const express = require('express');

const { generateContent, activeModel } = require('../services/gemini');
const { generateImages }               = require('../services/fal');
const { clientScope }                  = require('../middleware/clientScope');
const { getBrandKitByClientId }        = require('../database/brandKits');
const { getBrandIntelligenceById }     = require('../database/brandIntelligence');
const { createGeneration, updateGeneration } = require('../database/generations');
const { createCampaignBatch, getCampaignBatch, refreshBatchStatus } = require('../database/campaignBatches');

const router = express.Router();

router.use(clientScope);

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_COMBOS     = 12; // personas × angles cap
const MAX_TOTAL_ADS  = 20;
const VARIANT_CROPS  = [
  '',                                              // variant 1 — base
  ', close-up detail shot, tight framing',         // variant 2
  ', wide establishing shot, environmental context', // variant 3
];

const PLAN_ITEM_SCHEMA = JSON.stringify({
  combo_index:        0,
  prompt:             'standalone image generation prompt — plain comma-separated descriptors, no brand names, no embedded text',
  concept:            'one sentence: what this creative execution is doing and why',
  headline:           'suggested ad headline (8 words max)',
  strategy_rationale: 'one sentence: why this persona × angle pairing is strategically sound',
}, null, 2);

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPlanPrompt({ kit, intel, combos, goal, headline, cta, productImageUrl }) {
  const lines = [
    'You are a Meta ad strategist building a campaign generation matrix.',
    `Return a JSON array of exactly ${combos.length} objects — one per persona × angle combination.`,
    'Return JSON only — no markdown fences, no explanation.',
    '',
    'For each combination produce a distinct creative direction.',
    'prompt rules: plain comma-separated image generation prompt, no brand names, no embedded text, specific about lighting/composition/mood.',
    '',
    'Context:',
  ];

  if (kit) {
    if (kit.name)          lines.push(`Brand: ${kit.name}`);
    if (kit.tagline)       lines.push(`Tagline: ${kit.tagline}`);
    if (kit.tone_of_voice) lines.push(`Tone: ${kit.tone_of_voice}`);
    const colors = Array.isArray(kit.primary_colors) ? kit.primary_colors.filter(Boolean) : [];
    if (colors.length)     lines.push(`Brand colors: ${colors.join(', ')}`);
  }

  if (intel) {
    if (intel.unique_value_prop) lines.push(`UVP: ${intel.unique_value_prop}`);
    if (intel.tone_summary)      lines.push(`Brand tone: ${intel.tone_summary}`);
    const ra  = intel.raw_analysis || {};
    const diffs = Array.isArray(ra.differentiators) ? ra.differentiators.filter(Boolean) : [];
    if (diffs.length) lines.push(`Differentiators: ${diffs.join('; ')}`);
  }

  if (goal)            lines.push(`Campaign goal: ${goal}`);
  if (headline)        lines.push(`Working headline: ${headline}`);
  if (cta)             lines.push(`CTA: ${cta}`);
  if (productImageUrl) lines.push('Note: a product photo will be used as the img2img base; compose prompt to showcase it.');

  lines.push('', 'Persona × Angle combinations (use combo_index exactly as given):');
  combos.forEach(({ index, persona, angle }) => {
    lines.push(`  [${index}] Persona: ${persona}  |  Angle: ${angle}`);
  });

  lines.push('', `Each object must follow this shape (combo_index must match the index above):`, PLAN_ITEM_SCHEMA);

  return lines.join('\n');
}

// Variant suffix applied to the base prompt for ads_per_combo > 1
function variantPrompt(basePrompt, variantIndex) {
  const suffix = VARIANT_CROPS[variantIndex] || '';
  return suffix ? `${basePrompt}${suffix}` : basePrompt;
}

// ── POST /api/campaign/plan ───────────────────────────────────────────────────
// Compiles selected persona×angle pairs into a structured generation matrix.
//
// Body:
//   brand_intelligence_id  {number}    optional — source for personas/angles/context
//   personas               {string[]}  required (or derived from brand intel raw_analysis.personas)
//   angles                 {string[]}  required (or derived from brand intel raw_analysis.angles)
//   goal                   {string}    optional — campaign objective
//   headline               {string}    optional — working headline
//   cta                    {string}    optional
//   product_image_url      {string}    optional — passed through to each item
//   ads_per_combo          {number}    optional — variants per combo 1–3 (default 1)
//   image_size             {string}    optional — FAL size preset (default "square_hd")
//
// Returns:
//   {
//     plan: {
//       goal, total_ads,
//       items: [{
//         index, persona, angle, prompt, concept, headline, cta,
//         image_size, product_image_url,
//         metadata: { brand_intelligence_id, goal, strategy_rationale }
//       }]
//     },
//     model, planned_at
//   }

router.post('/plan', async (req, res, next) => {
  try {
    const {
      brand_intelligence_id,
      goal,
      headline,
      cta,
      product_image_url,
    } = req.body;

    const adsPerCombo = Math.min(3, Math.max(1, parseInt(req.body.ads_per_combo, 10) || 1));
    const imageSize   = req.body.image_size || 'square_hd';

    // ── Resolve personas and angles ──────────────────────────────────────────
    const kit = await getBrandKitByClientId(req.clientId).catch(() => null);

    let intel = null;
    if (brand_intelligence_id) {
      const id = parseInt(brand_intelligence_id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid brand_intelligence_id' });
      intel = await getBrandIntelligenceById(id, req.clientId);
      if (!intel) return res.status(404).json({ error: 'Brand intelligence record not found' });
    }

    // Personas: body param takes priority, then intel raw_analysis
    let personas = [];
    if (Array.isArray(req.body.personas) && req.body.personas.length) {
      personas = req.body.personas.map(String).map(s => s.trim()).filter(Boolean);
    } else if (intel?.raw_analysis?.personas) {
      // personas stored as "Name | Description" strings or plain strings
      const raw = intel.raw_analysis.personas;
      if (Array.isArray(raw)) {
        personas = raw.map(p => (typeof p === 'string' ? p : p?.name || '')).filter(Boolean);
      }
    }

    // Angles: body param takes priority, then intel raw_analysis
    let angles = [];
    if (Array.isArray(req.body.angles) && req.body.angles.length) {
      angles = req.body.angles.map(String).map(s => s.trim()).filter(Boolean);
    } else if (intel?.raw_analysis?.angles) {
      const raw = intel.raw_analysis.angles;
      if (Array.isArray(raw)) {
        angles = raw.map(String).filter(Boolean);
      }
    }

    if (personas.length === 0) return res.status(400).json({ error: 'At least one persona is required (provide personas[] or brand_intelligence_id with personas in raw_analysis)' });
    if (angles.length   === 0) return res.status(400).json({ error: 'At least one angle is required (provide angles[] or brand_intelligence_id with angles in raw_analysis)' });

    // Build combos matrix; cap at MAX_COMBOS to keep Gemini prompt manageable
    const allCombos = [];
    outer: for (const persona of personas) {
      for (const angle of angles) {
        allCombos.push({ index: allCombos.length, persona, angle });
        if (allCombos.length >= MAX_COMBOS) break outer;
      }
    }

    // Cap total ads
    const cappedAdsPerCombo = Math.min(adsPerCombo, Math.floor(MAX_TOTAL_ADS / allCombos.length) || 1);

    // ── Gemini: enrich each combo ─────────────────────────────────────────────
    let enriched;
    try {
      enriched = await generateContent(
        buildPlanPrompt({
          kit, intel,
          combos:         allCombos,
          goal:           goal            ? String(goal).trim()            : null,
          headline:       headline        ? String(headline).trim()        : null,
          cta:            cta             ? String(cta).trim()             : null,
          productImageUrl: product_image_url ? String(product_image_url).trim() : null,
        }),
        { json: true }
      );
    } catch (err) {
      const status = err.code === 'GEMINI_KEY_MISSING' ? 503 : 502;
      return res.status(status).json({ error: `Campaign planning failed: ${err.message}` });
    }

    // Normalise Gemini output into a combo_index → item map
    const enrichedMap = {};
    (Array.isArray(enriched) ? enriched : []).forEach(item => {
      if (item && typeof item.combo_index === 'number') {
        enrichedMap[item.combo_index] = item;
      }
    });

    // ── Expand into final plan items ──────────────────────────────────────────
    const items = [];
    for (const combo of allCombos) {
      const enrichedItem = enrichedMap[combo.index] || {};
      const basePrompt   = typeof enrichedItem.prompt === 'string' && enrichedItem.prompt.trim()
        ? enrichedItem.prompt.trim()
        : `${combo.angle} scene, ${combo.persona}, professional Meta ad creative, high quality`;

      for (let v = 0; v < cappedAdsPerCombo; v++) {
        items.push({
          index:             items.length + 1,
          persona:           combo.persona,
          angle:             combo.angle,
          prompt:            variantPrompt(basePrompt, v),
          concept:           typeof enrichedItem.concept   === 'string' ? enrichedItem.concept.trim()            : '',
          headline:          typeof enrichedItem.headline  === 'string' ? enrichedItem.headline.trim()           : (headline || ''),
          cta:               cta || '',
          image_size:        imageSize,
          product_image_url: product_image_url || null,
          metadata: {
            brand_intelligence_id: intel?.id   || null,
            goal:                  goal         || null,
            strategy_rationale:    typeof enrichedItem.strategy_rationale === 'string'
              ? enrichedItem.strategy_rationale.trim()
              : '',
            variant: cappedAdsPerCombo > 1 ? v + 1 : null,
          },
        });
      }
    }

    res.json({
      plan: {
        goal:       goal || null,
        total_ads:  items.length,
        items,
      },
      model:      activeModel(),
      planned_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ── Batch processing helpers ──────────────────────────────────────────────────

const BATCH_CONCURRENCY = 3;

// Runs `fn` over `items` with at most `concurrency` in-flight at once.
async function withConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return results;
}

// Executes a single plan item: pending → processing → done/failed
async function executeItem(item, generation, clientId, batchId) {
  try {
    await updateGeneration(generation.id, clientId, { status: 'processing' });

    const falOpts = {
      imageSize: item.image_size || 'square_hd',
      numImages: 1,
    };
    if (item.product_image_url) {
      falOpts.imageUrl = item.product_image_url;
      falOpts.strength = 0.75;
    }

    const result     = await generateImages(item.prompt, falOpts);
    const firstImage = result.images[0] || null;

    await updateGeneration(generation.id, clientId, {
      status:             'done',
      generated_images:   result.images,
      selected_image_url: firstImage?.url || null,
      metadata: {
        ...(generation.metadata || {}),
        fal_request_id: result.requestId,
        fal_seed:       result.seed,
        fal_model:      result.model,
      },
    });

    return { success: true, image_url: firstImage?.url || null };
  } catch (err) {
    const errorMsg = err?.message || 'Generation failed';
    await updateGeneration(generation.id, clientId, {
      status: 'failed',
      error:  errorMsg,
    });
    return { success: false, error: errorMsg };
  } finally {
    await refreshBatchStatus(batchId, clientId).catch(() => {});
  }
}

// ── POST /api/campaign/generate ───────────────────────────────────────────────
// Executes a plan by creating generation records and running FAL for each item.
// Returns immediately with batch_id and per-item generation IDs.
// FAL calls run in background (BATCH_CONCURRENCY at a time); client polls for status.
//
// Body:
//   items  {object[]}  required — plan items from POST /api/campaign/plan response
//   goal   {string}    optional — stored on the batch record
//
// Returns: { batch_id, total, items: [{ index, generation_id, status: 'pending' }] }

router.post('/generate', async (req, res, next) => {
  try {
    const rawItems = req.body.items;
    const goal     = req.body.goal ? String(req.body.goal).trim() : null;

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return res.status(400).json({ error: 'items[] array is required' });
    }
    if (rawItems.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 items per batch' });
    }

    // Create the batch record
    const batch = await createCampaignBatch({
      client_id:   req.clientId,
      goal,
      total_items: rawItems.length,
      metadata:    { source: 'campaign_plan' },
    });

    // Create all generation records immediately (status: pending) so the
    // history board and polling see them right away
    const generations = await Promise.all(
      rawItems.map((item, i) =>
        createGeneration({
          client_id:        req.clientId,
          prompt:           item.prompt   || '',
          headline:         item.headline || null,
          cta:              item.cta      || null,
          concept:          item.concept  || null,
          metadata: {
            campaign_batch_id:  batch.id,
            batch_item_index:   item.index ?? (i + 1),
            persona:            item.persona  || null,
            angle:              item.angle    || null,
            goal:               goal          || item.metadata?.goal || null,
            strategy_rationale: item.metadata?.strategy_rationale || null,
          },
        }).then(gen => {
          // Stamp the campaign_batch_id directly via raw SQL since createGeneration
          // doesn't know about that column yet — update right after insert
          const { pool } = require('../database/init');
          return pool.query(
            'UPDATE generations SET campaign_batch_id = $1 WHERE id = $2 RETURNING *',
            [batch.id, gen.id]
          ).then(r => r.rows[0] || gen);
        })
      )
    );

    // Respond immediately — client can start polling GET /api/campaign/generate/:batchId
    res.json({
      batch_id: batch.id,
      total:    generations.length,
      items: generations.map((g, i) => ({
        index:         rawItems[i]?.index ?? (i + 1),
        generation_id: g.id,
        status:        'pending',
      })),
    });

    // ── Background processing ─────────────────────────────────────────────────
    // Not awaited — response already sent above.
    withConcurrency(
      generations.map((gen, i) => ({ gen, item: rawItems[i] })),
      BATCH_CONCURRENCY,
      ({ gen, item }) => executeItem(item, gen, req.clientId, batch.id)
    ).catch(err => console.error('[campaign] Batch error:', err.message));

  } catch (err) {
    next(err);
  }
});

// ── GET /api/campaign/generate/:batchId ───────────────────────────────────────
// Returns current batch status with per-item generation data.
// Poll this until batch.status !== 'running'.
//
// Returns:
//   {
//     batch: {
//       id, goal, total_items, status,
//       items: [{
//         generation_id, index, persona, angle,
//         status, prompt, headline, concept, image_url, error, created_at
//       }]
//     }
//   }

router.get('/generate/:batchId', async (req, res, next) => {
  try {
    const batchId = parseInt(req.params.batchId, 10);
    if (isNaN(batchId)) return res.status(400).json({ error: 'Invalid batch ID' });

    const batch = await getCampaignBatch(batchId, req.clientId);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });

    res.json({ batch });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

const express = require('express');

const { generateContent, activeModel } = require('../services/gemini');
const { clientScope }                  = require('../middleware/clientScope');
const { getBrandKitByClientId } = require('../database/brandKits');
const {
  getBrandIntelligenceByClientId,
  getBrandIntelligenceById,
  createBrandIntelligence,
  updateBrandIntelligence,
  deleteBrandIntelligence,
} = require('../database/brandIntelligence');

const router = express.Router();

router.use(clientScope);

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildGenerationPrompt(kit, researchText) {
  const lines = [
    'You are a brand strategist. Analyze the brand context below and return a single JSON object.',
    'Return JSON only — no markdown fences, no explanation, no surrounding text.',
    '',
    'Brand context:',
  ];

  if (kit.name)          lines.push(`Brand name: ${kit.name}`);
  if (kit.tagline)       lines.push(`Tagline: ${kit.tagline}`);
  if (kit.description)   lines.push(`Description: ${kit.description}`);
  if (kit.tone_of_voice) lines.push(`Tone of voice: ${kit.tone_of_voice}`);

  const colors = Array.isArray(kit.primary_colors) ? kit.primary_colors.filter(Boolean) : [];
  if (colors.length)     lines.push(`Primary colors: ${colors.join(', ')}`);

  if (researchText) {
    lines.push('', 'Additional research / notes:', researchText);
  }

  lines.push(
    '',
    'Return this exact JSON structure (all fields required, use empty arrays if unknown):',
    JSON.stringify({
      unique_value_prop: 'one concise sentence',
      target_audience:   'one paragraph describing the ideal customer',
      tone_summary:      'one paragraph describing how the brand communicates',
      keywords:          ['keyword1', 'keyword2', 'keyword3'],
      competitors:       ['CompetitorBrand1', 'CompetitorBrand2'],
      pain_points:       ['pain point 1', 'pain point 2', 'pain point 3'],
      differentiators:   ['differentiator 1', 'differentiator 2'],
      personas: [
        {
          name:        'Persona Name',
          description: 'one sentence bio',
          goals:       ['goal 1', 'goal 2'],
          pain_points: ['pain 1'],
        },
      ],
      angles:            ['Ad angle / hook 1 — what makes this compelling', 'Ad angle / hook 2'],
      copy_hooks:        ['Copy hook / opening line 1', 'Copy hook 2'],
      visual_directions: ['Visual direction 1 — e.g. clean white background, bold typography', 'Visual direction 2'],
      emotions:          ['Emotion the ad should evoke 1', 'Emotion 2'],
    }, null, 2)
  );

  return lines.join('\n');
}

function safeArray(val) {
  return Array.isArray(val) ? val : [];
}

// ── GET /api/brand-intelligence ───────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const records = await getBrandIntelligenceByClientId(req.clientId);
    res.json({ brand_intelligence: records });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/brand-intelligence/generate ─────────────────────────────────────
// Calls Gemini to derive strategic intelligence from the active brand kit.
// Optional body: research_text {string}, source_url {string}

router.post('/generate', async (req, res, next) => {
  try {
    const kit = await getBrandKitByClientId(req.clientId);
    if (!kit) {
      return res.status(422).json({
        error: 'No brand kit found. Set up your brand kit before generating intelligence.',
      });
    }

    const researchText = req.body.research_text ? String(req.body.research_text).trim() : null;
    const prompt       = buildGenerationPrompt(kit, researchText);

    let parsed;
    try {
      parsed = await generateContent(prompt, { json: true });
    } catch (err) {
      const status = err.code === 'GEMINI_KEY_MISSING' ? 503 : 502;
      return res.status(status).json({ error: `Brand intelligence generation failed: ${err.message}` });
    }

    const record = await createBrandIntelligence({
      client_id:        req.clientId,
      brand_kit_id:     kit.id,
      source_url:       req.body.source_url || null,
      unique_value_prop: parsed.unique_value_prop || null,
      target_audience:   parsed.target_audience   || null,
      tone_summary:      parsed.tone_summary       || null,
      keywords:          safeArray(parsed.keywords),
      competitors:       safeArray(parsed.competitors),
      pain_points:       safeArray(parsed.pain_points),
      differentiators:   safeArray(parsed.differentiators),
      raw_analysis: {
        personas:          safeArray(parsed.personas),
        angles:            safeArray(parsed.angles),
        copy_hooks:        safeArray(parsed.copy_hooks),
        visual_directions: safeArray(parsed.visual_directions),
        emotions:          safeArray(parsed.emotions),
        _generation: {
          model:         activeModel(),
          research_text: researchText,
          generated_at:  new Date().toISOString(),
        },
      },
      source: 'ai',
    });

    res.status(201).json({ brand_intelligence: record });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/brand-intelligence ──────────────────────────────────────────────
// Manual create. All fields optional.

router.post('/', async (req, res, next) => {
  try {
    const {
      brand_kit_id, source_url,
      unique_value_prop, target_audience, tone_summary,
      keywords, competitors, pain_points, differentiators, raw_analysis,
    } = req.body;

    const record = await createBrandIntelligence({
      client_id:         req.clientId,
      brand_kit_id:      brand_kit_id ? parseInt(brand_kit_id, 10) : null,
      source_url:        source_url        || null,
      unique_value_prop: unique_value_prop || null,
      target_audience:   target_audience   || null,
      tone_summary:      tone_summary      || null,
      keywords:          safeArray(keywords),
      competitors:       safeArray(competitors),
      pain_points:       safeArray(pain_points),
      differentiators:   safeArray(differentiators),
      raw_analysis:      raw_analysis && typeof raw_analysis === 'object' ? raw_analysis : {},
      source:            'manual',
    });

    res.status(201).json({ brand_intelligence: record });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/brand-intelligence/:id ──────────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const record = await getBrandIntelligenceById(id, req.clientId);
    if (!record) return res.status(404).json({ error: 'Not found' });

    res.json({ brand_intelligence: record });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/brand-intelligence/:id ────────────────────────────────────────
// Partial update. Promotes source 'ai' → 'edited' on first manual change.

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const existing = await getBrandIntelligenceById(id, req.clientId);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const fields = {};

    if ('source_url'        in req.body) fields.source_url        = req.body.source_url        || null;
    if ('unique_value_prop' in req.body) fields.unique_value_prop = req.body.unique_value_prop || null;
    if ('target_audience'   in req.body) fields.target_audience   = req.body.target_audience   || null;
    if ('tone_summary'      in req.body) fields.tone_summary      = req.body.tone_summary      || null;
    if ('keywords'          in req.body) fields.keywords          = safeArray(req.body.keywords);
    if ('competitors'       in req.body) fields.competitors       = safeArray(req.body.competitors);
    if ('pain_points'       in req.body) fields.pain_points       = safeArray(req.body.pain_points);
    if ('differentiators'   in req.body) fields.differentiators   = safeArray(req.body.differentiators);
    if ('raw_analysis'      in req.body) {
      fields.raw_analysis = req.body.raw_analysis && typeof req.body.raw_analysis === 'object'
        ? req.body.raw_analysis
        : existing.raw_analysis;
    }

    // Track that an AI-generated record has been manually refined
    if (Object.keys(fields).length > 0 && existing.source === 'ai') {
      fields.source = 'edited';
    }

    const updated = await updateBrandIntelligence(id, req.clientId, fields);
    res.json({ brand_intelligence: updated });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/brand-intelligence/:id ───────────────────────────────────────

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const deleted = await deleteBrandIntelligence(id, req.clientId);
    if (!deleted) return res.status(404).json({ error: 'Not found' });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;

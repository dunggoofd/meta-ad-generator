const express = require('express');

const { generateContent, activeModel } = require('../services/gemini');
const { clientScope }                  = require('../middleware/clientScope');
const { getBrandKitByClientId }        = require('../database/brandKits');
const { getBrandIntelligenceById }     = require('../database/brandIntelligence');

const router = express.Router();

router.use(clientScope);

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeArray(val) {
  return Array.isArray(val) ? val.filter(Boolean) : [];
}

function buildComposePrompt({ kit, intel, goal, referenceStyle, productImageUrl, headline, cta, audience }) {
  const lines = [
    'You are an expert Meta ad creative director and prompt engineer.',
    'Your task is to write a single image generation prompt for an AI image model.',
    '',
    'Rules:',
    '- Output ONLY the image generation prompt — no preamble, no explanation, no markdown.',
    '- The prompt must be a single paragraph of plain comma-separated descriptors.',
    '- Be specific about lighting, composition, color palette, mood, and photographic style.',
    '- Do NOT include brand names or trademarked terms in the image prompt.',
    '- Do NOT include text, copy, headlines, or CTAs in the image prompt.',
    '',
    'Context:',
  ];

  // Brand kit context
  if (kit) {
    if (kit.name)          lines.push(`Brand: ${kit.name}`);
    if (kit.tagline)       lines.push(`Tagline: ${kit.tagline}`);
    if (kit.description)   lines.push(`Description: ${kit.description}`);
    if (kit.tone_of_voice) lines.push(`Tone of voice: ${kit.tone_of_voice}`);
    const colors = Array.isArray(kit.primary_colors) ? kit.primary_colors.filter(Boolean) : [];
    if (colors.length)     lines.push(`Brand colors: ${colors.join(', ')}`);
  }

  // Brand intelligence context
  if (intel) {
    if (intel.unique_value_prop) lines.push(`Unique value proposition: ${intel.unique_value_prop}`);
    if (intel.target_audience)   lines.push(`Target audience: ${intel.target_audience}`);
    if (intel.tone_summary)      lines.push(`Brand tone: ${intel.tone_summary}`);

    const ra = intel.raw_analysis || {};
    const emotions = safeArray(ra.emotions);
    if (emotions.length) lines.push(`Desired emotions: ${emotions.join(', ')}`);

    const visualDirs = safeArray(ra.visual_directions);
    if (visualDirs.length) lines.push(`Visual directions: ${visualDirs.join('; ')}`);

    const angles = safeArray(ra.angles);
    if (angles.length) lines.push(`Ad angles: ${angles.slice(0, 2).join('; ')}`);
  }

  // Campaign goal
  if (goal) lines.push(`Campaign goal: ${goal}`);

  // Reference style
  if (referenceStyle) lines.push(`Reference style: ${referenceStyle}`);

  // Product image signal
  if (productImageUrl) lines.push(`Note: A product photo will be provided as the img2img base. Compose the prompt to complement and showcase this product.`);

  // Copy context (inform visual without embedding text)
  if (headline)  lines.push(`Ad headline (inform visual tone only): ${headline}`);
  if (cta)       lines.push(`Call to action (inform urgency/mood only): ${cta}`);
  if (audience)  lines.push(`Target persona: ${audience}`);

  lines.push('', 'Write the image generation prompt now:');

  return lines.join('\n');
}

// ── Deterministic fallback ────────────────────────────────────────────────────
// Builds a serviceable image generation prompt from structured fields only.
// No AI required. Called when Gemini is unavailable or times out.

function buildFallbackPrompt({ kit, intel, goal, referenceStyle, productImageUrl, headline, audience }) {
  const parts = [];

  // Subject / scene
  if (productImageUrl) {
    parts.push('product hero shot');
  } else if (goal) {
    const g = goal.toLowerCase();
    if (g.includes('lifestyle'))        parts.push('lifestyle scene with real people');
    else if (g.includes('awareness'))   parts.push('bold brand awareness visual');
    else if (g.includes('conversion'))  parts.push('clean product-focused composition');
    else                                parts.push('professional ad creative scene');
  } else {
    parts.push('professional advertising photograph');
  }

  // Audience mood
  const audienceStr = audience || intel?.target_audience || null;
  if (audienceStr) {
    const a = audienceStr.toLowerCase();
    if (a.includes('young') || a.includes('gen z'))  parts.push('youthful vibrant energy');
    else if (a.includes('professional') || a.includes('b2b')) parts.push('refined corporate aesthetic');
    else if (a.includes('parent') || a.includes('family'))    parts.push('warm family-friendly atmosphere');
    else                                                        parts.push('approachable modern aesthetic');
  }

  // Tone / emotion
  const ra = intel?.raw_analysis || {};
  const emotions = safeArray(ra.emotions);
  if (emotions.length) {
    parts.push(`${emotions.slice(0, 2).join(' and ')} mood`);
  } else if (kit?.tone_of_voice) {
    const t = kit.tone_of_voice.toLowerCase();
    if (t.includes('bold') || t.includes('energetic'))  parts.push('bold energetic mood');
    else if (t.includes('calm') || t.includes('minimal')) parts.push('calm minimal mood');
    else if (t.includes('luxury') || t.includes('premium')) parts.push('premium luxurious feel');
    else parts.push('confident brand mood');
  }

  // Color palette
  const colors = Array.isArray(kit?.primary_colors) ? kit.primary_colors.filter(Boolean) : [];
  if (colors.length) {
    parts.push(`color palette: ${colors.slice(0, 3).join(', ')}`);
  } else {
    parts.push('clean neutral color palette');
  }

  // Visual direction
  const visualDirs = safeArray(ra.visual_directions);
  if (visualDirs.length) {
    parts.push(visualDirs[0]);
  } else if (referenceStyle) {
    parts.push(referenceStyle);
  }

  // Headline-informed mood (no text in image)
  if (headline) {
    const h = headline.toLowerCase();
    if (h.includes('fast') || h.includes('instant') || h.includes('now'))   parts.push('dynamic sense of motion');
    else if (h.includes('safe') || h.includes('trust') || h.includes('proven')) parts.push('trustworthy composed scene');
    else if (h.includes('transform') || h.includes('new') || h.includes('discover')) parts.push('aspirational uplifting composition');
  }

  // Technical quality
  parts.push('soft natural lighting', 'shallow depth of field', 'high resolution', 'professional Meta ad creative');

  return parts.join(', ');
}

function buildRationalePrompt({ kit, intel, goal, referenceStyle, headline, composedPrompt }) {
  const lines = [
    'You are a creative strategist explaining an ad concept.',
    'Given the context and the composed image generation prompt below, write 2-3 sentences explaining:',
    '- Why these visual choices serve the brand and campaign goal',
    '- What strategic intent is embedded in the prompt',
    '',
    'Output only the explanation — no headers, no bullet points.',
    '',
    'Context summary:',
  ];

  if (kit?.name)           lines.push(`Brand: ${kit.name}`);
  if (intel?.unique_value_prop) lines.push(`UVP: ${intel.unique_value_prop}`);
  if (goal)                lines.push(`Goal: ${goal}`);
  if (headline)            lines.push(`Headline: ${headline}`);
  if (referenceStyle)      lines.push(`Reference style: ${referenceStyle}`);

  lines.push('', `Composed image prompt: ${composedPrompt}`, '', 'Explanation:');

  return lines.join('\n');
}

// ── POST /api/prompt/compose ──────────────────────────────────────────────────
// Composes an image generation prompt from brand context + strategy.
//
// Body:
//   brand_intelligence_id  {number}  optional — fetch brand intel by ID
//   reference_style        {string}  optional — visual style description
//   product_image_url      {string}  optional — product photo URL (informs composition)
//   goal                   {string}  optional — campaign objective
//   headline               {string}  optional — ad headline (shapes visual tone)
//   cta                    {string}  optional — call to action (shapes urgency/mood)
//   audience               {string}  optional — specific persona description
//
// Returns: { prompt, rationale, model, composed_at }

router.post('/', async (req, res, next) => {
  try {
    const {
      brand_intelligence_id,
      reference_style,
      product_image_url,
      goal,
      headline,
      cta,
      audience,
    } = req.body;

    // Fetch brand kit (best-effort; compose without it if absent)
    const kit = await getBrandKitByClientId(req.clientId).catch(() => null);

    // Fetch brand intelligence if requested
    let intel = null;
    if (brand_intelligence_id) {
      const id = parseInt(brand_intelligence_id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid brand_intelligence_id' });
      intel = await getBrandIntelligenceById(id, req.clientId);
      if (!intel) return res.status(404).json({ error: 'Brand intelligence record not found' });
    }

    const ctx = {
      kit,
      intel,
      goal:             goal             ? String(goal).trim()             : null,
      referenceStyle:   reference_style  ? String(reference_style).trim()  : null,
      productImageUrl:  product_image_url ? String(product_image_url).trim() : null,
      headline:         headline         ? String(headline).trim()         : null,
      cta:              cta              ? String(cta).trim()              : null,
      audience:         audience         ? String(audience).trim()         : null,
    };

    // Compose image generation prompt — fall back to deterministic assembly on any AI failure
    let composedPrompt;
    let usedFallback = false;

    try {
      composedPrompt = await generateContent(buildComposePrompt(ctx));
    } catch (_err) {
      composedPrompt = buildFallbackPrompt(ctx);
      usedFallback = true;
    }

    // Generate rationale (best-effort; skipped when using fallback)
    let rationale = null;
    if (!usedFallback) {
      try {
        rationale = await generateContent(buildRationalePrompt({ ...ctx, composedPrompt }));
      } catch (_err) {
        // rationale is non-critical
      }
    }

    res.json({
      prompt:      composedPrompt,
      rationale,
      fallback:    usedFallback,
      model:       usedFallback ? null : activeModel(),
      composed_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

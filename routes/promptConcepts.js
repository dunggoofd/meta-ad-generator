const express = require('express');

const { generateContent, activeModel } = require('../services/gemini');
const { clientScope }                  = require('../middleware/clientScope');
const { getBrandKitByClientId }        = require('../database/brandKits');
const { getBrandIntelligenceById }     = require('../database/brandIntelligence');

const router = express.Router();

router.use(clientScope);

// ── Helpers ───────────────────────────────────────────────────────────────────

const CONCEPT_SCHEMA = JSON.stringify([
  {
    concept_type:    'one of: emotional | product-hero | lifestyle | social-proof | educational | urgency',
    angle:           'one sharp sentence describing the specific creative angle',
    audience_stage:  'one of: awareness | consideration | conversion',
    why_distinct:    'one sentence explaining what makes this concept different from the others in this set',
    prompt_template: 'standalone image generation prompt for this concept — plain comma-separated descriptors, no brand names, no embedded text',
  },
], null, 2);

function buildConceptsPrompt({ kit, intel, goal, referenceStyle, headline, cta, audience, numConcepts }) {
  const lines = [
    'You are a Meta ad creative strategist generating diverse concept directions.',
    'Your job is to produce a set of strategically distinct ad concepts for a campaign.',
    `Return exactly ${numConcepts} concepts as a JSON array.`,
    'Return JSON only — no markdown fences, no explanation, no surrounding text.',
    '',
    'Diversity rules — EACH concept must:',
    '- Use a different concept_type',
    '- Target a different emotional or rational motivation',
    '- Be suitable for a meaningfully different creative execution',
    '- Have a why_distinct that explicitly references how it differs from the others',
    '',
    'prompt_template rules:',
    '- Plain comma-separated image generation prompt',
    '- No brand names, logos, or trademarks',
    '- No embedded text, headlines, or copy in the image description',
    '- Specific about lighting, composition, mood, and photographic style',
    '',
    'Context:',
  ];

  if (kit) {
    if (kit.name)          lines.push(`Brand: ${kit.name}`);
    if (kit.tagline)       lines.push(`Tagline: ${kit.tagline}`);
    if (kit.description)   lines.push(`Description: ${kit.description}`);
    if (kit.tone_of_voice) lines.push(`Tone: ${kit.tone_of_voice}`);
    const colors = Array.isArray(kit.primary_colors) ? kit.primary_colors.filter(Boolean) : [];
    if (colors.length)     lines.push(`Brand colors: ${colors.join(', ')}`);
  }

  if (intel) {
    if (intel.unique_value_prop) lines.push(`UVP: ${intel.unique_value_prop}`);
    if (intel.target_audience)   lines.push(`Target audience: ${intel.target_audience}`);
    if (intel.tone_summary)      lines.push(`Brand tone: ${intel.tone_summary}`);

    const ra = intel.raw_analysis || {};
    const painPoints    = Array.isArray(ra.pain_points)       ? ra.pain_points.filter(Boolean)       : [];
    const differentials = Array.isArray(ra.differentiators)   ? ra.differentiators.filter(Boolean)   : [];
    const angles        = Array.isArray(ra.angles)            ? ra.angles.filter(Boolean)            : [];
    const emotions      = Array.isArray(ra.emotions)          ? ra.emotions.filter(Boolean)          : [];

    if (painPoints.length)    lines.push(`Pain points: ${painPoints.join('; ')}`);
    if (differentials.length) lines.push(`Differentiators: ${differentials.join('; ')}`);
    if (angles.length)        lines.push(`Known ad angles: ${angles.join('; ')}`);
    if (emotions.length)      lines.push(`Target emotions: ${emotions.join(', ')}`);
  }

  if (goal)           lines.push(`Campaign goal: ${goal}`);
  if (referenceStyle) lines.push(`Reference style: ${referenceStyle}`);
  if (headline)       lines.push(`Working headline: ${headline}`);
  if (cta)            lines.push(`CTA: ${cta}`);
  if (audience)       lines.push(`Specific audience: ${audience}`);

  lines.push(
    '',
    `Return an array of exactly ${numConcepts} objects with this shape:`,
    CONCEPT_SCHEMA
  );

  return lines.join('\n');
}

// ── POST /api/prompt/concepts ─────────────────────────────────────────────────
// Generates multiple distinct concept directions as a planning layer.
//
// Body:
//   brand_intelligence_id  {number}  optional
//   goal                   {string}  optional — campaign objective
//   reference_style        {string}  optional — visual reference
//   headline               {string}  optional — working headline
//   cta                    {string}  optional
//   audience               {string}  optional — specific persona
//   num_concepts           {number}  optional — how many concepts (2–6, default 4)
//
// Returns: { concepts[], model, generated_at }
// Each concept: { concept_type, angle, audience_stage, why_distinct, prompt_template }

router.post('/', async (req, res, next) => {
  try {
    const {
      brand_intelligence_id,
      goal,
      reference_style,
      headline,
      cta,
      audience,
    } = req.body;

    const rawNum    = parseInt(req.body.num_concepts, 10);
    const numConcepts = (!isNaN(rawNum) && rawNum >= 2 && rawNum <= 6) ? rawNum : 4;

    const kit = await getBrandKitByClientId(req.clientId).catch(() => null);

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
      goal:           goal           ? String(goal).trim()           : null,
      referenceStyle: reference_style ? String(reference_style).trim() : null,
      headline:       headline       ? String(headline).trim()       : null,
      cta:            cta            ? String(cta).trim()            : null,
      audience:       audience       ? String(audience).trim()       : null,
      numConcepts,
    };

    let raw;
    try {
      raw = await generateContent(buildConceptsPrompt(ctx), { json: true });
    } catch (err) {
      const status = err.code === 'GEMINI_KEY_MISSING' ? 503 : 502;
      return res.status(status).json({ error: `Concept generation failed: ${err.message}` });
    }

    // Normalise — ensure array, filter malformed entries
    const concepts = (Array.isArray(raw) ? raw : [])
      .filter(c => c && typeof c === 'object')
      .map(c => ({
        concept_type:    String(c.concept_type    || 'product-hero').trim(),
        angle:           String(c.angle           || '').trim(),
        audience_stage:  String(c.audience_stage  || 'awareness').trim(),
        why_distinct:    String(c.why_distinct    || '').trim(),
        prompt_template: String(c.prompt_template || '').trim(),
      }))
      .filter(c => c.angle && c.prompt_template);

    if (concepts.length === 0) {
      return res.status(502).json({ error: 'Concept generation returned no usable concepts' });
    }

    res.json({
      concepts,
      model:        activeModel(),
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

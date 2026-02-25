const express = require('express');

const { generateContentWithImage, activeModel } = require('../services/gemini');
const { clientScope }                           = require('../middleware/clientScope');

const router = express.Router();

router.use(clientScope);

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildReversePrompt(platform) {
  const platformNote = platform ? `The ad is formatted for: ${platform}.` : '';

  return [
    'You are an expert Meta ad creative director reverse-engineering a winning ad image.',
    'Analyze the image and return a single JSON object.',
    'Return JSON only — no markdown fences, no explanation, no surrounding text.',
    '',
    'Strict rules:',
    '- Do NOT copy or reference any brand names, logos, or trademarks visible in the image.',
    '- Do NOT reproduce literal claims, taglines, or proprietary copy from the ad.',
    '- Extract TRANSFERABLE patterns only — visual language, structure, emotional strategy.',
    '- style_prompt must be a plain comma-separated image generation prompt (no markdown, no brand names, no embedded text).',
    '- variant_prompts must each be standalone image generation prompts derived from the same style but varied in angle or composition.',
    platformNote,
    '',
    'Return this exact JSON structure:',
    JSON.stringify({
      style_prompt: 'plain image generation prompt capturing the visual style and composition',
      copy_skeleton: {
        headline: 'headline framework (pattern, not literal copy)',
        body:     'body copy structure with placeholder brackets for brand-specific details',
        cta:      'CTA pattern e.g. "Verb + benefit" or "Urgency + action"',
      },
      variant_prompts: [
        'variant 1 — same style, different composition angle',
        'variant 2 — same style, tighter crop or different subject framing',
        'variant 3 — same style, alternate mood or lighting treatment',
      ],
      analysis: {
        visual_style:  'one sentence: photographic style, rendering style, or illustration type',
        composition:   'one sentence: layout, subject placement, negative space, focal point',
        color_palette: ['hex or named color 1', 'hex or named color 2', 'hex or named color 3'],
        mood:          'one sentence: emotional tone and energy of the image',
        format:        'detected ad format e.g. single image, carousel frame, story, banner',
        hooks:         ['hook pattern 1', 'hook pattern 2'],
      },
    }, null, 2),
  ].filter(Boolean).join('\n');
}

// ── POST /api/prompt/reverse ──────────────────────────────────────────────────
// Reverse-engineers a winning ad image into reusable creative assets.
//
// Body:
//   image_url  {string}  required — URL of the winning ad image to analyze
//   platform   {string}  optional — ad placement context (e.g. "Facebook Feed")
//
// Returns:
//   {
//     style_prompt:    string          — image generation prompt capturing the visual style
//     copy_skeleton:   { headline, body, cta }
//     variant_prompts: string[]        — 3 standalone generation prompts (style variations)
//     analysis:        { visual_style, composition, color_palette[], mood, format, hooks[] }
//     model:           string
//     analyzed_at:     string
//   }

router.post('/', async (req, res, next) => {
  try {
    const { image_url, platform } = req.body;

    if (!image_url || typeof image_url !== 'string' || !image_url.trim()) {
      return res.status(400).json({ error: 'image_url is required' });
    }

    const url = image_url.trim();

    let analysis;
    try {
      analysis = await generateContentWithImage(
        url,
        buildReversePrompt(platform ? String(platform).trim() : null),
        { json: true }
      );
    } catch (err) {
      if (err.code === 'GEMINI_IMAGE_FETCH_ERROR') {
        return res.status(422).json({ error: `Could not fetch image: ${err.message}` });
      }
      const status = err.code === 'GEMINI_KEY_MISSING' ? 503 : 502;
      return res.status(status).json({ error: `Reverse engineering failed: ${err.message}` });
    }

    // Normalise — guard against partial responses
    const safe = {
      style_prompt:    typeof analysis.style_prompt === 'string' ? analysis.style_prompt.trim() : '',
      copy_skeleton: {
        headline: analysis.copy_skeleton?.headline || '',
        body:     analysis.copy_skeleton?.body     || '',
        cta:      analysis.copy_skeleton?.cta      || '',
      },
      variant_prompts: Array.isArray(analysis.variant_prompts)
        ? analysis.variant_prompts.filter(v => typeof v === 'string' && v.trim())
        : [],
      analysis: {
        visual_style:  analysis.analysis?.visual_style  || '',
        composition:   analysis.analysis?.composition   || '',
        color_palette: Array.isArray(analysis.analysis?.color_palette)
          ? analysis.analysis.color_palette.filter(Boolean)
          : [],
        mood:   analysis.analysis?.mood   || '',
        format: analysis.analysis?.format || '',
        hooks:  Array.isArray(analysis.analysis?.hooks)
          ? analysis.analysis.hooks.filter(Boolean)
          : [],
      },
    };

    res.json({
      ...safe,
      model:       activeModel(),
      analyzed_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

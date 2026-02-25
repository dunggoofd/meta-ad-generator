const express = require('express');

const { clientScope }            = require('../middleware/clientScope');
const { generateImages }         = require('../services/fal');
const { getBrandKitByClientId }  = require('../database/brandKits');
const {
  createGeneration,
  updateGeneration,
  getGenerationById,
} = require('../database/generations');

const router = express.Router();

router.use(clientScope);

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_IMAGE_SIZES = new Set([
  'square_hd', 'square', 'portrait_4_3', 'portrait_16_9',
  'landscape_4_3', 'landscape_16_9',
]);

// Appends brand identity constraints to the user's prompt.
// Only includes fields that are actually set in the brand kit.
function buildBrandPrompt(userPrompt, kit) {
  if (!kit) return userPrompt;

  const parts = [];
  if (kit.name)         parts.push(`brand: ${kit.name}`);
  if (kit.tagline)      parts.push(`tagline: ${kit.tagline}`);
  if (kit.tone_of_voice) parts.push(`tone: ${kit.tone_of_voice}`);

  const primary = Array.isArray(kit.primary_colors) ? kit.primary_colors[0] : null;
  if (primary)          parts.push(`primary color: ${primary}`);

  if (parts.length === 0) return userPrompt;
  return `${userPrompt}. ${parts.join(', ')}. Professional Meta ad creative, high quality.`;
}

// ── POST /api/generate ────────────────────────────────────────────────────────
// Generates a static ad image via FAL.
//
// Body:
//   prompt               {string}   required — image generation prompt
//   headline             {string}   optional — ad headline (stored only)
//   body_copy            {string}   optional — ad body copy (stored only)
//   cta                  {string}   optional — call to action (stored only)
//   concept              {string}   optional — ad concept / strategic intent (stored only)
//   avatar               {string}   optional — target audience persona (stored only)
//   asset_ids            {number[]} optional — brand asset IDs used as source images
//   brand_kit_id         {number}   optional — links generation to a brand kit
//   template_id          {number}   optional — links generation to a template
//   apply_brand_kit      {boolean}  optional — inject brand constraints into prompt
//   reference_image_url  {string}   optional — style reference; used as img2img base if no product image
//   product_image_url    {string}   optional — product photo; used as img2img base (takes priority)
//   strength             {number}   optional — img2img denoising 0–1 (default: product=0.75, reference=0.9)
//   num_images           {number}   optional — variants 1–4 (default 1)
//   image_size           {string}   optional — FAL size preset (default "square_hd")
//
// Success → 201 { generation }  (status: "done")
// FAL failure → 502/503 { error, generation }  (status: "failed")

router.post('/', async (req, res, next) => {
  const {
    prompt,
    headline,
    body_copy,
    cta,
    concept,
    avatar,
    asset_ids,
    brand_kit_id,
    template_id,
    apply_brand_kit,
    reference_image_url,
    product_image_url,
    strength,
    num_images,
    image_size,
  } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const numImages = Math.min(Math.max(parseInt(num_images ?? 1, 10) || 1, 1), 4);
  const imageSize = VALID_IMAGE_SIZES.has(image_size) ? image_size : 'square_hd';

  // Image input routing: product image takes priority over reference image
  const imageUrl       = product_image_url || reference_image_url || null;
  const defaultStrength = product_image_url ? 0.75 : 0.9;
  const resolvedStrength = strength != null
    ? Math.min(Math.max(parseFloat(strength), 0), 1)
    : defaultStrength;

  let generation;

  try {
    // ── 1. Brand kit injection ────────────────────────────────────────────────
    let brandKit = null;
    if (apply_brand_kit) {
      brandKit = await getBrandKitByClientId(req.clientId);
    }
    const finalPrompt = buildBrandPrompt(prompt.trim(), brandKit);

    // ── 2. Persist the intent immediately ─────────────────────────────────────
    // Parse asset_ids — accept JSON string or native array
    let parsedAssetIds = [];
    if (asset_ids) {
      try {
        const raw = typeof asset_ids === 'string' ? JSON.parse(asset_ids) : asset_ids;
        if (Array.isArray(raw)) parsedAssetIds = raw.filter(Number.isInteger);
      } catch { /* ignore malformed input */ }
    }

    generation = await createGeneration({
      client_id:    req.clientId,
      brand_kit_id: brand_kit_id ? parseInt(brand_kit_id, 10) : null,
      template_id:  template_id  ? parseInt(template_id, 10)  : null,
      prompt:       prompt.trim(),
      headline:     headline  || null,
      body_copy:    body_copy || null,
      cta:          cta       || null,
      concept:      concept   || null,
      avatar:       avatar    || null,
      asset_ids:    parsedAssetIds,
    });

    await updateGeneration(generation.id, req.clientId, { status: 'processing' });

    // ── 3. Call FAL ──────────────────────────────────────────────────────────
    const result = await generateImages(finalPrompt, {
      imageSize,
      numImages,
      imageUrl,
      strength: resolvedStrength,
    });

    // ── 4. Persist normalised result ─────────────────────────────────────────
    const done = await updateGeneration(generation.id, req.clientId, {
      status:             'done',
      generated_images:   result.images,
      selected_image_url: result.images[0]?.url || null,
      metadata: {
        fal_request_id:      result.requestId,
        seed:                result.seed,
        model:               result.model,
        num_images:          numImages,
        image_size:          imageSize,
        apply_brand_kit:     Boolean(apply_brand_kit),
        augmented_prompt:    finalPrompt,
        reference_image_url: reference_image_url || null,
        product_image_url:   product_image_url   || null,
        ...(imageUrl && { strength: resolvedStrength }),
      },
    });

    return res.status(201).json({ generation: done });

  } catch (err) {
    // ── 5. Actionable FAL error → mark failed, return structured response ─────
    if (generation) {
      const label =
        err.code === 'FAL_KEY_MISSING' ? 'Image generation is not configured (FAL_KEY missing)'
        : err.code === 'FAL_TIMEOUT'   ? 'Image generation timed out — please try again'
        :                                `Image generation failed: ${err.message}`;

      try {
        const failed = await updateGeneration(generation.id, req.clientId, {
          status: 'failed',
          error:  label,
        });
        const status = err.code === 'FAL_KEY_MISSING' ? 503 : 502;
        return res.status(status).json({ error: label, generation: failed });
      } catch {
        // DB update itself failed — fall through to global handler
      }
    }

    next(err);
  }
});

// ── POST /api/generate/edit ───────────────────────────────────────────────────
// Creates a variation of an existing generation using img2img.
// Fetches the source generation's selected image and re-runs FAL with a new prompt.
//
// Body:
//   generation_id    {number}   required — source generation
//   prompt           {string}   required — new/modified image prompt
//   headline         {string}   optional — stored only
//   body_copy        {string}   optional — stored only
//   cta              {string}   optional — stored only
//   concept          {string}   optional — stored only
//   avatar           {string}   optional — stored only
//   apply_brand_kit  {boolean}  optional — inject brand constraints into prompt
//   strength         {number}   optional — img2img denoising 0–1 (default 0.85)
//   num_images       {number}   optional — variants 1–4 (default 1)
//   image_size       {string}   optional — FAL size preset (default: inherits from source)
//
// Success → 201 { generation }
// Source not found / wrong status → 404 / 422

router.post('/edit', async (req, res, next) => {
  const {
    generation_id,
    prompt,
    headline,
    body_copy,
    cta,
    concept,
    avatar,
    apply_brand_kit,
    strength,
    num_images,
    image_size,
  } = req.body;

  const sourceId = parseInt(generation_id, 10);
  if (isNaN(sourceId)) {
    return res.status(400).json({ error: 'generation_id is required and must be a number' });
  }
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // ── 1. Load source generation (client-scoped) ──────────────────────────────
  const source = await getGenerationById(sourceId, req.clientId).catch(() => null);
  if (!source) return res.status(404).json({ error: 'Source generation not found' });

  if (source.status !== 'done') {
    return res.status(422).json({
      error: `Source generation has status "${source.status}". Only completed generations can be varied.`,
    });
  }

  // Resolve source image: selected → first in generated_images
  let sourceImageUrl = source.selected_image_url;
  if (!sourceImageUrl) {
    const images = Array.isArray(source.generated_images) ? source.generated_images : [];
    const first  = images[0];
    sourceImageUrl = typeof first === 'string' ? first : (first?.url || null);
  }
  if (!sourceImageUrl) {
    return res.status(422).json({ error: 'Source generation has no image to vary from.' });
  }

  // ── 2. Resolve generation options ─────────────────────────────────────────
  const sourceMetadata  = source.metadata || {};
  const numImages       = Math.min(Math.max(parseInt(num_images ?? 1, 10) || 1, 1), 4);
  const inheritedSize   = sourceMetadata.image_size;
  const imageSize       = VALID_IMAGE_SIZES.has(image_size)
    ? image_size
    : (VALID_IMAGE_SIZES.has(inheritedSize) ? inheritedSize : 'square_hd');
  const resolvedStrength = strength != null
    ? Math.min(Math.max(parseFloat(strength), 0), 1)
    : 0.85;

  let generation;

  try {
    // ── 3. Brand kit injection ───────────────────────────────────────────────
    let brandKit = null;
    if (apply_brand_kit) {
      brandKit = await getBrandKitByClientId(req.clientId);
    }
    const finalPrompt = buildBrandPrompt(prompt.trim(), brandKit);

    // ── 4. Persist new generation record ────────────────────────────────────
    generation = await createGeneration({
      client_id:    req.clientId,
      brand_kit_id: source.brand_kit_id  || null,
      template_id:  source.template_id   || null,
      prompt:       prompt.trim(),
      headline:     headline  || null,
      body_copy:    body_copy || null,
      cta:          cta       || null,
      concept:      concept   || null,
      avatar:       avatar    || null,
      asset_ids:    Array.isArray(source.asset_ids) ? source.asset_ids : [],
    });

    await updateGeneration(generation.id, req.clientId, { status: 'processing' });

    // ── 5. Call FAL img2img ──────────────────────────────────────────────────
    const result = await generateImages(finalPrompt, {
      imageSize,
      numImages,
      imageUrl: sourceImageUrl,
      strength: resolvedStrength,
    });

    // ── 6. Persist result ────────────────────────────────────────────────────
    const done = await updateGeneration(generation.id, req.clientId, {
      status:             'done',
      generated_images:   result.images,
      selected_image_url: result.images[0]?.url || null,
      metadata: {
        fal_request_id:        result.requestId,
        seed:                  result.seed,
        model:                 result.model,
        num_images:            numImages,
        image_size:            imageSize,
        apply_brand_kit:       Boolean(apply_brand_kit),
        augmented_prompt:      finalPrompt,
        strength:              resolvedStrength,
        parent_generation_id:  source.id,
        parent_image_url:      sourceImageUrl,
      },
    });

    return res.status(201).json({ generation: done });

  } catch (err) {
    if (generation) {
      const label =
        err.code === 'FAL_KEY_MISSING' ? 'Image generation is not configured (FAL_KEY missing)'
        : err.code === 'FAL_TIMEOUT'   ? 'Image generation timed out — please try again'
        :                                `Image generation failed: ${err.message}`;

      try {
        const failed = await updateGeneration(generation.id, req.clientId, {
          status: 'failed',
          error:  label,
        });
        const status = err.code === 'FAL_KEY_MISSING' ? 503 : 502;
        return res.status(status).json({ error: label, generation: failed });
      } catch {
        // fall through to global handler
      }
    }

    next(err);
  }
});

module.exports = router;

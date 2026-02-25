const { fal } = require('@fal-ai/client');

const FAL_MODEL         = process.env.FAL_MODEL         || 'fal-ai/flux/dev';
const FAL_IMG2IMG_MODEL = process.env.FAL_IMG2IMG_MODEL || 'fal-ai/flux/dev/image-to-image';
const FAL_TIMEOUT       = parseInt(process.env.FAL_TIMEOUT_MS || '120000', 10);

// ── Startup validation ────────────────────────────────────────────────────────
// Call once at boot. Warns but does not crash — the server can still serve
// non-generation routes if FAL_KEY is absent.

function configureFal() {
  const key = process.env.FAL_KEY;
  if (!key) {
    console.warn('[fal] WARNING: FAL_KEY is not set — image generation will fail at request time.');
    return;
  }
  fal.config({ credentials: key });
  console.log(`[fal] Ready  txt2img=${FAL_MODEL}  img2img=${FAL_IMG2IMG_MODEL}  timeout=${FAL_TIMEOUT}ms`);
}

// ── Response normalisation ────────────────────────────────────────────────────
// Different FAL models return images in slightly different shapes.
// We always produce: [{ url, width, height, content_type }]

function normalizeImages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(img => ({
      url:          typeof img === 'string' ? img    : img.url          || null,
      width:        typeof img === 'string' ? null   : img.width        || null,
      height:       typeof img === 'string' ? null   : img.height       || null,
      content_type: typeof img === 'string' ? 'image/jpeg' : img.content_type || 'image/jpeg',
    }))
    .filter(img => img.url);
}

// ── Core generation call ──────────────────────────────────────────────────────
// Options:
//   imageSize  {string}  FAL size preset (default: 'square_hd')
//   numImages  {number}  variants 1–4 (default: 1)
//   imageUrl   {string}  base image for img2img; triggers img2img model automatically
//   strength   {number}  img2img denoising strength 0–1 (default: 0.85)
//
// Returns { images, seed, requestId, model }
// Throws structured errors: code = FAL_KEY_MISSING | FAL_TIMEOUT | FAL_ERROR

async function generateImages(prompt, {
  imageSize = 'square_hd',
  numImages = 1,
  imageUrl  = null,
  strength  = 0.85,
} = {}) {
  if (!process.env.FAL_KEY) {
    throw Object.assign(new Error('FAL_KEY is not configured'), { code: 'FAL_KEY_MISSING' });
  }

  const isImg2Img     = Boolean(imageUrl);
  const resolvedModel = isImg2Img ? FAL_IMG2IMG_MODEL : FAL_MODEL;

  const input = isImg2Img
    ? { prompt, image_url: imageUrl, strength, num_images: numImages, image_size: imageSize, enable_safety_checker: false }
    : { prompt,                                num_images: numImages, image_size: imageSize, enable_safety_checker: false };

  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(Object.assign(
        new Error(`FAL request timed out after ${FAL_TIMEOUT}ms`),
        { code: 'FAL_TIMEOUT' }
      )),
      FAL_TIMEOUT
    )
  );

  let result;
  try {
    result = await Promise.race([
      fal.subscribe(resolvedModel, { input, logs: false }),
      timeout,
    ]);
  } catch (err) {
    if (err.code) throw err;
    const msg = err?.body?.detail || err?.message || 'Unknown FAL error';
    throw Object.assign(new Error(msg), { code: 'FAL_ERROR', cause: err });
  }

  const data      = result?.data ?? result ?? {};
  const rawImages = data.images ?? [];

  return {
    images:    normalizeImages(rawImages),
    seed:      data.seed      ?? null,
    requestId: result?.requestId ?? null,
    model:     resolvedModel,
  };
}

module.exports = { configureFal, generateImages };

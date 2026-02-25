const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const https    = require('https');
const http     = require('http');

const { clientScope }                          = require('../middleware/clientScope');
const { resolveUploadPath }                    = require('../middleware/upload');
const { getGenerationById, getAllGenerations }  = require('../database/generations');
const { getTemplateById }   = require('../database/templates');
const { createTemplate }    = require('../database/templates');

const router = express.Router();

// All generation routes are client-scoped.
router.use(clientScope);

// ── Image acquisition helpers ─────────────────────────────────────────────────

const THUMBNAILS_DIR = path.join(__dirname, '../public/uploads/thumbnails');

// Determines extension from a URL or filename, defaulting to .jpg
function extFromUrl(url) {
  const clean = url.split('?')[0];
  const ext   = path.extname(clean).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.svg'].includes(ext) ? ext : '.jpg';
}

// Generates a unique filename for the saved thumbnail
function makeFilename(ext) {
  return `${Date.now()}-${crypto.randomBytes(10).toString('hex')}${ext}`;
}

// Copy a local public file (path like "/uploads/assets/foo.jpg") to thumbnails/
async function copyLocalImage(publicPath) {
  const src = resolveUploadPath(publicPath);
  if (!src) throw new Error(`Invalid local image path: ${publicPath}`);
  const ext  = extFromUrl(publicPath);
  const name = makeFilename(ext);
  const dest = path.join(THUMBNAILS_DIR, name);
  await fs.promises.copyFile(src, dest);
  return `/uploads/thumbnails/${name}`;
}

// Download a remote image URL and save to thumbnails/
function downloadRemoteImage(url) {
  return new Promise((resolve, reject) => {
    const ext      = extFromUrl(url);
    const name     = makeFilename(ext);
    const dest     = path.join(THUMBNAILS_DIR, name);
    const file     = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;

    protocol.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`Failed to download image: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(`/uploads/thumbnails/${name}`);
      });
    }).on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// Acquire an image from either a local public path or a remote URL.
// Returns the new public path of the saved thumbnail.
async function acquireImage(imageUrl) {
  if (imageUrl.startsWith('/')) {
    return copyLocalImage(imageUrl);
  }
  return downloadRemoteImage(imageUrl);
}

// ── Metadata helpers ──────────────────────────────────────────────────────────

// Resolve the image to use: body override → selected → first in generated_images
function resolveImageUrl(generation, bodyImageUrl) {
  if (bodyImageUrl) return bodyImageUrl;
  if (generation.selected_image_url) return generation.selected_image_url;

  const images = generation.generated_images;
  if (Array.isArray(images) && images.length > 0) {
    const first = images[0];
    // Support both plain strings and { url } objects
    return typeof first === 'string' ? first : (first?.url || null);
  }
  return null;
}

// Build a human-readable template name from generation data
function buildTemplateName(generation, customName) {
  if (customName && customName.trim()) return customName.trim();
  if (generation.headline)            return generation.headline.trim();
  if (generation.prompt)              return generation.prompt.trim().slice(0, 60);
  return `Winner — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

// Derive tags from the generation + any user-supplied tags
function buildTags(generation, extraTags = []) {
  const tags = new Set(extraTags.map(t => t.toLowerCase().trim()).filter(Boolean));

  if (generation.cta) {
    // Normalise CTA to a tag: "Shop Now" → "shop-now"
    const ctaTag = generation.cta.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (ctaTag) tags.add(ctaTag);
  }

  tags.add('winner');
  return [...tags];
}

// Resolve dimensions: prefer parent template's dimensions, fall back to 1080×1080
async function resolveDimensions(generation) {
  if (generation.template_id) {
    const parentTemplate = await getTemplateById(generation.template_id);
    if (parentTemplate?.dimensions) return parentTemplate.dimensions;
  }
  return { width: 1080, height: 1080 };
}

// ── GET /api/generations ──────────────────────────────────────────────────────
// List generations for the active client, newest first.
// Query: ?limit= (max 100, default 50)  ?offset= (default 0)

router.get('/', async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50', 10) || 50, 100);
    const offset = Math.max(parseInt(req.query.offset || '0',  10) || 0,  0);
    const generations = await getAllGenerations(req.clientId, { limit, offset });
    res.json({ generations });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/generations/:id/save-as-template ────────────────────────────────
// Promotes a generation's image into the shared template library as a winner.
//
// Optional body fields:
//   name       – custom template name (defaults to headline → prompt → timestamp)
//   image_url  – specific image URL to use (defaults to selected_image_url → first in generated_images)
//   category   – template category string
//   tags       – array of additional tag strings (merged with auto-derived tags)

router.post('/:id/save-as-template', async (req, res, next) => {
  try {
    const generationId = parseInt(req.params.id, 10);
    if (isNaN(generationId)) return res.status(400).json({ error: 'Invalid generation id' });

    // ── 1. Fetch generation (client-scoped) ───────────────────────────────────
    const generation = await getGenerationById(generationId, req.clientId);
    if (!generation) return res.status(404).json({ error: 'Generation not found' });

    if (generation.status !== 'done') {
      return res.status(422).json({
        error: `Cannot save a generation with status "${generation.status}". Only completed generations can become templates.`,
      });
    }

    // ── 2. Resolve which image to promote ────────────────────────────────────
    const imageUrl = resolveImageUrl(generation, req.body.image_url);
    if (!imageUrl) {
      return res.status(422).json({ error: 'Generation has no image to save as a template.' });
    }

    // ── 3. Copy / download the image into the thumbnails directory ────────────
    let thumbnailUrl;
    try {
      thumbnailUrl = await acquireImage(imageUrl);
    } catch (err) {
      return res.status(502).json({ error: `Could not acquire image: ${err.message}` });
    }

    // ── 4. Build the template record ──────────────────────────────────────────
    const name       = buildTemplateName(generation, req.body.name);
    const tags       = buildTags(generation, req.body.tags);
    const dimensions = await resolveDimensions(generation);

    // Slug: derive from name, append short hash to avoid collisions
    const baseSlug  = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const hashSuffix = crypto.randomBytes(3).toString('hex'); // 6 chars
    const slug      = `${baseSlug}-${hashSuffix}`;

    // Preserve full generation context for future searchability
    const metadata = {
      generation_id:   generation.id,
      client_id:       generation.client_id,
      brand_kit_id:    generation.brand_kit_id  ?? null,
      template_id:     generation.template_id   ?? null,
      prompt:          generation.prompt         ?? null,
      headline:        generation.headline       ?? null,
      body_copy:       generation.body_copy      ?? null,
      cta:             generation.cta            ?? null,
      original_image_url: imageUrl,
      saved_at:        new Date().toISOString(),
    };

    let template;
    try {
      template = await createTemplate({
        name,
        slug,
        description:  generation.headline || generation.prompt || null,
        platform:     'meta',
        category:     req.body.category || null,
        dimensions,
        thumbnail_url: thumbnailUrl,
        is_active:    true,
        tags,
        is_favorite:  false,
        source_type:  'winner',
        metadata,
      });
    } catch (err) {
      // DB insert failed — remove the thumbnail we just wrote so it doesn't orphan
      const thumbFs = resolveUploadPath(thumbnailUrl);
      if (thumbFs) fs.unlink(thumbFs, () => {});
      throw err;
    }

    res.status(201).json({ template });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

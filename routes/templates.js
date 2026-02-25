const express = require('express');
const fs      = require('fs');

const { uploadThumbnail, handleUploadError, resolveUploadPath } = require('../middleware/upload');
const {
  getAllTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  toggleFavorite,
  setThumbnail,
  clearThumbnail,
  deleteTemplate,
} = require('../database/templates');

const router = express.Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_SOURCE_TYPES = new Set(['starter', 'user', 'winner']);
const VALID_PLATFORMS    = new Set(['meta', 'instagram', 'facebook', 'tiktok', 'google']);

// ── Validation helpers ────────────────────────────────────────────────────────

function validateBody(body) {
  const errors = [];

  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim())
      errors.push('name must be a non-empty string');
  }
  if ('description' in body && body.description !== null) {
    if (typeof body.description !== 'string')
      errors.push('description must be a string or null');
  }
  if ('platform' in body) {
    if (!VALID_PLATFORMS.has(body.platform))
      errors.push(`platform must be one of: ${[...VALID_PLATFORMS].join(', ')}`);
  }
  if ('source_type' in body) {
    if (!VALID_SOURCE_TYPES.has(body.source_type))
      errors.push(`source_type must be one of: ${[...VALID_SOURCE_TYPES].join(', ')}`);
  }
  if ('dimensions' in body && body.dimensions !== null) {
    const d = body.dimensions;
    if (typeof d !== 'object' || Array.isArray(d) ||
        !Number.isInteger(d.width)  || d.width  <= 0 ||
        !Number.isInteger(d.height) || d.height <= 0) {
      errors.push('dimensions must be an object with positive integer width and height');
    }
  }
  if ('tags' in body) {
    if (!Array.isArray(body.tags) || body.tags.some(t => typeof t !== 'string'))
      errors.push('tags must be an array of strings');
  }
  if ('is_favorite' in body && typeof body.is_favorite !== 'boolean')
    errors.push('is_favorite must be a boolean');
  if ('is_active' in body && typeof body.is_active !== 'boolean')
    errors.push('is_active must be a boolean');

  return errors;
}

function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function unlinkSilent(fsPath) {
  if (!fsPath) return;
  fs.unlink(fsPath, () => {});
}

// ── GET /api/templates ────────────────────────────────────────────────────────
// Query params: category, source_type, platform, is_favorite, is_active, tags, search
// tags accepts comma-separated values: ?tags=carousel,cta

router.get('/', async (req, res, next) => {
  try {
    const {
      category, source_type, platform, search,
    } = req.query;

    // Booleans
    const is_favorite = req.query.is_favorite !== undefined
      ? req.query.is_favorite === 'true'
      : undefined;
    const is_active = req.query.is_active !== undefined
      ? req.query.is_active === 'true'
      : true;  // default: only active templates

    // Tags: comma-separated → array
    const tags = req.query.tags
      ? req.query.tags.split(',').map(t => t.trim()).filter(Boolean)
      : undefined;

    const templates = await getAllTemplates({
      category, source_type, platform, is_favorite, is_active, tags, search,
    });
    res.json({ templates });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/templates ───────────────────────────────────────────────────────
// Create a new template. name is required; all other fields are optional.

router.post('/', async (req, res, next) => {
  try {
    if (!req.body.name || !req.body.name.trim())
      return res.status(400).json({ errors: ['name is required'] });

    const errors = validateBody(req.body);
    if (errors.length) return res.status(400).json({ errors });

    const slug = slugify(req.body.name.trim());

    const template = await createTemplate({
      ...req.body,
      name: req.body.name.trim(),
      slug,
    });
    res.status(201).json({ template });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'A template with that name already exists.' });
    next(err);
  }
});

// ── GET /api/templates/:id ────────────────────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const template = await getTemplateById(parseInt(req.params.id, 10));
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json({ template });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/templates/:id ──────────────────────────────────────────────────
// Partial update. Re-derives slug automatically when name changes.

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    const existing = await getTemplateById(id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    const errors = validateBody(req.body);
    if (errors.length) return res.status(400).json({ errors });

    const fields = { ...req.body };
    if (fields.name) {
      fields.name = fields.name.trim();
      if (!fields.name) return res.status(400).json({ errors: ['name cannot be empty'] });
      fields.slug = slugify(fields.name);
    }

    const template = await updateTemplate(id, fields);
    res.json({ template });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'A template with that name already exists.' });
    next(err);
  }
});

// ── DELETE /api/templates/:id ─────────────────────────────────────────────────
// Removes template and cleans up its thumbnail file.

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    const existing = await getTemplateById(id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    unlinkSilent(resolveUploadPath(existing.thumbnail_url));
    const deleted = await deleteTemplate(id);
    res.json({ deleted });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/templates/:id/favorite ─────────────────────────────────────────
// Toggle the is_favorite flag for a template.

router.post('/:id/favorite', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const template = await toggleFavorite(id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json({ template });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/templates/:id/thumbnail ────────────────────────────────────────
// Upload a thumbnail image. Form field name must be "thumbnail".

router.post(
  '/:id/thumbnail',
  uploadThumbnail.single('thumbnail'),
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);

      const existing = await getTemplateById(id);
      if (!existing) return res.status(404).json({ error: 'Template not found' });

      if (!req.file)
        return res.status(400).json({ error: 'No file received. Send a multipart field named "thumbnail".' });

      // Remove the previous thumbnail file before writing the new record
      unlinkSilent(resolveUploadPath(existing.thumbnail_url));

      const publicPath = `/uploads/thumbnails/${req.file.filename}`;
      const template   = await setThumbnail(id, publicPath);
      res.json({ template });
    } catch (err) {
      if (req.file) unlinkSilent(req.file.path);
      if (handleUploadError(err, res)) return;
      next(err);
    }
  }
);

// ── DELETE /api/templates/:id/thumbnail ──────────────────────────────────────

router.delete('/:id/thumbnail', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    const existing = await getTemplateById(id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });
    if (!existing.thumbnail_url) return res.status(404).json({ error: 'No thumbnail set' });

    unlinkSilent(resolveUploadPath(existing.thumbnail_url));
    const template = await clearThumbnail(id);
    res.json({ template });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

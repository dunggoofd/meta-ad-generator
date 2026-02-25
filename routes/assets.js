const express = require('express');
const fs      = require('fs');

const { clientScope }                                        = require('../middleware/clientScope');
const { uploadAssets, handleUploadError, resolveUploadPath } = require('../middleware/upload');
const {
  categoryFromMime,
  getAllAssets,
  getAssetById,
  createAsset,
  updateAsset,
  deleteAsset,
  deleteAssets,
} = require('../database/assets');

const router = express.Router();

router.use(clientScope);

// ── Helpers ───────────────────────────────────────────────────────────────────

function unlinkSilent(fsPath) {
  if (!fsPath) return;
  fs.unlink(fsPath, () => {});
}

const VALID_CATEGORIES = new Set([
  'image', 'video', 'font', 'document',
  'product_image', 'packaging', 'lifestyle', 'logo',
  'other',
]);

function validateUpdateBody(body) {
  const errors = [];

  if ('name' in body && (typeof body.name !== 'string' || !body.name.trim()))
    errors.push('name must be a non-empty string');

  if ('category' in body && !VALID_CATEGORIES.has(body.category))
    errors.push(`category must be one of: ${[...VALID_CATEGORIES].join(', ')}`);

  if ('tags' in body) {
    if (!Array.isArray(body.tags) || body.tags.some(t => typeof t !== 'string'))
      errors.push('tags must be an array of strings');
  }

  if ('brand_kit_id' in body && body.brand_kit_id !== null &&
      !Number.isInteger(body.brand_kit_id))
    errors.push('brand_kit_id must be an integer or null');

  return errors;
}

// ── GET /api/assets ───────────────────────────────────────────────────────────
// List all assets for the active client.
// Query params: category, source, brand_kit_id, tags (comma-separated), search

router.get('/', async (req, res, next) => {
  try {
    const { category, source, search } = req.query;

    const brand_kit_id = req.query.brand_kit_id !== undefined
      ? parseInt(req.query.brand_kit_id, 10)
      : undefined;

    const tags = req.query.tags
      ? req.query.tags.split(',').map(t => t.trim()).filter(Boolean)
      : undefined;

    const assets = await getAllAssets({
      clientId: req.clientId,
      category,
      source,
      brand_kit_id: isNaN(brand_kit_id) ? undefined : brand_kit_id,
      tags,
      search,
    });

    res.json({ assets });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/assets ──────────────────────────────────────────────────────────
// Multi-file upload. Field name must be "files" (up to 10 files).
// Optional body fields (form fields alongside files):
//   brand_kit_id – integer, associates assets with a brand kit
//   tags         – JSON string array, e.g. '["hero","product"]'
//
// Returns: { assets: [...], errors: [...] }
// Errors lists any files that failed DB insertion (file already cleaned up).

router.post(
  '/',
  uploadAssets.array('files', 10),
  async (req, res, next) => {
    try {
      if (!req.files || req.files.length === 0)
        return res.status(400).json({ error: 'No files received. Send multipart fields named "files".' });

      // Parse optional shared metadata from form fields
      const brand_kit_id = req.body.brand_kit_id
        ? parseInt(req.body.brand_kit_id, 10)
        : null;

      let sharedTags = [];
      if (req.body.tags) {
        try {
          const parsed = JSON.parse(req.body.tags);
          if (Array.isArray(parsed)) sharedTags = parsed.filter(t => typeof t === 'string');
        } catch {
          // Non-JSON: treat as comma-separated
          sharedTags = req.body.tags.split(',').map(t => t.trim()).filter(Boolean);
        }
      }

      const saved  = [];
      const errors = [];

      for (const file of req.files) {
        const publicPath = `/uploads/assets/${file.filename}`;

        try {
          const asset = await createAsset({
            client_id:     req.clientId,
            brand_kit_id:  isNaN(brand_kit_id) ? null : brand_kit_id,
            name:          file.originalname,
            original_name: file.originalname,
            file_url:      publicPath,
            file_type:     file.mimetype,
            file_size:     file.size,
            category:      categoryFromMime(file.mimetype),
            source:        'upload',
            tags:          sharedTags,
          });
          saved.push(asset);
        } catch (dbErr) {
          // DB failed for this file — remove the orphaned file and record the error
          unlinkSilent(resolveUploadPath(publicPath));
          errors.push({ originalname: file.originalname, error: dbErr.message });
        }
      }

      const status = saved.length > 0 ? 201 : 500;
      res.status(status).json({ assets: saved, errors });
    } catch (err) {
      // Clean up all uploaded files if the handler itself crashed
      if (req.files) req.files.forEach(f => unlinkSilent(f.path));
      if (handleUploadError(err, res)) return;
      next(err);
    }
  }
);

// ── GET /api/assets/:id ───────────────────────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const asset = await getAssetById(parseInt(req.params.id, 10), req.clientId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json({ asset });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/assets/:id ─────────────────────────────────────────────────────
// Update display name, tags, category, or brand_kit_id.
// file_url and file_type are immutable after upload.

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    const existing = await getAssetById(id, req.clientId);
    if (!existing) return res.status(404).json({ error: 'Asset not found' });

    const errors = validateUpdateBody(req.body);
    if (errors.length) return res.status(400).json({ errors });

    const asset = await updateAsset(id, req.clientId, req.body);
    res.json({ asset });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/assets/:id ────────────────────────────────────────────────────
// Removes the DB record and deletes the file from disk.

router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await deleteAsset(parseInt(req.params.id, 10), req.clientId);
    if (!deleted) return res.status(404).json({ error: 'Asset not found' });

    unlinkSilent(resolveUploadPath(deleted.file_url));
    res.json({ deleted });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/assets (bulk) ─────────────────────────────────────────────────
// Body: { ids: [1, 2, 3] }
// Deletes all matching assets that belong to the active client.
// Silently skips ids that don't exist or belong to another client.

router.delete('/', async (req, res, next) => {
  try {
    const ids = req.body.ids;

    if (!Array.isArray(ids) || ids.length === 0 ||
        ids.some(id => !Number.isInteger(id))) {
      return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    }

    const deleted = await deleteAssets(ids, req.clientId);
    deleted.forEach(a => unlinkSilent(resolveUploadPath(a.file_url)));

    res.json({ deleted });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const { clientScope }                   = require('../middleware/clientScope');
const { uploadLogo, handleUploadError } = require('../middleware/upload');
const {
  getBrandKitByClientId,
  upsertBrandKit,
  setLogoField,
  clearLogoField,
  deleteBrandKit,
} = require('../database/brandKits');

const router = express.Router();

// All brand-kit routes are client-scoped — req.clientId is always set.
router.use(clientScope);

// ── Validation helpers ────────────────────────────────────────────────────────

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isValidHex(v) { return typeof v === 'string' && HEX_RE.test(v); }

function validateColors(value, fieldName) {
  if (!Array.isArray(value)) return `${fieldName} must be an array`;
  const bad = value.filter(c => !isValidHex(c));
  if (bad.length) return `${fieldName} contains invalid hex values: ${bad.join(', ')}`;
  return null;
}

function validateFonts(value) {
  if (typeof value !== 'object' || Array.isArray(value) || value === null)
    return 'fonts must be an object';
  const allowed = new Set(['heading', 'body', 'accent', 'mono']);
  const bad = Object.keys(value).filter(k => !allowed.has(k));
  if (bad.length) return `fonts contains unknown keys: ${bad.join(', ')}. Allowed: heading, body, accent, mono`;
  return null;
}

function collectErrors(body) {
  const errors = [];

  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim())
      errors.push('name must be a non-empty string');
  }
  if ('description' in body && body.description !== null) {
    if (typeof body.description !== 'string')
      errors.push('description must be a string or null');
  }
  for (const field of ['primary_colors', 'secondary_colors', 'accent_colors']) {
    if (field in body) {
      const err = validateColors(body[field], field);
      if (err) errors.push(err);
    }
  }
  if ('fonts' in body && body.fonts !== null) {
    const err = validateFonts(body.fonts);
    if (err) errors.push(err);
  }
  if ('tone_of_voice' in body && body.tone_of_voice !== null) {
    if (typeof body.tone_of_voice !== 'string')
      errors.push('tone_of_voice must be a string or null');
  }

  return errors;
}

// ── GET /api/brand-kit ────────────────────────────────────────────────────────
// Returns the active client's brand kit, or null when none exists yet.
router.get('/', async (req, res, next) => {
  try {
    const kit = await getBrandKitByClientId(req.clientId);
    res.json({ brandKit: kit });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/brand-kit ────────────────────────────────────────────────────────
// Full create-or-replace. Sends the complete desired state; missing fields
// revert to their defaults. Use PATCH for partial updates.
router.put('/', async (req, res, next) => {
  try {
    const errors = collectErrors(req.body);
    if (errors.length) return res.status(400).json({ errors });

    const kit = await upsertBrandKit(req.clientId, req.body);
    res.json({ brandKit: kit });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/brand-kit ──────────────────────────────────────────────────────
// Partial update — merges only the fields supplied.
// Reads the current kit first so unchanged fields are preserved in the upsert.
router.patch('/', async (req, res, next) => {
  try {
    const errors = collectErrors(req.body);
    if (errors.length) return res.status(400).json({ errors });

    const existing = await getBrandKitByClientId(req.clientId);
    const merged   = { ...existing, ...req.body };

    const kit = await upsertBrandKit(req.clientId, merged);
    res.json({ brandKit: kit });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/brand-kit ─────────────────────────────────────────────────────
// Removes the brand kit for the active client.
// Generations that referenced it will see brand_kit_id set to NULL (ON DELETE SET NULL).
router.delete('/', async (req, res, next) => {
  try {
    const deleted = await deleteBrandKit(req.clientId);
    if (!deleted) return res.status(404).json({ error: 'No brand kit found for this client' });
    res.json({ deleted });
  } catch (err) {
    next(err);
  }
});

// ── Logo upload helpers ───────────────────────────────────────────────────────

// Map URL variant param → DB column name
const VARIANT_TO_FIELD = {
  light: 'logo_url',
  dark:  'logo_dark_url',
  icon:  'icon_url',
};

// Convert a stored public path ("/uploads/logos/foo.png") to a filesystem path
// so we can delete the old file when a replacement is uploaded.
function publicPathToFs(publicPath) {
  if (!publicPath) return null;
  return path.join(__dirname, '../public', publicPath);
}

function unlinkSilent(fsPath) {
  if (!fsPath) return;
  fs.unlink(fsPath, () => {}); // fire-and-forget; missing file is not an error
}

// ── POST /api/brand-kit/logo/:variant ────────────────────────────────────────
// Upload a logo file.  :variant must be "light", "dark", or "icon".
// Form field name must be "logo".
// Returns the full updated brand kit so the UI can refresh in one shot.
router.post(
  '/logo/:variant',
  uploadLogo.single('logo'),
  async (req, res, next) => {
    try {
      const field = VARIANT_TO_FIELD[req.params.variant];
      if (!field) {
        return res.status(400).json({ error: 'variant must be light, dark, or icon' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file received. Send a multipart field named "logo".' });
      }

      // Build the stable public URL path served by express.static
      const publicPath = `/uploads/logos/${req.file.filename}`;

      // Delete the previous file for this variant (if one exists)
      const existing = await getBrandKitByClientId(req.clientId);
      if (existing) unlinkSilent(publicPathToFs(existing[field]));

      // Persist — if the kit doesn't exist yet, upsertBrandKit creates it
      let kit;
      if (existing) {
        kit = await setLogoField(req.clientId, field, publicPath);
      } else {
        kit = await upsertBrandKit(req.clientId, { [field]: publicPath });
      }

      res.json({ brandKit: kit });
    } catch (err) {
      // Clean up the freshly-written file if the DB update failed
      if (req.file) unlinkSilent(req.file.path);
      if (handleUploadError(err, res)) return;
      next(err);
    }
  }
);

// ── DELETE /api/brand-kit/logo/:variant ──────────────────────────────────────
// Remove a specific logo variant from the brand kit and delete the file.
router.delete('/logo/:variant', async (req, res, next) => {
  try {
    const field = VARIANT_TO_FIELD[req.params.variant];
    if (!field) {
      return res.status(400).json({ error: 'variant must be light, dark, or icon' });
    }

    const existing = await getBrandKitByClientId(req.clientId);
    if (!existing) return res.status(404).json({ error: 'No brand kit found for this client' });
    if (!existing[field]) return res.status(404).json({ error: `No ${req.params.variant} logo set` });

    unlinkSilent(publicPathToFs(existing[field]));
    const kit = await clearLogoField(req.clientId, field);

    res.json({ brandKit: kit });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

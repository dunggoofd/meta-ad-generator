const { pool } = require('./init');

// ── Queries ───────────────────────────────────────────────────────────────────

async function getBrandKitByClientId(clientId) {
  const { rows } = await pool.query(
    'SELECT * FROM brand_kits WHERE client_id = $1 AND is_default = TRUE',
    [clientId]
  );
  return rows[0] || null;
}

// ── Upsert ────────────────────────────────────────────────────────────────────
// INSERT the first kit for a client; UPDATE it on every subsequent call.
// The partial unique index on (client_id) WHERE is_default = TRUE is the
// conflict target, enforcing exactly one default kit per client at the DB level.
//
// Only the fields that are explicitly provided in `fields` are written — callers
// that PATCH a subset of fields first read the existing row and merge before
// calling this function.

async function upsertBrandKit(clientId, fields) {
  const {
    name          = 'Brand Kit',
    description   = null,
    primary_colors   = [],
    secondary_colors = [],
    accent_colors    = [],
    fonts            = {},
    logo_url         = null,
    logo_dark_url    = null,
    icon_url         = null,
    tone_of_voice    = null,
    tagline          = null,
  } = fields;

  const { rows } = await pool.query(
    `INSERT INTO brand_kits
       (client_id, name, description, is_default,
        primary_colors, secondary_colors, accent_colors,
        fonts, logo_url, logo_dark_url, icon_url,
        tone_of_voice, tagline)
     VALUES ($1,$2,$3,TRUE,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (client_id) WHERE is_default = TRUE
     DO UPDATE SET
       name             = EXCLUDED.name,
       description      = EXCLUDED.description,
       primary_colors   = EXCLUDED.primary_colors,
       secondary_colors = EXCLUDED.secondary_colors,
       accent_colors    = EXCLUDED.accent_colors,
       fonts            = EXCLUDED.fonts,
       logo_url         = EXCLUDED.logo_url,
       logo_dark_url    = EXCLUDED.logo_dark_url,
       icon_url         = EXCLUDED.icon_url,
       tone_of_voice    = EXCLUDED.tone_of_voice,
       tagline          = EXCLUDED.tagline,
       updated_at       = NOW()
     RETURNING *`,
    [
      clientId, name, description,
      JSON.stringify(primary_colors),
      JSON.stringify(secondary_colors),
      JSON.stringify(accent_colors),
      JSON.stringify(fonts),
      logo_url, logo_dark_url, icon_url,
      tone_of_voice, tagline,
    ]
  );
  return rows[0];
}

// ── Logo field update ─────────────────────────────────────────────────────────
// Targeted UPDATE for a single logo column — avoids re-writing every field.
// `field` must be one of: logo_url | logo_dark_url | icon_url
const LOGO_FIELDS = new Set(['logo_url', 'logo_dark_url', 'icon_url']);

async function setLogoField(clientId, field, publicPath) {
  if (!LOGO_FIELDS.has(field)) throw new Error(`Invalid logo field: ${field}`);

  const { rows } = await pool.query(
    `UPDATE brand_kits
        SET ${field} = $1, updated_at = NOW()
      WHERE client_id = $2 AND is_default = TRUE
      RETURNING *`,
    [publicPath, clientId]
  );
  return rows[0] || null;
}

async function clearLogoField(clientId, field) {
  return setLogoField(clientId, field, null);
}

async function deleteBrandKit(clientId) {
  const { rows } = await pool.query(
    'DELETE FROM brand_kits WHERE client_id = $1 AND is_default = TRUE RETURNING *',
    [clientId]
  );
  return rows[0] || null;
}

module.exports = {
  getBrandKitByClientId,
  upsertBrandKit,
  setLogoField,
  clearLogoField,
  deleteBrandKit,
};

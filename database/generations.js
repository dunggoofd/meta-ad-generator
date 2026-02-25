const { pool } = require('./init');

// ── Image normalisation ───────────────────────────────────────────────────────
// Every entry stored in generated_images carries a consistent shape so the
// history board can render, score, and filter images without defensive checks.
//
// Shape: { url, width, height, content_type, is_selected, score, status }
//   status values: 'ready' | 'archived'

function normalizeImageEntry(img, selectedUrl) {
  const url = typeof img === 'string' ? img : (img?.url || null);
  if (!url) return null;
  return {
    url,
    width:        img?.width        ?? null,
    height:       img?.height       ?? null,
    content_type: img?.content_type ?? 'image/jpeg',
    is_selected:  Boolean(selectedUrl && url === selectedUrl),
    score:        img?.score        ?? null,
    status:       img?.status       ?? 'ready',
  };
}

function normalizeGenerationImages(images, selectedUrl = null) {
  if (!Array.isArray(images)) return [];
  return images.map(img => normalizeImageEntry(img, selectedUrl)).filter(Boolean);
}

// ── Fetch single ──────────────────────────────────────────────────────────────

async function getGenerationById(id, clientId) {
  const { rows } = await pool.query(
    'SELECT * FROM generations WHERE id = $1 AND client_id = $2',
    [id, clientId]
  );
  return rows[0] || null;
}

// ── List ──────────────────────────────────────────────────────────────────────

async function getAllGenerations(clientId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM generations
     WHERE client_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [clientId, limit, offset]
  );
  return rows;
}

// ── Create ────────────────────────────────────────────────────────────────────

async function createGeneration({
  client_id,
  brand_kit_id  = null,
  template_id   = null,
  prompt        = null,
  headline      = null,
  body_copy     = null,
  cta           = null,
  concept       = null,
  avatar        = null,
  asset_ids     = [],
  metadata      = {},
}) {
  const { rows } = await pool.query(
    `INSERT INTO generations
       (client_id, brand_kit_id, template_id, status,
        prompt, headline, body_copy, cta,
        concept, avatar, asset_ids, metadata)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      client_id,
      brand_kit_id || null,
      template_id  || null,
      prompt,
      headline,
      body_copy,
      cta,
      concept,
      avatar,
      JSON.stringify(Array.isArray(asset_ids) ? asset_ids : []),
      JSON.stringify(metadata),
    ]
  );
  return rows[0];
}

// ── Update ────────────────────────────────────────────────────────────────────
// generated_images is normalized before storage: each entry is enriched with
// is_selected, score, and status so the board UX never needs to guard against
// missing fields. All other updatable fields are written as-is.

const UPDATABLE   = new Set([
  'status', 'generated_images', 'selected_image_url', 'error',
  'prompt', 'headline', 'body_copy', 'cta',
  'concept', 'avatar', 'asset_ids',
  'metadata',
]);
const JSON_FIELDS = new Set(['generated_images', 'asset_ids', 'metadata']);

async function updateGeneration(id, clientId, fields) {
  const sets   = [];
  const values = [];
  let   i      = 1;

  // Normalize generated_images before storage; use selected_image_url from the
  // same update call (if present) to mark which entry is selected.
  if ('generated_images' in fields) {
    const selectedUrl = fields.selected_image_url ?? null;
    const normalized  = normalizeGenerationImages(fields.generated_images, selectedUrl);
    sets.push(`generated_images = $${i++}`);
    values.push(JSON.stringify(normalized));
  }

  for (const key of UPDATABLE) {
    if (!(key in fields) || key === 'generated_images') continue; // generated_images handled above
    sets.push(`${key} = $${i++}`);
    values.push(JSON_FIELDS.has(key) ? JSON.stringify(fields[key]) : fields[key]);
  }

  if (sets.length === 0) return getGenerationById(id, clientId);

  sets.push(`updated_at = NOW()`);
  values.push(id, clientId);

  const { rows } = await pool.query(
    `UPDATE generations
        SET ${sets.join(', ')}
      WHERE id = $${i} AND client_id = $${i + 1}
      RETURNING *`,
    values
  );
  return rows[0] || null;
}

module.exports = {
  getGenerationById,
  getAllGenerations,
  createGeneration,
  updateGeneration,
  normalizeGenerationImages,
};

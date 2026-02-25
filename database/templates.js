const { pool } = require('./init');

// ── List ──────────────────────────────────────────────────────────────────────
// Supports optional filters: category, source_type, platform, is_favorite,
// is_active (defaults to TRUE), tags (array → matches any), search (name ILIKE).
// Results are ordered: favorites first, then newest first.

async function getAllTemplates({
  category,
  source_type,
  platform,
  is_favorite,
  is_active   = true,
  tags,
  search,
} = {}) {
  const conditions = [];
  const values     = [];
  let   i          = 1;

  if (is_active !== undefined) {
    conditions.push(`is_active = $${i++}`);
    values.push(is_active);
  }
  if (category !== undefined) {
    conditions.push(`category = $${i++}`);
    values.push(category);
  }
  if (source_type !== undefined) {
    conditions.push(`source_type = $${i++}`);
    values.push(source_type);
  }
  if (platform !== undefined) {
    conditions.push(`platform = $${i++}`);
    values.push(platform);
  }
  if (is_favorite !== undefined) {
    conditions.push(`is_favorite = $${i++}`);
    values.push(is_favorite);
  }
  // Tags: match templates that contain ANY of the requested tags (?| operator)
  if (Array.isArray(tags) && tags.length > 0) {
    conditions.push(`tags ?| $${i++}::text[]`);
    values.push(tags);
  }
  if (search) {
    conditions.push(`name ILIKE $${i++}`);
    values.push(`%${search}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM templates ${where}
     ORDER BY is_favorite DESC, created_at DESC`,
    values
  );
  return rows;
}

async function getTemplateById(id) {
  const { rows } = await pool.query(
    'SELECT * FROM templates WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

// ── Create ────────────────────────────────────────────────────────────────────

async function createTemplate({
  name,
  slug,
  description   = null,
  platform      = 'meta',
  category      = null,
  dimensions    = { width: 1080, height: 1080 },
  thumbnail_url = null,
  is_active     = true,
  tags          = [],
  is_favorite   = false,
  source_type   = 'starter',
  metadata      = {},
}) {
  const { rows } = await pool.query(
    `INSERT INTO templates
       (name, slug, description, platform, category, dimensions,
        thumbnail_url, is_active, tags, is_favorite, source_type, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      name, slug, description, platform, category,
      JSON.stringify(dimensions),
      thumbnail_url, is_active,
      JSON.stringify(tags),
      is_favorite, source_type,
      JSON.stringify(metadata),
    ]
  );
  return rows[0];
}

// ── Update ────────────────────────────────────────────────────────────────────
// Accepts any subset of allowed fields; regenerates slug when name changes.

const UPDATABLE = new Set([
  'name', 'slug', 'description', 'platform', 'category',
  'dimensions', 'is_active', 'tags', 'is_favorite', 'source_type', 'metadata',
]);

// Fields whose values must be JSON-stringified before binding
const JSON_FIELDS = new Set(['dimensions', 'tags', 'metadata']);

async function updateTemplate(id, fields) {
  const sets   = [];
  const values = [];
  let   i      = 1;

  for (const key of UPDATABLE) {
    if (!(key in fields)) continue;
    sets.push(`${key} = $${i++}`);
    values.push(JSON_FIELDS.has(key) ? JSON.stringify(fields[key]) : fields[key]);
  }

  if (sets.length === 0) return getTemplateById(id);

  sets.push(`updated_at = NOW()`);
  values.push(id);

  const { rows } = await pool.query(
    `UPDATE templates SET ${sets.join(', ')}
     WHERE id = $${i} RETURNING *`,
    values
  );
  return rows[0] || null;
}

// ── Favorite toggle ───────────────────────────────────────────────────────────

async function toggleFavorite(id) {
  const { rows } = await pool.query(
    `UPDATE templates
        SET is_favorite = NOT is_favorite, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

// ── Thumbnail helpers ─────────────────────────────────────────────────────────

async function setThumbnail(id, thumbnailUrl) {
  const { rows } = await pool.query(
    `UPDATE templates
        SET thumbnail_url = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
    [thumbnailUrl, id]
  );
  return rows[0] || null;
}

async function clearThumbnail(id) {
  return setThumbnail(id, null);
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function deleteTemplate(id) {
  const { rows } = await pool.query(
    'DELETE FROM templates WHERE id = $1 RETURNING *',
    [id]
  );
  return rows[0] || null;
}

module.exports = {
  getAllTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  toggleFavorite,
  setThumbnail,
  clearThumbnail,
  deleteTemplate,
};

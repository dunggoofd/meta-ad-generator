const { pool } = require('./init');

// ── Category derivation ───────────────────────────────────────────────────────
// Keeps category deterministic — never null — without requiring callers to know
// the mapping. Extend this table as new MIME types are accepted by the uploader.

const MIME_TO_CATEGORY = {
  'image/jpeg':        'image',
  'image/jpg':         'image',
  'image/png':         'image',
  'image/webp':        'image',
  'image/svg+xml':     'image',
  'image/gif':         'image',
  'video/mp4':         'video',
  'video/quicktime':   'video',
  'video/webm':        'video',
  'font/ttf':          'font',
  'font/woff':         'font',
  'font/woff2':        'font',
  'font/otf':          'font',
  'application/pdf':   'document',
  'text/plain':        'document',
};

function categoryFromMime(mime) {
  return MIME_TO_CATEGORY[mime] ?? 'other';
}

// ── List ──────────────────────────────────────────────────────────────────────
// Always scoped to a client. Optional filters: category, source, brand_kit_id,
// tags (any-match), search (name OR original_name ILIKE).

async function getAllAssets({
  clientId,
  category,
  source,
  brand_kit_id,
  tags,
  search,
} = {}) {
  const conditions = ['client_id = $1'];
  const values     = [clientId];
  let   i          = 2;

  if (category !== undefined) {
    conditions.push(`category = $${i++}`);
    values.push(category);
  }
  if (source !== undefined) {
    conditions.push(`source = $${i++}`);
    values.push(source);
  }
  if (brand_kit_id !== undefined) {
    conditions.push(`brand_kit_id = $${i++}`);
    values.push(brand_kit_id);
  }
  if (Array.isArray(tags) && tags.length > 0) {
    conditions.push(`tags ?| $${i++}::text[]`);
    values.push(tags);
  }
  if (search) {
    conditions.push(`(name ILIKE $${i} OR original_name ILIKE $${i})`);
    i++;
    values.push(`%${search}%`);
  }

  const { rows } = await pool.query(
    `SELECT * FROM assets
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values
  );
  return rows;
}

async function getAssetById(id, clientId) {
  const { rows } = await pool.query(
    'SELECT * FROM assets WHERE id = $1 AND client_id = $2',
    [id, clientId]
  );
  return rows[0] || null;
}

// ── Create ────────────────────────────────────────────────────────────────────
// `category` defaults to the MIME-derived value; callers can override explicitly.

async function createAsset({
  client_id,
  brand_kit_id  = null,
  name,
  original_name,
  file_url,
  file_type,
  file_size     = null,
  width         = null,
  height        = null,
  source        = 'upload',
  tags          = [],
  category,           // if omitted, derive from file_type
  metadata      = {},
}) {
  const resolvedCategory = category ?? categoryFromMime(file_type) ?? 'other';

  const { rows } = await pool.query(
    `INSERT INTO assets
       (client_id, brand_kit_id, name, original_name,
        file_url, file_type, file_size, width, height,
        source, tags, category, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      client_id, brand_kit_id, name, original_name,
      file_url, file_type, file_size, width, height,
      source, JSON.stringify(tags), resolvedCategory,
      JSON.stringify(metadata),
    ]
  );
  return rows[0];
}

// ── Update ────────────────────────────────────────────────────────────────────
// Updatable by users: name, tags, category, brand_kit_id, metadata.
// file_url / file_type are immutable after upload.

const UPDATABLE = new Set(['name', 'tags', 'category', 'brand_kit_id', 'metadata']);
const JSON_FIELDS = new Set(['tags', 'metadata']);

async function updateAsset(id, clientId, fields) {
  const sets   = [];
  const values = [];
  let   i      = 1;

  for (const key of UPDATABLE) {
    if (!(key in fields)) continue;
    sets.push(`${key} = $${i++}`);
    values.push(JSON_FIELDS.has(key) ? JSON.stringify(fields[key]) : fields[key]);
  }

  if (sets.length === 0) return getAssetById(id, clientId);

  sets.push(`updated_at = NOW()`);
  values.push(id, clientId);

  const { rows } = await pool.query(
    `UPDATE assets
        SET ${sets.join(', ')}
      WHERE id = $${i} AND client_id = $${i + 1}
      RETURNING *`,
    values
  );
  return rows[0] || null;
}

// ── Delete ────────────────────────────────────────────────────────────────────
// Returns the deleted row so the caller can clean up the file on disk.

async function deleteAsset(id, clientId) {
  const { rows } = await pool.query(
    'DELETE FROM assets WHERE id = $1 AND client_id = $2 RETURNING *',
    [id, clientId]
  );
  return rows[0] || null;
}

// ── Bulk delete ───────────────────────────────────────────────────────────────
// Deletes all assets whose ids are in the array and belong to clientId.
// Returns the deleted rows for file cleanup.

async function deleteAssets(ids, clientId) {
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `DELETE FROM assets
     WHERE id = ANY($1::int[]) AND client_id = $2
     RETURNING *`,
    [ids, clientId]
  );
  return rows;
}

module.exports = {
  categoryFromMime,
  getAllAssets,
  getAssetById,
  createAsset,
  updateAsset,
  deleteAsset,
  deleteAssets,
};

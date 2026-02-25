const { pool } = require('./init');

// ── Fetch all ─────────────────────────────────────────────────────────────────

async function getBrandIntelligenceByClientId(clientId) {
  const { rows } = await pool.query(
    `SELECT * FROM brand_intelligence WHERE client_id = $1 ORDER BY created_at DESC`,
    [clientId]
  );
  return rows;
}

// ── Fetch single ──────────────────────────────────────────────────────────────

async function getBrandIntelligenceById(id, clientId) {
  const { rows } = await pool.query(
    'SELECT * FROM brand_intelligence WHERE id = $1 AND client_id = $2',
    [id, clientId]
  );
  return rows[0] || null;
}

// ── Create ────────────────────────────────────────────────────────────────────

async function createBrandIntelligence({
  client_id,
  brand_kit_id      = null,
  source_url        = null,
  unique_value_prop = null,
  target_audience   = null,
  tone_summary      = null,
  keywords          = [],
  competitors       = [],
  pain_points       = [],
  differentiators   = [],
  raw_analysis      = {},
  source            = 'manual',
}) {
  const { rows } = await pool.query(
    `INSERT INTO brand_intelligence
       (client_id, brand_kit_id, source_url, unique_value_prop, target_audience,
        tone_summary, keywords, competitors, pain_points, differentiators, raw_analysis, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      client_id,
      brand_kit_id || null,
      source_url,
      unique_value_prop,
      target_audience,
      tone_summary,
      JSON.stringify(Array.isArray(keywords)        ? keywords        : []),
      JSON.stringify(Array.isArray(competitors)     ? competitors     : []),
      JSON.stringify(Array.isArray(pain_points)     ? pain_points     : []),
      JSON.stringify(Array.isArray(differentiators) ? differentiators : []),
      JSON.stringify(raw_analysis && typeof raw_analysis === 'object' ? raw_analysis : {}),
      source,
    ]
  );
  return rows[0];
}

// ── Update ────────────────────────────────────────────────────────────────────

const UPDATABLE   = new Set([
  'source_url', 'unique_value_prop', 'target_audience', 'tone_summary',
  'keywords', 'competitors', 'pain_points', 'differentiators', 'raw_analysis', 'source',
]);
const JSON_FIELDS = new Set(['keywords', 'competitors', 'pain_points', 'differentiators', 'raw_analysis']);

async function updateBrandIntelligence(id, clientId, fields) {
  const sets   = [];
  const values = [];
  let   i      = 1;

  for (const key of UPDATABLE) {
    if (!(key in fields)) continue;
    sets.push(`${key} = $${i++}`);
    values.push(JSON_FIELDS.has(key) ? JSON.stringify(fields[key]) : fields[key]);
  }

  if (sets.length === 0) return getBrandIntelligenceById(id, clientId);

  sets.push(`updated_at = NOW()`);
  values.push(id, clientId);

  const { rows } = await pool.query(
    `UPDATE brand_intelligence
        SET ${sets.join(', ')}
      WHERE id = $${i} AND client_id = $${i + 1}
      RETURNING *`,
    values
  );
  return rows[0] || null;
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function deleteBrandIntelligence(id, clientId) {
  const { rows } = await pool.query(
    'DELETE FROM brand_intelligence WHERE id = $1 AND client_id = $2 RETURNING id',
    [id, clientId]
  );
  return rows[0] || null;
}

module.exports = {
  getBrandIntelligenceByClientId,
  getBrandIntelligenceById,
  createBrandIntelligence,
  updateBrandIntelligence,
  deleteBrandIntelligence,
};

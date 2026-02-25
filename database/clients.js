const { pool } = require('./init');

// ── Queries ───────────────────────────────────────────────────────────────────

async function getAllClients() {
  const { rows } = await pool.query(
    'SELECT * FROM clients ORDER BY name ASC'
  );
  return rows;
}

async function getClientById(id) {
  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

async function getDefaultClient() {
  const { rows } = await pool.query(
    'SELECT * FROM clients ORDER BY id ASC LIMIT 1'
  );
  return rows[0] || null;
}

async function createClient({ name, slug, email = null, website = null, industry = null }) {
  const { rows } = await pool.query(
    `INSERT INTO clients (name, slug, email, website, industry)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [name, slug, email, website, industry]
  );
  return rows[0];
}

async function countClients() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM clients');
  return rows[0].total;
}

async function deleteClient(id) {
  const { rows } = await pool.query(
    'DELETE FROM clients WHERE id = $1 RETURNING *',
    [id]
  );
  return rows[0] || null;
}

async function updateClient(id, fields) {
  const allowed = ['name', 'slug', 'email', 'website', 'industry', 'metadata'];
  const updates = [];
  const values = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = $${updates.length + 1}`);
      values.push(fields[key]);
    }
  }

  if (updates.length === 0) return getClientById(id);

  updates.push(`updated_at = NOW()`);
  values.push(id);

  const { rows } = await pool.query(
    `UPDATE clients SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  return rows[0] || null;
}

// ── Default-client seed ───────────────────────────────────────────────────────
// Called at server start. If no clients exist at all, creates a "My Brand"
// workspace so the app is immediately usable without any setup.

async function ensureDefaultClient() {
  const existing = await getDefaultClient();
  if (existing) return existing;

  console.log('[db] No clients found — seeding default workspace…');
  const client = await createClient({ name: 'My Brand', slug: 'my-brand' });
  console.log(`[db] Default client created  name="My Brand"  id=${client.id}`);
  return client;
}

module.exports = {
  getAllClients,
  getClientById,
  getDefaultClient,
  countClients,
  createClient,
  updateClient,
  deleteClient,
  ensureDefaultClient,
};

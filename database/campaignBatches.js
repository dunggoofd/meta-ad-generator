const { pool } = require('./init');

// ── Create ────────────────────────────────────────────────────────────────────

async function createCampaignBatch({ client_id, goal = null, total_items = 0, metadata = {} }) {
  const { rows } = await pool.query(
    `INSERT INTO campaign_batches (client_id, goal, total_items, metadata)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [client_id, goal, total_items, JSON.stringify(metadata)]
  );
  return rows[0];
}

// ── Fetch with per-item generation status ─────────────────────────────────────

async function getCampaignBatch(batchId, clientId) {
  const { rows: batchRows } = await pool.query(
    'SELECT * FROM campaign_batches WHERE id = $1 AND client_id = $2',
    [batchId, clientId]
  );
  if (!batchRows[0]) return null;

  const batch = batchRows[0];

  // Pull all generations linked to this batch, ordered by creation
  const { rows: genRows } = await pool.query(
    `SELECT id, status, prompt, headline, cta, concept, avatar,
            selected_image_url, generated_images, error, metadata, created_at
     FROM generations
     WHERE campaign_batch_id = $1 AND client_id = $2
     ORDER BY id ASC`,
    [batchId, clientId]
  );

  batch.items = genRows.map(g => {
    const meta       = g.metadata || {};
    const firstImage = Array.isArray(g.generated_images) ? g.generated_images[0] : null;
    return {
      generation_id: g.id,
      index:         meta.batch_item_index ?? null,
      persona:       meta.persona          ?? null,
      angle:         meta.angle            ?? null,
      status:        g.status,
      prompt:        g.prompt,
      headline:      g.headline,
      concept:       g.concept,
      image_url:     g.selected_image_url || firstImage?.url || null,
      error:         g.error,
      created_at:    g.created_at,
    };
  });

  return batch;
}

// ── Update batch status ───────────────────────────────────────────────────────
// Recalculates batch status from its generation rows.
// Call after every item update to keep the batch status in sync.

async function refreshBatchStatus(batchId, clientId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)                                    AS total,
       COUNT(*) FILTER (WHERE status = 'done')     AS done_count,
       COUNT(*) FILTER (WHERE status = 'failed')   AS failed_count,
       COUNT(*) FILTER (WHERE status IN ('pending','processing')) AS in_flight
     FROM generations
     WHERE campaign_batch_id = $1 AND client_id = $2`,
    [batchId, clientId]
  );

  const { total, done_count, failed_count, in_flight } = rows[0];
  const inFlight = parseInt(in_flight, 10);

  let status;
  if (inFlight > 0) {
    status = 'running';
  } else if (parseInt(failed_count, 10) === parseInt(total, 10)) {
    status = 'failed';
  } else {
    status = 'done';
  }

  await pool.query(
    `UPDATE campaign_batches
        SET status = $1, updated_at = NOW()
      WHERE id = $2 AND client_id = $3`,
    [status, batchId, clientId]
  );

  return status;
}

module.exports = { createCampaignBatch, getCampaignBatch, refreshBatchStatus };

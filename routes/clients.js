const express = require('express');
const { clientScope } = require('../middleware/clientScope');
const {
  getAllClients,
  getClientById,
  getDefaultClient,
  countClients,
  createClient,
  updateClient,
  deleteClient,
} = require('../database/clients');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function setActiveCookie(res, clientId) {
  res.cookie('active_client_id', String(clientId), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
}

function clearActiveCookie(res) {
  res.clearCookie('active_client_id');
}

// ── GET /api/clients ──────────────────────────────────────────────────────────
// List all clients. No scope guard — this is the workspace picker.
router.get('/', async (req, res, next) => {
  try {
    const clients = await getAllClients();
    res.json({ clients });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/clients ─────────────────────────────────────────────────────────
// Create a new client workspace.
// Returns the new client + full updated list so the UI can refresh in one shot.
router.post('/', async (req, res, next) => {
  try {
    const { name, email, website, industry } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const slug   = slugify(name.trim());
    const client = await createClient({ name: name.trim(), slug, email, website, industry });
    const clients = await getAllClients();

    res.status(201).json({ client, clients });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A client with that name already exists.' });
    }
    next(err);
  }
});

// ── GET /api/clients/active ───────────────────────────────────────────────────
// Returns the active client resolved by clientScope (cookie → default fallback).
router.get('/active', clientScope, (req, res) => {
  res.json({ client: req.client });
});

// ── PUT /api/clients/active ───────────────────────────────────────────────────
// Switch the active workspace. Writes an httpOnly cookie used by clientScope.
router.put('/active', async (req, res, next) => {
  try {
    const id = parseInt(req.body.clientId, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'clientId must be a number' });
    }

    const client = await getClientById(id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    setActiveCookie(res, client.id);
    res.json({ client });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/clients/:id ──────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const client = await getClientById(parseInt(req.params.id, 10));
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({ client });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/clients/:id ────────────────────────────────────────────────────
// Rename or update a client's fields.
// Re-derives the slug automatically when name changes.
router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    const existing = await getClientById(id);
    if (!existing) return res.status(404).json({ error: 'Client not found' });

    // Auto-update slug whenever the name is renamed
    const fields = { ...req.body };
    if (fields.name) {
      fields.name = fields.name.trim();
      if (!fields.name) return res.status(400).json({ error: 'name cannot be empty' });
      fields.slug = slugify(fields.name);
    }

    const client = await updateClient(id, fields);
    res.json({ client });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A client with that name already exists.' });
    }
    next(err);
  }
});

// ── DELETE /api/clients/:id ───────────────────────────────────────────────────
// Delete a client and all its cascaded data.
//
// Safety rules:
//   1. Client must exist              → 404
//   2. Must not be the last client    → 409  (app would have no workspace)
//   3. If the deleted client was the active cookie, auto-advance the cookie to
//      the next available client so the UI never lands in a broken state.
//
// Returns: { deleted, clients }  — full refreshed list for instant UI update.
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    // Rule 1 — must exist
    const target = await getClientById(id);
    if (!target) return res.status(404).json({ error: 'Client not found' });

    // Rule 2 — must not be the last client
    const total = await countClients();
    if (total <= 1) {
      return res.status(409).json({
        error: 'Cannot delete the last workspace. Create another client first.',
      });
    }

    // Delete (cascades to brand_kits, generations, assets, etc.)
    await deleteClient(id);

    // Rule 3 — if deleted client was the active cookie, advance to another
    const cookieId = parseInt(req.cookies?.active_client_id, 10);
    if (cookieId === id) {
      const next = await getDefaultClient(); // lowest remaining id
      if (next) setActiveCookie(res, next.id);
      else clearActiveCookie(res);
    }

    const clients = await getAllClients();
    res.json({ deleted: target, clients });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

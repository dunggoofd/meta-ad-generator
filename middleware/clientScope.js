const { getClientById, getDefaultClient } = require('../database/clients');

// ── clientScope middleware ────────────────────────────────────────────────────
// Attaches req.clientId and req.client to every request that passes through it.
//
// Resolution order:
//   1. X-Client-Id header  (programmatic / API callers)
//   2. active_client_id cookie  (browser UI)
//   3. Default client (lowest id) — first-time user fallback
//
// If none of the above resolve to a real client row the request is rejected
// with 503 so no route handler ever runs without a valid client context.
// This makes cross-client data leakage structurally impossible in route code.

async function clientScope(req, res, next) {
  try {
    let client = null;

    // 1. Explicit header (highest precedence — useful for scripts/API tests)
    const headerId = parseInt(req.headers['x-client-id'], 10);
    if (!isNaN(headerId)) {
      client = await getClientById(headerId);
    }

    // 2. Cookie set by the UI when the user switches workspace
    if (!client) {
      const cookieId = parseInt(req.cookies?.active_client_id, 10);
      if (!isNaN(cookieId)) {
        client = await getClientById(cookieId);
      }
    }

    // 3. Automatic fallback — default (lowest id) client
    if (!client) {
      client = await getDefaultClient();
    }

    if (!client) {
      return res.status(503).json({
        error: 'No client workspace found. Please create a client first.',
      });
    }

    req.clientId = client.id;
    req.client   = client;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { clientScope };

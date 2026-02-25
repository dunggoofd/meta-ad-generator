require('dotenv').config();
const express      = require('express');
const path         = require('path');
const cookieParser = require('cookie-parser');

const { initDatabase }       = require('./database/init');
const { ensureDefaultClient } = require('./database/clients');

const clientsRouter  = require('./routes/clients');
const brandKitRouter = require('./routes/brandKit');

const app      = express();
const PORT     = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/clients',   clientsRouter);
app.use('/api/brand-kit', brandKitRouter);

// Future resource routers (generations, assets, …) mount here.
// Each router applies clientScope so req.clientId is always set.

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    env: NODE_ENV,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ── UI Route ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await initDatabase();
  await ensureDefaultClient();

  app.listen(PORT, () => {
    console.log('──────────────────────────────────────────');
    console.log('  Static Ads Generator');
    console.log('──────────────────────────────────────────');
    console.log(`  Environment : ${NODE_ENV}`);
    console.log(`  Database    : ${process.env.DATABASE_URL ? 'connected' : 'DATABASE_URL not set'}`);
    console.log(`  URL         : http://localhost:${PORT}`);
    console.log(`  Health      : http://localhost:${PORT}/api/health`);
    console.log('──────────────────────────────────────────');
  });
}

start().catch((err) => {
  console.error('[fatal] Server failed to start:', err.message);
  process.exit(1);
});

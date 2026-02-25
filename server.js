require('dotenv').config();
const express      = require('express');
const path         = require('path');
const cookieParser = require('cookie-parser');

const { initDatabase }       = require('./database/init');
const { ensureDefaultClient } = require('./database/clients');
const { configureFal }    = require('./services/fal');
const { configureGemini } = require('./services/gemini');
const { ensureUploadDirs } = require('./middleware/upload');

const clientsRouter          = require('./routes/clients');
const brandKitRouter         = require('./routes/brandKit');
const templatesRouter        = require('./routes/templates');
const generationsRouter      = require('./routes/generations');
const assetsRouter           = require('./routes/assets');
const generateRouter         = require('./routes/generate');
const brandIntelligenceRouter = require('./routes/brandIntelligence');
const promptComposeRouter    = require('./routes/promptCompose');
const promptReverseRouter    = require('./routes/promptReverse');
const promptConceptsRouter   = require('./routes/promptConcepts');
const campaignRouter         = require('./routes/campaign');

const app      = express();
const PORT     = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/clients',            clientsRouter);
app.use('/api/brand-kit',          brandKitRouter);
app.use('/api/templates',          templatesRouter);
app.use('/api/generations',        generationsRouter);
app.use('/api/assets',             assetsRouter);
app.use('/api/generate',           generateRouter);
app.use('/api/brand-intelligence', brandIntelligenceRouter);
app.use('/api/prompt',            promptComposeRouter);
app.use('/api/prompt/reverse',    promptReverseRouter);
app.use('/api/prompt/concepts',   promptConceptsRouter);
app.use('/api/campaign',          campaignRouter);

// Future resource routers (assets, …) mount here.
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
  if (NODE_ENV !== 'production') {
    console.error('[error]', err.stack || err.message);
  } else {
    console.error('[error]', err.message);
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  if (!process.env.DATABASE_URL) {
    console.error('[fatal] DATABASE_URL is not set.');
    console.error('        Set it in a .env file or as an environment variable, then restart.');
    process.exit(1);
  }

  ensureUploadDirs();
  await initDatabase();
  await ensureDefaultClient();
  configureFal();
  configureGemini();

  app.listen(PORT, '0.0.0.0', () => {
    console.log('──────────────────────────────────────────');
    console.log('  Static Ads Generator');
    console.log('──────────────────────────────────────────');
    console.log(`  Environment : ${NODE_ENV}`);
    console.log(`  FAL key     : ${process.env.FAL_KEY     ? 'set' : 'MISSING — image generation disabled'}`);
    console.log(`  Gemini key  : ${process.env.GEMINI_KEY  ? 'set' : 'MISSING — AI features disabled'}`);
    console.log(`  URL         : http://0.0.0.0:${PORT}`);
    console.log(`  Health      : http://0.0.0.0:${PORT}/api/health`);
    console.log('──────────────────────────────────────────');
  });
}

start().catch((err) => {
  console.error('[fatal] Server failed to start:', err.message);
  process.exit(1);
});

// ── Process-level safety nets ─────────────────────────────────────────────────
// Catch async errors that escape all try/catch blocks so the process doesn't
// silently die without a log entry.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack);
  // Give the event loop a tick to flush logs, then exit so a process manager
  // (e.g. pm2, systemd) can restart cleanly.
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 500);
});

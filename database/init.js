const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ── Schema ────────────────────────────────────────────────────────────────────
// All CREATE TABLE / CREATE INDEX / CREATE UNIQUE INDEX statements use
// IF NOT EXISTS — safe to re-run on every boot.
// New columns are added via ALTER TABLE … ADD COLUMN IF NOT EXISTS at the
// bottom of the migrations section so iterative development never requires
// a teardown.

const INIT_SQL = `

  -- ── clients ────────────────────────────────────────────────────────────────
  -- Top-level tenant. Every other entity belongs to a client.
  CREATE TABLE IF NOT EXISTS clients (
    id          SERIAL        PRIMARY KEY,
    name        VARCHAR(255)  NOT NULL,
    slug        VARCHAR(100)  NOT NULL UNIQUE,
    email       VARCHAR(255),
    website     VARCHAR(500),
    industry    VARCHAR(100),
    metadata    JSONB         NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uidx_clients_slug ON clients (slug);
  CREATE        INDEX IF NOT EXISTS idx_clients_industry ON clients (industry);


  -- ── brand_kits ─────────────────────────────────────────────────────────────
  -- Stores the visual + voice identity for a client.
  -- primary_colors / fonts are JSONB arrays so the UI can iterate freely.
  CREATE TABLE IF NOT EXISTS brand_kits (
    id              SERIAL        PRIMARY KEY,
    client_id       INTEGER       NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name            VARCHAR(255)  NOT NULL,
    is_default      BOOLEAN       NOT NULL DEFAULT FALSE,
    primary_colors  JSONB         NOT NULL DEFAULT '[]',
    secondary_colors JSONB        NOT NULL DEFAULT '[]',
    fonts           JSONB         NOT NULL DEFAULT '{}',
    logo_url        TEXT,
    logo_dark_url   TEXT,
    icon_url        TEXT,
    tone_of_voice   VARCHAR(100),
    tagline         TEXT,
    metadata        JSONB         NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_brand_kits_client_id  ON brand_kits (client_id);
  -- Only one default brand kit per client
  CREATE UNIQUE INDEX IF NOT EXISTS uidx_brand_kits_client_default
    ON brand_kits (client_id) WHERE is_default = TRUE;


  -- ── brand_intelligence ─────────────────────────────────────────────────────
  -- AI-extracted strategic data scraped from a client's website / materials.
  CREATE TABLE IF NOT EXISTS brand_intelligence (
    id                  SERIAL       PRIMARY KEY,
    client_id           INTEGER      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    brand_kit_id        INTEGER      REFERENCES brand_kits(id) ON DELETE SET NULL,
    source_url          TEXT,
    unique_value_prop   TEXT,
    target_audience     TEXT,
    tone_summary        TEXT,
    keywords            JSONB        NOT NULL DEFAULT '[]',
    competitors         JSONB        NOT NULL DEFAULT '[]',
    pain_points         JSONB        NOT NULL DEFAULT '[]',
    differentiators     JSONB        NOT NULL DEFAULT '[]',
    raw_analysis        JSONB        NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_brand_intelligence_client_id
    ON brand_intelligence (client_id);
  CREATE INDEX IF NOT EXISTS idx_brand_intelligence_brand_kit_id
    ON brand_intelligence (brand_kit_id);


  -- ── templates ──────────────────────────────────────────────────────────────
  -- Reusable ad layout definitions (dimensions, platform, category).
  CREATE TABLE IF NOT EXISTS templates (
    id            SERIAL        PRIMARY KEY,
    name          VARCHAR(255)  NOT NULL,
    slug          VARCHAR(100)  NOT NULL UNIQUE,
    description   TEXT,
    platform      VARCHAR(50)   NOT NULL DEFAULT 'meta',
    category      VARCHAR(50),
    dimensions    JSONB         NOT NULL DEFAULT '{"width":1080,"height":1080}',
    thumbnail_url TEXT,
    is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
    metadata      JSONB         NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uidx_templates_slug ON templates (slug);
  CREATE        INDEX IF NOT EXISTS idx_templates_platform  ON templates (platform);
  CREATE        INDEX IF NOT EXISTS idx_templates_is_active ON templates (is_active);


  -- ── assets ─────────────────────────────────────────────────────────────────
  -- Uploaded or AI-generated image / video files linked to a client.
  CREATE TABLE IF NOT EXISTS assets (
    id            SERIAL        PRIMARY KEY,
    client_id     INTEGER       NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    brand_kit_id  INTEGER       REFERENCES brand_kits(id) ON DELETE SET NULL,
    name          VARCHAR(255),
    file_url      TEXT          NOT NULL,
    file_type     VARCHAR(50),
    file_size     INTEGER,
    width         INTEGER,
    height        INTEGER,
    source        VARCHAR(50)   NOT NULL DEFAULT 'upload',
    tags          JSONB         NOT NULL DEFAULT '[]',
    metadata      JSONB         NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_assets_client_id    ON assets (client_id);
  CREATE INDEX IF NOT EXISTS idx_assets_brand_kit_id ON assets (brand_kit_id);
  CREATE INDEX IF NOT EXISTS idx_assets_source       ON assets (source);


  -- ── campaign_tags ──────────────────────────────────────────────────────────
  -- Organisational labels attached to generations for filtering in the UI.
  CREATE TABLE IF NOT EXISTS campaign_tags (
    id          SERIAL       PRIMARY KEY,
    client_id   INTEGER      REFERENCES clients(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    slug        VARCHAR(100) NOT NULL,
    color       VARCHAR(20)  NOT NULL DEFAULT '#6366f1',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  -- Tag slugs must be unique per client (NULL client_id = global tag)
  CREATE UNIQUE INDEX IF NOT EXISTS uidx_campaign_tags_client_slug
    ON campaign_tags (client_id, slug);
  CREATE INDEX IF NOT EXISTS idx_campaign_tags_client_id ON campaign_tags (client_id);


  -- ── generations ────────────────────────────────────────────────────────────
  -- One row per ad generation request.  generated_images is a JSONB array of
  -- image objects so the UI can display, compare, and select variants easily.
  CREATE TABLE IF NOT EXISTS generations (
    id                  SERIAL        PRIMARY KEY,
    client_id           INTEGER       NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    brand_kit_id        INTEGER       REFERENCES brand_kits(id) ON DELETE SET NULL,
    template_id         INTEGER       REFERENCES templates(id) ON DELETE SET NULL,
    status              VARCHAR(20)   NOT NULL DEFAULT 'pending',
    prompt              TEXT,
    headline            TEXT,
    body_copy           TEXT,
    cta                 VARCHAR(100),
    generated_images    JSONB         NOT NULL DEFAULT '[]',
    selected_image_url  TEXT,
    error               TEXT,
    metadata            JSONB         NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_generations_status
      CHECK (status IN ('pending','processing','done','failed'))
  );

  CREATE INDEX IF NOT EXISTS idx_generations_client_id   ON generations (client_id);
  CREATE INDEX IF NOT EXISTS idx_generations_brand_kit_id ON generations (brand_kit_id);
  CREATE INDEX IF NOT EXISTS idx_generations_status      ON generations (status);
  CREATE INDEX IF NOT EXISTS idx_generations_created_at  ON generations (created_at DESC);


  -- ── generation_campaign_tags (join table) ──────────────────────────────────
  CREATE TABLE IF NOT EXISTS generation_campaign_tags (
    generation_id  INTEGER  NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    tag_id         INTEGER  NOT NULL REFERENCES campaign_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (generation_id, tag_id)
  );

  CREATE INDEX IF NOT EXISTS idx_gen_tags_tag_id
    ON generation_campaign_tags (tag_id);


  -- ── Iterative migrations ───────────────────────────────────────────────────
  -- Add columns here as the app evolves.  Each ALTER TABLE … ADD COLUMN IF NOT
  -- EXISTS is idempotent — no-ops when the column already exists.

  -- Brand kit: human-readable description and accent colour palette
  ALTER TABLE brand_kits ADD COLUMN IF NOT EXISTS description   TEXT;
  ALTER TABLE brand_kits ADD COLUMN IF NOT EXISTS accent_colors JSONB NOT NULL DEFAULT '[]';

  --
  -- ALTER TABLE clients            ADD COLUMN IF NOT EXISTS notes TEXT;
  -- ALTER TABLE generations        ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10,6);
  -- ALTER TABLE brand_intelligence ADD COLUMN IF NOT EXISTS confidence NUMERIC(4,2);
`;

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function initDatabase() {
  const client = await pool.connect();
  try {
    console.log('[db] Running schema bootstrap…');
    await client.query(INIT_SQL);
    console.log('[db] Schema ready  (clients, brand_kits, brand_intelligence,');
    console.log('[db]               templates, assets, campaign_tags, generations)');
  } catch (err) {
    console.error('[db] Bootstrap failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDatabase };

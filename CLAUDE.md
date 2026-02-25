# Static Ads Generator — CLAUDE.md

## What this is
A Node/Express monolith for generating Meta static ad creatives with AI.
Multi-tenant: each "client" is a workspace. Users switch workspaces via a dropdown; the active client is tracked by an `active_client_id` httpOnly cookie.

## Stack
- **Runtime**: Node.js (18+, uses global `fetch`)
- **Server**: Express 5
- **Database**: PostgreSQL via `pg` connection pool
- **File uploads**: Multer (disk storage)
- **Frontend**: Single HTML file, Tailwind CSS via CDN, vanilla JS
- **No build step** — everything is plain CommonJS, serve-and-go

## Project layout
```
server.js                  Entry point, route mounting, global error handler
database/
  init.js                  Schema bootstrap (all CREATE TABLE IF NOT EXISTS + migrations)
  clients.js               Client/workspace queries
  brandKits.js             Brand kit queries
  templates.js             Template library queries
  assets.js                Brand asset queries (includes categoryFromMime)
  generations.js           Generation queries (getGenerationById)
middleware/
  clientScope.js           Resolves active client → req.clientId, req.client
  upload.js                Multer configs: uploadLogo, uploadThumbnail, uploadAssets
routes/
  clients.js               /api/clients
  brandKit.js              /api/brand-kit
  templates.js             /api/templates
  generations.js           /api/generations
  assets.js                /api/assets
views/
  index.html               Full single-page UI
public/
  uploads/
    logos/                 Brand kit logos (light/dark/icon)
    thumbnails/            Template thumbnails
    assets/                Brand asset media library
```

## API routes

### Clients — `/api/clients`
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/clients` | List all workspaces |
| POST | `/api/clients` | Create workspace (auto-slugifies name) |
| GET | `/api/clients/active` | Active workspace (clientScope resolved) |
| PUT | `/api/clients/active` | Switch workspace (sets cookie) |
| GET | `/api/clients/:id` | Single client |
| PATCH | `/api/clients/:id` | Rename / update fields |
| DELETE | `/api/clients/:id` | Delete; refuses if last workspace; advances cookie |

### Brand Kit — `/api/brand-kit` (client-scoped)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/brand-kit` | Fetch active client's kit |
| PUT | `/api/brand-kit` | Full replace |
| PATCH | `/api/brand-kit` | Partial update (used by UI autosave) |
| DELETE | `/api/brand-kit` | Remove kit |
| POST | `/api/brand-kit/logo/:variant` | Upload logo; variant = light \| dark \| icon |
| DELETE | `/api/brand-kit/logo/:variant` | Remove logo + file |

### Templates — `/api/templates` (global, no client scope)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/templates` | List; query: `?category=&source_type=&platform=&is_favorite=&tags=a,b&search=` |
| POST | `/api/templates` | Create (name required) |
| GET | `/api/templates/:id` | Single |
| PATCH | `/api/templates/:id` | Partial update; auto-reslug on name change |
| DELETE | `/api/templates/:id` | Delete + thumbnail file cleanup |
| POST | `/api/templates/:id/favorite` | Toggle `is_favorite` |
| POST | `/api/templates/:id/thumbnail` | Upload thumbnail (field: `thumbnail`) |
| DELETE | `/api/templates/:id/thumbnail` | Remove thumbnail |

Template `source_type` values: `starter` | `user` | `winner`

### Generations — `/api/generations` (client-scoped)
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/generations/:id/save-as-template` | Promote a done generation's image to template library as `source_type: winner` |

Save-as-template body (all optional): `name`, `image_url`, `category`, `tags`
Image acquisition: local paths → `fs.copyFile`; external URLs → streamed download (survives CDN expiry).

### Assets — `/api/assets` (client-scoped)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/assets` | List; query: `?category=&source=&brand_kit_id=&tags=a,b&search=` |
| POST | `/api/assets` | Multi-file upload (field: `files`, max 10); optional form fields: `brand_kit_id`, `tags` (JSON or comma-sep). Returns `{ assets, errors }` per-file |
| GET | `/api/assets/:id` | Single |
| PATCH | `/api/assets/:id` | Update `name`, `tags`, `category`, `brand_kit_id` |
| DELETE | `/api/assets/:id` | Delete record + file |
| DELETE | `/api/assets` | Bulk delete by `{ ids: [1,2,3] }` |

Asset `category` values: `image` | `video` | `font` | `document` | `other` — derived automatically from MIME on upload via `categoryFromMime()` in `database/assets.js`.

## Database schema (key tables)
All tables use `IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS` migrations — safe to re-run on every boot.

| Table | Scope | Notes |
|-------|-------|-------|
| `clients` | global | Tenants; slug unique |
| `brand_kits` | per-client | One default kit per client (partial unique index `WHERE is_default = TRUE`); JSONB for colors/fonts |
| `brand_intelligence` | per-client | AI-extracted data; routes not yet built |
| `templates` | global | `tags` JSONB, `is_favorite`, `source_type`; GIN index on `tags` |
| `assets` | per-client | `original_name`, `category`, `tags` JSONB; GIN index on `tags`; `file_type`/`file_url` immutable post-upload |
| `campaign_tags` | per-client | Routes not yet built |
| `generations` | per-client | `generated_images` JSONB array of `{ url, ... }` objects; `selected_image_url` TEXT |
| `generation_campaign_tags` | join | Not yet wired |

## Upload middleware (`middleware/upload.js`)
| Exported | Field name | Dest dir | Max size | Accepted types |
|----------|-----------|----------|----------|----------------|
| `uploadLogo` | `logo` (single) | `uploads/logos/` | 5 MB | JPEG PNG WebP SVG |
| `uploadThumbnail` | `thumbnail` (single) | `uploads/thumbnails/` | 5 MB | JPEG PNG WebP SVG |
| `uploadAssets` | `files` (array, ≤10) | `uploads/assets/` | 20 MB each | JPEG PNG WebP SVG GIF |

All filenames are `{timestamp}-{randomHex}{ext}` — never trust client-supplied names.
Always call `handleUploadError(err, res)` in route catch blocks before `next(err)`.

## Key patterns & conventions
- **Client scoping**: All per-client routes use `router.use(clientScope)` at the top. `req.clientId` is always set — never query without it.
- **Partial updates**: Routes that accept partial updates (PATCH) read the existing row first, merge, then write. DB layer `updateX` functions only touch supplied fields.
- **File cleanup**: Routes that delete records also `unlinkSilent()` the associated file. Routes that fail mid-upload also clean up orphaned files.
- **Slug generation**: `slugify(name)` is defined locally in each router — lowercase, hyphens, trimmed. Templates append a 6-char hex suffix to avoid collisions between winners from the same headline.
- **JSON fields in DB**: `tags`, `colors`, `fonts`, `dimensions`, `metadata` are JSONB. Always `JSON.stringify()` before binding in queries. Postgres returns them already parsed.
- **Validation**: Each route validates its own body with a `collectErrors` / `validateBody` helper before touching the DB. Invalid requests get `{ errors: [...] }` at 400.
- **Error handler**: Global handler in `server.js` returns `{ error: "Internal server error" }` at 500. Structured errors (400/404/409/422) are returned directly from routes.

## Frontend (`views/index.html`)
Single-page, no framework. Current UI sections:
- **Header**: workspace dropdown (switches active client via `PUT /api/clients/active`)
- **Brand Setup**: two-tab card
  - *Brand Kit*: name, tagline, description, tone; color palettes with native color pickers; font inputs; live preview card (updates as you type)
  - *Brand Assets*: logo upload zones (light/dark/icon)
- **Autosave**: 800ms debounced `PATCH /api/brand-kit` on any text/color change; status shows Saving… → Saved

## Prompt plan (30 total)
| # | Description | Status |
|---|-------------|--------|
| 1 | Scaffold Node/Express monolith, views/index.html, Tailwind CDN | ✅ |
| 2 | Baseline middleware, /api/health, startup logs | ✅ |
| 3 | PostgreSQL idempotent bootstrap (database/init.js) | ✅ |
| 4 | Full data model: all tables, indexes, constraints | ✅ |
| 5 | Client-scoped everything; clientScope middleware; default-client fallback | ✅ |
| 6 | Client CRUD with safety rules (no deleting last workspace) | ✅ |
| 7 | Brand Kit CRUD (colors, fonts, tone, tagline) | ✅ |
| 8 | Brand logo uploads, light/dark/icon variants, Multer | ✅ |
| 9 | Brand Setup UI: two-tab (Brand Kit / Brand Assets), autosave, live preview | ✅ |
| 10 | Template Library backend: CRUD, thumbnail upload, favorite toggle, tags, source_type | ✅ |
| 11 | Save as Template from generations: image copy/download → winner template | ✅ |
| 12 | Brand Assets backend: multi-file upload, list/search/filter/update/bulk-delete | ✅ |
| 13 | Post-upload asset categorization modal (Product Image, Packaging, Lifestyle, Logo, Other) | ✅ |
| 14 | FAL image generation integration with resilient error handling | ✅ |
| 15 | Single ad generation endpoint POST /api/generate | ✅ |
| 16 | Persist rich generation history records | ✅ |
| 17 | Visual history board with loading/failure states | ✅ |
| 18 | Re-prompt variation endpoint POST /api/generate/edit | ✅ |
| 19 | Brand Intelligence generation and CRUD | ✅ |
| 20 | Brand Intelligence UI editor | ✅ |
| 21 | Reusable Gemini wrapper for all LLM calls | ✅ |
| 22 | Prompt composition endpoint from strategy + assets | ✅ |
| 23 | Deterministic fallback when AI composition fails | ✅ |
| 24 | Reverse-engineering endpoint for winning ads | ✅ |
| 25 | Reverse Engineer modal with direct actions | ✅ |
| 26 | Concept generation endpoint for strategic diversity | ✅ |
| 27 | Profile-first campaign planning endpoint | ✅ |
| 28 | Batch campaign generation with progress tracking | ✅ |
| 29 | Campaign builder UX step flow | ✅ |
| 30 | Harden: upload validation, secure file resolution, cleanup, docs | ✅ |

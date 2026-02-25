const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

// ── Upload directory management ───────────────────────────────────────────────

const PUBLIC_ROOT  = path.resolve(path.join(__dirname, '../public'));
const UPLOADS_ROOT = path.join(PUBLIC_ROOT, 'uploads');

const UPLOAD_DIRS = {
  logos:      path.join(UPLOADS_ROOT, 'logos'),
  thumbnails: path.join(UPLOADS_ROOT, 'thumbnails'),
  assets:     path.join(UPLOADS_ROOT, 'assets'),
};

// Creates all upload subdirectories synchronously. Safe to call on every boot.
function ensureUploadDirs() {
  for (const dir of Object.values(UPLOAD_DIRS)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Resolves a stored public path (e.g. "/uploads/logos/foo.png") to a safe
// absolute filesystem path. Returns null if the path escapes UPLOADS_ROOT —
// callers (unlinkSilent, copyFile) must treat null as "skip this operation".
function resolveUploadPath(publicPath) {
  if (!publicPath || typeof publicPath !== 'string') return null;
  const relative = publicPath.startsWith('/') ? publicPath.slice(1) : publicPath;
  const resolved = path.resolve(path.join(PUBLIC_ROOT, relative));
  if (!resolved.startsWith(UPLOADS_ROOT + path.sep)) {
    console.warn('[upload] Blocked unsafe path:', publicPath);
    return null;
  }
  return resolved;
}

// ── Allowed types & limits ────────────────────────────────────────────────────

// Logos / thumbnails: images only
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
]);

// Brand assets: broader set to support a real media library
const ALLOWED_ASSET_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
  'image/gif',
]);

const MAX_BYTES       = 5  * 1024 * 1024; // 5 MB  — logos & thumbnails
const MAX_ASSET_BYTES = 20 * 1024 * 1024; // 20 MB — brand assets (high-res images)
const MAX_ASSET_COUNT = 10;               // max files per multi-upload request

// Map MIME → canonical extension (avoids trusting the client-supplied filename)
const MIME_TO_EXT = {
  'image/jpeg':   '.jpg',
  'image/png':    '.png',
  'image/webp':   '.webp',
  'image/svg+xml': '.svg',
  'image/gif':    '.gif',
};

// ── Shared MIME filter factory ────────────────────────────────────────────────
function makeMimeFilter(label) {
  return function fileFilter(_req, file, cb) {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error(
        `Unsupported file type "${file.mimetype}" for ${label}. Allowed: jpeg, png, webp, svg`
      );
      err.status = 415;
      cb(err, false);
    }
  };
}

// ── Shared filename generator ─────────────────────────────────────────────────
// Always generates a server-side name — never trusts client-supplied filenames.
// Uses MIME-derived extension so the stored file always has the right extension
// regardless of what the browser sent.
function makeFilename(_req, file, cb) {
  const ext    = MIME_TO_EXT[file.mimetype] || '.bin';
  const unique = crypto.randomBytes(10).toString('hex');
  cb(null, `${Date.now()}-${unique}${ext}`);
}

// ── Logo uploader ─────────────────────────────────────────────────────────────
const logoStorage = multer.diskStorage({
  destination: path.join(__dirname, '../public/uploads/logos'),
  filename:    makeFilename,
});

const uploadLogo = multer({
  storage:    logoStorage,
  fileFilter: makeMimeFilter('logo'),
  limits:     { fileSize: MAX_BYTES },
});

// ── Thumbnail uploader ────────────────────────────────────────────────────────
const thumbnailStorage = multer.diskStorage({
  destination: path.join(__dirname, '../public/uploads/thumbnails'),
  filename:    makeFilename,
});

const uploadThumbnail = multer({
  storage:    thumbnailStorage,
  fileFilter: makeMimeFilter('thumbnail'),
  limits:     { fileSize: MAX_BYTES },
});

// ── Asset uploader (multi-file) ───────────────────────────────────────────────
// Use as: uploadAssets.array('files', MAX_ASSET_COUNT)
const assetStorage = multer.diskStorage({
  destination: path.join(__dirname, '../public/uploads/assets'),
  filename:    makeFilename,
});

function assetFileFilter(_req, file, cb) {
  if (ALLOWED_ASSET_MIME.has(file.mimetype)) {
    cb(null, true);
  } else {
    const err = new Error(
      `Unsupported file type "${file.mimetype}" for asset. Allowed: jpeg, png, webp, svg, gif`
    );
    err.status = 415;
    cb(err, false);
  }
}

const uploadAssets = multer({
  storage:    assetStorage,
  fileFilter: assetFileFilter,
  limits:     { fileSize: MAX_ASSET_BYTES, files: MAX_ASSET_COUNT },
});

// ── Multer error normaliser ───────────────────────────────────────────────────
// Call in a route's catch block to turn multer-specific errors into clean JSON.
function handleUploadError(err, res) {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: `File too large. Logos and thumbnails: max ${MAX_BYTES / 1024 / 1024} MB. Assets: max ${MAX_ASSET_BYTES / 1024 / 1024} MB.`,
    });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: `Too many files. Maximum is ${MAX_ASSET_COUNT} per upload.` });
  }
  if (err.status === 415 || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(err.status || 400).json({ error: err.message });
  }
  return null; // not a multer error — let the caller re-throw
}

module.exports = { uploadLogo, uploadThumbnail, uploadAssets, handleUploadError, ensureUploadDirs, resolveUploadPath };

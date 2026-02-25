const multer = require('multer');
const path   = require('path');
const crypto = require('crypto');

// ── Allowed types & limits ────────────────────────────────────────────────────
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
]);

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

// Map MIME → canonical extension (avoids trusting the client-supplied filename)
const MIME_TO_EXT = {
  'image/jpeg':   '.jpg',
  'image/png':    '.png',
  'image/webp':   '.webp',
  'image/svg+xml': '.svg',
};

// ── Disk storage ──────────────────────────────────────────────────────────────
const logoStorage = multer.diskStorage({
  destination: path.join(__dirname, '../public/uploads/logos'),

  filename(_req, file, cb) {
    const ext    = MIME_TO_EXT[file.mimetype] || path.extname(file.originalname).toLowerCase();
    const unique = crypto.randomBytes(10).toString('hex');
    cb(null, `${Date.now()}-${unique}${ext}`);
  },
});

// ── MIME filter ───────────────────────────────────────────────────────────────
function logoFileFilter(_req, file, cb) {
  if (ALLOWED_MIME.has(file.mimetype)) {
    cb(null, true);
  } else {
    const err = new Error(
      `Unsupported file type "${file.mimetype}". Allowed: jpeg, png, webp, svg`
    );
    err.status = 415;
    cb(err, false);
  }
}

// ── Exported uploader ─────────────────────────────────────────────────────────
// Use as:  router.post('/logo', uploadLogo.single('logo'), handler)
const uploadLogo = multer({
  storage:    logoStorage,
  fileFilter: logoFileFilter,
  limits:     { fileSize: MAX_BYTES },
});

// ── Multer error normaliser ───────────────────────────────────────────────────
// Call in a route's catch block to turn multer-specific errors into clean JSON.
function handleUploadError(err, res) {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large. Maximum size is ${MAX_BYTES / 1024 / 1024} MB.` });
  }
  if (err.status === 415 || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(err.status || 400).json({ error: err.message });
  }
  return null; // not a multer error — let the caller re-throw
}

module.exports = { uploadLogo, handleUploadError };

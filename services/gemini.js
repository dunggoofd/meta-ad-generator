const { GoogleGenerativeAI } = require('@google/generative-ai');

const DEFAULT_MODEL   = process.env.GEMINI_MODEL      || 'gemini-2.0-flash';
const DEFAULT_TIMEOUT = parseInt(process.env.GEMINI_TIMEOUT_MS || '60000', 10);

// ── Startup validation ────────────────────────────────────────────────────────
// Call once at boot. Warns but does not crash — the server can still serve
// non-LLM routes if GEMINI_KEY is absent.

function configureGemini() {
  const key = process.env.GEMINI_KEY;
  if (!key) {
    console.warn('[gemini] WARNING: GEMINI_KEY is not set — LLM calls will fail at request time.');
    return;
  }
  console.log(`[gemini] Ready  model=${DEFAULT_MODEL}  timeout=${DEFAULT_TIMEOUT}ms`);
}

// ── Core generate call ────────────────────────────────────────────────────────
// Options:
//   model    {string}  model name; defaults to GEMINI_MODEL env var or 'gemini-2.0-flash'
//   json     {boolean} parse response as JSON (strips markdown fences); default false
//   timeout  {number}  ms before rejecting; default GEMINI_TIMEOUT_MS env var or 60000
//
// Returns the text response, or a parsed JSON value if json=true.
// Throws structured errors with .code:
//   GEMINI_KEY_MISSING  — GEMINI_KEY env var not set
//   GEMINI_TIMEOUT      — request exceeded timeout
//   GEMINI_PARSE_ERROR  — json=true but response was not valid JSON (.raw has the text)
//   GEMINI_ERROR        — any other API or network error

async function generateContent(prompt, { model, json = false, timeout } = {}) {
  if (!process.env.GEMINI_KEY) {
    throw Object.assign(
      new Error('GEMINI_KEY is not configured'),
      { code: 'GEMINI_KEY_MISSING' }
    );
  }

  const resolvedModel   = model   || DEFAULT_MODEL;
  const resolvedTimeout = timeout ?? DEFAULT_TIMEOUT;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(Object.assign(
        new Error(`Gemini request timed out after ${resolvedTimeout}ms`),
        { code: 'GEMINI_TIMEOUT' }
      )),
      resolvedTimeout
    )
  );

  let result;
  try {
    const genAI    = new GoogleGenerativeAI(process.env.GEMINI_KEY);
    const genModel = genAI.getGenerativeModel({ model: resolvedModel });
    result = await Promise.race([
      genModel.generateContent(prompt),
      timeoutPromise,
    ]);
  } catch (err) {
    if (err.code) throw err; // already structured
    throw Object.assign(
      new Error(err?.message || 'Unknown Gemini error'),
      { code: 'GEMINI_ERROR', cause: err }
    );
  }

  const text = result.response.text().trim();

  if (!json) return text;

  // Strip markdown code fences if model returns them despite instructions
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(clean);
  } catch (err) {
    throw Object.assign(
      new Error(`Gemini returned invalid JSON: ${err.message}`),
      { code: 'GEMINI_PARSE_ERROR', raw: clean, cause: err }
    );
  }
}

// ── Multimodal generate call ──────────────────────────────────────────────────
// Same behaviour as generateContent but includes an image alongside the prompt.
// Fetches imageUrl via global fetch, converts to base64, sends as inlineData.
//
// Additional error code:
//   GEMINI_IMAGE_FETCH_ERROR — could not fetch or read the image URL

async function generateContentWithImage(imageUrl, textPrompt, { model, json = false, timeout } = {}) {
  if (!process.env.GEMINI_KEY) {
    throw Object.assign(
      new Error('GEMINI_KEY is not configured'),
      { code: 'GEMINI_KEY_MISSING' }
    );
  }

  const resolvedModel   = model   || DEFAULT_MODEL;
  const resolvedTimeout = timeout ?? DEFAULT_TIMEOUT;

  let imageData, mimeType;
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    mimeType  = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    imageData = Buffer.from(await response.arrayBuffer()).toString('base64');
  } catch (err) {
    if (err.code) throw err;
    throw Object.assign(
      new Error(`Failed to fetch image: ${err.message}`),
      { code: 'GEMINI_IMAGE_FETCH_ERROR', cause: err }
    );
  }

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(Object.assign(
        new Error(`Gemini request timed out after ${resolvedTimeout}ms`),
        { code: 'GEMINI_TIMEOUT' }
      )),
      resolvedTimeout
    )
  );

  let result;
  try {
    const genAI    = new GoogleGenerativeAI(process.env.GEMINI_KEY);
    const genModel = genAI.getGenerativeModel({ model: resolvedModel });
    result = await Promise.race([
      genModel.generateContent([
        textPrompt,
        { inlineData: { data: imageData, mimeType } },
      ]),
      timeoutPromise,
    ]);
  } catch (err) {
    if (err.code) throw err;
    throw Object.assign(
      new Error(err?.message || 'Unknown Gemini error'),
      { code: 'GEMINI_ERROR', cause: err }
    );
  }

  const text = result.response.text().trim();

  if (!json) return text;

  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(clean);
  } catch (err) {
    throw Object.assign(
      new Error(`Gemini returned invalid JSON: ${err.message}`),
      { code: 'GEMINI_PARSE_ERROR', raw: clean, cause: err }
    );
  }
}

// Returns the model name that will be used for calls (respects GEMINI_MODEL env var).
function activeModel() {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

module.exports = { configureGemini, generateContent, generateContentWithImage, activeModel };

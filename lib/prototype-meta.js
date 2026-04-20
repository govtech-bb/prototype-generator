/**
 * Per-prototype metadata — a small JSON sidecar stored alongside each
 * generated prototype in S3.
 *
 * Keyed by the prototype's folder handle (the stable URL slug). Records
 * user-supplied options set at generation time:
 *
 *   {
 *     notificationEmail: "caseworker@dept.gov.bb", // where submissions go
 *     instructions:     "Please add a phone field",// extra prompt input
 *     formName:         "Apply for X",
 *     createdAt:        "2026-04-17T..."
 *   }
 *
 * Used by:
 *   - /api/generate → writes meta.json after successful S3 upload
 *   - /api/submit  → reads meta.json to route the MDA notification email
 *
 * Storage path: prototypes/<folder>/meta.json
 *
 * Missing meta.json is not an error — it just means the prototype was
 * generated before this feature existed (or without per-service options).
 * Callers should treat `null` from `getMeta()` as "use defaults".
 */

const s3 = require('./s3');

const META_FILENAME = 'meta.json';

/**
 * Write meta for a prototype.
 *
 * @param {string} folder — the prototype folder slug (no path, no extension)
 * @param {object} meta   — will be JSON-serialised; keys at the caller's
 *                          discretion but `notificationEmail` and
 *                          `instructions` are the two we read back.
 * @returns {Promise<void>}
 */
async function setMeta(folder, meta) {
  if (!folder) throw new Error('setMeta: folder is required');
  const key = `prototypes/${folder}/${META_FILENAME}`;
  const body = JSON.stringify(meta, null, 2);
  await s3.putObject(key, body, 'application/json');
}

/**
 * Read meta for a prototype. Returns null if missing or unparsable —
 * never throws. Callers should treat null as "use server defaults".
 */
async function getMeta(folder) {
  if (!folder) return null;
  const key = `prototypes/${folder}/${META_FILENAME}`;
  try {
    const { body } = await s3.getObject(key);
    let text;
    if (body && typeof body.transformToString === 'function') {
      text = await body.transformToString('utf-8');
    } else {
      const chunks = [];
      for await (const c of body) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
      text = Buffer.concat(chunks).toString('utf-8');
    }
    return JSON.parse(text);
  } catch (err) {
    // NoSuchKey is expected for prototypes without meta.json — log only
    // genuinely unexpected errors.
    if (err && err.name !== 'NoSuchKey' && !/NoSuchKey|not found|404/i.test(String(err.message || ''))) {
      console.warn(`  getMeta(${folder}) error: ${err.message}`);
    }
    return null;
  }
}

module.exports = { setMeta, getMeta };

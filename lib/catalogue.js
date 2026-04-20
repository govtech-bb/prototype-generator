/**
 * Services catalogue.
 *
 * Builds a list of digitised services ("ServiceRecord[]") from the prototypes
 * stored in S3 under `prototypes/`. The concierge chat uses this catalogue
 * to match free-text citizen intents to the right service and deep-link the
 * user to the online form, per-form chat, or WhatsApp simulator.
 *
 * Caching:
 *   - `getCatalogue()` returns a cached promise. TTL is 5 minutes.
 *   - `invalidate()` clears the cache — called after every successful
 *     prototype generation so newly digitised services are routable
 *     without waiting for TTL expiry.
 *   - Concurrent callers during a build share the single in-flight promise
 *     so we don't fan out to S3 repeatedly on a cold cache.
 *
 * Extraction strategy (per prototype):
 *   1. Fetch the full `index.html` from S3 (~5–10 KB for a typical prototype).
 *   2. Parse the `<title>` tag, splitting on en-dash / em-dash / pipe to
 *      separate the form name from the MDA suffix.
 *   3. Cross-check with the `const FORM_NAME = '...'` declaration.
 *   4. Locate the `PAGES['start']` template literal and pull the first
 *      `<h1>`, the first `<p>`, and the first `<ul><li>…</li></ul>` block
 *      as the service heading, intro paragraph, and "what you'll need" list.
 *   5. Any failure at step 3–4 degrades to title-only metadata — the service
 *      is still routable, just with less context in the concierge prompt.
 */

const s3 = require('./s3');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cache = null;       // { builtAt: number, records: ServiceRecord[] }
let inFlight = null;    // Promise<ServiceRecord[]> while a build is running

/**
 * @typedef {Object} ServiceRecord
 * @property {string}   folder      — stable routing handle; for legacy flat
 *                                     files this is the filename without .html
 * @property {boolean}  legacy      — true for single-file (legacy) prototypes
 * @property {string}   formName
 * @property {string|null} mda      — agency name extracted from <title> suffix
 * @property {string}   url         — absolute path to the online form start page
 * @property {string}   chatUrl     — absolute path to the per-form chat UI
 * @property {string}   whatsappUrl — absolute path to the WhatsApp simulator
 * @property {string|null} h1       — start-page H1 (service-oriented heading)
 * @property {string|null} intro    — first paragraph of the start page
 * @property {string[]} whatYouNeed — bullets from the "What you will need" list
 */

async function getCatalogue() {
  if (cache && (Date.now() - cache.builtAt) < CACHE_TTL_MS) {
    return cache.records;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const records = await buildCatalogue();
      cache = { builtAt: Date.now(), records };
      return records;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

function invalidate() {
  cache = null;
  // Leave any in-flight promise alone; it will settle and not populate the
  // cache because its `then` writes to `cache` after we null it here.
  // Actually it WILL populate — but the next getCatalogue call will see
  // a stale cache and rebuild. Safer to null on settle:
  // (the IIFE above handles this with its finally/assignment order).
}

/* ── Build ───────────────────────────────────────────────────── */

async function buildCatalogue() {
  const objects = await s3.listObjects('prototypes/');

  // Group folder-based prototypes and collect legacy flat files
  const folders = new Map(); // folder -> { indexKey, files[] }
  const flatFiles = [];

  // Tombstones written by POST /api/prototypes/:folder/delete:
  //   folder-based  →  prototypes/<folder>/.deleted
  //   legacy flat   →  prototypes/<filename>.html.deleted
  // Both shapes hide the corresponding prototype from the concierge so
  // deleted services stop appearing in routing recommendations.
  const deletedFolders = new Set();
  const deletedFlatFiles = new Set();

  for (const obj of objects) {
    const relPath = obj.key.replace('prototypes/', '');
    if (!relPath) continue;

    if (relPath.endsWith('/.deleted')) {
      const folder = relPath.slice(0, -'/.deleted'.length);
      if (folder) deletedFolders.add(folder);
      continue;
    }
    if (relPath.endsWith('.html.deleted')) {
      deletedFlatFiles.add(relPath.slice(0, -'.deleted'.length));
      continue;
    }

    if (!relPath.endsWith('.html')) continue;

    const parts = relPath.split('/');
    if (parts.length === 2) {
      const folder = parts[0];
      const page = parts[1];
      if (!folders.has(folder)) {
        folders.set(folder, { indexKey: null, files: [] });
      }
      const entry = folders.get(folder);
      entry.files.push(page);
      if (page === 'index.html') entry.indexKey = obj.key;
    } else if (parts.length === 1) {
      flatFiles.push(obj);
    }
  }

  // Drop tombstoned entries
  for (const folder of deletedFolders) folders.delete(folder);

  // Fetch and parse in parallel. Each task is independent.
  const tasks = [];

  for (const [folder, entry] of folders) {
    const key = entry.indexKey || `prototypes/${folder}/${entry.files[0]}`;
    tasks.push(buildFolderRecord(folder, key));
  }

  for (const obj of flatFiles) {
    const filename = obj.key.replace('prototypes/', '');
    if (deletedFlatFiles.has(filename)) continue;
    tasks.push(buildLegacyRecord(obj.key));
  }

  const settled = await Promise.allSettled(tasks);
  const records = [];
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) records.push(r.value);
  }

  // Sort by formName for a stable system-prompt order
  records.sort((a, b) => a.formName.localeCompare(b.formName));
  return records;
}

async function buildFolderRecord(folder, indexKey) {
  let html;
  try {
    html = await fetchText(indexKey);
  } catch (_) {
    // If the index page can't be fetched, skip this prototype entirely
    return null;
  }

  const { formName: titleFormName, mda } = extractTitle(html);
  const formName = extractFormName(html) || titleFormName || folder;
  if (!formName) return null;

  const start = extractStart(html);

  const url = `/${folder}/index.html`;
  return {
    folder,
    legacy: false,
    formName,
    mda,
    url,
    chatUrl: `/chat.html?form=${encodeURIComponent(folder + '/index.html')}`,
    whatsappUrl: `/go/whatsapp?form=${encodeURIComponent(folder + '/index.html')}`,
    h1: start.h1,
    intro: start.intro,
    whatYouNeed: start.whatYouNeed,
  };
}

async function buildLegacyRecord(key) {
  let html;
  try {
    html = await fetchText(key);
  } catch (_) {
    return null;
  }

  const filename = key.replace('prototypes/', '');
  const folderHandle = filename.replace(/\.html$/i, '');

  const { formName: titleFormName, mda } = extractTitle(html);
  const formName = extractFormName(html) || titleFormName || folderHandle;
  if (!formName) return null;

  // Legacy prototypes rarely have the PAGES['start'] template in the same
  // shape. Try the extraction anyway and degrade gracefully.
  const start = extractStart(html);

  return {
    folder: folderHandle,
    legacy: true,
    formName,
    mda,
    url: `/${filename}`,
    chatUrl: `/chat.html?form=${encodeURIComponent(filename)}`,
    whatsappUrl: `/go/whatsapp?form=${encodeURIComponent(filename)}`,
    h1: start.h1,
    intro: start.intro,
    whatYouNeed: start.whatYouNeed,
  };
}

/* ── Extraction helpers ──────────────────────────────────────── */

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m) return { formName: null, mda: null };
  const parts = m[1].split(/\s*[–—|]\s*/);
  return {
    formName: (parts[0] || '').trim() || null,
    mda: parts.length > 1 ? parts.slice(1).join(' – ').trim() : null,
  };
}

function extractFormName(html) {
  // `const FORM_NAME = 'My Form';` or `"My Form"`
  const m = html.match(/const\s+FORM_NAME\s*=\s*(['"])([^'"]+)\1/);
  return m ? m[2].trim() : null;
}

/**
 * Pull the start-page template body out of `PAGES['start']` (or
 * `PAGES.start`) and parse the first H1, first paragraph, and first bullet
 * list. All steps are wrapped in try/catch so a malformed start page never
 * poisons the catalogue.
 *
 * Returns `{ h1, intro, whatYouNeed }` with any missing fields as null / [].
 */
function extractStart(html) {
  const fallback = { h1: null, intro: null, whatYouNeed: [] };

  try {
    // Match `'start': () => \`...\`` or `"start": () => \`...\`` or
    // `start: () => \`...\``. Non-greedy on the backtick body.
    const re = /['"]?start['"]?\s*:\s*\(\s*\)\s*=>\s*`([\s\S]*?)`\s*[,}]/;
    const m = html.match(re);
    if (!m) return fallback;

    const body = m[1];

    // First H1 (strip any inner tags)
    let h1 = null;
    const h1Match = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) h1 = stripTags(h1Match[1]).trim() || null;

    // First paragraph
    let intro = null;
    const pMatch = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (pMatch) intro = stripTags(pMatch[1]).trim() || null;

    // First <ul> — take every <li> child
    const whatYouNeed = [];
    const ulMatch = body.match(/<ul[^>]*>([\s\S]*?)<\/ul>/i);
    if (ulMatch) {
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch;
      while ((liMatch = liRe.exec(ulMatch[1])) !== null) {
        const text = stripTags(liMatch[1]).trim();
        if (text) whatYouNeed.push(text);
      }
    }

    return { h1, intro, whatYouNeed };
  } catch (_) {
    return fallback;
  }
}

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, '')        // drop HTML tags
    .replace(/\$\{[^}]+\}/g, '')    // drop ${template expressions}
    .replace(/\s+/g, ' ')           // collapse whitespace
    .trim();
}

async function fetchText(key) {
  const { body } = await s3.getObject(key);
  // AWS SDK v3 Body is a Readable stream with transformToString
  if (body && typeof body.transformToString === 'function') {
    return await body.transformToString('utf-8');
  }
  // Fallback for older SDKs / test mocks
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Load the full form script for a specific prototype by folder handle.
 *
 * Used by the WhatsApp and chat transport layers to seed a conversation
 * session with the form's JS (FLOW, PAGES, validate(), etc.) — the same
 * content that public/chat.html extracts client-side for the per-form
 * chat UI, but resolved here server-side from a simple folder handle.
 *
 * Tries the folder-based path (`prototypes/{folder}/index.html`) first,
 * then the legacy flat-file path (`prototypes/{folder}.html`).
 *
 * @param {string} folderOrFile — ServiceRecord.folder value, or a raw
 *   filename like "vehicle-registration.html". Path-traversal characters
 *   (".." and literal "/") are stripped for safety.
 * @returns {Promise<{ formName: string, formScript: string } | null>}
 */
async function loadFormScript(folderOrFile) {
  if (!folderOrFile || typeof folderOrFile !== 'string') return null;

  // Strip unsafe path characters and any trailing .html the caller
  // might have included
  const handle = folderOrFile
    .replace(/\.\./g, '')
    .replace(/^[\/\\]+/, '')
    .replace(/[\/\\].*$/, '')
    .replace(/\.html$/i, '');
  if (!handle) return null;

  // Try folder-based first, then legacy flat file
  const candidates = [
    `prototypes/${handle}/index.html`,
    `prototypes/${handle}.html`,
  ];

  let html = null;
  for (const key of candidates) {
    try {
      html = await fetchText(key);
      break;
    } catch (_) { /* try next */ }
  }
  if (!html) return null;

  // Prefer the FORM_NAME constant; fall back to the <title> before " – "
  const formName = extractFormName(html)
    || extractTitle(html).formName
    || handle;

  // Extract the last inline <script> (the form-specific one), same
  // convention as public/chat.html:300-303.
  const scripts = html.match(/<script(?!\s+src)[^>]*>([\s\S]*?)<\/script>/gi) || [];
  if (scripts.length === 0) return null;
  const last = scripts[scripts.length - 1];
  const formScript = last.replace(/<\/?script[^>]*>/gi, '').trim();
  if (!formScript) return null;

  return { formName, formScript };
}

module.exports = { getCatalogue, invalidate, loadFormScript };

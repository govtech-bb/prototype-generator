/**
 * Info catalogue — citizen-service content sourced from the frontend-alpha
 * GitHub repo (the source for alpha.gov.bb).
 *
 * Used by the concierge chat to answer questions about government services
 * we haven't yet digitised. Each record carries a title, description,
 * section, optional fees (parsed opportunistically), and the full markdown
 * body — the body is loaded lazily on demand, not embedded in every
 * catalogue turn (two-pass retrieval).
 *
 * Why the GitHub contents API and not `git clone`:
 *   - No git binary dependency in production images.
 *   - No vendor/ directory, works on read-only filesystems.
 *   - 50 files on a 6h TTL is ~8 HTTP calls/hour — trivial.
 *
 * Caching strategy:
 *   - First `getInfoCatalogue()` call lazily builds the catalogue;
 *     subsequent calls in the same 6h window return the cached array.
 *   - On GitHub fetch failure, we cache an EMPTY array for only 60s (not
 *     6h) so the next request retries quickly.
 *   - `invalidate()` wipes everything and forces a rebuild on next call.
 *   - `refresh()` forces a fresh build right now and returns it.
 *   - Partial failures are surfaced via `lastBuildErrors` for observability.
 */

'use strict';

const matter = require('gray-matter');

/* ── Config ──────────────────────────────────────────────────── */

const REPO = 'govtech-bb/frontend-alpha';
const BRANCH = 'main';
const CONTENT_PATH = 'src/content';
const ALPHA_BASE_URL = 'https://alpha.gov.bb';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // 6 hours on success
const NEG_CACHE_TTL_MS = 60 * 1000;       // 60s when the list fetch fails

// Optional GitHub token raises the rate limit from 60/hr → 5000/hr.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

/* ── State ───────────────────────────────────────────────────── */

let cache = null;         // { builtAt: number, records: InfoRecord[], errors: number }
let inFlight = null;      // Promise<InfoRecord[]> while a build is in progress

/* ── Public API ──────────────────────────────────────────────── */

/**
 * Return the cached catalogue (building it if necessary).
 * @returns {Promise<InfoRecord[]>}
 */
async function getInfoCatalogue() {
  if (cache) {
    const ttl = cache.records.length > 0 ? CACHE_TTL_MS : NEG_CACHE_TTL_MS;
    if ((Date.now() - cache.builtAt) < ttl) return cache.records;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const { records, errors } = await buildCatalogue();
      cache = { builtAt: Date.now(), records, errors };
      return records;
    } catch (err) {
      // Full catalogue build failed — log and cache empty for neg-TTL
      console.warn(`  Info catalogue build failed: ${err.message}`);
      cache = { builtAt: Date.now(), records: [], errors: 1 };
      return [];
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Return the full markdown body for one info service, loading it if not
 * already cached. The concierge uses this for follow-up question handling
 * (two-pass retrieval — metadata on turn 1, body on turn 2+).
 *
 * @param {string} slug
 * @returns {Promise<string|null>}
 */
async function getServiceBody(slug) {
  const records = await getInfoCatalogue();
  const rec = records.find(r => r.slug === slug);
  return rec ? rec.body : null;
}

function invalidate() {
  cache = null;
}

/**
 * Force a fresh build right now and return it. Used by the admin refresh
 * endpoint so stakeholders can see content-team changes without waiting
 * for the 6h TTL.
 */
async function refresh() {
  invalidate();
  const records = await getInfoCatalogue();
  return {
    ok: records.length > 0,
    records: records.length,
    errors: cache ? cache.errors : 0,
  };
}

/* ── Build ───────────────────────────────────────────────────── */

async function buildCatalogue() {
  const listing = await listContentDir();

  // Each entry is either a top-level .md file or a directory
  // containing index.md (+ maybe start.md — we ignore start.md).
  const tasks = [];
  for (const entry of listing) {
    if (entry.type === 'file' && entry.name.endsWith('.md')) {
      const slug = entry.name.replace(/\.md$/i, '');
      tasks.push(fetchAndParse(slug, entry.path));
    } else if (entry.type === 'dir') {
      const slug = entry.name;
      // Always use index.md, never start.md — start.md duplicates the
      // digitised-catalogue entry.
      const indexPath = `${CONTENT_PATH}/${slug}/index.md`;
      tasks.push(fetchAndParse(slug, indexPath));
    }
  }

  const settled = await Promise.allSettled(tasks);
  const records = [];
  let errors = 0;
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) records.push(r.value);
    else if (r.status === 'rejected') errors++;
  }

  // Sort by title for stable output ordering.
  records.sort((a, b) => (a.title || a.slug).localeCompare(b.title || b.slug));
  return { records, errors };
}

async function listContentDir() {
  // Use the GitHub contents API (one request for the directory listing).
  // Raw file bodies come from raw.githubusercontent.com below — unrated
  // for public repos.
  const url = `https://api.github.com/repos/${REPO}/contents/${CONTENT_PATH}?ref=${BRANCH}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'govtech-forms-concierge',
  };
  if (GITHUB_TOKEN) headers.Authorization = `token ${GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub list ${res.status}: ${body.substring(0, 160)}`);
  }
  return res.json();
}

async function fetchAndParse(slug, path) {
  const raw = await fetchRaw(path);
  if (!raw) return null;

  const parsed = matter(raw);
  const fm = parsed.data || {};
  const body = parsed.content || '';

  // Skip entirely empty entries (probably a 404 inside the directory
  // listing — e.g. a dir with no index.md).
  if (!body.trim()) return null;

  const record = {
    slug,
    title: fm.title || humanize(slug),
    description: fm.description || null,
    section: fm.section || null,
    publishDate: toIsoDate(fm.publish_date),
    sourceUrl: fm.source_url || null,
    alphaUrl: `${ALPHA_BASE_URL}/${slug}`,
    headings: extractH2Headings(body),
    fees: extractFees(body),
    body,
  };
  return record;
}

async function fetchRaw(path) {
  const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${path}`;
  const headers = { 'User-Agent': 'govtech-forms-concierge' };
  // raw.githubusercontent.com ignores Authorization for public repos but
  // sending it when available doesn't hurt.
  if (GITHUB_TOKEN) headers.Authorization = `token ${GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });
  if (res.status === 404) return null;  // expected for dirs without index.md
  if (!res.ok) {
    throw new Error(`GitHub raw ${res.status} for ${path}`);
  }
  return res.text();
}

/* ── Extraction helpers ──────────────────────────────────────── */

function humanize(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Normalise a publish_date frontmatter value to `YYYY-MM-DD` (or null).
 * gray-matter parses YAML dates into JS Date objects, so `String(value)`
 * would give "Fri Oct 24 2025 ..." — we want the ISO-style slice.
 */
function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (!s) return null;
  // Already ISO-ish (YYYY-MM-DD[...])
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  // Try Date parse as last resort
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Return a list of the `##` heading titles (not bodies). Used as routing
 * hints in the concierge system prompt — gives the model a sense of what
 * each service's content covers without embedding the full body.
 */
function extractH2Headings(body) {
  const titles = [];
  const re = /^##\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    const t = m[1].trim();
    if (t) titles.push(t);
  }
  return titles;
}

/**
 * Opportunistic fees extraction:
 *   1. If the body contains a markdown table (GFM `| ... | ... |`) within
 *      a "fees"-adjacent block, parse it into [{label, amount}].
 *   2. Otherwise, if a block contains fee-like text near a `$` figure,
 *      capture it as raw markdown for the client to render.
 *   3. Otherwise, return null.
 *
 * Non-authoritative — this is a hint for the card layout, not ground
 * truth. The model answers follow-up fee questions via `answer_from_content`
 * against the FULL body, not this structured extract.
 */
function extractFees(body) {
  // Try table first
  const tableMatch = findFeesTable(body);
  if (tableMatch) {
    const rows = parseGfmTable(tableMatch);
    if (rows && rows.length) return { table: rows };
  }
  // Fall back: look for a fee-ish paragraph with a dollar figure
  const feesBlock = findFeesParagraph(body);
  if (feesBlock) return { markdown: feesBlock };
  return null;
}

function findFeesTable(body) {
  // Split body into coarse blocks separated by blank lines, find the
  // first block that looks like a GFM table AND has a fee-ish neighbour.
  const lines = body.split(/\r?\n/);
  const feeHintRe = /\b(fee|fees|cost|cost of|price|pricing)\b/i;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|.+\|\s*$/.test(lines[i])) continue;
    // Found a potential table row — check neighbourhood for fee hint
    const start = Math.max(0, i - 6);
    const end = Math.min(lines.length, i + 12);
    const window = lines.slice(start, end).join('\n');
    if (!feeHintRe.test(window)) continue;

    // Collect contiguous table lines
    let end2 = i;
    while (end2 < lines.length && /^\s*\|.+\|\s*$/.test(lines[end2])) end2++;
    const tableLines = lines.slice(i, end2);
    if (tableLines.length >= 2) return tableLines.join('\n');
  }
  return null;
}

function parseGfmTable(tableText) {
  const rows = tableText.trim().split(/\r?\n/).map(l => l.trim());
  if (rows.length < 2) return null;
  // Second row is the separator (e.g. `|---|---|`) — verify and skip
  if (!/^\|\s*:?-+:?\s*\|/.test(rows[1])) return null;

  const dataRows = rows.slice(2);
  const out = [];
  for (const r of dataRows) {
    const cells = r.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 2) continue;
    const amount = cells[cells.length - 1];
    const label = cells.slice(0, -1).join(' — ');
    if (label && amount) out.push({ label, amount });
  }
  return out.length ? out : null;
}

function findFeesParagraph(body) {
  const feeHintRe = /\b(fee|fees|cost|price|pricing)\b/i;
  const blocks = body.split(/\n{2,}/);
  for (const block of blocks) {
    if (!feeHintRe.test(block)) continue;
    if (!/\$/.test(block)) continue;
    if (block.length > 600) continue;  // too long — probably not just fees
    return block.trim();
  }
  return null;
}

module.exports = {
  getInfoCatalogue,
  getServiceBody,
  invalidate,
  refresh,
};

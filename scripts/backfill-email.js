#!/usr/bin/env node
/**
 * One-shot backfill: inject a mandatory email-capture page into every
 * already-generated multi-page prototype in S3 that doesn't already
 * collect one.
 *
 * For each folder under `prototypes/`:
 *   1. Download every .html file.
 *   2. Detect whether the prototype already collects an email (looks for
 *      `GovBB.emailField('contact-email'` or `('email'` in any file).
 *   3. If yes, skip.
 *   4. Otherwise, patch every file: splice 'email' into FLOW (just before
 *      'check'), add 'email.html' to PAGE_FILES, add an email validation
 *      block to validate().
 *   5. Create a new email.html by cloning another file and swapping in
 *      a PAGES entry that renders the email question.
 *   6. Patch check.html to show the new email in the Check Your Answers
 *      summary.
 *   7. Invalidate the concierge catalogue so the retrofitted prototype is
 *      picked up on the next routing turn.
 *
 * Legacy single-file prototypes (prototypes/{file}.html) are skipped —
 * they have no flow to splice into.
 *
 * Safety:
 *   - Dry-run by default. Pass --apply to actually write to S3.
 *   - --folder=<handle> to limit to one prototype.
 *   - Every step is wrapped in try/catch per folder; a bad folder doesn't
 *     halt the whole run.
 *
 * Idempotent: running twice does nothing on the second pass because the
 * post-patch prototype contains the exact string the detection looks for.
 */

'use strict';

require('dotenv').config({ override: true });

const s3 = require('../lib/s3');

/* ── CLI ─────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose') || args.includes('-v');
const folderFilter = (() => {
  const f = args.find(a => a.startsWith('--folder='));
  return f ? f.substring('--folder='.length) : null;
})();

/* ── Templates ───────────────────────────────────────────────── */

const EMAIL_PAGES_TEMPLATE = `const PAGES = {
  'email': () => \`
    <form novalidate>
      \${GovBB.backLink()}
      \${GovBB.caption()}
      <h1 class="font-bold text-[3.5rem] leading-[1.15] mb-8">What is your email address?</h1>
      <div class="space-y-8">
        \${GovBB.emailField('contact-email', 'Email address', { hint: 'We will send you a confirmation after you submit.' })}
        \${GovBB.continueBtn()}
      </div>
    </form>\`,
};`;

const EMAIL_VALIDATE_BLOCK = `  if (pageId === 'email') {
    if (!D['contact-email']) {
      errors.push({ id: 'contact-email', msg: 'Email address – Enter your email address' });
    } else if (!/^\\S+@\\S+\\.\\S+$/.test(D['contact-email'])) {
      errors.push({ id: 'contact-email', msg: 'Email address – Enter a valid email address' });
    }
  }`;

const EMAIL_SUMMARY_BLOCK = `
      <div class="pt-4">
        <h2 class="text-[1.5rem] font-bold mb-4">Your email</h2>
        <dl class="divide-y divide-bb-grey-00 border-t border-bb-grey-00">
          \${GovBB.summaryRow('Email', GovBB.D['contact-email'], 'email')}
        </dl>
      </div>`;

/* ── Detection ───────────────────────────────────────────────── */

// True if any file in the folder already collects an email we'd recognise.
function alreadyCollectsEmail(htmlByFile) {
  const patterns = [
    /GovBB\.emailField\(\s*['"]contact-email['"]/,
    /GovBB\.emailField\(\s*['"]email['"]/,
    // Belt-and-braces: someone writing the input by hand with id="contact-email"
    /id=['"]contact-email['"]/,
  ];
  for (const html of Object.values(htmlByFile)) {
    if (patterns.some(p => p.test(html))) return true;
  }
  return false;
}

/* ── Parsing / patching ──────────────────────────────────────── */

// Extract and return the literal text of the FLOW array. e.g.
//   "['start', 'name', 'check', 'confirmation']"
function findFlow(html) {
  const m = html.match(/const\s+FLOW\s*=\s*(\[[^\]]*\])\s*;/);
  return m ? { full: m[0], arrayText: m[1] } : null;
}

// Extract the object literal text of PAGE_FILES.
function findPageFiles(html) {
  const m = html.match(/const\s+PAGE_FILES\s*=\s*(\{[\s\S]*?\})\s*;/);
  return m ? { full: m[0], objectText: m[1] } : null;
}

// Parse a JS-style array of single/double-quoted strings into a JS array.
function parseStringArray(text) {
  const out = [];
  const re = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

// Splice 'email' into a flow array. Preferred position: immediately
// before 'check'. Fallback: before 'confirmation'. Fallback: end.
function insertEmailInFlow(flow) {
  if (flow.includes('email')) return flow;
  const idxCheck = flow.indexOf('check');
  if (idxCheck >= 0) {
    return [...flow.slice(0, idxCheck), 'email', ...flow.slice(idxCheck)];
  }
  const idxConf = flow.indexOf('confirmation');
  if (idxConf >= 0) {
    return [...flow.slice(0, idxConf), 'email', ...flow.slice(idxConf)];
  }
  return [...flow, 'email'];
}

// Rewrite a file's FLOW and PAGE_FILES. Returns { html, changed: bool }.
function patchFlowAndPageFiles(html) {
  let changed = false;

  const flowLoc = findFlow(html);
  if (flowLoc) {
    const flow = parseStringArray(flowLoc.arrayText);
    if (!flow.includes('email')) {
      const next = insertEmailInFlow(flow);
      const rendered = `const FLOW = [${next.map(s => `'${s}'`).join(', ')}];`;
      html = html.replace(flowLoc.full, rendered);
      changed = true;
    }
  }

  const pfLoc = findPageFiles(html);
  if (pfLoc && !/['"]email['"]\s*:\s*['"]email\.html['"]/.test(pfLoc.objectText)) {
    // Insert a new row right before 'check' if present, else before the closing brace.
    let updated = pfLoc.objectText;
    if (/['"]check['"]\s*:/.test(updated)) {
      updated = updated.replace(
        /(\n\s*)(['"]check['"]\s*:)/,
        `$1'email': 'email.html',$1$2`
      );
    } else {
      // Append before the final `}`.
      updated = updated.replace(/(\n\s*)\}\s*$/, `$1  'email': 'email.html',$1}`);
    }
    html = html.replace(pfLoc.full, `const PAGE_FILES = ${updated};`);
    changed = true;
  }

  return { html, changed };
}

// Inject an `if (pageId === 'email') { ... }` block into validate() right
// before the `return errors;` line. No-op if the block already exists.
function patchValidate(html) {
  if (/if\s*\(\s*pageId\s*===\s*['"]email['"]\s*\)/.test(html)) {
    return { html, changed: false };
  }
  const returnPattern = /(\n[ \t]*)(return\s+errors\s*;)/;
  if (!returnPattern.test(html)) return { html, changed: false };
  const patched = html.replace(returnPattern, `$1${EMAIL_VALIDATE_BLOCK}\n$1$2`);
  return { html: patched, changed: patched !== html };
}

// Replace `const CURRENT_PAGE = '...';` with a given pageId.
function setCurrentPage(html, pageId) {
  return html.replace(
    /const\s+CURRENT_PAGE\s*=\s*['"][^'"]*['"]\s*;/,
    `const CURRENT_PAGE = '${pageId}';`
  );
}

// Replace the whole `const PAGES = { ... };` block with a new one.
// Uses brace-matching because PAGES can contain nested template literals
// with embedded `{...}` that a lazy `\{[\s\S]*?\}` regex would mis-match.
function replacePagesBlock(html, newBlock) {
  const startMatch = html.match(/const\s+PAGES\s*=\s*\{/);
  if (!startMatch) return null;
  const start = startMatch.index;
  const openIdx = html.indexOf('{', start);

  // Walk forward tracking brace depth, respecting template literals
  // and regular strings so we don't miscount braces inside them.
  let i = openIdx;
  let depth = 0;
  let inTpl = false;      // inside a backtick `...` string
  let inSingle = false;
  let inDouble = false;
  let tplExprDepth = 0;   // ${ ... } depth inside a template literal
  while (i < html.length) {
    const ch = html[i];
    const prev = i > 0 ? html[i - 1] : '';
    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
    } else if (inDouble) {
      if (ch === '"' && prev !== '\\') inDouble = false;
    } else if (inTpl) {
      if (tplExprDepth > 0) {
        // Inside a ${ ... } expression — count braces as normal code
        if (ch === '{') tplExprDepth++;
        else if (ch === '}') tplExprDepth--;
      } else if (ch === '`' && prev !== '\\') {
        inTpl = false;
      } else if (ch === '$' && html[i + 1] === '{') {
        tplExprDepth++;
        i++; // skip the {
      }
    } else {
      if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
      else if (ch === '`') inTpl = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    i++;
  }
  if (depth !== 0) return null;

  // Skip trailing whitespace and optional semicolon
  let end = i + 1;
  while (end < html.length && /\s/.test(html[end])) end++;
  if (html[end] === ';') end++;

  return html.substring(0, start) + newBlock + html.substring(end);
}

// Inject the email summary row into a check.html body. Prefers to append
// the block right before the first continueBtn call inside the PAGES
// template literal.
function patchCheckSummary(html) {
  if (/summaryRow\(\s*['"]Email['"]/.test(html)) {
    return { html, changed: false };
  }
  // Find `${GovBB.continueBtn(...)}` and insert our block just before it.
  // Only replace the FIRST occurrence (there is only one per check page).
  const m = html.match(/\$\{GovBB\.continueBtn\(/);
  if (!m) return { html, changed: false };
  const insertAt = m.index;
  const patched = html.substring(0, insertAt) + EMAIL_SUMMARY_BLOCK + '\n      ' + html.substring(insertAt);
  return { html: patched, changed: true };
}

// Build the email.html content by cloning another page file (for chrome
// and config) and swapping in the email PAGES + CURRENT_PAGE.
function buildEmailPage(templateHtml) {
  let html = setCurrentPage(templateHtml, 'email');
  const replaced = replacePagesBlock(html, EMAIL_PAGES_TEMPLATE);
  if (!replaced) throw new Error('Could not locate PAGES block in template file');
  html = replaced;
  // Update the <title> tag to note this is the email page — non-fatal if missing.
  html = html.replace(
    /<title>([^<]*?)<\/title>/i,
    (_m, inner) => `<title>${inner.replace(/\s+–.*$/, '')} – Email address</title>`
  );
  return html;
}

/* ── S3 helpers ──────────────────────────────────────────────── */

async function listFolders() {
  const objects = await s3.listObjects('prototypes/');
  const folders = new Map(); // name -> Set<pageFilename>
  for (const obj of objects) {
    const rel = obj.key.replace('prototypes/', '');
    if (!rel.endsWith('.html')) continue;
    const parts = rel.split('/');
    if (parts.length !== 2) continue; // skip legacy flat files
    if (!folders.has(parts[0])) folders.set(parts[0], new Set());
    folders.get(parts[0]).add(parts[1]);
  }
  return folders;
}

async function fetchText(key) {
  const { body } = await s3.getObject(key);
  if (body && typeof body.transformToString === 'function') {
    return body.transformToString('utf-8');
  }
  const chunks = [];
  for await (const c of body) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf-8');
}

async function downloadFolder(folder, files) {
  const out = {};
  for (const filename of files) {
    const key = `prototypes/${folder}/${filename}`;
    out[filename] = await fetchText(key);
  }
  return out;
}

async function uploadFolder(folder, files) {
  for (const [filename, html] of Object.entries(files)) {
    const key = `prototypes/${folder}/${filename}`;
    await s3.putObject(key, html, 'text/html');
  }
}

/* ── Main per-folder ─────────────────────────────────────────── */

async function processFolder(folder, filenames) {
  const htmlByFile = await downloadFolder(folder, [...filenames]);
  const originalFilenames = new Set(Object.keys(htmlByFile));

  if (alreadyCollectsEmail(htmlByFile)) {
    return { folder, status: 'skipped', reason: 'already collects email' };
  }

  const changed = new Set(); // filenames we need to upload

  // 1. Patch FLOW, PAGE_FILES, validate() in every existing file.
  for (const [filename, original] of Object.entries(htmlByFile)) {
    let html = original;
    let { html: a, changed: ca } = patchFlowAndPageFiles(html);
    html = a;
    let { html: b, changed: cb } = patchValidate(html);
    html = b;
    if (ca || cb || html !== original) {
      htmlByFile[filename] = html;
      changed.add(filename);
    }
  }

  // 2. Patch check.html's summary to include the email row.
  if (htmlByFile['check.html']) {
    const before = htmlByFile['check.html'];
    const { html: after, changed: cc } = patchCheckSummary(before);
    if (cc && after !== before) {
      htmlByFile['check.html'] = after;
      changed.add('check.html');
    }
  }

  // 3. Build the new email.html using index.html as the template.
  const templateFile = htmlByFile['index.html'] || Object.values(htmlByFile)[0];
  if (!templateFile) {
    return { folder, status: 'failed', reason: 'no template file available' };
  }
  try {
    htmlByFile['email.html'] = buildEmailPage(templateFile);
    changed.add('email.html');
  } catch (err) {
    return { folder, status: 'failed', reason: `email.html build: ${err.message}` };
  }

  if (VERBOSE) {
    console.log(`    files changed: ${[...changed].join(', ')}`);
  }

  if (!APPLY) {
    return {
      folder,
      status: 'planned',
      changedCount: changed.size,
      newFile: !originalFilenames.has('email.html'),
    };
  }

  // 4. Upload only the changed files.
  const uploadMap = {};
  for (const filename of changed) uploadMap[filename] = htmlByFile[filename];
  await uploadFolder(folder, uploadMap);

  return {
    folder,
    status: 'applied',
    changedCount: changed.size,
    newFile: !originalFilenames.has('email.html'),
  };
}

/* ── Runner ──────────────────────────────────────────────────── */

async function main() {
  console.log(`Backfill email — mode: ${APPLY ? 'APPLY (writes to S3)' : 'dry-run (no writes)'}`);
  if (folderFilter) console.log(`Folder filter: ${folderFilter}`);
  console.log();

  const folders = await listFolders();
  const tally = { scanned: 0, skipped: 0, planned: 0, applied: 0, failed: 0 };

  for (const [folder, filenames] of [...folders.entries()].sort()) {
    if (folderFilter && folder !== folderFilter) continue;
    tally.scanned++;
    process.stdout.write(`  ${folder} ... `);
    try {
      const result = await processFolder(folder, filenames);
      if (result.status === 'skipped') {
        console.log(`skipped (${result.reason})`);
        tally.skipped++;
      } else if (result.status === 'planned') {
        console.log(`would update ${result.changedCount} file(s)${result.newFile ? ' + new email.html' : ''}`);
        tally.planned++;
      } else if (result.status === 'applied') {
        console.log(`applied (${result.changedCount} file(s)${result.newFile ? ' + new email.html' : ''})`);
        tally.applied++;
      } else if (result.status === 'failed') {
        console.log(`FAILED: ${result.reason}`);
        tally.failed++;
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      tally.failed++;
      if (VERBOSE) console.error(err.stack);
    }
  }

  console.log();
  console.log('──────────────────────────────────────────');
  console.log(`  Scanned:          ${tally.scanned}`);
  console.log(`  Already had email: ${tally.skipped}`);
  if (APPLY) console.log(`  Applied:          ${tally.applied}`);
  else       console.log(`  Planned changes:  ${tally.planned}   (re-run with --apply to write)`);
  console.log(`  Failed:           ${tally.failed}`);
  console.log('──────────────────────────────────────────');

  if (APPLY && tally.applied > 0) {
    // Best-effort: if the server is running in the same process, invalidate
    // the concierge catalogue. In practice this script runs separately, so
    // the live server will pick up changes on its next 5-minute TTL expiry.
    try {
      require('../lib/catalogue').invalidate();
      console.log('Concierge catalogue invalidated (local).');
    } catch (_) {}
  }
}

main().catch(err => {
  console.error('Fatal:', err.stack || err.message);
  process.exit(1);
});

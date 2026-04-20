require('dotenv').config({ override: true });

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { extractFormSpec } = require('./lib/pdf');
const { generateReference } = require('./lib/reference');
const { sendConfirmation, sendNotification } = require('./lib/email');
const { generatePrototype } = require('./lib/generate');
const { chat } = require('./lib/chat');
const { concierge } = require('./lib/concierge');
const catalogue = require('./lib/catalogue');
const infoCatalogue = require('./lib/info-catalogue');
const prototypeMeta = require('./lib/prototype-meta');
const cms = require('./lib/cases');
const whatsapp = require('./lib/whatsapp');
const s3 = require('./lib/s3');
const { forwardAnthropicError } = require('./lib/http');

const app = express();
const PORT = process.env.PORT || 3000;

// MIME type lookup for S3 proxy
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

// Multer: in-memory storage for PDF uploads (max 10MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted'));
  },
});

// ── Middleware ───────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// Serve the generator UI from public/ (index.html, prototypes.html)
app.use(express.static(path.join(__dirname, 'public')));

// ── POST /api/generate ──────────────────────────────────────
app.post('/api/generate', upload.single('pdf'), async (req, res) => {
  // Long timeout for Claude API calls (up to 20 minutes)
  req.setTimeout(20 * 60 * 1000);
  res.setTimeout(20 * 60 * 1000);

  try {
    let formSpec = '';

    // Extract text from PDF or use description
    if (req.file) {
      console.log(`\n━━━ Generate: PDF Upload ━━━━━━━━━━━━━━━━━━━━`);
      console.log(`  File: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)}KB)`);

      try {
        const result = await extractFormSpec(req.file.buffer, req.file.originalname);
        formSpec = result.formSpec;
        console.log(`  Source: ${result.source === 'vision' ? 'Claude vision (scanned PDF)' : 'embedded text'}`);
      } catch (err) {
        // The extractor throws with a user-friendly message when neither
        // path recovers usable content.
        return res.status(400).json({
          success: false,
          error: err.message,
        });
      }
    } else if (req.body.description) {
      formSpec = req.body.description;
      console.log(`\n━━━ Generate: Text Description ━━━━━━━━━━━━━━`);
      console.log(`  Length: ${formSpec.length} characters`);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Please provide a PDF file or text description.',
      });
    }

    // Per-service options from the upload row (both optional):
    //   notification_email — where submissions to THIS prototype should be
    //                        emailed (overrides MDA_EMAIL env default)
    //   instructions       — extra guidance for Claude for THIS service,
    //                        appended to the user prompt
    const notificationEmail = (req.body.notification_email || '').trim();
    const instructions = (req.body.instructions || '').trim();
    if (notificationEmail) console.log(`  Notification email: ${notificationEmail}`);
    if (instructions) console.log(`  Extra instructions: ${instructions.length} chars`);

    // Call Claude API to generate the prototype
    console.log('  Generating prototype with Claude API...');
    const { files, formName } = await generatePrototype(formSpec, {
      instructions: instructions || null,
    });

    if (!files || files.length === 0) {
      return res.status(500).json({
        success: false,
        error: 'The generated output was too short. Please try again with more detail.',
      });
    }

    // Generate folder slug
    const slug = formName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 60);
    const timestamp = Date.now().toString(36);
    const folder = `${slug}-${timestamp}`;

    // Save all files to S3 under the folder
    let totalSize = 0;
    for (const file of files) {
      const s3Key = `prototypes/${folder}/${file.filename}`;
      await s3.putObject(s3Key, file.html, 'text/html');
      totalSize += file.html.length;
      console.log(`  Saved: ${s3Key}`);
    }

    // Write per-prototype meta.json sidecar when either option was set.
    // /api/submit reads this back to route notifications to the per-
    // service email instead of the MDA_EMAIL env default.
    if (notificationEmail || instructions) {
      try {
        await prototypeMeta.setMeta(folder, {
          formName,
          notificationEmail: notificationEmail || null,
          instructions: instructions || null,
          createdAt: new Date().toISOString(),
        });
        console.log(`  Saved: prototypes/${folder}/meta.json`);
      } catch (err) {
        // Non-fatal — the prototype itself is fine, just no meta record.
        console.warn(`  meta.json write failed: ${err.message}`);
      }
    }

    // Invalidate the concierge catalogue so the new prototype is routable
    // immediately (otherwise citizens would wait up to 5 min for TTL expiry).
    catalogue.invalidate();

    const url = `/${folder}/index.html`;
    console.log(`  ${files.length} files, ${(totalSize / 1024).toFixed(1)}KB total`);
    console.log(`  URL: ${url}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    return res.json({
      success: true,
      url,
      formName,
      folder,
      files: files.map(f => f.filename),
    });

  } catch (err) {
    console.error('  Generation error:', err.message);
    if (forwardAnthropicError(err, res)) return;
    return res.status(500).json({
      success: false,
      error: err.message || 'An unexpected error occurred during generation.',
    });
  }
});

// ── GET /api/prototypes ─────────────────────────────────────
app.get('/api/prototypes', async (req, res) => {
  try {
    const objects = await s3.listObjects('prototypes/');

    // Group objects by folder (multi-page) or detect flat files (legacy)
    const folders = new Map();  // folder -> { indexKey, totalSize, created, files[] }
    const flatFiles = [];       // legacy single-file prototypes

    // Tombstone marker sets — populated by scanning for `.deleted` sentinel
    // files. A folder-based prototype is tombstoned by writing
    // `prototypes/<folder>/.deleted`; a legacy flat file is tombstoned by
    // writing `prototypes/<filename>.html.deleted` next to the HTML file.
    // Both forms are written by POST /api/prototypes/:folder/delete.
    const deletedFolders = new Set();
    const deletedFlatFiles = new Set();

    for (const obj of objects) {
      const relPath = obj.key.replace('prototypes/', '');
      if (!relPath) continue;

      // Collect tombstones first — they're not HTML, and they hide
      // the HTML files listed elsewhere in this pass.
      if (relPath.endsWith('/.deleted')) {
        const folder = relPath.slice(0, -'/.deleted'.length);
        if (folder) deletedFolders.add(folder);
        continue;
      }
      if (relPath.endsWith('.html.deleted')) {
        const filename = relPath.slice(0, -'.deleted'.length);  // foo.html
        deletedFlatFiles.add(filename);
        continue;
      }

      if (!relPath.endsWith('.html')) continue;

      const parts = relPath.split('/');
      if (parts.length === 2) {
        // Folder-based: prototypes/{folder}/{page}.html
        const folder = parts[0];
        const page = parts[1];
        if (!folders.has(folder)) {
          folders.set(folder, { indexKey: null, totalSize: 0, created: obj.lastModified, files: [] });
        }
        const entry = folders.get(folder);
        entry.totalSize += obj.size;
        entry.files.push(page);
        if (page === 'index.html') entry.indexKey = obj.key;
        // Use earliest file date as created
        if (obj.lastModified < entry.created) entry.created = obj.lastModified;
      } else if (parts.length === 1) {
        // Legacy flat file: prototypes/{filename}.html
        flatFiles.push(obj);
      }
    }

    // Drop tombstoned entries from the groupings.
    for (const folder of deletedFolders) folders.delete(folder);

    const prototypes = [];

    // Process folder-based prototypes
    for (const [folder, entry] of folders) {
      let title = null;
      const titleKey = entry.indexKey || `prototypes/${folder}/${entry.files[0]}`;
      try {
        const head = await s3.getObjectRange(titleKey, 0, 1999);
        const m = head.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (m) title = m[1].split(/\s*[–—|]\s*/)[0].trim();
      } catch (_) {}

      prototypes.push({
        filename: `${folder}/index.html`,
        url: `/${folder}/index.html`,
        title,
        size: entry.totalSize,
        created: entry.created,
        folder,
        pages: entry.files,
      });
    }

    // Process legacy flat files (skip tombstoned)
    for (const obj of flatFiles) {
      const filename = obj.key.replace('prototypes/', '');
      if (deletedFlatFiles.has(filename)) continue;
      let title = null;
      try {
        const head = await s3.getObjectRange(obj.key, 0, 1999);
        const m = head.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (m) title = m[1].split(/\s*[–—|]\s*/)[0].trim();
      } catch (_) {}

      prototypes.push({
        filename,
        url: `/${filename}`,
        title,
        size: obj.size,
        created: obj.lastModified,
      });
    }

    // Sort newest first
    prototypes.sort((a, b) => new Date(b.created) - new Date(a.created));

    return res.json({ prototypes });
  } catch (err) {
    console.error('  List prototypes error:', err.message);
    return res.status(500).json({ prototypes: [], error: err.message });
  }
});

// ── POST /api/submit ────────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  const { formName, formData, userEmail, folder } = req.body;

  // Basic validation
  if (!formName || !formData || typeof formData !== 'object') {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: formName and formData',
    });
  }

  // Generate reference number
  const referenceNumber = generateReference(formName);

  // Create case in CMS
  cms.createCase({ referenceNumber, formName, formData, userEmail, channel: 'form' });

  // Look up per-prototype meta (if the generator UI set a notification
  // email on this service). Missing meta = use MDA_EMAIL default.
  let notificationTarget = null;
  if (folder) {
    const meta = await prototypeMeta.getMeta(folder);
    if (meta && meta.notificationEmail) {
      notificationTarget = meta.notificationEmail;
    }
  }

  console.log(`\n━━━ New Submission ━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Form:      ${formName}`);
  console.log(`  Reference: ${referenceNumber}`);
  console.log(`  Email:     ${userEmail || '(none)'}`);
  console.log(`  Notify →   ${notificationTarget || '(default MDA inbox)'}`);
  console.log(`  Fields:    ${Object.keys(formData).length}`);
  console.log(`  Time:      ${new Date().toISOString()}`);

  // Send both emails in parallel (neither blocks the other)
  const [confirmResult, notifyResult] = await Promise.allSettled([
    sendConfirmation(userEmail, formName, referenceNumber),
    sendNotification(formName, formData, referenceNumber, userEmail, { notificationTarget }),
  ]);

  const emailSent =
    (confirmResult.status === 'fulfilled' && confirmResult.value !== null) ||
    (notifyResult.status === 'fulfilled' && notifyResult.value !== null);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  return res.json({
    success: true,
    referenceNumber,
    emailSent,
  });
});


// ── S3 proxy: serve assets ──────────────────────────────────
app.get('/assets/:filename', async (req, res) => {
  const filename = req.params.filename;
  const ext = path.extname(filename);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const s3Key = `assets/${filename}`;

  try {
    const obj = await s3.getObject(s3Key);
    res.set('Content-Type', contentType);
    if (obj.contentLength) res.set('Content-Length', String(obj.contentLength));
    res.set('Cache-Control', 'public, max-age=3600');
    obj.body.pipe(res);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).send('Not found');
    }
    console.error(`  S3 asset error (${s3Key}):`, err.message);
    return res.status(500).send('Internal server error');
  }
});

// ── S3 proxy: serve prototypes (folder-based: /{folder}/{page}.html) ──
app.get(/^\/([a-z0-9][a-z0-9\-]*)\/([a-z0-9][a-z0-9\-]*\.html)$/i, async (req, res) => {
  const folder = req.params[0];
  const page = req.params[1];
  const s3Key = `prototypes/${folder}/${page}`;

  try {
    const obj = await s3.getObject(s3Key);
    res.set('Content-Type', 'text/html');
    if (obj.contentLength) res.set('Content-Length', String(obj.contentLength));
    obj.body.pipe(res);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).send('Not found');
    }
    console.error(`  S3 prototype error (${s3Key}):`, err.message);
    return res.status(500).send('Internal server error');
  }
});

// ── S3 proxy: serve prototypes (legacy flat: /{filename}.html) ──
app.get(/^\/([a-z0-9][a-z0-9\-]*\.html)$/i, async (req, res) => {
  const filename = req.params[0];
  const s3Key = `prototypes/${filename}`;

  try {
    const obj = await s3.getObject(s3Key);
    res.set('Content-Type', 'text/html');
    if (obj.contentLength) res.set('Content-Length', String(obj.contentLength));
    obj.body.pipe(res);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).send('Not found');
    }
    console.error(`  S3 prototype error (${s3Key}):`, err.message);
    return res.status(500).send('Internal server error');
  }
});

// ── POST /api/chat ──────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { conversationId, formName, formScript, message } = req.body;

  // First message must include formName and formScript
  if (!conversationId && (!formName || !formScript)) {
    return res.status(400).json({
      success: false,
      error: 'First message must include formName and formScript.',
    });
  }

  try {
    const result = await chat({ conversationId, formName, formScript, message });

    // If the form is complete, submit it
    if (result.complete) {
      const referenceNumber = generateReference(result.formData['form-name'] || formName || 'Chat Form');
      const userEmail = result.formData['contact-email'] || result.formData['email'] || null;

      // Create case in CMS
      cms.createCase({
        referenceNumber,
        formName: formName || 'Chat Form',
        formData: result.formData,
        userEmail,
        channel: 'chat',
      });

      console.log(`\n━━━ Chat Submission ━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`  Form:      ${formName || 'Chat Form'}`);
      console.log(`  Reference: ${referenceNumber}`);
      console.log(`  Fields:    ${Object.keys(result.formData).length}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      // Send emails in background (don't block the response)
      Promise.allSettled([
        sendConfirmation(userEmail, formName, referenceNumber),
        sendNotification(formName, result.formData, referenceNumber, userEmail),
      ]);

      return res.json({
        success: true,
        conversationId: result.conversationId,
        reply: result.reply,
        fields: result.fields,
        formData: result.formData,
        complete: true,
        referenceNumber,
      });
    }

    return res.json({
      success: true,
      conversationId: result.conversationId,
      reply: result.reply,
      fields: result.fields,
      formData: result.formData,
      complete: false,
    });

  } catch (err) {
    console.error('  Chat error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Something went wrong. Please try again.',
    });
  }
});

// ── POST /api/concierge ─────────────────────────────────────
// Front-door chat: match free-text citizen intents to digitised services.
app.post('/api/concierge', async (req, res) => {
  const { conversationId, message } = req.body || {};

  try {
    const result = await concierge({ conversationId, message });

    // Log routing outcome for visibility — "no match" rate informs what to
    // digitise next; most-requested intents inform catalogue curation.
    const userMsg = typeof message === 'string' ? message.trim() : '';
    if (userMsg) {
      if (result.answered) {
        console.log(`  Concierge: "${userMsg}" → answered from ${result.answered.slug} ("${result.answered.quote.substring(0, 60)}…")`);
      } else if (result.deferred) {
        console.log(`  Concierge: "${userMsg}" → deferred to ${result.deferred.slug}`);
      } else if (result.recommendations.length > 0) {
        const labels = result.recommendations.map(r => {
          const id = r.kind === 'online-form' ? r.folder : r.slug;
          return `${r.kind === 'online-form' ? 'form' : 'info'}:${id}`;
        }).join(', ');
        console.log(`  Concierge: "${userMsg}" → ${labels}`);
      } else if (result.noMatch) {
        console.log(`  Concierge: "${userMsg}" → no match`);
      } else {
        console.log(`  Concierge: "${userMsg}" → clarifying question`);
      }
    }

    return res.json({
      success: true,
      conversationId: result.conversationId,
      reply: result.reply,
      recommendations: result.recommendations,
      answered: result.answered,
      deferred: result.deferred,
      noMatch: result.noMatch,
    });
  } catch (err) {
    console.error('  Concierge error:', err.message);
    if (forwardAnthropicError(err, res)) return;
    return res.status(500).json({
      success: false,
      error: 'Something went wrong. Please try again.',
    });
  }
});

// ── POST /api/info-catalogue/refresh ────────────────────────
// Force a fresh build of the info-catalogue (from the frontend-alpha
// GitHub repo) so content-team updates surface without waiting for the
// 6-hour TTL. Requires a shared-secret token — without it this would be
// a trivial DoS vector (~50 GitHub fetches per call).
app.post('/api/info-catalogue/refresh', async (req, res) => {
  const expected = process.env.INFO_CATALOGUE_REFRESH_TOKEN;
  if (!expected) {
    return res.status(503).json({
      success: false,
      error: 'INFO_CATALOGUE_REFRESH_TOKEN is not set on the server. Set it in .env to enable this endpoint.',
    });
  }
  const header = req.headers['authorization'] || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== expected) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const result = await infoCatalogue.refresh();
    console.log(`  Info catalogue refreshed: ${result.records} records (${result.errors} errors)`);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('  Info catalogue refresh error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── WhatsApp webhook ───────────────────────────────────────
app.get('/api/whatsapp/webhook', whatsapp.verifyWebhook);
app.post('/api/whatsapp/webhook', whatsapp.handleWebhook);
app.post('/api/whatsapp/simulator', whatsapp.handleSimulator);

// ── GET /go/whatsapp ───────────────────────────────────────
// Single redirect that "Continue via WhatsApp" buttons point to. In LIVE
// mode with a resolved display number, sends the citizen to the real
// WhatsApp app via wa.me/ with a prefilled starter message. Otherwise
// falls back to the in-browser simulator.
app.get('/go/whatsapp', async (req, res) => {
  const formFile = (req.query.form || '').toString();
  if (!formFile) return res.status(400).send('Missing ?form parameter');

  // Best-effort: look up the form name from the catalogue for a nicer
  // prefill message. If the catalogue doesn't know about it (e.g. the
  // user is previewing a local-only prototype), we still redirect with
  // a generic label.
  let formName = null;
  try {
    const records = await catalogue.getCatalogue();
    const folder = formFile.split('/')[0].replace(/\.html$/i, '');
    const rec = records.find(r => r.folder === folder);
    if (rec) formName = rec.formName;
  } catch (_) { /* non-fatal */ }

  const target = await whatsapp.getStartLink(formFile, formName);
  return res.redirect(302, target);
});

// ── CMS: Authentication ────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  const session = cms.getSession(auth.slice(7));
  if (!session) {
    return res.status(401).json({ error: 'Session expired or invalid' });
  }
  req.caseworker = session;
  next();
}

app.post('/api/cms/login', (req, res) => {
  const { username, password } = req.body;
  const result = cms.login(username, password);
  if (!result) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  return res.json({ success: true, ...result });
});

app.post('/api/cms/logout', (req, res) => {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    cms.logout(auth.slice(7));
  }
  return res.json({ success: true });
});

// ── CMS: Cases ─────────────────────────────────────────────

app.get('/api/cms/cases', requireAuth, (req, res) => {
  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.query.formName) filters.formName = req.query.formName;
  const caseList = cms.listCases(Object.keys(filters).length ? filters : null);
  const counts = cms.getCaseCounts();
  const formNames = cms.getFormNames();
  return res.json({ cases: caseList, counts, formNames });
});

app.get('/api/cms/cases/:id', requireAuth, (req, res) => {
  const c = cms.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  return res.json(c);
});

// ── POST /api/prototypes/delete ──────────────────────────────
// Soft-delete a prototype by writing a tombstone sentinel file next to
// it. The listing (`GET /api/prototypes`) and the concierge catalogue
// both skip tombstoned entries. Data stays in S3 (the IAM policy here
// doesn't grant DeleteObject); a later manual cleanup or IAM update can
// hard-delete the bytes.
//
// Request: { target: "<filename>" } where <filename> is either
//   - "<folder>/index.html"  → tombstones prototypes/<folder>/.deleted
//   - "<slug>.html"          → tombstones prototypes/<slug>.html.deleted
app.post('/api/prototypes/delete', requireAuth, async (req, res) => {
  const target = (req.body && req.body.target ? String(req.body.target) : '').trim();

  // Reject path traversal and malformed inputs
  if (!target || target.includes('..') || target.startsWith('/') || !target.endsWith('.html')) {
    return res.status(400).json({ success: false, error: 'Invalid target.' });
  }

  const parts = target.split('/');
  let tombstoneKey;
  let label;
  if (parts.length === 2) {
    const folder = parts[0];
    if (!folder) return res.status(400).json({ success: false, error: 'Invalid target.' });
    tombstoneKey = `prototypes/${folder}/.deleted`;
    label = `folder:${folder}`;
  } else if (parts.length === 1) {
    tombstoneKey = `prototypes/${target}.deleted`;
    label = `flat:${target}`;
  } else {
    return res.status(400).json({ success: false, error: 'Invalid target.' });
  }

  try {
    const now = new Date().toISOString();
    const body = JSON.stringify({
      deletedAt: now,
      deletedBy: req.caseworker && req.caseworker.username ? req.caseworker.username : 'unknown',
      target,
    }, null, 2);
    await s3.putObject(tombstoneKey, body, 'application/json');

    // Catalogues cache for 5 min and 6 h; invalidate both so the delete
    // is visible to prototypes.html AND to the concierge immediately.
    try { catalogue.invalidate(); } catch (_) {}
    try { infoCatalogue.invalidate(); } catch (_) {}

    console.log(`  Tombstoned ${label} by ${req.caseworker.username} at ${now}`);
    return res.json({ success: true, tombstone: tombstoneKey });
  } catch (err) {
    console.error('  Tombstone write failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/cms/cases/:id/approve', requireAuth, async (req, res) => {
  const { notes, credentialType, credentialSubject, validityYears } = req.body;
  const c = cms.approveCase(req.params.id, req.caseworker.name, notes);
  if (!c) return res.status(404).json({ error: 'Case not found' });

  // If credential details provided, issue to wallet
  if (credentialType && credentialSubject) {
    const nationalId = c.formData['national-id'] || c.formData['nationalId'] || null;
    if (nationalId) {
      try {
        const issuerUrl = process.env.ISSUER_URL || 'http://localhost:3001';
        const apiKey = process.env.ISSUER_API_KEY || '';

        const issueRes = await fetch(`${issuerUrl}/api/v1/credentials/issue`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'X-Request-Id': `cms-${c.id}-${Date.now()}`,
          },
          body: JSON.stringify({
            credentialType,
            nationalId,
            subject: credentialSubject,
            caseReference: c.id,
            validityYears: validityYears || undefined,
          }),
        });

        const issueResult = await issueRes.json();

        if (issueRes.ok && issueResult.credentialId) {
          cms.recordCredential(c.id, issueResult.credentialId, issueResult.deliveredToWallet);
          c.credentialId = issueResult.credentialId;
          c.credentialDelivered = issueResult.deliveredToWallet;
          console.log(`  ✓ Credential issued: ${issueResult.credentialId}`);
        } else {
          console.error(`  ✗ Credential issuance failed:`, issueResult.error || issueResult);
          c._credentialError = issueResult.error || 'Issuance failed';
        }
      } catch (err) {
        console.error(`  ✗ Could not reach issuer service:`, err.message);
        c._credentialError = `Could not reach issuer service: ${err.message}`;
      }
    }
  }

  return res.json({ success: true, case: c });
});

app.post('/api/cms/cases/:id/reject', requireAuth, (req, res) => {
  const { notes } = req.body;
  const c = cms.rejectCase(req.params.id, req.caseworker.name, notes);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  return res.json({ success: true, case: c });
});

// ── Multer error handler ────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: 'File too large. Maximum size is 10MB.' });
    }
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err.message === 'Only PDF files are accepted') {
    return res.status(400).json({ success: false, error: err.message });
  }
  next(err);
});

// ── Sync shared assets to S3 on startup ─────────────────────
async function syncAssetsToS3() {
  const assetsDir = path.join(__dirname, 'public', 'assets');
  const assetFiles = ['govbb-tailwind-config.js', 'govbb-base.css', 'govbb-framework.js'];

  for (const file of assetFiles) {
    const filePath = path.join(assetsDir, file);
    if (!fs.existsSync(filePath)) continue;

    const ext = path.extname(file);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const body = fs.readFileSync(filePath, 'utf-8');
    const s3Key = `assets/${file}`;

    try {
      await s3.putObject(s3Key, body, contentType);
      console.log(`  ✓ Synced ${s3Key}`);
    } catch (err) {
      console.error(`  ✗ Failed to sync ${s3Key}:`, err.message);
    }
  }
}

// ── Start ───────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🏛  GovTech Forms server running at http://localhost:${PORT}`);
  console.log(`   Generator: http://localhost:${PORT}/`);
  console.log(`   Storage: S3 (${process.env.S3_BUCKET || 'no bucket configured'})`);

  if (process.env.S3_BUCKET) {
    console.log(`   Syncing shared assets to S3...`);
    await syncAssetsToS3();
  } else {
    console.log(`   ⚠  S3_BUCKET not set — S3 features disabled`);
  }

  console.log('');
});

require('dotenv').config({ override: true });

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { generateReference } = require('./lib/reference');
const { sendConfirmation, sendNotification } = require('./lib/email');
const { generatePrototype } = require('./lib/generate');
const { chat } = require('./lib/chat');
const { lookupCitizen, lookupVehicle, lookupBusiness } = require('./lib/mock-apis');
const cms = require('./lib/cases');
const whatsapp = require('./lib/whatsapp');
const s3 = require('./lib/s3');

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
  // Long timeout for Claude API calls (up to 15 minutes)
  req.setTimeout(15 * 60 * 1000);
  res.setTimeout(15 * 60 * 1000);

  try {
    let formSpec = '';

    // Extract text from PDF or use description
    if (req.file) {
      console.log(`\n━━━ Generate: PDF Upload ━━━━━━━━━━━━━━━━━━━━`);
      console.log(`  File: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)}KB)`);

      const pdfData = await pdfParse(req.file.buffer);
      formSpec = pdfData.text;

      if (!formSpec || formSpec.trim().length < 20) {
        return res.status(400).json({
          success: false,
          error: 'Could not extract enough text from the PDF. The file may be scanned or image-based. Try using the text description instead.',
        });
      }

      console.log(`  Extracted: ${formSpec.length} characters`);
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

    // Call Claude API to generate the prototype
    console.log('  Generating prototype with Claude API...');
    const { html, formName } = await generatePrototype(formSpec);

    if (!html || html.length < 100) {
      return res.status(500).json({
        success: false,
        error: 'The generated output was too short. Please try again with more detail.',
      });
    }

    // Generate filename slug
    const slug = formName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 60);
    const timestamp = Date.now().toString(36);
    const filename = `${slug}-${timestamp}.html`;

    // Save to S3
    const s3Key = `prototypes/${filename}`;
    await s3.putObject(s3Key, html, 'text/html');

    const url = `/${filename}`;
    console.log(`  Saved to S3: ${s3Key} (${(html.length / 1024).toFixed(1)}KB)`);
    console.log(`  URL: ${url}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    return res.json({
      success: true,
      url,
      formName,
      filename,
    });

  } catch (err) {
    console.error('  Generation error:', err.message);
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

    const files = [];
    for (const obj of objects) {
      const filename = obj.key.replace('prototypes/', '');
      if (!filename || !filename.endsWith('.html')) continue;

      // Extract title from the first 2000 bytes of the HTML
      let title = null;
      try {
        const head = await s3.getObjectRange(obj.key, 0, 1999);
        const m = head.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (m) title = m[1].split(/\s*[–—|]\s*/)[0].trim();
      } catch (_) {}

      files.push({
        filename,
        url: `/${filename}`,
        title,
        size: obj.size,
        created: obj.lastModified,
      });
    }

    // Sort newest first
    files.sort((a, b) => new Date(b.created) - new Date(a.created));

    return res.json({ prototypes: files });
  } catch (err) {
    console.error('  List prototypes error:', err.message);
    return res.status(500).json({ prototypes: [], error: err.message });
  }
});

// ── POST /api/submit ────────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  const { formName, formData, userEmail } = req.body;

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

  console.log(`\n━━━ New Submission ━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Form:      ${formName}`);
  console.log(`  Reference: ${referenceNumber}`);
  console.log(`  Email:     ${userEmail || '(none)'}`);
  console.log(`  Fields:    ${Object.keys(formData).length}`);
  console.log(`  Time:      ${new Date().toISOString()}`);

  // Send both emails in parallel (neither blocks the other)
  const [confirmResult, notifyResult] = await Promise.allSettled([
    sendConfirmation(userEmail, formName, referenceNumber),
    sendNotification(formName, formData, referenceNumber, userEmail),
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

// ── POST /api/trident-id ────────────────────────────────────
app.post('/api/trident-id', (req, res) => {
  const { nationalId } = req.body;
  const result = lookupCitizen(nationalId);
  // Simulate network latency (500-1000ms)
  setTimeout(() => res.json(result), 500 + Math.random() * 500);
});

// ── POST /api/vehicle-lookup ────────────────────────────────
app.post('/api/vehicle-lookup', (req, res) => {
  const { plate } = req.body;
  const result = lookupVehicle(plate);
  // Simulate network latency (500-1000ms)
  setTimeout(() => res.json(result), 500 + Math.random() * 500);
});

// ── POST /api/business-lookup ──────────────────────────────
app.post('/api/business-lookup', (req, res) => {
  const { registrationNumber } = req.body;
  const result = lookupBusiness(registrationNumber);
  // Simulate network latency (500-1000ms)
  setTimeout(() => res.json(result), 500 + Math.random() * 500);
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

// ── S3 proxy: serve prototypes ──────────────────────────────
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

// ── WhatsApp webhook ───────────────────────────────────────
app.get('/api/whatsapp/webhook', whatsapp.verifyWebhook);
app.post('/api/whatsapp/webhook', whatsapp.handleWebhook);
app.post('/api/whatsapp/simulator', whatsapp.handleSimulator);

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

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { generateReference } = require('./lib/reference');
const { sendConfirmation, sendNotification } = require('./lib/email');
const { generatePrototype } = require('./lib/generate');
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
app.get('/:filename.html', async (req, res) => {
  const filename = `${req.params.filename}.html`;
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

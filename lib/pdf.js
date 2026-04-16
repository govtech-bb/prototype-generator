/**
 * Form-spec extraction from uploaded PDFs.
 *
 * Two paths:
 *   1. Fast path — `pdf-parse` reads embedded text directly. Free, instant,
 *      and works for most government forms that come from Word/LibreOffice.
 *   2. Vision path — when the embedded text is empty or too short (i.e. the
 *      PDF is a scanned image), send the raw PDF to Claude's document API.
 *      Claude reads the scan visually (OCR-grade, but also understands form
 *      layout, checkboxes, tables, and handwriting) and returns a clean
 *      text transcription that the downstream generator can consume.
 *
 * The caller doesn't need to know which path ran — both return a plain
 * string that plugs into `generatePrototype(formSpec)` unchanged.
 */

const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');

// Extracted text below this many characters is treated as "no meaningful
// text" — typical scanned PDFs yield a few dozen characters of boilerplate
// (encoded metadata, file producer strings) but nothing substantive.
const TEXT_MIN_LENGTH = 100;

// Vision call uses Sonnet — it has first-class PDF document support, is
// materially cheaper than Opus, and is more than accurate enough for OCR
// and layout understanding of form specifications.
const VISION_MODEL = 'claude-sonnet-4-20250514';
const VISION_MAX_TOKENS = 8192;

// 2-minute ceiling on the vision call. A scanned ~10-page form typically
// comes back in 15–40 s; 2 minutes is comfortable headroom.
const client = new Anthropic({ timeout: 2 * 60 * 1000 });

const VISION_PROMPT = `The attached PDF is a scanned or image-based government form specification.

Read it carefully and produce a clean, plain-text transcription suitable for use as input to a form-digitisation system. Preserve:

- Section headings and groupings
- Every field label, with its required/optional status when visible
- Helper text, examples, and placeholders
- Validation rules, formats, and length limits
- Any checkboxes, radio options, and dropdown choices — list every option you can see
- Signature areas and date fields
- Eligibility criteria, "before you start" notes, and any "what you will need" lists
- Conditional logic (e.g. "If Yes, go to section 4")
- The issuing Ministry, Department, or Agency (MDA) if printed anywhere

Include fields you can partially read — mark uncertain text with [?]. Include structural hints like "Page 2 of 4" or "Section A".

Output plain text only. No markdown fences, no preamble, no commentary. Just the transcription.`;

/**
 * Extract a form-spec text string from an uploaded PDF buffer.
 *
 * @param {Buffer} buffer — raw PDF bytes (from multer memoryStorage)
 * @param {string} [filename] — original filename, used only for log lines
 * @returns {Promise<{ formSpec: string, source: 'text'|'vision', pages: number|null }>}
 * @throws {Error} with a user-friendly message if neither path recovers usable content
 */
async function extractFormSpec(buffer, filename) {
  const label = filename || 'upload.pdf';

  // 1. Fast path — embedded text
  let parsed;
  try {
    parsed = await pdfParse(buffer);
  } catch (err) {
    // A parse failure doesn't kill us — we fall straight through to vision.
    console.warn(`  pdf-parse failed for ${label}: ${err.message}. Falling back to vision.`);
    parsed = null;
  }

  const text = (parsed && parsed.text ? parsed.text : '').trim();
  const pages = parsed && typeof parsed.numpages === 'number' ? parsed.numpages : null;

  if (text.length >= TEXT_MIN_LENGTH) {
    console.log(`  PDF text-extract: ${text.length} chars from ${pages || '?'} page(s)`);
    return { formSpec: text, source: 'text', pages };
  }

  // 2. Vision path — Claude reads the scanned PDF directly
  console.log(`  PDF text-extract yielded ${text.length} chars — switching to Claude vision`);
  const formSpec = await readPdfWithClaude(buffer, label);

  if (!formSpec || formSpec.trim().length < TEXT_MIN_LENGTH) {
    throw new Error(
      'We could not read enough content from this PDF, even after trying a visual read. ' +
      'The file may be blank, corrupted, password-protected, or extremely low-resolution. ' +
      'Please try a clearer scan or use the text description instead.'
    );
  }

  console.log(`  PDF vision-extract: ${formSpec.length} chars`);
  return { formSpec: formSpec.trim(), source: 'vision', pages };
}

/**
 * Send a PDF buffer to Claude as a document content block and return the
 * model's text transcription.
 */
async function readPdfWithClaude(buffer, label) {
  const base64 = buffer.toString('base64');

  const response = await client.messages.create({
    model: VISION_MODEL,
    max_tokens: VISION_MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64,
            },
          },
          {
            type: 'text',
            text: VISION_PROMPT,
          },
        ],
      },
    ],
  });

  const textBlocks = response.content.filter(b => b.type === 'text');
  const text = textBlocks.map(b => b.text).join('\n');

  if (response.stop_reason === 'max_tokens') {
    console.warn(`  Vision read of ${label} hit max_tokens — transcription may be incomplete`);
  }

  return text;
}

module.exports = { extractFormSpec };

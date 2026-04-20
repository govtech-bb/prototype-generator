/**
 * Claude API integration for generating multi-page form prototypes.
 *
 * Claude generates a single definition file containing all page templates.
 * The generator then splits this into separate HTML files — one per form page.
 *
 * If the output is truncated (hits max_tokens), automatically continues
 * the generation and stitches the parts together.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { injectChrome } = require('./template');

const client = new Anthropic({ timeout: 20 * 60 * 1000 }); // 20 min timeout for large generations
const CLAUDE_MD_PATH = path.join(__dirname, '..', 'CLAUDE.md');
const MODEL = 'claude-opus-4-20250514';
const MAX_TOKENS = 32000;
const MAX_CONTINUATIONS = 4;

/**
 * Generate a multi-page HTML prototype from a form specification.
 *
 * Returns an object with { files, formName } where files is an array of
 * { filename, html, pageId } objects.
 *
 * @param {string} formSpec - The form specification text
 * @param {object} [options] - Optional per-request tweaks
 * @param {string} [options.instructions] - User-supplied extra instructions
 *   for this specific service. Appended to the user prompt with clear
 *   precedence rules so Claude treats them as authoritative for points
 *   where they contradict the boilerplate in CLAUDE.md.
 * @returns {Promise<{ files: Array<{filename: string, html: string, pageId: string}>, formName: string }>}
 */
async function generatePrototype(formSpec, options) {
  const systemPrompt = fs.readFileSync(CLAUDE_MD_PATH, 'utf-8');
  const extraInstructions = options && typeof options.instructions === 'string'
    ? options.instructions.trim()
    : '';

  const extraBlock = extraInstructions
    ? `\n\nADDITIONAL INSTRUCTIONS FOR THIS SERVICE (from the requester — these take precedence over the general CLAUDE.md rules where they conflict, but do not break the page skeleton or framework API):\n${extraInstructions}\n`
    : '';

  const userMessage = `Here is the form specification:\n\n${formSpec}${extraBlock}\n\nGenerate a complete, clickable HTML prototype following all the instructions in your system prompt.

CRITICAL: Use the shared external assets — do NOT inline CSS custom properties, Tailwind config, or framework JavaScript. The prototype must:
- Load \`/assets/govbb-tailwind-config.js\` in <head> (after Tailwind CDN)
- Load \`/assets/govbb-base.css\` in <head>
- Load \`/assets/govbb-framework.js\` at the bottom of <body>
- Use the GovBB framework API for all template helpers (GovBB.textField, GovBB.selectField, GovBB.radioGroup, GovBB.dateField, GovBB.backLink, GovBB.caption, GovBB.continueBtn, GovBB.startBtn, GovBB.summaryRow, GovBB.checkboxItem, etc.)
- Store form data in GovBB.D
- Call GovBB.init({ formName, flow, pages, validate, multiPage: true, currentPage, pageFiles }) at the end
- The only form-specific code should be: FORM_NAME, FLOW array, PAGE_FILES map, a single PAGES entry for the current page, and validate function

Generate the prototype as MULTIPLE separate HTML files — one per page in the form flow. Each file is a complete HTML document with the shared chrome (header, footer, alpha banner). Output them in this exact format:

--- FILE: index.html ---
<!DOCTYPE html>
<html>... (start page) ...</html>

--- FILE: name.html ---
<!DOCTYPE html>
<html>... (name page) ...</html>

... and so on for every page in the flow.

Output ONLY the files — no explanation, no markdown fences. Start directly with --- FILE: index.html ---`;

  console.log('  Calling Claude API (streaming)...');
  const startTime = Date.now();

  const messages = [{ role: 'user', content: userMessage }];

  let stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages,
  });

  let response = await stream.finalMessage();
  let htmlParts = [extractText(response)];
  let stopReason = response.stop_reason;
  let callCount = 1;

  const elapsed1 = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Call ${callCount}: ${elapsed1}s (stop_reason: ${stopReason})`);

  // Continue if truncated
  while (stopReason === 'max_tokens' && callCount <= MAX_CONTINUATIONS) {
    callCount++;
    console.log(`  Output truncated — sending continuation request ${callCount}...`);

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: 'Continue generating the HTML files from exactly where you left off. Do not repeat any code already generated. Do not add any explanation — just continue with the next --- FILE: ... --- marker.' });

    stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
    });

    response = await stream.finalMessage();
    htmlParts.push(extractText(response));
    stopReason = response.stop_reason;

    const elapsedN = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  Call ${callCount}: ${elapsedN}s total (stop_reason: ${stopReason})`);
  }

  if (stopReason === 'max_tokens') {
    console.warn(`  ⚠️  Output still truncated after ${callCount} calls`);
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Generation complete: ${callCount} API call(s) in ${totalElapsed}s`);

  // Stitch and parse into separate files
  let fullOutput = htmlParts.join('');
  fullOutput = fullOutput.replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  const files = parseMultiFileOutput(fullOutput);

  if (files.length === 0) {
    // Fallback: treat entire output as a single file (backwards compatibility)
    const injectedHtml = injectChrome(fullOutput);
    const titleMatch = injectedHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
    let formName = 'Generated Form';
    if (titleMatch) formName = titleMatch[1].split(/\s*[–—|]\s*/)[0].trim();
    return {
      files: [{ filename: 'index.html', html: injectedHtml, pageId: 'start' }],
      formName,
    };
  }

  // Inject shared chrome (top bar, header, alpha banner, footer, head resources)
  // for any file that uses placeholder comments. Idempotent — files without
  // placeholders pass through unchanged.
  for (const file of files) {
    file.html = injectChrome(file.html);
  }

  // Extract form name from the first file's <title>
  const firstHtml = files[0].html;
  const titleMatch = firstHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
  let formName = 'Generated Form';
  if (titleMatch) formName = titleMatch[1].split(/\s*[–—|]\s*/)[0].trim();

  return { files, formName };
}

/**
 * Parse Claude's multi-file output into separate files.
 * Expected format: --- FILE: filename.html ---\n<html>...</html>\n
 */
function parseMultiFileOutput(output) {
  const files = [];
  const pattern = /---\s*FILE:\s*(\S+)\s*---\s*\n/gi;
  const markers = [];
  let match;

  while ((match = pattern.exec(output)) !== null) {
    markers.push({ filename: match[1], start: match.index + match[0].length });
  }

  for (let i = 0; i < markers.length; i++) {
    const end = i + 1 < markers.length ? markers[i + 1].start - (output.substring(markers[i].start, markers[i + 1].start).match(/---\s*FILE:/i) || { index: markers[i + 1].start - markers[i].start }).index : output.length;
    // Simpler: content goes from this marker's start to the next marker's header
    let html;
    if (i + 1 < markers.length) {
      // Find the start of the next --- FILE: marker
      const nextMarkerMatch = output.substring(markers[i].start).match(/\n---\s*FILE:\s*\S+\s*---/i);
      html = nextMarkerMatch
        ? output.substring(markers[i].start, markers[i].start + nextMarkerMatch.index).trim()
        : output.substring(markers[i].start).trim();
    } else {
      html = output.substring(markers[i].start).trim();
    }

    // Derive pageId from filename: "name.html" -> "name", "index.html" -> "start"
    let pageId = markers[i].filename.replace(/\.html$/i, '');
    if (pageId === 'index') pageId = 'start';

    files.push({
      filename: markers[i].filename,
      html: html,
      pageId: pageId,
    });
  }

  return files;
}

function extractText(response) {
  return response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
}

module.exports = { generatePrototype };

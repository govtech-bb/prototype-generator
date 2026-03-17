/**
 * Claude API integration for generating form prototypes.
 *
 * Reads CLAUDE.md as the system prompt, sends the form spec/description
 * as the user message, and returns the generated HTML.
 *
 * If the output is truncated (hits max_tokens), automatically continues
 * the generation and stitches the parts together.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ timeout: 15 * 60 * 1000 }); // 15 min timeout for large generations

const CLAUDE_MD_PATH = path.join(__dirname, '..', 'CLAUDE.md');
const MODEL = 'claude-opus-4-20250514';
const MAX_TOKENS = 32000;
const MAX_CONTINUATIONS = 4; // up to 5 total calls (1 initial + 4 continuations)

/**
 * Generate a clickable HTML prototype from a form specification or description.
 *
 * @param {string} formSpec - The form specification text (from PDF extraction or user input)
 * @returns {Promise<{ html: string, formName: string }>}
 */
async function generatePrototype(formSpec) {
  const systemPrompt = fs.readFileSync(CLAUDE_MD_PATH, 'utf-8');

  const userMessage = `Here is the form specification:\n\n${formSpec}\n\nGenerate a complete, clickable HTML prototype following all the instructions in your system prompt.

CRITICAL: Use the shared external assets — do NOT inline CSS custom properties, Tailwind config, or framework JavaScript. The prototype must:
- Load \`/assets/govbb-tailwind-config.js\` in <head> (after Tailwind CDN)
- Load \`/assets/govbb-base.css\` in <head>
- Load \`/assets/govbb-framework.js\` at the bottom of <body>
- Use the GovBB framework API for all template helpers (GovBB.textField, GovBB.selectField, GovBB.radioGroup, GovBB.dateField, GovBB.backLink, GovBB.caption, GovBB.continueBtn, GovBB.startBtn, GovBB.summaryRow, GovBB.checkboxItem, etc.)
- Store form data in GovBB.D
- Call GovBB.init({ formName, flow, pages, validate }) at the end
- The only form-specific code should be: FORM_NAME, FLOW array, PAGES object (with template functions), and validate function

The prototype must include all pages (start, question pages, check your answers, confirmation) and full client-side validation. Form submission is handled automatically by the framework. Output ONLY the HTML — no explanation, no markdown fences, just the raw HTML starting with <!DOCTYPE html>.`;

  console.log('  Calling Claude API (streaming)...');
  const startTime = Date.now();

  // Build initial messages
  const messages = [{ role: 'user', content: userMessage }];

  // First call
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

    // Add the assistant's partial response and a continuation prompt
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: 'Continue generating the HTML from exactly where you left off. Do not repeat any code already generated. Do not add any explanation — just continue the raw HTML.' });

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

  // Stitch all parts together
  let html = htmlParts.join('');

  // Strip markdown code fences if present
  html = html.replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  // Extract form name from <title> tag
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  let formName = 'Generated Form';
  if (titleMatch) {
    formName = titleMatch[1].split(/\s*[–—|]\s*/)[0].trim();
  }

  return { html, formName };
}

/**
 * Extract text content from a Claude API response.
 */
function extractText(response) {
  return response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
}

module.exports = { generatePrototype };

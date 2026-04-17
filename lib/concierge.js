/**
 * Concierge "front door" chat — Claude inference.
 *
 * Routes citizen intents to:
 *   (a) DIGITISED services (online forms in S3), or
 *   (b) INFO services (markdown content from alpha.gov.bb), or
 *   (c) NO MATCH (nothing in either catalogue).
 *
 * For info services the bot also answers bounded follow-up questions —
 * "what's the fee for a child under 16?" — grounded STRUCTURALLY (not by
 * prose rule) via the `answer_from_content` tool, which requires a
 * verbatim `quote` the server validates against the service's markdown
 * body. Hallucinated fees / eligibility / documents are physically
 * impossible for that code path.
 *
 * Two-pass retrieval to keep prompt size (and cost) bounded:
 *   - Turn 1: system prompt has catalogue METADATA only. Model picks a
 *     service via `recommend_services`.
 *   - Turn 2+: system prompt gains the FULL markdown body of services the
 *     citizen has actively asked about (up to 3, FIFO-evicted) so the
 *     model can answer follow-ups from source content.
 *
 * Prompt caching is enabled on the stable catalogue block. Active bodies
 * live in a separate block AFTER the cache breakpoint so they don't
 * invalidate the cache on every turn.
 *
 * Four tools:
 *   - recommend_services({ digitised: [{folder, reason}], info: [{slug, reason}] })
 *   - answer_from_content({ service_slug, answer, quote })
 *   - defer_to_guide({ service_slug, reason })
 *   - no_match({ suggestion })
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getCatalogue } = require('./catalogue');
const infoCatalogue = require('./info-catalogue');

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 2048;
const MAX_TOOL_ITERATIONS = 4;
const MAX_ACTIVE_BODIES = 3;

const client = new Anthropic({ timeout: 60 * 1000 });

/* ── Tools ───────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: 'recommend_services',
    description:
      'Recommend one or more services that match what the citizen needs. Services come in two kinds: "digitised" (online forms you can fill in now) and "info" (guidance pages — the service is not online yet but we have information about it). Use folder values from DIGITISED CATALOGUE and slug values from INFO CATALOGUE — NEVER invent one. Each item needs a short one-sentence reason written for a citizen. Prefer digitised matches when both a digitised and info service cover the same need. At least one item across the two arrays is required.',
    input_schema: {
      type: 'object',
      properties: {
        digitised: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              folder: { type: 'string', description: 'The exact "folder" from DIGITISED CATALOGUE.' },
              reason: { type: 'string', description: 'One plain-language sentence explaining the match.' },
            },
            required: ['folder', 'reason'],
          },
        },
        info: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string', description: 'The exact "slug" from INFO CATALOGUE.' },
              reason: { type: 'string', description: 'One plain-language sentence explaining the match.' },
            },
            required: ['slug', 'reason'],
          },
        },
      },
    },
  },
  {
    name: 'answer_from_content',
    description:
      'Answer a specific factual question about an INFO service (fees, eligibility, documents, process). Provide both the plain-language `answer` the citizen will see AND a `quote` — a SHORT verbatim substring (2-30 words) of the service\'s markdown body that supports your answer. The server validates that `quote` appears in the source content; if it does not, your answer is rejected. Never estimate, infer, or extrapolate — if the exact detail isn\'t in the content, call `defer_to_guide` instead.',
    input_schema: {
      type: 'object',
      properties: {
        service_slug: { type: 'string', description: 'The slug of the info service the question is about.' },
        answer: { type: 'string', description: 'The plain-language answer for the citizen.' },
        quote: { type: 'string', description: 'A SHORT verbatim substring from the service content that backs up the answer.' },
      },
      required: ['service_slug', 'answer', 'quote'],
    },
  },
  {
    name: 'defer_to_guide',
    description:
      'Use when the citizen asks something about an INFO service that the provided content does not directly answer. The citizen will be shown a brief deferral with a link to the full guide on alpha.gov.bb. Never guess; never extrapolate; never offer a fallback fee or age. Defer cleanly.',
    input_schema: {
      type: 'object',
      properties: {
        service_slug: { type: 'string', description: 'The slug of the info service the question is about.' },
        reason: { type: 'string', description: 'One short sentence on what was asked that the content doesn\'t cover — stays on server logs, not shown verbatim to the citizen.' },
      },
      required: ['service_slug', 'reason'],
    },
  },
  {
    name: 'no_match',
    description:
      'Use when nothing in either catalogue fits. Suggestion is a brief plain-language message to the citizen (e.g. "That service isn\'t available online yet — you\'ll need to visit X in person.").',
    input_schema: {
      type: 'object',
      properties: {
        suggestion: { type: 'string', description: 'Short plain-language message for the citizen.' },
      },
      required: ['suggestion'],
    },
  },
];

/* ── System prompt builder ───────────────────────────────────── */

/**
 * Build the system prompt as an array of 2 text blocks:
 *   [0] — base rules + both catalogues (metadata only). Marked CACHED.
 *   [1] — full markdown body for services the citizen has actively asked
 *         about this session (at most MAX_ACTIVE_BODIES). Volatile —
 *         NOT cached. Only included when activeBodies is non-empty.
 *
 * The cache breakpoint sits between the two blocks, so subsequent turns
 * in the same 5-minute window read the catalogue portion from cache
 * (~10% of normal input pricing).
 */
function buildSystemPrompt(digitisedRecords, infoRecords, activeBodies) {
  const base = buildBase(digitisedRecords, infoRecords);
  const blocks = [
    { type: 'text', text: base, cache_control: { type: 'ephemeral' } },
  ];
  if (activeBodies && activeBodies.length) {
    blocks.push({ type: 'text', text: buildActiveBodiesBlock(activeBodies) });
  }
  return blocks;
}

function buildBase(digitisedRecords, infoRecords) {
  const digitisedJson = JSON.stringify(
    digitisedRecords.map(r => {
      const entry = { folder: r.folder, name: r.formName };
      if (r.mda) entry.agency = r.mda;
      if (r.h1) entry.heading = r.h1;
      if (r.intro) entry.about = r.intro;
      if (r.whatYouNeed && r.whatYouNeed.length) entry.whatYouNeed = r.whatYouNeed;
      if (r.guideUrl) entry.fullGuideOn = r.guideUrl;
      return entry;
    }),
    null, 2
  );

  const infoJson = JSON.stringify(
    infoRecords.map(r => {
      const entry = { slug: r.slug, title: r.title };
      if (r.section) entry.section = r.section;
      if (r.description) entry.description = r.description;
      if (r.publishDate) entry.publishDate = r.publishDate;
      if (r.headings && r.headings.length) entry.sections = r.headings;
      return entry;
    }),
    null, 2
  );

  return `You are the Government of Barbados services assistant. Your job is to help citizens find the right government service — digitised or not — and answer grounded follow-up questions about the services we have content for.

TONE
- Plain language a nine-year-old could understand.
- Short sentences. One idea per sentence.
- "You" and "your", not "the applicant".
- "Tell us" not "provide", "send" not "submit", "choose" not "select".
- Warm and direct. Never bureaucratic.

WHAT YOU CAN DO
- Match a citizen's need to a service by calling recommend_services.
- Answer factual questions about an info service ONLY via answer_from_content (with a verbatim quote).
- Defer to the full alpha.gov.bb guide via defer_to_guide if the content doesn't cover the question.
- Say no_match when nothing fits.

RULES — GROUNDING
- NEVER state a fee, age, document requirement, office name, or processing time that isn't in the catalogue content you can see. Your memory is not a source. Use answer_from_content, and if the specific detail isn't in the content, call defer_to_guide instead.
- NEVER estimate, infer, or extrapolate a value (e.g. a "child under 10" fee when the table only shows "under 16"). Defer cleanly.
- NEVER mix digitised routing and answer_from_content in the same turn — answer ONE question or do ONE routing per turn.
- Prefer digitised services over info services when both match. A digitised form lets the citizen complete the application right now; info is a read-only guide.

RULES — SHAPE
- On the first turn, greet briefly and give two or three short one-line examples of what you can help with, drawn from the catalogues.
- If intent is ambiguous, ask ONE clarifying question BEFORE routing.
- When confident, call ONE tool: recommend_services (digitised, info, or both), answer_from_content, defer_to_guide, or no_match.
- After the tool call, add a short plain-text reply (one or two sentences) — this is what the citizen reads in the chat bubble.
- If the publishDate on an info service is older than 12 months, add a trailing sentence: "This information may have changed — the full guide has the latest."

DIGITISED CATALOGUE (${digitisedRecords.length} online ${digitisedRecords.length === 1 ? 'form' : 'forms'})
${digitisedJson}

INFO CATALOGUE (${infoRecords.length} info ${infoRecords.length === 1 ? 'guide' : 'guides'})
${infoJson}`;
}

function buildActiveBodiesBlock(activeBodies) {
  // activeBodies is [{slug, title, body}, ...]
  const sections = activeBodies.map(b =>
    `=== ${b.slug} — ${b.title} ===\n${b.body}`
  ).join('\n\n---\n\n');

  return `ACTIVE SERVICE CONTENT

The following is the FULL verbatim markdown for services the citizen has asked about in this conversation. Use this as the source of truth when answering questions via answer_from_content — your \`quote\` MUST be a short verbatim substring of one of these bodies.

${sections}`;
}

/* ── Overlap reconciliation ──────────────────────────────────── */

/**
 * When a digitised folder exactly matches an info-catalogue slug, we:
 *   - annotate the ServiceRecord with `guideUrl: alphaUrl`, so the card
 *     can show a "see the full guide" link alongside the online form.
 *   - remove the InfoRecord from the info catalogue so the model is
 *     never offered both paths for the same service.
 *
 * Exact slug equality only — fuzzy matching would silently hide info
 * services, which is worse than a rare duplicate.
 */
function reconcile(digitisedRecords, infoRecords) {
  const folderSet = new Set(digitisedRecords.map(r => r.folder));
  const infoBySlug = new Map(infoRecords.map(r => [r.slug, r]));

  const reconciledDigitised = digitisedRecords.map(r => {
    const info = infoBySlug.get(r.folder);
    if (info) return { ...r, guideUrl: info.alphaUrl };
    return r;
  });

  const reconciledInfo = infoRecords.filter(r => !folderSet.has(r.slug));

  return { digitised: reconciledDigitised, info: reconciledInfo };
}

/* ── Conversation store ──────────────────────────────────────── */

const conversations = new Map();
const CONVERSATION_TTL = 60 * 60 * 1000;

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function cleanupConversations() {
  const now = Date.now();
  for (const [id, conv] of conversations) {
    if (now - conv.createdAt > CONVERSATION_TTL) {
      conversations.delete(id);
    }
  }
}
setInterval(cleanupConversations, 10 * 60 * 1000);

function rememberActiveSlug(conv, slug) {
  if (!slug) return;
  conv.activeInfoSlugs.delete(slug);          // move-to-front if present
  conv.activeInfoSlugs.add(slug);
  while (conv.activeInfoSlugs.size > MAX_ACTIVE_BODIES) {
    const oldest = conv.activeInfoSlugs.values().next().value;
    conv.activeInfoSlugs.delete(oldest);
  }
}

/* ── Quote verification (the structural grounding primitive) ──── */

function verifyQuote(body, quote) {
  if (!body || !quote) return false;
  if (body.includes(quote)) return true;
  // Whitespace-tolerant fallback — collapse runs of whitespace on both
  // sides. Case stays sensitive (monetary values, proper nouns).
  const ws = s => s.replace(/\s+/g, ' ').trim();
  return ws(body).includes(ws(quote));
}

/* ── Main handler ────────────────────────────────────────────── */

/**
 * Handle a concierge turn.
 *
 * @param {Object} params
 * @param {string} [params.conversationId]
 * @param {string} [params.message]
 * @returns {Promise<{
 *   conversationId: string,
 *   reply: string,
 *   recommendations: Array,
 *   answered: { slug, title, alphaUrl, answer, quote } | null,
 *   deferred: { slug, title, alphaUrl } | null,
 *   noMatch: string | null,
 * }>}
 */
async function concierge({ conversationId, message }) {
  // Load both catalogues fresh each turn (the modules handle their own
  // caching). info-catalogue may be empty if GitHub is unreachable —
  // fail-open, the digitised half still works.
  const [rawDigitised, rawInfo] = await Promise.all([
    getCatalogue(),
    infoCatalogue.getInfoCatalogue().catch(err => {
      console.warn(`  concierge: info catalogue unavailable — ${err.message}`);
      return [];
    }),
  ]);

  const { digitised, info } = reconcile(rawDigitised, rawInfo);
  const digitisedByFolder = new Map(digitised.map(r => [r.folder, r]));
  const infoBySlug = new Map(info.map(r => [r.slug, r]));

  // Load or start the conversation.
  let conv;
  if (conversationId && conversations.has(conversationId)) {
    conv = conversations.get(conversationId);
  } else {
    conversationId = generateId();
    conv = {
      messages: [],
      activeInfoSlugs: new Set(),  // Set preserves insertion order
      createdAt: Date.now(),
    };
    conversations.set(conversationId, conv);
  }

  // Seed user message
  const userText = typeof message === 'string' ? message.trim() : '';
  if (userText) {
    conv.messages.push({ role: 'user', content: userText });
  } else if (conv.messages.length === 0) {
    conv.messages.push({ role: 'user', content: 'Hi, I need some help finding a government service.' });
  }

  // Active info bodies for this turn (cap MAX_ACTIVE_BODIES, FIFO)
  const activeBodies = [];
  for (const slug of conv.activeInfoSlugs) {
    const rec = infoBySlug.get(slug);
    if (rec && rec.body) activeBodies.push({ slug, title: rec.title, body: rec.body });
  }

  const system = buildSystemPrompt(digitised, info, activeBodies);

  let response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    tools: TOOLS,
    messages: conv.messages,
  });
  logCacheUsage(response, conversationId);

  // ── Tool-use loop ─────────────────────────────────────────────
  const recommendations = [];
  let answered = null;
  let deferred = null;
  let noMatch = null;
  let iterations = 0;

  while (response.stop_reason === 'tool_use' && iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const toolUse of toolUses) {
      if (toolUse.name === 'recommend_services') {
        const input = toolUse.input || {};
        const digReqs = Array.isArray(input.digitised) ? input.digitised : [];
        const infoReqs = Array.isArray(input.info) ? input.info : [];

        const unknownFolders = [];
        const unknownSlugs = [];
        for (const s of digReqs) {
          const rec = digitisedByFolder.get(s && s.folder);
          if (rec) recommendations.push({ kind: 'online-form', ...rec, reason: (s.reason || '').trim() });
          else if (s && s.folder) unknownFolders.push(s.folder);
        }
        for (const s of infoReqs) {
          const rec = infoBySlug.get(s && s.slug);
          if (rec) {
            recommendations.push({
              kind: 'info-only',
              slug: rec.slug,
              title: rec.title,
              description: rec.description,
              section: rec.section,
              publishDate: rec.publishDate,
              alphaUrl: rec.alphaUrl,
              sourceUrl: rec.sourceUrl,
              fees: rec.fees,
              headings: rec.headings,
              body: rec.body,
              reason: (s.reason || '').trim(),
            });
            rememberActiveSlug(conv, rec.slug);
          } else if (s && s.slug) {
            unknownSlugs.push(s.slug);
          }
        }

        if (recommendations.length === 0) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: (unknownFolders.length || unknownSlugs.length)
              ? `None of your recommendations resolved. Unknown folders: ${unknownFolders.join(', ') || '(none)'}. Unknown slugs: ${unknownSlugs.join(', ') || '(none)'}. Check the catalogue IDs and try again, or call no_match.`
              : 'You called recommend_services with no services. Call no_match if nothing fits, or recommend at least one real service.',
            is_error: true,
          });
        } else {
          const parts = [];
          if (recommendations.length) parts.push(`Accepted: ${recommendations.map(r => r.kind === 'online-form' ? r.folder : r.slug).join(', ')}.`);
          if (unknownFolders.length) parts.push(`Ignored unknown folders: ${unknownFolders.join(', ')}.`);
          if (unknownSlugs.length) parts.push(`Ignored unknown slugs: ${unknownSlugs.join(', ')}.`);
          parts.push('Write a short one- or two-sentence reply to the citizen.');
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: parts.join(' '),
          });
        }
      } else if (toolUse.name === 'answer_from_content') {
        const input = toolUse.input || {};
        const slug = input.service_slug;
        const answer = (input.answer || '').trim();
        const quote = (input.quote || '').trim();
        const rec = slug ? infoBySlug.get(slug) : null;

        if (!rec) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Unknown service_slug: ${JSON.stringify(slug)}. Use a slug that's in INFO CATALOGUE.`,
            is_error: true,
          });
        } else if (!answer || !quote) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Both `answer` and `quote` are required.',
            is_error: true,
          });
        } else if (!verifyQuote(rec.body, quote)) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Your quote is not a verbatim substring of the content for ${slug}. Pick a shorter quote that appears EXACTLY in the provided body (whitespace-collapsed match is allowed), or call defer_to_guide.`,
            is_error: true,
          });
        } else {
          answered = {
            slug: rec.slug,
            title: rec.title,
            alphaUrl: rec.alphaUrl,
            answer,
            quote,
          };
          rememberActiveSlug(conv, rec.slug);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Answer recorded with source quote. Write a very short plain-text reply — the citizen will also see the quote as a citation below your answer.',
          });
        }
      } else if (toolUse.name === 'defer_to_guide') {
        const input = toolUse.input || {};
        const slug = input.service_slug;
        const rec = slug ? infoBySlug.get(slug) : null;
        if (!rec) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Unknown service_slug: ${JSON.stringify(slug)}. Use a slug that's in INFO CATALOGUE.`,
            is_error: true,
          });
        } else {
          deferred = { slug: rec.slug, title: rec.title, alphaUrl: rec.alphaUrl };
          rememberActiveSlug(conv, rec.slug);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Deferral recorded. Write a short plain-text message to the citizen that says you don\'t have that detail and the full guide has the current answer.',
          });
        }
      } else if (toolUse.name === 'no_match') {
        noMatch = (toolUse.input && toolUse.input.suggestion) || '';
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: 'Acknowledged. Write a short plain-text reply to the citizen.',
        });
      } else {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Unknown tool "${toolUse.name}". Available: recommend_services, answer_from_content, defer_to_guide, no_match.`,
          is_error: true,
        });
      }
    }

    conv.messages.push({ role: 'assistant', content: response.content });
    conv.messages.push({ role: 'user', content: toolResults });

    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: TOOLS,
      messages: conv.messages,
    });
    logCacheUsage(response, conversationId);
  }

  // Hit the cap — produce something safe
  if (response.stop_reason === 'tool_use') {
    conv.messages.push({ role: 'assistant', content: response.content });
    conv.messages.push({
      role: 'user',
      content: 'You\'ve hit the tool-iteration limit. Stop calling tools and write a short plain-text reply acknowledging you couldn\'t fully resolve the request.',
    });
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: conv.messages,
    });
    logCacheUsage(response, conversationId);
  }

  conv.messages.push({ role: 'assistant', content: response.content });
  const textBlocks = response.content.filter(b => b.type === 'text');
  let reply = textBlocks.map(b => b.text).join('\n').trim();
  if (!reply) {
    if (answered) reply = answered.answer;
    else if (deferred) reply = 'I don\'t have that specific detail — the full guide on alpha.gov.bb has the most current information.';
    else if (recommendations.length) reply = 'Here is what I found for you.';
    else if (noMatch) reply = noMatch;
    else reply = 'Could you tell me a bit more about what you need?';
  }

  return {
    conversationId,
    reply,
    recommendations,
    answered,
    deferred,
    noMatch,
  };
}

function logCacheUsage(response, conversationId) {
  const u = response && response.usage;
  if (!u) return;
  const created = u.cache_creation_input_tokens || 0;
  const read = u.cache_read_input_tokens || 0;
  if (created || read) {
    console.log(`  concierge[${conversationId}] cache: created=${created} read=${read} uncached=${u.input_tokens}`);
  }
}

module.exports = { concierge, reconcile };

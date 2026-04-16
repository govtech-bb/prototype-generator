/**
 * Concierge "front door" chat — Claude inference.
 *
 * The concierge matches free-text citizen intents to digitised government
 * services. It is deliberately separate from `lib/chat.js` (which drives
 * in-form question-answering) because the contracts differ:
 *
 *   - lib/chat.js has a single form in context; stores collected form data;
 *     submits the application at the end.
 *   - lib/concierge.js has NO form in context; stores nothing structured;
 *     its only output is a list of service recommendations or a "no match".
 *
 * The Claude model uses two tools:
 *   - `recommend_services({ services: [{ folder, reason }, ...] })`
 *   - `no_match({ suggestion })`
 *
 * The tool-use loop mirrors the one in lib/chat.js but with three defences:
 *   1. Iterates every tool_use block in a turn (the model may emit both).
 *   2. Filters out folder values that don't resolve against the live
 *      catalogue (prevents hallucinated recommendations reaching the UI).
 *   3. Treats `recommend_services` with an empty array as `no_match`.
 * Loop iterations are capped at 3.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getCatalogue } = require('./catalogue');

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 1024;
const MAX_TOOL_ITERATIONS = 3;

const client = new Anthropic({ timeout: 60 * 1000 });

/* ── Tools ───────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: 'recommend_services',
    description:
      'Recommend one to three digitised services that match what the citizen needs. Use ONLY folder values from the SERVICES CATALOGUE in the system prompt — never invent one. Each item must include a short plain-language reason (one sentence).',
    input_schema: {
      type: 'object',
      properties: {
        services: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              folder: {
                type: 'string',
                description: 'The exact "folder" identifier of the service from the catalogue.',
              },
              reason: {
                type: 'string',
                description: 'One short plain sentence explaining why this service matches. Written for a citizen.',
              },
            },
            required: ['folder', 'reason'],
          },
        },
      },
      required: ['services'],
    },
  },
  {
    name: 'no_match',
    description:
      'Call this when no digitised service in the catalogue matches the citizen\'s need. Provide a brief plain-language suggestion — for example, point them to the relevant agency or say the service is not yet online.',
    input_schema: {
      type: 'object',
      properties: {
        suggestion: {
          type: 'string',
          description: 'A short plain-language message to show the citizen.',
        },
      },
      required: ['suggestion'],
    },
  },
];

/* ── System prompt ───────────────────────────────────────────── */

function buildSystemPrompt(records) {
  const cataloguePayload = records.map(r => {
    const entry = {
      folder: r.folder,
      name: r.formName,
    };
    if (r.mda) entry.agency = r.mda;
    if (r.h1) entry.heading = r.h1;
    if (r.intro) entry.about = r.intro;
    if (r.whatYouNeed && r.whatYouNeed.length) entry.whatYouNeed = r.whatYouNeed;
    return entry;
  });

  const catalogueJson = JSON.stringify(cataloguePayload, null, 2);

  return `You are the Government of Barbados services assistant. Your only job is to understand what a citizen needs and point them to the right digitised government service.

TONE
- Write in plain, simple language a nine-year-old could understand.
- Short sentences. One idea per sentence.
- Say "you" and "your", not "the applicant".
- Say "tell us" not "provide", "send" not "submit", "choose" not "select".
- Be warm and direct. Never bureaucratic.

BEHAVIOUR
- If this is the first message and the citizen has not yet said what they need, greet them briefly and ask what you can help them with. Give two or three one-line examples drawn from the catalogue below.
- Otherwise, read the citizen's message and decide:
  * If it is too vague to route with confidence (e.g. "something about my car" when several car-related services exist), ask ONE short clarifying question. Do not recommend yet.
  * If you are confident, call the \`recommend_services\` tool with one to three items. One match is usually better than three.
  * If nothing in the catalogue fits, call the \`no_match\` tool with a short suggestion (e.g. "That service isn't online yet — you'll need to visit the Licensing Authority in person.").
- After you call a tool, add a very short plain-text reply confirming what you found or why nothing fit. Keep it to one or two sentences.
- Never invent a service. Only recommend services whose \`folder\` appears in the catalogue below.
- Never ask for personal details (names, ID numbers, addresses). Routing only.

SERVICES CATALOGUE (${records.length} digitised ${records.length === 1 ? 'service' : 'services'})
${catalogueJson}`;
}

/* ── Conversation store ──────────────────────────────────────── */

const conversations = new Map();
const CONVERSATION_TTL = 60 * 60 * 1000; // 1 hour

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

/* ── Main handler ────────────────────────────────────────────── */

/**
 * Handle a concierge turn.
 *
 * @param {Object} params
 * @param {string} [params.conversationId] — null/undefined for first message
 * @param {string} [params.message]        — null/undefined to have the bot open
 * @returns {Promise<{
 *   conversationId: string,
 *   reply: string,
 *   recommendations: Array<ServiceRecord & { reason: string }>,
 *   noMatch: string | null,
 * }>}
 */
async function concierge({ conversationId, message }) {
  // Always fetch the catalogue fresh (the module itself handles caching).
  const records = await getCatalogue();
  const byFolder = new Map(records.map(r => [r.folder, r]));

  let conv;
  if (conversationId && conversations.has(conversationId)) {
    conv = conversations.get(conversationId);
    // Rebuild the system prompt each turn so a newly digitised service
    // becomes routable immediately without ending the conversation.
    conv.systemPrompt = buildSystemPrompt(records);
  } else {
    conversationId = generateId();
    conv = {
      systemPrompt: buildSystemPrompt(records),
      messages: [],
      createdAt: Date.now(),
    };
    conversations.set(conversationId, conv);
  }

  // Seed user message. On the very first turn with no message, fake a
  // greeting so the API has at least one user message to respond to.
  const userText = typeof message === 'string' ? message.trim() : '';
  if (userText) {
    conv.messages.push({ role: 'user', content: userText });
  } else if (conv.messages.length === 0) {
    conv.messages.push({ role: 'user', content: 'Hi, I need some help finding a government service.' });
  }

  let response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: conv.systemPrompt,
    tools: TOOLS,
    messages: conv.messages,
  });

  const recommendations = [];
  let noMatch = null;
  let iterations = 0;

  while (response.stop_reason === 'tool_use' && iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const toolUse of toolUses) {
      if (toolUse.name === 'recommend_services') {
        const services = Array.isArray(toolUse.input && toolUse.input.services)
          ? toolUse.input.services
          : [];

        const resolved = [];
        const unknown = [];
        for (const s of services) {
          const folder = s && s.folder;
          const record = byFolder.get(folder);
          if (record) {
            resolved.push({ ...record, reason: (s.reason || '').trim() });
          } else if (folder) {
            unknown.push(folder);
          }
        }

        if (resolved.length === 0) {
          // Empty or all-hallucinated → tell the model and let it try again
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: unknown.length
              ? `None of the folders you listed (${unknown.join(', ')}) exist in the catalogue. Check the SERVICES CATALOGUE and either call recommend_services with a real folder, or call no_match.`
              : 'You called recommend_services with no services. Call no_match instead if nothing fits, or recommend at least one service from the catalogue.',
            is_error: true,
          });
        } else {
          for (const r of resolved) recommendations.push(r);
          const summary = resolved.map(r => `${r.folder} (${r.formName})`).join(', ');
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: unknown.length
              ? `Accepted: ${summary}. Ignored unknown folders: ${unknown.join(', ')}. Now write a one-sentence reply to the citizen.`
              : `Accepted: ${summary}. Now write a one-sentence reply to the citizen.`,
          });
        }
      } else if (toolUse.name === 'no_match') {
        noMatch = (toolUse.input && toolUse.input.suggestion) || '';
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: 'Acknowledged. Now write a one-sentence reply to the citizen.',
        });
      } else {
        // Unknown tool — ignore but respond to avoid a stalled turn
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Unknown tool "${toolUse.name}". Only recommend_services and no_match are available.`,
          is_error: true,
        });
      }
    }

    conv.messages.push({ role: 'assistant', content: response.content });
    conv.messages.push({ role: 'user', content: toolResults });

    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: conv.systemPrompt,
      tools: TOOLS,
      messages: conv.messages,
    });
  }

  // Hit the iteration cap without landing on a text turn
  if (response.stop_reason === 'tool_use') {
    conv.messages.push({ role: 'assistant', content: response.content });
    const fallback = 'Sorry, I am having trouble finding the right service. Could you tell me in a different way what you need help with?';
    conv.messages.push({ role: 'user', content: fallback });
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: conv.systemPrompt,
      tools: TOOLS,
      messages: conv.messages,
    });
  }

  conv.messages.push({ role: 'assistant', content: response.content });
  const textBlocks = response.content.filter(b => b.type === 'text');
  const reply = textBlocks.map(b => b.text).join('\n').trim() || (
    recommendations.length
      ? 'Here is what I found for you.'
      : noMatch
        ? noMatch
        : 'Could you tell me a bit more about what you need?'
  );

  // If no_match was set but we also have recommendations, prefer the
  // recommendations. If recommendations is empty and no_match is still
  // null, leave both empty — the reply text carries the conversation.
  if (recommendations.length > 0) noMatch = null;

  return {
    conversationId,
    reply,
    recommendations,
    noMatch,
  };
}

module.exports = { concierge };

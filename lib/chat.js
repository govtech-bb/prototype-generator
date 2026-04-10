/**
 * Claude-powered conversational form assistant.
 *
 * Uses Claude with tool calling to collect form data through natural conversation.
 * The chat handler is stateless per request — conversation state is managed server-side
 * via an in-memory store keyed by conversationId.
 */

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ timeout: 60 * 1000 });
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 1024;

/* ═══════════════════════════════════════════════
   Tool definitions
   ═══════════════════════════════════════════════ */

const TOOLS = [
  {
    name: 'save_fields',
    description: 'Save one or more form field values that the user has provided. Call this whenever the user gives information that corresponds to a form field. Use the exact field IDs from the form code.',
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field_id: { type: 'string', description: 'The form field ID (e.g. "first-name", "dob-day", "parish")' },
              value: { type: 'string', description: 'The value to save' },
            },
            required: ['field_id', 'value'],
          },
        },
      },
      required: ['fields'],
    },
  },
  {
    name: 'complete_form',
    description: 'Submit the completed form. Only call this after ALL required fields have been collected and the user has explicitly confirmed their answers are correct.',
    input_schema: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: 'Whether the user confirmed their answers' },
      },
      required: ['confirmed'],
    },
  },
];

/* ═══════════════════════════════════════════════
   System prompt builder
   ═══════════════════════════════════════════════ */

function buildSystemPrompt(formName, formScript) {
  return `You are a friendly, helpful assistant for the Government of Barbados. You are helping a citizen complete the "${formName}" form through a conversational chat interface.

## PROCESS — follow this order:

STEP 1: Greet the user warmly. Briefly explain what form you will help them complete and what information you will need from them.

STEP 2: Work through the form fields in a logical order. Start with personal details:
  - Full name (first name, middle name if any, last name)
  - Date of birth (day, month, year)
  - Gender (if required by the form)
  - Email address
  - Mobile phone number
  - Address (street address, parish, postal code)

STEP 3: If the form involves vehicle details, ask for each one:
  - Licence plate number
  - Vehicle make, model, year, colour
  - Engine number, chassis number (if required)
  - Registered owner name

STEP 4: If the form involves business/company details, ask for each one:
  - Company Registration Number
  - Business name, type, status
  - Date of incorporation
  - Registered address
  - TIN, NIS number (if required)
  - Directors

STEP 5: Ask for any additional form-specific fields (check the form code below to see what fields are needed — e.g. marital status, reason for application, declaration consent).

STEP 6: When ALL fields are collected, show a clear summary of everything and ask the user to confirm all details are correct.

STEP 7: When confirmed, call complete_form.

## RULES:

- Ask for details directly from the user — one question at a time.
- When the user provides data, your VERY NEXT action must be to call save_fields with the correct field IDs. Do not respond with text first.
- Use the exact field IDs from the form code when calling save_fields.
- Group closely related fields together (e.g. first name + last name in one question, or email + phone).
- For Barbados parishes: Christ Church, St. Andrew, St. George, St. James, St. John, St. Joseph, St. Lucy, St. Michael, St. Peter, St. Philip, St. Thomas.
- Postal code format: BB followed by 5 digits (e.g. BB11000).
- Date format: day, month, year (e.g. 15, 03, 1987).
- National Registration Number format: YYMMDD-XXXX (e.g. 870315-1234).

## Style rules:
- Be warm and professional. Use "you" and "your".
- Keep responses SHORT — 1-3 sentences per message.
- Use plain, simple language a 9-year-old can understand.
- Ask one question at a time (or a small group of closely related fields).
- Do NOT use markdown formatting (no **, no ##, no bullets with - or *). Use plain numbered lists if needed.

## Form code reference

The form code below shows what fields this form collects. Use the field IDs from this code when calling save_fields.

\`\`\`javascript
${formScript}
\`\`\``;
}

/* ═══════════════════════════════════════════════
   In-memory conversation store
   ═══════════════════════════════════════════════ */

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

// Run cleanup every 10 minutes
setInterval(cleanupConversations, 10 * 60 * 1000);

/* ═══════════════════════════════════════════════
   Chat handler
   ═══════════════════════════════════════════════ */

/**
 * Process a chat message.
 *
 * @param {Object} params
 * @param {string} [params.conversationId] — null for first message
 * @param {string} [params.formName] — required for first message
 * @param {string} [params.formScript] — required for first message
 * @param {string} [params.message] — null for first message (bot initiates)
 * @returns {Promise<{conversationId, reply, fields, formData, complete}>}
 */
async function chat({ conversationId, formName, formScript, message }) {
  let conv;

  if (conversationId && conversations.has(conversationId)) {
    // Existing conversation
    conv = conversations.get(conversationId);
  } else {
    // New conversation
    conversationId = generateId();
    conv = {
      formName: formName,
      formScript: formScript,
      systemPrompt: buildSystemPrompt(formName, formScript),
      messages: [],
      formData: {},
      createdAt: Date.now(),
    };
    conversations.set(conversationId, conv);
  }

  // Add user message (if provided — null on first call to let bot initiate)
  if (message) {
    conv.messages.push({ role: 'user', content: message });
  } else if (conv.messages.length === 0) {
    // First call with no message — seed with a greeting so the API has at least one message
    conv.messages.push({ role: 'user', content: 'Hi, I would like to complete this form.' });
  }

  // Call Claude
  let response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: conv.systemPrompt,
    tools: TOOLS,
    messages: conv.messages,
  });

  const collectedFields = {};
  let isComplete = false;

  // Process tool calls in a loop until we get a text response
  while (response.stop_reason === 'tool_use') {
    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const toolUse of toolUses) {
      if (toolUse.name === 'save_fields') {
        for (const field of toolUse.input.fields) {
          collectedFields[field.field_id] = field.value;
          conv.formData[field.field_id] = field.value;
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Saved: ${toolUse.input.fields.map(f => f.field_id).join(', ')}`,
        });
      } else if (toolUse.name === 'complete_form') {
        isComplete = toolUse.input.confirmed === true;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: isComplete ? 'Form marked as complete.' : 'User has not confirmed yet.',
        });
      }
    }

    // Add assistant response + tool results to history
    conv.messages.push({ role: 'assistant', content: response.content });
    conv.messages.push({ role: 'user', content: toolResults });

    // Continue conversation
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: conv.systemPrompt,
      tools: TOOLS,
      messages: conv.messages,
    });
  }

  // Add final assistant response to history
  conv.messages.push({ role: 'assistant', content: response.content });

  // Extract text reply
  const textBlocks = response.content.filter(b => b.type === 'text');
  const reply = textBlocks.map(b => b.text).join('\n');

  return {
    conversationId,
    reply,
    fields: collectedFields,
    formData: { ...conv.formData },
    complete: isComplete,
  };
}

module.exports = { chat };

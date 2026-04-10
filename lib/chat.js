/**
 * Claude-powered conversational form assistant.
 *
 * Uses Claude with tool calling to collect form data through natural conversation.
 * The chat handler is stateless per request — conversation state is managed server-side
 * via an in-memory store keyed by conversationId.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { lookupCitizen, lookupVehicle, lookupBusiness } = require('./mock-apis');

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
    name: 'lookup_citizen',
    description: 'Look up a citizen\'s details from the Trident ID service using their National Registration Number (format: YYMMDD-XXXX). Returns name, date of birth, gender, email, phone, address, and national insurance number. ALWAYS use this instead of asking for personal details manually.',
    input_schema: {
      type: 'object',
      properties: {
        national_id: { type: 'string', description: 'The National Registration Number (e.g. "870315-1234")' },
      },
      required: ['national_id'],
    },
  },
  {
    name: 'lookup_vehicle',
    description: 'Look up vehicle details from the Barbados Licensing Authority using the licence plate number (e.g. "B 1234"). Returns make, model, year, colour, engine number, chassis number, and registered owner. ALWAYS use this instead of asking for vehicle details manually.',
    input_schema: {
      type: 'object',
      properties: {
        plate: { type: 'string', description: 'The vehicle licence plate number (e.g. "B 1234")' },
      },
      required: ['plate'],
    },
  },
  {
    name: 'lookup_business',
    description: 'Look up business/company details from the CAIPO registry using the Company Registration Number (format: BB-YYYY-NNNNN, e.g. "BB-2019-04521"). Returns entity name, status, type, date of incorporation, registered address, TIN, NIS number, and directors. ALWAYS use this instead of asking for business details manually.',
    input_schema: {
      type: 'object',
      properties: {
        registration_number: { type: 'string', description: 'The Company Registration Number (e.g. "BB-2019-04521")' },
      },
      required: ['registration_number'],
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

## MANDATORY PROCESS — follow this exact order:

STEP 1: Greet the user warmly. Briefly explain what form you will help them complete.

STEP 2: Ask for their National Registration Number (format: YYMMDD-XXXX, e.g. 870315-1234).

STEP 3: When they provide the number, call the lookup_citizen tool IMMEDIATELY. Do NOT respond with text first — call the tool.

STEP 4: When lookup_citizen returns successfully, call save_fields to save ALL returned data using these EXACT field IDs:
  - first-name, middle-name, last-name
  - dob-day, dob-month, dob-year
  - gender
  - contact-email
  - mobile, landline
  - street-address, parish, postal-code
  - national-insurance, national-id
Then present the retrieved details to the user and ask them to confirm.

STEP 5: If the form involves vehicles (check the form code for vehicle-related fields), ask for the licence plate number (e.g. "B 1234"). Call lookup_vehicle, then save_fields with:
  - vehicle-plate, vehicle-make, vehicle-model, vehicle-year
  - vehicle-colour, vehicle-engine, vehicle-chassis, vehicle-owner
Present details and ask the user to confirm.

STEP 5b: If the form involves business/company details (check the form code for business-related fields), ask for the Company Registration Number (format: BB-YYYY-NNNNN, e.g. "BB-2019-04521"). Call lookup_business, then save_fields with:
  - business-reg, business-name, business-status, business-type
  - business-inc-day, business-inc-month, business-inc-year
  - business-address, business-parish, business-postal-code
  - business-tin, business-nis, business-name-reg, business-directors
Present details and ask the user to confirm.

STEP 6: Only AFTER the lookups are confirmed, ask for any ADDITIONAL fields that were NOT returned by the lookups (e.g. marital status, disability status, reason for application, new colour, declaration consent). Check the form code to see what other fields are needed.

STEP 7: When ALL fields are collected, show a final summary and ask the user to confirm.

STEP 8: When confirmed, call complete_form.

## ABSOLUTE RULES — NEVER BREAK THESE:

- NEVER ask the user for their name, date of birth, gender, email, phone number, or address. These are ALL retrieved by lookup_citizen. Even if the form code has separate pages for these fields, IGNORE those pages and use the lookup instead.
- NEVER ask the user for vehicle make, model, year, colour, engine number, or chassis number. These are ALL retrieved by lookup_vehicle.
- NEVER ask the user for business name, TIN, NIS number, directors, date of incorporation, or registered address. These are ALL retrieved by lookup_business.
- The form code below may show individual pages for name, DOB, address, business details, etc. — IGNORE that structure for the chat. The chat ALWAYS uses lookups instead of manual entry.
- Company Registration Number format: BB-YYYY-NNNNN (e.g. BB-2019-04521). Explain this if the user seems unsure.
- When the user gives you a National Registration Number, your VERY NEXT action must be to call lookup_citizen. Do not ask any other questions first.
- When the user gives you a licence plate, your VERY NEXT action must be to call lookup_vehicle. Do not ask any other questions first.
- If a lookup fails (wrong number / not found), tell the user and ask them to try again. Do NOT fall back to asking for details manually.

## Style rules:
- Be warm and professional. Use "you" and "your".
- Keep responses SHORT — 1-3 sentences per message, except when presenting lookup results.
- Use plain, simple language a 9-year-old can understand.
- Ask one question at a time.
- Do NOT use markdown formatting (no **, no ##, no bullets with - or *). Use plain numbered lists if needed.
- For Barbados parishes: Christ Church, St. Andrew, St. George, St. James, St. John, St. Joseph, St. Lucy, St. Michael, St. Peter, St. Philip, St. Thomas.
- Postal code format: BB followed by 5 digits (e.g. BB11000).
- ALWAYS call save_fields BEFORE responding with text when the user provides data.

## Form code reference

The form code below shows what fields this form collects. Use the field IDs from this code when calling save_fields. But remember: personal details and vehicle details come from lookups, NOT manual entry.

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
      } else if (toolUse.name === 'lookup_citizen') {
        const result = lookupCitizen(toolUse.input.national_id);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      } else if (toolUse.name === 'lookup_vehicle') {
        const result = lookupVehicle(toolUse.input.plate);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      } else if (toolUse.name === 'lookup_business') {
        const result = lookupBusiness(toolUse.input.registration_number);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
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

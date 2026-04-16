/**
 * WhatsApp Business API integration for conversational form completion.
 *
 * Supports two modes:
 *   - LIVE: Uses Meta Cloud API to send/receive real WhatsApp messages
 *   - LOCAL: Mock mode for testing without credentials. The WhatsApp simulator
 *            page (whatsapp-test.html) calls the webhook directly.
 *
 * The conversation logic is handled by lib/chat.js — this module only
 * manages the WhatsApp transport layer (webhook ↔ chat handler ↔ send reply).
 */

'use strict';

const { chat } = require('./chat');

/* ═══════════════════════════════════════════════
   Configuration
   ═══════════════════════════════════════════════ */

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'govtech-verify-token';
// Optional manual override. If unset, we fetch the display number from Meta
// on first use (via ensureDisplayNumber).
const WHATSAPP_DISPLAY_NUMBER = process.env.WHATSAPP_DISPLAY_NUMBER || '';
const IS_LIVE = !!(WHATSAPP_TOKEN && WHATSAPP_PHONE_ID);

// Cached E.164 number (digits only, no "+") used to build wa.me/ links.
let cachedDisplayNumber = null;
let displayNumberLookupTried = false;

/**
 * Strip a phone number down to bare E.164 digits (no "+", no dashes, no
 * spaces, no parens). wa.me/ links require this format.
 */
function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d]/g, '');
  return digits || null;
}

/**
 * Resolve the WhatsApp display number once, cache it. Priority:
 *   1. WHATSAPP_DISPLAY_NUMBER env var (manual override — skips the API)
 *   2. GET /v19.0/<PHONE_ID> on the Graph API — returns display_phone_number
 * Returns null if we aren't LIVE or the fetch failed.
 */
async function ensureDisplayNumber() {
  if (cachedDisplayNumber) return cachedDisplayNumber;
  if (!IS_LIVE) return null;

  if (WHATSAPP_DISPLAY_NUMBER) {
    cachedDisplayNumber = normalisePhone(WHATSAPP_DISPLAY_NUMBER);
    return cachedDisplayNumber;
  }

  if (displayNumberLookupTried) return null;
  displayNumberLookupTried = true;

  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`  WhatsApp display-number lookup failed (${res.status}): ${body.substring(0, 200)}`);
      return null;
    }
    const data = await res.json();
    cachedDisplayNumber = normalisePhone(data.display_phone_number);
    if (cachedDisplayNumber) {
      console.log(`  WhatsApp live: +${cachedDisplayNumber} (${data.verified_name || 'unverified'})`);
    }
    return cachedDisplayNumber;
  } catch (err) {
    console.warn(`  WhatsApp display-number lookup error: ${err.message}`);
    return null;
  }
}

/**
 * Build the URL that the "Continue via WhatsApp" button should open.
 *
 * In LIVE mode with a known display number: returns a wa.me/ deep link
 * that opens the real WhatsApp app with a prefilled starter message.
 * The prefill embeds a `[start:<folder>]` trigger that handleMessage
 * picks up to seed the right form session.
 *
 * In LOCAL mode (or if we can't resolve the display number): falls back
 * to the simulator page.
 *
 * @param {string} formFile — e.g. "direct-deposit/index.html" or
 *                            "vehicle-registration.html"
 * @param {string} [formName] — friendly name shown in the prefill text
 */
async function getStartLink(formFile, formName) {
  const safeFile = String(formFile || '').replace(/^\/+/, '');

  // Derive the folder/slug that handleMessage uses to look the form up.
  // Matches the ServiceRecord.folder values produced by lib/catalogue.js:
  // folder-based prototypes → "direct-deposit"
  // legacy single-file      → "vehicle-registration"
  let folder = safeFile.split('/')[0] || '';
  folder = folder.replace(/\.html$/i, '');

  const number = await ensureDisplayNumber();
  if (!number) {
    return `/whatsapp-test.html?form=${encodeURIComponent(safeFile)}`;
  }

  const trimmed = formName && formName.trim();
  const prefill = trimmed
    ? `Hi! I'd like to start the ${trimmed}. [start:${folder}]`
    : `Hi! I'd like to start a government service. [start:${folder}]`;
  return `https://wa.me/${number}?text=${encodeURIComponent(prefill)}`;
}

/* ═══════════════════════════════════════════════
   Phone → conversation mapping
   ═══════════════════════════════════════════════ */

// Maps phone numbers to { conversationId, formName, formScript, startedAt }
const phoneSessions = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000; // 2 hours

function cleanupSessions() {
  const now = Date.now();
  for (const [phone, session] of phoneSessions) {
    if (now - session.startedAt > SESSION_TTL) {
      phoneSessions.delete(phone);
    }
  }
}
setInterval(cleanupSessions, 15 * 60 * 1000);

/* ═══════════════════════════════════════════════
   Webhook verification (GET)
   ═══════════════════════════════════════════════ */

function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('  WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
}

/* ═══════════════════════════════════════════════
   Send message via Meta Cloud API
   ═══════════════════════════════════════════════ */

async function sendWhatsAppMessage(to, text) {
  if (!IS_LIVE) {
    // In local mode, messages are returned directly to the simulator
    console.log(`  [WhatsApp LOCAL] → ${to}: ${text.substring(0, 80)}...`);
    return;
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      console.error('  WhatsApp send error:', data);
    }
  } catch (err) {
    console.error('  WhatsApp send failed:', err.message);
  }
}

/* ═══════════════════════════════════════════════
   Process an incoming message
   ═══════════════════════════════════════════════ */

/**
 * Handle an incoming WhatsApp message.
 *
 * @param {string} phone - Sender's phone number
 * @param {string} text - Message text
 * @param {string} [formName] - Form name (for starting a new session in local mode)
 * @param {string} [formScript] - Form script (for starting a new session in local mode)
 * @returns {Promise<{reply, complete, referenceNumber?}>}
 */
async function handleMessage(phone, text, formName, formScript) {
  let session = phoneSessions.get(phone);

  // Check for reset commands
  const lower = text.trim().toLowerCase();
  if (lower === 'reset' || lower === 'restart' || lower === 'cancel') {
    phoneSessions.delete(phone);
    return {
      reply: 'No problem. Your session has been cleared. Send a message any time to start again.',
      complete: false,
    };
  }

  // Detect a [start:<folder>] trigger embedded in the message.
  // This is how the "Continue via WhatsApp" button opens a specific form:
  // the prefilled message contains the trigger, and we use it to look up
  // the form JS and seed the session.
  const startMatch = text.match(/\[start:\s*([a-zA-Z0-9_\-\.\/]+)\s*\]/);
  if (startMatch) {
    const folder = startMatch[1];
    try {
      const { loadFormScript } = require('./catalogue');
      const loaded = await loadFormScript(folder);
      if (loaded && loaded.formScript) {
        // Start-triggers always replace any existing session.
        phoneSessions.delete(phone);
        formName = loaded.formName;
        formScript = loaded.formScript;
      }
    } catch (err) {
      console.warn(`  WhatsApp start-trigger for "${folder}" failed: ${err.message}`);
    }
  }

  // If no active session, we need form details to start one
  if (!session || startMatch) {
    if (!formName || !formScript) {
      return {
        reply: 'Welcome to GovTech Barbados. To get started, please use the link from the service page to begin your application via WhatsApp.',
        complete: false,
      };
    }
    session = {
      conversationId: null,
      formName,
      formScript,
      startedAt: Date.now(),
    };
    phoneSessions.set(phone, session);
  }

  // Pass to chat handler
  const result = await chat({
    conversationId: session.conversationId,
    formName: session.formName,
    formScript: session.formScript,
    message: text,
  });

  // Update session with conversation ID
  session.conversationId = result.conversationId;

  // If complete, clean up session
  if (result.complete) {
    phoneSessions.delete(phone);
  }

  return {
    reply: result.reply,
    fields: result.fields,
    formData: result.formData,
    complete: result.complete,
  };
}

/* ═══════════════════════════════════════════════
   Webhook handler (POST) — for real WhatsApp
   ═══════════════════════════════════════════════ */

async function handleWebhook(req, res) {
  // Acknowledge immediately (Meta requires 200 within 5s)
  res.status(200).send('OK');

  const body = req.body;

  if (!body.entry) return;

  for (const entry of body.entry) {
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field !== 'messages') continue;
      const messages = change.value?.messages || [];

      for (const msg of messages) {
        if (msg.type !== 'text') continue;
        const phone = msg.from;
        const text = msg.text?.body || '';

        console.log(`  [WhatsApp] ← ${phone}: ${text.substring(0, 80)}`);

        try {
          const result = await handleMessage(phone, text);
          if (result.reply) {
            await sendWhatsAppMessage(phone, result.reply);
          }
        } catch (err) {
          console.error('  WhatsApp processing error:', err.message);
          await sendWhatsAppMessage(phone, 'Sorry, something went wrong. Please try again.');
        }
      }
    }
  }
}

/* ═══════════════════════════════════════════════
   Local simulator endpoint
   ═══════════════════════════════════════════════ */

/**
 * Handle a message from the local WhatsApp simulator.
 * Unlike the real webhook, this returns the reply directly in the response.
 */
async function handleSimulator(req, res) {
  const { phone, message, formName, formScript } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message are required' });
  }

  try {
    const result = await handleMessage(phone, message, formName, formScript);

    // If complete, generate reference number and create case
    if (result.complete) {
      const { generateReference } = require('./reference');
      const { createCase } = require('./cases');
      const { sendConfirmation, sendNotification } = require('./email');

      const referenceNumber = generateReference(formName || 'WhatsApp Form');
      const userEmail = result.formData?.['contact-email'] || result.formData?.['email'] || null;

      createCase({
        referenceNumber,
        formName: formName || phoneSessions.get(phone)?.formName || 'WhatsApp Form',
        formData: result.formData || {},
        userEmail,
        channel: 'whatsapp',
      });

      console.log(`\n━━━ WhatsApp Submission ━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`  Form:      ${formName}`);
      console.log(`  Reference: ${referenceNumber}`);
      console.log(`  Phone:     ${phone}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      // Send emails in background
      Promise.allSettled([
        sendConfirmation(userEmail, formName, referenceNumber),
        sendNotification(formName, result.formData, referenceNumber, userEmail),
      ]);

      return res.json({
        success: true,
        reply: result.reply,
        complete: true,
        referenceNumber,
      });
    }

    return res.json({
      success: true,
      reply: result.reply,
      complete: false,
    });
  } catch (err) {
    console.error('  WhatsApp simulator error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Something went wrong. Please try again.',
    });
  }
}

module.exports = {
  verifyWebhook,
  handleWebhook,
  handleSimulator,
  getStartLink,
  ensureDisplayNumber,
  IS_LIVE,
};

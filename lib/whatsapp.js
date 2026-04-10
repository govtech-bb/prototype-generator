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
const IS_LIVE = !!(WHATSAPP_TOKEN && WHATSAPP_PHONE_ID);

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

  // If no active session, we need form details to start one
  if (!session) {
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
  IS_LIVE,
};

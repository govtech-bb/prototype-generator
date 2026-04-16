#!/usr/bin/env node
/**
 * One-shot build script: composes public/services.html by splicing
 * chat.html's chrome (top bar + yellow header + alpha banner + footer)
 * with a concierge-specific <main> body and <script>.
 *
 * This exists because the trident SVG in the yellow header is ~10KB of
 * path data that we don't want to maintain in two places by hand. Re-run
 * if chat.html's chrome ever changes.
 *
 * Usage: node scripts/build-services-html.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const chatHtmlPath = path.join(ROOT, 'public', 'chat.html');
const outPath = path.join(ROOT, 'public', 'services.html');

const chat = fs.readFileSync(chatHtmlPath, 'utf-8');

// Pull chrome pieces out of chat.html.
function slice(html, startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  const e = html.indexOf(endMarker, s);
  if (s === -1 || e === -1) throw new Error('Missing chrome marker: ' + startMarker);
  return html.substring(s, e);
}

const topBar       = slice(chat, '<!-- Top bar -->',       '<!-- Header -->');
const yellowHeader = slice(chat, '<!-- Header -->',        '<!-- Alpha banner -->');
const alphaBanner  = slice(chat, '<!-- Alpha banner -->',  '<!-- Main -->');
const footer       = slice(chat, '<!-- Footer -->',        '<script>');

// Main body for the concierge page.
const main = `<!-- Main -->
<main>
  <div class="container py-8 max-w-3xl chat-container">

    <!-- Page header -->
    <div class="mb-4">
      <p class="border-bb-blue-40 border-l-4 py-xs pl-s text-bb-mid-grey-00 mb-2">Government of Barbados</p>
      <h1 class="font-bold text-[2.5rem] leading-[1.15] mb-2">Find a government service</h1>
      <p class="text-bb-mid-grey-00 mb-0 text-[1rem]">Tell us what you need help with. We'll point you to the right place.</p>
    </div>

    <!-- Chat messages -->
    <div class="chat-messages border-2 border-bb-grey-00 rounded-sm bg-white p-4 mb-4" id="chat-messages">
      <!-- Messages injected here -->
    </div>

    <!-- Input area -->
    <div class="chat-input-area flex gap-2" id="chat-input-area">
      <div class="relative inline-flex flex-1 rounded-sm border-2 border-bb-black-00 items-center transition-all bg-bb-white-00 hover:shadow-form-hover focus-within:ring-4 focus-within:ring-bb-teal-100">
        <input type="text" id="chat-input"
          class="w-full min-w-0 p-s outline-none rounded-[inherit]"
          placeholder="What do you need help with?"
          autocomplete="off" />
      </div>
      <button type="button" id="chat-send"
        class="relative inline-flex items-center justify-center gap-2 text-[20px] whitespace-nowrap transition-[background-color,box-shadow] duration-200 outline-none bg-bb-teal-00 text-bb-white-00 hover:bg-[#1a777d] active:bg-[#0a4549] px-xm py-s rounded-sm leading-[1.7] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-offset-1 focus-visible:ring-bb-teal-100 disabled:opacity-50 disabled:cursor-not-allowed">
        Send
      </button>
    </div>

  </div>
</main>
`;

// Concierge-specific script.
const script = `<script>
(function () {
  'use strict';

  var conversationId = null;
  var sending = false;

  var messagesEl = document.getElementById('chat-messages');
  var inputEl = document.getElementById('chat-input');
  var sendBtn = document.getElementById('chat-send');

  /* ── Helpers ── */
  function esc(text) {
    var d = document.createElement('div');
    d.textContent = text == null ? '' : String(text);
    return d.innerHTML;
  }

  function scrollToEnd() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addUserMessage(text) {
    var div = document.createElement('div');
    div.className = 'flex gap-3 items-start mb-4 justify-end';
    div.innerHTML =
      '<div class="bg-bb-teal-00 text-bb-white-00 rounded-sm px-4 py-3 max-w-[80%]">' +
      '<p class="text-[1.125rem] leading-relaxed whitespace-pre-wrap">' + esc(text) + '</p></div>';
    messagesEl.appendChild(div);
    scrollToEnd();
  }

  function addBotMessage(text, extraHtml) {
    var div = document.createElement('div');
    div.className = 'flex gap-3 items-start mb-4';
    div.innerHTML =
      '<div class="shrink-0 w-10 h-10 rounded-full bg-bb-blue-100 flex items-center justify-center text-white text-[0.875rem] font-bold mt-1">BB</div>' +
      '<div class="flex-1 min-w-0 max-w-[80%] space-y-3">' +
        '<div class="bg-bb-blue-10 rounded-sm px-4 py-3">' +
          '<p class="text-[1.125rem] leading-relaxed whitespace-pre-wrap">' + esc(text) + '</p>' +
        '</div>' +
        (extraHtml || '') +
      '</div>';
    messagesEl.appendChild(div);
    scrollToEnd();
  }

  function serviceCardHtml(rec) {
    var primaryBtnCls = 'relative inline-flex items-center justify-center gap-2 text-[1rem] whitespace-nowrap outline-none bg-bb-teal-00 text-bb-white-00 hover:bg-[#1a777d] active:bg-[#0a4549] px-s py-xs rounded-sm font-bold no-underline';
    var linkCls = 'inline-flex outline-none underline-offset-2 underline hover:no-underline active:bg-bb-yellow-100 focus-visible:bg-bb-yellow-100 text-bb-teal-00 hover:text-bb-black-00 hover:bg-bb-teal-10 text-[1rem]';

    var bullets = '';
    if (rec.whatYouNeed && rec.whatYouNeed.length) {
      var shown = rec.whatYouNeed.slice(0, 3);
      var more = rec.whatYouNeed.length - shown.length;
      var items = shown.map(function (b) {
        return '<li>' + esc(b) + '</li>';
      }).join('');
      bullets =
        '<div class="mt-3">' +
          '<p class="font-bold text-[1rem] mb-1">What you will need</p>' +
          '<ul class="list-disc pl-5 space-y-1 text-[1rem]">' + items + '</ul>' +
          (more > 0 ? '<p class="text-[0.875rem] text-bb-mid-grey-00 mt-1">+' + more + ' more</p>' : '') +
        '</div>';
    }

    var heading = rec.h1 || rec.formName;
    var subHead = (rec.h1 && rec.h1 !== rec.formName) ? rec.formName : null;

    return '<article class="border-2 border-bb-grey-00 rounded-sm bg-bb-white-00 p-4">' +
      (rec.mda ? '<p class="border-bb-blue-40 border-l-4 py-xs pl-s text-bb-mid-grey-00 text-[0.875rem] mb-2">' + esc(rec.mda) + '</p>' : '') +
      '<h2 class="font-bold text-[1.5rem] leading-tight mb-1">' + esc(heading) + '</h2>' +
      (subHead ? '<p class="text-bb-mid-grey-00 text-[0.875rem] mb-2">' + esc(subHead) + '</p>' : '') +
      (rec.intro ? '<p class="text-[1rem] mb-0">' + esc(rec.intro) + '</p>' : '') +
      bullets +
      '<div class="mt-4 flex flex-wrap items-center gap-4">' +
        '<a href="' + esc(rec.url) + '" class="' + primaryBtnCls + '">Start online form</a>' +
        '<a href="' + esc(rec.chatUrl) + '" class="' + linkCls + '">Continue via chat</a>' +
        '<a href="' + esc(rec.whatsappUrl) + '" class="' + linkCls + '">Continue via WhatsApp</a>' +
      '</div>' +
    '</article>';
  }

  function addRecommendationCards(recs) {
    var html = recs.map(function (r) {
      var reasonHtml = r.reason
        ? '<p class="text-[1rem] text-bb-mid-grey-00 mb-0">' + esc(r.reason) + '</p>'
        : '';
      return '<div class="space-y-2">' + reasonHtml + serviceCardHtml(r) + '</div>';
    }).join('');
    var div = document.createElement('div');
    div.className = 'flex gap-3 items-start mb-4';
    div.innerHTML =
      '<div class="shrink-0 w-10 h-10 rounded-full bg-bb-blue-100 flex items-center justify-center text-white text-[0.875rem] font-bold mt-1">BB</div>' +
      '<div class="flex-1 min-w-0 max-w-[95%] space-y-3">' + html + '</div>';
    messagesEl.appendChild(div);
    scrollToEnd();
  }

  function showTyping() {
    var div = document.createElement('div');
    div.className = 'flex gap-3 items-start mb-4';
    div.id = 'typing-indicator';
    div.innerHTML =
      '<div class="shrink-0 w-10 h-10 rounded-full bg-bb-blue-100 flex items-center justify-center text-white text-[0.875rem] font-bold mt-1">BB</div>' +
      '<div class="bg-bb-blue-10 rounded-sm px-4 py-3"><div class="flex gap-1.5 py-1"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div></div>';
    messagesEl.appendChild(div);
    scrollToEnd();
  }

  function hideTyping() {
    var el = document.getElementById('typing-indicator');
    if (el) el.remove();
  }

  function setLoading(loading) {
    sending = loading;
    sendBtn.disabled = loading;
    inputEl.disabled = loading;
  }

  /* ── API ── */
  async function sendMessage(userMessage) {
    if (sending) return;
    setLoading(true);

    if (userMessage) addUserMessage(userMessage);
    showTyping();

    try {
      var body = { conversationId: conversationId };
      if (userMessage) body.message = userMessage;

      var res = await fetch('/api/concierge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      hideTyping();

      if (res.status === 429) {
        addBotMessage('Lots of people are asking right now. Please try again in a moment.');
        setLoading(false);
        return;
      }

      var data = await res.json();
      if (!data.success) {
        addBotMessage('Sorry, something went wrong. Please try again.');
        setLoading(false);
        return;
      }

      conversationId = data.conversationId;

      if (data.recommendations && data.recommendations.length > 0) {
        // Bot text first (reply), then the cards as a separate bot turn.
        if (data.reply) addBotMessage(data.reply);
        addRecommendationCards(data.recommendations);
      } else if (data.noMatch) {
        var merged = (data.reply && data.reply !== data.noMatch)
          ? data.reply + '\\n\\n' + data.noMatch
          : (data.reply || data.noMatch);
        addBotMessage(merged);
      } else {
        addBotMessage(data.reply || '…');
      }

    } catch (err) {
      hideTyping();
      addBotMessage('Sorry, I could not connect. Please check your internet and try again.');
    }

    setLoading(false);
    if (!sending) inputEl.focus();
  }

  /* ── Events ── */
  sendBtn.addEventListener('click', function () {
    var msg = inputEl.value.trim();
    if (!msg) return;
    inputEl.value = '';
    sendMessage(msg);
  });

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      var msg = inputEl.value.trim();
      if (!msg) return;
      inputEl.value = '';
      sendMessage(msg);
    }
  });

  /* ── Cold start: let the bot greet first ── */
  sendMessage(null);
})();
</script>`;

const services = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Find a government service – GovTech Barbados</title>
<link rel="icon" type="image/svg+xml" href="https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Flag_of_Barbados.svg/1280px-Flag_of_Barbados.svg.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@300..900&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<script src="/assets/govbb-tailwind-config.js"></script>
<link rel="stylesheet" href="/assets/govbb-base.css">
<link rel="stylesheet" href="/assets/govbb-chat.css">
</head>
<body>

${topBar.trim()}

${yellowHeader.trim()}

${alphaBanner.trim()}

${main.trim()}

${footer.trim()}

${script}
</body>
</html>
`;

fs.writeFileSync(outPath, services);
console.log('Wrote ' + outPath + ' (' + (services.length / 1024).toFixed(1) + ' KB)');

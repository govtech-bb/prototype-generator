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

  var PRIMARY_BTN_CLS = 'relative inline-flex items-center justify-center gap-2 text-[1rem] whitespace-nowrap outline-none bg-bb-teal-00 text-bb-white-00 hover:bg-[#1a777d] active:bg-[#0a4549] px-s py-xs rounded-sm font-bold no-underline';
  var LINK_CLS = 'inline-flex outline-none underline-offset-2 underline hover:no-underline active:bg-bb-yellow-100 focus-visible:bg-bb-yellow-100 text-bb-teal-00 hover:text-bb-black-00 hover:bg-bb-teal-10 text-[1rem]';

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

  /* ── Service cards ── */
  function digitisedCardHtml(rec) {
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
        '<a href="' + esc(rec.url) + '" class="' + PRIMARY_BTN_CLS + '">Start online form</a>' +
        '<a href="' + esc(rec.chatUrl) + '" class="' + LINK_CLS + '">Continue via chat</a>' +
        '<a href="' + esc(rec.whatsappUrl) + '" class="' + LINK_CLS + '">Continue via WhatsApp</a>' +
      '</div>' +
      (rec.guideUrl ? '<p class="mt-3 text-[0.875rem] text-bb-mid-grey-00">For the latest fees and requirements, see the <a href="' + esc(rec.guideUrl) + '" class="' + LINK_CLS + '">full guide on alpha.gov.bb</a>.</p>' : '') +
    '</article>';
  }

  function infoCardHtml(rec) {
    var feesHtml = '';
    if (rec.fees && rec.fees.table && rec.fees.table.length) {
      var rows = rec.fees.table.map(function (r) {
        return '<tr class="border-t border-bb-grey-00"><td class="py-1 pr-4">' + esc(r.label) + '</td><td class="py-1 font-bold text-right">' + esc(r.amount) + '</td></tr>';
      }).join('');
      feesHtml =
        '<div class="mt-3">' +
          '<p class="font-bold text-[1rem] mb-1">Fees</p>' +
          '<table class="w-full text-[1rem] border-t border-bb-grey-00"><tbody>' + rows + '</tbody></table>' +
        '</div>';
    } else if (rec.fees && rec.fees.markdown) {
      feesHtml =
        '<div class="mt-3">' +
          '<p class="font-bold text-[1rem] mb-1">Fees</p>' +
          '<div class="text-[1rem]">' + renderMarkdown(rec.fees.markdown) + '</div>' +
        '</div>';
    }

    // How-to-apply summary: first paragraph under the first ## heading
    var howToHtml = '';
    var howToText = extractHowToApply(rec.body);
    if (howToText) {
      howToHtml =
        '<div class="mt-3">' +
          '<p class="font-bold text-[1rem] mb-1">How to apply</p>' +
          '<div class="text-[1rem]">' + renderMarkdown(howToText) + '</div>' +
        '</div>';
    }

    // Show Last updated only when date is real, in the past, and <= 24 months old
    var dateChip = '';
    if (rec.publishDate) {
      var d = new Date(rec.publishDate);
      var now = new Date();
      if (!isNaN(d.getTime()) && d.getTime() < now.getTime() + 24*60*60*1000) {
        var monthsAgo = (now.getTime() - d.getTime()) / (30 * 24 * 60 * 60 * 1000);
        if (monthsAgo <= 24) {
          dateChip = '<span class="inline-block text-[0.875rem] text-bb-mid-grey-00 mt-3">Last updated: ' + esc(formatDate(d)) + '</span>';
        }
      }
    }

    return '<article class="border-2 border-bb-grey-00 rounded-sm bg-bb-white-00 p-4">' +
      (rec.section ? '<p class="border-bb-blue-40 border-l-4 py-xs pl-s text-bb-mid-grey-00 text-[0.875rem] mb-2">' + esc(rec.section) + '</p>' : '') +
      '<h2 class="font-bold text-[1.5rem] leading-tight mb-1">' + esc(rec.title) + '</h2>' +
      (rec.description ? '<p class="text-[1rem] mb-0">' + esc(rec.description) + '</p>' : '') +
      howToHtml +
      feesHtml +
      '<div class="mt-4 flex flex-wrap items-center gap-4">' +
        '<a href="' + esc(rec.alphaUrl) + '" target="_blank" rel="noopener" class="' + PRIMARY_BTN_CLS + '">Read the full guide on alpha.gov.bb &rarr;</a>' +
      '</div>' +
      dateChip +
    '</article>';
  }

  function serviceCardHtml(rec) {
    return rec.kind === 'info-only' ? infoCardHtml(rec) : digitisedCardHtml(rec);
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

  /* ── Grounded answer (pull-quote citation) ── */
  function addAnswer(answered, replyText) {
    var quoteHtml =
      '<blockquote class="border-l-4 border-bb-teal-40 bg-bb-teal-10 pl-s py-xs mt-0 text-[0.95rem]">' +
        '<p class="italic text-bb-black-00 mb-1">&ldquo;' + esc(answered.quote) + '&rdquo;</p>' +
        '<p class="text-[0.875rem] text-bb-mid-grey-00 mb-0">Source: <a href="' + esc(answered.alphaUrl) + '" target="_blank" rel="noopener" class="' + LINK_CLS + ' text-[0.875rem]">' + esc(answered.title) + '</a></p>' +
      '</blockquote>';
    addBotMessage(replyText || answered.answer, quoteHtml);
  }

  /* ── Deferral ── */
  function addDeferral(deferred, replyText) {
    var cardHtml =
      '<article class="border-2 border-bb-grey-00 rounded-sm bg-bb-white-00 p-4">' +
        '<p class="text-[1rem] mb-3">The full guide has the current answer.</p>' +
        '<a href="' + esc(deferred.alphaUrl) + '" target="_blank" rel="noopener" class="' + PRIMARY_BTN_CLS + '">Read the full ' + esc(deferred.title) + ' guide &rarr;</a>' +
      '</article>';
    addBotMessage(replyText || 'I don\\'t have that specific detail.', cardHtml);
  }

  /* ── Tiny markdown renderer ── */
  // Handles headings, paragraphs, bullets, bold, italic, links. Rewrites
  // relative links (e.g. /foo-bar) to absolute alpha.gov.bb URLs so they
  // don't 404 against our own domain.
  function renderMarkdown(md) {
    if (!md) return '';
    var lines = String(md).split(/\\r?\\n/);
    var html = '';
    var inList = false;
    var inPara = [];
    function flushPara() {
      if (inPara.length) {
        html += '<p class="mb-2">' + renderInline(inPara.join(' ')) + '</p>';
        inPara = [];
      }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m;
      if (/^\\s*$/.test(line)) { flushPara(); if (inList) { html += '</ul>'; inList = false; } continue; }
      if ((m = line.match(/^###\\s+(.+)$/))) { flushPara(); if (inList) { html += '</ul>'; inList = false; } html += '<p class="font-bold text-[1rem] mt-2 mb-1">' + renderInline(m[1]) + '</p>'; continue; }
      if ((m = line.match(/^##\\s+(.+)$/)))  { flushPara(); if (inList) { html += '</ul>'; inList = false; } html += '<p class="font-bold text-[1rem] mt-2 mb-1">' + renderInline(m[1]) + '</p>'; continue; }
      if ((m = line.match(/^\\s*[-*]\\s+(.+)$/))) {
        flushPara();
        if (!inList) { html += '<ul class="list-disc pl-5 space-y-1 mb-2">'; inList = true; }
        html += '<li>' + renderInline(m[1]) + '</li>';
        continue;
      }
      inPara.push(line.trim());
    }
    flushPara();
    if (inList) html += '</ul>';
    return html;
  }

  function renderInline(text) {
    if (!text) return '';
    // Escape HTML first
    var out = esc(text);
    // Links: [label](url) — rewrite relative paths to alpha.gov.bb
    out = out.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, function (_m, label, url) {
      if (/^\\//.test(url)) url = 'https://alpha.gov.bb' + url;
      return '<a href="' + url + '" target="_blank" rel="noopener" class="' + LINK_CLS + '">' + label + '</a>';
    });
    // Bold **x** and __x__
    out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    // Italic *x* (but not bold's asterisks)
    out = out.replace(/(^|[^*])\\*([^*]+)\\*(?!\\*)/g, '$1<em>$2</em>');
    // Emdash
    out = out.replace(/—/g, '&mdash;');
    return out;
  }

  // Pull the first paragraph (if any) under the first "## How to..." or
  // "## How do..." or "## Applying..." or any first ## heading, for the
  // card's "How to apply" summary.
  function extractHowToApply(md) {
    if (!md) return '';
    var lines = md.split(/\\r?\\n/);
    var inTarget = false;
    var captured = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var hMatch = line.match(/^##\\s+(.+)$/);
      if (hMatch) {
        if (inTarget) break;  // stop at next ##
        var title = hMatch[1].toLowerCase();
        if (/\\b(how to (apply|get)|apply|steps|process|how do i|how can i)\\b/.test(title)) {
          inTarget = true;
          continue;
        }
      }
      if (inTarget) captured.push(line);
    }
    // Keep up to the first blank-line-separated block (one paragraph or list)
    var firstBlock = captured.join('\\n').split(/\\n{2,}/)[0];
    return (firstBlock || '').trim();
  }

  function formatDate(d) {
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  }

  /* ── Typing / loading ── */
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

      // Priority: answered (grounded pull-quote) → deferred → recs → noMatch → plain
      if (data.answered) {
        addAnswer(data.answered, data.reply);
      } else if (data.deferred) {
        addDeferral(data.deferred, data.reply);
      } else if (data.recommendations && data.recommendations.length > 0) {
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

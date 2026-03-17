/**
 * GovTech Barbados – Form Prototype Framework
 *
 * Provides navigation, template helpers, validation, and form submission.
 * Each prototype provides only: FORM_NAME, FLOW, PAGES, validate(), then calls GovBB.init().
 *
 * Load at the bottom of <body>:
 *   <script src="/assets/govbb-framework.js"></script>
 */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════
     Constants
     ═══════════════════════════════════════════════ */

  const PARISHES = [
    'Christ Church', 'St. Andrew', 'St. George', 'St. James', 'St. John',
    'St. Joseph', 'St. Lucy', 'St. Michael', 'St. Peter', 'St. Philip', 'St. Thomas',
  ];

  /* ═══════════════════════════════════════════════
     State
     ═══════════════════════════════════════════════ */

  const D = {};          // Form data store
  let cur = 0;           // Current page index
  let _config = null;    // Config set by init()
  let _appEl = null;     // The <main id="app"> element

  /* ═══════════════════════════════════════════════
     CSS class constants
     ═══════════════════════════════════════════════ */

  const LINK_CLS = 'inline-flex outline-none underline-offset-2 underline hover:no-underline active:bg-bb-yellow-100 active:no-underline focus-visible:bg-bb-yellow-100 focus-visible:no-underline active:text-bb-black-00 focus-visible:text-bb-black-00 text-bb-teal-00 hover:text-bb-black-00 hover:bg-bb-teal-10';
  const BTN_CLS = 'relative inline-flex items-center justify-center gap-2 text-[20px] whitespace-nowrap transition-[background-color,box-shadow] duration-200 outline-none bg-bb-teal-00 text-bb-white-00 hover:bg-[#1a777d] hover:shadow-[inset_0_0_0_4px_rgba(222,245,246,0.10)] active:bg-[#0a4549] active:shadow-[inset_0_0_0_3px_rgba(0,0,0,0.20)] px-xm py-s rounded-sm leading-[1.7] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-offset-1 focus-visible:ring-bb-teal-100 focus-visible:rounded-sm';
  const INPUT_WRAP_CLS = 'relative inline-flex rounded-sm border-2 border-bb-black-00 items-center gap-2 transition-all bg-bb-white-00 hover:shadow-form-hover focus-within:ring-4 focus-within:ring-bb-teal-100';
  const INPUT_CLS = 'w-full min-w-0 p-s outline-none rounded-[inherit] placeholder:text-bb-black-00/60';
  const RADIO_CLS = 'relative inline-flex size-12 shrink-0 items-center justify-center bg-bb-white-00 border-2 border-bb-black-00 border-solid rounded-full transition-all outline-none hover:cursor-pointer hover:shadow-form-hover focus-visible:border-bb-teal-00 focus-visible:shadow-none focus-visible:ring-4 focus-visible:ring-bb-teal-100';
  const CHECKBOX_CLS = 'relative inline-flex size-12 shrink-0 items-center justify-center bg-bb-white-00 border-2 border-bb-black-00 border-solid rounded-sm transition-all outline-none hover:cursor-pointer hover:shadow-form-hover focus-visible:border-bb-teal-00 focus-visible:shadow-none focus-visible:ring-4 focus-visible:ring-bb-teal-100';

  /* ═══════════════════════════════════════════════
     Template Helpers (return HTML strings)
     ═══════════════════════════════════════════════ */

  function backLink() {
    return `<a href="#" onclick="GovBB.back();return false" class="inline-flex items-center gap-xs outline-none underline-offset-2 underline hover:no-underline active:bg-bb-yellow-100 focus-visible:bg-bb-yellow-100 text-bb-teal-00 hover:text-bb-black-00 hover:bg-bb-teal-10 mb-4">&#8592; Back</a>`;
  }

  function caption(text) {
    const label = text || (_config ? _config.formName : '');
    return `<p class="border-bb-blue-40 border-l-4 py-xs pl-s text-bb-mid-grey-00 mb-2">${label}</p>`;
  }

  function continueBtn(label) {
    label = label || 'Continue';
    return `<div class="mt-8 flex gap-4">
      <button type="button" onclick="GovBB.next()" class="${BTN_CLS}">${label}</button>
    </div>`;
  }

  function startBtn(label) {
    label = label || 'Complete the online form';
    return `<div class="mt-8 flex gap-4">
      <a href="#" onclick="GovBB.next();return false" class="${BTN_CLS} no-underline">${label}</a>
    </div>`;
  }

  function textField(id, label, opts) {
    opts = opts || {};
    const hint = opts.hint || '';
    const width = opts.width || 'w-full';
    const inputmode = opts.inputmode || '';
    const maxlength = opts.maxlength || '';
    const placeholder = opts.placeholder || '';
    return `<div class="flex flex-col gap-xs w-full items-start">
      <label for="${id}" class="block text-[1.25rem] leading-normal font-bold text-bb-black-00">${label}</label>
      ${hint ? `<p class="text-[1.25rem] leading-normal text-bb-mid-grey-00">${hint}</p>` : ''}
      <div class="${INPUT_WRAP_CLS} ${width}" id="${id}-wrap">
        <input type="text" id="${id}" name="${id}"${inputmode ? ` inputmode="${inputmode}"` : ''}${maxlength ? ` maxlength="${maxlength}"` : ''}${placeholder ? ` placeholder="${placeholder}"` : ''}
          class="${INPUT_CLS}"
          value="${_esc(D[id])}" oninput="GovBB.D['${id}']=this.value" />
      </div>
      <p class="text-bb-red-00 text-[1rem] hidden" id="${id}-err"></p>
    </div>`;
  }

  function emailField(id, label, opts) {
    opts = opts || {};
    const hint = opts.hint || '';
    return `<div class="flex flex-col gap-xs w-full items-start">
      <label for="${id}" class="block text-[1.25rem] leading-normal font-bold text-bb-black-00">${label}</label>
      ${hint ? `<p class="text-[1.25rem] leading-normal text-bb-mid-grey-00">${hint}</p>` : ''}
      <div class="${INPUT_WRAP_CLS} w-full" id="${id}-wrap">
        <input type="email" id="${id}" name="${id}"
          class="${INPUT_CLS}"
          value="${_esc(D[id])}" oninput="GovBB.D['${id}']=this.value" />
      </div>
      <p class="text-bb-red-00 text-[1rem] hidden" id="${id}-err"></p>
    </div>`;
  }

  function telField(id, label, opts) {
    opts = opts || {};
    const hint = opts.hint || '';
    const placeholder = opts.placeholder || '';
    const width = opts.width || 'w-full';
    return `<div class="flex flex-col gap-xs w-full items-start">
      <label for="${id}" class="block text-[1.25rem] leading-normal font-bold text-bb-black-00">${label}</label>
      ${hint ? `<p class="text-[1.25rem] leading-normal text-bb-mid-grey-00">${hint}</p>` : ''}
      <div class="${INPUT_WRAP_CLS} ${width}" id="${id}-wrap">
        <input type="tel" id="${id}" name="${id}"${placeholder ? ` placeholder="${placeholder}"` : ''}
          class="${INPUT_CLS}"
          value="${_esc(D[id])}" oninput="GovBB.D['${id}']=this.value" />
      </div>
      <p class="text-bb-red-00 text-[1rem] hidden" id="${id}-err"></p>
    </div>`;
  }

  function selectField(id, label, options, opts) {
    opts = opts || {};
    const hint = opts.hint || '';
    const optHtml = options.map(function (o) {
      var val = typeof o === 'object' ? o.value : o;
      var text = typeof o === 'object' ? o.label : o;
      return `<option value="${val}"${D[id] === val ? ' selected' : ''}>${text}</option>`;
    }).join('');
    return `<div class="flex flex-col gap-xs w-full items-start">
      <label for="${id}" class="block text-[1.25rem] leading-normal font-bold text-bb-black-00">${label}</label>
      ${hint ? `<p class="text-[1.25rem] leading-normal text-bb-mid-grey-00">${hint}</p>` : ''}
      <div class="${INPUT_WRAP_CLS} w-full" id="${id}-wrap">
        <select id="${id}" name="${id}" class="w-full min-w-0 p-s outline-none rounded-[inherit] bg-transparent" onchange="GovBB.D['${id}']=this.value">
          <option value="">Select</option>
          ${optHtml}
        </select>
      </div>
      <p class="text-bb-red-00 text-[1rem] hidden" id="${id}-err"></p>
    </div>`;
  }

  function textareaField(id, label, opts) {
    opts = opts || {};
    const hint = opts.hint || '';
    const rows = opts.rows || 4;
    const maxlength = opts.maxlength || '';
    return `<div class="flex flex-col gap-xs w-full items-start">
      <label for="${id}" class="block text-[1.25rem] leading-normal font-bold text-bb-black-00">${label}</label>
      ${hint ? `<p class="text-[1.25rem] leading-normal text-bb-mid-grey-00">${hint}</p>` : ''}
      <div class="${INPUT_WRAP_CLS} w-full" id="${id}-wrap">
        <textarea id="${id}" name="${id}" rows="${rows}"${maxlength ? ` maxlength="${maxlength}"` : ''}
          class="${INPUT_CLS}"
          oninput="GovBB.D['${id}']=this.value">${_esc(D[id])}</textarea>
      </div>
      <p class="text-bb-red-00 text-[1rem] hidden" id="${id}-err"></p>
    </div>`;
  }

  function dateField(prefix, label, hint) {
    return `<div class="flex flex-col gap-xs w-full items-start">
      <p class="text-[1.25rem] leading-normal font-bold text-bb-black-00">${label}</p>
      ${hint ? `<p class="text-[1.25rem] leading-normal text-bb-mid-grey-00">${hint}</p>` : ''}
      <div class="flex gap-s items-end flex-wrap">
        <div class="flex flex-col gap-xs">
          <label for="${prefix}-day" class="text-[1.25rem] leading-normal font-bold text-bb-black-00">Day</label>
          <div class="${INPUT_WRAP_CLS}" style="width:5rem" id="${prefix}-day-wrap">
            <input type="text" id="${prefix}-day" name="${prefix}-day" inputmode="numeric" maxlength="2"
              class="${INPUT_CLS}" value="${_esc(D[prefix + '-day'])}" oninput="GovBB.D['${prefix}-day']=this.value" />
          </div>
        </div>
        <div class="flex flex-col gap-xs">
          <label for="${prefix}-month" class="text-[1.25rem] leading-normal font-bold text-bb-black-00">Month</label>
          <div class="${INPUT_WRAP_CLS}" style="width:5rem" id="${prefix}-month-wrap">
            <input type="text" id="${prefix}-month" name="${prefix}-month" inputmode="numeric" maxlength="2"
              class="${INPUT_CLS}" value="${_esc(D[prefix + '-month'])}" oninput="GovBB.D['${prefix}-month']=this.value" />
          </div>
        </div>
        <div class="flex flex-col gap-xs">
          <label for="${prefix}-year" class="text-[1.25rem] leading-normal font-bold text-bb-black-00">Year</label>
          <div class="${INPUT_WRAP_CLS}" style="width:7rem" id="${prefix}-year-wrap">
            <input type="text" id="${prefix}-year" name="${prefix}-year" inputmode="numeric" maxlength="4"
              class="${INPUT_CLS}" value="${_esc(D[prefix + '-year'])}" oninput="GovBB.D['${prefix}-year']=this.value" />
          </div>
        </div>
      </div>
      <p class="text-bb-red-00 text-[1rem] hidden" id="${prefix}-err"></p>
    </div>`;
  }

  function radioGroup(name, label, options, opts) {
    opts = opts || {};
    const hint = opts.hint || '';
    const optionsHtml = options.map(function (o) {
      var val = typeof o === 'object' ? o.value : o;
      var text = typeof o === 'object' ? o.label : o;
      var checked = D[name] === val;
      return `<div class="flex gap-5 items-center">
        <button type="button" role="radio" aria-checked="${checked}" onclick="GovBB.selectRadio('${name}','${val}')"
          class="${RADIO_CLS}" data-radio="${name}" data-value="${val}">
          <span class="size-6 rounded-full bg-bb-teal-00 ${checked ? '' : 'hidden'}"></span>
        </button>
        <label class="text-[1.25rem] leading-normal text-bb-black-00 cursor-pointer" onclick="GovBB.selectRadio('${name}','${val}')">${text}</label>
      </div>`;
    }).join('');
    return `<div class="flex flex-col gap-s items-start w-full">
      <p class="text-[1.25rem] leading-normal font-bold text-bb-black-00">${label}</p>
      ${hint ? `<p class="text-[1.25rem] leading-normal text-bb-mid-grey-00">${hint}</p>` : ''}
      <p class="text-bb-red-00 text-[1rem] hidden" id="${name}-err"></p>
      ${optionsHtml}
    </div>`;
  }

  function checkboxItem(name, label) {
    var checked = !!D[name];
    return `<div class="flex gap-5 items-center">
      <button type="button" role="checkbox" aria-checked="${checked}" id="${name}-btn"
        onclick="GovBB.toggleCheckbox('${name}')"
        class="${CHECKBOX_CLS}">
        ${checked ? '<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>' : ''}
      </button>
      <label class="text-[1.25rem] leading-normal text-bb-black-00 cursor-pointer" onclick="GovBB.toggleCheckbox('${name}')">${label}</label>
    </div>
    <p class="text-bb-red-00 text-[1rem] hidden" id="${name}-err"></p>`;
  }

  function summaryRow(label, value, changeTo) {
    return `<div class="flex justify-between items-start py-4 border-b border-bb-grey-00">
      <dt class="font-bold w-1/3">${label}</dt>
      <dd class="w-1/3">${value || '<span class="text-bb-mid-grey-00">Not provided</span>'}</dd>
      <dd class="w-1/3 text-right">
        <a href="#" onclick="GovBB.nav('${changeTo}');return false" class="${LINK_CLS}">Change<span class="sr-only"> ${label.toLowerCase()}</span></a>
      </dd>
    </div>`;
  }

  function errorSummary(errors) {
    if (!errors || !errors.length) return '';
    return `<div class="border-l-4 border-bb-red-00 bg-bb-red-10 p-s mb-8" role="alert" id="error-summary">
      <h2 class="text-[1.25rem] font-bold text-bb-red-00 mb-2">There is a problem</h2>
      <ul class="list-none m-0 p-0 space-y-1">
        ${errors.map(function (e) { return `<li><a href="#${e.id}" class="text-bb-red-00 underline underline-offset-2 hover:no-underline">${e.msg}</a></li>`; }).join('')}
      </ul>
    </div>`;
  }

  /* ═══════════════════════════════════════════════
     Validation helpers
     ═══════════════════════════════════════════════ */

  function clearErrors() {
    document.querySelectorAll('[id$="-wrap"]').forEach(function (el) {
      el.classList.remove('border-bb-red-00');
      el.classList.add('border-bb-black-00');
    });
    document.querySelectorAll('[id$="-err"]').forEach(function (el) {
      el.textContent = '';
      el.classList.add('hidden');
    });
    document.querySelectorAll('[aria-invalid]').forEach(function (el) {
      el.removeAttribute('aria-invalid');
    });
    var es = document.getElementById('error-summary');
    if (es) es.remove();
  }

  function showFieldError(id, msg) {
    var wrap = document.getElementById(id + '-wrap');
    var err = document.getElementById(id + '-err');
    if (wrap) {
      wrap.classList.remove('border-bb-black-00');
      wrap.classList.add('border-bb-red-00');
    }
    if (err) {
      err.textContent = msg;
      err.classList.remove('hidden');
    }
    var input = document.getElementById(id);
    if (input) input.setAttribute('aria-invalid', 'true');
  }

  function showErrors(errors) {
    // Insert error summary after the first h1
    var form = _appEl.querySelector('form') || _appEl;
    var h1 = form.querySelector('h1');
    if (h1) {
      h1.insertAdjacentHTML('afterend', errorSummary(errors));
    }
    // Show inline errors
    errors.forEach(function (e) {
      showFieldError(e.id, e.msg);
    });
    // Prefix title with Error:
    document.title = 'Error: ' + document.title.replace(/^Error: /, '');
    // Scroll to error summary
    var summary = document.getElementById('error-summary');
    if (summary) summary.scrollIntoView({ behavior: 'smooth' });
  }

  /* ═══════════════════════════════════════════════
     Interaction handlers
     ═══════════════════════════════════════════════ */

  function selectRadio(name, value) {
    D[name] = value;
    // Update all radio buttons in this group
    document.querySelectorAll('[data-radio="' + name + '"]').forEach(function (btn) {
      var isSelected = btn.dataset.value === value;
      btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
      var dot = btn.querySelector('span');
      if (dot) {
        if (isSelected) dot.classList.remove('hidden');
        else dot.classList.add('hidden');
      }
    });
    // Trigger any onRadioChange callback
    if (_config && typeof _config.onRadioChange === 'function') {
      _config.onRadioChange(name, value);
    }
  }

  function toggleCheckbox(name) {
    D[name] = !D[name];
    render();
  }

  /* ═══════════════════════════════════════════════
     Navigation
     ═══════════════════════════════════════════════ */

  function _getFlow() {
    if (_config && typeof _config.getFlow === 'function') {
      return _config.getFlow();
    }
    return _config ? _config.flow : [];
  }

  function render() {
    var flow = _getFlow();
    var pageId = flow[cur];
    if (!pageId || !_config.pages[pageId]) return;
    _appEl.innerHTML = _config.pages[pageId]();
    window.scrollTo(0, 0);
  }

  function nav(pageId) {
    var flow = _getFlow();
    var idx = flow.indexOf(pageId);
    if (idx !== -1) {
      cur = idx;
      render();
    }
  }

  function back() {
    if (cur > 0) {
      cur--;
      render();
    }
  }

  function next() {
    var flow = _getFlow();
    var pageId = flow[cur];

    // Collect current input values into D
    document.querySelectorAll('input, select, textarea').forEach(function (el) {
      if (el.id && el.type !== 'button') D[el.id] = el.value;
    });

    // Validate (skip start, check, confirmation)
    if (pageId !== 'start' && pageId !== 'check' && pageId !== 'confirmation') {
      clearErrors();
      var errors = _config.validate ? _config.validate(pageId) : [];
      if (errors.length) {
        showErrors(errors);
        return;
      }
    }

    // If about to advance to confirmation, submit to server first
    if (flow[cur + 1] === 'confirmation') {
      submitApplication().then(function () {
        cur++;
        render();
      });
      return;
    }

    // Advance
    if (cur < flow.length - 1) {
      cur++;
      render();
    }
  }

  /* ═══════════════════════════════════════════════
     Form submission
     ═══════════════════════════════════════════════ */

  function submitApplication() {
    return (async function () {
      try {
        var res = await fetch('/api/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            formName: _config.formName,
            formData: Object.assign({}, D),
            userEmail: D['contact-email'] || D['email'] || null,
          }),
        });
        var result = await res.json();
        if (result.referenceNumber) {
          window.__refNumber = result.referenceNumber;
        }
      } catch (e) {
        console.error('Submit failed:', e);
        window.__refNumber = null;
      }
    })();
  }

  /* ═══════════════════════════════════════════════
     Utility
     ═══════════════════════════════════════════════ */

  function _esc(val) {
    if (val == null) return '';
    return String(val).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ═══════════════════════════════════════════════
     Initialization
     ═══════════════════════════════════════════════ */

  function init(config) {
    _config = config;
    _appEl = document.getElementById(config.appElementId || 'app');
    cur = 0;
    render();
  }

  /* ═══════════════════════════════════════════════
     Public API
     ═══════════════════════════════════════════════ */

  var GovBB = {
    // Data
    D: D,
    PARISHES: PARISHES,

    // Navigation
    init: init,
    nav: nav,
    back: back,
    next: next,
    render: render,

    // Template helpers
    backLink: backLink,
    caption: caption,
    continueBtn: continueBtn,
    startBtn: startBtn,
    textField: textField,
    emailField: emailField,
    telField: telField,
    selectField: selectField,
    textareaField: textareaField,
    dateField: dateField,
    radioGroup: radioGroup,
    checkboxItem: checkboxItem,
    summaryRow: summaryRow,
    errorSummary: errorSummary,

    // Validation
    clearErrors: clearErrors,
    showFieldError: showFieldError,
    showErrors: showErrors,

    // Interaction
    selectRadio: selectRadio,
    toggleCheckbox: toggleCheckbox,

    // Submission
    submitApplication: submitApplication,

    // CSS class constants (for custom templates)
    BTN_CLS: BTN_CLS,
    LINK_CLS: LINK_CLS,
    INPUT_WRAP_CLS: INPUT_WRAP_CLS,
    INPUT_CLS: INPUT_CLS,
  };

  window.GovBB = GovBB;

  // Expose common functions as globals for simple onclick handlers
  window.next = next;
  window.back = back;
  window.nav = nav;
  window.goBack = back;
  window.goTo = nav;

})();

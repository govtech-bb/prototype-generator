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

  // D is a sessionStorage-backed data store so form data persists across page loads.
  // Reads/writes sessionStorage under the key 'govbb_form_data'.
  var _storageKey = 'govbb_form_data';
  function _loadData() {
    try { return JSON.parse(sessionStorage.getItem(_storageKey)) || {}; } catch (e) { return {}; }
  }
  function _saveData(d) {
    try { sessionStorage.setItem(_storageKey, JSON.stringify(d)); } catch (e) {}
  }
  var _dataCache = _loadData();
  var D = new Proxy(_dataCache, {
    set: function (obj, prop, val) { obj[prop] = val; _saveData(obj); return true; },
    deleteProperty: function (obj, prop) { delete obj[prop]; _saveData(obj); return true; },
  });

  let cur = 0;           // Current page index
  let _config = null;    // Config set by init()
  let _appEl = null;     // The <main id="app"> element
  let _multiPage = false; // Multi-page mode (separate HTML files per page)

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

  function chatBtn(label) {
    label = label || 'Complete via chat';
    var formFile = window.location.pathname.replace(/^\//, '');
    if (!formFile || !formFile.endsWith('.html')) {
      formFile = window.location.hash ? '' : '';
    }
    var href = '/chat.html?form=' + encodeURIComponent(formFile);
    return `<div class="mt-4 flex gap-4">
      <a href="${href}" class="${LINK_CLS} text-[20px]">${label}</a>
    </div>`;
  }

  function whatsappBtn(label) {
    label = label || 'Complete via WhatsApp';
    var formFile = window.location.pathname.replace(/^\//, '');
    if (!formFile || !formFile.endsWith('.html')) {
      formFile = window.location.hash ? '' : '';
    }
    // Server-side redirect: opens the real WhatsApp app via wa.me/ when
    // LIVE credentials are configured; falls back to the simulator otherwise.
    var href = '/go/whatsapp?form=' + encodeURIComponent(formFile);
    return `<div class="mt-2 flex gap-4 items-center">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="#25d366" xmlns="http://www.w3.org/2000/svg"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
      <a href="${href}" class="${LINK_CLS} text-[20px]">${label}</a>
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

  /* ═══════════════════════════════════════════════
     Lookup helpers (Trident ID, Vehicle)
     ═══════════════════════════════════════════════ */

  /**
   * Render a Trident ID lookup field.
   * Shows an input for National Registration Number with a "Look up" button.
   * On success, displays citizen details and a confirm button.
   * Stores all retrieved fields in GovBB.D with the given fieldPrefix.
   */
  function tridentIdLookup(fieldId, opts) {
    opts = opts || {};
    var label = opts.label || 'What is your National Registration Number?';
    var hint = opts.hint || 'You can find this on your national ID card. For example, 870315-1234';
    return `<div id="${fieldId}-lookup" class="space-y-6">
      <div class="flex flex-col gap-xs w-full items-start">
        <label for="${fieldId}" class="block text-[1.25rem] leading-normal font-bold text-bb-black-00">${label}</label>
        <p class="text-[1.25rem] leading-normal text-bb-mid-grey-00">${hint}</p>
        <div class="flex gap-4 items-end w-full">
          <div class="${INPUT_WRAP_CLS} flex-1" id="${fieldId}-wrap">
            <input type="text" id="${fieldId}" name="${fieldId}" placeholder="YYMMDD-XXXX"
              class="${INPUT_CLS}" value="${_esc(D[fieldId])}" oninput="GovBB.D['${fieldId}']=this.value" />
          </div>
          <button type="button" onclick="GovBB.doTridentLookup('${fieldId}')" class="${BTN_CLS}" id="${fieldId}-lookup-btn">Look up</button>
        </div>
        <p class="text-bb-red-00 text-[1rem] hidden" id="${fieldId}-err"></p>
      </div>
      <div id="${fieldId}-loading" class="hidden items-center gap-3 p-s bg-bb-blue-10 rounded-sm">
        <svg class="animate-spin h-5 w-5 text-bb-teal-00" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
        <span class="text-[1.25rem]">Looking up your details…</span>
      </div>
      <div id="${fieldId}-results" class="hidden"></div>
    </div>`;
  }

  function _renderCitizenResults(fieldId, data) {
    return `<div class="border-2 border-bb-green-00 bg-bb-green-10 rounded-sm p-6 space-y-4">
      <div class="flex items-center gap-2 mb-2">
        <svg class="h-6 w-6 text-bb-green-00" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
        <p class="text-[1.25rem] font-bold text-bb-green-00">We found your details</p>
      </div>
      <p class="text-[1.25rem] text-bb-black-00">Please check these are correct before continuing.</p>
      <dl class="divide-y divide-bb-grey-00 border-t border-bb-grey-00">
        <div class="flex py-3"><dt class="font-bold w-2/5">Name</dt><dd>${_esc(data.firstName)}${data.middleName ? ' ' + _esc(data.middleName) : ''} ${_esc(data.lastName)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Date of birth</dt><dd>${_esc(data.dateOfBirth.day)}/${_esc(data.dateOfBirth.month)}/${_esc(data.dateOfBirth.year)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Gender</dt><dd>${_esc(data.gender)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Email</dt><dd>${_esc(data.email)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Mobile</dt><dd>${_esc(data.mobile)}</dd></div>
        ${data.landline ? `<div class="flex py-3"><dt class="font-bold w-2/5">Landline</dt><dd>${_esc(data.landline)}</dd></div>` : ''}
        <div class="flex py-3"><dt class="font-bold w-2/5">Address</dt><dd>${_esc(data.streetAddress)}, ${_esc(data.parish)} ${_esc(data.postalCode)}</dd></div>
      </dl>
      <div class="flex gap-4 mt-4">
        <button type="button" onclick="GovBB._confirmTridentId('${fieldId}')" class="${BTN_CLS}">Yes, this is correct</button>
        <button type="button" onclick="GovBB._retryLookup('${fieldId}')" class="${BTN_CLS} bg-bb-white-00 !text-bb-black-00 border-2 border-bb-black-00 hover:bg-bb-grey-00">No, try again</button>
      </div>
    </div>`;
  }

  async function doTridentLookup(fieldId) {
    var val = D[fieldId] || (document.getElementById(fieldId) ? document.getElementById(fieldId).value : '');
    D[fieldId] = val;

    if (!val.trim()) {
      clearErrors();
      showFieldError(fieldId, 'Enter your National Registration Number');
      return;
    }

    // Show loading
    var loadingEl = document.getElementById(fieldId + '-loading');
    var resultsEl = document.getElementById(fieldId + '-results');
    var lookupBtn = document.getElementById(fieldId + '-lookup-btn');
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (loadingEl) loadingEl.classList.add('flex');
    if (resultsEl) resultsEl.classList.add('hidden');
    if (lookupBtn) lookupBtn.disabled = true;
    clearErrors();

    try {
      var res = await fetch('/api/trident-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nationalId: val.trim() }),
      });
      var result = await res.json();

      if (loadingEl) loadingEl.classList.add('hidden');
      if (loadingEl) loadingEl.classList.remove('flex');
      if (lookupBtn) lookupBtn.disabled = false;

      if (!result.success) {
        showFieldError(fieldId, result.error);
        return;
      }

      // Store the retrieved data
      D['_tridentData'] = result.data;
      if (resultsEl) {
        resultsEl.innerHTML = _renderCitizenResults(fieldId, result.data);
        resultsEl.classList.remove('hidden');
      }
    } catch (err) {
      if (loadingEl) loadingEl.classList.add('hidden');
      if (lookupBtn) lookupBtn.disabled = false;
      showFieldError(fieldId, 'Could not connect to the Trident ID service. Please try again.');
    }
  }

  function _confirmTridentId(fieldId) {
    var data = D['_tridentData'];
    if (!data) return;

    // Copy all citizen fields into the form data store
    D['first-name'] = data.firstName;
    D['middle-name'] = data.middleName || '';
    D['last-name'] = data.lastName;
    D['dob-day'] = data.dateOfBirth.day;
    D['dob-month'] = data.dateOfBirth.month;
    D['dob-year'] = data.dateOfBirth.year;
    D['gender'] = data.gender;
    D['contact-email'] = data.email;
    D['email'] = data.email;
    D['mobile'] = data.mobile;
    D['landline'] = data.landline || '';
    D['street-address'] = data.streetAddress;
    D['parish'] = data.parish;
    D['postal-code'] = data.postalCode;
    D['national-insurance'] = data.nationalInsurance || '';
    D['_tridentConfirmed'] = true;

    next();
  }

  function _retryLookup(fieldId) {
    var resultsEl = document.getElementById(fieldId + '-results');
    if (resultsEl) resultsEl.classList.add('hidden');
    D['_tridentData'] = null;
    var input = document.getElementById(fieldId);
    if (input) { input.value = ''; input.focus(); }
    D[fieldId] = '';
  }

  /**
   * Render a vehicle lookup field.
   * Shows an input for licence plate with a "Look up" button.
   * On success, displays vehicle details and a confirm button.
   */
  function vehicleLookup(fieldId, opts) {
    opts = opts || {};
    var label = opts.label || 'What is your vehicle licence plate number?';
    var hint = opts.hint || 'For example, B 1234';
    return `<div id="${fieldId}-lookup" class="space-y-6">
      <div class="flex flex-col gap-xs w-full items-start">
        <label for="${fieldId}" class="block text-[1.25rem] leading-normal font-bold text-bb-black-00">${label}</label>
        <p class="text-[1.25rem] leading-normal text-bb-mid-grey-00">${hint}</p>
        <div class="flex gap-4 items-end w-full">
          <div class="${INPUT_WRAP_CLS} flex-1" id="${fieldId}-wrap">
            <input type="text" id="${fieldId}" name="${fieldId}" placeholder="B 1234"
              class="${INPUT_CLS}" value="${_esc(D[fieldId])}" oninput="GovBB.D['${fieldId}']=this.value" />
          </div>
          <button type="button" onclick="GovBB.doVehicleLookup('${fieldId}')" class="${BTN_CLS}" id="${fieldId}-lookup-btn">Look up</button>
        </div>
        <p class="text-bb-red-00 text-[1rem] hidden" id="${fieldId}-err"></p>
      </div>
      <div id="${fieldId}-loading" class="hidden items-center gap-3 p-s bg-bb-blue-10 rounded-sm">
        <svg class="animate-spin h-5 w-5 text-bb-teal-00" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
        <span class="text-[1.25rem]">Looking up vehicle details…</span>
      </div>
      <div id="${fieldId}-results" class="hidden"></div>
    </div>`;
  }

  function _renderVehicleResults(fieldId, data) {
    return `<div class="border-2 border-bb-green-00 bg-bb-green-10 rounded-sm p-6 space-y-4">
      <div class="flex items-center gap-2 mb-2">
        <svg class="h-6 w-6 text-bb-green-00" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
        <p class="text-[1.25rem] font-bold text-bb-green-00">We found your vehicle</p>
      </div>
      <p class="text-[1.25rem] text-bb-black-00">Please check these details are correct before continuing.</p>
      <dl class="divide-y divide-bb-grey-00 border-t border-bb-grey-00">
        <div class="flex py-3"><dt class="font-bold w-2/5">Licence plate</dt><dd>${_esc(data.plate)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Make</dt><dd>${_esc(data.make)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Model</dt><dd>${_esc(data.model)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Year</dt><dd>${_esc(data.year)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Current colour</dt><dd>${_esc(data.colour)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Engine number</dt><dd>${_esc(data.engineNumber)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Chassis number</dt><dd>${_esc(data.chassisNumber)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Registered owner</dt><dd>${_esc(data.ownerName)}</dd></div>
      </dl>
      <div class="flex gap-4 mt-4">
        <button type="button" onclick="GovBB._confirmVehicle('${fieldId}')" class="${BTN_CLS}">Yes, this is correct</button>
        <button type="button" onclick="GovBB._retryLookup('${fieldId}')" class="${BTN_CLS} bg-bb-white-00 !text-bb-black-00 border-2 border-bb-black-00 hover:bg-bb-grey-00">No, try again</button>
      </div>
    </div>`;
  }

  async function doVehicleLookup(fieldId) {
    var val = D[fieldId] || (document.getElementById(fieldId) ? document.getElementById(fieldId).value : '');
    D[fieldId] = val;

    if (!val.trim()) {
      clearErrors();
      showFieldError(fieldId, 'Enter your vehicle licence plate number');
      return;
    }

    // Show loading
    var loadingEl = document.getElementById(fieldId + '-loading');
    var resultsEl = document.getElementById(fieldId + '-results');
    var lookupBtn = document.getElementById(fieldId + '-lookup-btn');
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (loadingEl) loadingEl.classList.add('flex');
    if (resultsEl) resultsEl.classList.add('hidden');
    if (lookupBtn) lookupBtn.disabled = true;
    clearErrors();

    try {
      var res = await fetch('/api/vehicle-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plate: val.trim() }),
      });
      var result = await res.json();

      if (loadingEl) loadingEl.classList.add('hidden');
      if (loadingEl) loadingEl.classList.remove('flex');
      if (lookupBtn) lookupBtn.disabled = false;

      if (!result.success) {
        showFieldError(fieldId, result.error);
        return;
      }

      D['_vehicleData'] = result.data;
      if (resultsEl) {
        resultsEl.innerHTML = _renderVehicleResults(fieldId, result.data);
        resultsEl.classList.remove('hidden');
      }
    } catch (err) {
      if (loadingEl) loadingEl.classList.add('hidden');
      if (lookupBtn) lookupBtn.disabled = false;
      showFieldError(fieldId, 'Could not connect to the Licensing Authority. Please try again.');
    }
  }

  function _confirmVehicle(fieldId) {
    var data = D['_vehicleData'];
    if (!data) return;

    D['vehicle-plate'] = data.plate;
    D['vehicle-make'] = data.make;
    D['vehicle-model'] = data.model;
    D['vehicle-year'] = data.year;
    D['vehicle-colour'] = data.colour;
    D['vehicle-engine'] = data.engineNumber;
    D['vehicle-chassis'] = data.chassisNumber;
    D['vehicle-owner'] = data.ownerName;
    D['_vehicleConfirmed'] = true;

    next();
  }

  /**
   * Render a business/company lookup field.
   * Shows an input for Company Registration Number with a "Look up" button.
   * On success, displays business details and a confirm button.
   */
  function businessLookup(fieldId, opts) {
    opts = opts || {};
    var label = opts.label || 'What is the Company Registration Number?';
    var hint = opts.hint || 'You can find this on the CAIPO certificate of incorporation. For example, BB-2019-04521';
    return `<div id="${fieldId}-lookup" class="space-y-6">
      <div class="flex flex-col gap-xs w-full items-start">
        <label for="${fieldId}" class="block text-[1.25rem] leading-normal font-bold text-bb-black-00">${label}</label>
        <p class="text-[1.25rem] leading-normal text-bb-mid-grey-00">${hint}</p>
        <div class="flex gap-4 items-end w-full">
          <div class="${INPUT_WRAP_CLS} flex-1" id="${fieldId}-wrap">
            <input type="text" id="${fieldId}" name="${fieldId}" placeholder="BB-YYYY-NNNNN"
              class="${INPUT_CLS}" value="${_esc(D[fieldId])}" oninput="GovBB.D['${fieldId}']=this.value" />
          </div>
          <button type="button" onclick="GovBB.doBusinessLookup('${fieldId}')" class="${BTN_CLS}" id="${fieldId}-lookup-btn">Look up</button>
        </div>
        <p class="text-bb-red-00 text-[1rem] hidden" id="${fieldId}-err"></p>
      </div>
      <div id="${fieldId}-loading" class="hidden items-center gap-3 p-s bg-bb-blue-10 rounded-sm">
        <svg class="animate-spin h-5 w-5 text-bb-teal-00" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
        <span class="text-[1.25rem]">Looking up business details…</span>
      </div>
      <div id="${fieldId}-results" class="hidden"></div>
    </div>`;
  }

  function _renderBusinessResults(fieldId, data) {
    return `<div class="border-2 border-bb-green-00 bg-bb-green-10 rounded-sm p-6 space-y-4">
      <div class="flex items-center gap-2 mb-2">
        <svg class="h-6 w-6 text-bb-green-00" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
        <p class="text-[1.25rem] font-bold text-bb-green-00">We found this business</p>
      </div>
      <p class="text-[1.25rem] text-bb-black-00">Please check these details are correct before continuing.</p>
      <dl class="divide-y divide-bb-grey-00 border-t border-bb-grey-00">
        <div class="flex py-3"><dt class="font-bold w-2/5">Business name</dt><dd>${_esc(data.entityName)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Status</dt><dd>${_esc(data.entityStatus)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Company type</dt><dd>${_esc(data.companyType)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Registration number</dt><dd>${_esc(data.companyRegistrationNumber)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Date of incorporation</dt><dd>${_esc(data.dateOfIncorporation.day)}/${_esc(data.dateOfIncorporation.month)}/${_esc(data.dateOfIncorporation.year)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">Registered address</dt><dd>${_esc(data.registeredOfficeAddress)}, ${_esc(data.parish)} ${_esc(data.postalCode)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">TIN</dt><dd>${_esc(data.tin)}</dd></div>
        <div class="flex py-3"><dt class="font-bold w-2/5">NIS number</dt><dd>${_esc(data.nisNumber)}</dd></div>
        ${data.businessNameRegistration ? `<div class="flex py-3"><dt class="font-bold w-2/5">Business name reg.</dt><dd>${_esc(data.businessNameRegistration)}</dd></div>` : ''}
        <div class="flex py-3"><dt class="font-bold w-2/5">Directors</dt><dd>${_esc(data.directors)}</dd></div>
      </dl>
      <div class="flex gap-4 mt-4">
        <button type="button" onclick="GovBB._confirmBusiness('${fieldId}')" class="${BTN_CLS}">Yes, this is correct</button>
        <button type="button" onclick="GovBB._retryLookup('${fieldId}')" class="${BTN_CLS} bg-bb-white-00 !text-bb-black-00 border-2 border-bb-black-00 hover:bg-bb-grey-00">No, try again</button>
      </div>
    </div>`;
  }

  async function doBusinessLookup(fieldId) {
    var val = D[fieldId] || (document.getElementById(fieldId) ? document.getElementById(fieldId).value : '');
    D[fieldId] = val;

    if (!val.trim()) {
      clearErrors();
      showFieldError(fieldId, 'Enter the Company Registration Number');
      return;
    }

    var loadingEl = document.getElementById(fieldId + '-loading');
    var resultsEl = document.getElementById(fieldId + '-results');
    var lookupBtn = document.getElementById(fieldId + '-lookup-btn');
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (loadingEl) loadingEl.classList.add('flex');
    if (resultsEl) resultsEl.classList.add('hidden');
    if (lookupBtn) lookupBtn.disabled = true;
    clearErrors();

    try {
      var res = await fetch('/api/business-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registrationNumber: val.trim() }),
      });
      var result = await res.json();

      if (loadingEl) loadingEl.classList.add('hidden');
      if (loadingEl) loadingEl.classList.remove('flex');
      if (lookupBtn) lookupBtn.disabled = false;

      if (!result.success) {
        showFieldError(fieldId, result.error);
        return;
      }

      D['_businessData'] = result.data;
      if (resultsEl) {
        resultsEl.innerHTML = _renderBusinessResults(fieldId, result.data);
        resultsEl.classList.remove('hidden');
      }
    } catch (err) {
      if (loadingEl) loadingEl.classList.add('hidden');
      if (lookupBtn) lookupBtn.disabled = false;
      showFieldError(fieldId, 'Could not connect to the CAIPO registry. Please try again.');
    }
  }

  function _confirmBusiness(fieldId) {
    var data = D['_businessData'];
    if (!data) return;

    D['business-reg'] = data.companyRegistrationNumber;
    D['business-name'] = data.entityName;
    D['business-status'] = data.entityStatus;
    D['business-type'] = data.companyType;
    D['business-inc-day'] = data.dateOfIncorporation.day;
    D['business-inc-month'] = data.dateOfIncorporation.month;
    D['business-inc-year'] = data.dateOfIncorporation.year;
    D['business-address'] = data.registeredOfficeAddress;
    D['business-parish'] = data.parish;
    D['business-postal-code'] = data.postalCode;
    D['business-tin'] = data.tin;
    D['business-nis'] = data.nisNumber;
    D['business-name-reg'] = data.businessNameRegistration || '';
    D['business-directors'] = data.directors;
    D['_businessConfirmed'] = true;

    next();
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

  /* ═══════════════════════════════════════════════
     Payment helpers (GOV.UK Pay-style + EZPay)
     ═══════════════════════════════════════════════ */

  var BB_BANKS = [
    'Republic Bank (Barbados) Ltd.',
    'First Citizens (Barbados) Ltd.',
    'CIBC FirstCaribbean International Bank',
    'Scotiabank (Barbados) Ltd.',
    'RBC Royal Bank (Barbados) Ltd.',
    'Sagicor Financial Corporation',
    'Capita Financial Services Inc.',
  ];

  /**
   * Payment method selection page.
   * opts: { amount, description, currency }
   */
  function paymentMethodPage(opts) {
    opts = opts || {};
    var amt = opts.amount || '0.00';
    var desc = opts.description || _config.formName;
    var cur = opts.currency || 'BBD';

    return `<form novalidate>
      ${backLink()}
      ${caption()}
      <h1 class="font-bold text-[3.5rem] leading-[1.15] mb-8">Pay for your application</h1>
      <div class="space-y-8">
        <div class="bg-bb-blue-10 rounded-sm p-6 space-y-2">
          <p class="text-[1.25rem] text-bb-black-00">${_esc(desc)}</p>
          <p class="text-[2rem] font-bold text-bb-black-00">$${_esc(amt)} ${_esc(cur)}</p>
        </div>
        ${radioGroup('payment-method', 'How would you like to pay?', [
          { value: 'card', label: 'Pay by debit or credit card' },
          { value: 'ezpay', label: 'Pay with EZPay (Barbados bank account)' },
        ], { hint: 'EZPay lets you pay directly from your Barbados bank account.' })}
        ${continueBtn()}
      </div>
    </form>`;
  }

  /**
   * Payment details page — card or EZPay fields based on D['payment-method'].
   * opts: { amount, currency }
   */
  function paymentDetailsPage(opts) {
    opts = opts || {};
    var amt = opts.amount || '0.00';
    var cur = opts.currency || 'BBD';
    var method = D['payment-method'];

    if (method === 'ezpay') {
      return _ezpayDetailsPage(amt, cur);
    }
    return _cardDetailsPage(amt, cur);
  }

  function _cardDetailsPage(amt, cur) {
    return `<form novalidate>
      ${backLink()}
      ${caption()}
      <h1 class="font-bold text-[3.5rem] leading-[1.15] mb-8">Enter card details</h1>
      <div class="space-y-8">
        <div class="bg-bb-blue-10 rounded-sm p-4 flex justify-between items-center">
          <span class="text-[1.25rem]">Total to pay</span>
          <span class="text-[1.5rem] font-bold">$${_esc(amt)} ${_esc(cur)}</span>
        </div>

        <div class="flex items-center gap-3 text-bb-mid-grey-00 text-[1rem]">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
          <span>Accepted cards</span>
          <div class="flex gap-2">
            <span class="bg-[#1a1f71] text-white text-[0.7rem] font-bold px-2 py-0.5 rounded">VISA</span>
            <span class="bg-[#eb001b] text-white text-[0.7rem] font-bold px-2 py-0.5 rounded">MC</span>
          </div>
        </div>

        ${textField('card-number', 'Card number', { hint: 'The long number on the front of your card', placeholder: '0000 0000 0000 0000', inputmode: 'numeric', maxlength: '19' })}

        <div class="flex gap-s items-start flex-wrap">
          <div class="flex-1 min-w-[140px]">
            ${textField('card-expiry', 'Expiry date', { hint: 'For example, 03/26', placeholder: 'MM/YY', maxlength: '5' })}
          </div>
          <div class="flex-1 min-w-[140px]">
            ${textField('card-cvc', 'Card security code', { hint: 'The 3 digits on the back of your card', placeholder: '123', inputmode: 'numeric', maxlength: '4', width: 'w-28' })}
          </div>
        </div>

        ${textField('card-name', 'Name on card')}

        <details class="group">
          <summary class="cursor-pointer ${LINK_CLS} text-[1.25rem] list-none">
            <span class="group-open:hidden">+ Use a different billing address</span>
            <span class="hidden group-open:inline">− Hide billing address</span>
          </summary>
          <div class="mt-4 space-y-4 border-l-4 border-bb-blue-40 pl-6">
            ${textField('billing-address-1', 'Address line 1')}
            ${textField('billing-address-2', 'Address line 2 (optional)')}
            ${textField('billing-city', 'Town or city')}
            ${textField('billing-postcode', 'Postcode', { placeholder: 'BB11000', width: 'w-40' })}
          </div>
        </details>

        ${continueBtn()}
      </div>
    </form>`;
  }

  function _ezpayDetailsPage(amt, cur) {
    var bankOpts = BB_BANKS.map(function (b) { return { value: b, label: b }; });
    return `<form novalidate>
      ${backLink()}
      ${caption()}
      <h1 class="font-bold text-[3.5rem] leading-[1.15] mb-8">Pay with EZPay</h1>
      <div class="space-y-8">
        <div class="bg-bb-blue-10 rounded-sm p-4 flex justify-between items-center">
          <span class="text-[1.25rem]">Total to pay</span>
          <span class="text-[1.5rem] font-bold">$${_esc(amt)} ${_esc(cur)}</span>
        </div>

        <div class="flex items-center gap-3 p-4 bg-bb-teal-10 rounded-sm border-l-4 border-bb-teal-00">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <p class="text-[1rem] text-bb-black-00">Your bank details are sent securely. We do not store your account number.</p>
        </div>

        ${selectField('ezpay-bank', 'Your bank', bankOpts)}
        ${textField('ezpay-account', 'Account number', { hint: 'Your Barbados bank account number', inputmode: 'numeric' })}
        ${textField('ezpay-holder', 'Account holder name', { hint: 'The name on your bank account' })}

        ${continueBtn()}
      </div>
    </form>`;
  }

  /**
   * Payment confirmation page — review and "Pay now" button.
   * opts: { amount, description, currency }
   */
  function paymentConfirmPage(opts) {
    opts = opts || {};
    var amt = opts.amount || '0.00';
    var desc = opts.description || _config.formName;
    var cur = opts.currency || 'BBD';
    var method = D['payment-method'];
    var isCard = method === 'card';

    var methodLabel = isCard ? 'Debit/credit card' : 'EZPay (bank transfer)';
    var lastDigits = '';
    if (isCard && D['card-number']) {
      lastDigits = D['card-number'].replace(/\s/g, '').slice(-4);
    }
    var bankName = D['ezpay-bank'] || '';

    return `<form novalidate>
      ${backLink()}
      ${caption()}
      <h1 class="font-bold text-[3.5rem] leading-[1.15] mb-8">Confirm your payment</h1>
      <div class="space-y-8">
        <dl class="divide-y divide-bb-grey-00 border-t border-b border-bb-grey-00">
          <div class="flex justify-between items-center py-4">
            <dt class="font-bold">Description</dt>
            <dd>${_esc(desc)}</dd>
          </div>
          <div class="flex justify-between items-center py-4">
            <dt class="font-bold">Amount</dt>
            <dd class="text-[1.5rem] font-bold">$${_esc(amt)} ${_esc(cur)}</dd>
          </div>
          <div class="flex justify-between items-center py-4">
            <dt class="font-bold">Payment method</dt>
            <dd>${_esc(methodLabel)}${isCard && lastDigits ? ' ending ' + _esc(lastDigits) : ''}${!isCard && bankName ? ' – ' + _esc(bankName) : ''}</dd>
          </div>
        </dl>

        <div id="pay-action">
          <div class="mt-8 flex gap-4">
            <button type="button" onclick="GovBB._processPayment()" class="${BTN_CLS}">
              Pay $${_esc(amt)} ${_esc(cur)}
            </button>
          </div>
          <p class="mt-4 text-[1rem] text-bb-mid-grey-00">By clicking "Pay" you agree to the payment terms.</p>
        </div>

        <div id="pay-processing" class="hidden">
          <div class="flex flex-col items-center justify-center py-12 space-y-4">
            <svg class="animate-spin h-10 w-10 text-bb-teal-00" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
            <p class="text-[1.25rem] font-bold text-bb-black-00">Processing your payment…</p>
            <p class="text-[1rem] text-bb-mid-grey-00">Please do not close this page.</p>
          </div>
        </div>

        <div id="pay-success" class="hidden">
          <div class="border-2 border-bb-green-00 bg-bb-green-10 rounded-sm p-6 space-y-4">
            <div class="flex items-center gap-2">
              <svg class="h-6 w-6 text-bb-green-00" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
              <p class="text-[1.25rem] font-bold text-bb-green-00">Payment successful</p>
            </div>
            <p class="text-[1.25rem]">Your payment of <strong>$${_esc(amt)} ${_esc(cur)}</strong> has been processed.</p>
            <p class="text-[1rem] text-bb-mid-grey-00">We are now submitting your application…</p>
          </div>
        </div>
      </div>
    </form>`;
  }

  /**
   * Process a mock payment — shows spinner, then success, then submits and advances.
   */
  function _processPayment() {
    var actionEl = document.getElementById('pay-action');
    var processingEl = document.getElementById('pay-processing');
    var successEl = document.getElementById('pay-success');

    if (actionEl) actionEl.classList.add('hidden');
    if (processingEl) processingEl.classList.remove('hidden');

    D['_paymentComplete'] = false;
    D['_paymentRef'] = 'PAY-' + Math.random().toString(36).substring(2, 8).toUpperCase();

    // Simulate payment processing (1.5–2.5 seconds)
    setTimeout(function () {
      if (processingEl) processingEl.classList.add('hidden');
      if (successEl) successEl.classList.remove('hidden');
      D['_paymentComplete'] = true;

      // After showing success briefly, auto-advance (submit + confirmation)
      setTimeout(function () {
        next();
      }, 1500);
    }, 1500 + Math.random() * 1000);
  }

  /**
   * Validate payment pages. Returns errors array.
   * Call from the prototype's validate() function:
   *   if (['payment','payment-details','payment-confirm'].includes(pageId))
   *     return GovBB.validatePayment(pageId);
   */
  function validatePayment(pageId) {
    var errors = [];
    if (pageId === 'payment') {
      if (!D['payment-method']) {
        errors.push({ id: 'payment-method', msg: 'Choose how you would like to pay' });
      }
    } else if (pageId === 'payment-details') {
      if (D['payment-method'] === 'card') {
        var num = (D['card-number'] || '').replace(/\s/g, '');
        if (!num) {
          errors.push({ id: 'card-number', msg: 'Enter your card number' });
        } else if (!/^\d{13,19}$/.test(num)) {
          errors.push({ id: 'card-number', msg: 'Enter a valid card number' });
        }
        if (!(D['card-expiry'] || '').trim()) {
          errors.push({ id: 'card-expiry', msg: 'Enter the expiry date' });
        } else if (!/^\d{2}\/\d{2}$/.test((D['card-expiry'] || '').trim())) {
          errors.push({ id: 'card-expiry', msg: 'Enter the expiry date in the format MM/YY' });
        }
        if (!(D['card-cvc'] || '').trim()) {
          errors.push({ id: 'card-cvc', msg: 'Enter the card security code' });
        } else if (!/^\d{3,4}$/.test((D['card-cvc'] || '').trim())) {
          errors.push({ id: 'card-cvc', msg: 'Enter a valid security code (3 or 4 digits)' });
        }
        if (!(D['card-name'] || '').trim()) {
          errors.push({ id: 'card-name', msg: 'Enter the name on your card' });
        }
      } else if (D['payment-method'] === 'ezpay') {
        if (!(D['ezpay-bank'] || '').trim()) {
          errors.push({ id: 'ezpay-bank', msg: 'Choose your bank' });
        }
        if (!(D['ezpay-account'] || '').trim()) {
          errors.push({ id: 'ezpay-account', msg: 'Enter your account number' });
        }
        if (!(D['ezpay-holder'] || '').trim()) {
          errors.push({ id: 'ezpay-holder', msg: 'Enter the account holder name' });
        }
      }
    }
    // payment-confirm has no validation — the Pay button handles it
    return errors;
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

  function _pushState(pageId) {
    var url = '#' + pageId;
    if (window.location.hash !== url) {
      history.pushState({ page: pageId }, '', url);
    }
  }

  function _replaceState(pageId) {
    history.replaceState({ page: pageId }, '', '#' + pageId);
  }

  function render() {
    var flow = _getFlow();
    var pageId = flow[cur];
    if (!pageId || !_config.pages[pageId]) return;
    _appEl.innerHTML = _config.pages[pageId]();
    window.scrollTo(0, 0);
  }

  /** Resolve a page ID to a URL in multi-page mode */
  function _pageUrl(pageId) {
    if (!_multiPage || !_config || !_config.pageFiles) return '#' + pageId;
    return _config.pageFiles[pageId] || (pageId + '.html');
  }

  function nav(pageId) {
    if (_multiPage) {
      _collectInputs();
      window.location.href = _pageUrl(pageId);
      return;
    }
    var flow = _getFlow();
    var idx = flow.indexOf(pageId);
    if (idx !== -1) {
      cur = idx;
      _pushState(pageId);
      render();
    }
  }

  function back() {
    if (_multiPage) {
      _collectInputs();
      var flow = _getFlow();
      if (cur > 0) {
        window.location.href = _pageUrl(flow[cur - 1]);
      }
      return;
    }
    if (cur > 0) {
      cur--;
      var flow = _getFlow();
      _pushState(flow[cur]);
      render();
    }
  }

  /** Collect all current input values into D */
  function _collectInputs() {
    document.querySelectorAll('input, select, textarea').forEach(function (el) {
      if (el.id && el.type !== 'button') D[el.id] = el.value;
    });
  }

  function next() {
    var flow = _getFlow();
    var pageId = flow[cur];

    // Collect current input values into D
    _collectInputs();

    // Validate (skip start, check, confirmation)
    if (pageId !== 'start' && pageId !== 'check' && pageId !== 'confirmation' && pageId !== 'payment-confirm') {
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
        if (_multiPage) {
          window.location.href = _pageUrl('confirmation');
        } else {
          cur++;
          _pushState(flow[cur]);
          render();
        }
      });
      return;
    }

    // Advance
    if (cur < flow.length - 1) {
      if (_multiPage) {
        window.location.href = _pageUrl(flow[cur + 1]);
      } else {
        cur++;
        _pushState(flow[cur]);
        render();
      }
    }
  }

  /* ═══════════════════════════════════════════════
     Form submission
     ═══════════════════════════════════════════════ */

  function submitApplication() {
    // Derive the prototype folder from the URL so the server can look up
    // any per-service meta.json (notification_email override, etc.).
    // Folder-based prototypes live under /<folder>/<page>.html — the
    // folder is the first non-empty path segment and has no dot.
    // Legacy flat files (/foo.html) have no folder; leave it null.
    var _folder = null;
    try {
      var _parts = window.location.pathname.split('/').filter(Boolean);
      if (_parts.length >= 2 && _parts[0].indexOf('.') === -1) {
        _folder = _parts[0];
      }
    } catch (_) { /* non-fatal */ }

    return (async function () {
      try {
        var res = await fetch('/api/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            formName: _config.formName,
            formData: Object.assign({}, _dataCache),
            userEmail: D['contact-email'] || D['email'] || null,
            folder: _folder,
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
    _multiPage = !!config.multiPage;

    var flow = _getFlow();

    if (_multiPage) {
      // Multi-page mode: each page is its own HTML file.
      // Determine current page from config.currentPage (set per-file).
      var currentPage = config.currentPage || flow[0];
      cur = flow.indexOf(currentPage);
      if (cur === -1) cur = 0;

      // If this page has a render function, render it
      if (config.pages && config.pages[currentPage]) {
        _appEl.innerHTML = config.pages[currentPage]();
      }

      // Clear form data on start page
      if (currentPage === 'start') {
        Object.keys(_dataCache).forEach(function (k) { delete D[k]; });
      }
    } else {
      // Single-page mode (legacy): all pages in one HTML file.
      var hash = window.location.hash.replace('#', '');
      var idx = hash ? flow.indexOf(hash) : -1;
      cur = idx !== -1 ? idx : 0;

      _replaceState(flow[cur]);
      render();

      window.addEventListener('popstate', function (e) {
        if (e.state && e.state.page) {
          var flow = _getFlow();
          var idx = flow.indexOf(e.state.page);
          if (idx !== -1) {
            cur = idx;
            render();
          }
        }
      });
    }
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
    chatBtn: chatBtn,
    whatsappBtn: whatsappBtn,
    textField: textField,
    emailField: emailField,
    telField: telField,
    selectField: selectField,
    textareaField: textareaField,
    dateField: dateField,
    radioGroup: radioGroup,
    checkboxItem: checkboxItem,
    tridentIdLookup: tridentIdLookup,
    vehicleLookup: vehicleLookup,
    businessLookup: businessLookup,
    doTridentLookup: doTridentLookup,
    doVehicleLookup: doVehicleLookup,
    doBusinessLookup: doBusinessLookup,
    _confirmTridentId: _confirmTridentId,
    _confirmVehicle: _confirmVehicle,
    _confirmBusiness: _confirmBusiness,
    _retryLookup: _retryLookup,
    summaryRow: summaryRow,
    errorSummary: errorSummary,

    // Payment
    paymentMethodPage: paymentMethodPage,
    paymentDetailsPage: paymentDetailsPage,
    paymentConfirmPage: paymentConfirmPage,
    validatePayment: validatePayment,
    _processPayment: _processPayment,
    BB_BANKS: BB_BANKS,

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

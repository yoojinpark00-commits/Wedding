#!/usr/bin/env node
// Page-content encrypter for the wedding site.
//
// Reads a PLAINTEXT index.html, encrypts the site HTML + translations
// with AES-GCM-256 using a PBKDF2-SHA256-derived key from the password,
// and writes the rebuilt (gated) index.html to the repo root.
//
// Usage:
//   node tools/encrypt_site.mjs <source-index.html> <password>
//
// Workflow:
//   1. Keep an unencrypted copy of index.html somewhere outside the repo
//      (or under tools/_plaintext/, which is gitignored).
//   2. Edit it when you want to change site content.
//   3. Run this script to regenerate the encrypted index.html served by
//      GitHub Pages.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto, randomBytes } from 'node:crypto';
import vm from 'node:vm';

const crypto = webcrypto;
const [,, SRC_ARG, PASSWORD] = process.argv;
if (!SRC_ARG || !PASSWORD) {
  console.error('usage: node tools/encrypt_site.mjs <source-index.html> <password>');
  process.exit(2);
}

const ITERATIONS = 200000;
const REPO_ROOT  = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH   = resolve(REPO_ROOT, 'index.html');
const SRC_PATH   = resolve(SRC_ARG);

const src = readFileSync(SRC_PATH, 'utf8');

// ---- 1. Split into head/gate preamble and the body content we'll encrypt ----
// Everything up to and including the gate overlay stays in clear.
// The gate overlay ends with `</div>\n\n<!-- NAV -->`.
const NAV_MARK = '\n\n<!-- NAV -->';
const navIdx = src.indexOf(NAV_MARK);
if (navIdx === -1) throw new Error('NAV marker not found');
const preamble = src.slice(0, navIdx); // ends with `</div>` of the gate
// Toast div is the last HTML fragment before <script>
const TOAST_END = '<div class="toast" id="toast">Response Sent — See You in Taipei!</div>';
const toastIdx = src.indexOf(TOAST_END);
if (toastIdx === -1) throw new Error('toast marker not found');
const bodyContent = src.slice(navIdx + 2, toastIdx + TOAST_END.length); // skip leading "\n\n"

// ---- 2. Extract the translations object (var T = { ... };) ----
const tStart = src.indexOf('var T =');
const tEndMark = '\n  };\n\n  // ── SET LANGUAGE';
const tEnd = src.indexOf(tEndMark);
if (tStart === -1 || tEnd === -1) throw new Error('T block not found');
// Grab the literal between `= ` and the closing `  }` (inclusive).
const tLiteral = src.slice(src.indexOf('{', tStart), tEnd + '\n  }'.length);
const T = vm.runInNewContext(`(${tLiteral})`);

// ---- 3. Build plaintext JSON and encrypt ----
const plaintext = new TextEncoder().encode(JSON.stringify({ html: bodyContent, T }));
const salt = randomBytes(16);
const iv   = randomBytes(12);

const keyMaterial = await crypto.subtle.importKey(
  'raw', new TextEncoder().encode(PASSWORD), { name: 'PBKDF2' }, false, ['deriveKey']
);
const key = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
  keyMaterial,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt']
);
const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
const ctB64 = Buffer.from(ctBuf).toString('base64');

// ---- 4. Rebuild the file ----
const saltHex = Buffer.from(salt).toString('hex');
const ivHex   = Buffer.from(iv).toString('hex');

const runtime = String.raw`
<main id="site" aria-hidden="true"></main>

<script>
  // =====================================================
  // PAGE-CONTENT ENCRYPTION
  // -----------------------------------------------------
  // Site content (HTML + translations) is encrypted with
  // AES-GCM-256 using a PBKDF2-SHA256-derived key. Neither
  // the password nor the plaintext ever appear in source.
  //
  // To rotate the password, regenerate the site with:
  //   node encrypt_site.mjs <new-password>
  // =====================================================
  const VAULT = {
    saltHex: '__SALT_HEX__',
    ivHex:   '__IV_HEX__',
    iterations: __ITERS__,
    ctB64:   '__CT_B64__',
    sessionKey: 'yz-wedding-session'
  };

  // ── helpers ──
  function hexToBytes(h) {
    var b = new Uint8Array(h.length / 2);
    for (var i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
    return b;
  }
  function b64ToBytes(s) {
    var bin = atob(s), b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }

  // ── gate i18n (pre-unlock UI only) ──
  var GATE_I18N = {
    en: {
      label:'Private Celebration', date:'November 1, 2026',
      title:'Please enter the password',
      sub:'This website is reserved for our wedding guests. The password was included in your invitation.',
      placeholder:'Password', submit:'Enter',
      wrong:'Incorrect password. Please try again.',
      empty:'Please enter the password.',
      locked:'Too many attempts. Please wait a moment and try again.'
    },
    ko: {
      label:'비공개 초대', date:'2026년 11월 1일',
      title:'비밀번호를 입력해 주세요',
      sub:'이 웹사이트는 저희 결혼식 하객분들만을 위한 공간입니다. 비밀번호는 청첩장에 안내되어 있습니다.',
      placeholder:'비밀번호', submit:'입장',
      wrong:'비밀번호가 올바르지 않습니다. 다시 시도해 주세요.',
      empty:'비밀번호를 입력해 주세요.',
      locked:'시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.'
    },
    zh: {
      label:'私人婚禮', date:'2026年11月1日',
      title:'請輸入密碼',
      sub:'本網站僅供婚禮賓客瀏覽。密碼已包含在您的邀請函中。',
      placeholder:'密碼', submit:'進入',
      wrong:'密碼錯誤，請再試一次。',
      empty:'請輸入密碼。',
      locked:'嘗試次數過多，請稍候再試。'
    }
  };

  function setGateLang(lang) {
    if (!GATE_I18N[lang]) lang = 'en';
    var s = GATE_I18N[lang];
    document.getElementById('gate-date').textContent = s.date;
    document.getElementById('gate-label').textContent = s.label;
    document.getElementById('gate-title').textContent = s.title;
    document.getElementById('gate-sub').textContent = s.sub;
    document.getElementById('gate-input').placeholder = s.placeholder;
    document.getElementById('gate-submit').textContent = s.submit;
    document.querySelectorAll('[data-gate-lang]').forEach(function(b) {
      b.classList.toggle('active', b.dataset.gateLang === lang);
    });
    document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : lang;
    window.__gateLang = lang;
  }

  // ── AES-GCM decrypt ──
  async function decryptVault(password) {
    var enc = new TextEncoder();
    var keyMat = await crypto.subtle.importKey(
      'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    var key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: hexToBytes(VAULT.saltHex), iterations: VAULT.iterations, hash: 'SHA-256' },
      keyMat,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    var pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(VAULT.ivHex) },
      key,
      b64ToBytes(VAULT.ctB64)
    );
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // ── site boot: injected after successful decrypt ──
  // These are assigned to window so inline handlers in decrypted HTML work.
  var currentLang = 'en';
  var T = null;

  window.toggleFAQ = function(el) { el.classList.toggle('open'); };

  window.setLang = function(lang) {
    if (!T || !T[lang]) return;
    currentLang = lang;
    document.querySelectorAll('.lang-btn').forEach(function(b) { b.classList.remove('active'); });
    var active = document.querySelector('.lang-btn[onclick*="' + lang + '"]');
    if (active) active.classList.add('active');
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
      var key = el.getAttribute('data-i18n');
      if (T[lang][key] !== undefined) {
        if (key.indexOf('Val') > -1) el.innerHTML = T[lang][key];
        else el.textContent = T[lang][key];
      }
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function(el) {
      var key = el.getAttribute('data-i18n-html');
      if (T[lang][key] !== undefined) el.innerHTML = T[lang][key];
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function(el) {
      var key = el.getAttribute('data-i18n-ph');
      if (T[lang][key]) el.placeholder = T[lang][key];
    });
    updateCountdown();
  };

  function updateCountdown() {
    var el = document.getElementById('countdown');
    if (!el || !T) return;
    var wedding = new Date('2026-11-01T11:00:00+08:00');
    var diff = wedding - new Date();
    if (diff <= 0) { el.textContent = T[currentLang]['countdown.today']; return; }
    var d = Math.floor(diff / 86400000);
    var h = Math.floor((diff % 86400000) / 3600000);
    var m = Math.floor((diff % 3600000) / 60000);
    var s = Math.floor((diff % 60000) / 1000);
    var L = T[currentLang];
    el.textContent = d+' '+L['countdown.days']+' · '+h+' '+L['countdown.hours']+' · '+m+' '+L['countdown.min']+' · '+s+' '+L['countdown.sec'];
  }

  function initReveals() {
    var reveals = document.querySelectorAll('.reveal:not(.visible)');
    var obs = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) { entry.target.classList.add('visible'); obs.unobserve(entry.target); }
      });
    }, { threshold: 0.1 });
    reveals.forEach(function(el) { obs.observe(el); });
  }

  function showToast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function() { t.classList.remove('show'); }, 3500);
  }

  // ── RSVP EDIT-MODE STATE ──
  // If the guest opens "?rsvp=TOKEN" (from their confirmation email) we fetch
  // their existing response, prefill both forms, and switch the submit action
  // from "create" to "update".
  var rsvpEditToken = null;

  function getFormFields(source) {
    if (source === 'page') {
      var form = document.getElementById('page-rsvp');
      return {
        firstName: form.querySelector('[data-field="firstName"]'),
        lastName:  form.querySelector('[data-field="lastName"]'),
        email:     form.querySelector('[data-field="email"]'),
        attending: form.querySelector('[data-field="attending"]'),
        guests:    form.querySelector('[data-field="guests"]'),
        notes:     form.querySelector('[data-field="notes"]'),
        plusOneFirstName: form.querySelector('[data-field="plusOneFirstName"]'),
        plusOneLastName:  form.querySelector('[data-field="plusOneLastName"]'),
        plusOneNotes:     form.querySelector('[data-field="plusOneNotes"]'),
        plusOneWrap:      form.querySelector('[data-plus-one]')
      };
    }
    return {
      firstName: document.getElementById('firstName'),
      lastName:  document.getElementById('lastName'),
      email:     document.getElementById('email'),
      attending: document.getElementById('attending'),
      guests:    document.getElementById('guests'),
      notes:     document.getElementById('notes'),
      plusOneFirstName: document.getElementById('plusOneFirstName'),
      plusOneLastName:  document.getElementById('plusOneLastName'),
      plusOneNotes:     document.getElementById('plusOneNotes'),
      plusOneWrap:      document.querySelector('#page-home [data-plus-one]')
    };
  }

  // Reveal the +1 details when guests==='2', hide (and clear) otherwise.
  function updatePlusOneVisibility(f) {
    if (!f.plusOneWrap) return;
    var show = f.guests && f.guests.value === '2';
    if (show) {
      f.plusOneWrap.removeAttribute('hidden');
    } else {
      f.plusOneWrap.setAttribute('hidden', '');
      // Clear so hidden values never make it into the payload.
      if (f.plusOneFirstName) f.plusOneFirstName.value = '';
      if (f.plusOneLastName)  f.plusOneLastName.value  = '';
      if (f.plusOneNotes)     f.plusOneNotes.value     = '';
    }
  }

  function wirePlusOneToggles() {
    ['home', 'page'].forEach(function(src) {
      var f = getFormFields(src);
      if (!f.guests) return;
      // Initial sync (handles edit-mode prefill where guests is already '2').
      updatePlusOneVisibility(f);
      f.guests.addEventListener('change', function() { updatePlusOneVisibility(f); });
    });
  }

  function applyRSVPButtonLabels() {
    var key = rsvpEditToken ? 'rsvp.update' : 'rsvp.send';
    ['rsvp-btn', 'rsvp-btn-page'].forEach(function(id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.setAttribute('data-i18n', key);
      el.textContent = (T && T[currentLang] && T[currentLang][key])
                     || (rsvpEditToken ? 'Update Response' : 'Send Response');
    });
  }

  function setRSVPEditBannerVisible(visible) {
    document.querySelectorAll('[data-rsvp-banner]').forEach(function(el) {
      if (visible) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
    });
  }

  function prefillRSVP(rsvp) {
    ['home','page'].forEach(function(src) {
      var f = getFormFields(src);
      if (!f.firstName) return;
      f.firstName.value = rsvp.firstName || '';
      f.lastName.value  = rsvp.lastName  || '';
      f.email.value     = rsvp.email     || '';
      if (rsvp.attending) { f.attending.value = rsvp.attending; f.attending.classList.add('selected'); }
      var g = String(rsvp.guests || 1);
      if (g === '1' || g === '2') { f.guests.value = g; f.guests.classList.add('selected'); }
      f.notes.value = rsvp.notes || '';
      if (f.plusOneFirstName) f.plusOneFirstName.value = rsvp.plusOneFirstName || '';
      if (f.plusOneLastName)  f.plusOneLastName.value  = rsvp.plusOneLastName  || '';
      if (f.plusOneNotes)     f.plusOneNotes.value     = rsvp.plusOneNotes     || '';
      updatePlusOneVisibility(f);
    });
  }

  async function initRSVPEditMode() {
    try {
      var params = new URLSearchParams(window.location.search);
      var token = params.get('rsvp');
      if (!token || !/^[a-f0-9]{32}$/i.test(token)) return;
      if (!window.GOOGLE_SCRIPT_URL || window.GOOGLE_SCRIPT_URL.indexOf('YOUR_GOOGLE_SCRIPT_URL') === 0) return;
      var url = window.GOOGLE_SCRIPT_URL
              + (window.GOOGLE_SCRIPT_URL.indexOf('?') >= 0 ? '&' : '?')
              + 'action=get&token=' + encodeURIComponent(token);
      var res = await fetch(url, { method: 'GET' });
      var body = await res.json();
      if (!body || !body.ok || !body.rsvp) return;
      rsvpEditToken = token;
      prefillRSVP(body.rsvp);
      setRSVPEditBannerVisible(true);
      applyRSVPButtonLabels();
    } catch (e) { /* offline / bad response → stay in create mode */ }
  }

  window.submitRSVP = function(source) {
    var L = T[currentLang];
    var f = getFormFields(source);
    var btn = document.getElementById(source === 'page' ? 'rsvp-btn-page' : 'rsvp-btn');
    var firstName = f.firstName.value.trim();
    var lastName  = f.lastName.value.trim();
    var email     = f.email.value.trim();
    var attending = f.attending.value;
    var guests    = f.guests.value;
    var notes     = f.notes.value.trim();
    var p1First   = (f.plusOneFirstName && f.plusOneFirstName.value || '').trim();
    var p1Last    = (f.plusOneLastName  && f.plusOneLastName.value  || '').trim();
    var p1Notes   = (f.plusOneNotes     && f.plusOneNotes.value     || '').trim();
    var emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
    if (!firstName || !lastName) { showToast(L['toast.name']); return; }
    if (!email || !emailOk) { showToast(L['toast.email']); return; }
    if (!attending) { showToast(L['toast.attend']); return; }
    if (guests !== '1' && guests !== '2') guests = '1';
    if (guests === '2' && (!p1First || !p1Last)) {
      showToast(L['toast.plusOneName'] || 'Please enter your +1\'s name');
      return;
    }
    firstName = firstName.slice(0, 60);
    lastName  = lastName.slice(0, 60);
    notes     = notes.slice(0, 500);
    p1First   = p1First.slice(0, 60);
    p1Last    = p1Last.slice(0, 60);
    p1Notes   = p1Notes.slice(0, 500);
    var url = window.GOOGLE_SCRIPT_URL || 'YOUR_GOOGLE_SCRIPT_URL_HERE';
    if (!url || url.indexOf('YOUR_GOOGLE_SCRIPT_URL') === 0) {
      showToast(L['toast.configErr'] || 'RSVP endpoint not configured');
      return;
    }
    var isUpdate = !!rsvpEditToken;
    var payload = {
      action: isUpdate ? 'update' : 'create',
      firstName: firstName, lastName: lastName, email: email,
      attending: attending, guests: guests, notes: notes,
      plusOneFirstName: guests === '2' ? p1First : '',
      plusOneLastName:  guests === '2' ? p1Last  : '',
      plusOneNotes:     guests === '2' ? p1Notes : ''
    };
    if (isUpdate) payload.token = rsvpEditToken;
    btn.textContent = 'SENDING...';
    btn.style.opacity = '0.6'; btn.style.pointerEvents = 'none';
    fetch(url, {
      method: 'POST',
      body: new URLSearchParams(payload),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })
      .then(function(res){ return res.json().catch(function(){ return { ok: true }; }); })
      .then(function(body){
        if (!body || body.ok === false) {
          showToast(L['toast.sendErr'] || 'Could not send. Please try again.');
          return;
        }
        if (isUpdate) {
          showToast(L['toast.updated'] || 'RSVP updated.');
        } else {
          // Backend returns a token → keep the guest in edit mode so a second
          // submit becomes an update instead of a duplicate row.
          if (body.token && /^[a-f0-9]{32}$/i.test(body.token)) {
            rsvpEditToken = body.token;
            setRSVPEditBannerVisible(true);
            applyRSVPButtonLabels();
          } else {
            resetForm(source);
          }
          showToast(L['toast.sent']);
        }
      })
      .catch(function(){ showToast(L['toast.sendErr'] || 'Could not send. Please try again.'); })
      .finally(function(){
        applyRSVPButtonLabels();
        btn.style.opacity='1'; btn.style.pointerEvents='auto';
      });
  };

  function resetForm(source) {
    if (source === 'page') {
      var form = document.getElementById('page-rsvp');
      form.querySelectorAll('.rsvp-field').forEach(function(f) {
        if (f.tagName==='SELECT'){ f.selectedIndex=0; f.classList.remove('selected'); }
        else { f.value=''; }
      });
    } else {
      ['firstName','lastName','email','notes',
       'plusOneFirstName','plusOneLastName','plusOneNotes'].forEach(function(id){
        var el = document.getElementById(id); if (el) el.value='';
      });
      var a = document.getElementById('attending'); if (a) a.selectedIndex=0;
      var g = document.getElementById('guests'); if (g) g.selectedIndex=0;
    }
    // Hide the +1 panel on both forms after a reset.
    document.querySelectorAll('[data-plus-one]').forEach(function(el) {
      el.setAttribute('hidden', '');
    });
  }

  // =====================================================
  // IMPORTANT: Replace with your Google Apps Script URL
  // =====================================================
  window.GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz7XrXIBTZVXGnpVXtMph2t1IBgBrFllcJ4Cbp_6hqBw6n4LPPUYjR3Ijwhe03Vdaki/exec';

  function bootSite(vault) {
    T = vault.T;
    var site = document.getElementById('site');
    site.innerHTML = vault.html;
    site.setAttribute('aria-hidden', 'false');
    document.body.classList.remove('locked');

    // Nav click handlers (originally inline in source).
    document.querySelectorAll('nav a[data-page]').forEach(function(link) {
      link.addEventListener('click', function(e) {
        e.preventDefault();
        var page = this.dataset.page;
        document.querySelectorAll('nav a[data-page]').forEach(function(a) { a.classList.remove('active'); });
        this.classList.add('active');
        document.querySelectorAll('.page-section').forEach(function(s) { s.classList.remove('active'); });
        var target = document.getElementById('page-' + page);
        if (target) target.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'instant' });
        setTimeout(initReveals, 100);
      });
    });

    // Apply preferred language if the gate set one.
    var lang = window.__gateLang || 'en';
    window.setLang(lang);
    applyRSVPButtonLabels();
    updateCountdown();
    setInterval(updateCountdown, 1000);
    initReveals();
    // Bind the +1 reveal/hide on both RSVP forms.
    wirePlusOneToggles();
    // If the guest arrived via an edit link, prefill their existing RSVP.
    initRSVPEditMode();
  }

  // ── gate form wiring ──
  (function initGate() {
    var nav = (navigator.language || 'en').toLowerCase();
    var preferred = nav.indexOf('ko') === 0 ? 'ko'
                  : (nav.indexOf('zh') === 0 ? 'zh' : 'en');
    setGateLang(preferred);

    // Restore previously-decrypted vault for this tab.
    try {
      var cached = sessionStorage.getItem(VAULT.sessionKey);
      if (cached) { bootSite(JSON.parse(cached)); return; }
    } catch (e) { /* ignore */ }

    var form = document.getElementById('gate-form');
    var input = document.getElementById('gate-input');
    var btn = document.getElementById('gate-submit');
    var err = document.getElementById('gate-error');
    var failures = 0;
    var locked = false;

    document.querySelectorAll('[data-gate-lang]').forEach(function(b) {
      b.addEventListener('click', function() { setGateLang(b.dataset.gateLang); err.textContent = ''; });
    });
    setTimeout(function() { try { input.focus(); } catch (e) {} }, 900);

    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      if (locked) return;
      var lang = window.__gateLang || 'en';
      var s = GATE_I18N[lang];
      var pw = input.value;
      if (!pw) { err.textContent = s.empty; return; }
      btn.disabled = true;
      err.textContent = '';
      try {
        var vault = await decryptVault(pw);
        try { sessionStorage.setItem(VAULT.sessionKey, JSON.stringify(vault)); } catch (e) {}
        bootSite(vault);
      } catch (ex) {
        failures++;
        input.value = '';
        err.textContent = s.wrong;
        if (failures >= 3) {
          locked = true;
          var wait = Math.min(60, Math.pow(2, failures - 2)) * 1000;
          err.textContent = s.locked;
          setTimeout(function() { locked = false; btn.disabled = false; err.textContent = ''; }, wait);
        } else {
          btn.disabled = false;
        }
      }
    });
  })();
</script>
</body>
</html>
`;

const filled = runtime
  .replace('__SALT_HEX__', saltHex)
  .replace('__IV_HEX__',   ivHex)
  .replace('__ITERS__',    String(ITERATIONS))
  .replace('__CT_B64__',   ctB64);

const out = preamble + filled;
writeFileSync(OUT_PATH, out);

// ---- 5. Self-test: decrypt to make sure we produced a working vault ----
{
  const keyMat2 = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(PASSWORD), { name: 'PBKDF2' }, false, ['deriveKey']
  );
  const key2 = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMat2,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const pt2 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key2, ctBuf);
  const obj = JSON.parse(new TextDecoder().decode(pt2));
  if (!obj.html || !obj.T || !obj.T.en) throw new Error('self-test: missing fields');
  console.log('ok. bytes=', out.length, 'ct.b64=', ctB64.length,
              'html.len=', obj.html.length, 'T.en.keys=', Object.keys(obj.T.en).length);
}

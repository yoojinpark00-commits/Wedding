/**
 * Yoojin & Zoey — RSVP backend (Google Apps Script).
 *
 * Responsibilities:
 *   1. Store each guest's response in a Google Sheet ("RSVPs").
 *   2. Email the guest a confirmation with a unique edit link.
 *   3. Accept updates via that link so the sheet stays in sync.
 *
 * Deployment:
 *   - Attach this script to a Google Sheet.
 *   - Set SHEET_NAME / CONFIRM_FROM_NAME / WEDDING_SITE_URL below.
 *   - Deploy → New deployment → type "Web app":
 *       Execute as: Me
 *       Who has access: Anyone
 *     Paste the resulting /exec URL into the site's GOOGLE_SCRIPT_URL.
 *
 * Endpoints (same URL, different params/body):
 *   GET  ?action=get&token=XXX        → { ok, rsvp: {...} } | { ok:false, error }
 *   POST action=create (form body)    → { ok, token, mode:"created" }
 *   POST action=update&token=XXX      → { ok, mode:"updated" }
 *
 * Design notes:
 *   - Tokens are 128-bit random hex. Whoever holds a token can edit that RSVP
 *     (same trust model as an unsubscribe link).
 *   - If a create request arrives for an email that already has an RSVP, we
 *     treat it as an update rather than erroring — guests may forget they
 *     already responded.
 *   - All Sheet mutations are wrapped in LockService to avoid interleaving
 *     writes when two guests submit at the same instant.
 */

// ─── CONFIG ─────────────────────────────────────────────────────────────
var SHEET_NAME        = 'RSVPs';
var CONFIRM_FROM_NAME = 'Yoojin & Zoey';
var WEDDING_SITE_URL  = 'https://www.yoojinandzoey.com/';  // no trailing path; edit links append ?rsvp=TOKEN
var RSVP_DEADLINE     = 'September 15, 2026';

// Column order in the sheet. If you reorder columns, update HEADERS accordingly.
var HEADERS = [
  'Timestamp', 'Token', 'First Name', 'Last Name', 'Email',
  'Attending', 'Guests', 'Notes', 'Last Updated'
];

// Cap on total guests (1 = just them, 2 = them + one +1).
var MAX_GUESTS = 2;

// ─── HTTP ENTRY POINTS ──────────────────────────────────────────────────
function doGet(e) {
  try {
    var action = (e.parameter.action || 'get').toLowerCase();
    if (action === 'get') return jsonOut(handleGet(e.parameter));
    return jsonOut({ ok: false, error: 'unknown-action' });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var params = e.parameter || {};
    console.log('doPost params:', JSON.stringify(params));
    var action = (params.action || 'create').toLowerCase();
    var result;
    if (action === 'create')      result = handleCreate(params);
    else if (action === 'update') result = handleUpdate(params);
    else                          result = { ok: false, error: 'unknown-action' };
    console.log('doPost result:', JSON.stringify(result));
    return jsonOut(result);
  } catch (err) {
    console.error('doPost threw:', err && err.stack || err);
    return jsonOut({ ok: false, error: String(err) });
  }
}

// ─── HANDLERS ───────────────────────────────────────────────────────────
function handleGet(p) {
  var token = (p.token || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(token)) return { ok: false, error: 'bad-token' };
  var row = findRowByToken(token);
  if (!row) return { ok: false, error: 'not-found' };
  return { ok: true, rsvp: rowToObject(row.values) };
}

function handleCreate(p) {
  var rec = validateInput(p);
  if (rec.error) return { ok: false, error: rec.error };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet();
    // If this email already responded, update the existing row instead of duplicating.
    var existing = findRowByEmail(rec.email);
    if (existing) {
      return applyUpdate_(sheet, existing, rec, /*sendEmail*/ true, /*updateMode*/ false);
    }
    var token = generateToken();
    var now = new Date();
    sheet.appendRow([
      now, token, rec.firstName, rec.lastName, rec.email,
      rec.attending, rec.guests, rec.notes, now
    ]);
    sendConfirmationEmail_(rec, token, /*updateMode*/ false);
    return { ok: true, token: token, mode: 'created' };
  } finally {
    lock.releaseLock();
  }
}

function handleUpdate(p) {
  var token = (p.token || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(token)) return { ok: false, error: 'bad-token' };
  var rec = validateInput(p);
  if (rec.error) return { ok: false, error: rec.error };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet();
    var target = findRowByToken(token);
    if (!target) return { ok: false, error: 'not-found' };
    return applyUpdate_(sheet, target, rec, /*sendEmail*/ true, /*updateMode*/ true);
  } finally {
    lock.releaseLock();
  }
}

// ─── SHEET HELPERS ──────────────────────────────────────────────────────
function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findRowByToken(token) {
  return findRowBy_(1 /* token col is index 1 in zero-based values array */, token, /*caseInsensitive*/ false);
}

function findRowByEmail(email) {
  return findRowBy_(4 /* email col index */, email, /*caseInsensitive*/ true);
}

function findRowBy_(colIdx, needle, caseInsensitive) {
  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var range = sheet.getRange(2, 1, last - 1, HEADERS.length);
  var rows = range.getValues();
  var target = caseInsensitive ? String(needle).toLowerCase() : String(needle);
  for (var i = 0; i < rows.length; i++) {
    var cell = rows[i][colIdx];
    var val = caseInsensitive ? String(cell).toLowerCase() : String(cell);
    if (val === target) {
      return { rowNumber: i + 2, values: rows[i] };
    }
  }
  return null;
}

function applyUpdate_(sheet, target, rec, sendEmail, updateMode) {
  var now = new Date();
  // Preserve original Timestamp (col 1) and Token (col 2); overwrite the rest.
  var token = String(target.values[1]);
  sheet.getRange(target.rowNumber, 3, 1, 7).setValues([[
    rec.firstName, rec.lastName, rec.email,
    rec.attending, rec.guests, rec.notes, now
  ]]);
  if (sendEmail) sendConfirmationEmail_(rec, token, updateMode);
  return { ok: true, token: token, mode: updateMode ? 'updated' : 'merged' };
}

function rowToObject(values) {
  return {
    firstName: values[2],
    lastName:  values[3],
    email:     values[4],
    attending: values[5],
    guests:    Number(values[6]) || 1,
    notes:     values[7]
  };
}

// ─── VALIDATION ─────────────────────────────────────────────────────────
function validateInput(p) {
  var firstName = sanitize(p.firstName, 60);
  var lastName  = sanitize(p.lastName,  60);
  var email     = sanitize(p.email,     254).toLowerCase();
  var attending = sanitize(p.attending, 40);
  var guests    = parseInt(p.guests, 10);
  var notes     = sanitize(p.notes,     500);

  if (!firstName || !lastName) return { error: 'missing-name' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'bad-email' };
  if (attending !== 'Joyfully Accepts' && attending !== 'Regretfully Declines') {
    return { error: 'bad-attending' };
  }
  if (!(guests >= 1 && guests <= MAX_GUESTS)) guests = 1;
  return { firstName: firstName, lastName: lastName, email: email,
           attending: attending, guests: guests, notes: notes };
}

function sanitize(v, maxLen) {
  if (v == null) return '';
  var s = String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.length > maxLen ? s.substring(0, maxLen) : s;
}

// ─── EMAIL ──────────────────────────────────────────────────────────────
function sendConfirmationEmail_(rec, token, updateMode) {
  var editUrl = WEDDING_SITE_URL + (WEDDING_SITE_URL.indexOf('?') >= 0 ? '&' : '?') + 'rsvp=' + encodeURIComponent(token);
  var attending = rec.attending === 'Joyfully Accepts';
  var greeting  = 'Hi ' + rec.firstName + ',';
  var intro = updateMode
    ? 'Your RSVP has been updated — thank you!'
    : (attending
        ? 'Thank you for your RSVP — we can\'t wait to celebrate with you!'
        : 'Thank you for letting us know. We\'ll miss you, but appreciate the response.');
  var summary = [
    'Name:       ' + rec.firstName + ' ' + rec.lastName,
    'Attending:  ' + (attending ? 'Yes' : 'No'),
    'Guests:     ' + rec.guests + (rec.guests > 1 ? ' (including your +1)' : ''),
    'Notes:      ' + (rec.notes || '—')
  ].join('\n');

  var body = [
    greeting, '',
    intro, '',
    'Event details:',
    '  Yoojin & Zoey\'s Wedding',
    '  November 1, 2026 · Taipei Marriott Hotel',
    '',
    'Your response:',
    summary, '',
    'Need to change something? You can update your RSVP any time before ' + RSVP_DEADLINE + ' here:',
    editUrl, '',
    'With love,',
    'Yoojin & Zoey'
  ].join('\n');

  MailApp.sendEmail({
    to: rec.email,
    name: CONFIRM_FROM_NAME,
    subject: (updateMode ? 'Your RSVP has been updated' : 'Your RSVP is confirmed')
              + ' · Yoojin & Zoey · Nov 1, 2026',
    body: body
  });
}

// ─── UTILS ──────────────────────────────────────────────────────────────
function generateToken() {
  var bytes = [];
  for (var i = 0; i < 16; i++) bytes.push(Math.floor(Math.random() * 256));
  return bytes.map(function(b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

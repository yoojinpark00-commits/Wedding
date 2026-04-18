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

// Column order in the sheet. New columns are appended at the end so existing
// sheets migrate in place (cells at old positions stay untouched). If you
// reorder, update the indexes used in findRowBy_/rowToObject/applyUpdate_.
var HEADERS = [
  'Timestamp', 'Token', 'First Name', 'Last Name', 'Email',
  'Attending', 'Guests', 'Notes', 'Last Updated',
  'Plus One First Name', 'Plus One Last Name', 'Plus One Notes'
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
      rec.attending, rec.guests, rec.notes, now,
      rec.plusOneFirstName, rec.plusOneLastName, rec.plusOneNotes
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
    return sheet;
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    return sheet;
  }
  // Migration: an older deployment only had the first 9 columns. Append any
  // new header cells at the end of row 1 so existing data keeps its position.
  var currentCols = sheet.getLastColumn();
  if (currentCols < HEADERS.length) {
    var missing = HEADERS.slice(currentCols);
    sheet.getRange(1, currentCols + 1, 1, missing.length).setValues([missing]);
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
  sheet.getRange(target.rowNumber, 3, 1, 10).setValues([[
    rec.firstName, rec.lastName, rec.email,
    rec.attending, rec.guests, rec.notes, now,
    rec.plusOneFirstName, rec.plusOneLastName, rec.plusOneNotes
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
    notes:     values[7],
    // Cells 9–11 (0-indexed) are added in v2; legacy rows return undefined,
    // which we normalise to empty strings so the prefill flow works cleanly.
    plusOneFirstName: values[9]  || '',
    plusOneLastName:  values[10] || '',
    plusOneNotes:     values[11] || ''
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
  var p1First   = sanitize(p.plusOneFirstName, 60);
  var p1Last    = sanitize(p.plusOneLastName,  60);
  var p1Notes   = sanitize(p.plusOneNotes,     500);

  if (!firstName || !lastName) return { error: 'missing-name' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'bad-email' };
  if (attending !== 'Joyfully Accepts' && attending !== 'Regretfully Declines') {
    return { error: 'bad-attending' };
  }
  if (!(guests >= 1 && guests <= MAX_GUESTS)) guests = 1;
  // If they're coming solo, wipe any +1 details that slipped in.
  if (guests !== 2) { p1First = ''; p1Last = ''; p1Notes = ''; }
  return { firstName: firstName, lastName: lastName, email: email,
           attending: attending, guests: guests, notes: notes,
           plusOneFirstName: p1First, plusOneLastName: p1Last, plusOneNotes: p1Notes };
}

function sanitize(v, maxLen) {
  if (v == null) return '';
  var s = String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.length > maxLen ? s.substring(0, maxLen) : s;
}

// ─── EMAIL ──────────────────────────────────────────────────────────────
function sendConfirmationEmail_(rec, token, updateMode) {
  var editUrl   = WEDDING_SITE_URL + (WEDDING_SITE_URL.indexOf('?') >= 0 ? '&' : '?') + 'rsvp=' + encodeURIComponent(token);
  var attending = rec.attending === 'Joyfully Accepts';
  var intro     = updateMode
    ? 'Your RSVP has been updated — thank you!'
    : (attending
        ? 'Thank you for your RSVP — we can\'t wait to celebrate with you!'
        : 'Thank you for letting us know. We\'ll miss you, but appreciate the response.');

  // Plain-text fallback (for clients that don't render HTML).
  var plainLines = [
    'Hi ' + rec.firstName + ',', '',
    intro, '',
    'Event details:',
    '  Yoojin & Zoey\'s Wedding',
    '  November 1, 2026 · Taipei Marriott Hotel',
    '',
    'Your response:',
    'Name:       ' + rec.firstName + ' ' + rec.lastName,
    'Attending:  ' + (attending ? 'Yes' : 'No'),
    'Guests:     ' + rec.guests + (rec.guests > 1 ? ' (including your +1)' : '')
  ];
  if (rec.guests === 2 && (rec.plusOneFirstName || rec.plusOneLastName)) {
    plainLines.push('Plus One:   ' + (rec.plusOneFirstName + ' ' + rec.plusOneLastName).trim());
    if (rec.plusOneNotes) plainLines.push('+1 Notes:   ' + rec.plusOneNotes);
  }
  plainLines.push('Notes:      ' + (rec.notes || '—'));
  plainLines.push('', 'Need to change something? Update your RSVP any time before ' + RSVP_DEADLINE + ':',
                   editUrl, '', 'With love,', 'Yoojin & Zoey');
  var body = plainLines.join('\n');

  MailApp.sendEmail({
    to: rec.email,
    name: CONFIRM_FROM_NAME,
    subject: (updateMode ? 'Your RSVP has been updated' : 'Your RSVP is confirmed')
              + ' · Yoojin & Zoey · Nov 1, 2026',
    body: body,
    htmlBody: buildConfirmationHtml_(rec, editUrl, updateMode, attending, intro)
  });
}

// Tiny HTML-escape so guest-provided text can't inject markup.
function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Build a table-based HTML email with inline styles, matching the site's
// black/gold/cream aesthetic. Inline everything — most email clients strip
// <style> blocks (Gmail's web client preserves them, but Outlook/Yahoo/etc
// do not), so every rule lives on its element.
function buildConfirmationHtml_(rec, editUrl, updateMode, attending, intro) {
  var eyebrow = updateMode ? 'RSVP Updated' : (attending ? 'RSVP Confirmed' : 'Response Received');
  var heading = updateMode
    ? 'Your response has been updated.'
    : (attending ? 'Thank you for your RSVP.' : 'Thank you for letting us know.');

  var rows = '';
  function row(label, value) {
    rows +=
      '<tr>' +
        '<td style="padding:14px 0 14px 0;font-family:Helvetica,Arial,sans-serif;font-size:10px;letter-spacing:0.22em;color:#7a7670;text-transform:uppercase;width:120px;border-bottom:1px solid #f0ece5;vertical-align:top;">' + esc_(label) + '</td>' +
        '<td style="padding:14px 0 14px 0;font-family:Georgia,serif;font-size:15px;color:#0a0a0a;line-height:1.5;border-bottom:1px solid #f0ece5;">' + value + '</td>' +
      '</tr>';
  }
  row('Name', esc_(rec.firstName + ' ' + rec.lastName));
  row('Attending', attending ? 'Joyfully accepts' : 'Regretfully declines');
  row('Guests', rec.guests === 2 ? 'Two (you + one +1)' : 'Just you');
  if (rec.guests === 2 && (rec.plusOneFirstName || rec.plusOneLastName)) {
    row('Plus One', esc_((rec.plusOneFirstName + ' ' + rec.plusOneLastName).trim()));
    if (rec.plusOneNotes) row('+1 Notes', esc_(rec.plusOneNotes));
  }
  row('Notes', rec.notes ? esc_(rec.notes) : '<span style="color:#a8a49c;">—</span>');

  // Hairline above the signature to separate the note from the CTA.
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Your RSVP</title></head>',
    '<body style="margin:0;padding:0;background:#ece8e1;font-family:Georgia,serif;color:#2a2a2a;-webkit-font-smoothing:antialiased;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ece8e1;">',
      '<tr><td align="center" style="padding:32px 16px;">',
        '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e5dfd2;">',
          // ── Header band ──
          '<tr><td align="center" style="background:#0a0a0a;padding:48px 32px 40px 32px;">',
            '<div style="font-family:\'Playfair Display\',Georgia,serif;font-weight:300;font-size:38px;line-height:1;color:#f8f6f3;letter-spacing:-0.01em;">',
              'Yoojin <span style="color:#c9a96e;font-style:italic;font-family:Georgia,serif;">&amp;</span> Zoey',
            '</div>',
            '<div style="width:40px;height:1px;background:#c9a96e;margin:20px auto 0 auto;line-height:1px;font-size:0;">&nbsp;</div>',
            '<div style="font-family:Helvetica,Arial,sans-serif;font-weight:300;font-size:11px;letter-spacing:0.4em;color:#c9a96e;text-transform:uppercase;margin-top:18px;">',
              'November 1, 2026 &middot; Taipei',
            '</div>',
          '</td></tr>',
          // ── Eyebrow + heading ──
          '<tr><td align="center" style="padding:40px 40px 8px 40px;">',
            '<div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;letter-spacing:0.4em;color:#c9a96e;text-transform:uppercase;margin-bottom:16px;">',
              esc_(eyebrow),
            '</div>',
            '<div style="font-family:Georgia,serif;font-style:italic;font-weight:400;font-size:26px;line-height:1.3;color:#0a0a0a;">',
              esc_(heading),
            '</div>',
          '</td></tr>',
          // ── Greeting + intro ──
          '<tr><td style="padding:24px 40px 24px 40px;font-family:Georgia,serif;font-size:15px;line-height:1.75;color:#2a2a2a;">',
            '<p style="margin:0 0 16px 0;">Hi ' + esc_(rec.firstName) + ',</p>',
            '<p style="margin:0;">' + esc_(intro) + '</p>',
          '</td></tr>',
          // ── Response summary ──
          '<tr><td style="padding:8px 40px 32px 40px;">',
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #e5dfd2;">',
              rows,
            '</table>',
          '</td></tr>',
          // ── CTA ──
          '<tr><td align="center" style="padding:8px 40px 48px 40px;">',
            '<p style="margin:0 0 24px 0;font-family:Georgia,serif;font-size:14px;line-height:1.75;color:#5a554f;">',
              'Need to change something? You can update your response any time before ' + esc_(RSVP_DEADLINE) + '.',
            '</p>',
            '<a href="' + esc_(editUrl) + '" style="display:inline-block;padding:15px 38px;background:#c9a96e;color:#0a0a0a;text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:500;letter-spacing:0.35em;text-transform:uppercase;border:1px solid #c9a96e;">',
              'Update My RSVP',
            '</a>',
            '<p style="margin:18px 0 0 0;font-family:Helvetica,Arial,sans-serif;font-size:10px;letter-spacing:0.1em;color:#a8a49c;word-break:break-all;">',
              'Or copy &amp; paste: ',
              '<a href="' + esc_(editUrl) + '" style="color:#a8a49c;text-decoration:underline;">' + esc_(editUrl) + '</a>',
            '</p>',
          '</td></tr>',
          // ── Footer ──
          '<tr><td align="center" style="background:#faf7f1;border-top:1px solid #e5dfd2;padding:36px 40px 40px 40px;">',
            '<div style="font-family:Georgia,serif;font-style:italic;font-size:15px;color:#5a554f;margin-bottom:10px;">With love,</div>',
            '<div style="font-family:\'Playfair Display\',Georgia,serif;font-weight:300;font-size:24px;color:#0a0a0a;">',
              'Yoojin <span style="color:#c9a96e;font-style:italic;font-family:Georgia,serif;">&amp;</span> Zoey',
            '</div>',
          '</td></tr>',
        '</table>',
      '</td></tr>',
    '</table>',
    '</body></html>'
  ].join('');
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

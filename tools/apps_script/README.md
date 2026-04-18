# RSVP backend — Google Apps Script

A drop-in script that turns a Google Sheet into an RSVP database with email confirmations and edit links.

## One-time setup

1. **Create a Google Sheet** (name it anything, e.g. `YZ Wedding RSVPs`).
2. Open **Extensions → Apps Script**.
3. Delete the starter `Code.gs` content and paste the contents of `Code.gs` from this folder.
4. At the top of the file, set:
   - `WEDDING_SITE_URL` — your site URL (e.g. `https://yoojin-zoey.com/`). Edit links are built as `<URL>?rsvp=TOKEN`.
   - `CONFIRM_FROM_NAME` — the display name on outgoing emails.
5. **Save** (disk icon). Run the `getSheet` function once from the editor to trigger the OAuth prompt (approve "Sheets" + "Gmail send").
6. **Deploy → New deployment**:
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, then copy the Web app URL (ends in `/exec`).
7. Paste that URL into `tools/_plaintext/index.html` as `window.GOOGLE_SCRIPT_URL = '...'`, then re-run:
   ```
   node tools/encrypt_site.mjs tools/_plaintext/index.html 07072019
   ```

## Updating the script later

Any change to `Code.gs` requires a **new deployment** (or a new version of the existing one) for the /exec endpoint to pick up the change. Go to **Deploy → Manage deployments → (pencil icon) → Version: New version → Deploy**. The URL stays the same.

## Endpoints

All requests use `Content-Type: application/x-www-form-urlencoded`.

| Method | Params | Purpose |
|---|---|---|
| `GET` | `action=get&token=XXX` | Look up an existing RSVP by token (used when a guest opens the edit link). |
| `POST` | `action=create&firstName=…&lastName=…&email=…&attending=…&guests=…&notes=…` | Create a new RSVP. If the email already exists, updates instead of duplicating. Emails the guest. |
| `POST` | `action=update&token=XXX&…fields…` | Update the RSVP identified by `token`. Emails the guest a confirmation of the change. |

All responses are JSON: `{ ok: true, token?, mode? }` or `{ ok: false, error }`.

## Gmail quota

`MailApp.sendEmail` from a personal Google account is limited to **~100 emails/day**. Wedding-scale guest lists fit comfortably. If you expect >100, switch to `GmailApp.sendEmail` (uses Gmail quota, same limit) or delegate to a mailing service.

## Privacy

Tokens are 128-bit random hex — anyone with the link can edit that single RSVP, which is intended. Tokens are only ever emailed to the address that submitted the RSVP. The sheet is only visible to you (the sheet owner).

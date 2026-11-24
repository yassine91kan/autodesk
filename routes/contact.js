// routes/contact.js
// ---------------------------------------------------------------------------
// POST /contact          - the landing page's contact form (JSON). Open to everyone,
//                          signed in or not (routes/login.js lets guests send it).
//                          Saved, then emailed to info@askaugmented.com (augmented/mailer.js).
// GET  /admin/contacts   - the messages as a page, newest first. Signed-in users only.
//
// Checked before saving: name, a valid email, a message of a sensible length, a role
// from the list. Spam guards: a hidden "website" field people never fill in (bots do:
// they get a normal "thanks" and nothing is saved), and at most MAX_PER_HOUR messages
// per address. Everything on the admin page is escaped, so "<script>" shows as text.
// ---------------------------------------------------------------------------

const express = require('express');
const { saveMessage, sentRecently, recentMessages, KEEP_DAYS } = require('../augmented/contacts');
const { sendContactEmail } = require('../augmented/mailer');

const router = express.Router();

const MAX_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
const LIMITS = { name: 100, email: 200, company: 120, message: 3000 };
const MIN_MESSAGE = 10;
const ROLES = ['Structural engineer', 'Architect', 'BIM manager', 'Quantity surveyor', 'Contractor', 'Drafter', 'Other'];
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

const clean = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();

// Returns { fields } ready to save, or { error } in plain words (shown under the form).
function checkForm(body) {
    const fields = {
        name: clean(body.name), email: clean(body.email).toLowerCase(), company: clean(body.company),
        role: clean(body.role), message: clean(body.message), lang: body.lang === 'fr' ? 'fr' : 'en'
    };
    if (!fields.name) return { error: 'name' };
    if (!EMAIL.test(fields.email) || fields.email.length > LIMITS.email) return { error: 'email' };
    if (fields.message.length < MIN_MESSAGE) return { error: 'message' };
    for (const [field, max] of Object.entries(LIMITS)) {
        if (fields[field].length > max) return { error: 'tooLong', field };
    }
    if (fields.role && !ROLES.includes(fields.role)) fields.role = 'Other';
    return { fields };
}

router.post('/contact', (req, res) => {
    const body = req.body || {};
    if (clean(body.website)) {
        return res.json({ success: true });   // the hidden field was filled in: a bot. Thank it and save nothing.
    }
    const { fields, error, field } = checkForm(body);
    if (error) {
        return res.status(400).json({ success: false, error, field });
    }
    try {
        if (sentRecently(req.ip, HOUR_MS) >= MAX_PER_HOUR) {
            return res.status(429).json({ success: false, error: 'tooMany' });
        }
        saveMessage(fields, req.ip);
        console.log(`CONTACT message from ${fields.email}${fields.company ? ` (${fields.company})` : ''}`);
        // A copy by email to info@askaugmented.com (augmented/mailer.js). Not awaited: the
        // message is already saved, so a slow or failed email never delays or breaks the form.
        sendContactEmail(fields).then(result => {
            if (!result.sent && result.reason !== 'RESEND_API_KEY is not set') console.error(`contact email failed: ${result.reason}`);
        });
        return res.json({ success: true });
    } catch (err) {
        console.error('contact form error:', err);
        return res.status(500).json({ success: false, error: 'server' });
    }
});

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

router.get('/admin/contacts', (req, res) => {
    // No req.user = login.js isn't mounted (local tests): treated as signed in, like admin.js.
    if ((req.user?.kind || 'member') !== 'member') {
        return res.status(403).type('text/plain').send('Sign in to see the contact messages.');
    }
    const rows = recentMessages(200).map(m => `<tr>
        <td class="nowrap">${escapeHtml(m.at.slice(0, 16).replace('T', ' '))}</td>
        <td><strong>${escapeHtml(m.name)}</strong><br><a href="mailto:${escapeHtml(m.email)}">${escapeHtml(m.email)}</a>
            ${m.company ? `<br><small>${escapeHtml(m.company)}</small>` : ''}</td>
        <td>${escapeHtml(m.role || '')}<br><small>${escapeHtml(m.lang)}</small></td>
        <td class="msg">${escapeHtml(m.message)}</td></tr>`).join('');

    res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Contact messages</title>
<style>
  :root { --bg: #fff; --fg: #1d1d1b; --muted: #6b6a65; --line: #e2e0d8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1d1d1b; --fg: #ecebe6; --muted: #a3a29b; --line: #3a3936; } }
  body { background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; margin: 0 16px 40px; }
  h1 { font-size: 20px; font-weight: 600; margin: 20px 0 4px; } p, small { color: var(--muted); }
  table { border-collapse: collapse; width: 100%; } a { color: inherit; }
  th, td { border-bottom: 1px solid var(--line); padding: 8px; text-align: left; vertical-align: top; }
  th { font-weight: 600; color: var(--muted); } .nowrap { white-space: nowrap; } .msg { white-space: pre-wrap; max-width: 70ch; }
  .wrap { overflow-x: auto; }
</style></head><body>
<h1>Contact messages</h1>
<p>From the contact form on the landing page, newest first (times in UTC). Kept ${KEEP_DAYS} days. <a href="/admin/questions">Question log</a></p>
<div class="wrap"><table>
<thead><tr><th>When</th><th>From</th><th>Role</th><th>Message</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4"><small>No messages yet.</small></td></tr>'}</tbody>
</table></div>
</body></html>`);
});

module.exports = router;
module.exports.checkForm = checkForm;
module.exports.ROLES = ROLES;
module.exports.MAX_PER_HOUR = MAX_PER_HOUR;

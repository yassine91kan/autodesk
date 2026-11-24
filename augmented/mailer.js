// augmented/mailer.js
// ===========================================================================
// EMAIL - sends a copy of each contact-form message to the team's inbox, through
// Resend (resend.com, a plain HTTPS API: no extra package needed).
//
// Settings (Render > Environment; never in the code):
//   RESEND_API_KEY  the Resend API key. Not set = no email is sent (messages are still
//                   saved and listed at /admin/contacts), so your PC and the tests need nothing.
//   CONTACT_TO      who receives the messages            (default info@askaugmented.com)
//   CONTACT_FROM    the sender, on a domain verified in Resend
//                   (default "Ask Augmented <forms@askaugmented.com>")
//
// The visitor's address goes in Reply-To, so "Reply" in your mail app answers them.
// Sending never blocks or breaks the form: the message is saved first, and an email
// failure is only logged (and the message is still on /admin/contacts).
// ===========================================================================

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10 * 1000;

const settings = () => ({
    key: process.env.RESEND_API_KEY || '',
    to: process.env.CONTACT_TO || 'info@askaugmented.com',
    from: process.env.CONTACT_FROM || 'Ask Augmented <forms@askaugmented.com>'
});

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
// One line, no line breaks: what goes in a subject or a header can't add new headers.
const oneLine = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

// The email for one saved message: { from, to, reply_to, subject, text, html }.
function contactEmail(message, { to, from } = settings()) {
    const rows = [
        ['Name', message.name],
        ['Email', message.email],
        ['Company', message.company || '-'],
        ['Role', message.role || '-'],
        ['Page language', message.lang === 'fr' ? 'French' : 'English']
    ];
    const text = `${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${message.message}\n\n` +
        'Sent from the contact form on askaugmented.com. Reply to this email to answer them. ' +
        'All messages: https://www.askaugmented.com/admin/contacts';
    const html = `<table style="font:14px/1.5 sans-serif;border-collapse:collapse">${rows.map(([k, v]) =>
        `<tr><td style="padding:2px 16px 2px 0;color:#5e5d59">${k}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
<p style="font:15px/1.55 sans-serif;white-space:pre-wrap;border-left:3px solid #c15f3c;padding-left:12px">${escapeHtml(message.message)}</p>
<p style="font:12px/1.5 sans-serif;color:#5e5d59">Sent from the contact form on askaugmented.com. Reply to this email to answer them.
<a href="https://www.askaugmented.com/admin/contacts">All messages</a></p>`;
    return {
        from,
        to: [to],
        reply_to: oneLine(message.email),
        subject: oneLine(`New message from ${message.name}${message.company ? ` (${message.company})` : ''} · Ask Augmented`).slice(0, 200),
        text,
        html
    };
}

// Sends the email. Returns { sent: true } | { sent: false, reason } and never throws.
async function sendContactEmail(message) {
    const config = settings();
    if (!config.key) return { sent: false, reason: 'RESEND_API_KEY is not set' };
    try {
        const response = await fetch(RESEND_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(contactEmail(message, config)),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
        });
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 300);
            console.error(`contact email not sent: Resend answered ${response.status} ${detail}`);
            return { sent: false, reason: `Resend ${response.status}` };
        }
        return { sent: true };
    } catch (error) {
        console.error('contact email not sent:', error.message);
        return { sent: false, reason: error.message };
    }
}

module.exports = { sendContactEmail, contactEmail, RESEND_URL };

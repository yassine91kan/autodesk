// Tests for the contact form (routes/contact.js, augmented/contacts.js): node test/run_contact.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'augmented-contact-'));
process.env.DATA_DIR = tmp;                 // saved on "disk", like Render
process.env.APP_PASSWORD = 'correct horse'; // the sign-in gate is on: guests must still be able to send it
const express = require('express');
const bodyParser = require('body-parser');
const contacts = require('../augmented/contacts');

const app = express();
app.set('trust proxy', 1);
app.use(bodyParser.json());
app.use(require('../routes/login.js'));
app.use(require('../routes/contact.js'));

let base, pass = 0, fail = 0;
function check(name, cond, detail = '') {
    cond ? pass++ : fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? '\n        ' + detail : ''}`);
}
const send = (body, ip = '198.51.100.1') => fetch(base + '/contact', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(body)
});
const good = { name: 'Sam Rivera', email: 'Sam@Example.com', company: 'Rivera Structures', role: 'Structural engineer', message: 'Can we try it on our own Revit model?', lang: 'en' };

(async () => {
    const server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    let r, j;

    console.log('\n=== Sending a message ===');
    r = await send(good); j = await r.json();
    check('a guest (not signed in) can send the form', r.status === 200 && j.success === true, `${r.status} ${JSON.stringify(j)}`);
    let saved = contacts.recentMessages();
    check('...and it is saved, email in lower case', saved.length === 1 && saved[0].email === 'sam@example.com' && saved[0].company === 'Rivera Structures', JSON.stringify(saved));
    check('the IP address itself is never stored', !JSON.stringify(saved).includes('198.51.100.1'));
    check('the saved file is on the disk (DATA_DIR)', fs.existsSync(path.join(tmp, 'contacts.sqlite')));

    console.log('\n=== Checks ===');
    r = await send({ ...good, name: '  ' }); j = await r.json();
    check('no name -> 400 "name"', r.status === 400 && j.error === 'name', JSON.stringify(j));
    r = await send({ ...good, email: 'not-an-email' }); j = await r.json();
    check('a bad email -> 400 "email"', r.status === 400 && j.error === 'email', JSON.stringify(j));
    r = await send({ ...good, message: 'hi' }); j = await r.json();
    check('a message under 10 characters -> 400 "message"', r.status === 400 && j.error === 'message', JSON.stringify(j));
    r = await send({ ...good, company: 'x'.repeat(500) }); j = await r.json();
    check('a field over its limit -> 400 "tooLong" with the field', r.status === 400 && j.error === 'tooLong' && j.field === 'company', JSON.stringify(j));
    r = await send({ ...good, role: 'Supreme leader', email: 'b@example.com' }, '198.51.100.9'); j = await r.json();
    saved = contacts.recentMessages();
    check('a role not in the list is saved as "Other"', j.success && saved[0].role === 'Other', JSON.stringify(saved[0]));

    console.log('\n=== Spam guards ===');
    const before = contacts.recentMessages().length;
    r = await send({ ...good, website: 'http://spam.example' }, '198.51.100.7'); j = await r.json();
    check('the hidden field filled in (a bot): "thanks", but nothing saved', r.status === 200 && j.success === true && contacts.recentMessages().length === before);
    const ip = '203.0.113.5';
    const results = [];
    for (let i = 0; i < 6; i++) results.push((await send({ ...good, email: `p${i}@example.com` }, ip)).status);
    check('at most 5 messages per hour from one address: the 6th gets 429', results.slice(0, 5).every(s => s === 200) && results[5] === 429, results.join(','));

    console.log('\n=== The email copy to info@askaugmented.com ===');
    // A stand-in for Resend: requests to its address are captured here, nothing is sent.
    const realFetch = globalThis.fetch;
    const sent = [];
    let resendStatus = 200;
    globalThis.fetch = async (url, options) => {
        if (String(url).startsWith('https://api.resend.com/')) {
            sent.push({ url, headers: options.headers, body: JSON.parse(options.body) });
            return new Response(JSON.stringify({ id: 'test' }), { status: resendStatus });
        }
        return realFetch(url, options);
    };
    const settle = () => new Promise(r => setTimeout(r, 150));
    delete process.env.RESEND_API_KEY;
    await send({ ...good, email: 'nokey@example.com' }, '198.51.100.30'); await settle();
    check('without RESEND_API_KEY no email is attempted (your PC, the tests)', sent.length === 0);
    process.env.RESEND_API_KEY = 'test-key';
    r = await send({ ...good, name: 'Ana <b>Lima</b>', email: 'ana@example.com', message: 'Line one\nLine two <script>x</script>' }, '198.51.100.31'); await settle();
    const mail = sent[0]?.body || {};
    check('with a key: the message is emailed through Resend', r.status === 200 && sent.length === 1 && sent[0].headers.Authorization === 'Bearer test-key', JSON.stringify(sent[0]?.headers));
    check('...to info@askaugmented.com, from the site\'s own address', JSON.stringify(mail.to) === '["info@askaugmented.com"]' && /@askaugmented\.com>$/.test(mail.from), `${mail.to} ${mail.from}`);
    check('...with Reply-To = the visitor, so "Reply" answers them', mail.reply_to === 'ana@example.com');
    check('...the subject names the sender and company', mail.subject === 'New message from Ana <b>Lima</b> (Rivera Structures) · Ask Augmented', mail.subject);
    check('...HTML in what they typed is shown as text, never run', (mail.html || '').includes('&lt;script&gt;x&lt;/script&gt;') && !(mail.html || '').includes('<script>') && (mail.html || '').includes('Ana &lt;b&gt;Lima&lt;/b&gt;'));
    check('...and the plain-text version keeps their line breaks', (mail.text || '').includes('Line one\nLine two'));
    process.env.CONTACT_TO = 'team@example.com';
    await send({ ...good, email: 'to@example.com' }, '198.51.100.32'); await settle();
    check('CONTACT_TO changes the recipient', JSON.stringify(sent[1]?.body.to) === '["team@example.com"]');
    delete process.env.CONTACT_TO;
    resendStatus = 500;
    const savedBefore = contacts.recentMessages().length;
    r = await send({ ...good, email: 'down@example.com' }, '198.51.100.33'); await settle();
    check('Resend failing: the visitor still gets "thanks" and the message is still saved', r.status === 200 && contacts.recentMessages().length === savedBefore + 1);
    resendStatus = 200;
    await send({ ...good, name: 'Eve\r\nBcc: victim@example.com', email: 'eve@example.com' }, '198.51.100.34'); await settle();
    check('line breaks in the name can\'t add email headers', !/[\r\n]/.test(sent[sent.length - 1].body.subject));
    delete process.env.RESEND_API_KEY;
    globalThis.fetch = realFetch;

    console.log('\n=== The admin page ===');
    await send({ ...good, name: '<script>alert(1)</script>', email: 'x@example.com' }, '198.51.100.20');
    r = await fetch(base + '/admin/contacts');
    check('guests can\'t read the messages (403)', r.status === 403, `${r.status}`);
    // signed in: log in with the password and use the session cookie
    const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse' }) });
    const cookie = (login.headers.get('set-cookie') || '').split(',').map(c => c.trim()).find(c => c.startsWith('augmented_session='))?.split(';')[0];
    if (cookie) {
        r = await fetch(base + '/admin/contacts', { headers: { Cookie: cookie } });
        const html = await r.text();
        check('signed in: the page lists the messages', r.status === 200 && html.includes('Rivera Structures'), `${r.status}`);
        check('names are escaped: "<script>" shows as text, never runs', html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !html.includes('<script>alert(1)'));
    } else {
        check('signed in: could log in for the admin check', false, `login ${login.status}: no session cookie`);
    }

    server.close();
    contacts.closeContacts();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('TEST ERROR', e); process.exit(1); });

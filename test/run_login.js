// Tests for routes/login.js: node test/run_login.js
process.env.APP_PASSWORD = 'correct horse';
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(bodyParser.urlencoded({ extended: true }));
app.use(require('../routes/login.js'));
// The pages as server.js serves them: / = landing page, /app = the app (routes/pages.js).
app.use(require('../routes/pages.js'));
app.use(express.static(path.join(__dirname, '..', 'wwwroot'), { index: false }));
// A stand-in for the chatbot: checks the budget like the real route, "uses" 6,000
// tokens per question, and says WHO asked, so the tests can see users kept apart.
const usage = require('../routes/usage.js');
app.post('/ask_agent_simple', (req, res) => {
    const refused = usage.checkBefore(req);
    if (refused) return res.status(refused.status).json({ success: false, limitReached: Boolean(refused.limitReached), message: refused.message });
    usage.recordAfter(req, 6000);
    res.json({ success: true, user: req.user.id, answer: 'model data', budget: usage.budgetOf(req) });
});
app.post('/api/models', (req, res) => res.json({ success: true, uploaded: true }));
app.post('/feedback', (req, res) => res.json({ gate: 'passed' }));   // stand-in: only the gate is tested here
app.use(require('../routes/admin.js'));

let base, pass = 0, fail = 0;
function check(name, cond, detail = '') {
    cond ? pass++ : fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n        ' + detail : ''}`);
}
const get = (p, headers = {}) => fetch(base + p, { redirect: 'manual', headers });
const post = (p, form, headers = {}) => fetch(base + p, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString()
});
const HTML = { Accept: 'text/html' };
const askAs = (cookie, ip = '192.0.2.1') => fetch(base + '/ask_agent_simple', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) }, body: '{"prompt":"x"}'
});
const guestCookieOf = r => (r.headers.get('set-cookie') || '').split(',').map(c => c.trim()).find(c => c.startsWith('augmented_guest='))?.split(';')[0];

(async () => {
    const server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    let r;

    console.log('\n=== Guests: open the link and ask, no password ===');
    r = await get('/', HTML);
    check('"/" is the landing page', r.status === 200 && (await r.text()).includes('What you can ask'), `${r.status}`);
    r = await get('/app', HTML);
    check('opening the app (/app) -> the app itself, no redirect, no .html', r.status === 200 && (await r.text()).includes('main.js'), `${r.status}`);
    const guestSet = r.headers.get('set-cookie') || '';
    check('...and the browser gets a guest cookie (HttpOnly, 1 year)', /augmented_guest=/.test(guestSet) && /HttpOnly/.test(guestSet) && /Max-Age=31536000/.test(guestSet), guestSet);
    r = await get('/landing.html', HTML);
    check('old address /landing.html -> 301 to /', r.status === 301 && r.headers.get('location') === '/', `${r.status} ${r.headers.get('location')}`);
    r = await get('/index.html', HTML);
    check('old address /index.html -> 301 to /app', r.status === 301 && r.headers.get('location') === '/app', `${r.status} ${r.headers.get('location')}`);
    r = await get('/login', HTML);
    const page = await r.text();
    check('sign-in page loads', r.status === 200 && page.includes('Sign in') && page.includes('name="password"'));
    for (const file of ['/assets/css/drawing-sheet.css', '/assets/css/login.css', '/assets/images/augmented-mark.svg', '/assets/images/favicon.svg']) {
        r = await get(file);
        check(`the page's own file loads: ${file}`, r.status === 200, `status ${r.status}`);
    }
    r = await get('/main.js');
    check('app files load for guests (main.js)', r.status === 200, `status ${r.status}`);

    r = await askAs(null, '192.0.2.10');
    const guestA = guestCookieOf(r);
    const answerA = await r.json();
    r = await askAs(null, '192.0.2.11');
    const guestB = guestCookieOf(r);
    const answerB = await r.json();
    check('two visitors -> two different guest ids', guestA && guestB && answerA.user !== answerB.user && answerA.user.startsWith('guest:'), `${answerA.user} / ${answerB.user}`);
    r = await askAs(guestA, '192.0.2.10');
    check('the same browser keeps its id (and its budget)', (await r.json()).user === answerA.user);
    r = await askAs('augmented_guest=madeup.signature', '192.0.2.12');
    const forgedGuest = await r.json();
    check('a forged guest cookie is replaced by a fresh id', forgedGuest.user !== 'guest:madeup' && Boolean(guestCookieOf(r)), forgedGuest.user);
    r = await fetch(base + '/api/models', { method: 'POST', headers: { Cookie: guestA } });
    check('guests cannot upload models -> 401 "sign in"', r.status === 401 && (await r.json()).signIn === true);

    console.log('\n=== Guest budget: 20,000 tokens a day ===');
    // Guest A has used 12,000 so far (2 x 6,000). One more -> 18,000: over 80%, so the page warns.
    r = await askAs(guestA, '192.0.2.10');
    const third = await r.json();
    check('at 18,000 of 20,000 the answer still comes, with a warning flag', r.status === 200 && third.budget.used === 18000 && third.budget.warn === true, JSON.stringify(third.budget));
    r = await askAs(guestA, '192.0.2.10');
    check('the last question may go a little over (24,000): never cut off halfway', r.status === 200);
    r = await askAs(guestA, '192.0.2.10');
    const stopped = await r.json();
    check('over the budget -> 429 "sign in to keep asking"', r.status === 429 && stopped.limitReached === true && /Sign in/.test(stopped.message), stopped.message);
    r = await askAs(guestB, '192.0.2.11');
    check('...while another guest is not affected', r.status === 200);
    // Same address, cookies cleared: a new guest id each time. The address already used
    // 24,000; 6 more questions take it past 60,000.
    let blocked = false;
    for (let i = 0; i < 8 && !blocked; i++) {
        r = await askAs(null, '192.0.2.10');
        blocked = r.status === 429;
    }
    check('clearing cookies does not reset it: the address has a budget too', blocked, `status ${r.status}`);
    usage.store.day = '2000-01-01';   // pretend the day changed
    r = await askAs(guestA, '192.0.2.10');
    check('a new day -> the budget starts again', r.status === 200);
    usage.store.day = '2000-01-01';
    for (let i = 0; i < 9; i++) { await askAs(guestB, '192.0.2.11'); usage.store.day = '2000-01-01'; }
    r = await askAs(guestB, '192.0.2.11');
    check('more than 10 questions in a minute -> 429 "wait a moment"', r.status === 429 && /minute/.test((await r.json()).message));

    console.log('\n=== Signing in ===');
    r = await post('/login', { password: 'wrong', next: '/' });
    check('wrong password -> back to sign-in with a message', r.status === 303 && r.headers.get('location').startsWith('/login?error=wrong'), r.headers.get('location'));
    r = await post('/login', { password: 'correct horse', next: '/app#rstbasicsampleproject.rvt' });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    check('right password -> back to the page asked for, model included', r.status === 303 && r.headers.get('location') === '/app#rstbasicsampleproject.rvt', r.headers.get('location'));
    check('cookie is HttpOnly, SameSite=Lax, 7 days', /HttpOnly/.test(r.headers.get('set-cookie')) && /SameSite=Lax/.test(r.headers.get('set-cookie')) && /Max-Age=604800/.test(r.headers.get('set-cookie')), r.headers.get('set-cookie'));
    r = await post('/login', { password: 'correct horse', next: '//evil.example.com' });
    check('"next" pointing to another site is ignored -> the app', r.headers.get('location') === '/app', r.headers.get('location'));

    console.log('\n=== Signed in ===');
    r = await get('/app', { ...HTML, Cookie: cookie });
    check('the app opens', r.status === 200 && (await r.text()).includes('Augmented'));
    r = await fetch(base + '/ask_agent_simple', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
    const member = await r.json();
    check('the chatbot answers, with no budget', r.status === 200 && member.user === 'member' && member.budget.limit === null, JSON.stringify(member.budget));
    for (let i = 0; i < 12; i++) await askAs(cookie);
    r = await askAs(cookie);
    check('...and no per-minute or token limit (after 13 more questions)', r.status === 200);
    r = await fetch(base + '/api/models', { method: 'POST', headers: { Cookie: cookie } });
    check('signed in -> uploads allowed', r.status === 200);
    r = await get('/api/me', { Cookie: cookie });
    check('/api/me says "member"', (await r.json()).kind === 'member');
    r = await get('/api/me', { Cookie: guestB });
    const me = await r.json();
    check('/api/me says "guest", with the budget', me.kind === 'guest' && me.budget.limit === 20000, JSON.stringify(me));
    r = await get('/login', { ...HTML, Cookie: cookie });
    check('visiting /login when signed in -> straight to the app', r.status === 302 && r.headers.get('location') === '/app');

    console.log('\n=== Question log: 👍/👎 and the admin page ===');
    r = await fetch(base + '/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: guestB }, body: '{}' });
    check('guests may send 👍/👎 (not stopped by the sign-in gate)', r.status === 200 && (await r.json()).gate === 'passed', `status ${r.status}`);
    r = await get('/admin/questions', { ...HTML, Cookie: guestB });
    check('guests can\'t open the question log (403)', r.status === 403, `status ${r.status}`);
    r = await get('/admin/questions', { ...HTML, Cookie: cookie });
    check('signed in: the question log opens', r.status === 200 && (await r.text()).includes('Question log'), `status ${r.status}`);

    console.log('\n=== Forged cookies ===');
    const [expiry, signature] = cookie.split('=')[1].split('.');
    const upload = c => fetch(base + '/api/models', { method: 'POST', headers: { Cookie: c } });
    r = await upload(`augmented_session=${Number(expiry) + 1e9}.${signature}`);
    check('extended expiry with the old signature -> treated as a guest (upload refused)', r.status === 401);
    r = await upload(`augmented_session=${expiry}.forged`);
    check('made-up signature -> treated as a guest (upload refused)', r.status === 401);

    console.log('\n=== Logging out ===');
    r = await post('/logout', {}, { Cookie: cookie });
    check('log out -> back to the app as a guest, cookie deleted', r.status === 303 && r.headers.get('location') === '/app' && /Max-Age=0/.test(r.headers.get('set-cookie')));

    console.log('\n=== Guessing ===');
    for (let i = 0; i < 10; i++) await post('/login', { password: `guess ${i}` }, { 'X-Forwarded-For': '203.0.113.9' });
    r = await post('/login', { password: 'correct horse' }, { 'X-Forwarded-For': '203.0.113.9' });
    check('after 10 wrong passwords, even the right one waits 15 min', r.headers.get('location').startsWith('/login?error=locked'), r.headers.get('location'));
    r = await post('/login', { password: 'correct horse' }, { 'X-Forwarded-For': '198.51.100.4' });
    check('...but only for that address', r.headers.get('location') === '/app');

    console.log('\n=== Misconfigured server ===');
    process.env.APP_PASSWORD = ''; process.env.NODE_ENV = 'production';
    r = await get('/', HTML);
    check('production without APP_PASSWORD -> refuses everything (503), never open', r.status === 503, `status ${r.status}`);
    process.env.NODE_ENV = '';
    r = await get('/', HTML);
    check('local development without APP_PASSWORD -> open', r.status === 200);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;   // a failure must fail the run (GitHub Actions checks this)
    server.close();
})().catch(e => { console.error('TEST ERROR', e); process.exit(1); });

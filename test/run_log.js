// Tests for the question log (augmented/questionlog.js), POST /feedback and the admin
// page (routes/admin.js): node test/run_log.js
// No DATA_DIR: the log lives in memory. Uses the fake Autodesk and OpenAI of test/harness.js.
process.env.ROUTER = '../routes/ask_agent_simple_v2.js';
const express = require('express');
const { app, origLog: log, BROKEN_URN } = require('./harness');
const questionLog = require('../augmented/questionlog');

let base, pass = 0, fail = 0;
function check(name, cond, detail = '') {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n        ' + detail : ''}`);
}
async function post(path, body) {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
}
const ask = (prompt, extra = {}) => post('/api/ask_agent_simple', { prompt, conversationId: 'log-sheet', ...extra });
const rowOf = id => questionLog.recentQuestions({ limit: 1000 }).find(row => row.id === id);
const latest = () => questionLog.recentQuestions({ limit: 1 })[0];

(async () => {
    const server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    let r, row;

    log('\n=== Every question is logged ===');
    r = await ask('how many walls are there?');
    row = rowOf(r.body.questionId);
    check('an answer gets a questionId, and its row says what happened',
        r.body.questionId > 0 && row && row.question === 'how many walls are there?' && row.action === 'count' &&
        row.result_count === 2 && row.tier === 0 && row.tokens === r.body.token.currentRequest.totalTokens && row.model === 'rstbasicsampleproject.rvt' &&
        row.sheet === 'log-sheet' && row.duration_ms >= 0 && row.error === null, JSON.stringify(row));
    check('the answer text is stored, the user only as a scrambled code',
        /2/.test(row.answer) && row.who === questionLog.whoCode('local') && row.who !== 'local', `${row.who} | ${row.answer}`);
    r = await ask('list the different floors');
    row = rowOf(r.body.questionId);
    check('an OpenAI-planned question logs its tier, tokens and plan',
        row.tier === 1 && row.tokens === r.body.token.currentRequest.totalTokens && row.tokens > 0 && JSON.parse(row.plan).action,
        `tier ${row.tier}, tokens ${row.tokens}, plan ${row.plan}`);
    r = await ask('and on level 12?');
    check('a follow-up is marked as one', r.body.followUp === true && rowOf(r.body.questionId)?.follow_up === 1, JSON.stringify(rowOf(r.body.questionId)));

    log('\n=== Failures are logged too ===');
    r = await ask('list all floors', { urn: BROKEN_URN, guid: 'g1' });
    row = latest();
    check('a model that is not ready -> 503, logged with the reason', r.status === 503 && /^503: /.test(row.error), row.error);
    r = await ask('BROKEN_JSON');
    row = latest();
    check('an OpenAI answer that can\'t be read -> 502, logged', r.status === 502 && /^502: /.test(row.error), row.error);
    r = await ask('x'.repeat(501));
    row = latest();
    check('a question that is too long -> logged as refused', r.status === 400 && /under 500/.test(row.error), row.error);

    log('\n=== 👍/👎 ===');
    const asked = await ask('how many doors are there?');
    const id = asked.body.questionId;
    r = await post('/api/feedback', { questionId: id, vote: 'down', note: 'wrong level' });
    row = rowOf(id);
    check('👎 with a note is saved on the question', r.status === 200 && row.vote === -1 && row.note === 'wrong level' && row.voted_at, JSON.stringify(row));
    r = await post('/api/feedback', { questionId: id, vote: 'up' });
    check('changing your mind: 👍 replaces it', r.status === 200 && rowOf(id).vote === 1 && rowOf(id).note === null);
    check('someone else can\'t rate your answer', questionLog.rateAnswer(id, 'guest:someone-else', -1) === 'not-yours' && rowOf(id).vote === 1);
    r = await post('/api/feedback', { questionId: 999999, vote: 'up' });
    check('an unknown question -> 404', r.status === 404, r.body.message);
    r = await post('/api/feedback', { questionId: id, vote: 'maybe' });
    check('a vote that is not up/down -> 400', r.status === 400, r.body.message);
    r = await post('/api/feedback', { questionId: id, vote: 'down', note: 'n'.repeat(301) });
    check('a note over 300 characters -> 400', r.status === 400, r.body.message);

    log('\n=== The admin page ===');
    await ask('<script>alert(1)</script> walls');
    const admin = express();
    admin.use((req, res, next) => { req.user = { id: req.get('x-test-user'), kind: req.get('x-test-kind') }; next(); });
    admin.use(require('../routes/admin'));
    const adminServer = admin.listen(0);
    const adminGet = (path, kind) => fetch(`http://127.0.0.1:${adminServer.address().port}${path}`, { headers: { 'x-test-user': kind, 'x-test-kind': kind } });
    let page = await adminGet('/admin/questions', 'guest');
    check('guests can\'t see the log (403)', page.status === 403);
    page = await adminGet('/admin/questions', 'member');
    let html = await page.text();
    check('signed in: the page lists questions with totals per day',
        page.status === 200 && html.includes('how many walls are there?') && html.includes('Last 14 days') && /<td>\d{4}-\d\d-\d\d<\/td><td>\d+<\/td>/.test(html));
    check('a question typed as HTML is shown as text, never run',
        html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !html.includes('<script>alert(1)'));
    html = await (await adminGet('/admin/questions?show=down', 'member')).text();
    check('filter "👎 only" shows only rated-down questions', !html.includes('how many walls are there?') && html.includes('Nothing to show'));
    html = await (await adminGet('/admin/questions?show=errors', 'member')).text();
    check('filter "Errors" shows the failures', html.includes('503: ') && !html.includes('how many walls are there?'));
    adminServer.close();

    log('\n=== Logging never breaks a question ===');
    const circular = {}; circular.self = circular;      // JSON.stringify fails on this
    let threw = false, result;
    try { result = questionLog.logQuestion({ userId: 'local', question: 'q', plan: circular }); } catch { threw = true; }
    check('a row that can\'t be written returns null instead of throwing', !threw && result === null);

    log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
    server.close();
})().catch(e => { log('TEST ERROR', e); process.exit(1); });

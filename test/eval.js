// test/eval.js
// ---------------------------------------------------------------------------
// Runs an evaluation set against the RUNNING app (real APS model + real LLM)
// and reports how each question went.
//
//   node test/eval.js                                   all questions, once
//   node test/eval.js --repeat 3                        each question 3 times (stability)
//   node test/eval.js --only levels                     one group only
//   node test/eval.js --ids S04,S06                     chosen questions only
//   node test/eval.js --cases test/eval-cases-x.json    another model's set
//
//   BASE_URL       where the app runs (default http://localhost:8080)
//   EVAL_PASSWORD  the app's sign-in password, if sign-in is on
//
// Every result is one of:
//   PASS   the right answer
//   ASKED  the app asked back instead of answering: safe, but not an answer
//   WRONG  a confident answer that is wrong: the number to drive to zero
//   ERROR  the request failed
// Writes test/eval-report-<model>.json (details) and .md (summary to read).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : fallback;
};
const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const CASES_FILE = path.resolve(arg('--cases', path.join(__dirname, 'eval-cases-rstbasic.json')));
const REPEAT = Math.max(1, Number(arg('--repeat', 1)) || 1);
const ONLY = arg('--only', null);
const IDS = arg('--ids', null)?.split(',');

let cookie = '';

// Signs in first when the app has sign-in on (EVAL_PASSWORD set).
async function signIn() {
    if (!process.env.EVAL_PASSWORD) return;
    const r = await fetch(`${BASE_URL}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: process.env.EVAL_PASSWORD, next: '/' }).toString()
    });
    cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    if (!cookie) throw new Error('Sign-in failed: check EVAL_PASSWORD.');
}

async function ask(question, urn) {
    const started = Date.now();
    const r = await fetch(`${BASE_URL}/ask_agent_simple`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        // a new conversation id every time: evaluation questions must never be read as follow-ups
        body: JSON.stringify({ prompt: question, urn, conversationId: `eval-${Date.now()}-${Math.random().toString(36).slice(2)}` })
    });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, ms: Date.now() - started, body };
}

// All numbers in a text, "258,448.1 mm" -> [258448.1].
const numbersIn = text => (String(text || '').replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(\.\d+)?/g) || []).map(Number);

// Decides PASS / ASKED / WRONG / ERROR for one reply.
function classify(expect, { status, body }) {
    if (status !== 200) return { outcome: 'ERROR', why: `HTTP ${status}: ${body.message || ''}` };
    const action = body.action;
    const count = body.data?.count;
    const firstGroup = body.data?.groups?.[0]?.value;

    if (expect.actions) {
        return expect.actions.includes(action)
            ? { outcome: 'PASS' }
            : { outcome: 'WRONG', why: `answered with "${action}" instead of ${expect.actions.join(' / ')}` };
    }
    if (expect.noneOrClarify) {
        if (action === 'clarify' || action === 'reply') return { outcome: 'PASS' };
        if ((action === 'list' || action === 'count') && count === 0) return { outcome: 'PASS' };
        return { outcome: 'WRONG', why: `claimed ${count ?? 'some'} elements for something the model doesn't have` };
    }
    if (action === 'clarify') {
        return expect.orClarify ? { outcome: 'PASS' } : { outcome: 'ASKED', why: body.answer };
    }
    if (action === 'reply') return { outcome: 'ASKED', why: 'replied without answering' };

    if (expect.total !== undefined) {
        const hit = numbersIn(body.answer).some(v => Math.abs(v - expect.total) <= Math.abs(expect.total) * expect.tolerance);
        return hit ? { outcome: 'PASS' } : { outcome: 'WRONG', why: `expected a total of ${expect.total} ${expect.unit}` };
    }
    if (expect.firstGroup !== undefined) {
        return action === 'group' && firstGroup === expect.firstGroup
            ? { outcome: 'PASS' }
            : { outcome: 'WRONG', why: action === 'group' ? `biggest group "${firstGroup}", expected "${expect.firstGroup}"` : `"${action}" instead of a breakdown` };
    }
    const counts = expect.counts || [expect.count];
    if (['list', 'count', 'rank'].includes(action) && counts.includes(count)) return { outcome: 'PASS' };
    return { outcome: 'WRONG', why: action === 'group' ? 'a breakdown instead of an element answer' : `${count} elements, expected ${counts.join(' or ')}` };
}

const expected = e => e.actions ? e.actions.join(' / ')
    : e.noneOrClarify ? 'none, or ask back'
    : e.total !== undefined ? `total ${e.total} ${e.unit}`
    : e.firstGroup !== undefined ? `biggest group: ${e.firstGroup}`
    : (e.counts || [e.count]).join(' or ') + ' elements';

(async () => {
    const set = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
    const cases = set.cases.filter(c => (!ONLY || c.group === ONLY) && (!IDS || IDS.includes(c.id)));
    await signIn();
    console.log(`${cases.length} questions x${REPEAT} on ${set.model.name} via ${BASE_URL}\n`);

    const results = [];
    for (const c of cases) {
        const runs = [];
        for (let i = 0; i < REPEAT; i++) {
            const reply = await ask(c.question, set.model.urn).catch(e => ({ status: 0, ms: 0, body: { message: e.message } }));
            runs.push({ ...reply, ...classify(c.expect, reply) });
        }
        const first = runs[0];
        const plans = new Set(runs.map(r => JSON.stringify(r.body.plan ?? null)));
        const result = {
            id: c.id, group: c.group, question: c.question, expected: expected(c.expect),
            outcome: first.outcome, why: first.why || '',
            stable: plans.size === 1, outcomes: runs.map(r => r.outcome),
            tier: first.body.tier, tokens: first.body.token?.currentRequest?.totalTokens ?? 0, ms: first.ms,
            answer: first.body.answer ?? first.body.message, plan: first.body.plan
        };
        results.push(result);
        const mark = { PASS: 'PASS ', ASKED: 'ASKED', WRONG: 'WRONG', ERROR: 'ERROR' }[result.outcome];
        console.log(`${mark} ${c.id} [${c.group}] ${c.question}  (tier ${result.tier ?? '-'}, ${result.tokens} tok, ${result.ms} ms${result.stable ? '' : ', UNSTABLE'})`);
        if (result.outcome !== 'PASS') console.log(`        expected: ${result.expected} | got: ${String(result.answer).replace(/\s+/g, ' ').slice(0, 110)}`);
    }

    // ---------------------------------------------------------------- summary
    const by = (list, key) => list.reduce((m, r) => ((m[r[key]] = m[r[key]] || []).push(r), m), {});
    const count = (list, outcome) => list.filter(r => r.outcome === outcome).length;
    const groups = by(results, 'group');
    const tiers = by(results.filter(r => r.tier !== undefined), 'tier');
    const avg = list => Math.round(list.reduce((a, b) => a + b, 0) / Math.max(1, list.length));
    const times = results.map(r => r.ms).sort((a, b) => a - b);
    const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];

    const lines = [];
    lines.push(`# Evaluation: ${set.model.name}`, '');
    lines.push(`${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${results.length} questions · ${BASE_URL}${REPEAT > 1 ? ` · each asked ${REPEAT} times` : ''}`, '');
    lines.push(`| PASS | ASKED BACK | WRONG | ERROR |`, `|---|---|---|---|`);
    lines.push(`| ${count(results, 'PASS')} | ${count(results, 'ASKED')} | **${count(results, 'WRONG')}** | ${count(results, 'ERROR')} |`, '');
    lines.push(`Tokens per question: ${avg(results.map(r => r.tokens))} on average · time: ${avg(times)} ms average, ${p95} ms p95 · tiers: ${Object.entries(tiers).map(([t, l]) => `tier ${t} ${l.length}`).join(', ')}`);
    if (REPEAT > 1) lines.push(`Unstable plans: ${results.filter(r => !r.stable).length}`);
    lines.push('', '## By group', '', '| Group | PASS | ASKED | WRONG | ERROR |', '|---|---|---|---|---|');
    for (const [g, list] of Object.entries(groups)) lines.push(`| ${g} | ${count(list, 'PASS')} | ${count(list, 'ASKED')} | ${count(list, 'WRONG')} | ${count(list, 'ERROR')} |`);
    for (const outcome of ['WRONG', 'ASKED', 'ERROR']) {
        const list = results.filter(r => r.outcome === outcome);
        if (!list.length) continue;
        lines.push('', `## ${outcome === 'ASKED' ? 'Asked back' : outcome === 'WRONG' ? 'Wrong answers' : 'Errors'}`, '');
        for (const r of list) {
            lines.push(`- **${r.id} ${r.question}** — expected ${r.expected}; got: ${String(r.answer).replace(/\s+/g, ' ').slice(0, 160)}`);
            if (r.plan) lines.push(`  - plan: \`${JSON.stringify(r.plan)}\``);
        }
    }

    const stem = path.basename(CASES_FILE, '.json').replace('eval-cases-', '');
    fs.writeFileSync(path.join(__dirname, `eval-report-${stem}.json`), JSON.stringify({ model: set.model, ranAt: new Date().toISOString(), results }, null, 2));
    fs.writeFileSync(path.join(__dirname, `eval-report-${stem}.md`), lines.join('\n') + '\n');
    console.log('\n' + lines.slice(0, 9).join('\n'));
    console.log(`\nFull report: test/eval-report-${stem}.md`);
    process.exitCode = count(results, 'WRONG') + count(results, 'ERROR') > 0 ? 1 : 0;
})().catch(e => { console.error('eval failed:', e.message); process.exitCode = 1; });

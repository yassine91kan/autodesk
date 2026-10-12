// test/eval.js
// ---------------------------------------------------------------------------
// Automated chatbot test ("eval"). Sends every question in eval-cases.json to
// your RUNNING server (real APS model + real LLM) and checks the replies.
//
//   node test/eval.js            run all cases and compare with "expect"
//   node test/eval.js --record   fill in count / firstGroup from the current
//                                answers, then YOU check them once in the file
//
// Settings (environment variables):
//   BASE_URL  where your server runs      (default http://localhost:8080)
//   CASES     path to the cases file      (default test/eval-cases.json)
//   REPEAT    ask each question N times   (default 1). The LLM can answer the
//             same question differently; REPEAT=3 shows which ones are unstable.
//
// Every run also writes test/eval-report.json with the full responses
// (including each `plan`), so you can see WHY a case failed.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const CASES_FILE = path.resolve(process.env.CASES || path.join(__dirname, 'eval-cases.json'));
const REPORT_FILE = path.join(__dirname, 'eval-report.json');
const REPEAT = Math.max(1, Number(process.env.REPEAT) || 1);
const RECORD = process.argv.includes('--record');

// Sends one question to the chatbot, exactly like the frontend does.
async function ask(question) {
    const started = Date.now();
    const response = await fetch(`${BASE_URL}/ask_agent_simple`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: question })
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body, ms: Date.now() - started };
}

// Compares one reply with the expectations. Returns a list of problems
// (an empty list means the case passed). Every field in "expect" is optional:
// only the ones you write down are checked.
function check(expect, { status, body }) {
    const problems = [];
    const plan = body.plan || {};

    if (status !== 200) {
        return [`HTTP ${status}: ${body.message}`];
    }
    if (expect.action && body.action !== expect.action) {
        problems.push(`action: expected "${expect.action}", got "${body.action}"`);
    }
    if (expect.category && plan.category !== expect.category) {
        problems.push(`category: expected "${expect.category}", got "${plan.category}"`);
    }
    if (expect.count !== undefined && body.data?.count !== expect.count) {
        problems.push(`count: expected ${expect.count}, got ${body.data?.count}`);
    }
    if (expect.firstGroup && body.data?.groups?.[0]?.value !== expect.firstGroup) {
        problems.push(`first group: expected "${expect.firstGroup}", got "${body.data?.groups?.[0]?.value}"`);
    }
    for (const text of expect.answerIncludes || []) {
        if (!String(body.answer || '').toLowerCase().includes(text.toLowerCase())) {
            problems.push(`answer does not mention "${text}"`);
        }
    }
    return problems;
}

(async () => {
    const cases = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
    const report = [];
    let passed = 0;
    let unstable = 0;

    console.log(`Running ${cases.length} cases x${REPEAT} against ${BASE_URL}\n`);

    for (const testCase of cases) {
        const expect = testCase.expect || {};
        const runs = [];
        for (let i = 0; i < REPEAT; i++) {
            const reply = await ask(testCase.question);
            runs.push({ ...reply, problems: check(expect, reply) });
        }

        // --record: copy the facts from the first answer into the case,
        // but only where you haven't written an expectation yourself.
        if (RECORD) {
            const data = runs[0].body.data || {};
            if (expect.count === undefined && typeof data.count === 'number') expect.count = data.count;
            if (!expect.firstGroup && data.groups?.[0]) expect.firstGroup = data.groups[0].value;
            if (!expect.action && runs[0].body.action) expect.action = runs[0].body.action;
            testCase.expect = expect;
        }

        const failedRuns = runs.filter(run => run.problems.length > 0).length;
        const ok = failedRuns === 0;
        // "Unstable" = the same question gave different plans across repeats.
        const differentPlans = new Set(runs.map(run => JSON.stringify(run.body.plan))).size > 1;
        if (ok) passed++;
        if (differentPlans) unstable++;

        const avgMs = Math.round(runs.reduce((sum, run) => sum + run.ms, 0) / runs.length);
        const cost = `tier ${runs[0].body.tier}, ${runs[0].body.token?.currentRequest?.totalTokens} tokens`;
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${testCase.question}  (${cost}, ${avgMs} ms${REPEAT > 1 ? `, ${REPEAT - failedRuns}/${REPEAT} ok` : ''}${differentPlans ? ', UNSTABLE' : ''})`);
        console.log(`        -> ${String(runs[0].body.answer ?? runs[0].body.message).split('\n').join(' | ')}`);
        for (const problem of runs.find(run => run.problems.length)?.problems || []) {
            console.log(`        !! ${problem}`);
        }

        report.push({ question: testCase.question, expect, ok, unstable: differentPlans, runs: runs.map(run => ({ status: run.status, ms: run.ms, problems: run.problems, answer: run.body.answer, plan: run.body.plan, data: run.body.data })) });
    }

    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    if (RECORD) {
        fs.writeFileSync(CASES_FILE, JSON.stringify(cases, null, 4));
        console.log(`\nRecorded expectations into ${path.basename(CASES_FILE)}. Open it and check every count against Revit before trusting it.`);
    }

    console.log(`\n${passed}/${cases.length} passed${unstable ? `, ${unstable} unstable` : ''}. Full details: ${path.basename(REPORT_FILE)}`);
    process.exitCode = passed === cases.length ? 0 : 1; // non-zero = failure, so CI or scripts can detect it
})().catch(error => {
    console.error(`Could not run the eval: ${error.message}. Is the server running at ${BASE_URL}?`);
    process.exitCode = 1;
});

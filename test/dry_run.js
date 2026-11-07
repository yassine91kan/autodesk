// test/dry_run.js
// ---------------------------------------------------------------------------
// Runs an evaluation set through the REAL chatbot code and the REAL model data,
// but WITHOUT OpenAI: 0 tokens, 0 cost.
//
//   node test/dry_run.js --cases test/eval-cases-seaport.json
//
// OpenAI is replaced by a stand-in:
//   tier 0 (list / count / group?)  answered by simple rules, like test/harness.js
//   tier 1 / tier 2                  NOT answered: the question is reported as
//                                    "LLM" (it would cost tokens in the real app)
// So it shows exactly what CODE does with each question: which ones code answers by
// itself (and whether that's right), and which ones would go to the LLM.
// Use it after a change, before spending tokens on test/eval.js.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const Module = require('module');
const express = require('express');

// This dry run measures the TIERED planner's code (the hybrid is the app's default).
process.env.PLANNER = process.env.PLANNER || 'tiered';

const arg = (name, fallback) => (process.argv.indexOf(name) > 0 ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const CASES_FILE = path.resolve(arg('--cases', path.join(__dirname, 'eval-cases-rstbasic.json')));

// ---------------------------------------------------------------- the OpenAI stand-in
let llmNeeded = 0;
class NoOpenAI {
    constructor() {
        this.chat = { completions: { create: async (req) => {
            const system = req.messages[0].content;
            const reply = json => ({ choices: [{ message: { content: JSON.stringify(json) } }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
            if (system.startsWith('Classify a question')) {
                const q = req.messages[1].content.toLowerCase();
                return reply({ action: /how many|number of/.test(q) ? 'count' : /\bper\b|\bby\b|most|what .* used/.test(q) ? 'group' : 'list' });
            }
            llmNeeded++;
            // tier 1: "need more" sends it to tier 2; tier 2: a marker answer
            return reply(system.includes('CANDIDATES') ? { action: 'need_more' } : { action: 'clarify', message: 'DRY RUN: the LLM would answer this.' });
        } } };
    }
}
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    return request === 'openai' ? NoOpenAI : originalLoad.call(this, request, ...rest);
};

// ---------------------------------------------------------------- run
(async () => {
    const set = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(require('../routes/ask_agent_simple_v2.js'));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;

    console.log(`Dry run (no OpenAI) of ${set.cases.length} questions on ${set.model.name}. Loading the model...\n`);
    const totals = { code: 0, right: 0, llm: 0 };
    for (const c of set.cases) {
        const before = llmNeeded;
        const r = await fetch(`${base}/ask_agent_simple`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: c.question, urn: set.model.urn, conversationId: `dry-${c.id}` })
        });
        const body = await r.json().catch(() => ({}));
        if (llmNeeded > before) {
            totals.llm++;
            console.log(`LLM    ${c.id} ${c.question}`);
            continue;
        }
        // Code answered by itself: is it right? (The same checks as test/eval.js, simplified.)
        totals.code++;
        const e = c.expect;
        const count = body.data?.count;
        const right = e.noneOrClarify ? (body.action === 'clarify' || count === 0)
            : e.actions ? e.actions.includes(body.action)
            : e.total !== undefined ? String(body.answer || '').replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(\.\d+)?/g)?.some(v => Math.abs(v - e.total) <= Math.abs(e.total) * e.tolerance)
            : e.firstGroup !== undefined ? body.data?.groups?.[0]?.value === e.firstGroup
            : (e.counts || [e.count]).includes(count);
        if (right) totals.right++;
        console.log(`${right ? 'CODE ✓' : 'CODE ✗'} ${c.id} ${c.question}${right ? '' : `\n         expected ${JSON.stringify(e)} | got: ${String(body.answer).replace(/\s+/g, ' ').slice(0, 150)}`}`);
    }
    console.log(`\nCode answered ${totals.code} by itself (${totals.right} right, ${totals.code - totals.right} wrong); ${totals.llm} would go to the LLM.`);
    server.close();
    process.exit(0);
})().catch(e => { console.error('dry run failed:', e); process.exit(1); });

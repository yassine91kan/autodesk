// Zero-token probe of the hybrid planner on the REAL models.
//   node test/probe/probe.js <rst|sea> describe
//   node test/probe/probe.js <rst|sea> ask test/probe/rst-general.json
//   node test/probe/probe.js rst askpos test/probe/rst-spatial.json   (synthetic positions)
//   node test/probe/probe.js <rst|sea> sql "SELECT ..."
const path = require('path');
const fs = require('fs');
const Module = require('module');
const ROOT = path.resolve(__dirname, '../..').split(path.sep).join('/');
const START_DIR = process.cwd();
process.chdir(ROOT);
process.env.DATA_DIR = process.env.PROBE_DATA_DIR || path.join(require('os').tmpdir(), 'augmented-probe');   // index cached between runs, outside the project

let llm = [];
class NoOpenAI {
    constructor() {
        this.chat = { completions: { create: async req => {
            const system = req.messages[0].content;
            const reply = json => ({ choices: [{ message: { content: JSON.stringify(json) } }], usage: {} });
            if (system.startsWith('Classify a question')) {
                const q = req.messages[1].content.toLowerCase();
                return reply({ action: /distance|apart|spacing|far|close|near/.test(q) ? 'distance' : /how many/.test(q) ? 'count' : 'list' });
            }
            llm.push(req.messages[1].content);
            return reply(system.includes('CANDIDATES') ? { action: 'need_more' } : { clarify: 'WOULD-GO-TO-LLM', action: 'clarify', message: 'WOULD-GO-TO-LLM' });
        } } };
    }
}
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'openai' ? NoOpenAI : load.call(this, request, ...rest); };
const realLog = console.log;
console.log = () => {};

const URNS = {
    rst: 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6ZnFwdGd0Z2Q2N2dnNGd2dWJhZ2VpdmpweHVzdW9pbXMtYmFzaWMtYXBwL3JzdGJhc2ljc2FtcGxlcHJvamVjdC5ydnQ',
    sea: 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6ZnFwdGd0Z2Q2N2dnNGd2dWJhZ2VpdmpweHVzdW9pbXMtYmFzaWMtYXBwL1NlYXBvcnQtQ2l2aWMtQ2VudGVyX0FyY2hpdGVjdHVyZS5ydnQ'
};

(async () => {
    const [which, mode, file] = process.argv.slice(2);
    const { getModel } = require(ROOT + '/augmented/store');
    const { findMainViewGuid } = require(ROOT + '/augmented/aps');
    const hybrid = require(ROOT + '/augmented/hybrid');
    const { describeCleanTable } = require(ROOT + '/augmented/sqlplanner');
    const { answerQuestion } = require(ROOT + '/augmented/planner');
    const { runPlan } = require(ROOT + '/augmented/engine');
    const urn = URNS[which];
    const guid = which === 'rst' ? '2b8b1cf8-31bf-7e71-dfb5-e1d4342ddb82' : await findMainViewGuid(urn);
    const model = await getModel(urn, guid);
    const out = (...a) => realLog(...a);

    if (mode === 'describe') {
        out(describeCleanTable(model.db));
        out('\npositions:', model.db.prepare('SELECT COUNT(*) n FROM positions').get().n, 'elements:', model.elementCount);
        return process.exit(0);
    }
    if (mode === 'sql') {
        out(JSON.stringify(model.db.prepare(file).all().slice(0, 60), null, 0));
        return process.exit(0);
    }
    if (mode === 'askpos') {
        // Synthetic layout: columns on a 6 x 8 m grid (the last 6 stacked on the first 6),
        // the stair at (7,1), walls as 30 m long lines every 4 m, foundations under the grid.
        const { setPositions } = require(ROOT + '/augmented/spatial');
        const { fillHeightsFromPositions } = require(ROOT + '/augmented/clean');
        const pos = {};
        const rows = model.db.prepare("SELECT objectid, external_id, category FROM elements_clean WHERE category IN ('Structural Columns','Stairs','Walls','Structural Foundations') ORDER BY objectid").all();
        let c = 0, w = 0, f = 0;
        for (const r of rows) {
            if (r.category === 'Structural Columns') { const k = c % 24, up = c >= 24 ? 3 : 0; const x = (k % 6) * 6, y = Math.floor(k / 6) * 8; c++; pos[r.external_id] = { center: [x, y, 1.5 + up], min: [x - .1, y - .1, up], max: [x + .1, y + .1, 3 + up] }; }
            else if (r.category === 'Stairs') pos[r.external_id] = { center: [7, 1, 1.5], min: [6, 0, 0], max: [8, 2, 3] };
            else if (r.category === 'Walls') { const y = w * 4; w++; pos[r.external_id] = { center: [15, y, 2], min: [0, y - .1, 0], max: [30, y + .1, 4] }; }
            else { const x = (f % 6) * 6, y = Math.floor(f / 6) * 8; f++; pos[r.external_id] = { center: [x, y, -0.5], min: [x - .5, y - .5, -1], max: [x + .5, y + .5, 0] }; }
        }
        out('positions stored:', setPositions(model.db, pos), 'heights filled:', fillHeightsFromPositions(model.db));
    }
    const questions = JSON.parse(fs.readFileSync(path.resolve(START_DIR, file), 'utf8'));
    const tally = {};
    for (const item of questions) {
        const chain = Array.isArray(item) ? item : [item];
        let previous = null;
        for (const q of chain) {
            llm = [];
            let line;
            try {
                const r = await hybrid.answerHybrid(q, model, previous);
                let lane = r.lane;
                if (llm.length) lane = 'LLM' + (r.followUp ? '(followup)' : '');
                if (r.lane === 'old') {
                    const o = await answerQuestion(q, model, null);
                    const res = o.checked.ok ? runPlan(o.checked.plan, model, 'probe') : { answer: 'CLARIFY: ' + o.checked.question };
                    lane = llm.length ? 'old->LLM' : 'old';
                    line = `${JSON.stringify(o.plan)} => ${String(res.answer).replace(/\s+/g, ' ').slice(0, 230)}`;
                } else if (!llm.length) {
                    line = `${r.sql ? r.sql.replace(/\s+/g, ' ').slice(0, 170) + ' ' + JSON.stringify(r.params || []) : ''} => ${String(r.answer).replace(/\s+/g, ' ').slice(0, 200)}`;
                    if (r.sql) previous = { question: q, sql: r.sql };
                } else line = '';
                tally[lane] = (tally[lane] || 0) + 1;
                out(`[${lane}] ${chain.length > 1 && q !== chain[0] ? '  ↳ ' : ''}${q}\n      ${line}`);
            } catch (e) { out(`[ERROR] ${q}\n      ${e.stack.split('\n').slice(0, 3).join(' | ')}`); tally.ERROR = (tally.ERROR || 0) + 1; }
        }
    }
    out('\nTALLY', JSON.stringify(tally));
    process.exit(0);
})().catch(e => { realLog('probe failed', e); process.exit(1); });

// test/eval_compare.js
// ---------------------------------------------------------------------------
// Option 3: today's planner vs "OpenAI writes SQL on the clean table", graded the same way.
// The right answers are SQL on the clean table (test/eval-clean-rstbasic.json), computed
// here at run time.
//
//   node test/eval_compare.js --baseline <results.json> --db <rstbasic with clean table>        (free: grades the baseline only)
//   node test/eval_compare.js --baseline <results.json> --db <...> --run-sql --out <file.json>  (COSTS TOKENS: one OpenAI call per question, +1 retry if its SQL fails)
//
// --baseline: answers of today's planner (a real run, same 76 questions).
// --db:       a copy of the model's index WITH the clean table (and positions, for heights).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const BASELINE = arg('--baseline');
const DB_FILE = arg('--db');
const OUT = arg('--out');
const RUN_SQL = process.argv.includes('--run-sql');
const EXPECT = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval-clean-rstbasic.json'), 'utf8')).cases;

const db = new Database(DB_FILE, { readonly: true });
const scalar = sql => Object.values(db.prepare(sql).get())[0];
const near = (a, b) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 0.01);
// "1,275,952.5 mm (1,275.953 m)" -> [1275952.5, 1275.953]
const numbersIn = text => (String(text).replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(?:\.\d+)?/g) || []).map(Number);

// Both paths' answers in one shape: { kind, count, text }.
function fromBaseline(r) {
    const text = `${r.answer ?? ''} ${JSON.stringify(r.groups || [])}`;
    if (r.action === 'clarify' || r.action === 'reply') return { kind: 'ask', count: null, text };
    if (['list', 'rank', 'spatial'].includes(r.action)) return { kind: 'elements', count: r.count ?? r.idCount, text };
    if (r.action === 'count') return { kind: 'value', count: r.count, text };
    return { kind: 'table', count: null, text };   // group, total
}
function fromSql(r) {
    const text = `${r.answer ?? ''} ${JSON.stringify(r.rows?.slice(0, 200) || [])}`;
    if (r.kind === 'reply' || r.kind === 'clarify') return { kind: 'ask', count: null, text };
    if (r.kind === 'elements') return { kind: 'elements', count: r.count, text };
    if (r.kind === 'value') return { kind: 'value', count: typeof r.count === 'number' ? r.count : null, text };
    return { kind: 'table', count: null, text };
}

// pass | fail | manual
function grade(id, a) {
    const e = EXPECT[id];
    const accepted = [
        ...(e.sql && ['count', 'value'].includes(e.type) ? [scalar(e.sql)] : []),
        ...(e.alsoSql || []).map(scalar), ...(e.also || [])
    ];
    const countOk = () => a.count !== null && accepted.some(v => Math.round(a.count) === Math.round(v));   // counts: exact
    switch (e.type) {
        case 'count':
            return countOk() || (e.clarifyOk && a.kind === 'ask') ? 'pass' : 'fail';
        case 'value':
            return numbersIn(a.text).some(n => accepted.some(v => near(n, v))) ? 'pass' : 'fail';
        case 'labels': {
            const lower = a.text.toLowerCase();
            const labels = e.labels || db.prepare(e.sql).all().map(r => [String(Object.values(r)[0])]);
            const found = labels.filter(alts => alts.some(l => lower.includes(l.toLowerCase()))).length;
            const forbidden = (e.forbid || []).some(f => lower.includes(f.toLowerCase()));
            return found >= Math.ceil(labels.length * 0.8) && !forbidden ? 'pass' : 'fail';
        }
        case 'none':
            return a.kind === 'ask' || a.count === 0 ? 'pass' : 'fail';
        case 'cant':
            return a.kind === 'ask' || countOk() ? 'pass' : 'fail';
        case 'clarify':
            return a.kind === 'ask' || countOk() ? 'pass' : 'fail';
        default:
            return 'manual';
    }
}

(async () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).results;
    const rows = [];
    let sqlTokens = 0;
    let previous = null;
    const { answerWithSql, checkSql, shapeResult } = require('../augmented/sqlplanner');
    const HYBRID = process.argv.includes('--hybrid');
    const { answerHybrid } = HYBRID ? require('../augmented/hybrid') : {};
    const hybridModel = { db, key: 'eval' };
    // --regrade <earlier --out file>: re-run the SQL OpenAI wrote last time, locally (0 tokens),
    // and grade it again: for fixes in result shaping or grading, without a new paid run.
    const REGRADE = arg('--regrade');
    const earlier = REGRADE ? new Map(JSON.parse(fs.readFileSync(REGRADE, 'utf8')).rows.map(r => [r.id, r])) : null;
    for (const b of baseline) {
        const row = { id: b.id, question: b.question, baseline: grade(b.id, fromBaseline(b)), baselineTokens: b.tokens, baselineAnswer: b.answer };
        if (earlier) {
            const old = earlier.get(b.id);
            let r = { kind: old.sqlKind, count: old.sqlCount, answer: old.sqlAnswer, rows: [] };
            if (old.sqlText) {
                const checked = checkSql(db, old.sqlText);
                const result = checked.stmt.all();
                r = shapeResult(result, old.reading, checked.stmt.columns().map(c => c.name));
            }
            sqlTokens += old.sqlTokens;
            Object.assign(row, { ...old, baseline: row.baseline, sql: grade(b.id, fromSql(r)), sqlKind: r.kind, sqlCount: r.count ?? null, sqlAnswer: String(r.answer).slice(0, 400) });
            console.log(`${b.id} baseline=${row.baseline.padEnd(6)} sql=${row.sql.padEnd(6)} [${r.kind}${r.count != null ? ' ' + r.count : ''}]`);
        } else if (RUN_SQL) {
            const started = Date.now();
            let r;
            try {
                const prev = b.id.startsWith('I') && previous ? previous : null;
                // --hybrid: the whole hybrid (gate, templates, cache, SQL lane), as the app runs it.
                r = HYBRID ? await answerHybrid(b.question, hybridModel, prev) : await answerWithSql(b.question, { db }, prev);
            } catch (error) {
                r = { kind: 'clarify', answer: `ERROR: ${error.message}`, calls: [] };
            }
            const tokens = (r.calls || []).reduce((sum, c) => sum + c.totalTokens, 0);
            sqlTokens += tokens;
            Object.assign(row, { lane: r.lane || 'sql', sql: grade(b.id, fromSql(r)), sqlTokens: tokens, sqlMs: Date.now() - started, sqlKind: r.kind,
                sqlCount: r.count ?? null, sqlAnswer: String(r.answer).slice(0, 400), sqlText: r.sql || null, reading: r.reading || null, retries: (r.calls || []).length - 1 });
            previous = b.id.startsWith('I') ? { question: b.question, sql: r.sql || null } : null;
            console.log(`${b.id} baseline=${row.baseline.padEnd(6)} ${HYBRID ? `hybrid(${row.lane})` : 'sql'}=${row.sql.padEnd(6)} ${tokens}tok [${r.kind}${r.count != null ? ' ' + r.count : ''}] ${String(r.sql || r.answer).replace(/\s+/g, ' ').slice(0, 130)}`);
        } else {
            console.log(`${b.id} baseline=${row.baseline}`);
        }
        rows.push(row);
    }
    const tally = key => ({ pass: rows.filter(r => r[key] === 'pass').length, fail: rows.filter(r => r[key] === 'fail').length, manual: rows.filter(r => r[key] === 'manual').length });
    const lanes = rows.reduce((acc, r) => (r.lane ? { ...acc, [r.lane]: (acc[r.lane] || 0) + 1 } : acc), {});
    const summary = { questions: rows.length, baseline: tally('baseline'), ...(RUN_SQL || earlier ? { sql: tally('sql'), sqlTokens, lanes } : {}) };
    console.log('\n' + JSON.stringify(summary));
    if (OUT) fs.writeFileSync(OUT, JSON.stringify({ ranAt: new Date().toISOString(), summary, rows }, null, 1));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

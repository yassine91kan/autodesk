// Tests for the hybrid planner (augmented/hybrid.js) through the real route: node test/run_hybrid.js
// The fake model and fake OpenAI of test/harness.js (its SQL_ANSWERS play OpenAI's SQL lane).
process.env.PLANNER = 'hybrid';
const { app, calls, origLog: log } = require('./harness');
const questionLog = require('../augmented/questionlog');

let base, pass = 0, fail = 0;
function check(name, cond, detail = '') {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n        ' + detail : ''}`);
}
const ask = async (prompt, sheet = 'hybrid-sheet') => {
    const r = await fetch(`${base}/api/ask_agent_simple`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, conversationId: sheet }) });
    return r.json();
};
const ids = r => JSON.stringify([...(r.objectIds || [])].sort((a, b) => a - b));
const info = r => `${r.lane} ${r.action} ${ids(r)} | ${String(r.answer).replace(/\s+/g, ' ').slice(0, 160)}`;

(async () => {
    const server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    let r;

    log('\n=== Templates: plain questions, answered by code (0 tokens) ===');
    r = await ask('how many walls are there?', 's1');
    check('"how many walls" -> template, 2, 0 tokens, elements for the table and the 3D highlight',
        r.lane === 'template' && r.action === 'count' && r.message.count === 2 && r.message.elements[0].externalId === 'ext-1001' &&
        r.token.currentRequest.totalTokens === 0 && /There are 2 Walls/.test(r.answer), info(r));
    r = await ask('steel beams on level 2', 's2');
    check('"steel beams on level 2" -> 3001, 3002', r.lane === 'template' && ids(r) === '[3001,3002]', info(r));
    r = await ask('what is the total length of the steel beams?', 's3');
    check('"total length of the steel beams" -> 6 + 9 + 9 = 24 m', r.lane === 'template' && r.action === 'total' && /Total length of the 3 steel Structural Framing: 24 m/.test(r.answer), info(r));
    r = await ask('show me the longest beam', 's4');
    check('"the longest beam" -> the two tied at 9 m', r.lane === 'template' && r.action === 'rank' && ids(r) === '[3002,3003]' &&
        r.message.elements[0].value === 9 && r.message.elements[0].unit === 'm', info(r));
    r = await ask('beams per level', 's5');
    check('"beams per level" -> a breakdown', r.lane === 'template' && r.action === 'group' && /Level 1: 3/.test(r.answer), info(r));
    check('templates never called OpenAI', !calls.sql, `SQL calls: ${calls.sql || 0}`);

    log('\n=== Templates: number comparisons, converted from any unit ===');
    const sqlBefore = calls.sql || 0;
    r = await ask('beams longer than 8 m', 's1b');
    check('"beams longer than 8 m" -> template: the two 9 m beams', r.lane === 'template' && ids(r) === '[3002,3003]' && /length over 8 m/.test(r.answer), info(r));
    r = await ask('beams longer than 20 feet', 's1c');
    check('"longer than 20 feet" = 6.096 m: the 6 m beam is not included', r.lane === 'template' && ids(r) === '[3002,3003]', info(r));
    r = await ask('beams with a length between 5 and 7 metres', 's1d');
    check('"between 5 and 7 metres" -> the 6 m beam', r.lane === 'template' && ids(r) === '[3001]', info(r));
    r = await ask('walls thicker than 200 mm', 's1e');
    check('a size the category doesn\'t have -> says so, not a misleading "0 found"', r.lane === 'template' && r.action === 'reply' &&
        /Walls in this model have no thickness value/.test(r.answer), info(r));
    check('...all without OpenAI', (calls.sql || 0) === sqlBefore);
    r = await ask('beams over 300 mm', 's1f');
    check('"over 300 mm" with no measure named (width? depth? length?) is not guessed: OpenAI decides', r.lane === 'sql', info(r));

    log('\n=== Templates: family and type names ===');
    r = await ask('show me the flange beams', 's1g');
    check('"flange beams" -> the W-Wide Flange family', r.lane === 'template' && ids(r) === '[3001,3002,3003]', info(r));
    r = await ask('how many light gauge joists are there?', 's1h');
    check('a whole family name -> 1', r.lane === 'template' && r.message.count === 1 && ids(r) === '[3005]', info(r));

    log('\n=== The gate: data the model doesn\'t have (0 tokens) ===');
    const beforeGate = calls.sql || 0;
    r = await ask('which beams are connected to column 4001?', 's6');
    check('connections -> an honest answer at once, no OpenAI call', r.lane === 'gate' && r.action === 'reply' &&
        /doesn't include connections/.test(r.answer) && r.token.currentRequest.totalTokens === 0 && (calls.sql || 0) === beforeGate, info(r));

    log('\n=== The SQL lane: everything else ===');
    const sqlCalls = calls.sql || 0;
    r = await ask('beams that are not steel', 's7');
    check('"not steel" -> OpenAI writes the SQL, code runs it: 3004, 3005, 3006', r.lane === 'sql' && r.tier === 3 &&
        ids(r) === '[3004,3005,3006]' && /not steel/.test(r.answer) && r.plan.sql.includes('elements_clean') && calls.sql === sqlCalls + 1, info(r));
    r = await ask('and on level 12?', 's7');
    check('a follow-up gets the previous question and its SQL', r.lane === 'sql' && r.followUp === true &&
        calls.lastSqlUser.includes('Previous question in this conversation: "beams that are not steel"') && calls.lastSqlUser.includes("material_class <> 'steel'") &&
        /Nothing found/.test(r.answer), info(r));
    await ask('beams that are not steel', 's7b');
    r = await ask('exclude the level 1 ones', 's7b');
    check('"exclude ..." refines the previous answer (a follow-up with its SQL)', r.lane === 'sql' && r.followUp === true &&
        calls.lastSqlUser.includes('Previous question in this conversation: "beams that are not steel"') && ids(r) === '[]', info(r));
    r = await ask('count framing per level and material', 's8');
    check('a two-level breakdown comes back as rows', r.lane === 'sql' && r.action === 'group' && r.data.rows.length >= 3, info(r));
    r = await ask('delete the walls', 's9');
    check('SQL that would change data is refused before it runs; the retry answers in words', r.lane === 'sql' && r.action === 'reply' &&
        /only read/.test(r.answer), info(r));
    r = await ask('how many walls are there?', 's9b');
    check('...and the walls are all still there', r.message.count === 2, info(r));
    r = await ask('broken query', 's10');
    check('SQL with a mistake gets one retry with the error', r.lane === 'sql' && /count: 2/.test(r.answer) && r.token.calls.length === 2, info(r));
    r = await ask('tell me a joke', 's11');
    check('not about the model -> a reply, no elements', r.lane === 'sql' && r.action === 'reply' && (r.objectIds || []).length === 0, info(r));

    log('\n=== The plan cache ===');
    let before = calls.sql;
    r = await ask('Beams that are NOT steel?', 'c1');   // same words, other spelling, another sheet
    check('the same question again -> the saved SQL: same answer, no OpenAI call, 0 tokens', r.lane === 'cache' && ids(r) === '[3004,3005,3006]' &&
        calls.sql === before && r.token.currentRequest.totalTokens === 0 && r.tier === 0, info(r));
    const cachedId = r.questionId;
    r = await ask('tell me a joke', 'c2');
    check('a reply is cached too', r.lane === 'cache' && r.action === 'reply' && calls.sql === before, info(r));
    r = await ask('beams that are not steel', 'c3');
    await ask('and on level 12?', 'c3');
    before = calls.sql;
    r = await ask('beams that are not steel', 'c4');
    await ask('and on level 12?', 'c4');
    check('follow-ups are never cached (they depend on the conversation)', calls.sql === before + 1, `SQL calls ${before} -> ${calls.sql}`);
    r = await fetch(`${base}/api/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: cachedId, vote: 'down' }) });
    before = calls.sql;
    r = await ask('beams that are not steel', 'c5');
    check('a 👎 removes the saved SQL: the next ask goes to OpenAI again', r.lane === 'sql' && calls.sql === before + 1, info(r));
    r = await ask('beams that are not steel', 'c6');
    check('...and the fresh SQL is saved again', r.lane === 'cache' && calls.sql === before + 1, info(r));

    log('\n=== Spacing questions still use the existing spatial code ===');
    r = await ask('what is the spacing between the columns?', 's12');
    check('spacing -> the tiered planner (no lane in the answer)', r.success === true && r.lane === undefined && r.action === 'spatial', `${r.action} | ${r.answer}`);

    log('\n=== The question log ===');
    const rows = questionLog.recentQuestions({ limit: 50 });
    const sqlRow = rows.find(row => row.question === 'beams that are not steel' && row.tier === 3);
    const templateRow = rows.find(row => row.question === 'steel beams on level 2');
    check('SQL-lane questions are logged as tier 3 with their SQL', sqlRow?.tier === 3 && JSON.parse(sqlRow.plan).sql.includes('elements_clean') && sqlRow.tokens > 0, JSON.stringify(sqlRow));
    check('template questions are logged as tier 0 with their SQL, 0 tokens', templateRow?.tier === 0 && JSON.parse(templateRow.plan).lane === 'template' && templateRow.tokens === 0, JSON.stringify(templateRow));

    log('\n=== The switch ===');
    process.env.PLANNER = 'tiered';
    r = await ask('how many walls are there?', 's13');
    check('PLANNER=tiered switches back to the tiered planner', r.success === true && r.lane === undefined && r.data.count === 2, `${r.lane} ${r.answer}`);
    delete process.env.PLANNER;
    r = await ask('how many walls are there?', 's14');
    check('with no PLANNER setting, the hybrid answers (it is the default)', r.lane === 'template' && r.message.count === 2, `${r.lane} ${r.answer}`);

    log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
    server.close();
})().catch(e => { log('TEST ERROR', e); process.exit(1); });

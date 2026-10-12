process.env.ROUTER = '../routes/ask_agent_simple_v2.js'; // v2
const { app, calls, origLog: log, BROKEN_URN, SECOND_URN, DWG_URN } = require('./harness');

let base, pass = 0, fail = 0;
const tierCount = { 0: 0, 1: 0, 2: 0 };

async function api(method, path, body) {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
}
async function ask(prompt, extra = {}) {
    const r = await api('POST', '/api/ask_agent_simple', { prompt, ...extra });
    if (r.body && r.body.tier !== undefined) tierCount[r.body.tier]++;
    return r;
}
function check(name, cond, detail = '') {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n        ' + String(detail).replace(/\n/g, '\n        ') : ''}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// "[tier 0, 130 tok] Found 2 Floors elements."
const info = r => `[tier ${r.body.tier}, ${r.body.token?.currentRequest?.totalTokens} tok] ${r.body.answer ?? r.body.message}`;

(async () => {
    const server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    let r;

    log('\n=== Loading ===');
    r = await ask('');
    check('missing prompt -> 400', r.status === 400);
    const [a, b, c] = await Promise.all([ask('show me the beams'), ask('list all floors'), ask('show me the doors')]);
    check('3 concurrent cold requests -> 1 download, 1 login', calls.metadata === 1 && calls.tree === 1 && calls.auth === 1,
        `metadata=${calls.metadata} tree=${calls.tree} auth=${calls.auth}`);

    log('\n=== Tier 0: code finds the names, tiny prompt picks list/count/group ===');
    check('"show me the beams" -> all 6 framing (fix A: no usage guessing)', a.body.tier === 0 && a.body.data.count === 6, info(a));
    check('tier 0 costs only the intent prompt (130 tok)', a.body.token.currentRequest.totalTokens === 130, JSON.stringify(a.body.matched));
    check('"list all floors" -> 2', b.body.tier === 0 && same(b.body.objectIds, [2001, 2002]), info(b));
    check('"show me the doors" -> 1, clean name', same(c.body.objectIds, [5001]) && c.body.message.elements[0].name === 'Single Flush', info(c));
    r = await ask('show me all framing');
    check('"all framing" -> 6', r.body.tier === 0 && r.body.data.count === 6, info(r));
    r = await ask('show me the steel beams');
    check('steel beams -> 3001-3003 ("steel" matched part of a material name)', r.body.tier === 0 && same(r.body.objectIds, [3001, 3002, 3003]), info(r));
    r = await ask('show me all elements on level 2');
    check('everything on Level 2: walls + floors + beams, not Level 12, not the column ENDING at Level 2 (fix B)',
        r.body.tier === 0 && same(r.body.objectIds, [1002, 2002, 3001, 3002]), info(r));
    r = await ask('steel beams on level 2');
    check('two filters combined', r.body.tier === 0 && same(r.body.objectIds, [3001, 3002]), info(r));
    r = await ask('show me the light gauge joists');
    check('#7 light gauge joists by family name -> 3005', r.body.tier === 0 && same(r.body.objectIds, [3005]), info(r));
    r = await ask('show me the chs framing');
    check('part of a family name ("chs") -> 3006', r.body.tier === 0 && same(r.body.objectIds, [3006]), info(r));
    r = await ask('how many columns are on level 1?');
    check('#9 columns on Level 1 (Base Level) -> 1', r.body.tier === 0 && r.body.data.count === 1, info(r));
    r = await ask('how many walls are there?');
    check('how many walls -> 2', r.body.tier === 0 && r.body.data.count === 2, info(r));
    r = await ask('how many beams are on level 2?');
    check('how many beams on Level 2 -> 2', r.body.tier === 0 && r.body.data.count === 2, info(r));
    r = await ask('which level has the most beams?');
    check('which level has most beams -> Level 1 (3) first', r.body.tier === 0 && r.body.data?.groups?.[0]?.value === 'Level 1' && r.body.data.groups[0].count === 3, info(r));
    r = await ask('what materials are used for the columns?');
    check('materials of columns', r.body.tier === 0 && r.body.data?.groups?.[0]?.value === 'Concrete, Cast-in-Place', info(r));
    r = await ask('how many elements per category?');
    check('count per category', r.body.tier === 0 && r.body.data?.groups?.length === 5, info(r));
    r = await ask('group framing by family');
    check('group by family', r.body.tier === 0 && r.body.data?.groups?.[0]?.value === 'W-Wide Flange' && r.body.data.groups.length === 4, info(r));
    r = await ask('list all ceilings');
    check('"ceilings" (not in this model) -> answered by code, 0 tokens', r.body.action === 'clarify' && r.body.token.currentRequest.totalTokens === 0, info(r));

    log('\n=== Tier 1: small prompt with only the matched names ===');
    r = await ask('beams with a start level offset of 200 mm');
    check('numbers compare as numbers: "200 mm" = "200.000 mm" (fix C)', r.body.tier === 1 && same(r.body.objectIds, [3001]), info(r));
    const msg = calls.lastTier1Message;
    check('tier 1 sees the matched property, not the whole model', msg.includes('Constraints.Start Level Offset') && !msg.includes('Base Constraint') && msg.length < 800,
        msg.replace(/\n/g, '\n        '));
    r = await ask('where is element 3001?');
    check('no coordinates yet -> polite answer', r.body.tier === 1 && /don't have coordinates/.test(r.body.answer), info(r));
    await api('PUT', '/api/ask_agent_simple', { 3001: { elementCent: [12.5, 4, 3.2] } });
    r = await ask('where is element 3001?');
    check('coordinates after PUT', /12\.5/.test(r.body.answer), info(r));
    r = await ask('what can you help me with?');
    check('capability question', r.body.tier === 1 && r.body.action === 'reply', info(r));

    log('\n=== Tier 2: tier 1 said "need more" -> full prompt ===');
    r = await ask('beams with a start offset above 100 mm');
    check('numeric filter > 100 mm', r.body.tier === 2 && same(r.body.objectIds, [3001]), info(r));
    check('tier 2 token report adds up BOTH calls (tier 1 + tier 2)', r.body.token.calls.length === 2 && r.body.token.currentRequest.totalTokens === 450 + 1260, JSON.stringify(r.body.token.calls));
    r = await ask('show me elements on level 7');
    check('Level 7 does not exist -> suggests real levels', r.body.action === 'clarify' && r.body.answer.includes('Level 1'), info(r));
    r = await ask('group beams by fire rating');
    check('invented property -> asks instead of guessing', r.body.action === 'clarify', info(r));
    r = await ask('everything on level 2 (llm picked one level key)');
    check('#5 LLM picks only Reference Level -> code adds the others', same(r.body.objectIds, [1002, 2002, 3001, 3002]), info(r));
    r = await ask('columns used as joists');
    check('value exists in model but not in that category -> asks back', r.body.action === 'clarify', info(r));
    r = await ask('steel or concrete precast framing');
    check('equals with a list of values', same(r.body.objectIds, [3001, 3002, 3003, 3004]), info(r));
    r = await ask('framing except purlins');
    check('not_equals with a value the model lacks is dropped -> 6', r.body.data.count === 6, info(r));

    log('\n=== Bookkeeping ===');
    check('total tokens reported = sum of every LLM call made', r.body.token.total.totalTokens === calls.tokens,
        `${r.body.token.total.totalTokens} reported, ${calls.tokens} used`);
    await ask('show me the steel beams');
    r = await api('GET', '/api/ask_agent_simple');
    check('GET last result = [{ objectid }] for SummaryExtension', same(r.body.message, [{ objectid: 3001 }, { objectid: 3002 }, { objectid: 3003 }]), JSON.stringify(r.body.message));

    log('\n=== Safety & errors ===');
    r = await ask("walls' OR 1=1 --");
    check('SQL-injection-looking question -> asks back', r.body.action === 'clarify', info(r));
    r = await ask('BROKEN_JSON');
    check('invalid LLM JSON -> 502 with message', r.status === 502, r.body.message);
    const before = calls.metadata;
    r = await ask('list all floors', { urn: BROKEN_URN, guid: 'g1' });
    check('model still processing (202) -> 503', r.status === 503, r.body.message);
    await ask('list all floors', { urn: BROKEN_URN, guid: 'g1' });
    check('...and is retried next time, not cached empty', calls.metadata === before + 2, `metadata calls ${before} -> ${calls.metadata}`);

    log('\n=== The model chosen in the dropdown ===');
    r = await ask('how many walls are there?', { urn: SECOND_URN });
    check('question about another model -> its main 3D view is looked up and used', r.body.data?.count === 2 &&
        calls.urls.some(u => u.endsWith(`${SECOND_URN}/metadata/main-3d-guid/properties?forceget=true`)), info(r));
    const lists = calls.viewList;
    await ask('list all floors', { urn: SECOND_URN });
    check('...and the view is looked up only once per model', calls.viewList === lists, `view-list calls: ${calls.viewList}`);
    r = await api('GET', `/api/model_status?urn=${SECOND_URN}`);
    check('status of another model: ready, with its name from the urn', r.body.ready === true && r.body.modelName === 'second-model' && r.body.elementCount === 12,
        JSON.stringify(r.body));
    r = await api('GET', `/api/model_status?urn=${DWG_URN}`);
    check('a DWG drawing -> 422 "unsupported", clear message', r.status === 422 && r.body.reason === 'unsupported', `${r.status} ${JSON.stringify(r.body)}`);
    r = await ask('show me the walls', { urn: DWG_URN });
    check('asking about the DWG -> 422 with the same message', r.status === 422 && /3D view/.test(r.body.message), `${r.status} ${r.body.message}`);
    check('...decided from its view list, without waiting for its data', !calls.urls.some(u => u.includes(DWG_URN) && u.includes('/properties')));
    r = await ask('show me the walls', { urn: '../../secret' });
    check('a malformed urn is refused before it reaches APS -> 400', r.status === 400, `${r.status} ${r.body.message}`);
    await api('PUT', '/api/ask_agent_simple', { urn: SECOND_URN, coordinates: { 3002: { elementCent: [1, 2, 3] } } });
    r = await ask('where is element 3002?', { urn: SECOND_URN });
    check('coordinates are stored per model: { urn, coordinates } from LoggerExtension', /\[1,2,3\]/.test(r.body.answer), info(r));
    r = await ask('where is element 3002?');
    check('...and do not leak into the default model', /don't have coordinates/.test(r.body.answer), info(r));
    r = await api('GET', `/api/ask_agent_simple?urn=${SECOND_URN}`);
    check('last result per model (SummaryExtension)', Array.isArray(r.body.message), JSON.stringify(r.body.message));

    log('\n=== The full (tier 2) prompt, as the LLM received it ===');
    const prompt = calls.lastPlannerPrompt;
    check('real categories, values and family/type names', prompt.includes('- Structural Framing (6)') && prompt.includes('"Level 12"') && prompt.includes('"Light Gauge Joists"'));
    check('one-value properties left out', !prompt.includes('Phasing.Phase Created'));
    check('duplicate Identity Data.Type Name left out', !prompt.includes('Identity Data.Type Name'));
    check('the "beams" usage rule is gone (fix A)', !prompt.includes('WITHOUT joists'));
    log(`        (about ${Math.round(prompt.length / 4)} tokens)`);
    r = await api('GET', '/api/debug_vocabulary');
    check('/debug_vocabulary is removed (not public on Heroku)', r.status === 404, `status ${r.status}`);

    log(`\nQuestions per tier: tier 0 = ${tierCount[0]}, tier 1 = ${tierCount[1]}, tier 2 = ${tierCount[2]}`);
    log(`${pass} passed, ${fail} failed`);
    server.close();
})().catch(e => { log('HARNESS ERROR', e); process.exit(1); });

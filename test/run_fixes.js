// Tests for the pre-tester answer fixes and time limits: node test/run_fixes.js
//   1. "are you smart?" -> a fixed answer from code (0 tokens)
//   2. "the highest wall" -> every wall tied at the greatest height
//   3. "foundations" -> the category; "on foundation" -> the level
//   4. "the volume of X" -> one total
//   5. the measured value in the results table (templates and the SQL lane)
//   + plain SQL-lane wording, and the OpenAI / Autodesk time limits
// No OpenAI and no Autodesk: a small in-memory clean table, and fake errors.
process.env.APS_CLIENT_ID = process.env.APS_CLIENT_ID || 'test';
process.env.APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET || 'test';
process.env.APS_BUCKET = process.env.APS_BUCKET || 'test';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test';

const Database = require('better-sqlite3');
const { gate, readPlain, buildTemplate, elementsMessage, ABOUT_ANSWER } = require('../augmented/hybrid');
const { shapeResult, SQL_PROMPT } = require('../augmented/sqlplanner');
const { aiFailureMessage, OPENAI_TIMEOUT_MS } = require('../augmented/planner');
const aps = require('../augmented/aps');

let pass = 0, fail = 0;
const log = console.log;
function check(name, cond, detail = '') {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? '\n        ' + detail : ''}`);
}

// ---------------------------------------------------------------- a tiny model
const db = new Database(':memory:');
db.exec(`CREATE TABLE elements_clean (objectid INTEGER, external_id TEXT, name TEXT, category TEXT, family TEXT, type TEXT,
    level TEXT, top_level TEXT, mark TEXT, material TEXT, material_class TEXT, is_structural INTEGER, usage TEXT, function TEXT,
    length_m REAL, height_m REAL, width_mm REAL, depth_mm REAL, thickness_mm REAL, section TEXT, area_m2 REAL, volume_m3 REAL,
    weight_kg_per_m REAL, weight_kg REAL, derived TEXT)`);
const add = db.prepare(`INSERT INTO elements_clean (objectid, external_id, name, category, family, type, level, material_class, function,
    height_m, thickness_mm, area_m2, volume_m3) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
//   id    category                 family          type            level         material   function    height thick area volume
add.run(1, 'e1', 'Wall 1', 'Walls', 'Basic Wall', 'Retaining 280', 'Foundation', 'concrete', 'Retaining', 3.5, 280, 10, 2.8);
add.run(2, 'e2', 'Wall 2', 'Walls', 'Basic Wall', 'Retaining 280', 'Foundation', 'concrete', 'Retaining', 3.5, 280, 12, 3.36);
add.run(3, 'e3', 'Wall 3', 'Walls', 'Basic Wall', 'Generic 200', 'Level 1', 'concrete', 'Interior', 3.0, 200, 8, 1.6);
add.run(4, 'e4', 'Footing 1', 'Structural Foundations', 'Footing-Rectangular', 'F1', 'Foundation', 'concrete', null, null, null, null, 1.2);
add.run(5, 'e5', 'Footing 2', 'Structural Foundations', 'Footing-Rectangular', 'F1', 'Foundation', 'concrete', null, null, null, null, 1.2);
const model = { db, key: 'test' };
const plain = q => { const read = readPlain(q, model); return { read, t: read && buildTemplate(read, db) }; };
const ids = list => JSON.stringify([...(list || [])].sort((a, b) => a - b));

log('\n=== 1. Questions about the assistant: a fixed answer from code ===');
for (const q of ['are you smart?', 'Who are you?', 'what can you do', 'tell me about yourself', 'Hi, what are you?', 'are you an AI?']) {
    const g = gate(q);
    check(`"${q}" -> the fixed answer (0 tokens)`, g?.lane === 'gate' && g.answer === ABOUT_ANSWER, JSON.stringify(g));
}
for (const q of ['show me the walls', 'what can you tell me about the beams', 'walls about 3 m high', 'how many columns are there']) {
    check(`"${q}" is a model question, not "about me"`, gate(q)?.answer !== ABOUT_ANSWER);
}
check('the fixed answer never claims a number it can\'t back', /never invent a number/.test(ABOUT_ANSWER) && !/\d(?!D)/.test(ABOUT_ANSWER));

log('\n=== 2. "Highest": every element tied at the top ===');
let r = plain('show me the highest wall');
check('"the highest wall" -> a rank on height', r.read?.form === 'rank' && r.read.rank.column === 'height_m', JSON.stringify(r.read));
check('...and both 3.5 m walls (a tie), not just one', ids(r.t?.ids) === '[1,2]' && /2 elements share the greatest height/.test(r.t.answer), r.t?.answer);
check('the SQL prompt tells OpenAI to keep ties, never LIMIT 1', /EVERY element tied at the top value/.test(SQL_PROMPT) && /never LIMIT 1/.test(SQL_PROMPT));

log('\n=== 3. "Foundation(s)": the category, unless "on / at" the level ===');
r = plain('show me the foundations');
check('"show me the foundations" -> the Structural Foundations category (2 footings)', r.read?.category === 'Structural Foundations' && !r.read.level && ids(r.t?.ids) === '[4,5]', JSON.stringify(r.read));
r = plain('how many foundations are there?');
check('"how many foundations" -> 2', r.t?.count === 2, r.t?.answer);
r = plain('walls on foundation');
check('"walls on foundation" -> walls on the Foundation level', r.read?.level === 'Foundation' && r.read.category === 'Walls' && ids(r.t?.ids) === '[1,2]', JSON.stringify(r.read));
r = plain('walls on the foundation');
check('"walls on THE foundation" -> the level too', r.read?.level === 'Foundation', JSON.stringify(r.read));
check('the SQL prompt says the same', /"Foundations" \/ "footings" is the Structural Foundations category/.test(SQL_PROMPT));

log('\n=== 4. "The volume / area of X": one total ===');
r = plain('what is the volume of the concrete walls?');
check('"volume of the concrete walls" -> a total, 0 tokens', r.read?.form === 'sum' && r.read.measure === 'volume_m3', JSON.stringify(r.read));
check('...= 2.8 + 3.36 + 1.6 = 7.76 m³', /Total volume of the 3 concrete Walls: 7\.76 m³/.test(r.t?.answer || ''), r.t?.answer);
r = plain('area of the walls');
check('"area of the walls" -> total 30 m²', r.read?.form === 'sum' && /30 m²/.test(r.t?.answer || ''), r.t?.answer);
r = plain('the walls with the largest volume');
check('a ranking with "volume" stays a ranking', r.read?.form === 'rank', JSON.stringify(r.read));
check('the SQL prompt says "area / volume of X" is one total', /means one total: SUM/.test(SQL_PROMPT));

log('\n=== 5. The measured value in the results table ===');
r = plain('walls thicker than 250 mm');
check('"walls thicker than 250 mm" -> the 2 retaining walls', ids(r.t?.ids) === '[1,2]', r.t?.answer);
let msg = elementsMessage(db, r.t.ids, r.t.values, r.t.valueColumn);
check('...each with its thickness, named for the table', msg.valueName === 'thickness' && msg.elements.every(e => e.value === 280 && e.unit === 'mm'), JSON.stringify(msg));
r = plain('show me the walls');
msg = elementsMessage(db, r.t.ids, r.t.values, r.t.valueColumn);
check('a plain list has no value column', msg.valueName === null && msg.elements.every(e => e.value === null), JSON.stringify(msg));
r = plain('the highest wall');
msg = elementsMessage(db, r.t.ids, r.t.values, r.t.valueColumn);
check('a ranking shows the ranked value (height, m)', msg.valueName === 'height' && msg.elements[0].value === 3.5 && msg.elements[0].unit === 'm', JSON.stringify(msg));

log('\n=== The SQL lane: plain wording and values ===');
const rows = db.prepare('SELECT objectid, name, thickness_mm FROM elements_clean WHERE thickness_mm > 250').all();
let shaped = shapeResult(rows, 'Walls whose thickness is over 250 mm.', ['objectid', 'name', 'thickness_mm'], null, 'walls thicker than 250 mm.');
check('"Found 2 walls thicker than 250 mm." (not "Found 2 elements. <reading>")', shaped.answer === 'Found 2 walls thicker than 250 mm.', shaped.answer);
check('...with thickness as the table\'s value column', shaped.valueColumn === 'thickness_mm' && shaped.values.length === 2 && shaped.values[0].value === 280);
shaped = shapeResult([{ count: 3 }], 'Count of walls.', ['count'], null, 'walls');
check('a count reads "There are 3 walls."', shaped.answer === 'There are 3 walls.', shaped.answer);
shaped = shapeResult([{ total: 7.76 }], 'Total volume.', ['total'], null, 'total volume of the concrete walls (m³)');
check('a single number reads "Total volume of the concrete walls (m³): 7.76."', shaped.answer === 'Total volume of the concrete walls (m³): 7.76.', shaped.answer);
shaped = shapeResult([], 'x', ['objectid'], null, 'curtain walls on Level 9');
check('nothing found reads "No curtain walls on Level 9 found."', shaped.answer === 'No curtain walls on Level 9 found.', shaped.answer);
shaped = shapeResult(rows, 'Walls over 250 mm.', ['objectid', 'name', 'thickness_mm']);
check('without a label (old cached plans) the old wording still works', /^Found 2 elements\. Walls over 250 mm\.$/.test(shaped.answer), shaped.answer);
check('the SQL prompt asks for the label in the user\'s words', /"label" is read by the user/.test(SQL_PROMPT));

log('\n=== Time limits ===');
check('OpenAI calls stop after 25 s', OPENAI_TIMEOUT_MS === 25000);
class APIConnectionTimeoutError extends Error {}
check('an OpenAI timeout -> "took too long, try again"', /took too long/.test(aiFailureMessage(new APIConnectionTimeoutError('Request timed out.'))));
check('OpenAI busy (429) -> "busy, try again in a minute"', /busy/.test(aiFailureMessage(Object.assign(new Error('Rate limit'), { status: 429 }))));
check('any other OpenAI failure -> "could not be reached"', /could not be reached/.test(aiFailureMessage(new Error('socket hang up'))));
check('Autodesk downloads stop after 90 s, sign-in after 15 s', aps.DOWNLOAD_TIMEOUT_MS === 90000 && aps.AUTH_TIMEOUT_MS === 15000);
check('axios and fetch timeouts are both recognised', aps.isTimeout({ code: 'ECONNABORTED' }) && aps.isTimeout({ name: 'TimeoutError' }) && !aps.isTimeout(new Error('404')));

(async () => {
    // A stuck Autodesk download: axios gives up and the user is told to try again (503).
    const axios = require('axios');
    const realGet = axios.get;
    axios.get = async (url, options) => {
        check('the download is sent with the time limit', options?.timeout === 90000);
        throw Object.assign(new Error('timeout of 90000ms exceeded'), { code: 'ECONNABORTED' });
    };
    try {
        await aps.getReadyJson('https://example.test/x', 'token');
        check('a timed-out download fails', false);
    } catch (error) {
        const { ModelNotReadyError } = require('../augmented/shared');
        check('a timed-out download -> ModelNotReadyError "Autodesk took too long"', error instanceof ModelNotReadyError && /took too long/.test(error.message), error.message);
    } finally {
        axios.get = realGet;
    }

    log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
})();

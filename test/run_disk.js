// Tests for saving model indexes on disk (augmented/store.js): node test/run_disk.js
// Uses a fresh temporary folder as DATA_DIR, and the fake APS of test/harness.js,
// which counts downloads in calls.tree.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'augmented-disk-'));
process.env.ROUTER = '../routes/ask_agent_simple_v2.js';
const { app, calls, origLog: log } = require('./harness');
const store = require('../augmented/store');
const Database = require('better-sqlite3');

// The default model (routes/ask_agent_simple_v2.js DEFAULT_MODEL).
const URN = 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6ZnFwdGd0Z2Q2N2dnNGd2dWJhZ2VpdmpweHVzdW9pbXMtYmFzaWMtYXBwL3JzdGJhc2ljc2FtcGxlcHJvamVjdC5ydnQ';
const GUID = '2b8b1cf8-31bf-7e71-dfb5-e1d4342ddb82';
const FILE = store.indexFile(URN, GUID);

let base, pass = 0, fail = 0;
function check(name, cond, detail = '') {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n        ' + detail : ''}`);
}
async function api(method, p, body) {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return r.json();
}
const status = () => api('GET', '/api/model_status');

(async () => {
    const server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    let r;

    log('\n=== First load: downloaded from Autodesk, then saved ===');
    r = await status();
    check('first load comes from Autodesk (1 download)', r.source === 'autodesk' && calls.tree === 1, JSON.stringify(r));
    check('the index is saved as one file, with no .tmp left behind', fs.existsSync(FILE) && !fs.existsSync(`${FILE}.tmp`), FILE);
    r = await api('POST', '/api/model_positions', { positions: { 'ext-3001': [0, 0, 0], 'ext-3002': [6, 0, 0] } });
    check('positions stored (in the same file)', r.count === 2, JSON.stringify(r));

    log('\n=== After a restart: reopened from the file, no download ===');
    store.unloadModels();                                   // what a restart does to memory
    r = await status();
    check('after a "restart" the model comes from disk (still 1 download)', r.source === 'disk' && calls.tree === 1, JSON.stringify(r));
    r = await api('GET', '/api/model_positions');
    check('the positions survived the restart', r.count === 2, JSON.stringify(r));
    r = await api('POST', '/api/ask_agent_simple', { prompt: 'how many walls are there?' });
    check('questions are answered from the reopened file', r.data?.count === 2, r.answer);

    log('\n=== Outdated or broken files are rebuilt ===');
    store.unloadModels();
    const db = new Database(FILE);
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();   // pretend an older version built it
    db.close();
    r = await status();
    check('a file from an older schema version is rebuilt (2nd download)', r.source === 'autodesk' && calls.tree === 2, JSON.stringify(r));
    store.unloadModels();
    fs.writeFileSync(FILE, 'not a database');
    r = await status();
    check('a broken file is replaced, not trusted (3rd download)', r.source === 'autodesk' && calls.tree === 3 && r.elementCount > 0, JSON.stringify(r));

    log('\n=== A new upload clears the old index ===');
    store.forgetModel(URN);
    check('forgetModel deletes the file and the memory copy', !fs.existsSync(FILE) && !store.loadedModels.size, FILE);
    r = await status();
    check('the next load downloads the new version (4th download)', r.source === 'autodesk' && calls.tree === 4, JSON.stringify(r));

    log('\n=== A DATA_DIR that can\'t be used never takes the app down ===');
    const realDir = process.env.DATA_DIR;
    const notAFolder = path.join(realDir, 'a-file');
    fs.writeFileSync(notAFolder, 'x');
    process.env.DATA_DIR = notAFolder;                       // e.g. the disk isn't attached
    store.unloadModels();
    r = await status();
    check('unusable DATA_DIR -> the model still loads, in memory', r.ready === true && r.source === 'autodesk', JSON.stringify(r));
    process.env.DATA_DIR = realDir;

    log(`\n${pass} passed, ${fail} failed`);
    server.close();
    store.unloadModels();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
})().catch(e => { log('TEST ERROR', e); process.exit(1); });

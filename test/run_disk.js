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
const state = require('../augmented/state');
const usage = require('../routes/usage');

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
    // /healthz on its own small app, as server.js mounts it: before sign-in.
    const healthServer = require('express')().use(require('../routes/health')).listen(0);
    const healthBase = `http://127.0.0.1:${healthServer.address().port}`;
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

    log('\n=== At most MAX_LOADED_MODELS models stay in memory ===');
    process.env.MAX_LOADED_MODELS = '2';
    const GUID_A = '11111111-1111-1111-1111-111111111111';
    const GUID_B = '22222222-2222-2222-2222-222222222222';
    const view = guid => `/api/model_status?urn=${URN}&guid=${guid}`;
    await api('GET', view(GUID_A));                            // in memory: default + A
    await status();                                            // use the default again: A is now the oldest
    r = await api('GET', view(GUID_B));                        // a 3rd model: A must go
    const loaded = [...store.loadedModels.keys()];
    check('a 3rd model pushes out the least recently used one (A), not the default',
        loaded.length === 2 && !loaded.some(k => k.endsWith(GUID_A)) && loaded.some(k => k.endsWith(GUID)), loaded.join('\n        '));
    const downloads = calls.tree;
    r = await api('GET', view(GUID_A));
    check('the dropped model comes back from its saved file, with no download',
        r.source === 'disk' && calls.tree === downloads && store.loadedModels.size === 2, JSON.stringify(r));
    process.env.MAX_LOADED_MODELS = '';                        // back to the default (2)

    log('\n=== Budgets and follow-ups survive a restart (DATA_DIR/state.sqlite) ===');
    const restart = () => { state.forgetMemory(); usage.store.day = null; store.unloadModels(); };
    usage.store.add('guest:test', 1234);
    restart();
    check('a guest\'s tokens used today are still counted after a restart', usage.store.get('guest:test') === 1234,
        `used ${usage.store.get('guest:test')}`);
    const sheet = { conversationId: 'disk-sheet' };
    await api('POST', '/api/ask_agent_simple', { prompt: 'steel beams on level 2', ...sheet });
    restart();
    r = await api('POST', '/api/ask_agent_simple', { prompt: 'and on level 12?', ...sheet });
    check('a follow-up still builds on the question asked before the restart',
        r.followUp === true && JSON.stringify(r.objectIds) === '[3003]', `${r.followUp} ${JSON.stringify(r.objectIds)} ${r.answer}`);
    usage.store.day = '2000-01-01';                             // pretend the day changed
    usage.store.get('guest:test');
    restart();
    check('a new day still starts every budget again, also on disk', usage.store.get('guest:test') === 0,
        `used ${usage.store.get('guest:test')}`);

    log('\n=== A DATA_DIR that can\'t be used never takes the app down ===');
    const realDir = process.env.DATA_DIR;
    const notAFolder = path.join(realDir, 'a-file');
    fs.writeFileSync(notAFolder, 'x');
    process.env.DATA_DIR = notAFolder;                       // e.g. the disk isn't attached
    store.unloadModels();
    r = await status();
    check('unusable DATA_DIR -> the model still loads, in memory', r.ready === true && r.source === 'autodesk', JSON.stringify(r));
    let health = await fetch(`${healthBase}/healthz`);
    check('...and /healthz says so: 503, disk not writable', health.status === 503 && (await health.json()).disk.writable === false, `status ${health.status}`);
    process.env.DATA_DIR = realDir;
    health = await fetch(`${healthBase}/healthz`);
    r = await health.json();
    check('/healthz with a working disk: 200, saved models and sizes, no model names',
        health.status === 200 && r.disk.writable && r.disk.savedModels >= 1 && r.disk.sizeMB > 0 && r.modelsInMemory >= 1 &&
        !JSON.stringify(r).includes(URN) && !JSON.stringify(r).includes('rstbasic'), JSON.stringify(r));

    log(`\n${pass} passed, ${fail} failed`);
    server.close();
    healthServer.close();
    store.unloadModels();
    state.closeState();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
})().catch(e => { log('TEST ERROR', e); process.exit(1); });

// augmented/state.js
// ===========================================================================
// SAVED STATE - small things that should survive a restart or deploy:
//   - each guest's token budget for today   (routes/usage.js)
//   - the last plan of each conversation, so a follow-up still works (routes/ask_agent_simple_v2.js)
//
// savedMap() works like a Map (get / set / delete / clear), but with DATA_DIR set (on
// Render: /var/data, the persistent disk) every set is ALSO written to one small
// SQLite file, DATA_DIR/state.sqlite. After a restart, get() finds the value there.
// Without DATA_DIR (your PC, the tests) it is a plain in-memory Map, as before.
//
// If the file can't be written, the app keeps working from memory and logs why:
// losing a budget count is better than failing a question.
// ===========================================================================

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { MAX_USER_ENTRIES } = require('./shared');

// The state database: undefined = not opened yet, null = memory only.
let db;
function database() {
    if (db !== undefined) return db;
    db = null;
    if (!process.env.DATA_DIR) return db;
    try {
        fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
        db = new Database(path.join(process.env.DATA_DIR, 'state.sqlite'));
        db.pragma('journal_mode = WAL');
        // One table for everything: `name` says which map a row belongs to ("usage",
        // "followups"), `at` when it was last written (to delete old rows).
        db.exec(`CREATE TABLE IF NOT EXISTS state (
            name  TEXT,
            key   TEXT,
            value TEXT,      -- JSON
            at    INTEGER,   -- ms since 1970
            PRIMARY KEY (name, key)
        )`);
    } catch (error) {
        console.error(`DATA_DIR ${process.env.DATA_DIR} can't hold state.sqlite (${error.message}): budgets and follow-ups stay in memory only.`);
        if (db) db.close();
        db = null;
    }
    return db;
}

// Runs one write; a failing disk is logged, never thrown at the question being answered.
function write(sql, ...values) {
    const saved = database();
    if (!saved) return;
    try {
        saved.prepare(sql).run(...values);
    } catch (error) {
        console.error(`state.sqlite write failed (${error.message}): kept in memory only.`);
    }
}

// options.maxInMemory: how many entries to keep in memory (the oldest are dropped from
//                      memory only; they're still on disk).
// options.maxAgeMs:    rows older than this are deleted from the file now and then.
const allMemories = [];   // every savedMap's memory, so forgetMemory() can empty them all

function savedMap(name, { maxInMemory = MAX_USER_ENTRIES, maxAgeMs = null } = {}) {
    const memory = new Map();
    allMemories.push(memory);
    let lastCleanup = Date.now();

    // Re-inserting moves the key to the end, so the first key is always the oldest.
    function keep(key, value) {
        memory.delete(key);
        memory.set(key, value);
        if (memory.size > maxInMemory) memory.delete(memory.keys().next().value);
    }

    return {
        get(key) {
            if (memory.has(key)) return memory.get(key);
            const saved = database();
            if (!saved) return undefined;
            try {
                const row = saved.prepare('SELECT value, at FROM state WHERE name = ? AND key = ?').get(name, key);
                if (!row || (maxAgeMs && Date.now() - row.at > maxAgeMs)) return undefined;
                const value = JSON.parse(row.value);
                keep(key, value);
                return value;
            } catch (error) {
                console.error(`state.sqlite read failed (${error.message}).`);
                return undefined;
            }
        },
        set(key, value) {
            keep(key, value);
            write('INSERT OR REPLACE INTO state (name, key, value, at) VALUES (?, ?, ?, ?)', name, key, JSON.stringify(value), Date.now());
            // Every 10 minutes at most: delete this map's rows that are too old to matter.
            if (maxAgeMs && Date.now() - lastCleanup > 10 * 60 * 1000) {
                lastCleanup = Date.now();
                write('DELETE FROM state WHERE name = ? AND at < ?', name, Date.now() - maxAgeMs);
            }
        },
        delete(key) {
            memory.delete(key);
            write('DELETE FROM state WHERE name = ? AND key = ?', name, key);
        },
        clear() {
            memory.clear();
            write('DELETE FROM state WHERE name = ?', name);
        }
    };
}

// Empties every saved map's memory, as a restart would; the file stays (the tests use it).
function forgetMemory() {
    for (const memory of allMemories) memory.clear();
}

// Closes the file (the tests use it before deleting their temporary DATA_DIR).
function closeState() {
    if (db) db.close();
    db = undefined;
}

module.exports = { savedMap, forgetMemory, closeState };

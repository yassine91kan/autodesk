// augmented/questionlog.js
// ===========================================================================
// QUESTION LOG - one row per question asked in the app: what was asked, which step
// answered it, the plan, what the user saw, tokens, time, any error, and the user's
// 👍/👎. It answers "which questions fail, and why?" (the admin page shows it:
// routes/admin.js).
//
//   - With DATA_DIR (Render's disk): DATA_DIR/questions.sqlite, kept across restarts.
//     Without it (your PC, the tests): in memory, gone when the server stops.
//   - Rows older than KEEP_DAYS are deleted.
//   - WHO asked is stored as a short scrambled code (a hash of the guest id), never a
//     cookie, an IP address or a name: enough to follow one session, nothing more.
//   - Logging never breaks a question: any error is printed and ignored.
// ===========================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const KEEP_DAYS = 90;
const MAX_ANSWER_LENGTH = 1000;   // characters of the answer kept: enough to see what went wrong
const MAX_NOTE_LENGTH = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

// The log database: undefined = not opened yet.
let db;
function database() {
    if (db !== undefined) return db;
    let file = ':memory:';
    if (process.env.DATA_DIR) {
        try {
            fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
            file = path.join(process.env.DATA_DIR, 'questions.sqlite');
        } catch (error) {
            console.error(`DATA_DIR ${process.env.DATA_DIR} can't hold questions.sqlite (${error.message}): logging in memory only.`);
        }
    }
    try {
        db = new Database(file);
    } catch (error) {
        console.error(`questions.sqlite can't be opened (${error.message}): logging in memory only.`);
        db = new Database(':memory:');
    }
    if (file !== ':memory:') db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS questions (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            at           TEXT,      -- when, ISO time in UTC
            who          TEXT,      -- scrambled user code (see whoCode)
            user_kind    TEXT,      -- guest | member
            model        TEXT,      -- file name of the model
            sheet        TEXT,      -- the page's sheet (conversation) id
            follow_up    INTEGER,   -- 1 = built on the previous question
            question     TEXT,
            tier         INTEGER,   -- 0 = code (+ maybe the intent check), 1 or 2 = LLM tiers
            action       TEXT,      -- list | count | group | rank | total | spatial | clarify | reply
            plan         TEXT,      -- JSON
            answer       TEXT,      -- what the user saw (first MAX_ANSWER_LENGTH characters)
            result_count INTEGER,   -- elements found
            tokens       INTEGER,
            duration_ms  INTEGER,
            error        TEXT,      -- why it wasn't answered, if it wasn't
            vote         INTEGER,   -- 1 = 👍, -1 = 👎, NULL = not rated
            note         TEXT,      -- the user's comment with a 👎
            voted_at     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_questions_at ON questions(at);
    `);
    return db;
}

// "guest:6f1c..." -> "a41be09c27d3". The same user always gets the same code, but the
// code can't be turned back into the guest id (or its cookie).
const whoCode = userId => crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 12);

let lastCleanup = 0;

// Records one question. `entry` holds the fields of the table (userId instead of who).
// Returns the new row's id, or null if it couldn't be written.
function logQuestion(entry) {
    try {
        const log = database();
        const result = log.prepare(`
            INSERT INTO questions (at, who, user_kind, model, sheet, follow_up, question, tier, action,
                                   plan, answer, result_count, tokens, duration_ms, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            new Date().toISOString(),
            whoCode(entry.userId),
            entry.userKind || null,
            entry.model || null,
            entry.sheet || null,
            entry.followUp ? 1 : 0,
            String(entry.question || '').slice(0, 500),
            entry.tier ?? null,
            entry.action || null,
            entry.plan ? JSON.stringify(entry.plan) : null,
            entry.answer == null ? null : String(entry.answer).slice(0, MAX_ANSWER_LENGTH),
            entry.resultCount ?? null,
            entry.tokens ?? 0,
            entry.durationMs ?? null,
            entry.error || null
        );
        // Once an hour at most: forget questions older than KEEP_DAYS.
        if (Date.now() - lastCleanup > 60 * 60 * 1000) {
            lastCleanup = Date.now();
            log.prepare('DELETE FROM questions WHERE at < ?').run(new Date(Date.now() - KEEP_DAYS * DAY_MS).toISOString());
        }
        return Number(result.lastInsertRowid);
    } catch (error) {
        console.error(`Question log write failed (${error.message}): the answer still goes out.`);
        return null;
    }
}

// A 👍 (vote 1) or 👎 (vote -1) from the person who asked. Anyone else is refused, so
// nobody can rate other people's answers. Returns 'ok', 'not-found' or 'not-yours'.
function rateAnswer(questionId, userId, vote, note) {
    const log = database();
    const row = log.prepare('SELECT who FROM questions WHERE id = ?').get(questionId);
    if (!row) return 'not-found';
    if (row.who !== whoCode(userId)) return 'not-yours';
    log.prepare('UPDATE questions SET vote = ?, note = ?, voted_at = ? WHERE id = ?').run(
        vote, note ? String(note).slice(0, MAX_NOTE_LENGTH) : null, new Date().toISOString(), questionId);
    return 'ok';
}

// The plan that answered a question (JSON), or null. Used to forget a cached plan on a 👎.
function planOf(questionId) {
    try {
        const row = database().prepare('SELECT plan FROM questions WHERE id = ?').get(questionId);
        return row?.plan ? JSON.parse(row.plan) : null;
    } catch {
        return null;
    }
}

// The latest questions for the admin page, newest first.
//   show: 'all' | 'down' (👎 only) | 'errors' | 'llm' (answered with OpenAI's help)
const SHOW_FILTERS = {
    all: '1 = 1',
    down: 'vote = -1',
    errors: 'error IS NOT NULL',
    llm: 'tokens > 0'
};
function recentQuestions({ show = 'all', limit = 200 } = {}) {
    const where = SHOW_FILTERS[show] || SHOW_FILTERS.all;
    return database().prepare(`SELECT * FROM questions WHERE ${where} ORDER BY id DESC LIMIT ?`).all(limit);
}

// Per day: questions, tokens, how many code answered alone, 👍, 👎, errors.
function dailyTotals(days = 14) {
    return database().prepare(`
        SELECT substr(at, 1, 10)                                   AS day,
               COUNT(*)                                            AS questions,
               SUM(tokens)                                         AS tokens,
               SUM(CASE WHEN tokens = 0 AND error IS NULL THEN 1 ELSE 0 END) AS byCode,
               SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END)           AS up,
               SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END)          AS down,
               SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END)  AS errors
        FROM questions
        WHERE at >= ?
        GROUP BY day
        ORDER BY day DESC
    `).all(new Date(Date.now() - days * DAY_MS).toISOString());
}

// Closes the file (the tests use it before deleting their temporary DATA_DIR).
function closeLog() {
    if (db) db.close();
    db = undefined;
}

module.exports = { logQuestion, rateAnswer, planOf, recentQuestions, dailyTotals, whoCode, closeLog, KEEP_DAYS, MAX_NOTE_LENGTH };

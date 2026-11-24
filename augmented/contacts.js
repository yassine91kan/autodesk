// augmented/contacts.js
// ===========================================================================
// CONTACT MESSAGES - what visitors send with the landing page's contact form
// (routes/contact.js). The admin page lists them (GET /admin/contacts).
//
//   - With DATA_DIR (Render's disk): DATA_DIR/contacts.sqlite, kept across restarts.
//     Without it (your PC, the tests): in memory, gone when the server stops.
//   - Messages older than KEEP_DAYS are deleted (the form says so).
//   - The sender's IP address is never stored: only a short scrambled code, used to
//     slow down someone sending many messages.
// ===========================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const KEEP_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

let db;   // undefined = not opened yet
function database() {
    if (db !== undefined) return db;
    let file = ':memory:';
    if (process.env.DATA_DIR) {
        try {
            fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
            file = path.join(process.env.DATA_DIR, 'contacts.sqlite');
        } catch (error) {
            console.error(`DATA_DIR ${process.env.DATA_DIR} can't hold contacts.sqlite (${error.message}): keeping messages in memory only.`);
        }
    }
    try {
        db = new Database(file);
    } catch (error) {
        console.error(`contacts.sqlite can't be opened (${error.message}): keeping messages in memory only.`);
        db = new Database(':memory:');
    }
    if (file !== ':memory:') db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            at       TEXT,      -- when, ISO time in UTC
            name     TEXT,
            email    TEXT,
            company  TEXT,
            role     TEXT,
            message  TEXT,
            lang     TEXT,      -- en | fr: the page's language, to reply in it
            sender   TEXT       -- scrambled code of the IP address (never the address)
        );
        CREATE INDEX IF NOT EXISTS messages_at ON messages(at);
    `);
    db.prepare('DELETE FROM messages WHERE at < ?').run(new Date(Date.now() - KEEP_DAYS * DAY_MS).toISOString());
    return db;
}

// A short code for an IP address: the same address gives the same code, but the
// address can't be read back from it.
const senderCode = ip => crypto.createHash('sha256').update(`contact|${ip || ''}`).digest('hex').slice(0, 12);

function saveMessage({ name, email, company, role, message, lang }, ip) {
    const result = database().prepare(`INSERT INTO messages (at, name, email, company, role, message, lang, sender)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(new Date().toISOString(), name, email, company || null, role || null, message, lang || 'en', senderCode(ip));
    return result.lastInsertRowid;
}

// How many messages this address sent since `sinceMs` ago (for the rate limit).
function sentRecently(ip, sinceMs) {
    return database().prepare('SELECT COUNT(*) n FROM messages WHERE sender = ? AND at >= ?')
        .get(senderCode(ip), new Date(Date.now() - sinceMs).toISOString()).n;
}

function recentMessages(limit = 200) {
    return database().prepare('SELECT id, at, name, email, company, role, message, lang FROM messages ORDER BY id DESC LIMIT ?').all(limit);
}

// Closes the file (the tests use it before deleting their temporary DATA_DIR).
function closeContacts() {
    if (db) db.close();
    db = undefined;
}

module.exports = { saveMessage, sentRecently, recentMessages, closeContacts, KEEP_DAYS };

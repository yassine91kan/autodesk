// routes/usage.js
// ---------------------------------------------------------------------------
// Token budgets: how many LLM tokens each visitor may use per day.
//
//   - Guests (no password): GUEST_DAILY_TOKENS each, counted per guest cookie.
//     Clearing cookies gives a new guest id, so the visitor's address (IP) has a
//     budget too: a few guests behind one office router still fit, a script doesn't.
//   - Signed-in users: no daily limit.
//   - Everyone together: the guests' tokens also count towards GLOBAL_DAILY_TOKENS,
//     a safety cap on the OpenAI bill, whatever someone tries.
//   - Every budget starts again at midnight UTC.
//
// The counts live in memory and, with DATA_DIR set (Render's disk), in
// DATA_DIR/state.sqlite too (augmented/state.js), so a restart or deploy doesn't
// hand every guest a fresh budget. Each copy of the app still counts on its own:
// fine with one server; several servers would need a shared database (Redis, Postgres).
// ---------------------------------------------------------------------------

const { savedMap } = require('../augmented/state');

// 20,000 = about 20-25 questions. A GUEST_DAILY_TOKENS environment variable overrides it,
// e.g. 2000 to try the limit locally without asking 25 questions.
const GUEST_DAILY_TOKENS = Number(process.env.GUEST_DAILY_TOKENS) || 20000;
const IP_DAILY_TOKENS = 3 * GUEST_DAILY_TOKENS;
const GLOBAL_DAILY_TOKENS = 2000000;   // all guests together, about $0.25 a day with gpt-6-luna
const WARN_AT = 0.8;                   // the page warns at 80% of the budget

// Questions per minute per visitor, so nobody can fire hundreds in a row.
const MAX_QUESTIONS_PER_MINUTE = 10;

// ---------------------------------------------------------------- the store
// "Which day is it, and how much has each key used today?" Keys look like
// "guest:<id>", "ip:<address>" and "global". The saved "#day" entry says which day
// the saved counts belong to, so after a restart they're kept on the same day only.
const DAY_KEY = '#day';
const store = {
    day: null,
    used: savedMap('usage', { maxInMemory: 10000 }),
    // Today's date in UTC, "2026-10-18": when it changes, every count starts again.
    today() {
        const day = new Date().toISOString().slice(0, 10);
        if (this.day === null) this.day = this.used.get(DAY_KEY) ?? null;   // just started: the saved counts' day
        if (day !== this.day) {
            this.day = day;
            this.used.clear();
            this.used.set(DAY_KEY, day);
        }
        return day;
    },
    get(key) {
        this.today();
        return this.used.get(key) || 0;
    },
    add(key, tokens) {
        this.today();
        this.used.set(key, (this.used.get(key) || 0) + tokens);
    }
};

// When each visitor asked recently, for the per-minute limit: key -> [times in ms].
const recentQuestions = new Map();

// ---------------------------------------------------------------- helpers

// The budget keys for one request. req.user is set by login.js:
// { id: 'guest:abc...', kind: 'guest' } or { id: 'member', kind: 'member' }.
// No req.user means login.js isn't mounted (the tests): no budget, like local development.
function keysFor(req) {
    const user = req.user || { id: 'local', kind: 'member' };
    return { user, userKey: user.id, ipKey: `ip:${req.ip}` };
}

// What the page shows: how much of today's budget is used. null = no limit.
function budgetOf(req) {
    const { user, userKey } = keysFor(req);
    if (user.kind === 'member') {
        return { kind: 'member', used: null, limit: null, warn: false };
    }
    const used = store.get(userKey);
    return { kind: 'guest', used, limit: GUEST_DAILY_TOKENS, warn: used >= GUEST_DAILY_TOKENS * WARN_AT };
}

// Runs BEFORE a question. Returns null if it may go ahead, otherwise
// { status, message, limitReached } for the response.
function checkBefore(req) {
    const { user, userKey, ipKey } = keysFor(req);
    if (user.kind === 'member') return null; // signed in: no limits

    // Per-minute limit.
    const now = Date.now();
    const times = (recentQuestions.get(userKey) || []).filter(time => now - time < 60 * 1000);
    if (times.length >= MAX_QUESTIONS_PER_MINUTE) {
        return { status: 429, message: 'That is a lot of questions in one minute. Wait a moment, then ask again.' };
    }
    times.push(now);
    recentQuestions.set(userKey, times);
    if (recentQuestions.size > 10000) recentQuestions.delete(recentQuestions.keys().next().value); // forget the oldest

    if (store.get(userKey) >= GUEST_DAILY_TOKENS || store.get(ipKey) >= IP_DAILY_TOKENS) {
        return {
            status: 429,
            limitReached: true,
            message: `You've used today's free ${GUEST_DAILY_TOKENS.toLocaleString('en-US')} tokens. Sign in to keep asking, or come back tomorrow.`
        };
    }
    if (store.get('global') >= GLOBAL_DAILY_TOKENS) {
        return { status: 429, limitReached: true, message: 'The free questions for today are used up. Sign in to keep asking, or come back tomorrow.' };
    }
    return null;
}

// Runs AFTER a question, with the tokens it really used. (A question is never cut
// off halfway, so the last one of the day may take a guest a little over the limit.)
function recordAfter(req, tokens) {
    const { user, userKey, ipKey } = keysFor(req);
    if (user.kind === 'member' || !tokens) return;
    store.add(userKey, tokens);
    store.add(ipKey, tokens);
    store.add('global', tokens);
}

module.exports = { budgetOf, checkBefore, recordAfter, GUEST_DAILY_TOKENS, MAX_QUESTIONS_PER_MINUTE, store };

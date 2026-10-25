// routes/login.js
// ---------------------------------------------------------------------------
// Who is asking: a guest, or someone signed in with the shared password.
//
//   - Anyone who opens the link can ask right away, as a GUEST. Their browser gets a
//     guest cookie with a random id, so their questions, selections and token budget
//     are kept apart from everyone else's. Guests have a daily token budget (usage.js).
//   - Signing in with the password (APP_PASSWORD, a Heroku config var, never written
//     in the code) removes the budget and allows uploading models.
//   - Both cookies hold an id or expiry time plus a signature, so they can't be forged
//     or extended without the secret.
//   - The gate runs before every other route and the static files, and puts
//     req.user = { id, kind: 'guest' | 'member' } on every request.
//
// Mount it in server.js BEFORE express.static and the other routes.
// No extra packages: only Node's built-in crypto.
// ---------------------------------------------------------------------------

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const router = express.Router();

const usage = require('./usage');

const COOKIE_NAME = 'augmented_session';
const SESSION_DAYS = 7;
const GUEST_COOKIE = 'augmented_guest';
const GUEST_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// Files the login page itself needs, so they load before signing in.
const PUBLIC_PATHS = new Set([
    '/login',
    '/assets/css/drawing-sheet.css',
    '/assets/css/login.css',
    '/assets/images/augmented-mark.svg',
    '/assets/images/favicon.svg'
]);

// What guests may do besides reading pages (GET): ask questions and send the Viewer's
// coordinates. Everything else (uploading a model, the older LangChain assistant, whose
// tokens aren't counted) needs signing in.
const GUEST_WRITES = new Set(['POST /ask_agent_simple', 'PUT /ask_agent_simple', 'POST /model_positions', 'POST /login', 'POST /logout']);

// Slows down password guessing: after 10 wrong passwords from one address,
// that address must wait 15 minutes.
const MAX_FAILED_ATTEMPTS = 10;
const LOCK_MS = 15 * 60 * 1000;
const failedAttempts = new Map(); // ip -> { count, firstAt }

function appPassword() {
    return process.env.APP_PASSWORD || '';
}

// The key that signs the cookie. SESSION_SECRET if set; otherwise derived from the
// password, so changing the password also signs everyone out.
function signingKey() {
    return crypto.createHash('sha256')
        .update(`augmented-session:${process.env.SESSION_SECRET || appPassword()}`)
        .digest();
}

function sign(text) {
    return crypto.createHmac('sha256', signingKey()).update(text).digest('base64url');
}

// Compares two strings in constant time, so the response time doesn't reveal how
// many characters of a guess were right. Hashing first makes the lengths equal.
function sameText(a, b) {
    const hashA = crypto.createHash('sha256').update(String(a)).digest();
    const hashB = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

// Cookie value: "<expiry in ms>.<signature of the expiry>".
function newSessionValue() {
    const expiresAt = String(Date.now() + SESSION_DAYS * DAY_MS);
    return `${expiresAt}.${sign(expiresAt)}`;
}

// Guest cookie value: "<random id>.<signature of the id>".
function newGuestValue() {
    const id = crypto.randomBytes(16).toString('base64url'); // 128 random bits: impossible to guess
    return `${id}.${sign('guest:' + id)}`;
}

// The guest id in a cookie value, or null if it isn't one we signed.
function guestIdFrom(value) {
    const [id, signature] = String(value || '').split('.');
    return id && signature && sameText(signature, sign('guest:' + id)) ? id : null;
}

function isValidSession(value) {
    if (!value) return false;
    const [expiresAt, signature] = value.split('.');
    if (!expiresAt || !signature) return false;
    return sameText(signature, sign(expiresAt)) && Number(expiresAt) > Date.now();
}

// Reads one cookie from the request's Cookie header ("a=1; b=2").
function readCookie(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return decodeURIComponent(rest.join('='));
    }
    return null;
}

function setCookie(req, res, name, value, maxAgeSeconds) {
    // HttpOnly: page scripts can't read it. SameSite=Lax: other sites can't send
    // it along with their own form posts. Secure: only over https (Heroku).
    // append, not set: one response may set both cookies.
    const secure = req.secure ? '; Secure' : '';
    res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
}

function setSessionCookie(req, res, value, maxAgeSeconds) {
    setCookie(req, res, COOKIE_NAME, value, maxAgeSeconds);
}

// Only allow returning to a page of THIS site ("/..."), never "//other-site.com".
function safeNext(next) {
    const value = typeof next === 'string' ? next : '';
    return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

function isLocked(ip) {
    const entry = failedAttempts.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.firstAt > LOCK_MS) {
        failedAttempts.delete(ip); // the 15 minutes are over
        return false;
    }
    return entry.count >= MAX_FAILED_ATTEMPTS;
}

function recordFailure(ip) {
    const entry = failedAttempts.get(ip);
    if (!entry || Date.now() - entry.firstAt > LOCK_MS) {
        failedAttempts.set(ip, { count: 1, firstAt: Date.now() });
    } else {
        entry.count++;
    }
}

// ---------------------------------------------------------------- routes

router.get('/login', (req, res) => {
    if (appPassword() && isValidSession(readCookie(req, COOKIE_NAME))) {
        return res.redirect(safeNext(req.query.next)); // already signed in
    }
    res.sendFile(path.join(__dirname, '..', 'wwwroot', 'login.html'));
});

router.post('/login', (req, res) => {
    const next = safeNext(req.body?.next);
    const back = (error) => res.redirect(303, `/login?error=${error}&next=${encodeURIComponent(next)}`);

    if (isLocked(req.ip)) {
        return back('locked');
    }
    if (!appPassword() || !sameText(req.body?.password || '', appPassword())) {
        recordFailure(req.ip);
        return back('wrong');
    }

    failedAttempts.delete(req.ip);
    setSessionCookie(req, res, newSessionValue(), SESSION_DAYS * 24 * 60 * 60);
    res.redirect(303, next); // 303 = "now GET this page", so a reload doesn't re-send the password
});

router.post('/logout', (req, res) => {
    setSessionCookie(req, res, '', 0); // Max-Age=0 deletes the cookie
    res.redirect(303, '/');             // back to the app, as a guest again
});

// ---------------------------------------------------------------- the gate

router.use((req, res, next) => {
    if (!appPassword()) {
        // On Heroku (production) a missing password must NOT mean "open to everyone".
        if (process.env.NODE_ENV === 'production') {
            return res.status(503).type('text/plain').send('Sign-in is not configured: set the APP_PASSWORD config var.');
        }
        req.user = { id: 'local', kind: 'member' }; // local development: no budget, everything allowed
        return next();
    }

    if (isValidSession(readCookie(req, COOKIE_NAME))) {
        req.user = { id: 'member', kind: 'member' };
        return next();
    }
    if (PUBLIC_PATHS.has(req.path)) {
        return next();
    }

    // A guest. Only reading and asking: anything else needs signing in.
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (!isRead && !GUEST_WRITES.has(`${req.method} ${req.path}`)) {
        return res.status(401).json({ success: false, signIn: true, message: 'Sign in to use this.' });
    }

    // Same guest as before (valid cookie), or a new one: a fresh random id.
    let guestId = guestIdFrom(readCookie(req, GUEST_COOKIE));
    if (!guestId) {
        const value = newGuestValue();
        guestId = value.split('.')[0];
        setCookie(req, res, GUEST_COOKIE, value, GUEST_DAYS * 24 * 60 * 60);
    }
    req.user = { id: `guest:${guestId}`, kind: 'guest' };
    next();
});

// Who am I, and how much of today's budget is left? (The page asks on load, to show
// "Sign in" or "Log out" and to warn before the budget runs out.)
router.get('/api/me', (req, res) => {
    res.json({ kind: req.user?.kind || 'member', budget: usage.budgetOf(req) });
});

if (!appPassword()) {
    console.warn(process.env.NODE_ENV === 'production'
        ? 'login: APP_PASSWORD is not set, so every request is refused until it is.'
        : 'login: APP_PASSWORD is not set, so sign-in is OFF (local development only).');
}

module.exports = router;

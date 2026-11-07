// routes/pages.js
// ---------------------------------------------------------------------------
// The site's pages at clean addresses (no ".html"):
//
//   /        the landing page   (wwwroot/landing.html)
//   /app     the app            (wwwroot/index.html); "/app#Model.rvt" opens a model
//   /login   sign-in            (routes/login.js)
//
// The old file addresses redirect permanently, so existing links and bookmarks still
// work (the browser keeps the "#model" part across the redirect).
//
// Mount it AFTER routes/login.js (the sign-in gate) and BEFORE express.static, which
// must not serve index.html at "/" any more (server.js: { index: false }).
// ---------------------------------------------------------------------------

const express = require('express');
const path = require('path');

const router = express.Router();
const page = file => (req, res) => res.sendFile(path.join(__dirname, '..', 'wwwroot', file));

router.get('/', page('landing.html'));
router.get('/app', page('index.html'));
router.get('/landing.html', (req, res) => res.redirect(301, '/'));
router.get('/index.html', (req, res) => res.redirect(301, '/app'));

module.exports = router;

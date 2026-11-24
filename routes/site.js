// routes/site.js
// ---------------------------------------------------------------------------
// Site-wide basics, mounted FIRST in server.js:
//
//   1. One public address. Pages opened on the Render address (augmented-zvkd.onrender.com)
//      move permanently to https://www.askaugmented.com, so search engines and shared
//      links use one address. NOT moved: /healthz (Render's health check calls the Render
//      address), /mcp (the MCP connector), /api and other non-page requests, so nothing
//      that calls the server directly breaks.
//   2. Security headers on every response: HTTPS only (HSTS), no MIME sniffing, a
//      referrer policy, and no "X-Powered-By: Express". Pages also refuse to be framed
//      by other sites (the MCP viewer is not served from here, so it is unaffected).
//   3. /robots.txt and /sitemap.xml for search engines.
//
// The public address comes from PUBLIC_HOST (default www.askaugmented.com). The move only
// happens for *.onrender.com hosts, so your PC (localhost) and the tests are unaffected.
// ---------------------------------------------------------------------------

const express = require('express');

const router = express.Router();
const publicHost = () => process.env.PUBLIC_HOST || 'www.askaugmented.com';
const PAGES = ['/', '/app', '/login'];              // the public pages, for the sitemap
const NOT_MOVED = /^\/(healthz|mcp|api)(\/|$)/;      // called directly by machines: never redirected

router.use((req, res, next) => {
    // 1. the Render address -> the public address (pages only)
    const fromRender = /\.onrender\.com$/i.test(req.hostname || '');
    if (fromRender && (req.method === 'GET' || req.method === 'HEAD') && !NOT_MOVED.test(req.path)) {
        return res.redirect(301, `https://${publicHost()}${req.originalUrl}`);
    }

    // 2. security headers
    res.removeHeader('X-Powered-By');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (!req.path.startsWith('/mcp')) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
});

// 3. for search engines: the pages to index, and what to skip
router.get('/robots.txt', (req, res) => {
    res.type('text/plain').send([
        'User-agent: *',
        'Allow: /',
        'Disallow: /admin/',
        'Disallow: /api/',
        'Disallow: /mcp',
        `Sitemap: https://${publicHost()}/sitemap.xml`,
        ''
    ].join('\n'));
});

router.get('/sitemap.xml', (req, res) => {
    const urls = PAGES.map(p => `  <url><loc>https://${publicHost()}${p === '/' ? '/' : p}</loc></url>`).join('\n');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
});

module.exports = router;

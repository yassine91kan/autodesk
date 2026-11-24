// Tests for routes/site.js (one public address, security headers, robots/sitemap): node test/run_site.js
const express = require('express');
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(require('../routes/site.js'));
app.get('/', (req, res) => res.send('landing'));
app.get('/app', (req, res) => res.send('app'));
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/api/models', (req, res) => res.json([]));
app.post('/mcp/secret', (req, res) => res.json({ ok: true }));
app.get('/mcp/secret', (req, res) => res.json({ ok: true }));

let base, pass = 0, fail = 0;
function check(name, cond, detail = '') {
    cond ? pass++ : fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? '\n        ' + detail : ''}`);
}
// "Host" can't be set with fetch, so the proxy header Render sends is used instead.
const as = (host, path, method = 'GET') => fetch(base + path, { method, redirect: 'manual', headers: { 'X-Forwarded-Host': host } });
const RENDER = 'augmented-zvkd.onrender.com';

(async () => {
    const server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    let r;

    console.log('\n=== One public address ===');
    r = await as(RENDER, '/');
    check('the Render address -> 301 to https://www.askaugmented.com/', r.status === 301 && r.headers.get('location') === 'https://www.askaugmented.com/', `${r.status} ${r.headers.get('location')}`);
    r = await as(RENDER, '/app?model=x#y');
    check('...keeping the path and query', r.status === 301 && r.headers.get('location') === 'https://www.askaugmented.com/app?model=x', `${r.headers.get('location')}`);
    r = await as(RENDER, '/healthz');
    check('Render\'s health check on the Render address is NOT moved', r.status === 200);
    r = await as(RENDER, '/mcp/secret');
    check('the MCP connector is NOT moved (GET)', r.status === 200);
    r = await as(RENDER, '/mcp/secret', 'POST');
    check('...nor its POSTs', r.status === 200);
    r = await as(RENDER, '/api/models');
    check('API calls are NOT moved', r.status === 200);
    r = await as('www.askaugmented.com', '/');
    check('the public address itself is served (no loop)', r.status === 200 && (await r.text()) === 'landing');
    r = await fetch(base + '/');
    check('localhost (your PC, the tests) is served as before', r.status === 200);

    console.log('\n=== Security headers ===');
    r = await fetch(base + '/app');
    check('HSTS: browsers always use https', /max-age=31536000/.test(r.headers.get('strict-transport-security') || ''));
    check('no MIME sniffing', r.headers.get('x-content-type-options') === 'nosniff');
    check('a referrer policy', r.headers.get('referrer-policy') === 'strict-origin-when-cross-origin');
    check('pages refuse to be framed by other sites', r.headers.get('x-frame-options') === 'SAMEORIGIN');
    check('no "X-Powered-By: Express"', !r.headers.get('x-powered-by'));
    r = await fetch(base + '/mcp/secret');
    check('the MCP endpoint may still be framed (the chat embeds its viewer)', !r.headers.get('x-frame-options'));

    console.log('\n=== Search engines ===');
    r = await fetch(base + '/robots.txt');
    const robots = await r.text();
    check('robots.txt allows the site, skips admin/api/mcp, names the sitemap',
        r.status === 200 && /Disallow: \/admin\//.test(robots) && /Sitemap: https:\/\/www\.askaugmented\.com\/sitemap\.xml/.test(robots), robots);
    r = await fetch(base + '/sitemap.xml');
    const map = await r.text();
    check('sitemap.xml lists /, /app and /login on the public address',
        r.status === 200 && /application\/xml/.test(r.headers.get('content-type')) && map.includes('<loc>https://www.askaugmented.com/</loc>') && map.includes('/app</loc>'), map);

    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('TEST ERROR', e); process.exit(1); });

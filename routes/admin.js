// routes/admin.js
// ---------------------------------------------------------------------------
// GET /admin/questions - the question log (augmented/questionlog.js) as a page:
// totals per day at the top, then the latest 200 questions, newest first.
// Filters: ?show=down (👎 only), errors, llm (answered with OpenAI's help).
//
// Signed-in users only: guests (and anyone without the password) get 403. Mount it
// AFTER routes/login.js, which sets req.user.
// Everything shown is escaped (escapeHtml), so a question typed as "<script>..." is
// displayed as text, never run.
// ---------------------------------------------------------------------------

const express = require('express');
const { recentQuestions, dailyTotals, KEEP_DAYS } = require('../augmented/questionlog');

const router = express.Router();

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Which step answered, in words.
function stepOf(row) {
    if (row.error && row.tier === null) return 'not answered';
    if (row.tier === 1) return 'tier 1 (LLM)';
    if (row.tier === 2) return 'tier 2 (LLM)';
    if (row.tier === 3) return 'SQL written by LLM';
    if (row.plan && JSON.parse(row.plan).lane === 'cache') return 'cached SQL (no LLM)';
    return row.tokens > 0 ? 'intent check + code' : 'code only';
}

const FILTERS = [['all', 'All'], ['down', '👎 only'], ['errors', 'Errors'], ['llm', 'Used OpenAI']];

router.get('/admin/questions', (req, res) => {
    // No req.user = login.js isn't mounted (local tests): treated as signed in, like usage.js.
    if ((req.user?.kind || 'member') !== 'member') {
        return res.status(403).type('text/plain').send('Sign in to see the question log.');
    }
    const show = FILTERS.some(([key]) => key === req.query.show) ? req.query.show : 'all';
    const days = dailyTotals(14);
    const rows = recentQuestions({ show, limit: 200 });

    const dayRows = days.map(d => `<tr>
        <td>${escapeHtml(d.day)}</td><td>${d.questions}</td><td>${(d.tokens || 0).toLocaleString('en-US')}</td>
        <td>${d.questions ? Math.round(100 * d.byCode / d.questions) : 0}%</td>
        <td>${d.up}</td><td>${d.down}</td><td>${d.errors}</td></tr>`).join('');

    const questionRows = rows.map(r => {
        const vote = r.vote === 1 ? '👍' : r.vote === -1 ? '👎' : '';
        return `<tr class="${r.vote === -1 ? 'down' : ''}${r.error ? ' error' : ''}">
        <td class="nowrap">${escapeHtml(r.at.slice(0, 16).replace('T', ' '))}</td>
        <td class="mono">${escapeHtml(r.who)}<br><small>${escapeHtml(r.user_kind)}</small></td>
        <td><strong>${escapeHtml(r.question)}</strong>${r.follow_up ? '<br><small>follow-up</small>' : ''}
            <br><small>${escapeHtml(r.model)}</small></td>
        <td>${escapeHtml(stepOf(r))}<br><small>${escapeHtml(r.action)}</small></td>
        <td>${r.error ? `<span class="err">${escapeHtml(r.error)}</span>` : escapeHtml(r.answer)}
            ${r.plan ? `<details><summary>plan</summary><pre>${escapeHtml(JSON.stringify(JSON.parse(r.plan), null, 1))}</pre></details>` : ''}</td>
        <td class="num">${r.result_count ?? ''}</td>
        <td class="num">${r.tokens}</td>
        <td class="num">${r.duration_ms ?? ''}</td>
        <td>${vote}${r.note ? `<br><small>${escapeHtml(r.note)}</small>` : ''}</td></tr>`;
    }).join('');

    const links = FILTERS.map(([key, label]) => key === show
        ? `<strong>${label}</strong>` : `<a href="?show=${key}">${label}</a>`).join(' · ');

    res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Question log</title>
<style>
  :root { --bg: #fff; --fg: #1d1d1b; --muted: #6b6a65; --line: #e2e0d8; --down: #fcebeb; --err: #a32d2d; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1d1d1b; --fg: #ecebe6; --muted: #a3a29b; --line: #3a3936; --down: #3b1d1d; --err: #f09595; } }
  body { background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; margin: 0 16px 40px; }
  h1 { font-size: 20px; font-weight: 600; margin: 20px 0 4px; } h2 { font-size: 16px; margin: 24px 0 8px; }
  p, small { color: var(--muted); } table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
  th { font-weight: 600; color: var(--muted); } .num { text-align: right; } .nowrap { white-space: nowrap; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; } tr.down { background: var(--down); }
  .err { color: var(--err); } pre { font-size: 12px; white-space: pre-wrap; margin: 4px 0; }
  .wrap { overflow-x: auto; } a { color: inherit; }
</style></head><body>
<h1>Question log</h1>
<p>Every question asked in the app, kept ${KEEP_DAYS} days. "Who" is a scrambled code per visitor, not a name.</p>
<h2>Last 14 days</h2>
<div class="wrap"><table><tr><th>Day</th><th>Questions</th><th>Tokens</th><th>Code only</th><th>👍</th><th>👎</th><th>Errors</th></tr>
${dayRows || '<tr><td colspan="7">No questions yet.</td></tr>'}</table></div>
<h2>Latest questions</h2>
<p>${links}</p>
<div class="wrap"><table><tr><th>When (UTC)</th><th>Who</th><th>Question</th><th>Step</th><th>Answer</th><th>Found</th><th>Tokens</th><th>ms</th><th>Rating</th></tr>
${questionRows || '<tr><td colspan="9">Nothing to show.</td></tr>'}</table></div>
</body></html>`);
});

module.exports = router;

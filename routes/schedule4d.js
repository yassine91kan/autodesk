// routes/schedule4d.js
// ---------------------------------------------------------------------------
// The 4D demo: an auto-generated construction schedule for a model.
//
//   GET /4d                                  the page (wwwroot/4d.html)
//   GET /api/4d/schedule?urn=...&start=...   the schedule as JSON (augmented/schedule4d.js)
//
// The schedule is built from the model's SQLite index (augmented/store.js), so it costs
// no LLM tokens. A built schedule is kept in memory per model + start date.
// ---------------------------------------------------------------------------

const express = require('express');
const path = require('path');
const { getModel } = require('../augmented/store');
const { findMainViewGuid } = require('../augmented/aps');
const { buildSchedule } = require('../augmented/schedule4d');
const { BadRequestError, ModelNotReadyError, UnsupportedModelError } = require('../augmented/shared');

const router = express.Router();

// Same default and checks as routes/ask_agent_simple_v2.js.
const DEFAULT_MODEL = {
    urn: 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6ZnFwdGd0Z2Q2N2dnNGd2dWJhZ2VpdmpweHVzdW9pbXMtYmFzaWMtYXBwL3JzdGJhc2ljc2FtcGxlcHJvamVjdC5ydnQ',
    guid: '2b8b1cf8-31bf-7e71-dfb5-e1d4342ddb82'
};
const URN_PATTERN = /^[A-Za-z0-9_-]+=*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const viewGuids = new Map();

async function resolveModel(urn) {
    if (!urn || urn === DEFAULT_MODEL.urn) return { ...DEFAULT_MODEL };
    if (!URN_PATTERN.test(urn)) throw new BadRequestError('That is not a valid model id.');
    if (!viewGuids.has(urn)) viewGuids.set(urn, await findMainViewGuid(urn));
    return { urn, guid: viewGuids.get(urn) };
}

// "urn:guid|start" -> schedule. Small: a handful of models, ~50 KB-1 MB each.
const schedules = new Map();
const MAX_CACHED = 12;

router.get('/4d', (req, res) => res.sendFile(path.join(__dirname, '..', 'wwwroot', '4d.html')));

router.get('/api/4d/schedule', async (req, res) => {
    try {
        const start = req.query.start ? String(req.query.start) : undefined;
        if (start && !DATE_PATTERN.test(start)) throw new BadRequestError('start must be a date like 2027-01-04.');
        const { urn, guid } = await resolveModel(req.query.urn ? String(req.query.urn) : '');
        const model = await getModel(urn, guid);

        const key = `${model.key}|${start || 'next-monday'}`;
        if (!schedules.has(key)) {
            const started = Date.now();
            schedules.set(key, { ...buildSchedule(model.db, { start }), urn, guid, builtInMs: null });
            schedules.get(key).builtInMs = Date.now() - started;
            if (schedules.size > MAX_CACHED) schedules.delete(schedules.keys().next().value);
        }
        res.json({ success: true, schedule: schedules.get(key) });
    } catch (error) {
        const status = error instanceof BadRequestError ? 400
            : error instanceof ModelNotReadyError ? 503
            : error instanceof UnsupportedModelError ? 422 : 500;
        if (status === 500) console.error('4D schedule error:', error);
        res.status(status).json({ success: false, message: status === 500 ? 'Something went wrong on the server.' : error.message });
    }
});

module.exports = router;

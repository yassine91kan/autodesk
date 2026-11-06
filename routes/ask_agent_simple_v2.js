// routes/ask_agent_simple_v2.js
// ===========================================================================
// The HTTP layer of the chatbot. It only reads the request, calls the domain code
// in augmented/, and sends the response. The question's journey:
//
//   route checks ─► matcher (words) ─► planner (tier) ─► engine (validate + SQL) ─► answer
//
//   augmented/aps.js       Autodesk login + download
//   augmented/store.js     SQLite index, vocabulary, loaded models
//   augmented/words.js     all the word lists
//   augmented/matcher.js   question words -> model names
//   augmented/plans.js     plans written by code (0 tokens), follow-ups
//   augmented/planner.js   the LLM tiers
//   augmented/engine.js    validation, SQL, answers
//   augmented/shared.js    errors, shared paths, small helpers
// ===========================================================================

const express = require('express');
const usage = require('./usage');   // daily token budgets per visitor
const { savedMap } = require('../augmented/state');
const {
    ModelNotReadyError, UnsupportedModelError, PlannerError, BadRequestError, remember, placeholders
} = require('../augmented/shared');
const {
    findMainViewGuid
} = require('../augmented/aps');
const {
    getModel, setCoordinates
} = require('../augmented/store');
const {
    answerQuestion
} = require('../augmented/planner');
const {
    runPlan
} = require('../augmented/engine');
const { setPositions, positionCount } = require('../augmented/spatial');

const router = express.Router();

// Used when the frontend doesn't send a urn (older pages and extensions).
const DEFAULT_MODEL = {
    urn: 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6ZnFwdGd0Z2Q2N2dnNGd2dWJhZ2VpdmpweHVzdW9pbXMtYmFzaWMtYXBwL3JzdGJhc2ljc2FtcGxlcHJvamVjdC5ydnQ',
    guid: '2b8b1cf8-31bf-7e71-dfb5-e1d4342ddb82'
};

// Answers that come with a list of elements for the page's result table.
const ELEMENT_ACTIONS = new Set(['list', 'count', 'rank', 'total', 'spatial']);

// Object ids of the last answer per user and model, for GET /ask_agent_simple.
const lastResults = new Map(); // "userId|urn:guid" -> [ids]

// Who is asking (set by login.js). Without login.js (the tests) everyone is "local".
const userOf = req => req.user?.id || 'local';

// The last plan that ran, per user + model + sheet, for follow-up questions:
// "userId|urn:guid|sheetId" -> { question, plan, at }. The page sends a new sheet id
// when you press New sheet or pick another model, which starts afresh.
// Saved on Render's disk too (augmented/state.js), so a deploy doesn't cut a conversation.
const FOLLOW_UP_MINUTES = 30;   // after 30 quiet minutes a question starts afresh
const lastPlans = savedMap('followups', { maxAgeMs: FOLLOW_UP_MINUTES * 60 * 1000 });
const SHEET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
function conversationKey(req, urn, guid) {
    const sheet = SHEET_ID_PATTERN.test(String(req.body?.conversationId || '')) ? req.body.conversationId : 'default';
    return `${userOf(req)}|${urn}:${guid}|${sheet}`;
}

// Longer questions are refused: no real question needs more, and a pasted page
// would only burn tokens.
const MAX_QUESTION_LENGTH = 500;

// What a URN and a GUID may contain. The URN goes into an APS URL, so anything else
// (slashes, "..", spaces) is refused before it gets there.
const URN_PATTERN = /^[A-Za-z0-9_-]+=*$/;
const GUID_PATTERN = /^[A-Za-z0-9-]+$/;

// urn -> GUID of its main 3D view, so APS is asked only once per model.
const viewGuids = new Map();

// Works out WHICH model a request is about. Accepts { urn, guid } or
// { model: { urn, guid } }. The page sends only the urn (from the model dropdown);
// the GUID is then looked up once and remembered. No urn = the default model.
async function resolveModel(input = {}) {
    const source = input.model && typeof input.model === 'object' ? input.model : input;
    if (!source.urn) {
        return { ...DEFAULT_MODEL };
    }

    const urn = String(source.urn);
    if (!URN_PATTERN.test(urn)) {
        throw new BadRequestError('That is not a valid model id.');
    }
    if (source.guid) {
        if (!GUID_PATTERN.test(String(source.guid))) {
            throw new BadRequestError('That is not a valid view id.');
        }
        return { urn, guid: String(source.guid) };
    }
    if (urn === DEFAULT_MODEL.urn) {
        return { ...DEFAULT_MODEL };
    }
    if (!viewGuids.has(urn)) {
        viewGuids.set(urn, await findMainViewGuid(urn));
    }
    return { urn, guid: viewGuids.get(urn) };
}

// "dXJuOm...ydnQ" -> "rstbasicsampleproject.rvt". A URN is the file's storage id in
// base64 ("urn:adsk.objects:os.object:bucket/file.rvt"); the part after the last
// "/" is the file name the user sees in the model dropdown.
function modelNameFromUrn(urn) {
    const name = Buffer.from(urn, 'base64url').toString('utf8').split('/').pop();
    try {
        return decodeURIComponent(name); // stored names use %20 for spaces: "Snowdon%20Towers..." -> "Snowdon Towers..."
    } catch {
        return name;                     // not valid %-encoding: show it as it is
    }
}

// "category Structural Framing", "Element.Family = Light Gauge-Joists | ..." (debug output).
function describeEntries(entries) {
    const shown = entries.slice(0, 3).map(entry => {
        if (entry.kind === 'category' || entry.kind === 'missing-category') return `${entry.kind} ${entry.category}`;
        if (entry.kind === 'property') return `property ${entry.paths.join(' / ')}`;
        if (entry.kind === 'value') return `${entry.path} = ${entry.value}`;
        return entry.kind;
    });
    return shown.join(' | ') + (entries.length > 3 ? ` (+${entries.length - 3} more)` : '');
}

// Which HTTP status each of our error types means.
function httpStatus(error) {
    if (error instanceof BadRequestError) return 400;       // the request itself is wrong
    if (error instanceof UnsupportedModelError) return 422; // valid request, but not possible with this model
    if (error instanceof PlannerError) return 502;          // a service we depend on misbehaved
    if (error instanceof ModelNotReadyError) return 503;    // try again later
    return 500;                                             // a bug: details go to the console only
}

// Turns any error into the right HTTP status and a friendly message.
function sendError(res, error) {
    const status = httpStatus(error);
    if (status === 500) {
        console.error('ask_agent_simple error:', error);
        return res.status(500).json({ success: false, message: 'Something went wrong on the server.' });
    }
    return res.status(status).json({ success: false, message: error.message });
}

// Main chat endpoint.
router.post('/ask_agent_simple', async (req, res) => {
    try {
        const question = String(req.body?.prompt || '').trim();
        if (!question) {
            return res.status(400).json({ success: false, message: 'A prompt is required.' });
        }
        if (question.length > MAX_QUESTION_LENGTH) {
            return res.status(400).json({ success: false, message: `Please keep questions under ${MAX_QUESTION_LENGTH} characters.` });
        }

        // 0. Is this visitor still within today's budget (and not asking too fast)?
        const refused = usage.checkBefore(req);
        if (refused) {
            return res.status(refused.status).json({
                success: false, limitReached: Boolean(refused.limitReached), message: refused.message, budget: usage.budgetOf(req)
            });
        }

        // 1. Which model (the one chosen in the page's dropdown), then load it
        //    (downloaded once, then served from memory).
        const { urn, guid } = await resolveModel(req.body);
        const model = await getModel(urn, guid);

        // 2. Match the words to model names, pick the cheapest tier that can answer,
        //    and get back a plan that validatePlan has already checked.
        const key = conversationKey(req, urn, guid);
        const last = lastPlans.get(key);
        const previous = last && Date.now() - last.at < FOLLOW_UP_MINUTES * 60 * 1000 ? last : null;
        const outcome = await answerQuestion(question, model, previous);
        const { checked } = outcome;

        // Add up the tokens of every LLM call this question needed (1 or 2).
        const tokens = { promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0 };
        for (const call of outcome.calls) {
            for (const field of Object.keys(tokens)) {
                tokens[field] += call[field];
            }
        }
        usage.recordAfter(req, tokens.totalTokens); // counts towards this visitor's daily budget
        // One line per question in the server console: which tier, how many tokens, what plan.
        console.log(`TIER ${outcome.tier} | ${tokens.totalTokens} tokens | PLAN: ${JSON.stringify(outcome.plan)}`);

        // 3. Run it (or, if validation failed, the "result" is just the question).
        const result = checked.ok
            ? runPlan(checked.plan, model, userOf(req))
            : { answer: checked.question, objectIds: [], data: null };

        const action = checked.ok ? checked.plan.action : 'clarify';
        // Remember this plan for a follow-up, if it found elements to follow up on.
        // An answer that found NOTHING is a dead end, not a starting point: the next
        // follow-up builds on the last answer that found something.
        // The question text builds up ("steel beams on level 2 / and on level 3?"), so the
        // LLM, and the invented-filter guard, can see where each filter came from.
        const foundSomething = result.data?.count > 0 || result.data?.groups?.length > 0;
        if (checked.ok && ['list', 'count', 'group', 'rank', 'total'].includes(action) && foundSomething) {
            const asked = outcome.followUp && previous ? `${previous.question} / ${question}` : question;
            lastPlans.set(key, { question: asked.slice(-500), plan: outcome.plan, at: Date.now() });
        }
        remember(lastResults, `${userOf(req)}|${urn}:${guid}`, result.objectIds);

        return res.json({
            success: true,
            action,                      // list | count | group | rank | total | coordinates | clarify | reply
            answer: result.answer,       // text to show in the chat
            objectIds: result.objectIds, // ids to highlight in the Viewer
            // `message` keeps v1's shape so the current frontend still works: element
            // results (a table + highlight) for list/count/rank/total, plain text otherwise.
            // (An answer without elements, e.g. "I couldn't find element 3001", sends its text:
            // sending its empty data showed a blank bubble.)
            message: ELEMENT_ACTIONS.has(action) && result.data ? result.data : result.answer,
            data: result.data,
            tier: outcome.tier,          // 0 = tiny intent prompt, 1 = small prompt, 2 = full prompt
            followUp: outcome.followUp,  // true = built on the previous question
            plan: outcome.plan,          // the plan that ran: the first thing to look at when an answer is wrong
            // What code understood: "beam -> category Structural Framing", ...
            matched: outcome.match.matches.map(m => `${m.words} -> ${describeEntries(m.entries)}`),
            unmatched: outcome.match.unexplained,
            token: { currentRequest: tokens, calls: outcome.calls },
            budget: usage.budgetOf(req), // guests: today's tokens used / limit; signed in: no limit
            cache: { modelLoadedAt: model.loadedAt, modelElementCount: model.elementCount }
        });
    } catch (error) {
        return sendError(res, error);
    }
});

// Ids of the last answer, for SummaryExtension.js. It expects `message` to be an
// array of { objectid } and selects those elements in the Viewer.
router.get('/ask_agent_simple', async (req, res) => {
    try {
        const { urn, guid } = await resolveModel(req.query);
        const objectIds = lastResults.get(`${userOf(req)}|${urn}:${guid}`) || [];
        // With each id its externalId: SVF2 viewers number elements differently, and
        // translate through the externalId (see toViewerIds in main.js).
        const model = objectIds.length > 0 ? await getModel(urn, guid) : null;
        const externalIds = new Map(model ? model.db.prepare(
            `SELECT objectid, external_id FROM elements WHERE objectid IN (${placeholders(objectIds)})`
        ).all(...objectIds).map(row => [row.objectid, row.external_id]) : []);
        res.json({ success: true, model: { urn, guid }, message: objectIds.map(objectid => ({ objectid, externalId: externalIds.get(objectid) ?? null })) });
    } catch (error) {
        return sendError(res, error);
    }
});

// Coordinates sent by the Viewer.
router.put('/ask_agent_simple', async (req, res) => {
    try {
        const { urn, guid } = await resolveModel(req.body);

        // The Viewer sends either { urn, coordinates: {...} } or the raw map with urn/guid mixed in.
        let coordinates = req.body.coordinates;
        if (!coordinates || typeof coordinates !== 'object') {
            const { urn: _u, guid: _g, model: _m, ...rest } = req.body || {}; // copy everything except these keys
            coordinates = rest;
        }

        setCoordinates(userOf(req), urn, guid, coordinates);
        res.json({ success: true, model: { urn, guid }, count: Object.keys(coordinates).length });
    } catch (error) {
        return sendError(res, error);
    }
});

// Element positions, for distance questions (augmented/spatial.js), stored in the model's
// "positions" table. The page asks first (GET: how many are stored?) and sends them only
// if there are none yet (POST: { urn, positions: { externalId: { center, min, max } } },
// in metres). A reload or a second visitor finds them already there.
router.get('/model_positions', async (req, res) => {
    try {
        const { urn, guid } = await resolveModel(req.query);
        const model = await getModel(urn, guid);
        res.json({ success: true, count: positionCount(model.db) });
    } catch (error) {
        return sendError(res, error);
    }
});

router.post('/model_positions', async (req, res) => {
    try {
        const { urn, guid } = await resolveModel(req.body);
        const model = await getModel(urn, guid);
        res.json({ success: true, count: setPositions(model.db, req.body?.positions) });
    } catch (error) {
        return sendError(res, error);
    }
});

// The model the chat answers about, for the status chip in the page's top bar.
// Calling it also loads and indexes the model, so the first question is faster.

router.get('/model_status', async (req, res) => {
    let urn = null;
    try {
        const resolved = await resolveModel(req.query);
        urn = resolved.urn;
        const model = await getModel(resolved.urn, resolved.guid);
        // source: 'disk' = reopened from its saved index file, 'autodesk' = downloaded and built
        res.json({ ready: true, urn, modelName: modelNameFromUrn(urn), elementCount: model.elementCount, loadedAt: model.loadedAt, source: model.source });
    } catch (error) {
        const status = httpStatus(error);
        if (status === 500) console.error('model_status error:', error);
        res.status(status).json({
            ready: false,
            urn,
            // 'unsupported' = loaded, but not a model the assistant can query (e.g. a DWG)
            reason: status === 422 ? 'unsupported' : status === 503 ? 'not-ready' : 'error',
            message: status === 500 ? 'Something went wrong on the server.' : error.message
        });
    }
});

// Printed once when server.js loads this file, so the console shows which version is running.
console.log('ask_agent_simple: v2 (tiered planner) loaded');

module.exports = router;

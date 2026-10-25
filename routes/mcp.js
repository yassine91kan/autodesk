// routes/mcp.js
// ===========================================================================
// The MCP server: lets Claude (or any MCP client, e.g. GitHub Copilot) query the
// models and show them in the APS Viewer inside the chat.
//
// The client's own LLM does the planning here, so planner.js (OpenAI) is not used:
//
//   list_models ─► describe_model ─► run_plan (engine.js: validate + SQL) ─► show_model
//
//   list_models      the models in our bucket
//   describe_model   categories, properties and values (what the planner prompt shows)
//   run_plan         a JSON plan, checked by validatePlan and run by runPlan
//   suggest_values   real values of a property, instead of guessing
//   get_elements     every property of some elements (e.g. the viewer's selection)
//   show_model       opens mcp/viewer.html in the chat and highlights elements
//
// Address: POST /mcp/<MCP_KEY>. Without MCP_KEY (local development) it is /mcp.
// Mounted before login.js in server.js: MCP clients can't sign in with a cookie.
// ===========================================================================

const fs = require('fs');
const path = require('path');
const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } = require('@modelcontextprotocol/ext-apps/server');
const { listObjects, urnify, getViewerToken } = require('../services/aps.js');
const { findMainViewGuid } = require('../augmented/aps');
const { getModel } = require('../augmented/store');
const { describeVocabulary } = require('../augmented/planner');
const { validatePlan, runPlan, suggestValues } = require('../augmented/engine');
const { MAX_RETURNED_ELEMENTS, placeholders } = require('../augmented/shared');

const router = express.Router();

const MCP_KEY = process.env.MCP_KEY || '';
if (!MCP_KEY) {
    console.warn('mcp: MCP_KEY is not set, so /mcp is open to anyone. Set it before deploying.');
}

// --- The viewer page, with the ext-apps client library pasted in.
// The library is an ES module; its final export list is replaced so it runs as a
// plain script and leaves only window.McpApp behind.
const VIEWER_URI = 'ui://aps/viewer.html';
const viewerHtml = (() => {
    const bundlePath = require.resolve('@modelcontextprotocol/ext-apps/app-with-deps');
    let bundle = fs.readFileSync(bundlePath, 'utf8');
    const exportAt = bundle.lastIndexOf('export{');
    const appName = bundle.slice(exportAt).match(/([\w$]+) as App\b/)[1];
    bundle = `(() => {${bundle.slice(0, exportAt)}\nwindow.McpApp = ${appName};})();`;
    const page = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'viewer.html'), 'utf8');
    return page.replace('/*APP_BUNDLE*/', () => bundle);
})();

// What the viewer page may load and connect to (the Viewer's own files, fonts and
// the SVF2 stream, which uses WebSockets).
const VIEWER_CSP = {
    resourceDomains: ['https://developer.api.autodesk.com', 'https://cdn.derivative.autodesk.com', 'https://fonts.autodesk.com', 'blob:', 'data:'],
    connectDomains: ['https://developer.api.autodesk.com', 'https://cdn.derivative.autodesk.com', 'https://fonts.autodesk.com', 'wss://cdn.derivative.autodesk.com']
};

// --- Models. Same checks as ask_agent_simple_v2.js: the URN goes into an APS URL.
const URN_PATTERN = /^[A-Za-z0-9_-]+=*$/;
const viewGuids = new Map(); // urn -> GUID of its main 3D view, asked once per model

async function loadModel(urn) {
    if (!URN_PATTERN.test(urn)) {
        throw new Error('That is not a valid model URN. Use list_models to get one.');
    }
    if (!viewGuids.has(urn)) {
        viewGuids.set(urn, await findMainViewGuid(urn));
    }
    return getModel(urn, viewGuids.get(urn));
}

// --- Tool results: text for the LLM, structuredContent for code (and the viewer page).
const reply = (text, structuredContent) => ({ content: [{ type: 'text', text }], ...(structuredContent && { structuredContent }) });
const failure = text => ({ content: [{ type: 'text', text }], isError: true });

// Runs a tool and turns any error into a message the LLM can act on.
const safely = handler => async args => {
    try {
        return await handler(args);
    } catch (error) {
        console.error('mcp tool error:', error);
        return failure(error.message || 'Something went wrong on the server.');
    }
};

const urnInput = z.string().describe('Model URN, from list_models.');

const PLAN_FORMAT = `A plan is a JSON object:
{
  "action": "list" | "count" | "group" | "rank" | "total" | "spatial",
  "category": exact category name from describe_model, or null for all categories,
  "filters": [ { "properties": [exact paths], "op": "equals" | "not_equals" | "contains" | "gt" | "gte" | "lt" | "lte", "value": text, number, or a list of texts for equals / not_equals } ],
  "groupBy": [exact paths] or "category" or null,
  "sortBy": [one number path] or null, "order": "desc" | "asc", "limit": number or null,
  "measure": [one number path] or "weight" or null, "aggregate": "sum" | "average" | "min" | "max",
  "kind": "between" | "spacing", "elementIds": [two element ids]   (spatial only)
}
- list: find elements. count: how many. group: breakdowns ("per level", "which level has the most").
- rank: longest / largest / top N by sortBy. limit null = every element tied at the top.
- total: sum / average of a number property (measure), or "weight" (Nominal Weight x Length). groupBy optional.
- spatial: distances. Needs element positions, which the web app stores the first time it loads a model.
- Use only categories and paths from describe_model. For levels, one level path is enough: the others are added.
- Listed values: op "equals" with the exact value. Free text (a material inside a longer name): op "contains".
- Several filters are combined with AND. "X or Y" on one property is one filter with a list of values.
- Numbers: plain numbers in the property's unit.
Examples:
"steel beams" -> {"action":"list","category":"Structural Framing","filters":[{"properties":["Materials and Finishes.Structural Material"],"op":"contains","value":"steel"}]}
"the 5 longest walls" -> {"action":"rank","category":"Walls","filters":[],"sortBy":["Dimensions.Length"],"order":"desc","limit":5}
"total volume of the floors per level" -> {"action":"total","category":"Floors","filters":[],"measure":["Dimensions.Volume"],"aggregate":"sum","groupBy":["Constraints.Level"]}`;

// A new server per request (stateless): nothing to clean up, and any Heroku dyno can answer.
function buildServer() {
    const server = new McpServer({ name: 'aps-models', version: '1.0.0' });

    server.registerTool('list_models', {
        title: 'List models',
        description: 'The BIM models available, with the URN every other tool needs.',
        annotations: { readOnlyHint: true }
    }, safely(async () => {
        const models = (await listObjects()).map(o => ({ name: o.objectKey, urn: urnify(o.objectId) }));
        return reply(models.map(m => `- ${m.name}: ${m.urn}`).join('\n') || 'No models uploaded yet.', { models });
    }));

    server.registerTool('describe_model', {
        title: 'Describe a model',
        description: 'Categories (with element counts), property paths and their values for one model. ' +
            'Call this before run_plan: plans may only use these names.',
        inputSchema: { urn: urnInput },
        annotations: { readOnlyHint: true }
    }, safely(async ({ urn }) => {
        const model = await loadModel(urn);
        return reply(`${model.elementCount} elements.\n\n${describeVocabulary(model.vocabulary)}\n\nOther properties exist too: get_elements shows all of an element's properties, and they work in plans.`);
    }));

    server.registerTool('run_plan', {
        title: 'Query a model',
        description: `Runs a query plan on a model and returns the answer and the matching elements (with externalIds for show_model).\n\n${PLAN_FORMAT}`,
        inputSchema: { urn: urnInput, plan: z.record(z.any()).describe('The query plan, as described above.') },
        annotations: { readOnlyHint: true }
    }, safely(async ({ urn, plan }) => {
        const model = await loadModel(urn);
        const checked = validatePlan(plan, model);
        if (!checked.ok) {
            // validatePlan's questions name the real options, so the LLM can fix the plan.
            return failure(`The plan was not run: ${checked.question}`);
        }
        const result = runPlan(checked.plan, model, 'mcp');
        return reply(`${result.answer}\n\n${JSON.stringify(result.data)}`, { answer: result.answer, plan: checked.plan, data: result.data });
    }));

    server.registerTool('suggest_values', {
        title: 'Suggest property values',
        description: 'Real values of a property that contain some text (or its most common values), so plans use exact values.',
        inputSchema: {
            urn: urnInput,
            properties: z.array(z.string()).describe('Property paths, e.g. ["Element.Family"].'),
            text: z.string().describe('Text the values should contain; empty for the most common ones.'),
            category: z.string().optional().describe('Only values used by this category.')
        },
        annotations: { readOnlyHint: true }
    }, safely(async ({ urn, properties, text, category }) => {
        const model = await loadModel(urn);
        const values = suggestValues(model.db, properties, text, category || null);
        return reply(values.length ? values.map(v => `- ${v}`).join('\n') : 'No values found.', { values });
    }));

    server.registerTool('get_elements', {
        title: 'Get element properties',
        description: 'All properties of some elements, by externalId (from run_plan results or the viewer selection).',
        inputSchema: { urn: urnInput, externalIds: z.array(z.string()).max(50) },
        annotations: { readOnlyHint: true }
    }, safely(async ({ urn, externalIds }) => {
        const model = await loadModel(urn);
        if (externalIds.length === 0) return reply('No elements asked for.', { elements: [] });
        const rows = model.db.prepare(
            `SELECT e.objectid, e.external_id, e.clean_name, e.category, p.path, p.value
             FROM elements e LEFT JOIN properties p ON p.objectid = e.objectid
             WHERE e.external_id IN (${placeholders(externalIds)}) ORDER BY e.objectid, p.path`
        ).all(...externalIds);
        const byId = new Map();
        for (const row of rows) {
            if (!byId.has(row.external_id)) {
                byId.set(row.external_id, { id: row.objectid, externalId: row.external_id, name: row.clean_name, category: row.category, properties: {} });
            }
            if (row.path) byId.get(row.external_id).properties[row.path] = row.value;
        }
        const elements = [...byId.values()];
        return reply(elements.length ? JSON.stringify(elements) : 'None of these externalIds are in this model.', { elements });
    }));

    registerAppResource(server, 'APS Viewer', VIEWER_URI, {
        description: 'The Autodesk Viewer for the show_model tool.',
        _meta: { ui: { csp: VIEWER_CSP } }
    }, async () => ({
        contents: [{ uri: VIEWER_URI, mimeType: RESOURCE_MIME_TYPE, text: viewerHtml, _meta: { ui: { csp: VIEWER_CSP } } }]
    }));

    registerAppTool(server, 'show_model', {
        title: 'Show model',
        description: 'Shows a model in the Autodesk Viewer inside the chat. Pass externalIds (from run_plan) to isolate ' +
            'and zoom to those elements. When the user selects elements in the viewer, their externalIds are shared with you.',
        inputSchema: {
            urn: urnInput,
            externalIds: z.array(z.string()).max(MAX_RETURNED_ELEMENTS).optional().describe('Elements to highlight; none = the whole model.')
        },
        annotations: { readOnlyHint: true },
        _meta: { ui: { resourceUri: VIEWER_URI } }
    }, safely(async ({ urn, externalIds = [] }) => {
        if (!URN_PATTERN.test(urn)) return failure('That is not a valid model URN. Use list_models to get one.');
        const token = await getViewerToken();
        // The token is only for the viewer page: the text the LLM reads doesn't repeat it.
        return reply(
            externalIds.length ? `Showing the model with ${externalIds.length} element(s) highlighted.` : 'Showing the model.',
            { urn, externalIds, accessToken: token.access_token, expiresIn: token.expires_in }
        );
    }));

    // A fresh token for a viewer that stays open longer than an hour. Only the viewer page can call it.
    registerAppTool(server, 'refresh_viewer_token', {
        title: 'Refresh viewer token',
        description: 'Used by the viewer page only.',
        annotations: { readOnlyHint: true },
        _meta: { ui: { resourceUri: VIEWER_URI, visibility: ['app'] } }
    }, safely(async () => {
        const token = await getViewerToken();
        return reply('Token refreshed.', { accessToken: token.access_token, expiresIn: token.expires_in });
    }));

    return server;
}

const mcpPath = MCP_KEY ? `/mcp/${MCP_KEY}` : '/mcp';

router.post(mcpPath, async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
        transport.close();
        server.close();
    });
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('mcp error:', error);
        if (!res.headersSent) {
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
        }
    }
});

// Stateless: no event stream to open (GET) and no session to end (DELETE).
router.all(mcpPath, (req, res) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});

console.log(`mcp: MCP server at ${MCP_KEY ? '/mcp/<MCP_KEY>' : '/mcp'}`);

module.exports = router;
module.exports.buildServer = buildServer; // for mcp/stdio.js (Claude Desktop, without a web server)

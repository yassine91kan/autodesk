// Test harness: runs the router unchanged, with APS + OpenAI stubbed out.
const Module = require('module');
const express = require('express');
const axios = require('axios');

const calls = { auth: 0, metadata: 0, tree: 0, classifier: 0, agentLLM: 0 };

// ---------------------------------------------------------------- fake model
const BROKEN_URN = 'broken-urn-still-processing';

function el(objectid, name, props) { return { objectid, name, properties: props }; }
const ident = (cat, type) => ({ Category: cat, 'Type Name': type });

const collection = [
    // grouping nodes (APS includes these in the properties dump too)
    el(10, 'Basic Wall', {}), el(11, 'Generic - 200mm', {}),
    el(1001, 'Basic Wall [1001]', { 'Identity Data': ident('Walls', 'Generic - 200mm'), Constraints: { 'Base Constraint': 'Level 1' }, 'Materials and Finishes': { 'Structural Material': 'Concrete, Cast-in-Place' } }),
    el(1002, 'Basic Wall [1002]', { 'Identity Data': ident('Walls', 'Generic - 200mm'), Constraints: { 'Base Constraint': 'Level 2' }, 'Materials and Finishes': { 'Structural Material': 'Concrete, Cast-in-Place' } }),
    el(2001, 'Floor [2001]', { 'Identity Data': ident('Floors', 'Generic 300mm'), Constraints: { Level: 'Level 1' } }),
    el(2002, 'Floor [2002]', { 'Identity Data': ident('Floors', 'Generic 300mm'), Constraints: { Level: 'Level 2' } }),
    el(30, 'W-Wide Flange', {}),
    el(3001, 'W-Wide Flange [3001]', { 'Identity Data': ident('Structural Framing', 'W310X38.7'), Constraints: { 'Reference Level': 'Level 2', 'Start Level Offset': '200.000 mm' }, 'Materials and Finishes': { 'Structural Material': 'Steel ASTM A992' }, Structural: { 'Structural Usage': 'Girder' }, Phasing: { 'Phase Created': 'New Construction' } }),
    el(3002, 'W-Wide Flange [3002]', { 'Identity Data': ident('Structural Framing', 'W310X38.7'), Constraints: { 'Reference Level': 'Level 2', 'Start Level Offset': '0.000 mm' }, 'Materials and Finishes': { 'Structural Material': 'Steel ASTM A992' }, Structural: { 'Structural Usage': 'Other' } }),
    el(3003, 'W-Wide Flange [3003]', { 'Identity Data': ident('Structural Framing', 'W310X38.7'), Constraints: { 'Reference Level': 'Level 12', 'Start Level Offset': '0.000 mm' }, 'Materials and Finishes': { 'Structural Material': 'Steel ASTM A992' }, Structural: { 'Structural Usage': 'Other' } }),
    el(3004, 'Concrete-Rectangular Beam [3004]', { 'Identity Data': ident('Structural Framing', '300x600mm'), Constraints: { 'Reference Level': 'Level 1', 'Start Level Offset': '0.000 mm' }, 'Materials and Finishes': { 'Structural Material': 'Concrete, Precast' }, Structural: { 'Structural Usage': 'Girder' }, Phasing: { 'Phase Created': 'New Construction' } }),
    // Like your real model: a joist and a brace that are also "Structural Framing".
    el(3005, 'Light Gauge Joists [3005]', { 'Identity Data': ident('Structural Framing', 'LGJ 200'), Constraints: { 'Reference Level': 'Level 1', 'Start Level Offset': '0.000 mm' }, Structural: { 'Structural Usage': 'Joist' } }),
    el(3006, 'CHS Circular Hollow Sections [3006]', { 'Identity Data': ident('Structural Framing', 'CHS 100x4'), Constraints: { 'Reference Level': 'Level 1', 'Start Level Offset': '0.000 mm' }, Structural: { 'Structural Usage': 'Vertical Bracing' } }),
    el(4001, 'Concrete-Square-Column [4001]', { 'Identity Data': ident('Structural Columns', '450x450mm'), Constraints: { 'Base Level': 'Level 1', 'Top Level': 'Level 2' }, 'Materials and Finishes': { 'Structural Material': 'Concrete, Cast-in-Place' } }),
    el(5001, 'M_Single-Flush [5001]', { 'Identity Data': ident('Doors', '0915 x 2134mm'), Constraints: { Level: 'Level 1' } })
];

const tree = {
    data: { type: 'objects', objects: [{ objectid: 1, name: 'Model', objects: [
        { objectid: 100, name: 'Walls', objects: [{ objectid: 10, name: 'Basic Wall', objects: [{ objectid: 11, name: 'Generic - 200mm', objects: [
            { objectid: 1001, name: 'Basic Wall [1001]' }, { objectid: 1002, name: 'Basic Wall [1002]' }] }] }] },
        { objectid: 200, name: 'Floors', objects: [{ objectid: 2001, name: 'Floor [2001]' }, { objectid: 2002, name: 'Floor [2002]' }] },
        { objectid: 300, name: 'Structural Framing', objects: [{ objectid: 30, name: 'W-Wide Flange', objects: [
            { objectid: 3001, name: 'W-Wide Flange [3001]' }, { objectid: 3002, name: 'W-Wide Flange [3002]' }, { objectid: 3003, name: 'W-Wide Flange [3003]' }] },
            { objectid: 3004, name: 'Concrete-Rectangular Beam [3004]' },
            { objectid: 31, name: 'Light Gauge Joists', objects: [{ objectid: 32, name: 'LGJ 200', objects: [{ objectid: 3005, name: 'Light Gauge Joists [3005]' }] }] },
            { objectid: 33, name: 'CHS Circular Hollow Sections', objects: [{ objectid: 34, name: 'CHS 100x4', objects: [{ objectid: 3006, name: 'CHS Circular Hollow Sections [3006]' }] }] }] },
        { objectid: 400, name: 'Structural Columns', objects: [{ objectid: 4001, name: 'Concrete-Square-Column [4001]' }] },
        { objectid: 500, name: 'Doors', objects: [{ objectid: 5001, name: 'M_Single-Flush [5001]' }] }
    ] }] }
};

// ---------------------------------------------------------------- APS stubs
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
    if (String(url).includes('autodesk.com/authentication')) {
        calls.auth++;
        return { ok: true, json: async () => ({ access_token: 'fake-token', expires_in: 3599 }) };
    }
    return realFetch(url, opts);
};

// A second Revit model (same fake data) and a DWG drawing (objects without "[id]").
const SECOND_URN = 'c2Vjb25kLW1vZGVs';
const DWG_URN = 'ZHJpdmVfc2hhZnQuZHdn';
const dwgCollection = [el(1, 'Model', {}), el(2, 'Layer 0', { General: { Color: 'ByLayer' } })];
const dwgTree = { data: { objects: [{ objectid: 1, name: 'Model', objects: [{ objectid: 2, name: 'Layer 0' }] }] } };

axios.get = async (url) => {
    await new Promise(r => setTimeout(r, 30)); // simulate latency
    calls.urls = [...(calls.urls || []), url];
    if (url.endsWith('/metadata') && url.includes(DWG_URN)) {
        // A DWG: 2D layouts only, no 3D view.
        return { status: 200, data: { data: { type: 'metadata', metadata: [{ name: 'Model', role: '2d', guid: 'dwg-model-guid' }] } } };
    }
    if (url.endsWith('/metadata')) {
        // The list of a model's views: a sheet and the main 3D view.
        calls.viewList = (calls.viewList || 0) + 1;
        return { status: 200, data: { data: { type: 'metadata', metadata: [
            { name: 'Sheet A101', role: '2d', guid: 'sheet-guid' },
            { name: '{3D}', role: '3d', guid: 'main-3d-guid', isMasterView: true }
        ] } } };
    }
    if (url.includes(DWG_URN)) {
        return { status: 200, data: url.includes('/properties') ? { data: { collection: dwgCollection } } : dwgTree };
    }
    if (url.includes(BROKEN_URN)) {
        // APS answers 202 while it is still extracting properties
        if (url.includes('/properties')) calls.metadata++; else calls.tree++;
        return { status: 202, data: { result: 'success' } };
    }
    if (url.includes('/properties')) { calls.metadata++; return { status: 200, data: { data: { type: 'properties', collection } } }; }
    calls.tree++;
    return { status: 200, data: tree };
};

// ---------------------------------------------------------------- OpenAI stub
// Classifier answers mimic what gpt-4o-mini plausibly returns for each prompt,
// constrained to the 4 intents the system prompt actually lists.
const CLASSIFIER = {
    'list all floors': { intent: 'SIMPLE_TYPE', type: 'floor' },
    'show me the beams': { intent: 'SIMPLE_TYPE', type: 'beams' },
    'show me all doors': { intent: 'SIMPLE_TYPE', type: 'door' },
    'steel beams': { intent: 'SIMPLE_PROPERTY', type: 'beam', property: 'material', value: 'steel' },
    'concrete columns': { intent: 'SIMPLE_PROPERTY', type: 'column', property: 'material', value: 'concrete' },
    'elements on level 2': { intent: 'SIMPLE_PROPERTY', type: '', property: 'level', value: 'Level 2' },
    'coordinates of element 3001': { intent: 'COORDINATE', id: '3001' },
    'how many beams are on level 2?': { intent: 'COMPLEX' },
    'how many walls are there?': { intent: 'COMPLEX' },
    'where is beam 3001 and what level is it on?': { intent: 'COMPLEX' },
    'BROKEN_JSON': null
};

// v2 planner answers: what gpt-4o-mini plausibly returns once it can see the
// model vocabulary. (Whether the REAL model plans this well is what the
// chatbot test questions are for.)
const LEVEL_PATHS = ['Constraints.Base Constraint', 'Constraints.Level', 'Constraints.Reference Level', 'Constraints.Base Level'];
const SF = 'Structural Framing';
const MAT = 'Materials and Finishes.Structural Material';
const USAGE = 'Structural.Structural Usage';
const NOT_JOISTS_OR_BRACING = { properties: [USAGE], op: 'not_equals', value: ['Joist', 'Vertical Bracing', 'Horizontal Bracing'] };
const PLANS = {
    'show me the beams': { action: 'list', category: SF, filters: [NOT_JOISTS_OR_BRACING] },
    'show me all framing': { action: 'list', category: SF, filters: [] },
    'framing except purlins': { action: 'list', category: SF, filters: [{ properties: [USAGE], op: 'not_equals', value: 'Purlin' }] },
    // Your real failures, with the plans gpt-4o-mini actually produced:
    'everything on level 2 (llm picked one level key)': { action: 'list', category: null, filters: [{ properties: ['Constraints.Reference Level'], op: 'equals', value: 'Level 2' }] },
    'how many columns are on level 1?': { action: 'count', category: 'Structural Columns', filters: [{ properties: ['Constraints.Reference Level'], op: 'equals', value: 'Level 1' }] },
    'show me the light gauge joists': { action: 'list', category: SF, filters: [{ properties: ['Element.Family'], op: 'equals', value: 'Light Gauge Joists' }] },
    'columns used as joists': { action: 'list', category: 'Structural Columns', filters: [{ properties: [USAGE], op: 'equals', value: 'Joist' }] },
    'group framing by family': { action: 'group', category: SF, filters: [], groupBy: ['Element.Family'] },
    'steel or concrete precast framing': { action: 'list', category: SF, filters: [{ properties: [MAT], op: 'equals', value: ['Steel ASTM A992', 'Concrete, Precast'] }] },
    'list all floors': { action: 'list', category: 'Floors', filters: [] },
    'show me the doors': { action: 'list', category: 'Doors', filters: [] },
    'list all ceilings': { action: 'list', category: 'Ceilings', filters: [] },
    'show me the steel beams': { action: 'list', category: SF, filters: [{ properties: [MAT], op: 'contains', value: 'steel' }] },
    'show me all elements on level 2': { action: 'list', category: null, filters: [{ properties: LEVEL_PATHS, op: 'equals', value: 'Level 2' }] },
    'show me elements on level 7': { action: 'list', category: null, filters: [{ properties: LEVEL_PATHS, op: 'equals', value: 'Level 7' }] },
    'steel beams on level 2': { action: 'list', category: SF, filters: [{ properties: [MAT], op: 'contains', value: 'steel' }, { properties: ['Constraints.Reference Level'], op: 'equals', value: 'level 2' }] },
    'how many walls are there?': { action: 'count', category: 'Walls', filters: [] },
    'how many beams are on level 2?': { action: 'count', category: SF, filters: [{ properties: ['Constraints.Reference Level'], op: 'equals', value: 'Level 2' }] },
    'which level has the most beams?': { action: 'group', category: SF, filters: [NOT_JOISTS_OR_BRACING], groupBy: ['Constraints.Reference Level'] },
    'what materials are used for the columns?': { action: 'group', category: 'Structural Columns', filters: [], groupBy: [MAT] },
    'how many elements per category?': { action: 'group', category: null, filters: [], groupBy: 'category' },
    'beams with a start offset above 100 mm': { action: 'list', category: SF, filters: [{ properties: ['Constraints.Start Level Offset'], op: 'gt', value: 100 }] },
    'group beams by fire rating': { action: 'group', category: SF, filters: [], groupBy: ['Identity Data.Fire Rating'] },
    "walls' OR 1=1 --": { action: 'list', category: "Walls' OR 1=1 --", filters: [] },
    'where is element 3001?': { action: 'coordinates', elementId: 3001 },
    'what can you help me with?': { action: 'reply', message: 'I can list, count and group elements in this model, filter them by properties like level or material, and locate elements.' },
    'BROKEN_JSON': null
};

// v2 tier 1 answers (small prompt). Questions not listed here answer "need_more",
// which sends them on to tier 2 (PLANS above).
const PLANS_TIER1 = {
    'what can you help me with?': { action: 'reply', message: 'I can list, count and group elements in this model, filter them by properties like level or material, and locate elements.' },
    'where is element 3001?': { action: 'coordinates', elementId: 3001 },
    'where is element 3002?': { action: 'coordinates', elementId: 3002 },
    'beams with a start level offset of 200 mm': { action: 'list', category: SF, filters: [{ properties: ['Constraints.Start Level Offset'], op: 'equals', value: '200 mm' }] },
    'BROKEN_JSON': null
};

function lastToolResult(messages) {
    const t = [...messages].reverse().find(m => m.role === 'tool');
    return t ? JSON.parse(t.content) : null;
}
const toolCall = (name, args) => ({ role: 'assistant', content: null,
    tool_calls: [{ id: 'call_' + Math.random().toString(36).slice(2), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const answer = (text) => ({ role: 'assistant', content: text });

// Scripted agent: follows the system prompt (list_properties first, then pick
// the key whose sample looks like "Level N").
function agentStep(messages) {
    const user = messages.find(m => m.role === 'user').content.toLowerCase();
    const toolMsgs = messages.filter(m => m.role === 'tool').length;

    if (user.startsWith('how many beams')) {
        if (toolMsgs === 0) return toolCall('list_properties', { concept: 'level' });
        if (toolMsgs === 1) {
            const best = lastToolResult(messages).matches.find(m => /^Level \d/.test(m.sample));
            return toolCall('count_elements_by_property', { category: best.category, key: best.key, value: 'Level 2', type: 'beam' });
        }
        return answer(`There are ${lastToolResult(messages).count} beams on Level 2.`);
    }
    if (user.startsWith('how many walls')) {
        if (toolMsgs === 0) return toolCall('count_elements', { type: 'wall' });
        return answer(`There are ${lastToolResult(messages).count} walls.`);
    }
    if (user.startsWith('where is beam')) {
        if (toolMsgs === 0) return toolCall('get_coordinates', { id: '3001' });
        const r = lastToolResult(messages);
        return answer(r.success ? `Beam 3001 is at ${JSON.stringify(r.coordinates)}.` : `Coordinates lookup failed: ${r.error}`);
    }
    return answer('I can help with BIM questions.');
}

class FakeOpenAI {
    constructor() {
        this.chat = { completions: { create: async (req) => {
            const system = req.messages[0].content;
            const reply = (json, prompt, completion) => {
                calls.tokens = (calls.tokens || 0) + prompt + completion;
                const content = json === null ? '{not json' : JSON.stringify(json);
                return { choices: [{ message: { content } }], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } };
            };
            if (system.startsWith('Classify a question')) {
                // v2 tier 0: intent only. Mimics what gpt-4o-mini answers.
                calls.tier0 = (calls.tier0 || 0) + 1;
                const q = req.messages[1].content.toLowerCase();
                const action = /how many|number of/.test(q) ? 'count' : /\bper\b|\bby\b|most|what .* used/.test(q) ? 'group' : 'list';
                return reply({ action }, 120, 10);
            }
            if (system.includes('CANDIDATES')) {
                // v2 tier 1: small prompt with candidates
                calls.tier1 = (calls.tier1 || 0) + 1;
                calls.lastTier1Message = req.messages[1].content;
                const question = req.messages[1].content.split('\n')[0].replace('QUESTION: ', '');
                const plan = PLANS_TIER1[question];
                return reply(plan === undefined ? { action: 'need_more' } : plan, 400, 50);
            }
            if (req.response_format && !system.includes('intent extraction')) {
                // v2 tier 2: the full prompt
                calls.planner = (calls.planner || 0) + 1;
                calls.lastPlannerPrompt = system;
                const plan = PLANS[req.messages[1].content];
                return reply(plan === null ? null : plan || { action: 'clarify', message: 'Could you rephrase?' }, 1200, 60);
            }
            if (req.response_format) {
                calls.classifier++;
                const prompt = req.messages[1].content;
                const intent = CLASSIFIER[prompt];
                const content = intent === null ? '{not json' : JSON.stringify(intent || { intent: 'COMPLEX' });
                return { choices: [{ message: { content } }], usage: { prompt_tokens: 250, completion_tokens: 20, total_tokens: 270 } };
            }
            calls.agentLLM++;
            return { choices: [{ message: agentStep(req.messages) }], usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 } };
        } } };
    }
}

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'openai') return FakeOpenAI;
    return origLoad.call(this, request, ...rest);
};

// Silence the router's own debug logs so test output stays readable.
const routerLogs = [];
const origLog = console.log;
console.log = (...a) => routerLogs.push(a.join(' '));
console.error = (...a) => routerLogs.push('ERR ' + a.join(' '));

const router = require(process.env.ROUTER || '../routes/ask_agent_simple_v2.js');
const app = express();
app.use(express.json());
app.use('/api', router);

module.exports = { app, calls, routerLogs, origLog, BROKEN_URN, SECOND_URN, DWG_URN };

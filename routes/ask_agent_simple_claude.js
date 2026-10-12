const express = require('express');
const OpenAI = require('openai');
const axios = require('axios');
const Database = require('better-sqlite3');
const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET } = require('../config.js');

const router = express.Router();

const openai = new OpenAI({
    apiKey: OPENAIKEY
});

// Temporary default model. The route also accepts urn/guid in requests, so this
// can evolve into a multi-model endpoint without changing the API shape.
const DEFAULT_MODEL = {
    urn: 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6ZnFwdGd0Z2Q2N2dnNGd2dWJhZ2VpdmpweHVzdW9pbXMtYmFzaWMtYXBwL3JzdGJhc2ljc2FtcGxlcHJvamVjdC5ydnQ',
    guid: '2b8b1cf8-31bf-7e71-dfb5-e1d4342ddb82'
};

const APS_BASE_URL = 'https://developer.api.autodesk.com/modelderivative/v2/designdata';
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const MAX_RESPONSE_ELEMENTS = 500;

// APS tokens are app-level credentials. Cache them once and refresh shortly
// before expiry so every prompt does not trigger a new authentication call.
const apsToken = {
    value: null,
    expiresAt: 0
};

// In-memory caches are the first scalability step: expensive model metadata is
// loaded once per model key, then reused by prompt handlers. For production,
// these maps should move to SQLite/Postgres/Redis so multiple Node processes can
// share the same indexed model data.
const modelCache = new Map();
const modelLoadPromises = new Map();
const coordinateCache = new Map();
const resultCache = new Map();

// Tracks only intent-extraction usage. The old LangChain executor is no longer
// in the hot path, so token accounting is simpler and tied to request routing.
const intentTokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
};

// Common user terms rarely match APS property paths exactly. This map lets the
// deterministic handler resolve natural BIM words before falling back to fuzzy
// path matching against the loaded metadata.
const PROPERTY_ALIASES = {
    material: [
        'Materials and Finishes.Structural Material',
        'Materials and Finishes.Material',
        'Identity Data.Material',
        'Other.Material'
    ],
    level: [
        'Constraints.Level',
        'Constraints.Base Constraint',
        'Constraints.Reference Level',
        'Identity Data.Reference Level'
    ],
    type: [
        'Identity Data.Type Name',
        'Identity Data.Family and Type',
        'Other.Family and Type'
    ],
    family: [
        'Identity Data.Family Name',
        'Identity Data.Family',
        'Other.Family'
    ],
    category: [
        'Identity Data.Category',
        'Other.Category'
    ],
    mark: [
        'Identity Data.Mark',
        'Other.Mark'
    ],
    comments: [
        'Identity Data.Comments',
        'Other.Comments'
    ]
};

function modelKey(model) {
    return model.key || `${model.urn}:${model.guid}`;
}

// Allows callers to pass either top-level urn/guid or a nested model object.
// Existing frontend calls still work because DEFAULT_MODEL fills the blanks.
function getModelFromInput(input = {}) {
    const source = input.model && typeof input.model === 'object' ? input.model : input;
    const urn = source.urn || DEFAULT_MODEL.urn;
    const guid = source.guid || DEFAULT_MODEL.guid;

    return {
        urn,
        guid,
        key: source.modelKey || source.modelId || `${urn}:${guid}`
    };
}

// The Viewer currently PUTs a raw objectId -> coordinate map. If a future caller
// wraps that map in { coordinates }, support that shape too.
function getCoordinatePayload(body = {}) {
    if (body.coordinates && typeof body.coordinates === 'object') {
        return body.coordinates;
    }

    const payload = { ...body };
    delete payload.urn;
    delete payload.guid;
    delete payload.model;
    delete payload.modelId;
    delete payload.modelKey;

    return payload;
}

async function authenticate() {
    const body = new URLSearchParams();
    body.append('grant_type', 'client_credentials');
    body.append('scope', 'data:read');

    const credentials = Buffer
        .from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`)
        .toString('base64');

    const response = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${credentials}`
        },
        body
    });

    if (!response.ok) {
        throw new Error(`APS authentication failed with status ${response.status}`);
    }

    const data = await response.json();
    apsToken.value = data.access_token;
    apsToken.expiresAt = Date.now() + (data.expires_in * 1000);

    return apsToken.value;
}

async function getAccessToken() {
    const tokenIsFresh = apsToken.value && Date.now() < apsToken.expiresAt - TOKEN_REFRESH_BUFFER_MS;

    if (tokenIsFresh) {
        return apsToken.value;
    }

    return authenticate();
}

// Full metadata is still used for the first scalable iteration because it gives
// us a local query layer. The important improvement is that this happens once
// per model cache miss, not on every prompt.
async function getModelMetadata(model, accessToken) {
    const response = await axios.get(
        `${APS_BASE_URL}/${model.urn}/metadata/${model.guid}/properties?forceget=true`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        }
    );

    return response.data;
}

async function getModelTree(model, accessToken) {
    const response = await axios.get(
        `${APS_BASE_URL}/${model.urn}/metadata/${model.guid}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return response.data;
}

function addPropertyPath(index, path, label) {
    if (index.pathSet.has(path)) {
        return;
    }

    index.pathSet.add(path);
    index.paths.push(path);
    index.labels.push({
        path,
        label
    });
}

// Builds a compact property-path index from APS metadata. Example path:
// "Materials and Finishes.Structural Material".
function indexPropertyPaths(collection = []) {
    const index = {
        paths: [],
        labels: [],
        pathSet: new Set()
    };

    for (const item of collection) {
        const properties = item.properties || {};

        for (const [category, details] of Object.entries(properties)) {
            if (!details || typeof details !== 'object' || Array.isArray(details)) {
                addPropertyPath(index, category, category);
                continue;
            }

            const detailKeys = Object.keys(details);

            if (detailKeys.length === 0) {
                addPropertyPath(index, category, category);
                continue;
            }

            for (const detailKey of detailKeys) {
                addPropertyPath(index, `${category}.${detailKey}`, detailKey);
            }
        }
    }

    return index;
}

function getUniqueNames(collection = []) {
    const names = new Set();

    for (const item of collection) {
        if (item.name) {
            names.add(item.name.toLowerCase().split('[')[0].trim());
        }
    }

    return Array.from(names);
}

// Ensures only one metadata load happens per model even if multiple prompts hit
// the server at the same time during a cold cache.
async function ensureModelContext(model) {
    const key = modelKey(model);

    if (modelCache.has(key)) {
        return modelCache.get(key);
    }

    if (modelLoadPromises.has(key)) {
        return modelLoadPromises.get(key);
    }

    const loadPromise = (async () => {
        const accessToken = await getAccessToken();

        // Fetch BOTH the flat properties dump (as before) AND the tree (new).
        const metadata = await getModelMetadata(model, accessToken);
        const tree = await getModelTree(model, accessToken);

        const collection = metadata?.data?.collection || [];
        const coordinates = coordinateCache.get(key) || {};

        // Build the SQLite database from both data sources.
        const db = buildModelDatabase(collection, tree, coordinates);

        const context = {
            key,
            urn: model.urn,
            guid: model.guid,
            loadedAt: new Date().toISOString(),
            elementCount: collection.length,
            db,
            profile: buildModelProfile(db) // <-- this is the new thing your query functions will use next stage
        };

        modelCache.set(key, context);
        return context;
    })();

    modelLoadPromises.set(key, loadPromise);

    try {
        return await loadPromise;
    } finally {
        modelLoadPromises.delete(key);
    }
}

function cleanElementName(name = '') {
    return name
        .replace(/\[\d+\]/g, '')
        .replace(/^M_/i, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeText(value = '') {
    return String(value)
        .toLowerCase()
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Reads nested APS property values using a dot path from the metadata index.
function getPropertyValue(properties = {}, path = '') {
    const [category, ...rest] = path.split('.');
    let value = properties[category];

    for (const key of rest) {
        if (!value || typeof value !== 'object') {
            return undefined;
        }

        value = value[key];
    }

    return value;
}

function valueContains(value, searchValue) {
    if (value === undefined || value === null) {
        return false;
    }

    const normalizedValue = normalizeText(
        typeof value === 'object' ? JSON.stringify(value) : value
    );

    return normalizedValue.includes(normalizeText(searchValue));
}

function toResultItem(item, matched = {}) {
    return {
        objectid: item.objectid,
        name: item.name,
        cleanName: cleanElementName(item.name),
        matched
    };
}

// Keeps API responses small and gives the frontend both object IDs for viewer
// highlighting and cleaned names for chat display.
function formatElementResults(items = []) {
    const limitedItems = items.slice(0, MAX_RESPONSE_ELEMENTS);

    return {
        count: items.length,
        returned: limitedItems.length,
        truncated: items.length > limitedItems.length,
        objectIds: limitedItems.map(item => item.objectid),
        elements: limitedItems.map(item => ({
            id: item.objectid,
            name: item.cleanName || cleanElementName(item.name),
            rawName: item.name,
            matched: item.matched
        }))
    };
}

// Resolves a user-facing property name into a real APS property path. It tries:
// aliases -> exact label -> exact path -> partial label -> partial path.
function resolvePropertyPath(context, property) {
    if (!property) {
        return null;
    }

    const normalizedProperty = normalizeText(property);
    const aliasCandidates = PROPERTY_ALIASES[normalizedProperty] || [];

    // 1. Try hand-curated aliases first — these are trusted, exact matches.
    for (const candidate of aliasCandidates) {
        const [category, key] = candidate.split('.');
        const exists = context.db.prepare(
            'SELECT 1 FROM properties WHERE category = ? AND key = ? LIMIT 1'
        ).get(category, key);
        if (exists) {
            return { category, key };
        }
    }

    // 2. Exact key match, anywhere — still trusted, no ambiguity.
    const exactMatch = context.db.prepare(
        'SELECT category, key FROM properties WHERE key = ? LIMIT 1'
    ).get(property);
    if (exactMatch) {
        return exactMatch;
    }

    // 3. Fuzzy FTS fallback — this is the dangerous path, so we log every
    // time it fires and ONLY trust it if there's exactly one distinct match.
    // Multiple matches means genuine ambiguity (e.g. "level" could mean
    // "Base Level" or "Top Level") — safer to report failure than guess.
    const fuzzyMatches = context.db.prepare(`
        SELECT DISTINCT category, key FROM property_keys_fts WHERE property_keys_fts MATCH ? LIMIT 5
    `).all(normalizedProperty);

    if (fuzzyMatches.length === 0) {
        console.log(`PROPERTY RESOLUTION: "${property}" — no match found at all`);
        return null;
    }

    if (fuzzyMatches.length > 1) {
        console.log(`PROPERTY RESOLUTION: "${property}" — AMBIGUOUS, ${fuzzyMatches.length} candidates:`,
            fuzzyMatches.map(m => `${m.category}.${m.key}`));
        return null; // refuse to guess — better to fail honestly than pick wrong
    }

    console.log(`PROPERTY RESOLUTION: "${property}" — fuzzy matched to ${fuzzyMatches[0].category}.${fuzzyMatches[0].key}`);
    return fuzzyMatches[0];
}

const TYPE_CATEGORY_ALIASES = {
    beam: ['structural framing'],
    column: ['structural columns'],
    wall: ['walls'],
    floor: ['floors'],
    stair: ['stairs'],
    rebar: ['structural rebar'],
    foundation: ['structural foundations'],
    pile: ['structural foundations']
};

function normalizeType(type) {
         const word = normalizeText(type);                   // "Beams" -> "beams"

    if (TYPE_CATEGORY_ALIASES[word]) {                 // already a known type, e.g. "beam"
        return word;
    }

    const singular = word.replace(/s$/, '');           // "beams" -> "beam"
    if (TYPE_CATEGORY_ALIASES[singular]) {             // only use it if it's a known type
        return singular;
    }

    return word;                                       // unknown word: leave it unchanged
}

// Local type search avoids an APS network call after metadata is cached.
function findElementsByType(context, type) {
     const searchType = normalizeType(type);
    const categoryTargets = TYPE_CATEGORY_ALIASES[searchType];

    let rows = [];

    if (categoryTargets && categoryTargets.length > 0) {
        const placeholders = categoryTargets.map(() => '?').join(',');
        rows = context.db.prepare(`
            SELECT e.objectid, e.name FROM elements e
            JOIN hierarchy h ON h.objectid = e.objectid
            WHERE h.is_real_element = 1 AND LOWER(h.category) IN (${placeholders})
        `).all(...categoryTargets);
    }

    if (rows.length === 0) {
        // NEW: no hardcoded alias for this word — search the categories that
        // actually EXIST in this specific model for a substring match, so an
        // untested word ("ceiling") still works if the model has "Ceilings".
        rows = context.db.prepare(`
            SELECT e.objectid, e.name FROM elements e
            JOIN hierarchy h ON h.objectid = e.objectid
            WHERE h.is_real_element = 1 AND LOWER(h.category) LIKE '%' || ? || '%'
        `).all(searchType);
    }

    if (rows.length === 0) {
        // Final fallback: plain name matching, same safety net as before.
        rows = context.db.prepare(`
            SELECT e.objectid, e.name FROM elements e
            JOIN hierarchy h ON h.objectid = e.objectid
            WHERE h.is_real_element = 1
              AND (e.clean_name LIKE '%' || ? || '%' OR e.name LIKE '%' || ? || '%')
        `).all(searchType, searchType);
    }

    return rows.map(row => toResultItem(row, { type }));
}

// Local property search handles prompts like "steel beams" after intent
// extraction turns them into { property: "material", value: "steel" }.
function findElementsByProperty(context, property, value, type) {
    console.log('>>> NEW findElementsByProperty IS RUNNING <<<');
    const normalizedProperty = normalizeText(property);
    const aliasCandidates = PROPERTY_ALIASES[normalizedProperty] || [];

    // Find every alias candidate that actually exists in this model.
    const realCandidates = [];
    for (const candidate of aliasCandidates) {
        const [category, key] = candidate.split('.');
        const exists = context.db.prepare(
            'SELECT 1 FROM properties WHERE category = ? AND key = ? LIMIT 1'
        ).get(category, key);
        if (exists) {
            realCandidates.push({ category, key });
        }
    }

    if (realCandidates.length === 0) {
        return { propertyPath: null, items: [] };
    }

    // Build the OR clause EXACTLY like the hand-verified query: each
    // condition is "(p.category = ? AND p.key = ?)", joined with OR.
    const orClause = realCandidates
        .map(() => '(p.category = ? AND p.key = ?)')
        .join(' OR ');

    // CRITICAL: params must be built in the SAME ORDER the ?s appear in
    // the query string. The OR-clause ?s come first (category, key pairs),
    // THEN the value placeholder, THEN the type placeholders if any.
    const params = [];
    for (const c of realCandidates) {
        params.push(c.category, c.key);
    }

    let query = `
        SELECT DISTINCT e.objectid, e.name, p.category, p.key, p.value
        FROM elements e
        JOIN hierarchy h ON h.objectid = e.objectid
        JOIN properties p ON p.objectid = e.objectid
        WHERE h.is_real_element = 1
          AND (${orClause})
          AND p.value LIKE '%' || ? || '%'
    `;
    params.push(value); // this MUST come right after the OR-clause params, matching query order

    if (type) {
        const searchType = normalizeText(type);
        const categoryTargets = TYPE_CATEGORY_ALIASES[searchType];
        if (categoryTargets && categoryTargets.length > 0) {
            const placeholders = categoryTargets.map(() => '?').join(',');
            query += ` AND LOWER(h.category) IN (${placeholders})`;
            params.push(...categoryTargets); // added LAST, matching query order
        }
    }

    const rows = context.db.prepare(query).all(...params);
    const items = rows.map(row => toResultItem(row, {
        property,
        matchedPath: `${row.category}.${row.key}`,
        value: row.value
    }));

    return {
        propertyPath: realCandidates.map(c => `${c.category}.${c.key}`).join(' OR '),
        items
    };
}

// Returns every distinct (category, key) pair in this model, with how many
// elements have it and one real sample value — this is what grounds the
// agent in REAL data instead of letting it guess property names.
function getPropertyCatalog(context, concept) {
    const normalized = normalizeText(concept);
    return context.db.prepare(`
        SELECT p1.category, p1.key, COUNT(DISTINCT p1.objectid) as coverage,
               (SELECT value FROM properties p2
                WHERE p2.category = p1.category AND p2.key = p1.key LIMIT 1) as sample
        FROM properties p1
        WHERE LOWER(p1.key) LIKE '%' || ? || '%'
        GROUP BY p1.category, p1.key
        ORDER BY coverage DESC
        LIMIT 10
    `).all(normalized);
}

function findElementsByExactProperty(context, category, key, value, type) {
    let query = `
        SELECT DISTINCT e.objectid, e.name, p.value
        FROM elements e
        JOIN hierarchy h ON h.objectid = e.objectid
        JOIN properties p ON p.objectid = e.objectid
        WHERE h.is_real_element = 1
          AND p.category = ? AND p.key = ?
          AND p.value LIKE '%' || ? || '%'
    `;
    const params = [category, key, value];

    if (type) {
        const categoryTargets = TYPE_CATEGORY_ALIASES[normalizeText(type)];
        if (categoryTargets && categoryTargets.length > 0) {
            query += ` AND LOWER(h.category) IN (${categoryTargets.map(() => '?').join(',')})`;
            params.push(...categoryTargets);
        }
    }

    const rows = context.db.prepare(query).all(...params);
    return rows.map(row => toResultItem(row, { category, key, value: row.value }));
}

function countByExactProperty(context, category, key, value, type) {
    return findElementsByExactProperty(context, category, key, value, type).length;
}

// Shared by SIMPLE_PROPERTY and COUNT — the one place that resolves a
// user-given property word against the real catalog and picks the best match.
function resolvePropertyAndFind(context, property, value, type) {
    const catalog = getPropertyCatalog(context, property);

    if (catalog.length === 0) {
        return { found: false, items: [] };
    }

    const best = catalog.find(c => valueContains(c.sample, value)) || catalog[0];
    const items = findElementsByExactProperty(context, best.category, best.key, value, type);

    return { found: true, propertyPath: `${best.category}.${best.key}`, items };
}

// function getCoordinates(model, id) {
//     const coordinates = coordinateCache.get(modelKey(model));

//     if (!coordinates || !coordinates[id] || !coordinates[id].elementCent) {
//         return null;
//     }

//     return coordinates[id].elementCent;
// }

// Users quote the Revit element id shown in brackets ("Pile Cap [512319]"),
// but the Viewer stores coordinates by its own object id (dbId). Accept either.
function getCoordinates(context, id) {
    const coordinates = coordinateCache.get(modelKey(context));
    if (!coordinates) return null;

    let objectId = id;
    if (!coordinates[objectId]?.elementCent) {
        const row = context.db.prepare(
            "SELECT objectid FROM elements WHERE name LIKE '%[' || ? || ']'"
        ).get(String(id));
        objectId = row?.objectid;
    }

    return coordinates[objectId]?.elementCent || null;
}

// The LLM only routes the request. It does not directly call APS or decide how
// to query the model, which keeps the execution path deterministic and cheaper.
async function extractIntent(prompt) {
    const extractionPrompt = `
You are an intent extraction system for a BIM model.

Return ONLY valid JSON:

{
  "intent": "SIMPLE_TYPE | SIMPLE_PROPERTY | COORDINATE | COMPLEX",
  "type": "",
  "property": "",
  "value": "",
  "id": ""
}

Rules:
- SIMPLE_TYPE means the user asks for elements by type, such as floors, walls, beams, doors, columns.
- SIMPLE_PROPERTY means the user filters elements by a property/value, such as steel beams or concrete columns.
- COORDINATE means the user asks for the position or coordinates of a specific element id.
- COMPLEX means the request needs multiple steps, aggregation, comparison, or is unclear.
- For "steel beams", use SIMPLE_PROPERTY with type "beam", property "material", value "steel".
- For "list all floors", use SIMPLE_TYPE with type "floor".
- For "coordinates of element 123", use COORDINATE with id "123".
`;

    const extraction = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: extractionPrompt },
            { role: 'user', content: prompt }
        ]
    });

    const usage = extraction.usage || {};
    intentTokenUsage.promptTokens += usage.prompt_tokens || 0;
    intentTokenUsage.completionTokens += usage.completion_tokens || 0;
    intentTokenUsage.totalTokens += usage.total_tokens || 0;

    const parsedIntent = JSON.parse(extraction.choices[0].message.content);
    console.log('CLASSIFIER RESULT:', JSON.stringify(parsedIntent, null, 2)); // <-- temporary debug line


    return {
        intent: JSON.parse(extraction.choices[0].message.content),
        usage: {
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || 0
        }
    };
}

// Executes the structured intent with plain JavaScript handlers. Complex queries
// are intentionally explicit so a planner/SQL-style aggregator can be added
// later without disturbing simple fast-path queries.
async function executeIntent(model, context, intent) {
    switch (intent.intent) {
        case 'SIMPLE_TYPE': {
            const items = findElementsByType(context, intent.type);
            return {
                success: true,
                handler: 'local_type_search',
                message: formatElementResults(items),
                raw: items
            };
        }

        case 'SIMPLE_PROPERTY': {
            const filter = intentToFilter(context, intent);
            if (filter === null) {
                return { success: true, handler: 'profile_search', message: formatElementResults([]), raw: [] };
            }
            if (filter) {
                const items = findElements(context, filter);
                return { success: true, handler: 'profile_search', filter, message: formatElementResults(items), raw: items };
            }

            // Properties the profile doesn't know yet (e.g. "mark") still use the old path.
            const resolved = resolvePropertyAndFind(context, intent.property, intent.value, intent.type);

        }

        case 'COUNT': {
            let items;
            if (intent.property) {
                const resolved = resolvePropertyAndFind(context, intent.property, intent.value, intent.type);
                if (!resolved.found) {
                    return { success: false, handler: 'count', message: `No property matching "${intent.property}" found.`, raw: [] };
                }
                items = resolved.items;
            } else if (intent.type) {
                items = findElementsByType(context, intent.type);
            } else {
                items = [];
            }
            return { success: true, handler: 'count', message: { count: items.length }, raw: items };
        }

        case 'COORDINATE': {
               const coordinates = getCoordinates(context, intent.id);

            if (!coordinates) {
                return {
                    success: false,
                    handler: 'coordinate_lookup',
                    message: `No coordinates found for object id ${intent.id}.`,
                    raw: null
                };
            }

            return {
                success: true,
                handler: 'coordinate_lookup',
                message: `Coordinates for object ${intent.id}: ${JSON.stringify(coordinates)}`,
                raw: coordinates
            };
        }

        case 'COMPLEX':
            return {
                success: false,
                handler: 'complex_query',
                message: 'Complex query detected. Next step is to route this to a multi-step planner or SQL-style aggregation handler.',
                raw: null
            };

        default:
            return {
                success: false,
                handler: 'unknown_intent',
                message: `Unknown intent "${intent.intent}".`,
                raw: null
            };
    }
}

// Add tools to the agent for complex queries. These tools can be called by the LLM to perform

const tools = [
    {
        type: "function",
        function: {
            name: "search_by_type",
            description: "Find elements by their type, e.g. beam, wall, door, column, floor.",
            parameters: {
                type: "object",
                properties: {
                    type: { type: "string", description: "The element type to search for" }
                },
                required: ["type"]
            }
        }
    },
    // {
    //     type: "function",
    //     function: {
    //         name: "search_by_property",
    //         description: "Find elements filtered by a property value, e.g. material=steel. Optionally scope to a type.",
    //         parameters: {
    //             type: "object",
    //             properties: {
    //                 property: { type: "string" },
    //                 value: { type: "string" },
    //                 type: { type: "string" }
    //             },
    //             required: ["property", "value"]
    //         }
    //     }
    // },
    
    {
        type: "function",
        function: {
            name: "count_elements",
            description: "Count elements matching an optional type and/or property filter. Use this whenever the user asks 'how many', not search_by_type/search_by_property.",
            parameters: {
                type: "object",
                properties: {
                    type: { type: "string" },
                    property: { type: "string" },
                    value: { type: "string" }
                }
            }
        }
    },
        {
        type: "function",
        function: {
            name: "list_properties",
            description: "Search for the EXACT property names available in THIS model, matching a general concept (e.g. 'level', 'weight', 'material'). Returns real (category, key) pairs with sample values. ALWAYS call this BEFORE search_by_property or count_elements_by_property, to get the real property name instead of guessing — guessing causes wrong answers.",
            parameters: {
                type: "object",
                properties: { concept: { type: "string", description: "The general concept the user is asking about, e.g. 'level', 'weight'" } },
                required: ["concept"]
            }
        }
    },
        {
        type: "function",
        function: {
            name: "search_by_property",
            description: "Find elements with an EXACT property category and key (get these from list_properties first, never guess them) matching a value. Optionally scope by type.",
            parameters: {
                type: "object",
                properties: {
                    category: { type: "string", description: "Exact category from list_properties, e.g. 'Constraints'" },
                    key: { type: "string", description: "Exact key from list_properties, e.g. 'Base Level'" },
                    value: { type: "string" },
                    type: { type: "string" }
                },
                required: ["category", "key", "value"]
            }
        }
    },
    {
    type: "function",
    function: {
        name: "count_elements_by_property",
        description: "Count elements with an EXACT property category and key (get these from list_properties first) matching a value. Use for 'how many' questions.",
        parameters: {
            type: "object",
            properties: {
                category: { type: "string" },
                key: { type: "string" },
                value: { type: "string" },
                type: { type: "string" }
            },
            required: ["category", "key", "value"]
        }
    }
},
    {
        type: "function",
        function: {
            name: "get_coordinates",
            description: "Get the 3D coordinates of one specific element by its objectId.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string" }
                },
                required: ["id"]
            }
        }
    }
];

function toolError(code, message) {
    return { success: false, code, error: message };
}

function toolSuccess(data) {
    return { success: true, ...data };
}

async function executeTool(name, args, context, model) {
    console.log('TOOL CALL:', name, JSON.stringify(args));

        // Check required arguments against the tool's own schema, so a call the
    // model got wrong comes back as an error it can correct, not as "0 results".
    const schema = tools.find(t => t.function.name === name)?.function.parameters;
    const missing = (schema?.required || []).filter(key =>
        args[key] === undefined || args[key] === null || String(args[key]).trim() === '');
    if (missing.length) {
        const error = toolError('MISSING_ARGUMENT',
            `Missing required argument(s): ${missing.join(', ')}. Call ${name} again with them.`);
        console.log('TOOL RESULT:', JSON.stringify(error));
        return error;
    }

    let result;

    switch (name) {
        case 'search_by_type': {
            const items = findElementsByType(context, args.type);
            result = toolSuccess(formatElementResults(items));
            break;
        }

        // case 'search_by_property': {
        //     const { propertyPath, items } = findElementsByProperty(context, args.property, args.value, args.type);
        //     if (!propertyPath) {
        //         result = toolError('PROPERTY_NOT_FOUND', `Could not find a property called "${args.property}". Try "material", "level", "type", or "category".`);
        //         break;
        //     }
        //     result = toolSuccess(formatElementResults(items));
        //     break;
        // }
        case 'list_properties': {
            const matches = getPropertyCatalog(context, args.concept);
            result = toolSuccess({ matches });
            break;
        }

        case 'search_by_property': {
            // NOTE: if this name collides with your OLD fuzzy-based tool,
            // rename the old one (e.g. 'search_by_property_fuzzy') or remove
            // it entirely now that this exact-match version replaces it.
            const items = findElementsByExactProperty(context, args.category, args.key, args.value, args.type);
            result = toolSuccess(formatElementResults(items));
            break;
        }

        case 'count_elements_by_property': {
            const count = countByExactProperty(context, args.category, args.key, args.value, args.type);
            result = toolSuccess({ count });
            break;
        }

        
        case 'count_elements': {
            let items;
            if (args.property) {
                const { propertyPath, items: found } = findElementsByProperty(context, args.property, args.value, args.type);
                if (!propertyPath) {
                    result = toolError('PROPERTY_NOT_FOUND', `Could not find a property called "${args.property}". Try "material", "level", "type", or "category".`);
                    break;
                }
                items = found;
            } else if (args.type) {
                items = findElementsByType(context, args.type);
            } else {
                items = [];
            }
            result = toolSuccess({ count: items.length });
            break;
        }

        case 'get_coordinates': {
            const coordinates = getCoordinates(context, args.id);
            result = coordinates
                ? toolSuccess({ coordinates })
                : toolError('COORDINATES_NOT_FOUND', `No coordinates found for object ${args.id}`);
            break;
        }

        default:
            result = toolError('UNKNOWN_TOOL', `Unknown tool "${name}"`);
    }

    console.log('TOOL RESULT:', JSON.stringify(result).slice(0, 500));
    return result;
}

const MAX_STEPS = 6;

async function runAgent(prompt, context, model) {
    const messages = [
        {
            role: "system",
            content: `You are an assistant answering questions about a BIM model.

CRITICAL: When the user asks about a property (level, weight, material, etc.),
you MUST call list_properties first to find the exact (category, key) pair
that exists in this specific model. NEVER guess a property name — different
models use different property names, and guessing produces wrong answers.

After list_properties returns matches, pick the one whose sample value and
key name best fit what the user is asking (e.g. for "level 2", prefer a key
whose sample looks like "Level 1" or "Level 2" over a key like "End Level
Offset" whose sample is a number with "mm").

Use count_elements_by_property for "how many" questions, search_by_property
for "list/show" questions.

If the user asks about your own capabilities, answer directly without tools.`

        },
        { role: "user", content: prompt }
    ];

    for (let step = 0; step < MAX_STEPS; step++) {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages,
            tools,
            tool_choice: 'auto'
        });

        const message = response.choices[0].message;
        messages.push(message);

        // If the model didn't ask for a tool, it's giving its final answer — stop.
        if (!message.tool_calls) {
            return { finalAnswer: message.content, messages };
        }

        // The model can ask for multiple tool calls in one step — handle all of them.
        for (const call of message.tool_calls) {
             let args = null;
            try {
                args = JSON.parse(call.function.arguments || '{}');
            } catch {
                // fall through: tell the model instead of crashing the request
            }
            const result = args
                ? await executeTool(call.function.name, args, context, model)
                : toolError('BAD_ARGUMENTS', 'The arguments were not valid JSON. Call the tool again with a JSON object.');

            messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify(result)
            });
        }
        // Loop continues: next iteration sends the tool results back to the model,
        // which decides whether it needs another tool call or can now answer.
    }

    return { finalAnswer: "Sorry, I couldn't resolve that within the allowed steps.", messages };
}

// ============================================================================
// Splits a raw value like "25.400 kgf/m" into { numericValue: 25.4, unit: "kgf/m" }
// ============================================================================
function parseValueAndUnit(value) {
    if (value === null || value === undefined) {
        return { numericValue: null, unit: null };
    }

    const str = String(value);
    const match = str.match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/);

    if (!match) {
        return { numericValue: null, unit: null };
    }

    return {
        numericValue: parseFloat(match[1]),
        unit: match[2].trim() || null
    };
}

// ============================================================================
// Real category names confirmed from your actual model tree dump.
// ============================================================================
const KNOWN_CATEGORY_NAMES = new Set([
    'walls', 'floors', 'structural foundations', 'stairs', 'runs',
    'structural columns', 'structural framing', 'lines',
    'structural area reinforcement', 'structural rebar', 'supports',
    'doors', 'windows', 'roofs', 'ceilings', 'railings',
    'pipes', 'ducts', 'mechanical equipment', 'electrical equipment'
]);

function isCategoryNode(name) {
    return KNOWN_CATEGORY_NAMES.has(normalizeText(name));
}

// ============================================================================
// Walks the model tree once, recording each node's inherited category and
// whether it's a leaf (real element) or a container (grouping node).
// ============================================================================
function buildHierarchyRows(tree) {
    const rows = [];

    // depth 0 = root's direct children = ALWAYS category nodes, regardless
    // of what they're named. This removes any need to maintain a list of
    // known category names — new categories in new models just work.
    function walk(node, parentId, currentCategory, depth) {
        const categoryHere = depth === 0 ? node.name : currentCategory;
        const hasChildren = Array.isArray(node.objects) && node.objects.length > 0;

        rows.push({
            objectid: node.objectid,
            parentId,
            category: categoryHere || null,
            isLeaf: hasChildren ? 0 : 1,
            isRealElement: isRealElementName(node.name) ? 1 : 0
        });

        if (hasChildren) {
            for (const child of node.objects) {
                walk(child, node.objectid, categoryHere, depth + 1);
            }
        }
    }

    const root = tree?.data?.objects?.[0];
    if (root && Array.isArray(root.objects)) {
        for (const child of root.objects) {
            walk(child, root.objectid, null, 0); // depth 0 = this IS a category
        }
    }

    return rows;
}

// ============================================================================
// Builds one SQLite database in memory for one model, from its flat
// properties collection + its tree + any cached coordinates.
// ============================================================================
function buildModelDatabase(collection, tree, coordinates = {}) {
    const db = new Database(':memory:');

    db.exec(`
        CREATE TABLE elements (
            objectid INTEGER PRIMARY KEY,
            name TEXT,
            clean_name TEXT
        );

        CREATE TABLE properties (
            objectid INTEGER,
            category TEXT,
            key TEXT,
            value TEXT,
            numeric_value REAL,
            unit TEXT
        );

        CREATE TABLE coordinates (
            objectid INTEGER PRIMARY KEY,
            x REAL, y REAL, z REAL
        );

        CREATE TABLE hierarchy (
            objectid INTEGER PRIMARY KEY,
            parent_id INTEGER,
            category TEXT,
            is_leaf INTEGER,
            is_real_element INTEGER  -- 1 = genuine physical element (name has a bracketed ID), 0 = container/grouping node
        );

        CREATE VIRTUAL TABLE property_keys_fts USING fts5(key, category, objectid UNINDEXED);

        CREATE INDEX idx_props_category_key ON properties(category, key);
        CREATE INDEX idx_props_objectid ON properties(objectid);
        CREATE INDEX idx_hierarchy_category ON hierarchy(category);
    `);

    const insertElement = db.prepare('INSERT INTO elements (objectid, name, clean_name) VALUES (?, ?, ?)');
    const insertProp = db.prepare(
        'INSERT INTO properties (objectid, category, key, value, numeric_value, unit) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertFts = db.prepare('INSERT INTO property_keys_fts (key, category, objectid) VALUES (?, ?, ?)');
    const insertCoord = db.prepare('INSERT INTO coordinates (objectid, x, y, z) VALUES (?, ?, ?, ?)');
    const insertHierarchy = db.prepare(
    'INSERT INTO hierarchy (objectid, parent_id, category, is_leaf, is_real_element) VALUES (?, ?, ?, ?, ?)'
    );

    const ingestProperties = db.transaction((items) => {
        for (const item of items) {
            insertElement.run(item.objectid, item.name, cleanElementName(item.name));

            for (const [category, details] of Object.entries(item.properties || {})) {
                if (!details || typeof details !== 'object' || Array.isArray(details)) {
                    continue;
                }
                for (const [key, value] of Object.entries(details)) {
                    const { numericValue, unit } = parseValueAndUnit(value);
                    insertProp.run(item.objectid, category, key, String(value), numericValue, unit);
                    insertFts.run(key, category, item.objectid);
                }
            }

            const coord = coordinates[item.objectid];
            if (coord && coord.elementCent) {
                const [x, y, z] = coord.elementCent;
                insertCoord.run(item.objectid, x, y, z);
            }
        }
    });

    ingestProperties(collection);

    const hierarchyRows = buildHierarchyRows(tree);
    const ingestHierarchy = db.transaction((rows) => {
    for (const row of rows) {
        insertHierarchy.run(row.objectid, row.parentId, row.category, row.isLeaf, row.isRealElement);
    }
    });
    ingestHierarchy(hierarchyRows);

    return db;
}

function isRealElementName(name = '') {
    return /\[\d+\]/.test(name);
}

// The property keys Revit uses for "the level an element sits on". It differs
// per category: beams use Reference Level, columns Base Level, floors Level,
// walls Base Constraint. Top Level is left out on purpose: a column that ends
// at Level 2 isn't "on" Level 2.
const LEVEL_KEYS = ['Level', 'Base Level', 'Reference Level', 'Base Constraint'];

// Summarises what this model actually contains, once, when it loads.
function buildModelProfile(db) {
    const levelKeyPlaceholders = LEVEL_KEYS.map(() => '?').join(',');

    // 1. Categories, with how many real elements each has.
    const categories = db.prepare(`
        SELECT category AS name, COUNT(*) AS count
        FROM hierarchy
        WHERE is_real_element = 1 AND category IS NOT NULL
        GROUP BY category
        ORDER BY count DESC
    `).all();

    // 2. Which level key each category uses. Rows come back most-used first,
    //    so the first key we see for a category is the one it really uses.
    const levelKeyRows = db.prepare(`
        SELECT h.category, p.key, COUNT(*) AS count
        FROM properties p
        JOIN hierarchy h ON h.objectid = p.objectid
        WHERE h.is_real_element = 1
          AND p.category = 'Constraints' AND p.key IN (${levelKeyPlaceholders})
        GROUP BY h.category, p.key
        ORDER BY count DESC
    `).all(...LEVEL_KEYS);

    const levelKeyByCategory = {};
    for (const row of levelKeyRows) {
        if (!levelKeyByCategory[row.category]) {
            levelKeyByCategory[row.category] = row.key;
        }
    }

    // 3. The level names that appear in those keys.
    const levels = db.prepare(`
        SELECT p.value AS name, COUNT(DISTINCT p.objectid) AS count
        FROM properties p
        JOIN hierarchy h ON h.objectid = p.objectid
        WHERE h.is_real_element = 1
          AND p.category = 'Constraints' AND p.key IN (${levelKeyPlaceholders})
        GROUP BY p.value
        ORDER BY count DESC
    `).all(...LEVEL_KEYS);

    // 4. Structural materials. "<By Category>" is a Revit placeholder, not a material.
    const materials = db.prepare(`
        SELECT p.value AS name, COUNT(DISTINCT p.objectid) AS count
        FROM properties p
        JOIN hierarchy h ON h.objectid = p.objectid
        WHERE h.is_real_element = 1
          AND p.category = 'Materials and Finishes' AND p.key = 'Structural Material'
          AND p.value <> '<By Category>'
        GROUP BY p.value
        ORDER BY count DESC
    `).all();

    return { categories, levels, levelKeyByCategory, materials };

}

// ============================================================================
// The ONE query layer. Every value in `filter` must be an exact name from the
// model profile, so the SQL only ever uses "=" / IN — no guessing with LIKE.
//   filter = { categories: ['Structural Framing'], levels: ['Level 2'], materials: [...] }
// An empty list means "don't filter on this".
// ============================================================================
function findElements(context, { categories = [], levels = [], materials = [] } = {}) {
    const list = values => values.map(() => '?').join(',');
    let query = `
        SELECT e.objectid, e.name
        FROM elements e
        JOIN hierarchy h ON h.objectid = e.objectid
        WHERE h.is_real_element = 1
    `;
    const params = [];

    if (categories.length > 0) {
        query += ` AND h.category IN (${list(categories)})`;
        params.push(...categories);
    }

    if (levels.length > 0) {
        // Each category keeps its level in a different key, so match the
        // (category, key) pairs from the profile:
        //   (h.category = 'Structural Framing' AND p.key = 'Reference Level') OR ...
        const pairs = Object.entries(context.profile.levelKeyByCategory);
        const pairClause = pairs.map(() => '(h.category = ? AND p.key = ?)').join(' OR ');
        query += `
            AND EXISTS (
                SELECT 1 FROM properties p
                WHERE p.objectid = e.objectid
                  AND p.category = 'Constraints'
                  AND (${pairClause})
                  AND p.value IN (${list(levels)})
            )`;
        for (const [category, key] of pairs) {
            params.push(category, key);
        }
        params.push(...levels);
    }

    if (materials.length > 0) {
        query += `
            AND EXISTS (
                SELECT 1 FROM properties p
                WHERE p.objectid = e.objectid
                  AND p.category = 'Materials and Finishes' AND p.key = 'Structural Material'
                  AND p.value IN (${list(materials)})
            )`;
        params.push(...materials);
    }

    const rows = context.db.prepare(query).all(...params);
    return rows.map(row => toResultItem(row, { categories, levels, materials }));
}

// TEMPORARY bridge until the classifier is grounded (step 3): turns the old
// intent words ({ type: 'beam', property: 'level', value: 'Level 2' }) into
// exact profile names. Returns null if a word matches nothing in this model,
// or undefined if the property isn't one the profile knows about.
function intentToFilter(context, intent) {
    const { profile } = context;
    const filter = { categories: [], levels: [], materials: [] };

    if (intent.type) {
        const wanted = resolveCategoryNames(profile, intent.type);
        if (wanted.length === 0) return null;
        filter.categories = wanted;
    }

    const property = normalizeText(intent.property);
    const value = normalizeText(intent.value);

    if (property === 'level') {
        // Exact name first ("level 2" -> "Level 2"), then whole word ("2" -> "Level 2", not "Level 12").
        let levels = profile.levels.filter(l => normalizeText(l.name) === value);
        if (levels.length === 0) {
            const word = new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            levels = profile.levels.filter(l => word.test(l.name));
        }
        if (levels.length === 0) return null;
        filter.levels = levels.map(l => l.name);
    } else if (property === 'material') {
        // Substring on purpose: "wood" must find "Softwood, Lumber", "steel" all three steels.
        const materials = profile.materials.filter(m => normalizeText(m.name).includes(value));
        if (materials.length === 0) return null;
        filter.materials = materials.map(m => m.name);
    } else if (property) {
        return undefined; // not a profile property -> caller uses the old path
    }

    return filter;
}

// "beams" -> ['Structural Framing'], "doors" -> ['Doors'] if the model has it.
function resolveCategoryNames(profile, type) {
    const word = normalizeType(type);
    const aliases = TYPE_CATEGORY_ALIASES[word] || [word];
    return profile.categories
        .map(c => c.name)
        .filter(name => aliases.some(alias => name.toLowerCase().includes(alias)));
}

router.get('/debug_profile', async function (req, res) {
    try {
        const context = await ensureModelContext(getModelFromInput(req.query));
        res.json(context.profile);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Returns the latest raw result for the selected/default model. Existing viewer
// extensions use this to inspect or reuse the last query result.
router.get('/ask_agent_simple', async function (req, res) {
    const model = getModelFromInput(req.query);
    const result = resultCache.get(modelKey(model)) || null;

    res.json({
        success: true,
        model: {
            urn: model.urn,
            guid: model.guid
        },
        message: result
    });
});

router.get('/debug_db', async function (req, res) {
    try {
        const model = getModelFromInput(req.query);
        const context = await ensureModelContext(model);

        const elementCount = context.db.prepare('SELECT COUNT(*) as c FROM elements').get().c;
        const propertyCount = context.db.prepare('SELECT COUNT(*) as c FROM properties').get().c;
        const hierarchyCount = context.db.prepare('SELECT COUNT(*) as c FROM hierarchy').get().c;
        const leafCount = context.db.prepare('SELECT COUNT(*) as c FROM hierarchy WHERE is_leaf = 1').get().c;
        const categorySample = context.db.prepare('SELECT DISTINCT category FROM hierarchy WHERE category IS NOT NULL LIMIT 20').all();

        res.json({ elementCount, propertyCount, hierarchyCount, leafCount, categorySample });
    } catch (error) {
        console.error('debug_db error:', error);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

router.get('/debug_leaves', async function (req, res) {
    try {
        const model = getModelFromInput(req.query);
        const context = await ensureModelContext(model);

        const containers = context.db.prepare(
            'SELECT h.objectid, e.name, h.category FROM hierarchy h JOIN elements e ON e.objectid = h.objectid WHERE h.is_real_element = 0 LIMIT 20'
        ).all();

        const realPileCap = context.db.prepare(
            "SELECT h.objectid, e.name, h.is_leaf, h.is_real_element FROM hierarchy h JOIN elements e ON e.objectid = h.objectid WHERE e.name LIKE '%512319%'"
        ).get();

        res.json({ containers, realPileCap });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/debug_direct_query', async function (req, res) {
    try {
        const model = getModelFromInput(req.query);
        const context = await ensureModelContext(model);

        // Hand-written, no dynamic building, no app logic — just a direct
        // check: does the database itself correctly answer this?
        const rows = context.db.prepare(`
            SELECT DISTINCT e.objectid, e.name
            FROM elements e
            JOIN hierarchy h ON h.objectid = e.objectid
            JOIN properties p ON p.objectid = e.objectid
            WHERE h.is_real_element = 1
              AND ((p.category = 'Constraints' AND p.key = 'Base Level')
                   OR (p.category = 'Constraints' AND p.key = 'Level'))
              AND p.value LIKE '%2%'
        `).all();

        res.json({ count: rows.length, rows: rows.slice(0, 10) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// Stores object coordinates generated by the Viewer, keyed by model. APS
// metadata knows object properties, while the Viewer is better for geometry.
router.put('/ask_agent_simple', async function (req, res) {
    const model = getModelFromInput(req.body);
    const coordinates = getCoordinatePayload(req.body);

    coordinateCache.set(modelKey(model), coordinates);

    res.json({
        success: true,
        model: {
            urn: model.urn,
            guid: model.guid
        },
        count: Object.keys(coordinates || {}).length
    });
});

// Main chat endpoint:
// 1. load/cached model metadata
// 2. classify the user's prompt
// 3. execute the matching deterministic handler
// 4. return viewer-friendly object IDs and display names
router.post('/ask_agent_simple', async function (req, res) {
    try {
        const prompt = req.body?.prompt;

        if (!prompt) {
            return res.status(400).json({
                success: false,
                message: 'A prompt is required.'
            });
        }

        const model = getModelFromInput(req.body);
        const context = await ensureModelContext(model);
        const { intent, usage } = await extractIntent(prompt);
        let result;
        if (intent.intent === 'COMPLEX') {
            const { finalAnswer, messages } = await runAgent(prompt, context, model);
            result = {
                success: true,
                handler: 'agent_loop',
                message: finalAnswer,
                steps: messages.length
            };
        } else {
            result = await executeIntent(model, context, intent); // your existing fast path
        }

        resultCache.set(modelKey(model), result.raw);

        return res.json({
            success: result.success,
            model: {
                urn: model.urn,
                guid: model.guid
            },
            intent,
            handler: result.handler,
            propertyPath: result.propertyPath,
            message: result.message,
            token: {
                currentRequest: usage,
                totalIntentUsage: intentTokenUsage
            },
            cache: {
                modelLoadedAt: context.loadedAt,
                modelElementCount: context.elementCount,  // this field DOES exist on the new context
                propertyPathCount: context.db.prepare('SELECT COUNT(DISTINCT category || key) as c FROM properties').get().c
            }
        });
    } catch (error) {
        console.error('ask_agent_simple error:', error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;

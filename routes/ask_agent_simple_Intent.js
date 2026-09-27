const express = require('express');
const OpenAI = require('openai');
const axios = require('axios');
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
        const metadata = await getModelMetadata(model, accessToken);
        const collection = metadata?.data?.collection || [];
        const propertyIndex = indexPropertyPaths(collection);

        const context = {
            key,
            urn: model.urn,
            guid: model.guid,
            loadedAt: new Date().toISOString(),
            collection,
            propertyPaths: propertyIndex.paths,
            propertyLabels: propertyIndex.labels,
            propertyPathSet: propertyIndex.pathSet,
            uniqueNames: getUniqueNames(collection)
        };

        modelCache.set(key, context);
        const raw = JSON.stringify(metadata);
        console.log(raw.includes('__category__')); // true/false
        console.log(raw.includes('Category'));     // check non-underscore variant too
        const collectionTrial = metadata?.data?.collection || [];
        const columnElement = collectionTrial.find(item => item.objectid === 3493); // the ambiguous "UB Universal Beams Column"
        console.log(JSON.stringify(columnElement, null, 2));    
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

    for (const candidate of aliasCandidates) {
        if (context.propertyPathSet.has(candidate)) {
            return candidate;
        }
    }

    const exactLabelMatch = context.propertyLabels.find(
        item => normalizeText(item.label) === normalizedProperty
    );

    if (exactLabelMatch) {
        return exactLabelMatch.path;
    }

    const exactPathMatch = context.propertyPaths.find(
        path => normalizeText(path) === normalizedProperty
    );

    if (exactPathMatch) {
        return exactPathMatch;
    }

    const partialLabelMatch = context.propertyLabels.find(
        item => normalizeText(item.label).includes(normalizedProperty)
    );

    if (partialLabelMatch) {
        return partialLabelMatch.path;
    }

    return context.propertyPaths.find(
        path => normalizeText(path).includes(normalizedProperty)
    ) || null;
}

// Local type search avoids an APS network call after metadata is cached.
function findElementsByType(context, type) {
    const searchType = normalizeText(type);

    if (!searchType) {
        return [];
    }

    return context.collection
        .filter(item => {
            const name = normalizeText(item.name || '');
            const cleanName = normalizeText(cleanElementName(item.name || ''));
            return name.includes(searchType) || cleanName.includes(searchType);
        })
        .map(item => toResultItem(item, { type }));
}

// Local property search handles prompts like "steel beams" after intent
// extraction turns them into { property: "material", value: "steel" }.
function findElementsByProperty(context, property, value, type) {
    const propertyPath = resolvePropertyPath(context, property);

    if (!propertyPath) {
        return {
            propertyPath: null,
            items: []
        };
    }

    const items = context.collection
        .filter(item => {
            if (type) {
                const name = normalizeText(item.name || '');
                const cleanName = normalizeText(cleanElementName(item.name || ''));

                if (!name.includes(normalizeText(type)) && !cleanName.includes(normalizeText(type))) {
                    return false;
                }
            }

            const propertyValue = getPropertyValue(item.properties, propertyPath);
            return valueContains(propertyValue, value);
        })
        .map(item => toResultItem(item, {
            property,
            propertyPath,
            value: getPropertyValue(item.properties, propertyPath)
        }));

    return {
        propertyPath,
        items
    };
}

function getCoordinates(model, id) {
    const coordinates = coordinateCache.get(modelKey(model));

    if (!coordinates || !coordinates[id] || !coordinates[id].elementCent) {
        return null;
    }

    return coordinates[id].elementCent;
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
            const { propertyPath, items } = findElementsByProperty(
                context,
                intent.property,
                intent.value,
                intent.type
            );

            if (!propertyPath) {
                return {
                    success: false,
                    handler: 'local_property_search',
                    message: `No matching property path found for "${intent.property}".`,
                    raw: []
                };
            }

            return {
                success: true,
                handler: 'local_property_search',
                propertyPath,
                message: formatElementResults(items),
                raw: items
            };
        }

        case 'COORDINATE': {
            const coordinates = getCoordinates(model, intent.id);

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
        const result = await executeIntent(model, context, intent);

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
                modelElementCount: context.collection.length,
                propertyPathCount: context.propertyPaths.length
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

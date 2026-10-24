// routes/ask_agent_simple_v2.js
// ===========================================================================
// A chatbot endpoint that answers questions about a BIM model.
//
//   question ─► getModel ─► planQuery (LLM) ─► validatePlan ─► runPlan (SQL) ─► answer
//
// The file is split into 5 sections. Read them in order:
//   1. APS            - logs in to Autodesk and downloads the model
//   2. MODEL STORE    - puts the model in SQLite and builds its "vocabulary"
//   3. PLANNER        - the ONLY LLM call: question -> JSON plan
//   4. QUERY ENGINE   - checks the plan, turns it into SQL, writes the answer
//   5. ROUTES         - the HTTP endpoints that connect it all
// ===========================================================================

const express = require('express');
const axios = require('axios');
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET } = require('../config.js');
const usage = require('./usage');   // daily token budgets per visitor

const router = express.Router();


// ===========================================================================
// 1. APS
// Everything that talks to Autodesk Platform Services lives in this section.
// Nothing else builds an APS URL - it all goes through fetchModelData().
// ===========================================================================

const AUTH_URL = 'https://developer.api.autodesk.com/authentication/v2/token';
const MODEL_URL = 'https://developer.api.autodesk.com/modelderivative/v2/designdata';

// An APS token lasts about an hour. We renew it 60 seconds early, so a request
// that starts just before expiry doesn't fail half-way through.
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

// One token shared by the whole server. It's an *app* token ("2-legged"),
// not tied to a user, so every request can reuse the same one.
const token = {
    value: null,    // the token string; null until we log in the first time
    expiresAt: 0,   // when it stops working (milliseconds since 1970, like Date.now())
    pending: null   // a Promise while a login is in progress (explained below)
};

// Our own error type. When APS says "still processing this model" we throw
// THIS instead of a plain Error. The route checks `instanceof ModelNotReadyError`
// and answers 503 "try again in a minute" instead of 500 "server broke".
class ModelNotReadyError extends Error {}

// The model loaded fine, but its objects don't look like model elements ("Name [id]"),
// e.g. a DWG drawing. The route answers 422 "can't do this with that model".
class UnsupportedModelError extends Error {}

// Logs in to APS and stores the new token.
async function requestNewToken() {
    // The token endpoint expects a form-encoded body (like an HTML form post).
    const body = new URLSearchParams({
        grant_type: 'client_credentials', // "log in as the app itself, not as a user"
        scope: 'data:read'                // we only need to read models, so ask for nothing more
    });

    // APS wants "clientId:clientSecret" encoded as base64 in a "Basic" header.
    const credentials = Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString('base64');

    const response = await fetch(AUTH_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${credentials}`
        },
        body
    });

    // fetch() does NOT throw on 401/500, so we have to check ourselves.
    if (!response.ok) {
        throw new Error(`APS authentication failed with status ${response.status}`);
    }

    const data = await response.json();
    token.value = data.access_token;
    token.expiresAt = Date.now() + data.expires_in * 1000; // expires_in is in seconds; Date.now() is in ms
    return token.value;
}

// Returns a working token, logging in only when we have to.
async function getAccessToken() {
    const stillValid = token.value && Date.now() < token.expiresAt - TOKEN_REFRESH_BUFFER_MS;
    if (stillValid) {
        return token.value;
    }

    // If 10 requests arrive while the token is expired, we want ONE login, not 10.
    // The first request starts the login and saves its Promise in `pending`.
    // The other 9 find `pending` already set and simply wait on the same Promise.
    if (!token.pending) {
        token.pending = requestNewToken().finally(() => {
            token.pending = null; // runs whether the login worked or failed
        });
    }
    return token.pending;
}

// GET an APS URL and refuse to continue if APS answers 202.
// 202 means "accepted, still working on it": the body is NOT the data yet.
// v1 treated that body as an empty model and cached it forever.
async function getReadyJson(url, accessToken) {
    const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (response.status === 202) {
        throw new ModelNotReadyError('APS is still processing this model. Try again in a minute.');
    }
    return response.data;
}

// A model has one or more views (3D views, sheets), each with its own GUID. The page
// only knows the model's URN, so we ask APS for the list of views and take the main
// 3D one: the "master view" if there is one, otherwise the first 3D view.
async function findMainViewGuid(urn) {
    const accessToken = await getAccessToken();
    const list = await getReadyJson(`${MODEL_URL}/${urn}/metadata`, accessToken);
    const views = list?.data?.metadata || [];
    if (views.length === 0) {
        throw new ModelNotReadyError('This model has no views yet. APS may still be translating it.');
    }
    const view = views.find(v => v.role === '3d' && v.isMasterView) || views.find(v => v.role === '3d');
    if (!view) {
        // Only 2D views (e.g. a DWG drawing): there are no model elements to ask about,
        // and APS would answer "still processing" forever if we waited for them.
        throw new UnsupportedModelError('This model has no 3D view, so there are no elements to ask about. The assistant works with 3D models such as Revit files.');
    }
    return view.guid;
}

// Downloads everything we need about one model view:
//   - properties: a flat list of every object with its property groups
//   - tree:       the hierarchy (Category > Family > Type > Element)
async function fetchModelData(urn, guid) {
    const accessToken = await getAccessToken();
    const base = `${MODEL_URL}/${urn}/metadata/${guid}`;

    // The two downloads don't depend on each other, so Promise.all starts
    // both at the same time instead of waiting for one to finish first.
    const [properties, tree] = await Promise.all([
        getReadyJson(`${base}/properties?forceget=true`, accessToken),
        getReadyJson(base, accessToken)
    ]);

    return {
        // `?.` means "if this is missing, give undefined instead of crashing";
        // `|| []` then turns undefined into an empty list.
        collection: properties?.data?.collection || [],
        tree
    };
}


// ===========================================================================
// 2. MODEL STORE
// Turns the raw APS download into two things we can use:
//   db         - a small SQLite database (in memory) we can query with SQL
//   vocabulary - a summary of what's IN this model: its real categories,
//                property names and values. The LLM reads this so it uses the
//                model's own words instead of guessing. This replaces all the
//                hand-written alias lists from v1.
// It also keeps loaded models in memory so each model is downloaded only once.
// ===========================================================================

// If a property has 25 or fewer different values (Level: "Level 1", "Level 2"...)
// we list them all for the LLM. If it has more (Mark: thousands of ids)
// we only show a few examples - listing them all would make the prompt huge.
const MAX_LISTED_VALUES = 25;

// Family and type names are how people describe elements ("light gauge joists",
// "UB beams"), so the LLM needs to see all of them, not 3 samples. A model has
// far fewer families than elements, so up to 100 is still a short list.
const MAX_LISTED_NAMES = 100;
const NAME_PATHS = new Set(['Element.Family', 'Element.Type']);

// Number properties with up to this many values are listed ("8.000 mm", "12.000 mm");
// with more, only their range is shown.
const MAX_LISTED_NUMBERS = 6;

// Revit placeholders like "<By Category>" or "<not associated>" aren't real values.
const PLACEHOLDER_VALUE = /^<.*>$/;

const loadedModels = new Map();       // "urn:guid" -> finished model object
const loadingModels = new Map();      // "urn:guid" -> Promise while a download is in progress
// Per USER and model, so two people never see each other's data:
// "userId|urn:guid" -> { objectId: { elementCent: [x, y, z] } }
const coordinatesByUser = new Map();
// Keeps a per-user Map from growing forever: past this many entries the oldest goes.
const MAX_USER_ENTRIES = 500;
function remember(map, key, value) {
    map.delete(key);   // re-inserting moves the key to the end: Maps keep insertion order
    map.set(key, value);
    if (map.size > MAX_USER_ENTRIES) map.delete(map.keys().next().value);
}

// "Basic Wall [1001]" -> "Basic Wall", "M_Single-Flush" -> "Single Flush".
// Only used for nicer display names in the chat.
function cleanElementName(name = '') {
    return name
        .replace(/\[\d+\]/g, '')   // remove the "[1001]" id
        .replace(/^M_/i, '')       // remove Revit's "M_" (metric) prefix
        .replace(/[-_]+/g, ' ')    // dashes/underscores -> spaces
        .replace(/\s+/g, ' ')      // collapse double spaces
        .trim();
}

// In Revit exports, real physical elements have their id in brackets:
// "Basic Wall [1001]". Grouping nodes like "Basic Wall" (the family) don't.
// We only want real elements, otherwise families get counted as walls.
function isRealElement(name = '') {
    return /\[\d+\]/.test(name);
}

// "6000.000 mm" -> { number: 6000, unit: "mm" }. "Level 2" -> { number: null, unit: null }.
// Storing the number separately lets SQL do "length > 5000" correctly.
// (Comparing text would say "900" > "5000", because '9' > '5'.)
function parseNumber(value) {
    const match = value.match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/); // a number at the start, then optional unit text
    if (!match) {
        return { number: null, unit: null };
    }
    return { number: parseFloat(match[1]), unit: match[2].trim() || null };
}

// Walks the APS object tree once. A Revit tree looks like:
//   Structural Framing  >  Light Gauge Joists  >  LGJ 200  >  Light Gauge Joists [3524]
//   (category)             (family)               (type)      (element)
// Returns a Map: objectid -> { category, family, type }.
function readTree(tree) {
    const infoById = new Map();
    const root = tree?.data?.objects?.[0];        // the tree has one root node (the model)
    if (!root || !Array.isArray(root.objects)) {
        return infoById;
    }

    // Recursive helper. `names` is the list of node names from the category
    // down to this node, e.g. ["Structural Framing", "Light Gauge Joists", "LGJ 200", "Light Gauge Joists [3524]"].
    function walk(node, parentNames) {
        const names = [...parentNames, node.name];
        infoById.set(node.objectid, {
            category: names[0],
            // Only count a level as family/type if it sits ABOVE the element itself.
            family: names.length > 2 ? names[1] : null,
            type: names.length > 3 ? names[2] : null
        });
        for (const child of node.objects || []) {
            walk(child, names);
        }
    }

    // The root's direct children ARE the categories ("Walls", "Floors", ...).
    for (const categoryNode of root.objects) {
        walk(categoryNode, []);
    }
    return infoById;
}

// Builds the SQLite database for one model.
function buildDatabase(collection, tree) {
    const db = new Database(':memory:'); // ':memory:' = lives in RAM, gone when the server stops

    // Two tables are enough:
    //   elements   - one row per real element, with its category
    //   properties - one row per (element, property). path is "Group.Key",
    //                e.g. "Constraints.Reference Level".
    // COLLATE NOCASE makes text comparisons ignore upper/lower case, so
    // "level 2" = "Level 2", and SQLite can still use the index.
    db.exec(`
        CREATE TABLE elements (
            objectid    INTEGER PRIMARY KEY,
            external_id TEXT,  -- Revit's permanent UniqueId: the same in every viewer format
            name        TEXT,
            clean_name  TEXT,
            category    TEXT COLLATE NOCASE
        );

        CREATE TABLE properties (
            objectid      INTEGER,
            path          TEXT,
            value         TEXT COLLATE NOCASE,
            numeric_value REAL,
            unit          TEXT
        );

        -- Indexes are like a book's index: they let SQLite jump straight to
        -- matching rows instead of reading the whole table.
        CREATE INDEX idx_elements_category   ON elements(category);
        CREATE INDEX idx_properties_path_val ON properties(path, value);
        CREATE INDEX idx_properties_object   ON properties(objectid, path);
    `);

    const treeInfoById = readTree(tree);

    // "Prepared statements": SQL compiled once, run many times with different values.
    // The ?s are placeholders. Values are always passed separately, never glued into
    // the SQL text, so a value like "x'; DROP TABLE" can't break or change the query.
    const insertElement = db.prepare(
        'INSERT OR IGNORE INTO elements (objectid, external_id, name, clean_name, category) VALUES (?, ?, ?, ?, ?)'
    );
    const insertProperty = db.prepare(
        'INSERT INTO properties (objectid, path, value, numeric_value, unit) VALUES (?, ?, ?, ?, ?)'
    );

    // A transaction groups all inserts into one commit. Without it, SQLite
    // commits after every row, which is roughly 100x slower on big models.
    const insertAll = db.transaction(() => {
        for (const item of collection) {
            if (!isRealElement(item.name)) {
                continue; // skip family/type grouping nodes
            }

            const info = treeInfoById.get(item.objectid) || {};
            // `?? null` = "use null if the left side is undefined/null"
            // externalId: the page needs it to find the element in the Viewer. objectid only
            // equals the Viewer's own id (dbId) for SVF models; SVF2 numbers them differently.
            insertElement.run(item.objectid, item.externalId ?? null, item.name, cleanElementName(item.name), info.category ?? null);

            // Family and type come from the tree, not from the properties. We store them
            // as two extra properties so filtering and grouping work on them like on any
            // other property ("Element.Family = Light Gauge Joists").
            // If the tree has no family level, the element name ("Family [id]") holds it.
            const family = info.family || cleanElementName(item.name);
            if (family) {
                insertProperty.run(item.objectid, 'Element.Family', family, null, null);
            }
            if (info.type) {
                insertProperty.run(item.objectid, 'Element.Type', info.type, null, null);
            }

            // item.properties looks like { "Constraints": { "Base Level": "Level 1", ... }, ... }
            for (const [group, fields] of Object.entries(item.properties || {})) {
                if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
                    continue; // only plain { key: value } groups are expected here
                }
                for (const [key, raw] of Object.entries(fields)) {
                    const value = (typeof raw === 'object' ? JSON.stringify(raw) : String(raw ?? '')).trim();
                    if (value === '') {
                        continue; // Revit has lots of empty properties; storing them only adds noise
                    }
                    const { number, unit } = parseNumber(value);
                    insertProperty.run(item.objectid, `${group}.${key}`, value, number, unit);
                }
            }
        }
    });
    insertAll(); // nothing is written until we actually call the transaction function

    return db;
}

// Summarises what this model contains. This is what the LLM reads before
// it plans a query, and what the validator checks plans against.
function buildVocabulary(db) {
    // Real categories with element counts, biggest first.
    const categories = db.prepare(`
        SELECT category AS name, COUNT(*) AS count
        FROM elements
        WHERE category IS NOT NULL
        GROUP BY category
        ORDER BY count DESC
    `).all();

    // One row per property path with some statistics about it.
    const stats = db.prepare(`
        SELECT path,
               COUNT(DISTINCT objectid) AS coverage,       -- how many elements have it
               COUNT(DISTINCT value)    AS distinctValues, -- how many different values
               COUNT(*)                 AS total,
               COUNT(numeric_value)     AS numericCount,   -- COUNT(col) skips NULLs
               MIN(numeric_value)       AS min,
               MAX(numeric_value)       AS max
        FROM properties
        GROUP BY path
        ORDER BY coverage DESC
    `).all();

    // Which categories use each property? This matters: the "level" of a wall
    // is "Base Constraint", of a beam "Reference Level", of a floor "Level".
    // Telling the LLM "used by: Walls" lets it choose the right one.
    const usageRows = db.prepare(`
        SELECT p.path, e.category, COUNT(DISTINCT p.objectid) AS count
        FROM properties p
        JOIN elements e ON e.objectid = p.objectid
        GROUP BY p.path, e.category
        ORDER BY count DESC
    `).all();

    // path -> { "Structural Framing": 370, "Walls": 9 }  (rows arrive biggest first,
    // so the object's keys are in "most used" order too)
    const countsByPath = new Map();
    for (const row of usageRows) {
        if (!countsByPath.has(row.path)) {
            countsByPath.set(row.path, {});
        }
        countsByPath.get(row.path)[row.category ?? 'Uncategorised'] = row.count;
    }

    const topValues = db.prepare(`
        SELECT value FROM properties WHERE path = ?
        GROUP BY value ORDER BY COUNT(*) DESC LIMIT ?
    `);
    const mainUnit = db.prepare(`
        SELECT unit FROM properties WHERE path = ? AND unit IS NOT NULL
        GROUP BY unit ORDER BY COUNT(*) DESC LIMIT 1
    `);

    // Describe each property as one of three kinds:
    //   values - a short list of options (levels, materials)  -> LLM picks one exactly
    //   number - a measurement (lengths, areas)               -> LLM can use > or <
    //   text   - free text with many values (marks, comments) -> LLM uses "contains"
    const properties = stats.map(stat => {
        const countByCategory = countsByPath.get(stat.path) || {};
        const entry = {
            path: stat.path,
            coverage: stat.coverage,
            countByCategory,
            usedBy: Object.keys(countByCategory),
            isNumeric: stat.numericCount === stat.total // every value parsed as a number
        };

        const listLimit = NAME_PATHS.has(stat.path) ? MAX_LISTED_NAMES : MAX_LISTED_VALUES;
        // Numbers are shown as a range ("from 400 to 24690 mm") unless there are only a
        // handful of them (bar diameters 8 and 12 mm): a list of 14 offsets wastes tokens.
        const listIt = entry.isNumeric ? stat.distinctValues <= MAX_LISTED_NUMBERS : stat.distinctValues <= listLimit;

        if (listIt) {
            entry.kind = 'values';
            entry.values = topValues.all(stat.path, listLimit)
                .map(row => row.value)
                .filter(value => !PLACEHOLDER_VALUE.test(value)); // "<By Category>" is not a real value
        } else if (entry.isNumeric) {
            entry.kind = 'number';
            entry.min = stat.min;
            entry.max = stat.max;
            entry.unit = mainUnit.get(stat.path)?.unit ?? null;
        } else {
            entry.kind = 'text';
            entry.samples = topValues.all(stat.path, 3).map(row => row.value);
        }

        // A property with only one value ("Phase Demolished: None" on everything)
        // can't filter or group anything, so it's not worth showing to the LLM.
        entry.useful = entry.kind === 'values' ? entry.values.length >= 2
            : entry.kind === 'number' ? entry.min !== entry.max
            : true;
        return entry;
    });

    return {
        categories,
        properties,
        allPaths: new Set(stats.map(stat => stat.path)), // a Set makes "does this path exist?" checks instant
        // Paths where every value is a number ("12.000 mm"), so "equals 12" can compare numbers.
        numericPaths: new Set(stats.filter(stat => stat.numericCount === stat.total).map(stat => stat.path))
    };
}

// Returns the loaded model, downloading and indexing it the first time.
async function getModel(urn, guid) {
    const key = `${urn}:${guid}`;

    if (loadedModels.has(key)) {
        return loadedModels.get(key);   // already loaded: instant
    }
    if (loadingModels.has(key)) {
        return loadingModels.get(key);  // someone else is loading it right now: wait for them
    }

    // Same trick as the token: store the Promise so parallel requests share one download.
    const promise = (async () => {
        const { collection, tree } = await fetchModelData(urn, guid);
        const db = buildDatabase(collection, tree);

        const elementCount = db.prepare('SELECT COUNT(*) AS c FROM elements').get().c;
        if (elementCount === 0) {
            db.close();
            // Throwing means we never reach loadedModels.set below, so nothing
            // empty gets cached: the next request simply tries again.
            if (collection.length > 0) {
                // Objects arrived, but none is a "Name [id]" element: not a model we can query.
                throw new UnsupportedModelError('This model has no elements the assistant can query. It currently works with Revit models.');
            }
            throw new ModelNotReadyError('The model has no elements yet. APS may still be processing it.');
        }

        const vocabulary = buildVocabulary(db);
        const model = {
            key,
            urn,
            guid,
            db,
            vocabulary,
            dictionary: buildDictionary(db, vocabulary), // word -> model name lookup (section 2b)
            elementCount,
            loadedAt: new Date().toISOString()
        };
        loadedModels.set(key, model); // only successful loads are cached
        return model;
    })();

    loadingModels.set(key, promise);
    try {
        return await promise;
    } finally {
        loadingModels.delete(key); // done (success or failure): stop sharing this Promise
    }
}

// The Viewer knows geometry; APS properties don't. The frontend PUTs a map of
// objectId -> { elementCent: [x, y, z] } and we keep it here, per user.
function setCoordinates(userId, urn, guid, coordinates) {
    remember(coordinatesByUser, `${userId}|${urn}:${guid}`, coordinates || {});
}

// Users often quote the Revit id shown in brackets ("Pile Cap [512319]"), but the
// Viewer stores coordinates by its own object id. So we try the id as an object id
// first, then look for an element whose name ends in "[id]".
// Returns { objectId, position } or null.
function getCoordinates(model, id, userId) {
    const coordinates = coordinatesByUser.get(`${userId}|${model.key}`);
    if (!coordinates) {
        return null;
    }

    let objectId = id;
    if (!coordinates[objectId]?.elementCent) {
        const row = model.db.prepare("SELECT objectid FROM elements WHERE name LIKE '%[' || ? || ']'").get(String(id));
        objectId = row?.objectid;
    }

    const position = coordinates[objectId]?.elementCent;
    return position ? { objectId, position } : null;
}


// ===========================================================================
// 2b. DICTIONARY
// Matches the words of a question to real names in the model, in plain code
// (no LLM, 0 tokens). Built once per model when it loads.
//
//   "show me the UB beams on level 2"
//      beam      -> category  Structural Framing       (everyday word)
//      ub        -> family    UB-Universal Beams (...) (part of a family name)
//      level 2   -> value     "Level 2" of the level properties
//      show, me, the, on -> ignored (stopwords)
//
// If every word is explained, the question is "simple" (tier 0). Otherwise the
// matches become the short CANDIDATES list for the tier 1 prompt.
// ===========================================================================

// Everyday words for categories. This is the only hand-written name list: family,
// type, property and value names all come from the model itself.
const CATEGORY_WORDS = {
    // Not "girder": Revit records it as a Structural Usage value, which the dictionary
    // finds by itself. As a category word it turned "girders" into all 370 framing members.
    'Structural Framing': ['beam', 'framing'],
    'Structural Columns': ['column'],
    'Walls': ['wall'],
    'Floors': ['floor', 'slab'],
    'Structural Foundations': ['foundation', 'footing', 'pile'],
    'Structural Rebar': ['rebar', 'reinforcing bar'],
    'Structural Area Reinforcement': ['area reinforcement'],
    'Stairs': ['stair', 'staircase'],
    'Doors': ['door'],
    'Windows': ['window'],
    'Roofs': ['roof'],
    'Ceilings': ['ceiling'],
    'Railings': ['railing'],
    'Rooms': ['room'],
    'Spaces': ['space']
};

// Everyday words for properties. `null` means "all the level properties" (LEVEL_PATHS, section 4).
const PROPERTY_WORDS = {
    level: null,
    material: ['Materials and Finishes.Structural Material', 'Materials and Finishes.Material'],
    family: ['Element.Family'],
    type: ['Element.Type'],
    length: ['Dimensions.Length'],
    long: ['Dimensions.Length'],
    longer: ['Dimensions.Length'],
    short: ['Dimensions.Length'],
    shorter: ['Dimensions.Length'],
    volume: ['Dimensions.Volume'],
    area: ['Dimensions.Area'],
    usage: ['Structural.Structural Usage'],
    // Revit's steel sections carry their weight per metre as "Nominal Weight".
    weight: ['Structural Analysis.Nominal Weight'],
    weigh: ['Structural Analysis.Nominal Weight'],
    heavy: ['Structural Analysis.Nominal Weight'],
    heavier: ['Structural Analysis.Nominal Weight'],
    lighter: ['Structural Analysis.Nominal Weight'],
    tonnage: ['Structural Analysis.Nominal Weight'],
    mass: ['Structural Analysis.Nominal Weight'],
    // Sizes ("the widest", "taller than 3 m", "square footage"): only used if the model has them.
    width: ['Dimensions.Width'], wide: ['Dimensions.Width'],
    height: ['Dimensions.Height'], tall: ['Dimensions.Height'],
    thickness: ['Dimensions.Thickness'], thick: ['Dimensions.Thickness'],
    'square footage': ['Dimensions.Area'], footage: ['Dimensions.Area'], sqft: ['Dimensions.Area']
};

// The number properties ranking and totals use most.
const LENGTH_PATH = 'Dimensions.Length';
const VOLUME_PATH = 'Dimensions.Volume';
const WEIGHT_PATH = 'Structural Analysis.Nominal Weight';   // weight PER METRE (kgf/m) in Revit

// Superlatives: rank by this property, highest ("desc") or lowest ("asc") first.
// "the longest beam" = the beams tied at the greatest length.
const RANK_WORDS = {
    longest: [LENGTH_PATH, 'desc'], shortest: [LENGTH_PATH, 'asc'],
    heaviest: [WEIGHT_PATH, 'desc'], lightest: [WEIGHT_PATH, 'asc'],
    largest: [VOLUME_PATH, 'desc'], biggest: [VOLUME_PATH, 'desc'], smallest: [VOLUME_PATH, 'asc'],
    widest: ['Dimensions.Width', 'desc'], narrowest: ['Dimensions.Width', 'asc'],
    tallest: ['Dimensions.Height', 'desc'],
    thickest: ['Dimensions.Thickness', 'desc'], thinnest: ['Dimensions.Thickness', 'asc']
};

// Rank words that don't say WHICH property: "the greatest LENGTH", "the highest WIDTH".
// They rank by the property the question names. (So do "largest", "biggest", "smallest"
// when a property is named: "the door with the largest WIDTH", not the largest volume.)
const GENERIC_RANK_WORDS = { greatest: 'desc', highest: 'desc', maximum: 'desc', max: 'desc', lowest: 'asc', minimum: 'asc', min: 'asc' };
const SIZE_RANK_WORDS = new Set(['largest', 'biggest', 'smallest']);

// Words that ask to add numbers up, and which aggregate each one means.
const AGGREGATE_WORDS = { total: 'sum', sum: 'sum', overall: 'sum', combined: 'sum', together: 'sum', add: 'sum',
    average: 'average', mean: 'average' };

// Material words: when one also appears inside a family name ("M_Concrete-Square-Column"),
// people still mean the material ("concrete elements" = elements made of concrete).
const MATERIAL_TERMS = new Set(['steel', 'concrete', 'timber', 'wood', 'wooden', 'softwood', 'lumber',
    'aluminum', 'metal', 'masonry', 'brick', 'glass', 'precast', 'stud']);

// Words that make a question continue the previous one: "AND on level 3?", "ONLY the
// steel ones", "how many of THEM?". They name nothing in the model, so they are also
// stopwords (they would otherwise count as words nothing matched).
const FOLLOW_UP_WORDS = new Set(['and', 'also', 'only', 'just', 'now', 'but', 'then', 'same', 'about',
    'them', 'those', 'these', 'they', 'their', 'again', 'instead', 'too', 'ok', 'okay']);
// A follow-up usually STARTS with one of these ("and on level 3?", "except the HSS ones").
const FOLLOW_UP_OPENERS = new Set(['and', 'also', 'only', 'just', 'now', 'but', 'then', 'same',
    'except', 'excluding', 'without', 'not']);
// ...or refers back to the last answer with one of these, anywhere ("how long are THEY?").
const BACK_REFERENCES = new Set(['them', 'those', 'these', 'they', 'their']);
// Words that ask about the WHOLE model: a question with them starts afresh.
const FRESH_WORDS = new Set(['everything', 'anything', 'all', 'element', 'model']);

// Words that turn a question around ("NOT on level 2", "EXCEPT the HSS ones"). Code
// can't express those, so such questions skip tier 0 and go to the LLM, which can.
// They're also kept from matching values like Section Shape "Not Defined".
const NEGATION_WORDS = new Set(['not', 'except', 'excluding', 'exclude', 'without', 'isn', 'aren', 'don', 'doesn', 'non']);

// Everyday words for values, used ONLY when the model lacks the word itself:
// "external walls" -> "Exterior" (Revit's Function value). ("inside" is left out: it is
// more often a place, "columns inside the core", than a value.)
const VALUE_SYNONYMS = { external: 'exterior', outside: 'exterior', internal: 'interior' };

// Numbers written as words, after a level word: "level two" -> "level 2".
// Ordinals before one: "second level", "2nd floor" -> "level 2".
const NUMBER_WORDS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
    nine: '9', ten: '10', eleven: '11', twelve: '12' };
const ORDINAL_WORDS = { first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6', seventh: '7',
    eighth: '8', ninth: '9', tenth: '10' };
const LEVEL_NOUNS = new Set(['level', 'story', 'floor']);

// British / American spellings, so "aluminium" finds "Aluminum".
const WORD_VARIANTS = { aluminium: 'aluminum', colour: 'color', grey: 'gray', centre: 'center', storey: 'story' };

// Everyday material words. Each looks for these words inside material and family names
// instead ("wooden" finds "Softwood, Lumber"; "timber" also finds the "...(Timber)-Beam" family).
const MATERIAL_WORDS = {
    wood: ['softwood', 'lumber'],
    wooden: ['softwood', 'lumber'],
    timber: ['timber', 'softwood', 'lumber']
};

// Words a question may contain that no model name will ever match, and that a plan
// expresses without repeating them: numbers, units, comparisons, sorting, "or".
// Any OTHER unmatched word that the plan ignores means the answer leaves something out.
const UNMATCHED_OK = new Set([
    'mm', 'cm', 'm', 'meter', 'metre', 'km', 'kg', 'kgf', 'ton', 'tonne', 'sq', 'square', 'cubic', 'unit',
    'than', 'more', 'less', 'over', 'under', 'above', 'below', 'between', 'greater', 'smaller', 'larger',
    'bigger', 'shorter', 'wider', 'deeper', 'taller', 'exactly', 'about', 'around', 'approximately', 'equal',
    'or', 'only', 'just', 'also', 'start', 'starting', 'end', 'ending', 'begin', 'sit', 'located', 'placed',
    'break', 'down', 'split', 'sort', 'sorted', 'order', 'ordered', 'first', 'last', 'them', 'they', 'where',
    'other', 'no', 'there', 'available', 'exist', 'existing'
]);

// Words that carry no meaning for the query. Intent words (show, how many, per)
// are here too: the tier 0 prompt reads the intent from the full question.
const STOPWORDS = new Set([
    'a', 'an', 'the', 'me', 'my', 'i', 'you', 'we', 'us', 'please', 'can', 'could', 'would',
    'show', 'list', 'find', 'get', 'give', 'display', 'select', 'highlight', 'see',
    'how', 'many', 'much', 'what', 'which', 'is', 'are', 'was', 'were', 'be', 'there', 'here',
    'do', 'does', 'did', 'have', 'has', 'had', 'of', 'on', 'in', 'at', 'to', 'for', 'from',
    'with', 'by', 'per', 'each', 'every', 'all', 'any', 'some', 'and', 'that', 'this', 'those',
    'these', 'it', 'its', 'element', 'item', 'object', 'thing', 'model', 'number', 'count',
    'total', 'most', 'least', 'used', 'use', 'made', 'kind', 'kinds', 'group', 'grouped', 'breakdown',
    'member', 'members', 'one', 'ones', 'everything', 'anything', 'something',
    'sum', 'average', 'mean', 'overall', 'combined', 'top', 'value', 'values', 'break', 'down', 'split',
    // filler that names nothing: "columns LOCATED on level 1", "PLS show", "I NEED the beams",
    // "how are the beams DISTRIBUTED ACROSS the levels", "ADD UP the lengths", "all of them TOGETHER"
    'located', 'placed', 'situated', 'sitting', 'exist', 'exists', 'existing', 'available', 'pls', 'plz', 'kindly',
    'need', 'want', 'distributed', 'distribution', 'across', 'spread', 'add', 'up', 'together',
    ...NEGATION_WORDS, ...FOLLOW_UP_WORDS
]);

// Single-word values that are also ordinary English ("Other", "None", "Top").
// Matching those would turn "the other beams" into a filter, so they're skipped.
const VAGUE_VALUES = new Set(['other', 'yes', 'no', 'none', 'top', 'bottom', 'center', 'centre', 'left',
    'right', 'standard', 'single', 'origin', 'uniform', 'new', 'main', 'part', 'not']);

// "beams" -> "beam", "families" -> "family". Rough, but applied the same way to the
// question AND to the model's names, so both sides end up with the same form.
function singular(word) {
    if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
}

// "Light Gauge-Joists" -> ["light", "gauge", "joist"]. Anything that isn't a letter
// or digit becomes a space, so "-", "_", "(" and ")" don't matter.
function toWords(text) {
    const words = String(text).toLowerCase()
        .replace(/['’]s\b/g, '')          // "what's" -> "what", "beam's" -> "beam" (a lone "s" matched marks like "S-3.3")
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean)
        .map(word => WORD_VARIANTS[word] || word)
        .map(word => (STOPWORDS.has(word) ? word : singular(word)));
    // "level two" -> "level 2"; "second level" / "2nd floor" -> "level 2".
    for (let i = 0; i < words.length; i++) {
        const ordinal = ORDINAL_WORDS[words[i]] || (words[i].match(/^(\d+)(st|nd|rd|th)$/) || [])[1];
        if (ordinal && LEVEL_NOUNS.has(words[i + 1])) {
            words[i] = 'level';
            words[i + 1] = ordinal;
        } else if (LEVEL_NOUNS.has(words[i]) && NUMBER_WORDS[words[i + 1]]) {
            words[i + 1] = NUMBER_WORDS[words[i + 1]];
            if (words[i] === 'story') words[i] = 'level';
        }
    }
    return words;
}

// How many single-letter edits turn `a` into `b`: add, remove, change a letter, or swap
// two neighbouring letters ("widnow" -> "window" is ONE swap, the most common typo).
// (Levenshtein distance plus swaps: "optimal string alignment".)
function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);   // the swap
            }
        }
    }
    return d[a.length][b.length];
}

// Builds the lookup tables for one model.
function buildDictionary(db, vocabulary) {
    const phrases = new Map();  // "light gauge joist" -> [entries]   (exact matches)
    const partials = [];        // names that can also match by some of their words ("ub")
    const genericWords = new Set(); // category words: too vague to match a family on their own

    function addPhrase(words, entry) {
        if (words.length === 0) return;
        const key = words.join(' ');
        if (!phrases.has(key)) phrases.set(key, []);
        phrases.get(key).push(entry);
    }

    // Categories: their own names plus the everyday words.
    const present = new Set(vocabulary.categories.map(c => c.name));
    for (const name of present) {
        addPhrase(toWords(name), { kind: 'category', category: name });
    }
    for (const [name, words] of Object.entries(CATEGORY_WORDS)) {
        for (const word of words) {
            const parts = toWords(word);
            parts.forEach(part => genericWords.add(part));
            // A known word for a category this model doesn't have ("ceilings") is
            // remembered too, so we can say "no such category" instead of guessing.
            addPhrase(parts, present.has(name) ? { kind: 'category', category: name } : { kind: 'missing-category', category: name });
        }
    }
    addPhrase(['category'], { kind: 'group-by-category' });

    // Properties: by their label ("Bar Diameter") and by the everyday words above.
    const visible = vocabulary.properties.filter(p => !HIDDEN_FROM_PROMPT.has(p.path));
    for (const property of visible) {
        const entry = { kind: 'property', paths: [property.path] };
        addPhrase(toWords(label(property.path)), entry);
        partials.push({ words: new Set(toWords(label(property.path))), entry });
    }
    for (const [word, paths] of Object.entries(PROPERTY_WORDS)) {
        const existing = (paths || LEVEL_PATHS).filter(path => vocabulary.allPaths.has(path));
        if (existing.length > 0) {
            addPhrase(toWords(word), { kind: 'property', paths: existing });
        }
    }

    // Values of short-list text properties (levels, materials, usage) and all
    // family / type names, each with the categories that use it.
    // Family and type names are ALWAYS included, however many there are: the 100-name
    // limit (MAX_LISTED_NAMES) keeps the PROMPT small, but matching in code costs nothing.
    // (Seaport has 154 families: with the limit, "chairs" and "precast stairs" found none.)
    const listedPaths = visible
        .filter(p => (p.kind === 'values' && !p.isNumeric) || NAME_PATHS.has(p.path))
        .map(p => p.path);
    const rows = listedPaths.length === 0 ? [] : db.prepare(`
        SELECT p.path, p.value, e.category
        FROM properties p JOIN elements e ON e.objectid = p.objectid
        WHERE p.path IN (${listedPaths.map(() => '?').join(', ')})
        GROUP BY p.path, p.value, e.category
    `).all(...listedPaths);

    const values = new Map(); // "path|value" -> entry
    for (const row of rows) {
        const key = `${row.path}|${row.value}`;
        if (!values.has(key)) {
            values.set(key, { kind: 'value', path: row.path, value: row.value, categories: new Set() });
        }
        values.get(key).categories.add(row.category);
    }
    for (const entry of values.values()) {
        const words = toWords(entry.value);
        if (PLACEHOLDER_VALUE.test(entry.value) || (words.length === 1 && VAGUE_VALUES.has(words[0]))) {
            continue;
        }
        addPhrase(words, entry);
        partials.push({ words: new Set(words), entry });
    }

    // Every word the model's names use, for typo correction ("colums" -> "column").
    const knownWords = new Set();
    for (const key of phrases.keys()) key.split(' ').forEach(word => knownWords.add(word));
    for (const item of partials) item.words.forEach(word => knownWords.add(word));
    Object.keys(PROPERTY_WORDS).concat(Object.keys(MATERIAL_WORDS)).forEach(word => knownWords.add(word));

    // path -> its value entries, so tier 1 can show only the values a category really uses.
    const valuesByPath = new Map();
    for (const entry of values.values()) {
        if (!valuesByPath.has(entry.path)) valuesByPath.set(entry.path, []);
        valuesByPath.get(entry.path).push(entry);
    }

    // The unit each size property is stored in ("mm" here, "ft" in an imperial model),
    // so "longer than 6 m" can be converted in code (see parseComparisons).
    const units = new Map();
    for (const path of COMPARISON_PATHS.filter(p => vocabulary.allPaths.has(p))) {
        const row = db.prepare('SELECT unit FROM properties WHERE path = ? AND unit IS NOT NULL GROUP BY unit ORDER BY COUNT(*) DESC LIMIT 1').get(path);
        if (row) units.set(path, row.unit);
    }

    const longest = Math.max(1, ...[...phrases.keys()].map(key => key.split(' ').length));
    return { phrases, partials, genericWords, knownWords, valuesByPath, units, longestPhrase: Math.min(longest, 8) };
}

// ---------------------------------------------------------------------------
// Comparisons with a number, read and converted in code:
//   "longer than 6 m", "over 2000 mm", "wider than 36 inches", "between 3 and 5 metres"
// The number is converted into the unit the PROPERTY uses (mm, or ft in an imperial
// model), so "doors wider than 1 m" works on a model in feet. An LLM can get that
// arithmetic wrong without anyone noticing; code gets it right every time.
// ---------------------------------------------------------------------------
const COMPARISON_PATHS = [LENGTH_PATH, 'Dimensions.Width', 'Dimensions.Height', 'Dimensions.Thickness', WEIGHT_PATH];
const COMPARATIVES = {
    longer: ['gt', LENGTH_PATH], shorter: ['lt', LENGTH_PATH],
    wider: ['gt', 'Dimensions.Width'], narrower: ['lt', 'Dimensions.Width'],
    taller: ['gt', 'Dimensions.Height'],
    thicker: ['gt', 'Dimensions.Thickness'], thinner: ['lt', 'Dimensions.Thickness'],
    heavier: ['gt', WEIGHT_PATH], lighter: ['lt', WEIGHT_PATH],
    // these say "more / less" but not of WHAT: the unit and the words around decide
    bigger: ['gt', null], larger: ['gt', null], greater: ['gt', null], more: ['gt', null], over: ['gt', null], above: ['gt', null],
    smaller: ['lt', null], less: ['lt', null], under: ['lt', null], below: ['lt', null],
    'at least': ['gte', null], 'at most': ['lte', null]
};
const UNIT_RE = '(mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|km|met(?:er|re)s?|m|ft|feet|foot|inch(?:es)?|in|kgf?\\s*/\\s*m|kgf?\\s+per\\s+(?:met(?:er|re)|m))';
const NUMBER_RE = '(-?\\d+(?:\\.\\d+)?)';
const COMPARE_RE = new RegExp(`\\b(${Object.keys(COMPARATIVES).join('|')})(?:\\s+than)?\\s+${NUMBER_RE}\\s*${UNIT_RE}(?![a-z])`, 'g');
const BETWEEN_RE = new RegExp(`\\bbetween\\s+${NUMBER_RE}\\s*${UNIT_RE}?\\s+(?:and|to)\\s+${NUMBER_RE}\\s*${UNIT_RE}(?![a-z])`, 'g');
const METRES_PER_UNIT = { mm: 0.001, cm: 0.01, m: 1, km: 1000, ft: 0.3048, in: 0.0254 };

// "millimetres" -> "mm", "feet" -> "ft", "kg per metre" -> "kg/m". Unknown -> null.
function normalUnit(unit) {
    const u = String(unit || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (/^kgf?\s*\/\s*m$/.test(u) || /^kgf? per /.test(u)) return 'kg/m';
    if (/^(mm|millimet)/.test(u)) return 'mm';
    if (/^(cm|centimet)/.test(u)) return 'cm';
    if (u === 'km') return 'km';
    if (/^(m|met)/.test(u)) return 'm';
    if (/^(ft|feet|foot)$/.test(u)) return 'ft';
    if (/^(in|inch)/.test(u)) return 'in';
    return null;
}

// 1, "m", "ft" -> 3.28084. null when the two units can't be converted.
function convertUnit(value, from, to) {
    if (!from || !to) return null;
    if (from === to) return value;
    if (from === 'kg/m' || to === 'kg/m') return null;
    if (!(from in METRES_PER_UNIT) || !(to in METRES_PER_UNIT)) return null;
    return value * METRES_PER_UNIT[from] / METRES_PER_UNIT[to];
}

// Which property "more than 6 m" is about: the comparative says it ("longer"), or the
// unit (kg/m = weight), or a size word in the question ("width greater than", "6 m long").
// Otherwise length is only a GUESS ("beams over 6 m"): returns null if the question
// names another property ("start offset ABOVE 100 mm"), and the LLM decides instead.
function comparedProperty(word, unit, text, dictionary) {
    if (word && COMPARATIVES[word]?.[1]) return COMPARATIVES[word][1];
    if (unit === 'kg/m') return WEIGHT_PATH;
    if (/\b(width|wide)\b/.test(text)) return 'Dimensions.Width';
    if (/\b(height|tall)\b/.test(text)) return 'Dimensions.Height';
    if (/\bthick/.test(text)) return 'Dimensions.Thickness';
    if (/\b(length|long)\b/.test(text)) return LENGTH_PATH;
    return namesOtherProperty(text, dictionary) ? null : LENGTH_PATH;
}

// Does the question name a property code doesn't compare by itself ("start OFFSET")?
// A word counts if it is part of property names and of no value, category or everyday word.
function namesOtherProperty(text, dictionary) {
    return toWords(text).some(word => !STOPWORDS.has(word) && !(word in PROPERTY_WORDS) &&
        !dictionary.genericWords.has(word) && !/\d/.test(word) &&
        findPartial(dictionary, [word], e => e.kind === 'property').length > 0 &&
        findPartial(dictionary, [word], e => e.kind !== 'property').length === 0);
}

// Finds the comparisons in a question. Returns { filters, text }: the number filters,
// and the question with those parts blanked out (so "6" and "m" don't count as words
// nothing matched). A comparison code can't convert is left in the text for the LLM.
function parseComparisons(question, dictionary) {
    const lower = String(question).toLowerCase();
    const filters = [];
    const filterFor = (path, op, value, unit) => {
        const propertyUnit = normalUnit(dictionary.units.get(path));
        const converted = convertUnit(value, unit, propertyUnit);
        return converted === null ? null : { paths: [path], op, value: Math.round(converted * 1e6) / 1e6 };
    };
    let text = lower.replace(BETWEEN_RE, (all, low, lowUnit, high, highUnit) => {
        const unit = normalUnit(highUnit);
        const path = comparedProperty(null, unit, lower, dictionary);
        if (!path) return all;
        const from = filterFor(path, 'gte', Number(low), normalUnit(lowUnit) || unit);
        const to = filterFor(path, 'lte', Number(high), unit);
        if (!from || !to) return all;
        filters.push(from, to);
        return ' ';
    });
    text = text.replace(COMPARE_RE, (all, word, number, unitText) => {
        const unit = normalUnit(unitText);
        const path = comparedProperty(word, unit, lower, dictionary);
        if (!path) return all;
        const filter = filterFor(path, COMPARATIVES[word][0], Number(number), unit);
        if (!filter) return all;
        filters.push(filter);
        return ' ';
    });
    return { filters, text };
}

// "colums" -> "column": a word the model never uses, one edit away from exactly one word
// it does use (two edits for long words), is treated as that word. Numbers, ignored words
// and short words are left alone, and so is anything with more than one close match.
function correctTypo(word, dictionary) {
    if (word.length < 3 || /\d/.test(word) || STOPWORDS.has(word) || UNMATCHED_OK.has(word) || dictionary.knownWords.has(word)) {
        return word;
    }
    // 3-letter words are only fixed into category words: "dors" -> (singular) "dor" -> "door".
    // Anything else that short ("ask", "way") is too likely a real word to "correct".
    if (word.length === 3) {
        const close = [...dictionary.genericWords].filter(known => known.length === 4 && editDistance(word, known) === 1);
        return close.length === 1 ? close[0] : word;
    }
    // Superlatives ("heaviest", "longest") are real words, not typos: "heaviest" is two
    // edits from "heavier", and "correcting" it turned a top-N question into a breakdown.
    if (word.length > 5 && word.endsWith('est')) {
        return word;
    }
    const allowed = word.length >= 8 ? 2 : 1;
    let best = null;
    let bestDistance = allowed + 1;
    let tie = false;
    for (const known of dictionary.knownWords) {
        if (/\d/.test(known) || Math.abs(known.length - word.length) > allowed) continue;
        const distance = editDistance(word, known);
        if (distance < bestDistance) { best = known; bestDistance = distance; tie = false; }
        else if (distance === bestDistance) tie = true;
    }
    return best && !tie ? best : word;
}

// Finds names whose words include ALL of `words` ("ub" is in "UB-Universal Beams").
// At least one word must be specific: "beam" alone would match every beam family.
// `accept` narrows the kind of entry wanted; it runs BEFORE the cut to 12, or 12
// property labels containing "chair" could crowd out the chair families.
function findPartial(dictionary, words, accept = () => true) {
    const specific = words.filter(word => !dictionary.genericWords.has(word) && !/^\d+$/.test(word));
    if (specific.length === 0) return [];
    return dictionary.partials
        .filter(item => words.every(word => item.words.has(word)) && accept(item.entry))
        .map(item => item.entry)
        .slice(0, 12);
}

// Step 1: which words of the question match which names?
// Returns { matches: [{ words, partial, entries }], unexplained: [words nothing matched] }.
function matchQuestion(question, dictionary) {
    const corrections = []; // "colums -> column", shown in the response for transparency
    const compared = parseComparisons(question, dictionary);   // "longer than 6 m" -> a number filter
    const words = toWords(compared.text).map(word => {
        // "external" -> "exterior", only when the model has "exterior" and not "external"
        const synonym = VALUE_SYNONYMS[word];
        if (synonym && !dictionary.knownWords.has(word) && dictionary.knownWords.has(synonym)) {
            corrections.push(`${word} -> ${synonym}`);
            return synonym;
        }
        const fixed = correctTypo(word, dictionary);
        if (fixed !== word) corrections.push(`${word} -> ${fixed}`);
        return fixed;
    });
    const negated = words.some(word => NEGATION_WORDS.has(word));

    // Ranking: "the 3 longest beams", "top 5 heaviest columns" -> { path, order, limit }.
    // The rank word and its number are replaced by "the" (a stopword): code has
    // understood them, so they mustn't count as words nothing matched.
    let rank = null;
    // ("the highest NUMBER of beams" / "how MANY" is about counts, not a ranking.)
    const aboutCounts = words.includes('number') || words.includes('many');
    words.forEach((word, i) => {
        if (rank || !(RANK_WORDS[word] || (GENERIC_RANK_WORDS[word] && !aboutCounts))) return;
        const [path, order] = RANK_WORDS[word] || [null, GENERIC_RANK_WORDS[word]];
        // flexible: ranks by the property the question names, if it names one
        rank = { word, path, order, limit: null, flexible: !RANK_WORDS[word] || SIZE_RANK_WORDS.has(word) };
        words[i] = 'the';
        // The number right before ("3 longest") or right after "top" ("top 3 longest").
        const numberAt = [i - 1, words.indexOf('top') + 1].find(j => j >= 0 && /^\d+$/.test(words[j] || ''));
        if (numberAt !== undefined) {
            rank.limit = Number(words[numberAt]);
            words[numberAt] = 'the';
        }
    });

    // Adding up: "total length", "average volume", "how much do they weigh", "tonnage".
    // (Only a real total if a measure such as length or volume is named too: see planRankOrTotal.)
    let aggregate = AGGREGATE_WORDS[words.find(word => AGGREGATE_WORDS[word])] || null;
    // ("how MANY beams weigh more than 50 kg/m" is a count, so it needs "much" or "how heavy".)
    const weightWord = words.some(word => ['weight', 'weigh', 'heavy', 'mass'].includes(word));
    const howHeavy = words.some((word, i) => word === 'how' && words[i + 1] === 'heavy');
    if (!aggregate && (words.includes('tonnage') || howHeavy || (weightWord && words.includes('much')))) {
        aggregate = 'sum';
    }

    const matches = [];
    const leftover = []; // runs of words that didn't match a whole phrase

    // "level 2" in a model whose levels are "O-Level 2", "O/G/PH/C-Level 1": the level
    // VALUES containing those words. Returns [] if there's no such value.
    const levelValues = (i) => {
        if (!['level', 'story', 'floor'].includes(words[i]) || !words[i + 1] || dictionary.phrases.has(`${words[i]} ${words[i + 1]}`)) return [];
        return findPartial(dictionary, [words[i], words[i + 1]], e => e.kind === 'value' && (LEVEL_PATHS.includes(e.path) || TOP_LEVEL_PATHS.includes(e.path)));
    };

    // Longest phrase first: "light gauge joist" before "joist".
    let run = [];
    let i = 0;
    while (i < words.length) {
        let found = false;
        const levels = levelValues(i);
        if (levels.length > 0) {
            if (run.length) leftover.push(run);
            run = [];
            matches.push({ words: `${words[i]} ${words[i + 1]}`, partial: true, entries: levels, levelName: true });
            i += 2;
            continue;
        }
        for (let n = Math.min(dictionary.longestPhrase, words.length - i); n >= 1; n--) {
            const phrase = words.slice(i, i + n).join(' ');
            // A filler word alone never matches a model name: "NUMBER of doors" was matching
            // the grid property "Number", "count ALL the doors" the value "All" (Region).
            if (n === 1 && STOPWORDS.has(phrase)) continue;
            if (dictionary.phrases.has(phrase)) {
                let entries = dictionary.phrases.get(phrase);
                // An exact match only on a minor property ("pile caps" = Assembly Description
                // "Pile Caps") must not hide the names people mean (the "Pile Cap-..." families):
                // add those partial matches too, and let name preference choose.
                // Same for a property LABEL nobody means as a property: "chairs" is the label of
                // a dining-table parameter (Construction.Chairs = 4), but people mean the chairs.
                // Everyday property words ("length", "level") are kept as properties.
                const obscureProperty = entries.some(e => e.kind === 'property') && !(phrase in PROPERTY_WORDS);
                if (obscureProperty) {
                    const isName = e => e.kind === 'value' && NAME_PATHS.has(e.path);
                    const names = [...new Set([...entries.filter(isName), ...findPartial(dictionary, words.slice(i, i + n), isName)])];
                    if (names.length > 0) entries = names;
                }
                const valuesOnly = entries.every(e => e.kind === 'value');
                if (valuesOnly && Math.min(...entries.map(e => pathPriority(e.path))) >= 5) {
                    const better = findPartial(dictionary, words.slice(i, i + n))
                        .filter(e => e.kind === 'value' && pathPriority(e.path) < 5);
                    if (better.length > 0) entries = entries.concat(better);
                }
                matches.push({ words: phrase, partial: false, entries });
                i += n;
                found = true;
                break;
            }
        }
        if (found) {
            if (run.length) leftover.push(run);
            run = [];
            continue;
        }
        if (STOPWORDS.has(words[i])) {
            if (run.length) leftover.push(run);
            run = [];
        } else {
            run.push(words[i]);
        }
        i++;
    }
    if (run.length) leftover.push(run);

    // Step 2: the leftover words, by parts of names ("ub", "steel", "diameter").
    const unexplained = [];
    for (const words of leftover) {
        let whole = findPartial(dictionary, words);
        // A material word on its own ("timber") also looks for its stand-ins ("softwood",
        // "lumber"), even when a name contains the word itself ("Rectangular(Timber)-Beam"):
        // then summarizeMatch can prefer the MATERIAL (see MATERIAL_TERMS).
        if (whole.length > 0 && words.length === 1 && MATERIAL_WORDS[words[0]]) {
            const standIns = MATERIAL_WORDS[words[0]].flatMap(w => findPartial(dictionary, [w]));
            whole = [...new Set([...whole, ...standIns])];
        }
        if (whole.length > 0) {
            matches.push({ words: words.join(' '), partial: true, entries: whole });
            continue;
        }
        for (const word of words) { // the run as a whole matched nothing: try word by word
            // Everyday material words look for their stand-ins ("wooden" -> softwood, lumber).
            const lookFor = MATERIAL_WORDS[word] || [word];
            const single = [...new Set(lookFor.flatMap(w => findPartial(dictionary, [w])))];
            if (single.length > 0) {
                matches.push({ words: word, partial: true, entries: single });
            } else {
                unexplained.push(word);
            }
        }
    }

    // withoutComparisons: the question minus "more than 20 kg per metre", for the intent
    // prompt (whose "per" read as "a breakdown per X").
    return { matches, unexplained, negated, corrections, rank, aggregate, comparisons: compared.filters,
        withoutComparisons: compared.filters.length > 0 ? compared.text.replace(/\s+/g, ' ').trim() : question };
}

// Which property a name most likely refers to, when it appears in several (lower = more likely).
function pathPriority(path) {
    if (path === 'Element.Family') return 1;
    if (path === 'Element.Type') return 2;
    if (path.startsWith('Materials and Finishes.') || path === 'Construction.Function') return 3; // "exterior walls"
    if (LEVEL_PATHS.includes(path) || TOP_LEVEL_PATHS.includes(path)) return 4;
    if (path === 'Structural.Structural Usage') return 5;
    return 9;
}

// Step 2: turn the matches into the pieces of a plan.
// categoryHint: for a follow-up that names no category ("only the UB ones"), the
// previous plan's category, so values are chosen for THAT category (the UB beams).
function summarizeMatch(match, categoryHint = null) {
    const summary = {
        categories: [],        // categories named in the question
        missingCategories: [], // categories named that this model doesn't have
        groupByCategory: false,
        valueFilters: [],      // { paths, values } e.g. Level properties = "Level 2"
        propertyMentions: [],  // properties named without a value ("which LEVEL", "what MATERIALS")
        ambiguous: false       // a word matched things we can't choose between
    };

    // Categories first: they're needed to choose between values below.
    for (const m of match.matches) {
        for (const entry of m.entries) {
            if (entry.kind === 'category' && !summary.categories.includes(entry.category)) summary.categories.push(entry.category);
            if (entry.kind === 'missing-category') summary.missingCategories.push(entry.category);
        }
    }

    for (const m of match.matches) {
        const kinds = new Set(m.entries.map(entry => entry.kind));
        if (kinds.has('category') || kinds.has('missing-category')) continue; // handled above
        if (kinds.has('group-by-category')) {
            summary.groupByCategory = true;
            continue;
        }
        if (kinds.has('property')) {
            const paths = [...new Set(m.entries.filter(e => e.kind === 'property').flatMap(e => e.paths))];
            summary.propertyMentions.push(paths);
            // "diameter" matching 5 different properties: we can't pick one in code.
            if (m.partial && paths.length > 1) summary.ambiguous = true;
            continue;
        }

        // Values. If the question names a category, keep the values used by it:
        // "UB beams" -> the UB *beam* family, not the UB *column* family.
        let entries = m.entries.filter(e => e.kind === 'value');
        const category = summary.categories.length === 1 ? summary.categories[0] : categoryHint;
        if (category) {
            const inCategory = entries.filter(e => e.categories.has(category));
            if (inCategory.length > 0) entries = inCategory;
        }
        // A word found in several properties: keep the one people most likely mean.
        // "pile caps" -> the Pile Cap families, not Assembly Description "Pile Caps";
        // "steel" -> the material, not Assembly Description "Steel Light Gauge Floor System".
        // A material word ("concrete") means the material, even where a family name also
        // contains it ("M_Concrete-Square-Column"): "concrete elements" are the ones MADE of it.
        const materials = entries.filter(e => e.path.startsWith('Materials and Finishes.'));
        if (MATERIAL_TERMS.has(m.words) && materials.length > 0) entries = materials;
        const best = Math.min(...entries.map(e => pathPriority(e.path)));
        entries = entries.filter(e => pathPriority(e.path) === best);

        // Part of a name, found in names of SEVERAL categories, and no category named:
        // "toilet" is in "Toilet-Domestic-3D" (plumbing) and in "Toilet Partition Panel"
        // (specialty equipment). Which one is meant is for tier 1 to decide, not code.
        const nameCategories = new Set(entries.filter(e => NAME_PATHS.has(e.path)).flatMap(e => [...e.categories]));
        if (m.partial && !category && nameCategories.size > 1) {
            summary.ambiguous = true;
        }
        if (m.levelName && new Set(entries.map(e => e.value)).size > 1) {
            summary.ambiguous = true;
        }
        const paths = [...new Set(entries.map(e => e.path))];
        const allLevels = paths.every(path => LEVEL_PATHS.includes(path) || TOP_LEVEL_PATHS.includes(path));
        if (paths.length > 1 && !allLevels) {
            summary.ambiguous = true; // e.g. "concrete" is both a material and a family name
        }
        summary.valueFilters.push({ paths, values: [...new Set(entries.map(e => e.value))] });
    }

    // Number filters read in code ("longer than 6 m"). The property word next to them
    // ("LENGTH greater than 6 m", "WEIGH more than 20 kg/m") is part of the comparison,
    // not a request to break the answer down by it.
    summary.numberFilters = match.comparisons || [];
    const compared = new Set(summary.numberFilters.flatMap(filter => filter.paths));
    summary.propertyMentions = summary.propertyMentions.filter(paths => !paths.some(path => compared.has(path)));
    return summary;
}

// Tier 0 only when code understood EVERYTHING: no leftover words, nothing ambiguous.
function isSimple(match, summary) {
    const found = summary.categories.length + summary.valueFilters.length + summary.numberFilters.length +
        summary.propertyMentions.length + (summary.groupByCategory ? 1 : 0);
    return found > 0 && match.unexplained.length === 0 && !summary.ambiguous && !match.negated &&
        summary.missingCategories.length === 0 && summary.categories.length <= 1;
}

// Builds the plan in code from the matches + the intent the tier 0 prompt chose.
// Returns null when the pieces don't fit that intent (then tier 1 takes over).
// The filters code found: names ("Level 2", "steel") and numbers ("longer than 6 m").
function filtersOf(summary) {
    return [
        ...summary.valueFilters.map(f => ({ properties: f.paths, op: 'equals', value: f.values })),
        ...(summary.numberFilters || []).map(f => ({ properties: f.paths, op: f.op, value: f.value }))
    ];
}

function planFromMatch(summary, action) {
    // "How many elements PER CATEGORY" or "show the MATERIALS of the columns": a count or
    // list that names something to break down by is really a grouping.
    if (summary.groupByCategory || summary.propertyMentions.length > 0) {
        action = 'group';
    }

    const plan = {
        action,
        category: summary.categories[0] || null,
        filters: filtersOf(summary),
        groupBy: null
    };

    if (action === 'group') {
        if (summary.groupByCategory) {
            plan.groupBy = 'category';
        } else if (summary.propertyMentions.length === 1) {
            plan.groupBy = summary.propertyMentions[0];
        } else {
            return null; // group by what? Let tier 1 decide.
        }
    }
    return plan;
}

// Properties that can be added up or ranked.
const MEASURE_PATHS = new Set([LENGTH_PATH, VOLUME_PATH, 'Dimensions.Area', WEIGHT_PATH]);
const isMeasure = paths => paths.length > 0 && paths.every(path => MEASURE_PATHS.has(path));

// Does the question ask to add up a measure ("total LENGTH", "how much do they WEIGH")?
// "Total number of beams" names no measure, so it stays a count.
function wantsTotal(match, summary) {
    return Boolean(match.aggregate) && summary.propertyMentions.some(isMeasure);
}

// Ranking and totals, built in code with NO LLM call: the words already say everything.
//   "the longest beam"              -> { action: "rank", sortBy: [Length], order: "desc", limit: null }
//   "total length of steel beams"   -> { action: "total", measure: [Length], aggregate: "sum" }
//   "total volume per level"        -> ... groupBy: [the level properties]
// Returns null when the pieces don't fit (e.g. two "per ..." words): then tier 1 decides.
function planRankOrTotal(summary, match, base = null) {
    base = base || {
        category: summary.categories[0] || null,
        filters: filtersOf(summary)
    };

    if (wantsTotal(match, summary)) {
        const measureAt = summary.propertyMentions.findIndex(isMeasure);
        const measure = summary.propertyMentions[measureAt];
        const others = summary.propertyMentions.filter((_, i) => i !== measureAt); // "per LEVEL"
        if (others.length + (summary.groupByCategory ? 1 : 0) > 1) return null;
        return {
            action: 'total', ...base,
            // Weight isn't stored per element, only per metre: "weight" = Nominal Weight x Length.
            measure: measure.includes(WEIGHT_PATH) ? 'weight' : measure,
            aggregate: match.aggregate,
            groupBy: summary.groupByCategory ? 'category' : (others[0] || null)
        };
    }

    if (match.rank) {
        // "the door with the largest WIDTH", "the greatest LENGTH": rank by the named property.
        let sortBy = match.rank.path ? [match.rank.path] : null;
        let others = summary.propertyMentions;
        if (match.rank.flexible && others.length === 1) {
            sortBy = others[0];
            others = [];
        } else if (sortBy) {
            // "the longest beam by length" is fine; "the longest beam per level" is for tier 1.
            others = others.filter(paths => !paths.includes(sortBy[0]));
        }
        if (!sortBy || others.length > 0 || summary.groupByCategory) return null;
        return { action: 'rank', ...base, sortBy, order: match.rank.order, limit: match.rank.limit };
    }
    return null;
}


// ---------------------------------------------------------------------------
// Follow-up questions: "steel beams on level 2" -> "and on level 3?" -> "how many?"
// The route remembers the last plan that ran (per user, model and sheet). A follow-up
// is merged into it instead of being answered from scratch.
// ---------------------------------------------------------------------------

// Did code understand every word? (Then it can merge the plans itself, 0 tokens.)
function understoodByCode(match, summary) {
    return match.unexplained.length === 0 && !match.negated && !summary.ambiguous &&
        summary.missingCategories.length === 0 && summary.categories.length <= 1;
}

// Is this question a follow-up of the previous one?
//   - it starts with "and", "only", "what about", "except", ...  -> yes
//   - it refers back with "them", "those", "they", ...           -> yes
//   - "which ONES are steel?" (no category named)              -> yes
//   - a FRAGMENT code fully understood, with no category: no question word of its own
//     ("on level 3?", "the longest?"), or nothing but one ("how many?") -> yes
// A full question ("show me the light gauge joists") is a new question, even without
// a category: treating it as a follow-up mixed it with the previous answer's filters.
function isFollowUp(question, match, summary) {
    const words = toWords(question);
    if (FOLLOW_UP_OPENERS.has(words[0])) return true;
    if ((words[0] === 'what' || words[0] === 'how') && words[1] === 'about') return true;
    if (words.some(word => BACK_REFERENCES.has(word))) return true;
    const noCategory = summary.categories.length === 0 && !summary.groupByCategory;
    if (noCategory && words.some(word => word === 'one' || word === 'ones')) return true;

    if (!understoodByCode(match, summary) || !noCategory || words.some(word => FRESH_WORDS.has(word))) return false;
    const named = summary.valueFilters.length + summary.propertyMentions.length + (match.rank || match.aggregate ? 1 : 0);
    const asksSomething = words.some(word => QUESTION_WORDS.has(word));
    return !asksSomething || named === 0;
}
// Words that start a full question of its own.
const QUESTION_WORDS = new Set(['show', 'list', 'find', 'get', 'give', 'display', 'select', 'highlight', 'see',
    'how', 'what', 'which', 'where', 'count']);

// Do two filters test the same property? All level properties count as one
// ("on level 3" replaces "on level 2"), and so do the two material properties.
const isLevelPath = path => LEVEL_PATHS.includes(path) || TOP_LEVEL_PATHS.includes(path);
const isMaterialPath = path => path.startsWith('Materials and Finishes.');
function sameProperty(a, b) {
    return a.some(path => b.includes(path)) ||
        (a.some(isLevelPath) && b.some(isLevelPath)) ||
        (a.some(isMaterialPath) && b.some(isMaterialPath));
}

const LIST_WORDS = new Set(['show', 'list', 'which', 'find', 'highlight', 'display', 'select', 'see']);

// Merges a follow-up into the previous plan, in code. Returns the new plan, or null
// when code can't tell what to change (then tier 1 gets both questions).
//   a new category   replaces the old one        ("and the columns?")
//   a new value      replaces a filter on the same property, or is added
//                                                ("and on level 3?", "only the UB ones")
//   rank / total words, "how many", "show", "per X" change the action
//   nothing about the action keeps it            ("and on level 3?" after a total = a total)
function mergeFollowUp(previous, summary, match, question) {
    const words = new Set(toWords(question));
    let category = previous.category ?? null;
    if (summary.categories.length === 1) category = summary.categories[0];

    let filters = (Array.isArray(previous.filters) ? previous.filters : []).map(filter => ({ ...filter }));
    for (const added of filtersOf(summary)) {
        filters = filters.filter(old => !sameProperty(toArray(old.properties ?? old.property), added.properties));
        filters.push(added);
    }
    const base = { category, filters };

    // "the longest?", "and the total length?"
    if (wantsTotal(match, summary) || match.rank) {
        return planRankOrTotal(summary, match, base);
    }
    // "per level?" / "and their materials?": break the same set down by that property.
    if (summary.propertyMentions.length > 1) return null;
    const mention = summary.propertyMentions[0];
    if (mention) {
        return previous.action === 'total'
            ? { ...previous, ...base, groupBy: mention }   // a total per level
            : { action: 'group', ...base, groupBy: mention };
    }
    if ((words.has('how') && words.has('many')) || words.has('count') || words.has('number')) {
        return { action: 'count', ...base, groupBy: null };
    }
    if ([...words].some(word => LIST_WORDS.has(word))) {
        return { action: 'list', ...base, groupBy: null };
    }
    // Only the filters changed: same kind of answer as before.
    return { ...previous, ...base };
}

// The previous question and plan, as text for the LLM (tiers 1 and 2).
function describePrevious(previous) {
    return `PREVIOUS QUESTION: ${previous.question}\nPREVIOUS PLAN: ${JSON.stringify(previous.plan)}\n` +
        'This question follows on from it: start from the previous plan and change only what this question changes.';
}


// ===========================================================================
// 3. PLANNER
// The ONLY place the LLM is used. Its job is small and specific: read the
// question + the model's vocabulary, and write a JSON "query plan".
// It never sees element lists and never writes SQL.
// v1 had two LLM paths (classifier + agent loop). v2 has one call per question.
// ===========================================================================

const openai = new OpenAI({ apiKey: OPENAIKEY });
// gpt-6-luna replaces gpt-4o-mini, which OpenAI shuts down on 14 Jan 2027.
// It's OpenAI's most efficient model for short, high-volume tasks like ours.
const PLANNER_MODEL = 'gpt-6-luna';

// The vocabulary is sent with EVERY question, so it decides the cost per question.
// Which properties go in:
//   1. ALWAYS_IN_PROMPT - the ones people ask about most (if the model has them)
//   2. the top PER_CATEGORY properties of each category, so small categories
//      (30 columns) aren't crowded out by big ones (346 rebar)
//   3. never more than MAX_PROMPT_PROPERTIES in total
// Everything left out still WORKS in a query; the LLM just isn't told about it.
const MAX_PROMPT_PROPERTIES = 60;
const PER_CATEGORY = 6;
const ALWAYS_IN_PROMPT = [
    'Element.Family', 'Element.Type',
    'Constraints.Level', 'Constraints.Base Level', 'Constraints.Reference Level', 'Constraints.Base Constraint',
    'Materials and Finishes.Structural Material', 'Materials and Finishes.Material',
    'Structural.Structural Usage', 'Dimensions.Length', 'Dimensions.Volume'
];
// Duplicates of Element.Family / Element.Type / the category: showing them twice only costs tokens.
const HIDDEN_FROM_PROMPT = new Set([
    'Identity Data.Type Name', 'Identity Data.Family Name', 'Identity Data.Family and Type',
    'Identity Data.Category', 'Other.Family and Type', 'Other.Category', 'Other.Family'
]);

// Picks which properties to describe, in the order explained above.
function choosePromptProperties(vocabulary) {
    const candidates = vocabulary.properties.filter(p => p.useful && !HIDDEN_FROM_PROMPT.has(p.path));
    const byPath = new Map(candidates.map(p => [p.path, p]));
    const chosen = new Set(ALWAYS_IN_PROMPT.filter(path => byPath.has(path)));

    for (const category of vocabulary.categories) {
        // This category's properties, most used by this category first.
        // (sort keeps the original coverage order for ties)
        const forCategory = candidates
            .filter(p => p.countByCategory[category.name])
            .sort((a, b) => b.countByCategory[category.name] - a.countByCategory[category.name]);
        let added = 0;
        for (const property of forCategory) {
            if (added >= PER_CATEGORY) break;
            if (!chosen.has(property.path)) {
                chosen.add(property.path);
                added++;
            }
        }
    }

    return [...chosen].slice(0, MAX_PROMPT_PROPERTIES).map(path => byPath.get(path));
}

// "[used by: Structural Framing, Walls, Floors +2 more]"
function describeUsedBy(categories) {
    const shown = categories.slice(0, 3).join(', ');
    return categories.length > 3 ? `[used by: ${shown} +${categories.length - 3} more]` : `[used by: ${shown}]`;
}

// Our own error type, so the route can answer "the AI gave a bad answer" (502)
// instead of a generic 500.
class PlannerError extends Error {}

// One property as one short line, e.g.
//   - Constraints.Reference Level [used by: Structural Framing] values: "Level 1", "Level 2"
// `onlyValues` shows just some of the values (tier 1 shows only the matched family names).
function describeProperty(property, onlyValues = null) {
    const usedBy = describeUsedBy(property.usedBy);
    // JSON.stringify adds quotes, so the LLM sees exactly where a value starts and ends.
    if (property.kind === 'values') {
        const numberNote = property.isNumeric ? ' (numeric)' : '';
        const values = onlyValues || property.values;
        return `- ${property.path} ${usedBy} values${numberNote}: ${values.map(v => JSON.stringify(v)).join(', ')}`;
    }
    if (property.kind === 'number') {
        return `- ${property.path} ${usedBy} numbers from ${property.min} to ${property.max}${property.unit ? ' ' + property.unit : ''}`;
    }
    if (onlyValues) {   // names that matched the question, from a property with too many to list
        return `- ${property.path} ${usedBy} matching values: ${onlyValues.map(v => JSON.stringify(v)).join(', ')}`;
    }
    return `- ${property.path} ${usedBy} free text, e.g. ${property.samples.map(v => JSON.stringify(v)).join(', ')}`;
}

// The whole vocabulary as text, for the tier 2 prompt.
function describeVocabulary(vocabulary) {
    const categoryLines = vocabulary.categories
        .map(category => `- ${category.name} (${category.count})`);
    const propertyLines = choosePromptProperties(vocabulary).map(property => describeProperty(property));

    return `CATEGORIES (name and element count):\n${categoryLines.join('\n')}\n\n` +
           `PROPERTIES (path, which categories use it, and its values):\n${propertyLines.join('\n')}`;
}

// The full instruction text. It's identical for every question about the same
// model, so we build it once per model (see planQuery). OpenAI also caches
// long identical prompt beginnings automatically, which makes repeat calls cheaper.
function buildSystemPrompt(vocabulary) {
    return `You turn questions about one BIM model into a JSON query plan.
Use ONLY the categories and property paths listed under MODEL below. Never invent names.

Return ONLY a JSON object with these fields:
{
  "action": "list" | "count" | "group" | "rank" | "total" | "coordinates" | "clarify" | "reply",
  "category": exact category name, or null for all categories,
  "filters": [ { "properties": [exact paths], "op": "equals" | "not_equals" | "contains" | "gt" | "gte" | "lt" | "lte", "value": text, number, or a list of texts for equals / not_equals } ],
  "groupBy": [exact paths] or "category" or null,
  "sortBy": [one number path] or null, "order": "desc" | "asc", "limit": number or null,
  "measure": [one number path] or "weight" or null, "aggregate": "sum" | "average" | "min" | "max",
  "elementId": number or null,
  "message": text or null
}

How to choose:
- "list": show / find / which elements. "count": how many. "group": breakdowns such as
  "which level has the most beams", "what materials are used", "count by type".
- "rank": longest / heaviest / largest / top N. sortBy = the number property, order "desc" for
  the highest first. limit = N for "top N", null for "the longest" (all tied elements are returned).
- "total": total / sum / average of a quantity (length, volume, area). measure = that number
  property, or "weight" for total weight or tonnage (computed as Nominal Weight x Length).
  groupBy is optional ("total volume per level"). "Total number of beams" is a count, not a total.
- "coordinates": where a specific element id is. Put the id in elementId.
- If the message has PREVIOUS QUESTION and PREVIOUS PLAN, the question is a follow-up: start from
  the previous plan and change only what the question changes.
- "clarify": the question mentions something this model does not have, or is ambiguous.
  Put a short question for the user in message, naming the closest real options.
- "reply": questions about you or not about the model. Put the answer in message.

Rules:
- Map everyday words to the real category: "beams" -> "Structural Framing", "columns" -> "Structural Columns".
- Element.Family and Element.Type hold the Revit family and type names. When the user names a kind
  of element ("light gauge joists", "UB beams", "CHS"), filter on Element.Family with the matching
  listed name(s).
- Levels: use any one level property (e.g. "Constraints.Reference Level"). The system adds the
  level properties of the other categories automatically.
- The same idea can be stored under different paths for different categories. Check "used by" and
  put every relevant path in "properties". An element matches if any of them matches.
- If a property lists its values, use op "equals" with exact listed value(s).
- For free text (e.g. a material name like "steel" inside "Steel ASTM A992"), use op "contains".
- For numbers use gt/gte/lt/lte with a plain number in the property's unit. kg/m and kgf/m are
  the same unit for weight per metre.
- Several conditions = several entries in "filters" (they are combined with AND).
- Within one property, "X or Y" is one filter with a list of values.
- Use the fewest filters that answer the question. Never add a condition the user did not ask for.
- Set "category" only when the question names a kind of element (beams, columns, walls, ...).
  For "members", "elements", "items" or "everything", use null.
- If the question asks for something this model doesn't have, use "clarify". Never answer while
  leaving out a word that says what the user wants.

Examples:
"steel beams" ->
{"action":"list","category":"Structural Framing","filters":[{"properties":["Materials and Finishes.Structural Material"],"op":"contains","value":"steel"}],"groupBy":null,"elementId":null,"message":null}
"what materials are used for the walls" ->
{"action":"group","category":"Walls","filters":[],"groupBy":["Materials and Finishes.Structural Material"],"elementId":null,"message":null}
"how many elements per category" ->
{"action":"group","category":null,"filters":[],"groupBy":"category","elementId":null,"message":null}
"the 5 longest walls" ->
{"action":"rank","category":"Walls","filters":[],"sortBy":["Dimensions.Length"],"order":"desc","limit":5,"elementId":null,"message":null}
"total volume of the floors per level" ->
{"action":"total","category":"Floors","filters":[],"measure":["Dimensions.Volume"],"aggregate":"sum","groupBy":["Constraints.Level"],"elementId":null,"message":null}

MODEL
${describeVocabulary(vocabulary)}`;
}

// One LLM call that must answer with JSON. Returns { json, usage }.
// The answer is NOT trusted yet: validatePlan checks every plan before it runs.
async function askForJson(systemPrompt, userMessage) {
    const completion = await openai.chat.completions.create({
        model: PLANNER_MODEL,
        // Luna can "think" before answering (reasoning), which adds hidden tokens and delay.
        // Writing a small JSON plan doesn't need it, so it's switched off. That also keeps
        // `temperature` allowed: OpenAI only accepts it while reasoning is off.
        reasoning_effort: 'none',
        temperature: 0,                            // 0 = as repeatable as possible; same question -> same plan
        response_format: { type: 'json_object' },  // forces the reply to be JSON (it can still be the WRONG JSON)
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ]
    });

    const usage = {
        promptTokens: completion.usage?.prompt_tokens || 0,
        // The part of promptTokens OpenAI re-used from its cache (same prompt start as an
        // earlier call). Cached tokens are billed at a discount, so this is the cheap part.
        // OpenAI only caches prompts of 1,024+ tokens, so tiers 0 and 1 will show 0 here.
        cachedTokens: completion.usage?.prompt_tokens_details?.cached_tokens || 0,
        completionTokens: completion.usage?.completion_tokens || 0,
        totalTokens: completion.usage?.total_tokens || 0
    };

    try {
        return { json: JSON.parse(completion.choices[0].message.content), usage };
    } catch {
        throw new PlannerError('The language model returned invalid JSON.');
    }
}

// --- Tier 0: code found every name; the LLM only says WHAT to do with them.
const INTENT_PROMPT = `Classify a question about a BIM model. Return ONLY JSON: {"action": "list" | "count" | "group" | "other"}
list: show / find / which elements. count: how many, number of.
group: a breakdown by something, e.g. "per level", "which level has the most", "what materials are used".
other: anything else.`;

async function classifyIntent(question) {
    const { json, usage } = await askForJson(INTENT_PROMPT, question);
    const action = ['list', 'count', 'group'].includes(json.action) ? json.action : 'other';
    return { action, usage };
}

// --- Tier 1: the LLM writes the plan, but only sees the names that matched the question.
const CANDIDATES_PROMPT = `You turn a question about a BIM model into a JSON query plan.
The user message has the QUESTION and the CANDIDATES: the names in this model that match it. Use only those names.

Return ONLY JSON:
{"action": "list" | "count" | "group" | "rank" | "total" | "coordinates" | "clarify" | "reply" | "need_more",
 "category": category name or null,
 "filters": [{"properties": [paths], "op": "equals" | "not_equals" | "contains" | "gt" | "gte" | "lt" | "lte", "value": text, number or list of texts}],
 "groupBy": [paths] or "category" or null,
 "sortBy": [one number path] or null, "order": "desc" | "asc", "limit": number or null,
 "measure": [one number path] or "weight" or null, "aggregate": "sum" | "average" | "min" | "max",
 "elementId": number or null,
 "message": text or null}

- list: show / find. count: how many. group: a breakdown (per X, which X has the most, what X are used).
- rank: longest / heaviest / top N, by sortBy (desc = highest first; limit null = all tied at the top).
- total: total / average of a length, volume or area (measure), or "weight" for total weight.
  groupBy optional. "Total number of X" is a count.
- coordinates: where one element is; put its id in elementId.
- PREVIOUS QUESTION / PREVIOUS PLAN given: this is a follow-up. Start from the previous plan and
  change only what the question changes (a new level replaces the level filter, "only X" adds a
  filter, "how many" changes the action, a new category replaces the category).
- kg/m and kgf/m are the same unit for weight per metre.
- equals: exact listed value(s). contains: part of a text. gt/gte/lt/lte: a plain number in the
  property's unit (6 m = 6000 when the unit is mm).
- Several filters are combined with AND. Use the fewest filters; never add one the user didn't ask for.
- Within one property, "X or Y" is one filter with a list of values.
- category: only when the question names a kind of element (beams, columns, walls, ...). For
  "members", "elements", "items" or "everything", use null.
- Never answer without part of the question. If a word under "words not found in this model" says
  WHAT the user wants (a kind of element, a material, a name), use need_more; don't drop it.
- reply: questions about you, not the model (answer in message).
- clarify: the question is ambiguous (a short question in message).
- need_more: the CANDIDATES don't contain what the question needs.`;

const MAX_CANDIDATE_PROPERTIES = 12;

// The CANDIDATES text: only what matched, usually 3-10 lines.
function describeCandidates(match, summary, model) {
    const { vocabulary } = model;
    const lines = [];

    for (const name of summary.categories) {
        const count = vocabulary.categories.find(c => c.name === name)?.count;
        lines.push(`- category: ${name} (${count})`);
    }
    for (const name of summary.missingCategories) {
        lines.push(`- this model has no "${name}" category`);
    }
    if (summary.groupByCategory) {
        lines.push('- you can group by "category"');
    }

    // Properties: the ones named, plus the ones whose values matched. For family and
    // type names we show only the matched names, not all 100.
    const shown = new Map(); // path -> values to show (null = all)
    // The rank word ("longest") was taken out of the question's words, so show its property here.
    if (match.rank && vocabulary.allPaths.has(match.rank.path)) {
        lines.push(`- "${match.rank.word}" ranks by ${match.rank.path} (${match.rank.order}${match.rank.limit ? `, limit ${match.rank.limit}` : ''})`);
        shown.set(match.rank.path, null);
    }
    for (const paths of summary.propertyMentions) {
        paths.forEach(path => shown.set(path, null));
    }
    for (const filter of summary.valueFilters) {
        for (const path of filter.paths) {
            if (!shown.has(path)) shown.set(path, NAME_PATHS.has(path) ? filter.values : null);
        }
    }
    let added = 0;
    for (const [path, onlyValues] of shown) {
        const property = vocabulary.properties.find(p => p.path === path);
        if (!property || added >= MAX_CANDIDATE_PROPERTIES) continue;
        // With one category named, show only the values that category uses: for "beams",
        // the framing materials, not "Steel, 45-345", which only columns have.
        let values = onlyValues;
        if (!values && property.kind === 'values' && summary.categories.length === 1) {
            const inCategory = (model.dictionary.valuesByPath.get(path) || [])
                .filter(entry => entry.categories.has(summary.categories[0]))
                .map(entry => entry.value);
            if (inCategory.length > 0) values = inCategory;
        }
        lines.push(describeProperty(property, values));
        added++;
    }
    if ([...shown.keys()].some(path => LEVEL_PATHS.includes(path))) {
        lines.push('- (a filter on one level property automatically covers all of them)');
    }

    // Only words that could be names: numbers, units and comparisons ("20", "kg", "than")
    // are never names, and listing them made the LLM give up on questions it could answer.
    const notFound = match.unexplained.filter(word => !/^\d/.test(word) && !UNMATCHED_OK.has(word));
    if (notFound.length > 0) {
        lines.push(`- words not found in this model: ${notFound.join(', ')}`);
    }
    return lines.length > 0 ? lines.join('\n') : '- nothing in the question matched a name in this model';
}

async function planWithCandidates(question, match, summary, model, previous = null) {
    let message = `QUESTION: ${question}\n\nCANDIDATES:\n${describeCandidates(match, summary, model)}`;
    if (previous) message += `\n\n${describePrevious(previous)}`;
    const { json, usage } = await askForJson(CANDIDATES_PROMPT, message);
    return { plan: json, usage };
}

// --- Tier 2: the full vocabulary (~3,000 tokens), only when tier 1 couldn't do it.
async function planQuery(question, model, match, summary, previous = null) {
    // Build the prompt the first time this model needs it, then reuse it.
    if (!model.plannerPrompt) {
        model.plannerPrompt = buildSystemPrompt(model.vocabulary);
    }
    // The full vocabulary shows only the most common properties. The names that matched
    // THIS question (e.g. Nominal Weight for "weigh") go along in the user message: after
    // the system prompt, so the long shared beginning stays cacheable.
    const matched = describeCandidates(match, summary, model);
    let message = `${question}\n\nNames in this model that match the question:\n${matched}`;
    if (previous) message += `\n\n${describePrevious(previous)}`;
    const { json, usage } = await askForJson(model.plannerPrompt, message);
    return { plan: json, usage };
}

// The guard against answering a different question: "the longest beam" or "total length of
// the beams" answered with a plain list, count or breakdown leaves out what was asked.
function missedIntent(match, summary, plan) {
    if (!plan || !['list', 'count', 'group'].includes(plan.action)) return false;
    return wantsTotal(match, summary) || Boolean(match.rank);
}

// The guard against answers that leave part of the question out: returns a word from the
// question that no model name matched, that isn't a number, unit or comparison, and that
// the plan doesn't use either. "curtain walls" answered with all walls -> "curtain".
function ignoredWord(match, plan) {
    if (!plan || !['list', 'count', 'group'].includes(plan.action)) return null;
    const planText = JSON.stringify(plan).toLowerCase();
    return match.unexplained.find(word =>
        !/^\d/.test(word) && !UNMATCHED_OK.has(word) && !planText.includes(word.slice(0, 5))) || null;
}

// The guard against filters the LLM made up: a text filter (equals / not_equals /
// contains) is kept only if its value shares a word with the question. "steel" keeps
// "Metal - Steel - 345 MPa"; "shorter than 2 m" drops an invented Family = "M_TJL Wood
// Open Web Joist". Typo fixes and material stand-ins ("timber" -> softwood) count as words
// of the question. Returns the plan with those filters removed, and logs what it removed.
function dropInventedFilters(plan, question, match) {
    if (!plan || !Array.isArray(plan.filters)) return plan;
    const asked = new Set(toWords(question).map(word => WORD_VARIANTS[word] || word));
    for (const fix of match.corrections) asked.add(fix.split(' -> ')[1]);
    for (const word of [...asked]) (MATERIAL_WORDS[word] || []).forEach(alias => asked.add(alias));
    const grounded = filter => {
        if (!['equals', 'not_equals', 'contains'].includes(filter?.op)) return true;   // numbers: always kept
        const values = [].concat(filter.value ?? []).map(String);
        return values.every(value => {
            const words = toWords(value).filter(word => !/^\d+$/.test(word) && !STOPWORDS.has(word));
            if (/^-?\d/.test(value.trim())) return true;                                 // "25.4 kg/m" is a number
            return words.length === 0 || words.some(word => asked.has(word) || [...asked].some(a => a.length > 3 && word.includes(a)));
        });
    };
    const kept = plan.filters.filter(grounded);
    if (kept.length === plan.filters.length) return plan;
    console.log(`Removed invented filter(s): ${JSON.stringify(plan.filters.filter(f => !grounded(f)))}`);
    return { ...plan, filters: kept };
}

// Decides which tier answers. Returns { tier, plan, checked, calls, match }:
//   checked - the result of validatePlan (ok + clean plan, or a question for the user)
//   calls   - one { tier, ...usage } per LLM call, for the token report
//   previous - { question, plan } of the last answer on this sheet, or null
async function answerQuestion(question, model, previous = null) {
    const calls = [];
    const match = matchQuestion(question, model.dictionary);
    let summary = summarizeMatch(match);
    const followUp = Boolean(previous) && isFollowUp(question, match, summary);
    // A follow-up without a category of its own is about the previous plan's category.
    if (followUp && summary.categories.length === 0 && previous.plan?.category) {
        summary = summarizeMatch(match, previous.plan.category);
    }
    const context = followUp ? previous : null;   // what tiers 1 and 2 are told about the last question
    const done = (tier, plan, checked) => ({ tier, plan, checked, calls, match, followUp });
    // The guard against invented filters must accept words from the earlier questions too:
    // "steel" in the plan came from "steel beams on level 2", not from "and on level 3?".
    const askedText = context ? `${question} ${context.question}` : question;

    // Asked for a category this model doesn't have ("ceilings"): no LLM needed.
    if (summary.missingCategories.length > 0 && summary.categories.length === 0) {
        const available = model.vocabulary.categories.map(c => c.name).join(', ');
        return done(0, null, ask(`This model has no ${summary.missingCategories[0]} category. Categories in this model: ${available}.`));
    }

    // A follow-up code fully understood: merge it into the previous plan (0 tokens).
    if (followUp && understoodByCode(match, summary)) {
        const plan = mergeFollowUp(previous.plan, summary, match, question);
        if (plan) {
            const checked = validatePlan(plan, model);
            // "and the columns?" when the old filter's value isn't used by columns is a
            // real question for the user; only an unknown name sends it on to the LLM.
            if (checked.ok || checked.kind !== 'unknown-name') return done(0, plan, checked);
        }
    }

    // Tier 0: code understood every word.
    //   Ranking / totals: the words already say what to do, so code writes the plan (0 tokens).
    //   Otherwise the tiny prompt only picks list / count / group.
    // (Not for follow-ups: starting from scratch would forget the previous question.)
    const special = wantsTotal(match, summary) || Boolean(match.rank);
    if (followUp) {
        // straight to tier 1, with the previous question
    } else if (isSimple(match, summary) && special) {
        const plan = planRankOrTotal(summary, match);
        if (plan) {
            const checked = validatePlan(plan, model);
            if (checked.ok) return done(0, plan, checked);
        }
    } else if (isSimple(match, summary)) {
        // (Without the comparisons code already read: also a few tokens cheaper.)
        const { action, usage } = await classifyIntent(match.withoutComparisons);
        calls.push({ tier: 0, ...usage });
        const plan = action === 'other' ? null : planFromMatch(summary, action);
        if (plan) {
            const checked = validatePlan(plan, model);
            if (checked.ok) return done(0, plan, checked);
        }
    }

    // Tier 1: small prompt with only the matched names.
    const tier1 = await planWithCandidates(question, match, summary, model, context);
    calls.push({ tier: 1, ...tier1.usage });
    tier1.plan = dropInventedFilters(tier1.plan, askedText, match);
    if (tier1.plan?.action !== 'need_more' && !ignoredWord(match, tier1.plan) && !missedIntent(match, summary, tier1.plan)) {
        const checked = validatePlan(tier1.plan, model);
        // A plan using names that don't exist means the candidates were too few:
        // try again with everything. Any other problem is a real question for the user.
        if (checked.ok || checked.kind !== 'unknown-name') return done(1, tier1.plan, checked);
    }
    // (A tier 1 plan that ignored a word of the question also goes on to tier 2:
    //  the full vocabulary may contain what that word refers to.)

    // Tier 2: the full vocabulary.
    const tier2 = await planQuery(question, model, match, summary, context);
    calls.push({ tier: 2, ...tier2.usage });
    tier2.plan = dropInventedFilters(tier2.plan, askedText, match);
    const dropped = ignoredWord(match, tier2.plan);
    if (dropped) {
        return done(2, tier2.plan, ask(`I couldn't find "${dropped}" in this model, so I can't answer that exactly. Ask without it, or use a name from the model.`));
    }
    if (missedIntent(match, summary, tier2.plan)) {
        return done(2, tier2.plan, ask(match.rank
            ? `I couldn't work out how to rank that. Try e.g. "the ${match.rank.word} beams" or "top 5 ${match.rank.word} columns".`
            : 'I couldn\'t work out which quantity to add up. Try e.g. "total length of the steel beams" or "total volume of the floors".'));
    }
    return done(2, tier2.plan, validatePlan(tier2.plan, model));
}


// ===========================================================================
// 4. QUERY ENGINE
// Takes the LLM's plan and:
//   validatePlan - checks every name and value against the REAL model.
//                  If something is wrong, it asks the user instead of guessing.
//   runPlan      - turns the checked plan into SQL, runs it, writes the answer.
// Plain JavaScript, no AI: fast, free, same result every time. If an answer is
// wrong, look at the plan: bad plan = LLM problem, good plan = code problem.
// ===========================================================================

const ACTIONS = new Set(['list', 'count', 'group', 'rank', 'total', 'coordinates', 'clarify', 'reply']);
const AGGREGATES = new Set(['sum', 'average', 'min', 'max']);

// Each operator maps to a small piece of SQL. `p` is the properties table.
// The LLM can only pick a NAME from this list; it never writes SQL itself.
// equals / not_equals take a LIST of values ("is Level 1 or Level 2"), so they
// use IN (...); the others take exactly one value.
const LIST_OPERATORS = new Set(['equals', 'not_equals']);
const NUMERIC_OPERATORS = new Set(['gt', 'gte', 'lt', 'lte']);
const OPERATORS = new Set(['equals', 'not_equals', 'contains', 'gt', 'gte', 'lt', 'lte']);
const NUMERIC_SQL = { gt: '>', gte: '>=', lt: '<', lte: '<=' };

// Human words for the answer text.
const OPERATOR_WORDS = {
    equals: 'is', not_equals: 'is not', equals_number: 'is', not_equals_number: 'is not',
    contains: 'contains', gt: '>', gte: '>=', lt: '<', lte: '<='
};

// Revit keeps "the level an element sits on" in a different property per category:
// beams use Reference Level, columns Base Level, walls Base Constraint, floors Level.
// The LLM kept picking only one of them, so whenever a plan uses ANY of these,
// the code adds all the others itself. ("Top Level" is left out on purpose:
// a column that ends at Level 2 isn't "on" Level 2.)
const LEVEL_PATHS = ['Constraints.Level', 'Constraints.Base Level', 'Constraints.Reference Level', 'Constraints.Base Constraint'];
// Where an element ENDS. Dropped whenever a plan also uses a level above, so a column from
// Level 1 up to Level 2 doesn't count as "on Level 2". Asked about on its own, it's kept.
const TOP_LEVEL_PATHS = ['Constraints.Top Level', 'Constraints.Top Constraint'];

// "12", "12 mm", "6000.5" -> a number with an optional unit word after it.
// (Units may contain "/": "25.4 kg/m", "12.5 kgf/m".)
const NUMBER_WITH_UNIT = /^-?\d+(?:\.\d+)?\s*[a-z°²³^0-9/]*$/i;

const MAX_RETURNED_ELEMENTS = 500; // never send more than this many elements to the frontend
const MAX_GROUPS = 50;

// Accept "x", ["x", "y"] or nothing, and always return an array of non-empty strings.
function toArray(value) {
    if (value === null || value === undefined) return [];
    return (Array.isArray(value) ? value : [value])
        .map(item => String(item ?? '').trim())
        .filter(item => item !== '');
}

// If any of the paths is a level property, add every level property this model has.
function withAllLevelPaths(paths, allPaths) {
    if (!paths.some(path => LEVEL_PATHS.includes(path))) {
        return paths;
    }
    const extra = LEVEL_PATHS.filter(path => allPaths.has(path));
    return [...new Set([...paths, ...extra])] // a Set removes duplicates
        .filter(path => !TOP_LEVEL_PATHS.includes(path));
}

// "Constraints.Reference Level" -> "Reference Level" (for display only).
function label(path) {
    return path.slice(path.indexOf('.') + 1);
}

// Several paths -> "Structural Material / Material" (duplicates removed).
// All the level properties are shown as just "Level".
function labels(paths) {
    const names = paths.map(path => (LEVEL_PATHS.includes(path) ? 'Level' : label(path)));
    return [...new Set(names)].join(' / ');
}

// In LIKE, % means "anything" and _ means "any one character". Put a "\" in
// front of them so that a user searching for "50%" searches for a real % sign.
function escapeLike(text) {
    return text.replace(/[\\%_]/g, '\\$&');
}

// "?, ?, ?" for an IN (...) list with one placeholder per item.
function placeholders(items) {
    return items.map(() => '?').join(', ');
}

// A validation result that means "don't run anything, ask the user this".
// kind 'unknown-name' = the plan used a category or property this model doesn't
// have. From tier 1 that means "too few candidates", so answerQuestion tries tier 2.
function ask(question, kind = 'answer') {
    return { ok: false, question, kind };
}

// SQL that limits property rows to one category, when there is one.
// Checking values per category is what catches "columns whose Reference Level
// is Level 1": that value exists in the model (on beams), but on no column.
function categoryJoin(category) {
    return category
        ? { sql: 'JOIN elements e ON e.objectid = p.objectid AND e.category = ?', params: [category] }
        : { sql: '', params: [] };
}

// Does `value` exist (exactly, ignoring case) under any of these paths,
// for an element of this category?
function valueExists(db, paths, value, category) {
    const join = categoryJoin(category);
    return Boolean(db.prepare(
        `SELECT 1 FROM properties p ${join.sql} WHERE p.path IN (${placeholders(paths)}) AND p.value = ? LIMIT 1`
    ).get(...join.params, ...paths, value));
}

// Does any value under these paths CONTAIN `text` (ignoring case), for this category?
function textExists(db, paths, text, category) {
    const join = categoryJoin(category);
    return Boolean(db.prepare(
        `SELECT 1 FROM properties p ${join.sql} WHERE p.path IN (${placeholders(paths)}) AND p.value LIKE ? ESCAPE '\\' LIMIT 1`
    ).get(...join.params, ...paths, `%${escapeLike(text)}%`));
}

// When an exact value isn't found, offer real values the user might have meant.
function suggestValues(db, paths, value, category) {
    const join = categoryJoin(category);
    const similar = db.prepare(
        `SELECT DISTINCT p.value FROM properties p ${join.sql}
         WHERE p.path IN (${placeholders(paths)}) AND p.value LIKE ? ESCAPE '\\' LIMIT 10`
    ).all(...join.params, ...paths, `%${escapeLike(value)}%`);
    if (similar.length > 0) {
        return similar.map(row => row.value);
    }
    // Nothing similar: just list the most common real values instead.
    return db.prepare(
        `SELECT p.value FROM properties p ${join.sql}
         WHERE p.path IN (${placeholders(paths)}) GROUP BY p.value ORDER BY COUNT(*) DESC LIMIT 10`
    ).all(...join.params, ...paths).map(row => row.value);
}

// Checks one filter from the LLM. Returns { filter } (cleaned up), { skip: true }
// when the filter can safely be ignored, or { question } to ask the user.
function validateFilter(rawFilter, category, model) {
    const { vocabulary, db } = model;

    let paths = toArray(rawFilter.properties ?? rawFilter.property); // accept either spelling from the LLM
    if (paths.length === 0) {
        return { question: 'Which property should I filter on?' };
    }
    const unknownPath = paths.find(path => !vocabulary.allPaths.has(path));
    if (unknownPath) {
        return { question: `This model has no property called "${label(unknownPath)}".`, kind: 'unknown-name' };
    }
    paths = withAllLevelPaths(paths, vocabulary.allPaths);

    const op = rawFilter.op;
    if (!OPERATORS.has(op)) {
        return { question: `I don't know how to compare using "${op}".` };
    }

    // Numbers: exactly one value that really is a number.
    if (NUMERIC_OPERATORS.has(op)) {
        const number = Number(Array.isArray(rawFilter.value) ? rawFilter.value[0] : rawFilter.value);
        if (!Number.isFinite(number)) {
            return { question: `"${rawFilter.value}" isn't a number, so I can't compare ${labels(paths)} with it.` };
        }
        return { filter: { paths, op, values: [number] } };
    }

    let values = toArray(rawFilter.value);
    if (values.length === 0) {
        return { question: `What value of ${labels(paths)} are you looking for?` };
    }

    // contains: "steel or timber" keeps BOTH values (any of them matches). Each one must
    // occur in this category, or the user is asked: never a silent "nothing found" for one of them.
    if (op === 'contains') {
        // Everyday material words stand for the names the model uses: "timber" -> "softwood",
        // "lumber" (when "timber" itself appears nowhere in these values).
        values = values.flatMap(value => {
            const aliases = MATERIAL_WORDS[value.toLowerCase()];
            if (!aliases || textExists(db, paths, value, category)) return [value];
            const found = aliases.filter(alias => textExists(db, paths, alias, category));
            return found.length > 0 ? found : [value];
        });
        const missing = values.find(value => !textExists(db, paths, value, category));
        if (missing) {
            const where = category ? `${category} with` : 'elements with';
            const options = suggestValues(db, paths, missing, category);
            return { question: `I couldn't find ${where} ${labels(paths)} containing "${missing}" in this model.` +
                (options.length ? ` Options: ${options.join(', ')}.` : '') };
        }
        return { filter: { paths, op, values } };
    }

    // "Bar Diameter equals 12 mm" on a number property: compare the numbers,
    // because the stored text is "12.000 mm" and would never equal "12 mm".
    const allNumeric = paths.every(path => vocabulary.numericPaths.has(path));
    if (allNumeric && LIST_OPERATORS.has(op) && values.every(value => NUMBER_WITH_UNIT.test(value))) {
        return { filter: { paths, op: `${op}_number`, values: values.map(value => parseFloat(value)) } };
    }

    // equals: every value must really exist for this category. This is what stops
    // "Level 2" from silently matching "Level 20" like LIKE did in v1.
    if (op === 'equals') {
        const missing = values.find(value => !valueExists(db, paths, value, category));
        if (missing) {
            const where = category ? `${category} with` : 'elements with';
            const options = suggestValues(db, paths, missing, category);
            return { question: `I couldn't find ${where} ${labels(paths)} "${missing}" in this model.` +
                (options.length ? ` Options: ${options.join(', ')}.` : '') };
        }
        return { filter: { paths, op, values } };
    }

    // not_equals: excluding a value that doesn't exist changes nothing, so we
    // just drop it instead of bothering the user.
    const existing = values.filter(value => valueExists(db, paths, value, category));
    return existing.length > 0 ? { filter: { paths, op, values: existing } } : { skip: true };
}

// Treat the LLM's output like user input from a form: check everything.
// Returns { ok: true, plan } with a cleaned-up plan, or { ok: false, question }.
function validatePlan(rawPlan, model) {
    const plan = rawPlan && typeof rawPlan === 'object' ? rawPlan : {};
    const { vocabulary } = model;

    if (!ACTIONS.has(plan.action)) {
        return ask('Sorry, I didn\'t understand that. Could you rephrase it?');
    }

    // These two need no database work: the LLM already wrote the text.
    if (plan.action === 'clarify' || plan.action === 'reply') {
        return { ok: true, plan: { action: plan.action, message: String(plan.message || '') } };
    }

    if (plan.action === 'coordinates') {
        const elementId = Number(plan.elementId);
        if (!Number.isInteger(elementId)) {
            return ask('Which element id do you want the location of?');
        }
        return { ok: true, plan: { action: 'coordinates', elementId } };
    }

    // --- category: must be one that really exists in this model
    let category = null;
    if (plan.category) {
        const wanted = String(plan.category).toLowerCase();
        const match = vocabulary.categories.find(c => c.name.toLowerCase() === wanted);
        if (!match) {
            const available = vocabulary.categories.map(c => c.name).join(', ');
            return ask(`This model has no "${plan.category}" category. Categories in this model: ${available}.`, 'unknown-name');
        }
        category = match.name; // use the model's exact spelling from now on
    }

    // --- filters: each one checked by validateFilter above
    const filters = [];
    for (const rawFilter of Array.isArray(plan.filters) ? plan.filters : []) {
        const result = validateFilter(rawFilter || {}, category, model);
        if (result.question) {
            return ask(result.question, result.kind);
        }
        if (result.filter) {
            filters.push(result.filter);
        }
    }

    // --- groupBy: needed for "group", optional for "total"; either "category" or real paths
    let groupBy = null;
    const wantsGroups = plan.action === 'group' || (plan.action === 'total' && plan.groupBy);
    if (wantsGroups) {
        if (plan.groupBy === 'category') {
            groupBy = 'category';
        } else {
            groupBy = toArray(plan.groupBy);
            if (groupBy.length === 0) {
                return ask('What should I group the elements by?');
            }
            const unknownPath = groupBy.find(path => !vocabulary.allPaths.has(path));
            if (unknownPath) {
                return ask(`This model has no property called "${label(unknownPath)}".`, 'unknown-name');
            }
            groupBy = withAllLevelPaths(groupBy, vocabulary.allPaths);
        }
    }

    // A property to rank by or add up must exist AND hold numbers ("6000 mm", not "Level 2").
    function numberPaths(raw, what) {
        const paths = toArray(raw);
        if (paths.length === 0) {
            return { question: `Which property should I ${what}?` };
        }
        const unknownPath = paths.find(path => !vocabulary.allPaths.has(path));
        if (unknownPath) {
            return { question: `This model has no property called "${label(unknownPath)}".`, kind: 'unknown-name' };
        }
        // A few non-number values somewhere in the model don't matter: the SQL only uses
        // rows that have a number. A property with no numbers at all can't be ranked.
        const hasNumbers = path => vocabulary.numericPaths.has(path) ||
            Boolean(model.db.prepare('SELECT 1 FROM properties WHERE path = ? AND numeric_value IS NOT NULL LIMIT 1').get(path));
        const textPath = paths.find(path => !hasNumbers(path));
        if (textPath) {
            return { question: `${label(textPath)} isn't a number, so I can't ${what} it.` };
        }
        return { paths };
    }

    if (plan.action === 'rank') {
        const sortBy = numberPaths(plan.sortBy, 'rank by');
        if (sortBy.question) return ask(sortBy.question, sortBy.kind);
        // limit: a whole number 1-500, or null = "every element tied at the top".
        const limit = Number(plan.limit);
        return {
            ok: true,
            plan: {
                action: 'rank', category, filters,
                sortBy: sortBy.paths,
                order: plan.order === 'asc' ? 'asc' : 'desc',
                limit: Number.isInteger(limit) && limit >= 1 ? Math.min(limit, MAX_RETURNED_ELEMENTS) : null
            }
        };
    }

    if (plan.action === 'total') {
        const aggregate = AGGREGATES.has(plan.aggregate) ? plan.aggregate : 'sum';
        // "weight" is worked out from two properties, so both must exist. (Adding up Nominal
        // Weight itself would add kg PER METRE, which means nothing: that's a weight too.)
        if (plan.measure === 'weight' || (toArray(plan.measure).includes(WEIGHT_PATH) && aggregate === 'sum')) {
            const missing = [WEIGHT_PATH, LENGTH_PATH].find(path => !vocabulary.numericPaths.has(path));
            if (missing) {
                return ask(`I can't work out weights in this model: it has no ${label(missing)} numbers.`);
            }
            return { ok: true, plan: { action: 'total', category, filters, measure: 'weight', aggregate, groupBy } };
        }
        const measure = numberPaths(plan.measure, 'add up');
        if (measure.question) return ask(measure.question, measure.kind);
        return { ok: true, plan: { action: 'total', category, filters, measure: measure.paths, aggregate, groupBy } };
    }

    return { ok: true, plan: { action: plan.action, category, filters, groupBy } };
}

// Builds the WHERE part shared by list, count and group.
// Returns the SQL text and its parameters IN THE SAME ORDER as the ?s.
function buildWhere(plan) {
    const conditions = [];
    const params = [];

    if (plan.category) {
        conditions.push('e.category = ?');
        params.push(plan.category);
    }

    // Each filter becomes "the element has (or, for not_equals, has NOT) a matching
    // property row". EXISTS (...) is true if the inner query finds any row at all.
    for (const filter of plan.filters) {
        let test;
        let values = filter.values;
        if (LIST_OPERATORS.has(filter.op)) {
            test = `p.value IN (${placeholders(values)})`;
        } else if (filter.op === 'equals_number' || filter.op === 'not_equals_number') {
            test = `p.numeric_value IN (${placeholders(values)})`; // set by validateFilter for "12 mm"
        } else if (filter.op === 'contains') {
            // One LIKE per value, joined with OR: "steel or timber" matches either.
            // ("\" lets us search for a literal % or _.)
            test = '(' + values.map(() => "p.value LIKE ? ESCAPE '\\'").join(' OR ') + ')';
            values = values.map(value => `%${escapeLike(value)}%`);
        } else {
            test = `p.numeric_value ${NUMERIC_SQL[filter.op]} ?`;
        }

        const exists = `EXISTS (SELECT 1 FROM properties p
                     WHERE p.objectid = e.objectid
                       AND p.path IN (${placeholders(filter.paths)})
                       AND ${test})`;
        conditions.push(filter.op.startsWith('not_equals') ? `NOT ${exists}` : exists);
        params.push(...filter.paths, ...values);
    }

    return {
        where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
        params
    };
}

// "Structural Framing elements where Reference Level is "Level 2""
function describe(plan) {
    const subject = plan.category ? `${plan.category} elements` : 'elements';
    if (plan.filters.length === 0) {
        return subject;
    }
    const conditions = plan.filters.map(filter => {
        // Quote text values ("Level 2") but not numbers (> 100).
        const shown = filter.values.map(value => (typeof value === 'number' ? value : `"${value}"`));
        const words = shown.length > 1 ? `${OPERATOR_WORDS[filter.op]} one of` : OPERATOR_WORDS[filter.op];
        return `${labels(filter.paths)} ${words} ${shown.join(', ')}`;
    });
    return `${subject} where ${conditions.join(' and ')}`;
}

// The matching elements (first 500) plus the total count.
function findElements(db, plan) {
    const { where, params } = buildWhere(plan);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM elements e ${where}`).get(...params).c;
    const rows = db.prepare(
        `SELECT e.objectid, e.external_id, e.name, e.clean_name FROM elements e ${where} ORDER BY e.objectid LIMIT ?`
    ).all(...params, MAX_RETURNED_ELEMENTS);
    return { total, rows };
}

// Counts per value, e.g. [{ value: "Level 2", count: 2 }, { value: "Level 1", count: 1 }].
function groupElements(db, plan) {
    const { where, params } = buildWhere(plan);

    if (plan.groupBy === 'category') {
        const groups = db.prepare(`
            SELECT COALESCE(e.category, 'Uncategorised') AS value, COUNT(*) AS count
            FROM elements e ${where}
            GROUP BY e.category ORDER BY count DESC LIMIT ?
        `).all(...params, MAX_GROUPS);
        return { groups, missing: 0 };
    }

    // Join each element to its group-by property (alias g) and count per value.
    // The ?s for g.path come BEFORE the WHERE's ?s in the SQL text, so their
    // params must come first too: [...groupBy paths, ...where params, limit].
    const groups = db.prepare(`
        SELECT g.value AS value, COUNT(DISTINCT e.objectid) AS count
        FROM elements e
        JOIN properties g ON g.objectid = e.objectid AND g.path IN (${placeholders(plan.groupBy)})
        ${where}
        GROUP BY g.value ORDER BY count DESC LIMIT ?
    `).all(...plan.groupBy, ...params, MAX_GROUPS);

    // Elements that matched but have none of the group-by properties.
    const noValueCondition = `NOT EXISTS (SELECT 1 FROM properties g WHERE g.objectid = e.objectid AND g.path IN (${placeholders(plan.groupBy)}))`;
    const missing = db.prepare(
        `SELECT COUNT(*) AS c FROM elements e ${where ? `${where} AND` : 'WHERE'} ${noValueCondition}`
    ).get(...params, ...plan.groupBy).c;

    return { groups, missing };
}

// Every matching element with ONE number from `paths` (e.g. its length) and, if asked,
// the group it belongs to. One row per element, also for elements without the number
// (number = null), so the answer can say how many were left out.
// Each (SELECT ... LIMIT 1) is a "subquery": it runs once per element and picks that
// element's first matching property row. Their ?s come before the WHERE's, so the
// params are in that order too: [paths, paths, group paths, ...where params].
function measureElements(db, plan, paths, groupBy = null) {
    const { where, params } = buildWhere(plan);
    const pick = column => `(SELECT m.${column} FROM properties m
        WHERE m.objectid = e.objectid AND m.path IN (${placeholders(paths)}) AND m.numeric_value IS NOT NULL LIMIT 1)`;
    let group = 'NULL';
    let groupParams = [];
    if (groupBy === 'category') {
        group = "COALESCE(e.category, 'Uncategorised')";
    } else if (groupBy) {
        group = `(SELECT g.value FROM properties g WHERE g.objectid = e.objectid AND g.path IN (${placeholders(groupBy)}) LIMIT 1)`;
        groupParams = groupBy;
    }
    return db.prepare(`
        SELECT e.objectid, e.external_id, e.name, e.clean_name, ${pick('numeric_value')} AS number, ${pick('unit')} AS unit, ${group} AS grp
        FROM elements e ${where} ORDER BY e.objectid
    `).all(...paths, ...paths, ...groupParams, ...params);
}

// Unit text -> how many metres (or kg per metre) one unit is. Unknown units -> undefined.
const METRES_PER = { mm: 0.001, cm: 0.01, m: 1, ft: 0.3048, in: 0.0254 };
const KG_PER_METRE = { 'kg/m': 1, 'kgf/m': 1, 'lb/ft': 1.48816 };

// Revit stores a steel section's weight PER METRE ("Nominal Weight", kgf/m), not the
// member's weight. So the member's weight = Nominal Weight x Length, in kg.
// Returns rows like measureElements, with number = kg (null if either value is missing).
function weighElements(db, plan, groupBy = null) {
    const weights = measureElements(db, plan, [WEIGHT_PATH], groupBy);
    const lengths = new Map(measureElements(db, plan, [LENGTH_PATH]).map(row => [row.objectid, row]));
    return weights.map(row => {
        const length = lengths.get(row.objectid);
        const perMetre = KG_PER_METRE[String(row.unit).toLowerCase()];
        const metres = METRES_PER[String(length?.unit).toLowerCase()];
        const known = row.number !== null && length?.number != null && perMetre && metres;
        return { ...row, number: known ? row.number * perMetre * length.number * metres : null, unit: 'kg' };
    });
}

// Adds up rows per unit: values in "mm" and in "m" must never be added together.
// Returns [{ unit, value, count }], e.g. [{ unit: 'mm', value: 258448.1, count: 42 }].
function aggregateByUnit(rows, aggregate) {
    const byUnit = new Map();
    for (const row of rows) {
        if (!byUnit.has(row.unit)) byUnit.set(row.unit, []);
        byUnit.get(row.unit).push(row.number);
    }
    return [...byUnit].map(([unit, numbers]) => {
        const sum = numbers.reduce((a, b) => a + b, 0);
        const value = aggregate === 'average' ? sum / numbers.length
            : aggregate === 'min' ? Math.min(...numbers)
            : aggregate === 'max' ? Math.max(...numbers)
            : sum;
        return { unit, value, count: numbers.length };
    });
}

// 258448.1, "mm" -> "258,448.1 mm (258.448 m)". The comma groups make big numbers readable;
// the second unit saves the reader a conversion.
function formatQuantity(value, unit) {
    const number = n => n.toLocaleString('en-US', { maximumFractionDigits: 3 });
    const shownUnit = String(unit ?? '').replace('^3', '³').replace('^2', '²');
    let text = `${number(value)}${shownUnit ? ' ' + shownUnit : ''}`;
    if (unit === 'mm' && Math.abs(value) >= 1000) text += ` (${number(value / 1000)} m)`;
    if (unit === 'kg' && Math.abs(value) >= 1000) text += ` (${number(value / 1000)} t)`;
    return text;
}

// The element list the frontend shows (same shape as list/count), plus each element's number.
function elementData(rows, total) {
    const shown = rows.slice(0, MAX_RETURNED_ELEMENTS);
    const objectIds = shown.map(row => row.objectid);
    return {
        count: total,
        returned: shown.length,
        truncated: total > shown.length,
        objectIds,
        elements: shown.map(row => ({ id: row.objectid, externalId: row.external_id, name: row.clean_name, rawName: row.name, value: row.number, unit: row.unit }))
    };
}

const AGGREGATE_LABELS = { sum: 'Total', average: 'Average', min: 'Smallest', max: 'Largest' };

// Runs a validated plan. Always returns { answer, objectIds, data }:
//   answer    - text for the chat bubble
//   objectIds - ids for the Viewer to highlight
//   data      - structured details (element list, groups, coordinates, ...)
function runPlan(plan, model, userId) {
    switch (plan.action) {
        case 'reply':
        case 'clarify':
            // Never send an empty answer: the chat would show a blank bubble.
            return { answer: plan.message || 'Could you rephrase that?', objectIds: [], data: null };

        case 'coordinates': {
            const found = getCoordinates(model, plan.elementId, userId);
            if (!found) {
                return { answer: `I don't have coordinates for element ${plan.elementId} yet.`, objectIds: [], data: null };
            }
            return {
                answer: `Element ${plan.elementId} is at ${JSON.stringify(found.position)}.`,
                objectIds: [found.objectId],
                data: { coordinates: found.position }
            };
        }

        case 'list':
        case 'count': {
            const { total, rows } = findElements(model.db, plan);
            const objectIds = rows.map(row => row.objectid);
            const description = describe(plan);

            let answer = plan.action === 'count'
                ? `There ${total === 1 ? 'is' : 'are'} ${total} ${description}.`
                : `Found ${total} ${description}.`;
            if (total > rows.length) {
                answer += ` Showing the first ${rows.length}.`;
            }

            return {
                answer,
                objectIds,
                // Same shape as v1's formatElementResults, so the frontend keeps working.
                data: {
                    count: total,
                    returned: rows.length,
                    truncated: total > rows.length,
                    objectIds,
                    elements: rows.map(row => ({ id: row.objectid, externalId: row.external_id, name: row.clean_name, rawName: row.name }))
                }
            };
        }

        case 'group': {
            const { groups, missing } = groupElements(model.db, plan);
            const byWhat = plan.groupBy === 'category' ? 'category' : labels(plan.groupBy);
            const lines = groups.map(group => `• ${group.value}: ${group.count}`);
            if (missing > 0) {
                lines.push(`• (no ${byWhat}): ${missing}`);
            }
            const answer = groups.length === 0
                ? `No ${describe(plan)} found.`
                : `${describe(plan)} by ${byWhat}:\n${lines.join('\n')}`;

            const { rows } = findElements(model.db, plan); // so the Viewer can highlight the whole set
            return { answer, objectIds: rows.map(row => row.objectid), data: { groups, missing } };
        }

        case 'rank': {
            const rows = measureElements(model.db, plan, plan.sortBy);
            const measured = rows.filter(row => row.number !== null);
            // Highest first for "desc", lowest first for "asc".
            measured.sort((a, b) => (plan.order === 'desc' ? b.number - a.number : a.number - b.number));
            const what = labels(plan.sortBy);
            const extreme = plan.order === 'desc' ? 'highest' : 'lowest';

            if (measured.length === 0) {
                return { answer: `None of the ${describe(plan)} has a ${what} value, so I can't rank them.`, objectIds: [], data: elementData([], 0) };
            }
            // No limit: every element tied at the top ("the longest beam" may be 4 beams of the
            // same length). A limit: exactly that many ("top 5").
            const chosen = plan.limit
                ? measured.slice(0, plan.limit)
                : measured.filter(row => row.number === measured[0].number);
            const first = formatQuantity(chosen[0].number, chosen[0].unit);
            const last = formatQuantity(chosen[chosen.length - 1].number, chosen[chosen.length - 1].unit);

            let answer = plan.limit
                ? `The ${chosen.length} ${describe(plan)} with the ${extreme} ${what}: from ${first} to ${last}.`
                : `${chosen.length === 1 ? '1 element has' : `${chosen.length} elements share`} the ${extreme} ${what} of the ${describe(plan)}: ${first}.`;
            if (rows.length > measured.length) {
                const unranked = rows.length - measured.length;
                answer += ` (${unranked} of them ${unranked === 1 ? 'has' : 'have'} no ${what} and ${unranked === 1 ? 'was' : 'were'} not ranked.)`;
            }
            const data = elementData(chosen, chosen.length);
            return { answer, objectIds: data.objectIds, data };
        }

        case 'total': {
            const isWeight = plan.measure === 'weight';
            const rows = isWeight
                ? weighElements(model.db, plan, plan.groupBy)
                : measureElements(model.db, plan, plan.measure, plan.groupBy);
            const measured = rows.filter(row => row.number !== null);
            const what = isWeight ? 'weight' : labels(plan.measure);
            const title = `${AGGREGATE_LABELS[plan.aggregate]} ${what}`;

            if (measured.length === 0) {
                const answer = rows.length === 0
                    ? `No ${describe(plan)} found.`
                    : `None of the ${rows.length} ${describe(plan)} has a ${isWeight ? 'Nominal Weight and Length' : what} value.`;
                return { answer, objectIds: [], data: { ...elementData(rows, rows.length), totals: [], groups: [] } };
            }

            // "258,448.1 mm (258.448 m)", or one part per unit if the values use several units.
            const totals = aggregateByUnit(measured, plan.aggregate);
            const shown = totals.length === 1
                ? formatQuantity(totals[0].value, totals[0].unit)
                : totals.map(t => `${formatQuantity(t.value, t.unit)} (${t.count} elements)`).join('; ');
            let answer = `${title} of the ${measured.length} ${describe(plan)}: ${shown}.`;
            if (isWeight) answer += ' (Weight = Nominal Weight per metre x Length.)';
            if (rows.length > measured.length) {
                answer += ` ${rows.length - measured.length} more have no ${isWeight ? 'Nominal Weight or Length' : what} and are not included.`;
            }

            // "per level": the same calculation for each group, biggest first.
            let groups = [];
            if (plan.groupBy) {
                const byGroup = new Map();
                for (const row of measured) {
                    const key = row.grp ?? `(no ${plan.groupBy === 'category' ? 'category' : labels(plan.groupBy)})`;
                    if (!byGroup.has(key)) byGroup.set(key, []);
                    byGroup.get(key).push(row);
                }
                groups = [...byGroup].map(([value, list]) => ({ value, count: list.length, totals: aggregateByUnit(list, plan.aggregate) }))
                    .sort((a, b) => b.totals[0].value - a.totals[0].value)
                    .slice(0, MAX_GROUPS);
                answer += '\n' + groups.map(g => `• ${g.value}: ${g.totals.map(t => formatQuantity(t.value, t.unit)).join('; ')}`).join('\n');
            }

            const data = { ...elementData(rows, rows.length), totals, groups, measure: plan.measure, aggregate: plan.aggregate };
            return { answer, objectIds: data.objectIds, data };
        }

        default:
            // validatePlan only lets known actions through, so this "can't happen".
            // Throwing makes it loud if someone adds an action and forgets this switch.
            throw new Error(`Unhandled action "${plan.action}"`);
    }
}


// ===========================================================================
// 5. ROUTES
// The HTTP layer. It only connects the sections above.
// Same URLs as v1, so the frontend doesn't need new endpoints.
// ===========================================================================

// Used when the frontend doesn't send a urn (older pages and extensions).
const DEFAULT_MODEL = {
    urn: 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6ZnFwdGd0Z2Q2N2dnNGd2dWJhZ2VpdmpweHVzdW9pbXMtYmFzaWMtYXBwL3JzdGJhc2ljc2FtcGxlcHJvamVjdC5ydnQ',
    guid: '2b8b1cf8-31bf-7e71-dfb5-e1d4342ddb82'
};

// Answers that come with a list of elements for the page's result table.
const ELEMENT_ACTIONS = new Set(['list', 'count', 'rank', 'total']);

// Object ids of the last answer per user and model, for GET /ask_agent_simple.
const lastResults = new Map(); // "userId|urn:guid" -> [ids]

// Who is asking (set by login.js). Without login.js (the tests) everyone is "local".
const userOf = req => req.user?.id || 'local';

// The last plan that ran, per user + model + sheet, for follow-up questions:
// "userId|urn:guid|sheetId" -> { question, plan, at }. The page sends a new sheet id
// when you press New sheet or pick another model, which starts afresh.
const lastPlans = new Map();
const FOLLOW_UP_MINUTES = 30;   // after 30 quiet minutes a question starts afresh
const SHEET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
function conversationKey(req, urn, guid) {
    const sheet = SHEET_ID_PATTERN.test(String(req.body?.conversationId || '')) ? req.body.conversationId : 'default';
    return `${userOf(req)}|${urn}:${guid}|${sheet}`;
}

// Longer questions are refused: no real question needs more, and a pasted page
// would only burn tokens.
const MAX_QUESTION_LENGTH = 500;

// A request asked for something we refuse to even try (e.g. a malformed model id).
class BadRequestError extends Error {}

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
            remember(lastPlans, key, { question: asked.slice(-500), plan: outcome.plan, at: Date.now() });
        }
        remember(lastResults, `${userOf(req)}|${urn}:${guid}`, result.objectIds);

        return res.json({
            success: true,
            action,                      // list | count | group | rank | total | coordinates | clarify | reply
            answer: result.answer,       // text to show in the chat
            objectIds: result.objectIds, // ids to highlight in the Viewer
            // `message` keeps v1's shape so the current frontend still works: element
            // results (a table + highlight) for list/count/rank/total, plain text otherwise.
            message: ELEMENT_ACTIONS.has(action) ? result.data : result.answer,
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

// The model the chat answers about, for the status chip in the page's top bar.
// Calling it also loads and indexes the model, so the first question is faster.
router.get('/model_status', async (req, res) => {
    let urn = null;
    try {
        const resolved = await resolveModel(req.query);
        urn = resolved.urn;
        const model = await getModel(resolved.urn, resolved.guid);
        res.json({ ready: true, urn, modelName: modelNameFromUrn(urn), elementCount: model.elementCount, loadedAt: model.loadedAt });
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

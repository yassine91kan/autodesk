// augmented/store.js
// ===========================================================================
// 2. MODEL STORE - puts a downloaded model into SQLite (one database per model),
// describes what it contains (its "vocabulary"), keeps loaded models in memory,
// and stores the Viewer's coordinates per user.
//
// With DATA_DIR set (on Render: /var/data, the persistent disk), each model's
// database is SAVED as a file and reopened after a restart or deploy, instead of
// downloading and rebuilding it from Autodesk. Without DATA_DIR (your PC, the
// tests) databases live in memory only, as before.
// ===========================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const {
    ModelNotReadyError, UnsupportedModelError, NAME_PATHS, PLACEHOLDER_VALUE, MAX_LISTED_VALUES,
    MAX_LISTED_NAMES, MAX_LISTED_NUMBERS, remember
} = require('./shared');
const {
    fetchModelData
} = require('./aps');
const {
    buildDictionary
} = require('./matcher');
const { buildCleanTable } = require('./clean');

// ---------------------------------------------------------------- index files
// Raise this number whenever the tables change (a new column, a new table): saved
// files of an older version are then rebuilt, never read with the wrong layout.
// 2: the clean table (elements_clean + clean_sources, augmented/clean.js).
// 3: its "function" column (Exterior / Interior...).
const SCHEMA_VERSION = 3;

// The folder for index files, or null = keep databases in memory only.
// (Read on every call, so a test can set DATA_DIR before using the store.)
// If DATA_DIR is set but can't be written (e.g. the disk isn't attached), the app keeps
// working in memory and says so in the log, instead of failing every model load.
const unwritable = new Set();
function indexDir() {
    if (!process.env.DATA_DIR) return null;
    const dir = path.join(process.env.DATA_DIR, 'indexes');
    if (unwritable.has(dir)) return null;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        return dir;
    } catch (error) {
        unwritable.add(dir);
        console.error(`DATA_DIR ${process.env.DATA_DIR} can't be written (${error.message}): keeping model indexes in memory only.`);
        return null;
    }
}

// The file for one model view: "<hash of the urn>_<guid>.sqlite". URNs are long base64
// text, so the file name uses a short hash of it; the guid is already safe (letters,
// digits, dashes). Starting with the urn's hash lets forgetModel find all of a model's files.
const urnHash = urn => crypto.createHash('sha1').update(urn).digest('hex').slice(0, 16);
function indexFile(urn, guid) {
    const dir = indexDir();
    return dir ? path.join(dir, `${urnHash(urn)}_${guid}.sqlite`) : null;
}

// Opens a saved index if it's valid: the right model, and this code's schema version.
// An old or broken file is deleted (so it gets rebuilt) and null is returned.
function openSavedIndex(file, key) {
    if (!file || !fs.existsSync(file)) return null;
    let db = null;
    try {
        db = new Database(file);   // (opens even a garbage file: SQLite only notices at the first query)
        const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map(row => [row.key, row.value]));
        if (Number(meta.schema_version) === SCHEMA_VERSION && meta.model === key) {
            db.pragma('journal_mode = WAL');   // readers and the occasional writer don't block each other
            return db;
        }
        console.log(`Index ${path.basename(file)} is from an older version: rebuilding it.`);
    } catch (error) {
        console.warn(`Index ${path.basename(file)} can't be read (${error.message}): rebuilding it.`);
    }
    // Close it BEFORE deleting: an open file can't be deleted on Windows, and a forgotten
    // open file is a leak everywhere.
    if (db) db.close();
    fs.rmSync(file, { force: true });
    return null;
}

const loadedModels = new Map();       // "urn:guid" -> finished model object
const loadingModels = new Map();      // "urn:guid" -> Promise while a download is in progress
// Per USER and model, so two people never see each other's data:
// "userId|urn:guid" -> { objectId: { elementCent: [x, y, z] } }
const coordinatesByUser = new Map();

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
// `file`: where to build it. ':memory:' (the default) lives in RAM and is gone when the
// server stops; a file path builds it on disk (see getModel).
function buildDatabase(collection, tree, file = ':memory:') {
    const db = new Database(file);
    if (file !== ':memory:') {
        // Building a TEMPORARY file (see getModel): SQLite's crash protection would only
        // slow it down, since a half-built .tmp file is thrown away anyway. About 2x faster.
        db.pragma('journal_mode = OFF');
        db.pragma('synchronous = OFF');
    }

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

        -- Where each element is, in metres, from the 3D viewer (see augmented/spatial.js):
        -- its centre and its box (the smallest box along X, Y, Z that holds it).
        -- Empty until a browser has loaded the model once.
        CREATE TABLE positions (
            objectid INTEGER PRIMARY KEY,
            cx REAL, cy REAL, cz REAL,
            min_x REAL, min_y REAL, min_z REAL,
            max_x REAL, max_y REAL, max_z REAL
        );

        -- About this file: which model it is, when it was built, and the schema
        -- version of the code that built it (see SCHEMA_VERSION).
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
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

    // The same data as one plain table in proper units, easy to query (augmented/clean.js).
    buildCleanTable(db);
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
        // Already loaded: instant. Delete + set moves it to the END of the Map, so the
        // Map's order is always "least recently used first" (see keepLoadedLimit).
        const model = loadedModels.get(key);
        loadedModels.delete(key);
        loadedModels.set(key, model);
        return model;
    }
    if (loadingModels.has(key)) {
        return loadingModels.get(key);  // someone else is loading it right now: wait for them
    }

    // Same trick as the token: store the Promise so parallel requests share one download.
    const promise = (async () => {
        // 1. A saved index on disk? Open it: no download, no rebuilding.
        const file = indexFile(urn, guid);
        let db = openSavedIndex(file, key);
        const source = db ? 'disk' : 'autodesk';   // where this model came from (shown by /model_status)

        // 2. Otherwise download it from Autodesk and build it.
        if (!db) {
            const { collection, tree } = await fetchModelData(urn, guid);
            // On disk: build into a temporary file, rename it at the end. A crash halfway
            // leaves only the .tmp file (ignored and replaced next time), never a broken index.
            const temporary = file && `${file}.tmp`;
            if (file) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.rmSync(temporary, { force: true });
            }
            db = buildDatabase(collection, tree, temporary || ':memory:');

            const count = db.prepare('SELECT COUNT(*) AS c FROM elements').get().c;
            if (count === 0) {
                db.close();
                if (temporary) fs.rmSync(temporary, { force: true });
                // Throwing means we never reach loadedModels.set below, so nothing
                // empty gets cached: the next request simply tries again.
                if (collection.length > 0) {
                    // Objects arrived, but none is a "Name [id]" element: not a model we can query.
                    throw new UnsupportedModelError('This model has no elements the assistant can query. It currently works with Revit models.');
                }
                throw new ModelNotReadyError('The model has no elements yet. APS may still be processing it.');
            }

            const writeMeta = db.prepare('INSERT INTO meta VALUES (?, ?)');
            writeMeta.run('schema_version', String(SCHEMA_VERSION));
            writeMeta.run('model', key);
            writeMeta.run('built_at', new Date().toISOString());

            if (file) {
                // Close before renaming (Windows can't rename an open file), then reopen.
                db.close();
                fs.renameSync(temporary, file);
                db = new Database(file);
                db.pragma('journal_mode = WAL');
            }
        }

        // 3. The vocabulary and dictionary are rebuilt from the database either way:
        //    they're quick to make (seconds at most) and live in memory.
        const elementCount = db.prepare('SELECT COUNT(*) AS c FROM elements').get().c;
        const vocabulary = buildVocabulary(db);
        const model = {
            key,
            urn,
            guid,
            db,
            vocabulary,
            dictionary: buildDictionary(db, vocabulary), // word -> model name lookup (section 2b)
            elementCount,
            source,
            loadedAt: new Date().toISOString()
        };
        loadedModels.set(key, model); // only successful loads are cached
        keepLoadedLimit();
        const megabytes = bytes => Math.round(bytes / 1048576);
        const memory = process.memoryUsage();
        console.log(`Model ${key.slice(-36)} loaded from ${source}: ${elementCount} elements. ` +
            `Models in memory: ${loadedModels.size}/${maxLoadedModels()}. ` +
            `Memory: ${megabytes(memory.rss)} MB total, ${megabytes(memory.heapUsed)} MB JavaScript.`);
        return model;
    })();

    loadingModels.set(key, promise);
    try {
        return await promise;
    } finally {
        loadingModels.delete(key); // done (success or failure): stop sharing this Promise
    }
}

// ------------------------------------------------------ limit on loaded models
// Each loaded model keeps its vocabulary and dictionary in memory (the database itself
// is on disk). To stay inside the server's memory, at most MAX_LOADED_MODELS (default 2)
// stay loaded; the least recently used one is dropped. Its saved file stays on disk, so
// the next question about it reopens it (about 2 s for Seaport), with no download.
// (Read on every call, so it can be changed in Render's environment and tests can set it.)
function maxLoadedModels() {
    const limit = parseInt(process.env.MAX_LOADED_MODELS, 10);
    return limit >= 1 ? limit : 2;
}

// A question may still be using a dropped model (e.g. waiting for OpenAI), so its
// database is closed a minute later rather than straight away.
// Until then it waits in droppedModels, so forgetModel/unloadModels can close it at once.
const CLOSE_DELAY_MS = 60 * 1000;
const droppedModels = new Set();
function closeModel(model) {
    droppedModels.delete(model);
    if (model.db.open) model.db.close();
}
function keepLoadedLimit() {
    while (loadedModels.size > maxLoadedModels()) {
        const [oldestKey, oldest] = loadedModels.entries().next().value;   // first = least recently used
        loadedModels.delete(oldestKey);
        droppedModels.add(oldest);
        console.log(`Model ${oldestKey.slice(-36)} dropped from memory (limit ${maxLoadedModels()}); it reopens from disk when asked again.`);
        setTimeout(() => closeModel(oldest), CLOSE_DELAY_MS).unref();
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

// A model was uploaded again (a new version): forget its index in memory AND on disk,
// so the next question builds it from the new version. Called by routes/models.js.
// (Our bucket only changes through our own upload, so this keeps every index current.)
function forgetModel(urn) {
    for (const [key, model] of loadedModels) {
        if (model.urn === urn) {
            closeModel(model);
            loadedModels.delete(key);
        }
    }
    for (const model of droppedModels) {
        if (model.urn === urn) closeModel(model);   // its file is about to be deleted
    }
    const dir = indexDir();
    if (!dir || !fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(`${urnHash(urn)}_`)) fs.rmSync(path.join(dir, name), { force: true });
    }
}

// Closes every loaded model and empties memory, as a restart would. Saved files stay.
// (Used by the tests to check that a "restarted" server reopens files instead of downloading.)
function unloadModels() {
    for (const model of [...loadedModels.values(), ...droppedModels]) closeModel(model);
    loadedModels.clear();
}

module.exports = {
    loadedModels, loadingModels, coordinatesByUser, cleanElementName, isRealElement, parseNumber,
    readTree, buildDatabase, buildVocabulary, getModel, setCoordinates, getCoordinates,
    SCHEMA_VERSION, indexFile, forgetModel, unloadModels, maxLoadedModels
};

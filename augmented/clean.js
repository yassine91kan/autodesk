// augmented/clean.js
// ===========================================================================
// THE CLEAN TABLE - Autodesk sends each element as a long list of text pairs
// ("Dimensions.Length" = "6000.000 mm", "Materials and Finishes.Structural Material" =
// "<By Category>", ...): about 1,000 different property names, units glued to the
// numbers, the same idea under different names per category.
//
// This file turns that into ONE plain table, once, when the model is indexed:
//
//   elements_clean: one row per element, ~20 columns, numbers in standard units
//     category, family, type, level, top_level, mark, material, material_class,
//     is_structural, usage, function, length_m, height_m, width_mm, depth_mm, thickness_mm,
//     section, area_m2, volume_m3, weight_kg_per_m, weight_kg, derived
//
//   clean_sources: for each category and column, WHICH Revit property it came from
//     ("Walls / thickness_mm <- Construction.Width, 9 elements"), so an answer can
//     say where its number came from.
//
// Then "walls thicker than 200 mm" is simply
//   SELECT * FROM elements_clean WHERE category = 'Walls' AND thickness_mm > 200
//
// How each column is filled is decided by the RULES below: a short "Revit rulebook"
// that is the same for every model (e.g. a wall's Width IS its thickness). Each value
// is converted on its own ("13.300 cm" -> 133 mm), so mixed units can't be compared
// by mistake, and text that only looks like a number ("200UB25.4") stays text.
// ===========================================================================

const { PLACEHOLDER_VALUE, WEIGHT_PATH } = require('./shared');

// ---------------------------------------------------------------- units
// Unit text -> [kind, how many base units one of it is]. Base units: metre, m², m³,
// kg, kg/m, degree. Anything not listed is NOT a unit ("UB25.4", "x5.0CHS", ".05.11"),
// so the value stays text.
const UNITS = {
    'mm': ['length', 0.001], 'cm': ['length', 0.01], 'm': ['length', 1], 'km': ['length', 1000],
    'ft': ['length', 0.3048], 'in': ['length', 0.0254],
    'mm^2': ['area', 1e-6], 'mm²': ['area', 1e-6], 'cm^2': ['area', 1e-4], 'cm²': ['area', 1e-4],
    'm^2': ['area', 1], 'm²': ['area', 1], 'ft^2': ['area', 0.09290304], 'ft²': ['area', 0.09290304], 'sf': ['area', 0.09290304],
    'mm^3': ['volume', 1e-9], 'mm³': ['volume', 1e-9], 'cm^3': ['volume', 1e-6], 'cm³': ['volume', 1e-6],
    'm^3': ['volume', 1], 'm³': ['volume', 1], 'ft^3': ['volume', 0.028316846592], 'ft³': ['volume', 0.028316846592], 'cf': ['volume', 0.028316846592],
    'kg': ['mass', 1], 't': ['mass', 1000], 'lb': ['mass', 0.45359237],
    // kgf/m is how Revit labels "Nominal Weight": as a mass per metre it is the same number as kg/m.
    'kg/m': ['linear_mass', 1], 'kgf/m': ['linear_mass', 1], 'lb/ft': ['linear_mass', 1.48816394], 'lbf/ft': ['linear_mass', 1.48816394],
    '°': ['angle', 1], 'deg': ['angle', 1]
};

// Values that mean "nothing set": "<By Category>", "<not associated>", "None", "-", "".
const isPlaceholder = text => text === '' || PLACEHOLDER_VALUE.test(text) || /^(none|-|n\/a)$/i.test(text);

// "6000.000 mm" -> { kind: 'length', base: 6 }. "13.300 cm" -> { kind: 'length', base: 0.133 }.
// Imperial "10' - 6\"" -> 3.2004 m. Anything else (text, unknown units) -> null.
function parseMeasure(raw) {
    const text = String(raw ?? '').trim();
    const feetInches = text.match(/^(-?\d+(?:\.\d+)?)'\s*-?\s*(?:(\d+(?:\.\d+)?)(?:\s+(\d+)\/(\d+))?")?$/);
    if (feetInches) {
        const inches = Number(feetInches[2] || 0) + (feetInches[3] ? Number(feetInches[3]) / Number(feetInches[4]) : 0);
        const sign = feetInches[1].startsWith('-') ? -1 : 1;
        return { kind: 'length', base: (Math.abs(Number(feetInches[1])) * 0.3048 + inches * 0.0254) * sign };
    }
    const match = text.match(/^(-?\d+(?:\.\d+)?)\s*(\S+)$/);
    if (!match) return null;
    const unit = UNITS[match[2].toLowerCase()] || UNITS[match[2]];
    return unit ? { kind: unit[0], base: Number(match[1]) * unit[1] } : null;
}

// ---------------------------------------------------------------- the Revit rulebook
// For each column: the properties to try, in order (the first one an element has wins),
// and what kind of value it must be. `byCategory` replaces the list for one category.
// `skip` lists categories where the column means nothing (a rebar's "B" is a bar
// segment, not a section width).
const SECTION_SKIP = ['Structural Rebar', 'Structural Area Reinforcement'];
const RULES = {
    level: { text: true, paths: ['Constraints.Reference Level', 'Constraints.Base Level', 'Constraints.Level', 'Constraints.Base Constraint', 'Constraints.Schedule Level'] },
    top_level: { text: true, paths: ['Constraints.Top Level', 'Constraints.Top Constraint'], clean: value => value.replace(/^up to level:\s*/i, '') },
    mark: { text: true, paths: ['Identity Data.Mark'] },
    material: { text: true, paths: ['Materials and Finishes.Structural Material', 'Materials and Finishes.Material'] },
    usage: { text: true, paths: ['Structural.Structural Usage'] },
    // Revit's "Function": Exterior / Interior / Foundation / Retaining / Soffit / Core-shaft
    // (walls, floors, roofs). "Exterior walls" means this, not a word in the type name.
    function: { text: true, paths: ['Construction.Function'] },
    length_m: { kind: 'length', scale: 1, paths: ['Dimensions.Length', 'Dimensions.Total Bar Length'] },
    height_m: { kind: 'length', scale: 1, paths: ['Dimensions.Height', 'Constraints.Unconnected Height', 'Constraints.Desired Stair Height'],
        skip: ['Structural Columns', 'Structural Framing'] },   // their "Height" is the profile's, filled as depth_mm
    // A Revit wall's "Width" IS its thickness; for everything else width = the section or footprint width.
    width_mm: { kind: 'length', scale: 1000, skip: SECTION_SKIP,
        paths: ['Structural Section Geometry.Width', 'Dimensions.b', 'Dimensions.Width', 'Dimensions.Chord Width', 'Dimensions.B'],
        byCategory: { Walls: ['Construction.Width'] } },
    depth_mm: { kind: 'length', scale: 1000, skip: SECTION_SKIP,
        paths: ['Structural Section Geometry.Height', 'Dimensions.h', 'Dimensions.Depth', 'Dimensions.d'] },
    thickness_mm: { kind: 'length', scale: 1000,
        paths: ['Dimensions.Thickness', 'Dimensions.Foundation Thickness', 'Construction.Default Thickness'],
        byCategory: { Walls: ['Construction.Width'] } },
    area_m2: { kind: 'area', scale: 1, paths: ['Dimensions.Area'] },
    volume_m3: { kind: 'volume', scale: 1, paths: ['Dimensions.Volume', 'Structural.Reinforcement Volume'] },
    weight_kg_per_m: { kind: 'linear_mass', scale: 1, paths: [WEIGHT_PATH] }
};

// Material name -> class, by the words in it. The first class that matches wins.
const MATERIAL_CLASSES = [
    ['concrete', /concrete|cement|grout|precast|cast-in-place|cast in place/i],
    ['steel', /steel|metal|iron|astm a|\bs235\b|\bs275\b|\bs355\b|rebar/i],
    ['timber', /timber|wood|lumber|softwood|hardwood|glulam|\bclt\b|plywood|\blvl\b/i],
    ['aluminium', /alumin/i],
    ['masonry', /masonry|brick|block|\bcmu\b|stone/i],
    ['glass', /glass|glazing/i]
];
const materialClass = material => material ? (MATERIAL_CLASSES.find(([, re]) => re.test(material))?.[0] || 'other') : null;

// Every Revit property any rule reads (so only those are loaded).
const ALL_PATHS = [...new Set([
    'Element.Family', 'Element.Type', 'Structural.Structural', 'Dimensions.h',
    ...Object.values(RULES).flatMap(rule => [...rule.paths, ...Object.values(rule.byCategory || {}).flat()])
])];

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

// Builds elements_clean and clean_sources in `db` (called right after the raw tables are
// filled: store.js buildDatabase). Returns the number of rows written.
function buildCleanTable(db) {
    db.exec(`
        CREATE TABLE elements_clean (
            objectid        INTEGER PRIMARY KEY,
            external_id     TEXT,
            name            TEXT,
            category        TEXT COLLATE NOCASE,
            family          TEXT COLLATE NOCASE,
            type            TEXT COLLATE NOCASE,
            level           TEXT COLLATE NOCASE,
            top_level       TEXT COLLATE NOCASE,
            mark            TEXT COLLATE NOCASE,
            material        TEXT COLLATE NOCASE,
            material_class  TEXT,      -- concrete | steel | timber | aluminium | masonry | glass | other | NULL (not set)
            is_structural   INTEGER,   -- 1 / 0
            usage           TEXT COLLATE NOCASE,
            function        TEXT COLLATE NOCASE,   -- Exterior | Interior | Foundation | Retaining ... (Revit "Function")
            length_m        REAL,
            height_m        REAL,
            width_mm        REAL,
            depth_mm        REAL,
            thickness_mm    REAL,
            section         TEXT,      -- "450 x 450 mm" when width and depth are known
            area_m2         REAL,
            volume_m3       REAL,
            weight_kg_per_m REAL,
            weight_kg       REAL,
            derived         TEXT       -- columns COMPUTED rather than read: "weight_kg", "height_m"
        );
        CREATE INDEX idx_clean_category ON elements_clean(category);
        CREATE INDEX idx_clean_level ON elements_clean(level);
        CREATE INDEX idx_clean_material_class ON elements_clean(material_class);
        CREATE TABLE clean_sources (
            category TEXT,
            "column" TEXT,
            source   TEXT,      -- the Revit property, or "computed: ..."
            elements INTEGER,
            PRIMARY KEY (category, "column", source)
        );
    `);

    // The raw values these rules need, per element: objectid -> { path: value }.
    const raw = new Map();
    const read = db.prepare(`SELECT objectid, path, value FROM properties WHERE path IN (${ALL_PATHS.map(() => '?').join(', ')})`);
    for (const row of read.iterate(...ALL_PATHS)) {
        if (!raw.has(row.objectid)) raw.set(row.objectid, {});
        raw.get(row.objectid)[row.path] = row.value;
    }

    const sources = new Map();   // "category|column|source" -> count
    const note = (category, column, source) => {
        const key = `${category}|${column}|${source}`;
        sources.set(key, (sources.get(key) || 0) + 1);
    };

    const insert = db.prepare(`INSERT INTO elements_clean VALUES (${Array(25).fill('?').join(', ')})`);
    let count = 0;
    db.transaction(() => {
        // .all(), not .iterate(): SQLite can't insert while a read is still open on the same connection.
        for (const element of db.prepare('SELECT objectid, external_id, clean_name, category FROM elements').all()) {
            const values = raw.get(element.objectid) || {};
            const category = element.category || null;
            const row = {};
            const derived = [];

            for (const [column, rule] of Object.entries(RULES)) {
                row[column] = null;
                if (rule.skip?.includes(category)) continue;
                for (const path of rule.byCategory?.[category] || rule.paths) {
                    const value = values[path];
                    if (value === undefined || isPlaceholder(String(value).trim())) continue;
                    if (rule.text) {
                        row[column] = rule.clean ? rule.clean(String(value).trim()) : String(value).trim();
                    } else {
                        const measure = parseMeasure(value);
                        if (!measure || measure.kind !== rule.kind) continue;   // wrong kind of value: try the next property
                        row[column] = round(measure.base * rule.scale, 6);
                    }
                    note(category, column, path);
                    break;
                }
            }

            // Revit's square column families store only "b": the depth is the same.
            if (row.width_mm !== null && row.depth_mm === null && values['Dimensions.b'] !== undefined && values['Dimensions.h'] === undefined &&
                category === 'Structural Columns') {
                row.depth_mm = row.width_mm;
                note(category, 'depth_mm', 'computed: square section (only b is given)');
            }

            // Structural: Revit's own Yes/No if the element has it, otherwise its category.
            const flag = values['Structural.Structural'];
            const isStructural = flag === 'Yes' ? 1 : flag === 'No' ? 0 : /^structural /i.test(category || '') ? 1 : 0;
            note(category, 'is_structural', flag === 'Yes' || flag === 'No' ? 'Structural.Structural' : 'computed: from the category');

            const klass = materialClass(row.material);
            if (klass) note(category, 'material_class', 'computed: from material');

            // Weight: weight per metre x length, when both are known.
            let weight = null;
            if (row.weight_kg_per_m !== null && row.length_m !== null) {
                weight = round(row.weight_kg_per_m * row.length_m, 3);
                derived.push('weight_kg');
                note(category, 'weight_kg', 'computed: weight per metre x length');
            }

            const section = row.width_mm !== null && row.depth_mm !== null
                ? `${round(row.width_mm, 1)} x ${round(row.depth_mm, 1)} mm` : null;

            insert.run(
                element.objectid, element.external_id, element.clean_name, category,
                values['Element.Family'] ?? null, values['Element.Type'] ?? null,
                row.level, row.top_level, row.mark, row.material, klass, isStructural, row.usage, row.function,
                row.length_m, row.height_m, row.width_mm, row.depth_mm, row.thickness_mm, section,
                row.area_m2, row.volume_m3, row.weight_kg_per_m, weight, derived.join(',') || null
            );
            count++;
        }
        const addSource = db.prepare('INSERT INTO clean_sources VALUES (?, ?, ?, ?)');
        for (const [key, elements] of sources) addSource.run(...key.split('|'), elements);
    })();
    return count;
}

// Heights from the 3D view, for elements that have no height property (columns): the top
// of their box minus the bottom. Called when the page sends positions (spatial.js), which
// is after indexing. Returns the number of heights filled.
function fillHeightsFromPositions(db) {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'elements_clean'").get();
    if (!has) return 0;
    const filled = db.prepare(`
        UPDATE elements_clean
        SET height_m = (SELECT ROUND(p.max_z - p.min_z, 3) FROM positions p WHERE p.objectid = elements_clean.objectid),
            derived = CASE WHEN derived IS NULL THEN 'height_m' ELSE derived || ',height_m' END
        WHERE height_m IS NULL AND category = 'Structural Columns'
          AND objectid IN (SELECT objectid FROM positions WHERE max_z IS NOT NULL AND min_z IS NOT NULL)
    `).run().changes;
    if (filled > 0) {
        db.prepare(`INSERT OR REPLACE INTO clean_sources VALUES ('Structural Columns', 'height_m', 'computed: from the 3D view (top - bottom of its box)', ?)`).run(filled);
    }
    return filled;
}

module.exports = { buildCleanTable, fillHeightsFromPositions, parseMeasure, isPlaceholder, materialClass, RULES, UNITS };

// augmented/hybrid.js
// ===========================================================================
// THE HYBRID PLANNER - two lanes onto the same clean table (augmented/clean.js):
//
//   1. gate      code, 0 tokens: questions the data can't answer (connections, grids,
//                clashes, the selected element...) get an honest answer at once;
//                spacing / distance questions go to the existing spatial code.
//   2. template  code, 0 tokens: PLAIN questions where every word is understood:
//                count, list, total / average, rank (longest...), per X.
//                Filters: one category, one level, one material class.
//   3. sql       OpenAI writes one SQL query (augmented/sqlplanner.js): everything
//                else, and every follow-up ("and on level 2?").
//
// Both lanes run checked SQL on elements_clean and return the same result shape.
// This is the default planner (routes/ask_agent_simple_v2.js); PLANNER=tiered in the
// environment switches back to the tiered planner (augmented/planner.js).
// ===========================================================================

const { toWords, CATEGORY_WORDS, STOPWORDS, NEGATION_WORDS, FOLLOW_UP_OPENERS, BACK_REFERENCES, SPATIAL_WORDS, NUMBER_WORDS } = require('./words');
const { MAX_RETURNED_ELEMENTS } = require('./shared');
const crypto = require('crypto');
const { answerWithSql, checkSql, runChecked, shapeResult, SQL_PROMPT } = require('./sqlplanner');
const { savedMap } = require('./state');

// ---------------------------------------------------------------- 1. the gate
// Questions about things Autodesk's property data doesn't contain. (Words only, never
// "supports" alone: some models have a "Supports" category.)
const NOT_IN_DATA = [
    [/\bconnect(ed|ion|ions|s)?\b|\bsupport(ed|ing)\s+(by|the|on)\b|\bsupports?\s+the\b|\bhost(ed|s)?\b|\bassembl(y|ies)\b|\battached to\b/,
        'connections, supports, hosts and assemblies between elements'],
    [/\bintersect\w*|\boverlap\w*|\bclash\w*|\bcollid\w*/, 'clashes or overlaps between elements'],
    [/\bgrids?\b|\bgrid line/, 'grid lines'],
    [/\b(north|south|east|west)(ern)?\b/, 'the building\'s orientation (north, south...)'],
    // ("Clear the current selection and find..." is a normal question: only "selected" or "this X".)
    [/\bselected\b|\bthis (element|column|beam|wall|floor|door|slab|selection)\b/, 'what is selected in the 3D viewer']
];
const CAN_INSTEAD = 'I can count, list, add up and compare elements by category, level, material, type and size, and measure spacing between elements.';

function gate(question) {
    const lower = question.toLowerCase();
    // First: data that doesn't exist ("closest to the SELECTED beam" can't be answered either).
    const hit = NOT_IN_DATA.find(([pattern]) => pattern.test(lower));
    if (hit) {
        return { lane: 'gate', kind: 'reply', answer: `The model data doesn't include ${hit[1]}, so I can't answer that exactly. ${CAN_INSTEAD}` };
    }
    if (toWords(question).some(word => SPATIAL_WORDS.has(word))) return { lane: 'old' };   // spacing: the existing spatial code
    return null;
}

// ---------------------------------------------------------------- 2. templates
// Everyday words for the clean table's number columns.
const MEASURE_WORDS = {
    length: 'length_m', long: 'length_m',
    area: 'area_m2',
    volume: 'volume_m3',
    weight: 'weight_kg', weigh: 'weight_kg', heavy: 'weight_kg', tonnage: 'weight_kg',
    thickness: 'thickness_mm', thick: 'thickness_mm',
    width: 'width_mm', wide: 'width_mm',
    height: 'height_m', tall: 'height_m',
    depth: 'depth_mm', deep: 'depth_mm'
};
const RANK_COLUMNS = {
    longest: ['length_m', 'desc'], shortest: ['length_m', 'asc'],
    heaviest: ['weight_kg', 'desc'], lightest: ['weight_kg', 'asc'],
    largest: ['volume_m3', 'desc'], biggest: ['volume_m3', 'desc'], smallest: ['volume_m3', 'asc'],
    widest: ['width_mm', 'desc'], narrowest: ['width_mm', 'asc'],
    tallest: ['height_m', 'desc'], thickest: ['thickness_mm', 'desc'], thinnest: ['thickness_mm', 'asc']
};
const MATERIAL_CLASS_WORDS = {
    concrete: 'concrete', steel: 'steel', timber: 'timber', wood: 'timber', wooden: 'timber', lumber: 'timber', softwood: 'timber',
    aluminum: 'aluminium', masonry: 'masonry', brick: 'masonry', glass: 'glass'
};
// Everyday words for Revit's Function values.
const FUNCTION_SYNONYMS = { exterior: ['external', 'outside', 'outer'], interior: ['internal', 'inside', 'inner'] };
// "per level", "by material": the column to group by.
const GROUP_WORDS = { level: 'level', material: 'material', type: 'type', category: 'category', usage: 'usage' };
const SUM_WORDS = new Set(['total', 'sum', 'overall', 'combined', 'together']);
const AVG_WORDS = new Set(['average', 'mean']);
const COUNT_WORDS = new Set(['many', 'number', 'count']);

const COLUMN_UNITS = { length_m: 'm', area_m2: 'm²', volume_m3: 'm³', weight_kg: 'kg', thickness_mm: 'mm', width_mm: 'mm', height_m: 'm', depth_mm: 'mm', weight_kg_per_m: 'kg/m' };
const COLUMN_NAMES = { length_m: 'length', area_m2: 'area', volume_m3: 'volume', weight_kg: 'weight', thickness_mm: 'thickness', width_mm: 'width', height_m: 'height', depth_mm: 'depth', weight_kg_per_m: 'weight per metre' };

// What this model's clean table contains, as word lists for matching (built once per model).
function namesOf(model) {
    if (model.hybridNames) return model.hybridNames;
    const db = model.db;
    const phrases = new Map();   // "structural column" -> { kind, value }
    const add = (text, entry) => {
        const key = toWords(text).join(' ');
        if (!key) return;
        if (!phrases.has(key)) phrases.set(key, []);
        // "Walls" (the category's name) and "wall" (its everyday word) are the same thing, once.
        if (!phrases.get(key).some(e => e.kind === entry.kind && e.value === entry.value)) phrases.get(key).push(entry);
    };
    const categories = db.prepare('SELECT DISTINCT category FROM elements_clean WHERE category IS NOT NULL').all().map(r => r.category);
    for (const category of categories) add(category, { kind: 'category', value: category });
    for (const [category, words] of Object.entries(CATEGORY_WORDS)) {
        if (categories.includes(category)) words.forEach(word => add(word, { kind: 'category', value: category }));
    }
    for (const { level } of db.prepare('SELECT DISTINCT level FROM elements_clean WHERE level IS NOT NULL').all()) add(level, { kind: 'level', value: level });
    const classes = new Set(db.prepare('SELECT DISTINCT material_class c FROM elements_clean WHERE material_class IS NOT NULL').all().map(r => r.c));
    for (const [word, klass] of Object.entries(MATERIAL_CLASS_WORDS)) if (classes.has(klass)) add(word, { kind: 'material', value: klass });
    // Revit's Function ("exterior walls"), plus everyday words for it. Only where the words
    // don't already mean something else ("Foundation" is also a level and a category word).
    const functions = db.prepare('SELECT DISTINCT function FROM elements_clean WHERE function IS NOT NULL').all().map(r => r.function);
    for (const value of functions) {
        const words = [value, ...(FUNCTION_SYNONYMS[value.toLowerCase()] || [])];
        for (const word of words) if (!phrases.has(toWords(word).join(' '))) add(word, { kind: 'function', value });
    }

    // Type and family names, whole ("200UB25.4", "Light Gauge Joists"), unless the same words
    // already mean a category, level or material ("Floor" is also a family name).
    const names = db.prepare('SELECT DISTINCT family, type FROM elements_clean').all();
    // Family names by their own words: "UB" is in "UB-Universal Beams", "HSS" in
    // "HSS-Hollow Structural Section", "chair" in "Chair", "Chair-Breuer", "Chair-Task"...
    // Only words that mean nothing else ("beam", "column", "steel" mean the category / material).
    const taken = new Set([...phrases.keys()].flatMap(key => key.split(' ')));
    const familyWords = new Map();   // word -> Set of family names
    for (const { family } of names) {
        for (const word of new Set(toWords(family || ''))) {
            if (taken.has(word) || STOPWORDS.has(word) || /^\d+$/.test(word) || word.length < 2 || MEASURE_WORDS[word] || RANK_COLUMNS[word]) continue;
            if (!familyWords.has(word)) familyWords.set(word, new Set());
            familyWords.get(word).add(family);
        }
    }
    // Whole type and family names ("200UB25.4", "Light Gauge Joists"), unless the same words
    // already mean a category, level or material ("Floor" is also a family name), or the name
    // is ONE word that other families share ("Chair": "chairs" means all the chair families).
    const addName = (text, kind) => {
        const words = toWords(text);
        const key = words.join(' ');
        if (!key || (phrases.get(key) || []).some(e => ['category', 'level', 'material'].includes(e.kind))) return;
        if (words.length === 1 && (familyWords.get(key)?.size || 0) > 1) return;   // (a TYPE can be called "Chair" too)
        add(text, { kind, value: text });
    };
    for (const { family, type } of names) {
        if (family) addName(family, 'family');
        if (type) addName(type, 'type');
    }
    const longest = Math.max(1, ...[...phrases.keys()].map(key => key.split(' ').length));
    model.hybridNames = { phrases, longest, familyWords };
    return model.hybridNames;
}

// ---------------------------------------------------------------- number comparisons
// "longer than 6 m", "thicker than 200 mm", "over 20 feet", "between 3 and 5 m": read in
// code into a filter on a clean column, the number converted into that column's unit.
const COMPARE_UNITS = [
    // [pattern, kind, how many base units (m, m², m³, kg, kg/m) one is]
    [/^(mm|millimet(er|re)s?)$/, 'length', 0.001], [/^(cm|centimet(er|re)s?)$/, 'length', 0.01],
    [/^(m|met(er|re)s?)$/, 'length', 1], [/^(ft|feet|foot)$/, 'length', 0.3048], [/^(in|inch(es)?)$/, 'length', 0.0254],
    [/^(m2|m²|sq ?m|square met(er|re)s?)$/, 'area', 1], [/^(ft2|ft²|sq ?ft|square f(ee|oo)t)$/, 'area', 0.09290304],
    [/^(m3|m³|cubic met(er|re)s?)$/, 'volume', 1],
    [/^(kg ?\/ ?m|kg per met(er|re)|kg per m)$/, 'linear_mass', 1], [/^(kg|kilos?|kilograms?)$/, 'mass', 1], [/^(t|tonnes?|tons?)$/, 'mass', 1000]
];
const UNIT_TEXT = 'kg ?\\/ ?m|kg per met(?:er|re)|kg per m|mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|met(?:er|re)s?|m2|m²|m3|m³|sq ?m|sq ?ft|square met(?:er|re)s?|square f(?:ee|oo)t|cubic met(?:er|re)s?|ft2|ft²|ft|feet|foot|inch(?:es)?|in|kg|kilos?|kilograms?|tonnes?|tons?|t|m';
const COMPARATIVE_COLUMNS = { longer: ['length_m', '>'], shorter: ['length_m', '<'], wider: ['width_mm', '>'], narrower: ['width_mm', '<'],
    taller: ['height_m', '>'], thicker: ['thickness_mm', '>'], thinner: ['thickness_mm', '<'], deeper: ['depth_mm', '>'], shallower: ['depth_mm', '<'],
    heavier: [null, '>'], lighter: [null, '<'] };
const GENERIC_COMPARATIVES = { larger: '>', bigger: '>', greater: '>', more: '>', over: '>', above: '>', exceeding: '>',
    smaller: '<', less: '<', under: '<', below: '<', 'at least': '>=', 'at most': '<=' };
const COMPARE_RE = new RegExp(`\\b(${[...Object.keys(COMPARATIVE_COLUMNS), ...Object.keys(GENERIC_COMPARATIVES)].join('|')})(?:\\s+than)?\\s+(\\d+(?:\\.\\d+)?)\\s*(${UNIT_TEXT})(?![a-z0-9])`, 'g');
const BETWEEN_RE = new RegExp(`\\bbetween\\s+(\\d+(?:\\.\\d+)?)\\s*(?:${UNIT_TEXT})?\\s+(?:and|to)\\s+(\\d+(?:\\.\\d+)?)\\s*(${UNIT_TEXT})(?![a-z0-9])`, 'g');

function unitOf(text) {
    const unit = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
    const found = COMPARE_UNITS.find(([pattern]) => pattern.test(unit));
    return found ? { kind: found[1], factor: found[2] } : null;
}
// Which clean column a comparison is about: the comparative says it ("thicker"), or a measure
// word in the question ("width greater than"), or the unit (m² = area). A plain "over 300 mm"
// with no measure named is NOT guessed (width? length? depth?): null, and OpenAI decides.
function comparedColumn(word, unit, text) {
    if (COMPARATIVE_COLUMNS[word]?.[0]) return COMPARATIVE_COLUMNS[word][0];
    if (unit.kind === 'linear_mass') return 'weight_kg_per_m';
    if (unit.kind === 'mass') return 'weight_kg';
    if (unit.kind === 'area') return 'area_m2';
    if (unit.kind === 'volume') return 'volume_m3';
    const named = toWords(text).map(w => MEASURE_WORDS[w]).filter(Boolean);
    if (new Set(named).size === 1) return named[0];
    if (new Set(named).size > 1) return null;
    return unit.factor >= 0.3 ? 'length_m' : null;   // "beams over 6 m / 20 ft": a length; "over 300 mm": unclear
}
// "6 m" for column length_m -> 6; "200 mm" for thickness_mm -> 200; "20 ft" -> 6.096.
const inColumnUnit = (value, unit, column) => Math.round(value * unit.factor * (column.endsWith('_mm') ? 1000 : 1) * 1e6) / 1e6;
const KIND_OF_COLUMN = { length_m: 'length', height_m: 'length', width_mm: 'length', depth_mm: 'length', thickness_mm: 'length',
    area_m2: 'area', volume_m3: 'volume', weight_kg: 'mass', weight_kg_per_m: 'linear_mass' };

// Returns { comparisons: [{ column, op, value }], rest: the question without them } or null
// when a comparison is there but can't be read for certain.
function readComparisons(question) {
    const lower = String(question).toLowerCase();
    const comparisons = [];
    let unclear = false;
    let rest = lower.replace(BETWEEN_RE, (all, low, high, unitText) => {
        const unit = unitOf(unitText);
        const column = unit && comparedColumn(null, unit, lower);
        if (!column || KIND_OF_COLUMN[column] !== unit.kind) { unclear = true; return all; }
        comparisons.push({ column, op: '>=', value: inColumnUnit(Number(low), unit, column) }, { column, op: '<=', value: inColumnUnit(Number(high), unit, column) });
        return ' ';
    });
    rest = rest.replace(COMPARE_RE, (all, word, value, unitText) => {
        const unit = unitOf(unitText);
        const column = unit && comparedColumn(word, unit, lower);
        if (!column || KIND_OF_COLUMN[column] !== unit.kind) { unclear = true; return all; }
        comparisons.push({ column, op: COMPARATIVE_COLUMNS[word]?.[1] || GENERIC_COMPARATIVES[word], value: inColumnUnit(Number(value), unit, column) });
        return ' ';
    });
    return unclear ? null : { comparisons, rest };
}

// Reads a PLAIN question into { form, category, level, material, type, family, families,
// comparisons, measure, groupBy, rank } or null if any word is left unexplained (then OpenAI
// decides). Plain = no "not / except / or", at most one category, level, material, type and
// family, and number comparisons code can read for certain.
function readPlain(question, model) {
    const compared = readComparisons(question);
    if (!compared) return null;
    const comparedColumns = compared.comparisons.map(c => c.column);
    const words = toWords(compared.rest);
    if (words.some(word => NEGATION_WORDS.has(word)) || words.includes('or') || words.includes('than')) return null;
    const { phrases, longest, familyWords } = namesOf(model);
    const found = { category: [], level: [], material: [], type: [], family: [], function: [] };
    const familyHints = [];   // Sets of families, one per family word ("ub")
    let measure = null, groupBy = null, rank = null, aggregate = null, counting = false;

    for (let i = 0; i < words.length;) {
        // A known name, longest first ("top of parapet" before "top").
        let matched = false;
        for (let n = Math.min(longest, words.length - i); n >= 1 && !matched; n--) {
            const phrase = words.slice(i, i + n).join(' ');
            if (n === 1 && STOPWORDS.has(phrase)) continue;
            let entries = phrases.get(phrase);
            if (!entries) continue;
            // A family and a type with the same name ("Curtain Wall"): if every element of that
            // type is in that family, the family is the broader, intended meaning.
            if (entries.length === 2 && entries.some(e => e.kind === 'family') && entries.some(e => e.kind === 'type') &&
                entries[0].value === entries[1].value &&
                model.db.prepare('SELECT COUNT(*) n FROM elements_clean WHERE type = ? AND (family IS NULL OR family <> ?)').get(entries[0].value, entries[0].value).n === 0) {
                entries = entries.filter(e => e.kind === 'family');
            }
            if (entries.length > 1) return null;   // e.g. "foundation" = a category AND a level: OpenAI decides
            found[entries[0].kind].push(entries[0].value);
            i += n;
            matched = true;
        }
        if (matched) continue;

        const word = words[i];
        const next = words[i + 1];
        if (RANK_COLUMNS[word]) {
            if (rank) return null;
            rank = { word, column: RANK_COLUMNS[word][0], order: RANK_COLUMNS[word][1], limit: null };
            const before = words[i - 1];
            const number = /^\d+$/.test(before) ? before : NUMBER_WORDS[before];
            if (number) rank.limit = Number(number);
        } else if (word === 'top' && (/^\d+$/.test(next) || NUMBER_WORDS[next])) {
            words[i + 1] = 'the';   // "top 5 longest": the number belongs to the rank word
            rank = rank || { column: null, order: 'desc', limit: null };
            rank.limit = Number(/^\d+$/.test(next) ? next : NUMBER_WORDS[next]);
        } else if (/^\d+$/.test(word) && RANK_COLUMNS[next]) {
            // the "5" of "5 longest": read with the rank word
        } else if (['per', 'by', 'each'].includes(word) && GROUP_WORDS[next]) {
            if (groupBy) return null;
            groupBy = GROUP_WORDS[next];
            i++;   // the group word is used up
        } else if (GROUP_WORDS[word] && (words[i - 1] === 'what' || words[i - 1] === 'which' || words.includes('used') || words[i - 1] === 'different')) {
            // "what levels / materials / types are there", "what materials are used"
            if (groupBy) return null;
            groupBy = GROUP_WORDS[word];
        } else if (MEASURE_WORDS[word] && comparedColumns.includes(MEASURE_WORDS[word]) && !SUM_WORDS.has(words[i - 1]) && !AVG_WORDS.has(words[i - 1])) {
            // the "length" of "with a length greater than 6 m", or "6 m LONG": part of the comparison
        } else if (MEASURE_WORDS[word]) {
            if (measure && measure !== MEASURE_WORDS[word]) return null;
            measure = MEASURE_WORDS[word];
        } else if (familyWords.has(word)) {
            familyHints.push(familyWords.get(word));
        } else if (SUM_WORDS.has(word)) {
            aggregate = 'sum';
        } else if (AVG_WORDS.has(word)) {
            aggregate = 'avg';
        } else if (COUNT_WORDS.has(word)) {
            counting = true;
        } else if (!STOPWORDS.has(word) && !['different', 'used', 'types', 'kind', 'kinds'].includes(word)) {
            return null;   // a word code doesn't understand: OpenAI decides
        }
        i++;
    }

    if (Object.values(found).some(list => list.length > 1)) return null;
    const filters = {
        category: found.category[0] || null, level: found.level[0] || null, material: found.material[0] || null,
        type: found.type[0] || null, family: found.family[0] || null, families: null, comparisons: compared.comparisons,
        function: found.function[0] || null
    };
    // Family words ("UB", "HSS"): the families that contain ALL of them, within the category.
    if (familyHints.length > 0) {
        if (filters.family || filters.type) return null;
        let families = [...familyHints[0]].filter(f => familyHints.every(set => set.has(f)));
        if (filters.category) {
            const inCategory = new Set(model.db.prepare('SELECT DISTINCT family FROM elements_clean WHERE category = ?').all(filters.category).map(r => r.family));
            families = families.filter(f => inCategory.has(f));
        }
        if (families.length === 0) return null;   // nothing fits: OpenAI decides (and can say so)
        // Families in several categories ("toilet": the toilets AND the toilet partitions) are
        // ambiguous unless the question names the category: OpenAI decides what was meant.
        if (!filters.category) {
            const categories = model.db.prepare(`SELECT DISTINCT category FROM elements_clean WHERE family IN (${families.map(() => '?').join(', ')})`).all(...families);
            if (categories.length > 1) return null;
        }
        filters.families = families;
    }
    const hasFilter = filters.category || filters.level || filters.material || filters.type || filters.family || filters.families ||
        filters.function || filters.comparisons.length;

    if (rank) {
        // "the door with the largest WIDTH": a size word ranks by the measure the question names.
        if (measure && ['largest', 'biggest', 'smallest'].includes(rank.word)) rank.column = measure;
        rank.column = rank.column || measure;
        if (!rank.column || groupBy || aggregate) return null;
        return { form: 'rank', ...filters, rank };
    }
    if (aggregate) {
        if (!measure) return null;   // "total of the beams": total of what? OpenAI asks
        return { form: aggregate, ...filters, measure, groupBy };
    }
    if (groupBy) {
        if (measure) return null;
        return { form: 'group', ...filters, groupBy };
    }
    if (measure) return null;   // "how long are the beams": a measure without total/rank, OpenAI decides
    if (counting) return { form: 'count', ...filters };
    if (!hasFilter) return null;   // "show me" alone
    return { form: 'list', ...filters };
}

// "concrete Walls on Level 2", "UB-Universal Beams Structural Framing longer than 6 m"
const OP_WORDS = { '>': 'over', '<': 'under', '>=': 'at least', '<=': 'at most' };
function describe(read) {
    const several = read.families?.length > 1 ? read.families : null;
    const name = read.type || read.family || (read.families?.length === 1 ? read.families[0] : null);
    const what = [read.function?.toLowerCase(), read.material, name, read.category || (name ? null : 'elements')].filter(Boolean).join(' ');
    const sizes = (read.comparisons || []).map(c => `${COLUMN_NAMES[c.column]} ${OP_WORDS[c.op]} ${quantity(c.value, c.column)}`);
    // "elements of 3 families (Pile Cap-2 Pile, Pile Cap-3 Pile, ...)"
    const of = several ? ` of ${several.length} families (${several.slice(0, 3).join(', ')}${several.length > 3 ? ', ...' : ''})` : '';
    return `${what}${of}${read.level ? ` on ${read.level}` : ''}${sizes.length ? ` with ${sizes.join(' and ')}` : ''}`;
}
const number = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 3 });
function quantity(value, column) {
    const unit = COLUMN_UNITS[column];
    let text = `${number(value)} ${unit}`;
    if (unit === 'kg' && Math.abs(value) >= 1000) text += ` (${number(value / 1000)} t)`;
    if (unit === 'mm' && Math.abs(value) >= 1000) text += ` (${number(value / 1000)} m)`;
    return text;
}

// The SQL of a plain question: { sql, params, answer(rows) }.
function buildTemplate(read, db) {
    const where = [];
    const params = [];
    if (read.category) { where.push('category = ?'); params.push(read.category); }
    if (read.level) { where.push('level = ?'); params.push(read.level); }
    if (read.material) { where.push('material_class = ?'); params.push(read.material); }
    if (read.function) { where.push('function = ?'); params.push(read.function); }
    if (read.type) { where.push('type = ?'); params.push(read.type); }
    if (read.family) { where.push('family = ?'); params.push(read.family); }
    if (read.families) { where.push(`family IN (${read.families.map(() => '?').join(', ')})`); params.push(...read.families); }
    for (const c of read.comparisons || []) {
        // "columns shorter than 3 m": columns have a height, not a length (as for ranking).
        let column = c.column;
        const swap = { length_m: 'height_m', height_m: 'length_m' }[column];
        if (swap && read.category && !db.prepare(`SELECT 1 FROM elements_clean WHERE category = ? AND ${column} IS NOT NULL LIMIT 1`).get(read.category) &&
            db.prepare(`SELECT 1 FROM elements_clean WHERE category = ? AND ${swap} IS NOT NULL LIMIT 1`).get(read.category)) column = swap;
        // A category without this measure at all: say so instead of a misleading "0 found".
        if (read.category && !db.prepare(`SELECT 1 FROM elements_clean WHERE category = ? AND ${column} IS NOT NULL LIMIT 1`).get(read.category)) {
            return { sql: null, params: [], kind: 'reply', answer: `${read.category} in this model have no ${COLUMN_NAMES[column]} value, so they can't be compared by ${COLUMN_NAMES[column]}.` };
        }
        where.push(`${column} ${c.op} ?`);
        params.push(c.value);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const and = extra => (where.length ? `${whereSql} AND ${extra}` : `WHERE ${extra}`);
    const subject = describe(read);

    switch (read.form) {
        case 'count':
        case 'list': {
            const sql = `SELECT objectid FROM elements_clean ${whereSql} ORDER BY level, objectid`;
            const ids = db.prepare(sql).all(...params).map(r => r.objectid);
            // "30 Structural Columns", but "1 element (Structural Columns on Level 1)"
            const amount = ids.length === 1 ? `1 element (${subject})` : `${ids.length} ${subject}`;
            const answer = read.form === 'count'
                ? `There ${ids.length === 1 ? 'is' : 'are'} ${amount}.`
                : `Found ${amount}.`;
            return { sql, params, ids, count: ids.length, answer, kind: 'elements' };
        }
        case 'sum':
        case 'avg': {
            const fn = read.form === 'sum' ? 'SUM' : 'AVG';
            const label = `${read.form === 'sum' ? 'Total' : 'Average'} ${COLUMN_NAMES[read.measure]}`;
            const group = read.groupBy ? `${read.groupBy}` : null;
            const sql = group
                ? `SELECT COALESCE(${group}, '(not set)') AS value, ${fn}(${read.measure}) AS total, COUNT(${read.measure}) AS measured FROM elements_clean ${whereSql} GROUP BY 1 ORDER BY total DESC`
                : `SELECT ${fn}(${read.measure}) AS total, COUNT(${read.measure}) AS measured, COUNT(*) AS n FROM elements_clean ${whereSql}`;
            const rows = db.prepare(sql).all(...params);
            const measured = rows.reduce((s, r) => s + r.measured, 0);
            const n = group ? db.prepare(`SELECT COUNT(*) n FROM elements_clean ${whereSql}`).get(...params).n : rows[0].n;
            if (measured === 0) {
                return { sql, params, kind: 'reply', answer: `${subject[0].toUpperCase()}${subject.slice(1)} in this model have no ${COLUMN_NAMES[read.measure]} value.` };
            }
            const overall = group ? db.prepare(`SELECT ${fn}(${read.measure}) t FROM elements_clean ${whereSql}`).get(...params).t : rows[0].total;
            let answer = `${label} of the ${measured} ${subject}: ${quantity(overall, read.measure)}.`;
            if (measured < n) answer += ` ${n - measured} more have no ${COLUMN_NAMES[read.measure]} and are not included.`;
            if (group) answer += '\n' + rows.filter(r => r.measured > 0).slice(0, 50).map(r => `• ${r.value}: ${quantity(r.total, read.measure)}`).join('\n');
            return { sql, params, kind: 'table', answer, rows, value: overall };
        }
        case 'rank': {
            const { order, limit } = read.rank;
            let { column } = read.rank;
            // "The shortest column": columns have a height, not a length (and the other way round).
            const hasValues = col => db.prepare(`SELECT 1 FROM elements_clean ${and(`${col} IS NOT NULL`)} LIMIT 1`).get(...params);
            // "The heaviest columns": no total weight without a length, but the weight per metre is there.
            const swap = { length_m: 'height_m', height_m: 'length_m', weight_kg: 'weight_kg_per_m' }[column];
            if (swap && !hasValues(column) && hasValues(swap)) column = swap;
            const extreme = order === 'desc' ? 'MAX' : 'MIN';
            // No number: every element sharing the top value ("the longest beam" may be 3 tied ones).
            const sql = limit
                ? `SELECT objectid, ${column} AS value FROM elements_clean ${and(`${column} IS NOT NULL`)} ORDER BY ${column} ${order.toUpperCase()}, objectid LIMIT ${limit}`
                : `SELECT objectid, ${column} AS value FROM elements_clean ${and(`${column} = (SELECT ${extreme}(${column}) FROM elements_clean ${and(`${column} IS NOT NULL`)})`)} ORDER BY objectid`;
            const rows = db.prepare(sql).all(...(limit ? params : [...params, ...params]));
            if (rows.length === 0) {
                return { sql, params, kind: 'reply', answer: `${subject[0].toUpperCase()}${subject.slice(1)} in this model have no ${COLUMN_NAMES[column]} value.` };
            }
            const word = order === 'desc' ? 'greatest' : 'smallest';
            const answer = limit
                ? `The ${rows.length} ${subject} with the ${word} ${COLUMN_NAMES[column]}: from ${quantity(rows[0].value, column)} to ${quantity(rows[rows.length - 1].value, column)}.`
                : `${rows.length === 1 ? '1 element has' : `${rows.length} elements share`} the ${word} ${COLUMN_NAMES[column]} of the ${subject}: ${quantity(rows[0].value, column)}.`;
            return { sql, params, kind: 'elements', ids: rows.map(r => r.objectid), count: rows.length, answer, values: rows, valueColumn: column };
        }
        case 'group': {
            const sql = `SELECT COALESCE(${read.groupBy}, '(not set)') AS value, COUNT(*) AS count FROM elements_clean ${whereSql} GROUP BY 1 ORDER BY count DESC`;
            const rows = db.prepare(sql).all(...params);
            const answer = `${subject[0].toUpperCase()}${subject.slice(1)} by ${read.groupBy}:\n` + rows.slice(0, 50).map(r => `• ${r.value}: ${r.count}`).join('\n');
            return { sql, params, kind: 'table', answer, rows };
        }
        default:
            return null;
    }
}

// ---------------------------------------------------------------- 3. the whole flow
// A question that refines the previous answer: "and on level 2?", "how many remain?", or one
// that starts by changing the result: "exclude the C1 columns", "keep only the concrete ones".
const REFINE_STARTS = new Set(['exclude', 'excluding', 'remove', 'without', 'except', 'keep', 'filter', 'highlight', 'isolate', 'sort', 'add', 'include', 'drop']);
const isFollowUpQuestion = question => {
    const words = toWords(question);
    const first = String(question).trim().toLowerCase().split(/\s+/)[0];
    return FOLLOW_UP_OPENERS.has(words[0]) || REFINE_STARTS.has(first) ||
        words.some(word => BACK_REFERENCES.has(word) || ['remain', 'remaining', 'left', 'rest'].includes(word));
};

// ---------------------------------------------------------------- the plan cache
// The SQL OpenAI wrote for a question, saved and reused when the same question is asked
// again (by anyone, on the same model): then it's free, instant and the same every time.
// The SQL runs again each time, so the numbers are always current. Kept 30 days, on disk
// with DATA_DIR (augmented/state.js). The key holds:
//   - the model and when its index was built (a new upload = new answers)
//   - a fingerprint of the SQL prompt (a changed prompt = new answers)
//   - the question's words ("Walls thicker than 200mm?" = "wall thicker than 200 mm")
// Follow-ups are never cached: they depend on the conversation. A 👎 removes the entry
// (routes/ask_agent_simple_v2.js POST /feedback), so a bad query isn't repeated.
const planCache = savedMap('plancache', { maxAgeMs: 30 * 24 * 60 * 60 * 1000 });
const PROMPT_VERSION = crypto.createHash('sha1').update(SQL_PROMPT).digest('hex').slice(0, 8);
function cacheKey(model, question) {
    if (model.cleanBuiltAt === undefined) {
        model.cleanBuiltAt = model.db.prepare("SELECT value FROM meta WHERE key = 'built_at'").get()?.value || 'unknown';
    }
    return `${model.key || 'model'}|${model.cleanBuiltAt}|${PROMPT_VERSION}|${toWords(question).join(' ')}`;
}
const forgetCachedPlan = key => planCache.delete(key);

// Answers one question. `previous` = { question, sql } of the last answer on this sheet.
// Returns { lane, kind, answer, ids, count, sql, reading, calls, followUp, cacheKey } or
// { lane: 'old' } (spacing questions: the route then uses the tiered planner's spatial code).
// Lanes: gate | template | cache | sql.
async function answerHybrid(question, model, previous = null) {
    const gated = gate(question);
    if (gated) return { ids: [], calls: [], ...gated };

    const followUp = Boolean(previous) && isFollowUpQuestion(question);
    if (followUp) {
        return { lane: 'sql', followUp, ...(await answerWithSql(question, model, previous)) };
    }

    const read = readPlain(question, model);
    const template = read && buildTemplate(read, model.db);
    if (template) return { lane: 'template', ids: [], calls: [], reading: null, ...template, read };

    const key = cacheKey(model, question);
    const cached = planCache.get(key);
    if (cached?.reply) return { lane: 'cache', kind: 'reply', ids: [], calls: [], answer: cached.reply, cacheKey: key };
    if (cached?.sql) {
        const checked = checkSql(model.db, cached.sql);   // checked again: the cache is data, not trusted code
        if (checked.stmt) {
            const { rows, columns, total } = runChecked(model.db, checked);
            return { lane: 'cache', calls: [], ...shapeResult(rows, cached.reading, columns, total),
                sql: checked.sql, reading: cached.reading, cacheKey: key };
        }
        planCache.delete(key);   // no longer valid: ask OpenAI again
    }

    const result = await answerWithSql(question, model, null);
    if (result.sql) planCache.set(key, { sql: result.sql, reading: result.reading || null });
    else if (result.kind === 'reply') planCache.set(key, { reply: result.answer });   // not "clarify": the user may rephrase
    return { lane: 'sql', followUp: false, ...result, cacheKey: key };
}

// The element list the page shows (same shape as the tiered planner's): at most
// MAX_RETURNED_ELEMENTS, with externalId so SVF2 viewers can find them.
function elementsMessage(db, ids, values = null, valueColumn = null) {
    const shown = ids.slice(0, MAX_RETURNED_ELEMENTS);
    const byId = new Map(shown.length ? db.prepare(`SELECT objectid, external_id, name FROM elements_clean WHERE objectid IN (${shown.map(() => '?').join(', ')})`)
        .all(...shown).map(row => [row.objectid, row]) : []);
    const valueOf = new Map((values || []).map(v => [v.objectid, v.value]));
    return {
        count: ids.length,
        elements: shown.map(id => ({ id, externalId: byId.get(id)?.external_id ?? null, name: byId.get(id)?.name ?? String(id),
            value: valueOf.get(id) ?? null, unit: valueColumn ? COLUMN_UNITS[valueColumn] : null }))
    };
}

module.exports = { answerHybrid, readPlain, readComparisons, buildTemplate, gate, elementsMessage, isFollowUpQuestion, namesOf, forgetCachedPlan, cacheKey };

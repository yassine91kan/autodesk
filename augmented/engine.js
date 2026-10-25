// augmented/engine.js
// ===========================================================================
// 4. QUERY ENGINE - plain JavaScript, no AI:
//   validatePlan  checks every name and value of a plan against the REAL model
//   runPlan       turns the checked plan into SQL and writes the answer
// If an answer is wrong, look at the plan: bad plan = matcher/LLM problem,
// good plan = a problem here.
// ===========================================================================

const {
    LENGTH_PATH, VOLUME_PATH, WEIGHT_PATH, LEVEL_PATHS, TOP_LEVEL_PATHS, MAX_RETURNED_ELEMENTS, MAX_GROUPS,
    toArray, label, labels, placeholders, escapeLike
} = require('./shared');
const {
    getCoordinates
} = require('./store');
const {
    MATERIAL_WORDS
} = require('./words');
const { getPositions, distance, nearestNeighbours, LONG_CATEGORIES } = require('./spatial');

const ACTIONS = new Set(['list', 'count', 'group', 'rank', 'total', 'spatial', 'coordinates', 'clarify', 'reply']);
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

// "12", "12 mm", "6000.5" -> a number with an optional unit word after it.
// (Units may contain "/": "25.4 kg/m", "12.5 kgf/m".)
const NUMBER_WITH_UNIT = /^-?\d+(?:\.\d+)?\s*[a-z°²³^0-9/]*$/i;

// If any of the paths is a level property, add every level property this model has.
function withAllLevelPaths(paths, allPaths) {
    if (!paths.some(path => LEVEL_PATHS.includes(path))) {
        return paths;
    }
    const extra = LEVEL_PATHS.filter(path => allPaths.has(path));
    return [...new Set([...paths, ...extra])] // a Set removes duplicates
        .filter(path => !TOP_LEVEL_PATHS.includes(path));
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

    // These two need no database work: the LLM already wrote the text. Property paths it
    // copied from the prompt ("Dimensions.Elevation at Top") become plain names ("Elevation at Top").
    if (plan.action === 'clarify' || plan.action === 'reply') {
        let message = String(plan.message || '');
        for (const path of vocabulary.allPaths) {
            if (message.includes(path)) message = message.split(path).join(label(path));
        }
        return { ok: true, plan: { action: plan.action, message } };
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

    // Asked about a property the category doesn't have ("how tall are the COLUMNS": only
    // walls have Unconnected Height): say so, and name what it does have. kind 'final' =
    // a complete answer, so even tier 0 stops here instead of asking the LLM.
    function notInCategory(paths) {
        if (!category || paths.length === 0) return null;
        const usedBy = path => vocabulary.properties.find(p => p.path === path)?.usedBy || [];
        if (paths.some(path => usedBy(path).includes(category))) return null;
        // Related = what the category DOES have that a size depends on: its Constraints first
        // (levels and offsets: "Base Level, Top Level, Base Offset, Top Offset" for columns),
        // and Dimensions only if there are hardly any (a steel profile's "Clear Web Height"
        // isn't what someone asking how tall a column is wants to see).
        const SIZE_LIKE = /level|offset|elevation|height|length|width|depth|thickness/i;
        const ofGroup = group => vocabulary.properties
            .filter(p => p.usedBy.includes(category) && p.path.startsWith(group) && SIZE_LIKE.test(label(p.path)))
            .map(p => label(p.path));
        const constraints = ofGroup('Constraints.');
        const related = (constraints.length >= 2 ? constraints : [...constraints, ...ofGroup('Dimensions.')]).slice(0, 6);
        // A height between two levels could be worked out from the levels' elevations, but
        // only if the model data has them (a "Levels" category); say why it can't, if not.
        const between = constraints.some(l => /^base/i.test(l)) && constraints.some(l => /^top/i.test(l));
        const noElevations = !vocabulary.categories.some(c => c.name === 'Levels');
        const why = /height/i.test(labels(paths)) && between && noElevations
            ? ' It can\'t be worked out either: their height is set by their base and top levels, and the model data has no level elevations.'
            : '';
        return ask(`${category} in this model have no ${labels(paths)} value.${why}` +
            (related.length ? ` What they do have: ${related.join(', ')}.` : ''), 'final');
    }
    if (Array.isArray(groupBy)) {
        const missing = notInCategory(groupBy);
        if (missing) return missing;
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
        const missing = notInCategory(sortBy.paths);
        if (missing) return missing;
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

    // Distances: two element ids, or the spacing of the set the category + filters give.
    if (plan.action === 'spatial') {
        if (plan.kind === 'between') {
            const elementIds = toArray(plan.elementIds).map(Number).filter(Number.isInteger);
            if (elementIds.length !== 2) return ask('Distance between which two elements? Give their ids, e.g. "distance between 3493 and 3902".');
            return { ok: true, plan: { action: 'spatial', kind: 'between', elementIds } };
        }
        if (!category && filters.length === 0) {
            return ask('Distance between which elements? Name them, e.g. "distance between the columns on level 1".');
        }
        return { ok: true, plan: { action: 'spatial', kind: 'spacing', category, filters } };
    }

    if (plan.action === 'total') {
        const aggregate = AGGREGATES.has(plan.aggregate) ? plan.aggregate : 'sum';
        // "weight" is worked out (see weighElements): from weight per metre x length, or
        // estimated from volume x a typical density. One of the two must be possible.
        // (Adding up Nominal Weight itself would add kg PER METRE, which means nothing.)
        if (plan.measure === 'weight' || (toArray(plan.measure).includes(WEIGHT_PATH) && aggregate === 'sum')) {
            const perMetre = [WEIGHT_PATH, LENGTH_PATH].every(path => vocabulary.allPaths.has(path));
            if (!perMetre && !vocabulary.allPaths.has(VOLUME_PATH)) {
                return ask('I can\'t work out weights in this model: it has neither a weight per metre nor volumes.');
            }
            return { ok: true, plan: { action: 'total', category, filters, measure: 'weight', aggregate, groupBy } };
        }
        const measure = numberPaths(plan.measure, 'add up');
        if (measure.question) return ask(measure.question, measure.kind);
        const missing = notInCategory(measure.paths);
        if (missing) return missing;
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

// Volume unit text -> cubic metres.
const CUBIC_METRES_PER = { 'm^3': 1, 'm³': 1, 'ft^3': 0.0283168, 'cm^3': 1e-6, 'mm^3': 1e-9, 'in^3': 1.6387e-5 };

// Typical densities (kg/m³), used ONLY to estimate a weight when the model doesn't
// give one: Revit exports no densities. The first word found in the material name wins.
// Every answer that uses them says "estimated" and lists the densities it used.
// [word looked for, density, name shown in the answer]
const TYPICAL_DENSITIES = [
    ['concrete', 2400, 'concrete'], ['steel', 7850, 'steel'], ['metal', 7850, 'steel'], ['alumin', 2700, 'aluminium'],
    ['softwood', 500, 'timber'], ['timber', 500, 'timber'], ['wood', 500, 'timber'], ['lumber', 500, 'timber'],
    ['brick', 1900, 'masonry'], ['masonry', 1900, 'masonry'], ['glass', 2500, 'glass']
];
function typicalDensity(material) {
    const text = String(material || '').toLowerCase();
    const found = TYPICAL_DENSITIES.find(([word]) => text.includes(word));
    return found ? { word: found[2], density: found[1] } : null;
}

// Each matching element's material name (structural material first).
function materialsOf(db, plan) {
    const { where, params } = buildWhere(plan);
    return new Map(db.prepare(`
        SELECT e.objectid, (SELECT m.value FROM properties m WHERE m.objectid = e.objectid
            AND m.path IN ('Materials and Finishes.Structural Material', 'Materials and Finishes.Material') LIMIT 1) AS material
        FROM elements e ${where}
    `).all(...params).map(row => [row.objectid, row.material]));
}

// A weight in kg for each matching element, worked out in one of two ways:
//   'per-metre'  Revit stores a steel section's weight PER METRE ("Nominal Weight",
//                kgf/m): member weight = Nominal Weight x Length. Exact.
//   'estimate'   otherwise: Volume x a typical density for its material (concrete
//                2,400 kg/m³ ...). An ESTIMATE, and every answer says so.
// Returns rows like measureElements, with number = kg (null if neither works) and source.
function weighElements(db, plan, groupBy = null) {
    const weights = measureElements(db, plan, [WEIGHT_PATH], groupBy);
    const lengths = new Map(measureElements(db, plan, [LENGTH_PATH]).map(row => [row.objectid, row]));
    const volumes = new Map(measureElements(db, plan, [VOLUME_PATH]).map(row => [row.objectid, row]));
    const materials = materialsOf(db, plan);
    return weights.map(row => {
        const length = lengths.get(row.objectid);
        const perMetre = KG_PER_METRE[String(row.unit).toLowerCase()];
        const metres = METRES_PER[String(length?.unit).toLowerCase()];
        if (row.number !== null && length?.number != null && perMetre && metres) {
            return { ...row, number: row.number * perMetre * length.number * metres, unit: 'kg', source: 'per-metre' };
        }
        const volume = volumes.get(row.objectid);
        const cubicMetres = CUBIC_METRES_PER[String(volume?.unit)];
        const typical = typicalDensity(materials.get(row.objectid));
        if (volume?.number != null && cubicMetres && typical) {
            return { ...row, number: volume.number * cubicMetres * typical.density, unit: 'kg', source: 'estimate', densityWord: typical.word, density: typical.density };
        }
        return { ...row, number: null, unit: 'kg', source: null };
    });
}

// "6,933.3 kg from the weight per metre of 60 steel members; 518,100 kg estimated from
// volume x typical density (concrete 2,400 kg/m³) for 17 elements"
function describeWeightSources(measured) {
    const sum = list => list.reduce((total, row) => total + row.number, 0);
    const exact = measured.filter(row => row.source === 'per-metre');
    const estimated = measured.filter(row => row.source === 'estimate');
    const parts = [];
    if (exact.length) parts.push(`${formatQuantity(sum(exact), 'kg')} from the weight per metre x length of ${exact.length} members`);
    if (estimated.length) {
        const used = [...new Map(estimated.map(row => [row.densityWord, row.density]))]
            .map(([word, density]) => `${word} ${density.toLocaleString('en-US')} kg/m³`).join(', ');
        parts.push(`${formatQuantity(sum(estimated), 'kg')} ESTIMATED from the volume of ${estimated.length} elements x a typical density (${used})`);
    }
    return parts.join('; ');
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
            const estimated = isWeight && measured.some(row => row.source === 'estimate');
            const title = `${estimated ? 'Estimated ' + AGGREGATE_LABELS[plan.aggregate].toLowerCase() : AGGREGATE_LABELS[plan.aggregate]} ${what}`;

            if (measured.length === 0) {
                const answer = rows.length === 0
                    ? `No ${describe(plan)} found.`
                    : `None of the ${rows.length} ${describe(plan)} has a ${isWeight ? 'weight per metre or a volume with a known material' : what} value.`;
                return { answer, objectIds: [], data: { ...elementData(rows, rows.length), totals: [], groups: [] } };
            }

            // "258,448.1 mm (258.448 m)", or one part per unit if the values use several units.
            const totals = aggregateByUnit(measured, plan.aggregate);
            const shown = totals.length === 1
                ? formatQuantity(totals[0].value, totals[0].unit)
                : totals.map(t => `${formatQuantity(t.value, t.unit)} (${t.count} elements)`).join('; ');
            // Weights say where each part comes from, in the answer itself, not in small print:
            // "6,933 kg" alone read as the weight of the whole model when it was only the steel.
            let answer = isWeight
                ? `${title} of ${measured.length} of the ${rows.length} ${describe(plan)}: ${shown}. ${describeWeightSources(measured)}.`
                : `${title} of the ${measured.length} ${describe(plan)}: ${shown}.`;
            if (rows.length > measured.length) {
                answer += isWeight
                    ? ` NOT included: ${rows.length - measured.length} elements with neither a weight per metre nor a volume and known material.`
                    : ` ${rows.length - measured.length} more have no ${what} and are not included.`;
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

        case 'spatial': {
            const positions = getPositions(model.db);   // from the model's "positions" table
            if (positions.size === 0) {
                return { answer: 'I don\'t have the element positions of this model yet. They are read from the 3D view ' +
                    'once the model has loaded: wait for it to finish loading, then ask again.', objectIds: [], data: null };
            }
            const metres = value => formatQuantity(Math.round(value * 100) / 100, 'm');

            if (plan.kind === 'between') {
                // The ids people see in the table (objectid), or a Revit id from a name ("Pile Cap [512319]").
                const find = id => model.db.prepare('SELECT objectid, external_id, name, clean_name FROM elements WHERE objectid = ?').get(id) ||
                    model.db.prepare("SELECT objectid, external_id, name, clean_name FROM elements WHERE name LIKE '%[' || ? || ']'").get(String(id));
                const [a, b] = plan.elementIds.map(find);
                const missing = plan.elementIds.find((id, i) => ![a, b][i]);
                if (missing) return { answer: `I couldn't find element ${missing} in this model.`, objectIds: [], data: null };
                if (!positions.has(a.external_id) || !positions.has(b.external_id)) {
                    return { answer: 'One of these elements has no position in the 3D view (it may have no geometry).', objectIds: [], data: null };
                }
                const d = distance(positions.get(a.external_id).center, positions.get(b.external_id).center);
                const answer = `${a.clean_name} ${a.objectid} and ${b.clean_name} ${b.objectid} are ${metres(d.straight)} apart, centre to centre ` +
                    `(${metres(d.horizontal)} on plan, ${metres(d.vertical)} in height).`;
                const data = elementData([a, b], 2);
                return { answer, objectIds: data.objectIds, data };
            }

            // spacing: from each element's location on plan to the nearest other location
            // (stacked elements, e.g. a column above another, share one location)
            const { total, rows } = findElements(model.db, plan);
            const { items, locations } = nearestNeighbours(rows, positions);
            if (locations < 2) {
                return { answer: `I need ${describe(plan)} at 2 or more locations to measure a distance (found ${locations}).`, objectIds: [], data: null };
            }
            items.sort((x, y) => x.distance - y.distance);
            const values = items.map(item => item.distance);
            const median = values[Math.floor(values.length / 2)];
            const where = locations < items.length ? ` at ${locations} locations on plan (some are stacked)` : '';
            let answer = `Spacing of the ${items.length} ${describe(plan)}${where}, centre to centre, to the nearest neighbour: ` +
                `smallest ${metres(values[0])}, typical ${metres(median)}, largest ${metres(values[values.length - 1])}.`;
            if (LONG_CATEGORIES.has(plan.category)) {
                answer += ` These are long elements, so centre-to-centre distances are only a rough guide.`;
            }
            if (total > items.length) answer += ` (${total - items.length} have no position in the 3D view and are not included.)`;
            const data = elementData(items.map(item => ({ ...item.row, number: Math.round(item.distance * 100) / 100, unit: 'm' })), items.length);
            return { answer, objectIds: data.objectIds, data };
        }

        default:
            // validatePlan only lets known actions through, so this "can't happen".
            // Throwing makes it loud if someone adds an action and forgets this switch.
            throw new Error(`Unhandled action "${plan.action}"`);
    }
}

module.exports = {
    ACTIONS, AGGREGATES, LIST_OPERATORS, NUMERIC_OPERATORS, OPERATORS, NUMERIC_SQL, OPERATOR_WORDS,
    NUMBER_WITH_UNIT, withAllLevelPaths, ask, categoryJoin, valueExists, textExists, suggestValues,
    validateFilter, validatePlan, buildWhere, describe, findElements, groupElements, measureElements,
    METRES_PER, KG_PER_METRE, weighElements, aggregateByUnit, formatQuantity, elementData,
    AGGREGATE_LABELS, runPlan
};

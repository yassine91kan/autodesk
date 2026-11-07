// augmented/sqlplanner.js
// ===========================================================================
// EXPERIMENT (option 3): OpenAI writes ONE SQL query on the clean table
// (elements_clean, augmented/clean.js), code checks it and runs it.
// Not connected to the app yet: test/eval_compare.js runs it side by side with
// today's planner on the same questions, and the results decide.
//
//   question -> describeCleanTable (what this model contains, ~1k tokens)
//            -> OpenAI: { sql, reading } | { reply } | { clarify }
//            -> checkSql (read-only, one statement, elements_clean only)
//            -> SQLite (at most MAX_ROWS rows) -> result
//
// Safety, as with every plan today: OpenAI never runs anything itself. Its SQL must be
// a single read-only SELECT on elements_clean, or it is refused before it runs.
// ===========================================================================

const { askForJson } = require('./planner');

const MAX_ROWS = 2000;

// What each column means, for the prompt (the same for every model).
const COLUMN_NOTES = [
    'objectid (element id: SELECT it whenever the answer is a set of elements)', 'name', 'category', 'family', 'type',
    'level (the level the element is on)', 'top_level (the level it goes up to)', 'mark',
    'material (text)', 'material_class (concrete|steel|timber|aluminium|masonry|glass|other, NULL = no material set)',
    'is_structural (1/0)', 'usage (structural usage: Joist, Girder, Purlin...)',
    'function (Revit Function: Exterior, Interior, Foundation, Retaining...; "exterior / external / outside walls" = function = \'Exterior\')',
    'length_m', 'height_m', 'width_mm (section or footprint width)', 'depth_mm (section depth)',
    'thickness_mm (walls: their thickness)', 'section (text, e.g. "450 x 450 mm")', 'area_m2', 'volume_m3',
    'weight_kg_per_m', 'weight_kg', 'derived (columns computed, e.g. "height_m" from the 3D view)'
];
const NUMBER_COLUMNS = ['length_m', 'height_m', 'width_mm', 'depth_mm', 'thickness_mm', 'area_m2', 'volume_m3', 'weight_kg_per_m', 'weight_kg'];

// What THIS model contains: categories (with the columns they have values for), levels,
// material classes and names, usages, types. Built from the clean table, ~1k tokens.
function describeCleanTable(db) {
    const lines = [];
    const categories = db.prepare('SELECT category, COUNT(*) n FROM elements_clean GROUP BY category ORDER BY n DESC').all();
    lines.push('Categories (elements, and the number columns they have values for):');
    for (const { category, n } of categories.slice(0, 40)) {
        const filled = NUMBER_COLUMNS.filter(col => db.prepare(`SELECT 1 FROM elements_clean WHERE category = ? AND ${col} IS NOT NULL LIMIT 1`).get(category));
        const marks = db.prepare('SELECT COUNT(mark) m FROM elements_clean WHERE category = ?').get(category).m;
        lines.push(`- ${category} (${n}): ${filled.join(', ') || 'no sizes'}${marks ? `; mark on ${marks}` : ''}`);
    }
    const list = (sql, label, limit = 40) => {
        const values = db.prepare(sql).all().map(r => `${r.v} (${r.n})`);
        if (values.length) lines.push(`${label}: ${values.slice(0, limit).join(', ')}${values.length > limit ? ', ...' : ''}`);
    };
    list('SELECT level v, COUNT(*) n FROM elements_clean WHERE level IS NOT NULL GROUP BY 1 ORDER BY n DESC', 'Levels');
    list('SELECT top_level v, COUNT(*) n FROM elements_clean WHERE top_level IS NOT NULL GROUP BY 1 ORDER BY n DESC', 'Top levels');
    list("SELECT COALESCE(material_class, 'NULL') v, COUNT(*) n FROM elements_clean GROUP BY 1 ORDER BY n DESC", 'Material classes');
    list('SELECT material v, COUNT(*) n FROM elements_clean WHERE material IS NOT NULL GROUP BY 1 ORDER BY n DESC', 'Materials', 25);
    list('SELECT usage v, COUNT(*) n FROM elements_clean WHERE usage IS NOT NULL GROUP BY 1 ORDER BY n DESC', 'Usages');
    list("SELECT category || ': ' || function v, COUNT(*) n FROM elements_clean WHERE function IS NOT NULL GROUP BY 1 ORDER BY n DESC", 'Functions (category: function)');
    list("SELECT category || ': ' || type v, COUNT(*) n FROM elements_clean WHERE type IS NOT NULL GROUP BY 1 ORDER BY n DESC", 'Types (category: type)', 40);
    return lines.join('\n');
}

const SQL_PROMPT = `You are Augmented, an assistant that answers questions about a Revit building model by writing ONE SQLite query.

The only table is elements_clean, one row per element. Columns:
${COLUMN_NOTES.map(c => `- ${c}`).join('\n')}
Units are in the column names: convert the question's units (6 m -> length_m > 6; 300 mm -> width_mm > 300; 20 ft -> length_m > 6.096; 1 m3 -> volume_m3 > 1).

Return ONLY JSON, one of:
{"sql": "SELECT ...", "reading": "<one short sentence: how you read the question>"}
{"reply": "<short answer in words>"}    when the table can't answer it: connections, supports, hosts, assemblies, grids, clashes, orientation (north), the element selected in the viewer, viewer actions, or questions not about the model
{"clarify": "<one short question>"}     only when the question is too vague to choose (e.g. "large" with no size)

Rules for the SQL:
- When the answer is a set of elements (show, find, list, which), SELECT objectid and the columns that matter.
- How many: SELECT COUNT(*) AS count. Totals and averages: SUM / AVG of a number column, with GROUP BY for "per" / "by".
- Use names exactly as listed below (categories, levels, types, materials). "beams" = Structural Framing, "columns" = Structural Columns (plus Columns if listed).
- Materials: material_class for words like concrete, steel, timber; material LIKE '%...%' for a specific grade.
- "structural" = is_structural = 1 only (Revit's own flag): don't add categories to it. "missing" / "no ..." = IS NULL. Use only the columns above; never invent names.
- "horizontal members" = Structural Framing; "vertical members" = Structural Columns (plus Columns if listed).
- Viewer actions (highlight, isolate, clear the selection, add to the schedule) happen automatically for every answer: ignore those words and answer the data part. "Highlight these" after a previous question = run the previous query again.
- Never use a level as a stand-in for an elevation: the table has no elevations, so for "highest / lowest elevation" reply that elevations aren't in the model data (heights are in height_m).
- If a name in the question exists nowhere below (a level, mark, type or material), reply that it doesn't exist and name a few that do.

This model contains:
`;

// The SQL must be one read-only SELECT (or WITH ... SELECT) on elements_clean. Returns
// { stmt } ready to run, or { error } saying why it was refused.
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|replace|vacuum|reindex|analyze|load_extension|sqlite_\w+)\b/i;
function checkSql(db, rawSql) {
    let sql = String(rawSql || '').trim().replace(/;\s*$/, '');
    if (!sql) return { error: 'empty query' };
    if (sql.includes(';')) return { error: 'only one statement is allowed' };
    if (!/^(select|with)\b/i.test(sql)) return { error: 'only SELECT queries are allowed' };
    if (FORBIDDEN.test(sql)) return { error: 'the query uses a forbidden word' };
    const cteNames = [...sql.matchAll(/(?:with|,)\s*([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].map(m => m[1].toLowerCase());
    const tables = [...sql.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)].map(m => m[1].toLowerCase());
    const other = tables.find(t => t !== 'elements_clean' && !cteNames.includes(t));
    if (other) return { error: `only the table elements_clean may be used, not "${other}"` };
    try {
        const stmt = db.prepare(`SELECT * FROM (${sql}) LIMIT ${MAX_ROWS}`);
        if (!stmt.reader || !stmt.readonly) return { error: 'the query must only read data' };
        return { stmt, sql };
    } catch (error) {
        return { error: error.message };
    }
}

// Runs a query checkSql accepted: at most MAX_ROWS rows come back, but the TRUE total is
// counted too (Seaport has more than 2,000 curtain-wall elements: "Found 2000" was wrong).
// Returns { rows, columns, total }; total = distinct elements when the query lists elements.
function runChecked(db, checked) {
    const rows = checked.stmt.all();
    const columns = checked.stmt.columns().map(c => c.name);
    let total = rows.length;
    if (rows.length >= MAX_ROWS) {
        total = db.prepare(columns.includes('objectid')
            ? `SELECT COUNT(DISTINCT objectid) AS n FROM (${checked.sql})`
            : `SELECT COUNT(*) AS n FROM (${checked.sql})`).get().n;
    }
    return { rows, columns, total };
}

// Turns the rows into a result like today's: element ids to highlight, a count, and text.
// `columns` = the query's column names (known even when no row came back); `total` = the
// true number of results when more than MAX_ROWS exist.
function shapeResult(rows, reading, columns = rows[0] ? Object.keys(rows[0]) : [], total = null) {
    if (rows.length === 0) {
        return { kind: columns.includes('objectid') ? 'elements' : 'table', ids: [], rows, count: 0,
            answer: `Nothing found. ${reading || ''}`.trim() };
    }
    if ('objectid' in rows[0]) {
        const ids = [...new Set(rows.map(r => r.objectid))];
        const count = Math.max(total ?? 0, ids.length);
        const shown = count > ids.length ? ` (the first ${ids.length} are listed)` : '';
        return { kind: 'elements', ids, count, rows, answer: `Found ${count} element${count === 1 ? '' : 's'}${shown}. ${reading || ''}`.trim() };
    }
    if (rows.length === 1 && Object.keys(rows[0]).length === 1) {
        const [column, value] = Object.entries(rows[0])[0];
        return { kind: 'value', ids: [], value, count: /count/i.test(column) ? value : null, rows,
            answer: `${column}: ${typeof value === 'number' ? Math.round(value * 1000) / 1000 : value}. ${reading || ''}`.trim() };
    }
    const lines = rows.slice(0, 50).map(r => Object.values(r).map(v => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v).join(' | '));
    return { kind: 'table', ids: [], rows, count: null,
        answer: `${reading || ''}\n${lines.join('\n')}${rows.length > 50 ? `\n... (${rows.length} rows)` : ''}`.trim() };
}

// Answers one question. `previous` = { question, sql } of the last question in the same
// conversation, for follow-ups ("and on level 2?"). Returns the shaped result plus
// { sql, reading, calls: [usage per OpenAI call] }.
async function answerWithSql(question, model, previous = null) {
    const db = model.db;
    if (!model.cleanDescription) model.cleanDescription = describeCleanTable(db);   // once per loaded model
    const system = SQL_PROMPT + model.cleanDescription;
    let user = previous
        ? `Previous question in this conversation: "${previous.question}"\nIts SQL: ${previous.sql || '(none)'}\nNew question (may refine the previous one): ${question}`
        : question;

    const calls = [];
    for (let attempt = 0; attempt < 2; attempt++) {   // one retry if the SQL fails
        const { json, usage } = await askForJson(system, user);
        calls.push(usage);
        if (json.reply) return { kind: 'reply', ids: [], rows: [], count: null, answer: String(json.reply), calls };
        if (json.clarify) return { kind: 'clarify', ids: [], rows: [], count: null, answer: String(json.clarify), calls };
        const checked = checkSql(db, json.sql);
        if (checked.stmt) {
            try {
                const { rows, columns, total } = runChecked(db, checked);
                return { ...shapeResult(rows, json.reading, columns, total), sql: checked.sql, reading: json.reading || null, calls };
            } catch (error) {
                checked.error = error.message;
            }
        }
        user += `\n\nYour SQL was refused or failed: ${checked.error}. Return corrected JSON.\nSQL was: ${json.sql}`;
    }
    return { kind: 'clarify', ids: [], rows: [], count: null, answer: 'Sorry, I couldn\'t build a working query for that. Could you rephrase it?', calls };
}

module.exports = { answerWithSql, describeCleanTable, checkSql, runChecked, shapeResult, SQL_PROMPT, MAX_ROWS };

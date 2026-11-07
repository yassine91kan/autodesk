// Tests for the clean table (augmented/clean.js): node test/run_clean.js
// A small made-up model with the traps found in real Revit data: sizes in cm, weights in
// kgf/m, type names that look like numbers, placeholders, square columns, and walls whose
// thickness is stored as "Width".
const { buildDatabase } = require('../augmented/store');
const { parseMeasure, isPlaceholder, materialClass, fillHeightsFromPositions } = require('../augmented/clean');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
    cond ? pass++ : fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n        ' + detail : ''}`);
}

console.log('\n=== Reading values ===');
const near = (a, b) => a !== null && Math.abs(a - b) < 1e-9;
check('"6000.000 mm" -> 6 m', near(parseMeasure('6000.000 mm').base, 6) && parseMeasure('6000.000 mm').kind === 'length');
check('"13.300 cm" -> 0.133 m (sizes in cm are converted, not compared as 13.3)', near(parseMeasure('13.300 cm').base, 0.133));
check('"0.030 m^3" and "861 cm^3" are volumes in m3', near(parseMeasure('0.030 m^3').base, 0.03) && near(parseMeasure('861 cm^3').base, 0.000861));
check('"25.400 kgf/m" = 25.4 kg/m', near(parseMeasure('25.400 kgf/m').base, 25.4) && parseMeasure('25.400 kgf/m').kind === 'linear_mass');
check('imperial 10\' - 6" -> 3.2004 m', near(Math.round(parseMeasure('10\' - 6"').base * 1e4) / 1e4, 3.2004));
check('"200UB25.4", "88.9x5.0CHS", ".05.11" stay text (not numbers)',
    parseMeasure('200UB25.4') === null && parseMeasure('88.9x5.0CHS') === null && parseMeasure('.05.11') === null);
check('placeholders mean "not set"', ['<By Category>', '<not associated>', 'None', '-', ''].every(isPlaceholder) && !isPlaceholder('Level 1'));
check('material classes', materialClass('CL Concrete_ panels') === 'concrete' && materialClass('Metal - Steel - 345 MPa') === 'steel' &&
    materialClass('Softwood, Lumber') === 'timber' && materialClass('Aluminum') === 'aluminium' && materialClass('Vinyl') === 'other' && materialClass(null) === null);

console.log('\n=== Building the table ===');
const el = (objectid, name, properties) => ({ objectid, externalId: `ext-${objectid}`, name, properties });
const collection = [
    el(1, 'Basic Wall [1]', { Construction: { Width: '280.000 mm', Function: 'Exterior' }, Constraints: { 'Base Constraint': 'Foundation', 'Top Constraint': 'Up to level: Level 2', 'Unconnected Height': '4700.000 mm' },
        Structural: { Structural: 'Yes' }, 'Materials and Finishes': { 'Structural Material': 'CL Concrete_ panels' }, 'Identity Data': { Mark: 'W1' } }),
    el(2, 'Floor [2]', { Dimensions: { Thickness: '300.000 mm', Area: '50.000 m^2', Volume: '15.000 m^3' }, Constraints: { Level: 'Level 1' }, Structural: { Structural: 'No' },
        'Materials and Finishes': { 'Structural Material': '<By Category>' } }),
    el(3, 'HSS Column [3]', { 'Structural Section Geometry': { Width: '13.300 cm', Height: '20.300 cm' }, 'Structural Analysis': { 'Nominal Weight': '25.400 kgf/m' },
        Constraints: { 'Base Level': 'Level 2', 'Top Level': 'Top of Parapet' }, 'Materials and Finishes': { 'Structural Material': 'Metal - Steel - 345 MPa' } }),
    el(4, 'Concrete-Square-Column [4]', { Dimensions: { b: '450.000 mm', Volume: '0.607 m^3' }, Constraints: { 'Base Level': 'Level 1', 'Top Level': 'Level 2' },
        'Materials and Finishes': { 'Structural Material': 'Concrete, Cast-in-Place gray' } }),
    el(5, 'UB-Universal Beam [5]', { Dimensions: { Length: '6000.000 mm' }, 'Structural Analysis': { 'Nominal Weight': '25.400 kg/m' },
        Constraints: { 'Reference Level': 'Level 2' }, 'Materials and Finishes': { 'Structural Material': 'Metal - Steel - 250 MPa' } }),
    el(6, 'Rebar Bar [6]', { Dimensions: { 'Total Bar Length': '1200.000 mm', B: '500.000 mm' }, 'Materials and Finishes': { Material: '<By Category>' } })
];
const node = (objectid, name, objects) => ({ objectid, name, objects });
const tree = { data: { objects: [node(100, 'Model', [
    node(101, 'Walls', [node(102, 'Basic Wall', [node(1, 'Basic Wall [1]')])]),
    node(103, 'Floors', [node(2, 'Floor [2]')]),
    node(104, 'Structural Columns', [node(105, 'HSS Column', [node(106, 'HSS 133x203', [node(3, 'HSS Column [3]')])]),
        node(107, 'M_Concrete-Square-Column', [node(108, '450 x 450mm', [node(4, 'Concrete-Square-Column [4]')])])]),
    node(109, 'Structural Framing', [node(110, 'UB-Universal Beam', [node(111, '200UB25.4', [node(5, 'UB-Universal Beam [5]')])])]),
    node(112, 'Structural Rebar', [node(6, 'Rebar Bar [6]')])
])] } };

const db = buildDatabase(collection, tree);
const row = id => db.prepare('SELECT * FROM elements_clean WHERE objectid = ?').get(id);
const source = (category, column) => db.prepare('SELECT source FROM clean_sources WHERE category = ? AND "column" = ?').all(category, column).map(r => r.source);

let r = row(1);
check('wall: thickness comes from Revit\'s Width (280 mm), structural, levels cleaned',
    r.thickness_mm === 280 && r.width_mm === 280 && r.height_m === 4.7 && r.is_structural === 1 && r.level === 'Foundation' &&
    r.top_level === 'Level 2' && r.mark === 'W1' && r.material_class === 'concrete', JSON.stringify(r));
check('...and the source is recorded ("Walls / thickness_mm <- Construction.Width")', source('Walls', 'thickness_mm').includes('Construction.Width'));
r = row(2);
check('floor: Revit says not structural; "<By Category>" material = not set', r.is_structural === 0 && r.material === null && r.material_class === null &&
    r.thickness_mm === 300 && r.area_m2 === 50 && r.volume_m3 === 15, JSON.stringify(r));
r = row(3);
check('steel column: cm sizes -> 133 x 203 mm, kgf/m -> kg/m, structural by category', r.width_mm === 133 && r.depth_mm === 203 &&
    r.section === '133 x 203 mm' && r.weight_kg_per_m === 25.4 && r.is_structural === 1 && r.material_class === 'steel' && r.height_m === null, JSON.stringify(r));
r = row(4);
check('square concrete column: only "b" given -> 450 x 450 mm', r.width_mm === 450 && r.depth_mm === 450 && r.section === '450 x 450 mm', JSON.stringify(r));
r = row(5);
check('beam: type "200UB25.4" stays text; weight = 25.4 kg/m x 6 m = 152.4 kg (marked as computed)',
    r.type === '200UB25.4' && r.length_m === 6 && r.weight_kg === 152.4 && r.derived === 'weight_kg', JSON.stringify(r));
r = row(6);
check('rebar: length from Total Bar Length; its "B" is not a section width; no material set',
    r.length_m === 1.2 && r.width_mm === null && r.material === null && r.is_structural === 1, JSON.stringify(r));

console.log('\n=== Heights from the 3D view ===');
db.prepare('INSERT INTO positions (objectid, cx, cy, cz, min_x, min_y, min_z, max_x, max_y, max_z) VALUES (3, 0, 0, 2, 0, 0, 0.5, 0, 0, 3.6)').run();
const filled = fillHeightsFromPositions(db);
r = row(3);
check('a column without a height property gets top - bottom of its box (3.1 m), marked as computed',
    filled === 1 && r.height_m === 3.1 && r.derived === 'height_m' && source('Structural Columns', 'height_m')[0].startsWith('computed'), JSON.stringify(r));
check('...and doing it again changes nothing', fillHeightsFromPositions(db) === 0);

console.log('\n=== Plain SQL now answers what failed before ===');
check('"walls thicker than 200 mm" -> 1', db.prepare("SELECT COUNT(*) n FROM elements_clean WHERE category = 'Walls' AND thickness_mm > 200").get().n === 1);
check('"columns wider than 300 mm" -> the concrete one only', JSON.stringify(db.prepare("SELECT objectid FROM elements_clean WHERE category = 'Structural Columns' AND width_mm > 300").all()) === '[{"objectid":4}]');
check('"non-structural elements" -> the floor only', JSON.stringify(db.prepare('SELECT objectid FROM elements_clean WHERE is_structural = 0').all()) === '[{"objectid":2}]');

console.log('\n=== The SQL guard (augmented/sqlplanner.js): only read-only queries on elements_clean ===');
const { checkSql } = require('../augmented/sqlplanner');
const refused = sql => Boolean(checkSql(db, sql).error);
check('a normal SELECT runs', !refused("SELECT objectid FROM elements_clean WHERE category = 'Walls'"));
check('WITH ... SELECT on elements_clean runs', !refused('WITH w AS (SELECT * FROM elements_clean) SELECT COUNT(*) AS count FROM w'));
check('a trailing ";" is fine', !refused('SELECT COUNT(*) FROM elements_clean;'));
check('DELETE / DROP / UPDATE are refused', refused('DELETE FROM elements_clean') && refused('DROP TABLE elements_clean') &&
    refused("UPDATE elements_clean SET mark = 'x'"));
check('two statements are refused', refused('SELECT 1 FROM elements_clean; DROP TABLE elements_clean'));
check('other tables are refused (raw properties, sqlite_master, positions)', refused('SELECT * FROM properties') &&
    refused('SELECT * FROM sqlite_master') && refused('SELECT * FROM elements_clean JOIN positions USING(objectid)'));
check('PRAGMA and ATTACH are refused', refused('PRAGMA table_info(elements_clean)') && refused("ATTACH 'x.db' AS x"));
check('a query with a mistake returns the error (for one retry)', /no such column/.test(checkSql(db, 'SELECT nope FROM elements_clean').error));
check('the table is still intact afterwards', db.prepare('SELECT COUNT(*) n FROM elements_clean').get().n === 6);

console.log('\n=== Revit\'s Function (exterior / interior) ===');
check('the wall\'s Function is a column', row(1).function === 'Exterior' && row(2).function === null, `${row(1).function} / ${row(2).function}`);
const { readPlain, buildTemplate } = require('../augmented/hybrid');
const model = { db };
for (const question of ['show me the exterior walls', 'external walls', 'how many outside walls are there?']) {
    const read = readPlain(question, model);
    const result = read && buildTemplate(read, db);
    check(`"${question}" -> template on function = Exterior -> the wall`, read?.function === 'Exterior' && JSON.stringify(result?.ids) === '[1]', result?.answer);
}

console.log('\n=== More results than the row limit: the TRUE count ===');
const { runChecked, shapeResult, MAX_ROWS } = require('../augmented/sqlplanner');
const big = new (require('better-sqlite3'))(':memory:');
big.exec('CREATE TABLE elements_clean (objectid INTEGER, category TEXT)');
const add = big.prepare("INSERT INTO elements_clean VALUES (?, 'Walls')");
big.transaction(() => { for (let i = 1; i <= MAX_ROWS + 500; i++) add.run(i); })();
const checkedBig = checkSql(big, 'SELECT objectid FROM elements_clean');
const ran = runChecked(big, checkedBig);
const shaped = shapeResult(ran.rows, 'All walls.', ran.columns, ran.total);
check(`${MAX_ROWS + 500} walls: ${MAX_ROWS} are listed, but the answer says ${MAX_ROWS + 500}`, ran.rows.length === MAX_ROWS && shaped.count === MAX_ROWS + 500 &&
    new RegExp(`Found ${MAX_ROWS + 500} elements \\(the first ${MAX_ROWS} are listed\\)`).test(shaped.answer), shaped.answer);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

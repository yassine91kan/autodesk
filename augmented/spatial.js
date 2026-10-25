// augmented/spatial.js
// ===========================================================================
// SPATIAL - distances between elements.
//
// The model's property data says WHAT elements are, not WHERE. The 3D viewer knows
// where: when a model loads, the page computes each element's box from its geometry
// and sends it here (POST /model_positions), in metres, keyed by externalId (the same
// in SVF and SVF2 models). It's stored in the model's own index, in the "positions"
// table next to elements and properties (store.js), once per model: a reload or a
// second visitor doesn't send or overwrite it again.
//
// Two kinds of question so far:
//   spacing  "distance between the columns"   each element's nearest neighbour
//   between  "distance between 3493 and 3902" two elements, centre to centre
// Distances are centre to centre: right for columns and piles, rough for walls and slabs.
// ===========================================================================

const isPoint = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

// How many elements of this model have a position.
function positionCount(db) {
    return db.prepare('SELECT COUNT(*) AS n FROM positions').get().n;
}

// Stores a model's positions, the first time only: when the table already has rows,
// nothing is replaced. Each value is { center, min, max } ([x, y, z] in metres), or just
// a centre [x, y, z]. Only externalIds of real elements in the index are kept.
// Returns how many positions the model has.
function setPositions(db, positions) {
    if (positionCount(db) > 0) return positionCount(db);
    const idOf = db.prepare('SELECT objectid FROM elements WHERE external_id = ?');
    const insert = db.prepare('INSERT OR IGNORE INTO positions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
        for (const [externalId, value] of Object.entries(positions || {})) {
            const box = isPoint(value) ? { center: value, min: value, max: value } : value || {};
            if (![box.center, box.min, box.max].every(isPoint)) continue;
            const element = idOf.get(externalId);
            if (element) insert.run(element.objectid, ...box.center, ...box.min, ...box.max);
        }
    })();
    return positionCount(db);
}

// externalId -> { center, min, max } for the whole model. Empty Map if none yet.
function getPositions(db) {
    const rows = db.prepare(`
        SELECT e.external_id, p.* FROM positions p JOIN elements e ON e.objectid = p.objectid
    `).all();
    return new Map(rows.map(r => [r.external_id, {
        center: [r.cx, r.cy, r.cz], min: [r.min_x, r.min_y, r.min_z], max: [r.max_x, r.max_y, r.max_z]
    }]));
}

// How far apart two points are: straight line, on plan (x, y), and in height (z).
function distance(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    return { straight: Math.hypot(dx, dy, dz), horizontal: Math.hypot(dx, dy), vertical: Math.abs(dz) };
}

// Elements this close on plan are one LOCATION: a column above another, at the same grid
// point, isn't "0 m" from it in any useful sense.
const SAME_LOCATION_M = 0.05;

// Long elements: their centre says little about where they are, so distances between
// them are only a rough guide (and the answer says so).
const LONG_CATEGORIES = new Set(['Structural Framing', 'Walls', 'Railings', 'Curtain Panels', 'Pipes', 'Ducts']);

// Groups the elements into locations on plan, then gives each element the distance from
// its location to the nearest OTHER location. Returns { items: [{ row, distance }], locations }.
// (Every pair is compared: fine for the few hundred elements an answer holds.)
function nearestNeighbours(rows, positions) {
    const locations = [];   // [{ point, rows }]
    for (const row of rows.filter(r => positions.has(r.external_id))) {
        const point = positions.get(row.external_id).center;
        const near = locations.find(loc => distance(loc.point, point).horizontal < SAME_LOCATION_M);
        if (near) near.rows.push(row);
        else locations.push({ point, rows: [row] });
    }
    const items = [];
    for (const loc of locations) {
        let best = Infinity;
        for (const other of locations) {
            if (other !== loc) best = Math.min(best, distance(loc.point, other.point).horizontal);
        }
        if (best < Infinity) loc.rows.forEach(row => items.push({ row, distance: best }));
    }
    return { items, locations: locations.length };
}

module.exports = { positionCount, setPositions, getPositions, distance, nearestNeighbours, LONG_CATEGORIES };

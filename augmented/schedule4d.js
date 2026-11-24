// augmented/schedule4d.js
// ===========================================================================
// AUTO-GENERATED 4D SCHEDULE - a first-draft construction sequence derived from the
// model itself, with no outside schedule data.
//
//   elements_clean ─► each element gets a STAGE (what kind of work) and a LEVEL (where)
//                  ─► one task per (stage, level), sized by its quantities
//                  ─► forward pass (earliest dates) + backward pass (critical path)
//
// It's a rule-of-thumb plan a planner would refine, not a real programme: the rates
// below are deliberately simple crew-days per element / per m³.
// ===========================================================================

// Stages, in build order. `structural` stages follow the floor-by-floor rule: the
// structure of a level can't start until the structure below it is finished.
const STAGES = [
    { id: 'substructure', name: 'Substructure', structural: true },
    { id: 'vertical', name: 'Columns & walls', structural: true },
    { id: 'horizontal', name: 'Beams & slabs', structural: true },
    { id: 'circulation', name: 'Stairs & cores', structural: false },
    { id: 'envelope', name: 'Envelope', structural: false },
    { id: 'interiors', name: 'Interiors', structural: false },
    { id: 'fitout', name: 'Services & fit-out', structural: false }
];
const STAGE_INDEX = new Map(STAGES.map((stage, index) => [stage.id, index]));

// Category -> stage. Walls are decided per element (structural / exterior / interior).
const CATEGORY_STAGE = {
    'Structural Foundations': 'substructure',
    'Structural Columns': 'vertical',
    'Columns': 'vertical',
    'Structural Framing': 'horizontal',
    'Structural Trusses': 'horizontal',
    'Structural Beam Systems': 'horizontal',
    'Floors': 'horizontal',
    'Stairs': 'circulation',
    'Runs': 'circulation',
    'Landings': 'circulation',
    'Railings': 'circulation',
    'Top Rails': 'circulation',
    'Ramps': 'circulation',
    'Roofs': 'envelope',
    'Curtain Panels': 'envelope',
    'Curtain Wall Mullions': 'envelope',
    'Curtain Systems': 'envelope',
    'Windows': 'envelope',
    'Doors': 'interiors',
    'Ceilings': 'interiors',
    'Casework': 'interiors',
    'Generic Models': 'interiors'
};

// Reinforcement goes in WITH its host, ahead of the concrete (sorted first in the task).
const REINFORCEMENT = new Set([
    'Structural Rebar', 'Structural Area Reinforcement', 'Structural Path Reinforcement',
    'Structural Fabric Reinforcement', 'Structural Fabric Areas'
]);
const HOST_STAGE = { 'Structural Foundation': 'substructure', 'Wall': 'vertical', 'Floor': 'horizontal' };

// Not built: annotation and helper objects.
const SKIPPED = new Set([
    'Lines', 'Rooms', 'Areas', 'Grids', 'Levels', 'Cameras', 'Views', 'Room Separation',
    '<Room Separation>', '<Area Boundary>', 'Center line', 'Mass', 'Spaces', 'Project Information'
]);

// Crew-days: per element, plus per m³ where volume matters (concrete).
const RATES = {
    'Structural Foundations': { each: 0.6, perM3: 0.25 },
    'Structural Columns': { each: 0.25 },
    'Walls': { each: 0.3, perM3: 0.08 },
    'Structural Framing': { each: 0.08 },
    'Floors': { each: 0.5, perM3: 0.06 },
    'Structural Rebar': { each: 0.02 },
    'Structural Area Reinforcement': { each: 0.1 },
    'Stairs': { each: 3 },
    'Roofs': { each: 1, perM3: 0.05 },
    'Curtain Panels': { each: 0.05 },
    'Curtain Wall Mullions': { each: 0.01 },
    'Windows': { each: 0.15 },
    'Doors': { each: 0.15 },
    'Ceilings': { each: 0.4 },
    'Furniture': { each: 0.03 }
};
const DEFAULT_RATE = { each: 0.1 };
const MAX_TASK_DAYS = 30;
const OVERLAP = 0.5;   // the next trade on a level may start when the previous one is half done

function stageOf(element) {
    if (REINFORCEMENT.has(element.category)) {
        return HOST_STAGE[element.host_category] || 'horizontal';
    }
    if (element.category === 'Walls') {
        if (element.is_structural) return 'vertical';
        return element.function === 'Exterior' ? 'envelope' : 'interiors';
    }
    return CATEGORY_STAGE[element.category] || 'fitout';
}

// A guess at a level's height when no element tells us (names only).
function elevationFromName(name) {
    const text = name.toLowerCase();
    if (/found|footing|pile/.test(text)) return -10000;
    if (/lower|basement|cellar|^b\d/.test(text)) return -5000;
    if (/ground|^gf$|level 0/.test(text)) return 0;
    const number = text.match(/(\d+)/);
    if (number) return Number(number[1]) * 3500;
    if (/parapet|roof|top/.test(text)) return 1e6;
    return 0;
}

// Levels in height order: the median bottom elevation of the elements on each level,
// falling back to what the level's name suggests.
function orderLevels(elements) {
    const heights = new Map();
    for (const element of elements) {
        if (!element.level) continue;
        if (!heights.has(element.level)) heights.set(element.level, []);
        const height = levelHeightOf(element);
        if (height != null) heights.get(element.level).push(height);
    }
    const median = values => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    };
    return [...heights.entries()]
        .map(([name, values]) => ({ name, elevation: values.length ? median(values) : elevationFromName(name) }))
        .sort((a, b) => a.elevation - b.elevation);
}

// The level nearest an elevation (for elements that don't name their level).
function nearestLevel(levels, elevation) {
    let best = levels[0];
    for (const level of levels) {
        if (Math.abs(level.elevation - elevation) < Math.abs(best.elevation - elevation)) best = level;
    }
    return best.name;
}

// Adds working days (Mon-Fri) to a date.
function addWorkdays(start, days) {
    const date = new Date(start);
    let left = days;
    while (left > 0) {
        date.setUTCDate(date.getUTCDate() + 1);
        const weekday = date.getUTCDay();
        if (weekday !== 0 && weekday !== 6) left -= 1;
    }
    return date;
}

// The Monday on or after a date.
function nextMonday(date = new Date()) {
    const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1);
    return monday;
}

const isoDate = date => date.toISOString().slice(0, 10);

// Tasks ordered so every task comes after all its predecessors (Kahn's algorithm).
function topologicalOrder(tasks) {
    const waiting = new Map(tasks.map(task => [task.id, task.links.length]));
    const successors = new Map(tasks.map(task => [task.id, []]));
    for (const task of tasks) for (const link of task.links) successors.get(link.from).push(task);
    const ready = tasks.filter(task => task.links.length === 0);
    const ordered = [];
    while (ready.length) {
        const task = ready.shift();
        ordered.push(task);
        for (const next of successors.get(task.id)) {
            waiting.set(next.id, waiting.get(next.id) - 1);
            if (waiting.get(next.id) === 0) ready.push(next);
        }
    }
    if (ordered.length !== tasks.length) throw new Error('The generated schedule has a dependency loop.');
    return ordered;
}

// Reads what the schedule needs from the model's index, one row per element.
function readElements(db) {
    return db.prepare(`
        SELECT c.objectid, c.external_id, c.category, c.level, c.is_structural, c.function,
               c.volume_m3, c.length_m, c.material_class,
               (SELECT p.value FROM properties p WHERE p.objectid = c.objectid
                  AND p.path = 'Identity Data.Host Category' LIMIT 1) AS host_category,
               (SELECT p.numeric_value FROM properties p WHERE p.objectid = c.objectid
                  AND p.path = 'Dimensions.Elevation at Bottom' LIMIT 1) AS elevation_mm,
               (SELECT p.numeric_value FROM properties p WHERE p.objectid = c.objectid
                  AND p.path = 'Dimensions.Elevation at Top' LIMIT 1) AS top_mm,
               (SELECT MAX(p.numeric_value) FROM properties p WHERE p.objectid = c.objectid
                  AND p.path IN ('Constraints.Height Offset From Level', 'Constraints.Start Level Offset',
                                 'Constraints.End Level Offset')) AS offset_mm
        FROM elements_clean c
        WHERE c.external_id IS NOT NULL
    `).all();
}

// Where an element says its level is: its top minus how far it sits above that level
// ("Elevation at Top" is absolute, the offset is relative to the level).
function levelHeightOf(element) {
    if (element.top_mm == null) return null;
    return element.top_mm - (element.offset_mm || 0);
}

// Builds the schedule. `start` = 'YYYY-MM-DD' (default: next Monday).
function buildSchedule(db, { start } = {}) {
    const startDate = start ? new Date(`${start}T00:00:00Z`) : nextMonday();
    if (Number.isNaN(startDate.getTime())) throw new Error('start must be a date like 2027-01-04');

    const elements = readElements(db).filter(element => !SKIPPED.has(element.category));
    const levels = orderLevels(elements);
    if (levels.length === 0) levels.push({ name: 'Site', elevation: 0 });
    const levelIndex = new Map(levels.map((level, index) => [level.name, index]));

    // 1. Each element -> stage + level. Elements without a level take the nearest level by
    //    elevation, then the lowest level their host stage uses, then the lowest level.
    const firstLevelOf = new Map();   // stage id or category -> lowest level index it uses
    const note = (key, index) => {
        const known = firstLevelOf.get(key);
        if (known == null || index < known) firstLevelOf.set(key, index);
    };
    for (const element of elements) {
        element.stage = stageOf(element);
        if (element.level && levelIndex.has(element.level)) {
            note(element.stage, levelIndex.get(element.level));
            note(element.category, levelIndex.get(element.level));
        }
    }
    // Rebar hosted by a "Floor" goes with the first floors, and so on.
    const HOST_CATEGORY = { 'Structural Foundation': 'Structural Foundations', 'Floor': 'Floors', 'Wall': 'Walls' };
    for (const element of elements) {
        if (element.level && levelIndex.has(element.level)) continue;
        const height = levelHeightOf(element) ?? element.elevation_mm;
        if (height != null) {
            element.level = nearestLevel(levels, height);
        } else {
            const index = firstLevelOf.get(HOST_CATEGORY[element.host_category]) ?? firstLevelOf.get(element.stage) ?? 0;
            element.level = levels[index].name;
        }
    }

    // 2. One task per (stage, level).
    const tasksByKey = new Map();
    for (const element of elements) {
        const key = `${element.stage}|${element.level}`;
        if (!tasksByKey.has(key)) {
            tasksByKey.set(key, {
                stage: element.stage, level: element.level, members: [], effort: 0,
                volume: 0, counts: {}
            });
        }
        const task = tasksByKey.get(key);
        const rate = RATES[element.category] || DEFAULT_RATE;
        task.effort += rate.each + (rate.perM3 || 0) * (element.volume_m3 || 0);
        if (element.material_class === 'concrete' && !REINFORCEMENT.has(element.category)) {
            task.volume += element.volume_m3 || 0;   // concrete only: what "Concrete placed" adds up
        }
        task.counts[element.category] = (task.counts[element.category] || 0) + 1;
        task.members.push(element);
    }

    const tasks = [...tasksByKey.values()].sort((a, b) =>
        STAGE_INDEX.get(a.stage) - STAGE_INDEX.get(b.stage) || levelIndex.get(a.level) - levelIndex.get(b.level));
    tasks.forEach((task, index) => {
        task.id = index;
        task.duration = Math.min(MAX_TASK_DAYS, Math.max(1, Math.ceil(task.effort)));
        task.links = [];   // { from, type: 'FS' | 'SS', lag }
    });

    // 3. Dependencies.
    const find = (stage, level) => tasksByKey.get(`${stage}|${level}`);
    for (const task of tasks) {
        const stageNo = STAGE_INDEX.get(task.stage);
        const levelNo = levelIndex.get(task.level);
        const add = (from, type, lag = 0) => {
            if (from && from !== task && !task.links.some(link => link.from === from.id && link.type === type)) {
                task.links.push({ from: from.id, type, lag });
            }
        };
        // Same level, the trade before: start when it's half done.
        for (let s = stageNo - 1; s >= 0; s -= 1) {
            const previous = find(STAGES[s].id, task.level);
            if (previous) { add(previous, 'SS', Math.ceil(previous.duration * OVERLAP)); break; }
        }
        // Same trade, the level below: finish first (crews move up floor by floor).
        for (let l = levelNo - 1; l >= 0; l -= 1) {
            const below = find(task.stage, levels[l].name);
            if (below) { add(below, 'FS'); break; }
        }
        // Structure of this level needs ALL structure below it finished;
        // later trades need the structure of their own level finished.
        const structureBelow = STAGES[stageNo].structural ? levelNo - 1 : levelNo;
        for (let l = structureBelow; l >= 0; l -= 1) {
            const below = tasks.filter(other => STAGES[STAGE_INDEX.get(other.stage)].structural && other.level === levels[l].name);
            if (below.length) { below.forEach(other => add(other, 'FS')); break; }
        }
    }

    // 4. Forward pass: earliest start (working day number, 0 = project start), in
    //    dependency order (columns on Level 2 wait for slabs on Level 1, which sort later).
    const ordered = topologicalOrder(tasks);
    for (const task of ordered) {
        task.start = 0;
        for (const link of task.links) {
            const from = tasks[link.from];
            const earliest = link.type === 'FS' ? from.start + from.duration : from.start + link.lag;
            task.start = Math.max(task.start, earliest);
        }
        task.end = task.start + task.duration;
    }
    const totalDays = Math.max(...tasks.map(task => task.end));

    // 5. Backward pass: latest start without delaying the finish. Zero float = critical.
    for (const task of tasks) task.lateEnd = totalDays;
    for (const task of [...ordered].reverse()) {
        task.lateStart = task.lateEnd - task.duration;
        for (const link of task.links) {
            const from = tasks[link.from];
            const latest = link.type === 'FS' ? task.lateStart : task.lateStart - link.lag + from.duration;
            from.lateEnd = Math.min(from.lateEnd, latest);
        }
    }

    // 6. The result. Inside a task, reinforcement first, then bottom-up, so playback
    //    reveals elements in a believable order.
    const order = element => [REINFORCEMENT.has(element.category) ? 0 : 1, element.elevation_mm ?? 0, element.objectid];
    const compare = (a, b) => {
        const x = order(a); const y = order(b);
        return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    };
    const dateOf = day => isoDate(addWorkdays(startDate, day));
    return {
        start: isoDate(startDate),
        finish: dateOf(totalDays),
        totalDays,
        workingWeek: 'Mon-Fri',
        levels: levels.map(level => level.name),
        stages: STAGES.filter(stage => tasks.some(task => task.stage === stage.id)).map(({ id, name }) => ({ id, name })),
        elementCount: elements.length,
        tasks: tasks.map(task => ({
            id: task.id,
            name: `${STAGES[STAGE_INDEX.get(task.stage)].name} · ${task.level}`,
            stage: task.stage,
            level: task.level,
            start: task.start,
            duration: task.duration,
            end: task.end,
            startDate: dateOf(task.start),
            endDate: dateOf(task.end),
            float: task.lateStart - task.start,
            critical: task.lateStart - task.start === 0,
            volumeM3: Math.round(task.volume * 10) / 10,
            counts: task.counts,
            links: task.links,
            elements: task.members.sort(compare).map(element => element.external_id)
        }))
    };
}

module.exports = { buildSchedule, STAGES, addWorkdays };

// wwwroot/4d.js - the auto-generated 4D schedule demo (/4d).
//
// Loads a model in the Viewer and its generated schedule (GET /api/4d/schedule), then
// plays the construction back: built elements show normally, elements of tasks in
// progress take their stage's colour, and unbuilt elements are ghosted (or hidden).
// Server elements are matched to Viewer ids through their externalId (SVF2-safe).

const STAGE_COLORS = {
    substructure: '#8a6a4a',
    vertical: '#3d6f9f',
    horizontal: '#c15f3c',
    circulation: '#7c62a8',
    envelope: '#3f8a64',
    interiors: '#b08a2e',
    fitout: '#6b6a64'
};
const DEFAULT_MODEL_NAME = /^rstbasicsampleproject\.rvt$/i;
const VIEWER_UPDATE_MS = 90;

const $ = id => document.getElementById(id);
const notice = $('notice');

let viewer = null;
let loadedUrn = null;
let schedule = null;
let items = [];          // every scheduled element: { t (reveal day), dbId, task }, sorted by t
let sortedIds = [];      // items' dbIds in the same order
let time = 0;
let playing = false;
let lastFrame = 0;
let gantt = null;        // { bars: [{ progress, task }], playhead, x }

// --------------------------------------------------------------------- dates
function addWorkdays(isoStart, days) {
    const date = new Date(`${isoStart}T00:00:00Z`);
    let left = Math.floor(days);
    while (left > 0) {
        date.setUTCDate(date.getUTCDate() + 1);
        const weekday = date.getUTCDay();
        if (weekday !== 0 && weekday !== 6) left -= 1;
    }
    return date;
}
const formatDate = (date, withYear = true) => date.toLocaleDateString('en-GB', {
    timeZone: 'UTC', weekday: withYear ? 'short' : undefined, day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined
});

// --------------------------------------------------------------------- viewer
async function getAccessToken(callback) {
    const resp = await fetch('/api/auth/token');
    const data = await resp.json();
    if (typeof data === 'string') callback(data, 3600);
    else callback(data.access_token, data.expires_in);
}

function initViewer(container) {
    return new Promise(resolve => {
        Autodesk.Viewing.Initializer({ getAccessToken }, () => {
            const instance = new Autodesk.Viewing.GuiViewer3D(container, { extensions: [] });
            instance.start();
            instance.setTheme('light-theme');
            try { instance.setBackgroundColor(250, 249, 245, 250, 249, 245); } catch { /* cosmetic */ }
            resolve(instance);
        });
    });
}

function loadDocument(urn) {
    return new Promise((resolve, reject) => {
        Autodesk.Viewing.Document.load(`urn:${urn}`, async doc => {
            try {
                if (viewer.model) viewer.unloadModel(viewer.model);
                const geometryLoaded = new Promise(done => {
                    const onLoaded = () => { viewer.removeEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, onLoaded); done(); };
                    viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, onLoaded);
                });
                const model = await viewer.loadDocumentNode(doc, doc.getRoot().getDefaultGeometry());
                await geometryLoaded;
                resolve(model);
            } catch (error) {
                reject(error);
            }
        }, (code, message) => reject(new Error(message || `Viewer error ${code}`)));
    });
}

const externalIdMap = model => new Promise(resolve => model.getExternalIdMapping(resolve, () => resolve({})));

// ------------------------------------------------------------- model + schedule
async function fetchSchedule(urn, start) {
    const params = new URLSearchParams({ urn });
    if (start) params.set('start', start);
    const resp = await fetch(`/api/4d/schedule?${params}`);
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || !body.success) throw new Error(body.message || `The schedule could not be built (${resp.status}).`);
    return body.schedule;
}

async function open(urn, start) {
    pause();
    notice.hidden = false;
    notice.textContent = 'Loading the model and generating its schedule…';
    try {
        const schedulePromise = fetchSchedule(urn, start);
        if (urn !== loadedUrn) {
            await loadDocument(urn);
            loadedUrn = urn;
        }
        schedule = await schedulePromise;
        const map = await externalIdMap(viewer.model);

        items = [];
        for (const task of schedule.tasks) {
            const count = task.elements.length;
            task.dbIds = [];
            task.elements.forEach((externalId, index) => {
                const dbId = map[externalId];
                if (dbId == null) return;
                task.dbIds.push(dbId);
                items.push({ t: task.start + ((index + 1) / count) * task.duration, dbId, task });
            });
        }
        items.sort((a, b) => a.t - b.t);
        sortedIds = items.map(item => item.dbId);

        $('start').value = schedule.start;
        $('statDuration').textContent = `${schedule.totalDays} days`;
        $('statFinish').textContent = formatDate(new Date(`${schedule.finish}T00:00:00Z`));
        $('slider').max = schedule.totalDays;
        renderLegend();
        renderGantt();
        notice.hidden = true;
        setTime(0);
        viewer.fitToView();
    } catch (error) {
        console.error(error);
        notice.hidden = false;
        notice.textContent = error.message || 'Something went wrong.';
    }
}

// ------------------------------------------------------------------ playback
function builtCount(t) {
    let low = 0; let high = items.length;   // first item revealed AFTER t
    while (low < high) {
        const middle = (low + high) >> 1;
        if (items[middle].t <= t) low = middle + 1; else high = middle;
    }
    return low;
}

function setTime(t) {
    if (!schedule) return;
    time = Math.max(0, Math.min(schedule.totalDays, t));
    $('slider').value = time;
    $('dateLabel').textContent = formatDate(addWorkdays(schedule.start, time));
    $('dayLabel').textContent = `Day ${Math.floor(time)} / ${schedule.totalDays}`;

    const built = builtCount(time);
    $('statBuilt').textContent = items.length ? `${Math.round((built / items.length) * 100)}%` : '–';
    let concrete = 0;
    for (const task of schedule.tasks) {
        concrete += task.volumeM3 * Math.max(0, Math.min(1, (time - task.start) / task.duration));
    }
    $('statConcrete').textContent = `${Math.round(concrete)} m³`;
    updateGantt();
    requestViewerUpdate();
}

let viewerTimer = null;
let viewerDirty = false;
function requestViewerUpdate() {
    viewerDirty = true;
    if (viewerTimer) return;
    viewerTimer = setTimeout(() => {
        viewerTimer = null;
        if (viewerDirty) { viewerDirty = false; updateViewer(); }
    }, VIEWER_UPDATE_MS);
}

function updateViewer() {
    const model = viewer?.model;
    if (!model) return;
    const built = builtCount(time);
    viewer.setGhosting($('ghost').checked);
    // isolate([]) would show EVERYTHING: at day 0 isolate an id that doesn't exist instead.
    viewer.isolate(built > 0 ? sortedIds.slice(0, built) : [-1], model);

    viewer.clearThemingColors(model);
    for (const task of schedule.tasks) {
        if (time < task.start || time >= task.end) continue;   // only tasks in progress
        const color = hexToVector(STAGE_COLORS[task.stage] || '#888888');
        const shown = Math.floor(((time - task.start) / task.duration) * task.dbIds.length);
        for (let index = 0; index < shown; index += 1) viewer.setThemingColor(task.dbIds[index], color, model, true);
    }
    viewer.impl.invalidate(true, true, true);
}

function hexToVector(hex) {
    const value = parseInt(hex.slice(1), 16);
    return new THREE.Vector4(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255, 1);
}

function play() {
    if (!schedule) return;
    if (time >= schedule.totalDays) setTime(0);
    playing = true;
    $('play').textContent = 'Pause';
    lastFrame = performance.now();
    requestAnimationFrame(step);
}
function pause() {
    playing = false;
    $('play').textContent = 'Play';
}
function step(now) {
    if (!playing) return;
    const seconds = (now - lastFrame) / 1000;
    lastFrame = now;
    setTime(time + seconds * Number($('speed').value));
    if (time >= schedule.totalDays) { pause(); return; }
    requestAnimationFrame(step);
}

// --------------------------------------------------------------------- gantt
const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attributes = {}, parent) {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (parent) parent.appendChild(node);
    return node;
}

function renderLegend() {
    const legend = $('legend');
    legend.replaceChildren(...schedule.stages.map(stage => {
        const item = document.createElement('span');
        const swatch = document.createElement('i');
        swatch.style.background = STAGE_COLORS[stage.id];
        item.append(swatch, stage.name);
        return item;
    }));
    const critical = document.createElement('span');
    critical.innerHTML = '<i style="background:transparent;outline:1.5px solid var(--critical)"></i>Critical path';
    legend.append(critical);
}

function renderGantt() {
    const container = $('gantt');
    const narrow = container.clientWidth < 640;
    const labelWidth = narrow ? 150 : 250;
    const rowHeight = 24;
    const header = 26;
    const days = schedule.totalDays;
    // (-36: room for the vertical scrollbar, which appears after this is measured)
    const perDay = Math.max(narrow ? 5 : 4, (container.clientWidth - labelWidth - 36) / days);
    const width = labelWidth + days * perDay + 12;
    const rows = schedule.tasks.slice().sort((a, b) => a.start - b.start || a.id - b.id);
    const height = header + rows.length * rowHeight + 8;
    const x = day => labelWidth + day * perDay;

    const root = svg('svg', { width, height, role: 'img', 'aria-label': 'Generated construction schedule' });

    // Week ticks, thinned so labels don't collide.
    const weekEvery = Math.max(1, Math.ceil(64 / (perDay * 5)));
    for (let day = 0; day <= days; day += 5 * weekEvery) {
        svg('line', { x1: x(day), x2: x(day), y1: header - 6, y2: height, class: 'grid' }, root);
        const label = svg('text', { x: x(day) + 3, y: 16, class: 'tick' }, root);
        label.textContent = formatDate(addWorkdays(schedule.start, day), false);
    }

    const bars = [];
    rows.forEach((task, row) => {
        const y = header + row * rowHeight;
        if (row % 2 === 0) svg('rect', { x: 0, y, width, height: rowHeight, class: 'rowband' }, root);
        const color = STAGE_COLORS[task.stage];

        const label = svg('text', { x: 10, y: y + 16, class: `row-label${task.critical ? ' critical' : ''}` }, root);
        const maxChars = Math.floor(labelWidth / 7.2);
        label.textContent = task.name.length > maxChars ? `${task.name.slice(0, maxChars - 1)}…` : task.name;

        const group = svg('g', { class: `bar${task.critical ? ' critical' : ''}` }, root);
        svg('rect', { x: x(task.start), y: y + 5, width: Math.max(2, task.duration * perDay), height: rowHeight - 10, rx: 2, fill: color, class: 'track' }, group);
        const progress = svg('rect', { x: x(task.start), y: y + 5, width: 0, height: rowHeight - 10, rx: 2, fill: color }, group);
        const counts = Object.entries(task.counts).map(([name, n]) => `${n} ${name}`).join(', ');
        svg('title', {}, group).textContent = `${task.name}\n${formatDate(new Date(`${task.startDate}T00:00:00Z`))} → ` +
            `${formatDate(new Date(`${task.endDate}T00:00:00Z`))} (${task.duration} days)\n${counts}` +
            `${task.volumeM3 ? `\n${task.volumeM3} m³` : ''}\n${task.critical ? 'Critical path' : `Float: ${task.float} days`}`;

        const focus = () => {
            pause();
            setTime(task.start + task.duration * 0.6);
            if (task.dbIds.length) viewer.fitToView(task.dbIds, viewer.model);
        };
        group.addEventListener('click', focus);
        label.addEventListener('click', focus);
        bars.push({ task, progress, perDay });
    });

    const playhead = svg('line', { y1: header - 6, y2: height, class: 'playhead' }, root);
    container.replaceChildren(root);
    gantt = { bars, playhead, x };
}

function updateGantt() {
    if (!gantt) return;
    for (const { task, progress, perDay } of gantt.bars) {
        const done = Math.max(0, Math.min(task.duration, time - task.start));
        progress.setAttribute('width', done * perDay);
        progress.parentNode.classList.toggle('active', time >= task.start && time < task.end);
    }
    const position = gantt.x(time);
    gantt.playhead.setAttribute('x1', position);
    gantt.playhead.setAttribute('x2', position);
}

// ------------------------------------------------------------------ controls
async function setupModels() {
    const resp = await fetch('/api/models');
    const models = (await resp.json()).filter(model => /\.rvt$/i.test(model.name));
    const select = $('models');
    select.replaceChildren(...models.map(model => new Option(model.name, model.urn)));
    const wanted = decodeURIComponent(location.hash.slice(1));
    const chosen = models.find(model => model.name === wanted) || models.find(model => DEFAULT_MODEL_NAME.test(model.name)) || models[0];
    if (!chosen) throw new Error('No Revit models found.');
    select.value = chosen.urn;
    select.addEventListener('change', () => {
        const model = models.find(m => m.urn === select.value);
        history.replaceState(null, '', `#${encodeURIComponent(model.name)}`);
        open(select.value, $('start').value);
    });
    return chosen.urn;
}

$('play').addEventListener('click', () => (playing ? pause() : play()));
$('reset').addEventListener('click', () => { pause(); setTime(0); });
$('slider').addEventListener('input', event => { pause(); setTime(Number(event.target.value)); });
$('ghost').addEventListener('change', requestViewerUpdate);
$('start').addEventListener('change', () => { if ($('start').value) open($('models').value, $('start').value); });
let resizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (schedule) { renderGantt(); updateGantt(); } }, 150);
});

(async () => {
    try {
        viewer = await initViewer($('viewer'));
        const urn = await setupModels();
        await open(urn);
    } catch (error) {
        console.error(error);
        notice.hidden = false;
        notice.textContent = error.message || 'The 4D demo could not start.';
    }
})();

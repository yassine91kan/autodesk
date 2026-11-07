import { initViewer, loadModel } from './viewer.js';

const ROWS_SHOWN = 4;
const ACCENT = 0xd97757;         // Claude orange: the newest answer's selection
const OLDER = 0x6a9bcc;          // Claude blue: selections made from older entries
const LEVEL_KEYS = ['Level', 'Base Level', 'Reference Level', 'Base Constraint'];
const MATERIAL_KEYS = ['Structural Material', 'Material'];
const PROP_FILTER = ['name', 'Type Name', ...LEVEL_KEYS, ...MATERIAL_KEYS];
const DBKEY = 11;                // property type: a reference to another element
const DASH = '–';

let routeselect = document.querySelector('input[name="agent"]:checked')?.value || 'ask_agent_simple';
let currentViewer = null;
let pendingSelection = null;     // a selection that arrived before the model finished loading
let busy = false;
let entryCount = 0;
let activeOwner = null;          // the entry whose elements are selected in the model
let lastSelectedUrn = null;      // to notice when a DIFFERENT model is picked
let resolveModelReady;
let modelReady = new Promise(resolve => { resolveModelReady = resolve; });

initViewer(document.getElementById('preview')).then(viewer => {
    currentViewer = viewer;
    try {
        viewer.setBackgroundColor(250, 249, 245, 250, 249, 245);   // the model sits on the ivory sheet
    } catch (err) {
        console.warn('Viewer styling skipped.', err);
    }
    viewer.addEventListener(Autodesk.Viewing.OBJECT_TREE_CREATED_EVENT, () => resolveModelReady());
    viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, () => {
        if (pendingSelection) {
            highlight(pendingSelection.ids, pendingSelection.owner);
            pendingSelection = null;
        }
        sendPositions(viewer, currentUrn()).catch(err => console.warn('Element positions not sent.', err));
    });
    // Zones follow the selection as the camera moves.
    let zoneTimer = null;
    viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, () => {
        clearTimeout(zoneTimer);
        zoneTimer = setTimeout(updateZones, 120);
    });
    window.addEventListener('resize', () => {
        clearTimeout(zoneTimer);
        zoneTimer = setTimeout(updateZones, 200);
    });
    // The address ends in the model's file name ("#rstbasicsampleproject.rvt"), so a
    // reload or a shared link opens the same model. Old links with a URN still work.
    const wanted = decodeURIComponent(window.location.hash.substring(1));
    setupModelSelection(viewer, wanted);
    setupModelUpload(viewer);
});

// ---------------------------------------------------------------------------
// Model selection and upload
// ---------------------------------------------------------------------------
// The model selected when the address doesn't name one ("rstbasicsampleproject.rvt").
const DEFAULT_MODEL_NAME = /^rstbasicsampleproject\.rvt$/i;

// `wanted` is the model to select: its file name (from the address) or its URN (after an upload).
async function setupModelSelection(viewer, wanted) {
    const dropdown = document.getElementById('models');
    dropdown.innerHTML = '';
    try {
        const resp = await fetch('/api/models');
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        const models = await resp.json();
        // No model in the address (or one that no longer exists): start with the RST Basic sample.
        const found = models.some(model => model.name === wanted || model.urn === wanted);
        const start = found ? wanted : models.find(model => DEFAULT_MODEL_NAME.test(model.name))?.name;
        for (const model of models) {
            const isWanted = model.name === start || model.urn === start;
            dropdown.add(new Option(model.name, model.urn, false, isWanted));
        }
        dropdown.onchange = () => onModelSelected(viewer, dropdown.value);
        if (dropdown.value) {
            onModelSelected(viewer, dropdown.value);
        }
    } catch (err) {
        setModelName('No models available');
        showNotification('Could not list the models. Check the server connection and reload the page.');
        console.error(err);
    }
}

async function setupModelUpload(viewer) {
    const upload = document.getElementById('upload');
    const input = document.getElementById('input');
    const models = document.getElementById('models');
    // Only signed-in users may upload. Check BEFORE the file picker opens: otherwise a
    // guest picks a (large) Revit file, sends it, and only then gets refused.
    // (The server refuses guest uploads too: routes/login.js.)
    upload.onclick = async () => {
        await accountReady;
        if (account.kind !== 'member') return showUploadNeedsSignIn();
        input.click();
    };
    input.onchange = async () => {
        const file = input.files[0];
        let data = new FormData();
        data.append('model-file', file);
        if (file.name.endsWith('.zip')) { // When uploading a zip file, ask for the main design file in the archive
            const entrypoint = window.prompt('Please enter the filename of the main design inside the archive.');
            data.append('model-zip-entrypoint', entrypoint);
        }
        upload.setAttribute('disabled', 'true');
        models.setAttribute('disabled', 'true');
        showNotification(`Uploading ${file.name}. Do not reload the page.`);
        try {
            const resp = await fetch('/api/models', { method: 'POST', body: data });
            if (resp.status === 401) {                // signed out meanwhile (session expired)
                clearNotification();
                return showUploadNeedsSignIn();
            }
            if (!resp.ok) {
                throw new Error(await resp.text());
            }
            const model = await resp.json();
            clearNotification();
            setupModelSelection(viewer, model.urn);
        } catch (err) {
            showNotification(`Could not upload ${file.name}. Check the file and try again.`);
            console.error(err);
        } finally {
            upload.removeAttribute('disabled');
            models.removeAttribute('disabled');
            input.value = '';
        }
    };
}

async function onModelSelected(viewer, urn) {
    if (window.onModelSelectedTimeout) {
        clearTimeout(window.onModelSelectedTimeout);
        delete window.onModelSelectedTimeout;
    }
    const dropdown = document.getElementById('models');
    const name = dropdown.options[dropdown.selectedIndex]?.text || DASH;
    setModelName(name);
    // Show the readable file name in the address instead of the long URN.
    // replaceState changes the address without adding a Back-button step per model.
    history.replaceState(null, '', `#${encodeURIComponent(name)}`);
    // The Viewer extensions (Logger, Summary) read the selected model from here.
    window.selectedModelUrn = urn;
    modelReady = new Promise(resolve => { resolveModelReady = resolve; });

    // A different model: earlier answers point at elements of the old one, so the
    // schedule starts over. (This function also re-runs every 5 s while a model is
    // being translated; that's the same model, so nothing is cleared then.)
    if (urn !== lastSelectedUrn) {
        if (entryCount > 0) startNewSheet();
        lastSelectedUrn = urn;
    }
    try {
        const resp = await fetch(`/api/models/${urn}/status`);
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        const status = await resp.json();
        switch (status.status) {
            case 'n/a':
                showNotification('This model has not been translated yet.');
                setIndexStatus({ state: 'error', message: 'This model has not been translated yet.' });
                break;
            case 'inprogress':
                showNotification(`Preparing the model (${status.progress})…`);
                setIndexStatus({ state: 'loading', label: 'Waiting for translation…', message: `APS is translating the model (${status.progress}).` });
                window.onModelSelectedTimeout = setTimeout(onModelSelected, 5000, viewer, urn);
                break;
            case 'failed':
                showNotification('The model could not be translated.', status.messages.map(msg => JSON.stringify(msg)));
                setIndexStatus({ state: 'error', message: 'The model could not be translated.' });
                break;
            default:
                clearNotification();
                loadModel(viewer, urn);
                loadIndexStatus(urn);   // index the same model on the server, in parallel
                break;
        }
    } catch (err) {
        showNotification('Could not load the model. Check the server connection and try another model.');
        console.error(err);
    }
}

document.getElementById('tbDate').textContent = new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });

// File-type badge shown at the left of the model picker (Revit, AutoCAD, ...).
const FORMATS = {
    rvt: ['R', 'Revit model'],
    rfa: ['R', 'Revit family'],
    dwg: ['A', 'AutoCAD drawing'],
    nwd: ['N', 'Navisworks model'],
    nwc: ['N', 'Navisworks model'],
    ifc: ['I', 'IFC model']
};

// The model name lives on the drawing's view title only; the schedule column
// keeps its width for the answers.
function setModelName(name) {
    document.getElementById('viewModelName').textContent = name;
    const ext = (String(name).split('.').pop() || '').toLowerCase();
    const [letter, label] = FORMATS[ext] || ['M', 'Model'];
    const badge = document.getElementById('modelBadge');
    badge.textContent = letter;
    badge.dataset.format = FORMATS[ext] ? ext : 'other';
    badge.title = label;
}

// A guest clicked Upload: say why it can't happen, on the page, with a way to sign in.
// (The file picker never opens, so no file is sent. The server refuses guest uploads too.)
function showUploadNeedsSignIn() {
    showToast('Sign in to upload',
        'Uploading Revit models is for signed-in users. You can keep asking questions about the models already here.',
        { label: 'Sign in', href: signInUrl('upload') }, 'alert');
}

// The server answered 401 (this needs signing in): go to the sign-in page and come
// back to this model afterwards. `reason` picks the message the sign-in page shows.
function signInAgain(reason = 'member') {
    location.assign(signInUrl(reason));
}
function signInUrl(reason) {
    return `/login?error=${reason}&next=${encodeURIComponent('/app' + location.hash)}`;
}

// ---------------------------------------------------------------------------
// Guest or signed in?
// ---------------------------------------------------------------------------
// Anyone can ask as a guest, with a daily token budget. The top bar shows "Sign in"
// to guests and "Log out" to signed-in users.
let account = { kind: 'guest', budget: null };
async function loadAccount() {
    try {
        const resp = await fetch('/api/me');
        if (resp.ok) account = await resp.json();
    } catch (err) {
        console.warn('Could not check the sign-in state.', err);
    }
    const isGuest = account.kind === 'guest';
    const signIn = document.getElementById('signIn');
    signIn.hidden = !isGuest;
    signIn.href = signInUrl('');
    document.getElementById('logOut').hidden = isGuest;
    // Guests see that uploading needs signing in before they click.
    const upload = document.getElementById('upload');
    upload.title = isGuest ? 'Sign in to upload a Revit model' : 'Upload a new model';
}
// The upload button waits for this, so a click right after the page opens is checked too.
const accountReady = loadAccount();

// The model chosen in the dropdown. Every question and status check is sent with it,
// so the assistant always answers about the model you are looking at.
function currentUrn() {
    return document.getElementById('models').value;
}

// ---------------------------------------------------------------------------
// Element positions, for distance questions ("distance between the columns")
// ---------------------------------------------------------------------------
// The model's property data has no positions; the Viewer's geometry does. Once a model
// has loaded, each element's bounding box (centre, min and max corners) is sent to the
// server, in metres, keyed by externalId. The server keeps it in the model's index for
// everyone, so this happens once per model: the page asks first and only sends if
// there are none (a reload, or a second visitor, sends nothing).
const METRES_PER_VIEWER_UNIT = { ft: 0.3048, feet: 0.3048, in: 0.0254, m: 1, cm: 0.01, mm: 0.001 };
async function sendPositions(viewer, urn) {
    const model = viewer.model;
    if (!model || !urn) return;
    const stored = await fetch(`/model_positions?urn=${encodeURIComponent(urn)}`).then(r => r.json());
    if (stored.count > 0) return;

    const unit = model.getUnitString?.() || model.getDisplayUnit?.() || 'm';
    const scale = METRES_PER_VIEWER_UNIT[String(unit).toLowerCase()] ?? 1;
    const tree = model.getInstanceTree();
    const fragments = model.getFragmentList();
    const idMap = await externalIdMap(model);          // externalId -> dbId (also used for highlighting)
    const box = new THREE.Box3();
    const part = new THREE.Box3();
    const positions = {};
    for (const [externalId, dbId] of Object.entries(idMap)) {
        box.makeEmpty();
        tree.enumNodeFragments(dbId, fragId => {
            fragments.getWorldBounds(fragId, part);
            box.union(part);
        }, true);
        if (box.isEmpty()) continue;                     // no geometry (e.g. a level or a grid)
        const metres = v => [v.x, v.y, v.z].map(n => Math.round(n * scale * 1000) / 1000);
        positions[externalId] = { center: metres(box.getCenter(new THREE.Vector3())), min: metres(box.min), max: metres(box.max) };
    }
    console.log(`Sending ${Object.keys(positions).length} element positions (viewer unit: ${unit}).`);
    await fetch('/model_positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urn, positions })
    });
}

// ---------------------------------------------------------------------------
// Model status (top bar): is the selected model ready for questions?
// ---------------------------------------------------------------------------
// states: loading | ready | unsupported (e.g. a DWG drawing) | error
let indexStatus = { state: 'loading' };

function setIndexStatus(status) {
    indexStatus = status;
    updateIndexStatus();
}

async function loadIndexStatus(urn) {
    setIndexStatus({ state: 'loading' });
    let next;
    try {
        // Also loads and indexes the model on the server, so the first question is fast.
        const resp = await fetch(`/model_status?urn=${encodeURIComponent(urn)}`);
        if (resp.status === 401) return signInAgain();
        const data = await resp.json();
        if (data.ready) {
            next = { state: 'ready', ...data };
        } else if (data.reason === 'unsupported') {
            next = { state: 'unsupported', message: data.message };
        } else if (data.reason === 'not-ready') {
            // APS is still preparing the model's data (big models, the first time):
            // not an error, so keep waiting and check again by ourselves.
            next = { state: 'loading', label: 'Preparing model data…', message: data.message };
        } else {
            next = { state: 'error', message: data.message || 'The model index is not available.' };
        }
    } catch (err) {
        next = { state: 'error', message: 'Could not reach the server.' };
        console.error(err);
    }
    // Indexing a big model takes a while. If another model was picked meanwhile,
    // this answer is about the old one: don't show it.
    if (urn !== currentUrn()) return;
    setIndexStatus(next);
    if (next.label === 'Preparing model data…') {
        setTimeout(() => { if (urn === currentUrn()) loadIndexStatus(urn); }, 15000);
    }
}

function updateIndexStatus() {
    const chip = document.getElementById('indexStatus');
    const text = document.getElementById('indexStatusText');
    const s = indexStatus;
    let label, tip;

    if (s.state === 'ready') {
        const time = new Date(s.loadedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        label = `Indexed · ${s.elementCount.toLocaleString()} elements · ${time}`;
        tip = `Questions are answered about ${s.modelName}, indexed at ${time}.`;
    } else if (s.state === 'unsupported') {
        label = 'No questions for this model';
        tip = s.message;
    } else if (s.state === 'error') {
        label = 'Model index unavailable';
        tip = s.message;
    } else {
        label = s.label || 'Indexing model…';
        tip = s.message || 'The server is loading the model index.';
    }

    chip.dataset.state = s.state;
    text.textContent = label;
    chip.title = tip;
}

function showNotification(message, details = []) {
    const overlay = document.getElementById('overlay');
    const box = el('div', 'notification', message);
    if (details.length) {
        const list = el('ul');
        details.forEach(detail => list.append(el('li', null, detail)));
        box.append(list);
    }
    overlay.replaceChildren(box);
    overlay.style.display = 'flex';
}

function clearNotification() {
    const overlay = document.getElementById('overlay');
    overlay.replaceChildren();
    overlay.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Assistant routing
// ---------------------------------------------------------------------------
document.querySelectorAll('input[name="agent"]').forEach(radio => {
    radio.addEventListener('change', () => {
        if (radio.checked) {
            routeselect = radio.value;
        }
    });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Text always goes in as text, never as HTML.
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

const markFor = n => `A-${String(n).padStart(2, '0')}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const stripId = name => String(name || '').replace(/\s*\[\d+\]$/, '');

function describeFilter(filter) {
    if (!filter) return '';
    const parts = [];
    if (filter.categories?.length) parts.push(`Category = ${filter.categories.join(' / ')}`);
    if (filter.levels?.length) parts.push(`Level = ${filter.levels.join(' / ')}`);
    if (filter.materials?.length) parts.push(`Material = ${filter.materials.join(' / ')}`);
    return parts.join(' · ');
}

// The revision delta: a drawn triangle carrying the entry's mark.
function deltaMark(mark) {
    const ns = 'http://www.w3.org/2000/svg';
    const wrap = el('span', 'delta');
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 56 32');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M28 1.5 L54.5 30.5 L1.5 30.5 Z');
    svg.append(path);
    wrap.append(svg, el('span', 'delta__mark', mark));
    return wrap;
}

// ---------------------------------------------------------------------------
// Element properties, read from the model itself
// ---------------------------------------------------------------------------
function bulkProperties(ids, filter) {
    return new Promise(resolve => {
        if (!currentViewer?.model || ids.length === 0) return resolve([]);
        currentViewer.model.getBulkProperties(ids, { propFilter: filter }, resolve, () => resolve([]));
    });
}

function propValue(props, names) {
    for (const name of names) {
        const prop = props.find(p => p.displayName === name);
        if (prop && prop.displayValue !== '' && prop.displayValue !== null && prop.displayValue !== '<By Category>') return prop;
    }
    return null;
}

// ---------------------------------------------------------------------------
// The server's element ids -> the Viewer's ids
// ---------------------------------------------------------------------------
// The server finds elements by the id in the model's property data (objectid). The
// Viewer has its own id per element (dbId). For SVF models they are the same number,
// but SVF2 models (e.g. Seaport) number them differently: selecting "4521" then picks
// the WRONG element. Every element also has a permanent externalId (Revit's UniqueId),
// the same in every format, so we translate through that.
const externalIdMaps = new WeakMap();   // Viewer model -> { externalId: dbId }, read once per model
function externalIdMap(model) {
    if (!externalIdMaps.has(model)) {
        externalIdMaps.set(model, new Promise(resolve => model.getExternalIdMapping(resolve, () => resolve({}))));
    }
    return externalIdMaps.get(model);
}
// Returns the elements with `id` = the Viewer's dbId, and `modelId` = the server's id
// (shown in the table). Without a loaded model, or an externalId, the id stays as it is.
async function toViewerIds(elements) {
    const model = currentViewer?.model;
    if (!model) return elements.map(e => ({ ...e, modelId: e.id }));
    const map = await externalIdMap(model);
    return elements.map(e => ({ ...e, modelId: e.id, id: (e.externalId && map[e.externalId]) ?? e.id }));
}

async function describeElements(elements) {
    await modelReady;
    const rows = await bulkProperties(elements.map(e => e.id), PROP_FILTER);
    // Level properties point at the level element; read those names once.
    const levelIds = new Set();
    for (const row of rows) {
        const level = propValue(row.properties || [], LEVEL_KEYS);
        if (level?.type === DBKEY) levelIds.add(Number(level.displayValue));
    }
    const levelNames = new Map((await bulkProperties([...levelIds], ['name'])).map(r => [r.dbId, stripId(r.name)]));

    const map = new Map();
    for (const row of rows) {
        const props = row.properties || [];
        const level = propValue(props, LEVEL_KEYS);
        const material = propValue(props, MATERIAL_KEYS);
        const type = propValue(props, ['Type Name']);
        map.set(row.dbId, {
            type: type ? String(type.displayValue) : stripId(row.name),
            material: material ? String(material.displayValue) : '',
            level: level ? (level.type === DBKEY ? levelNames.get(Number(level.displayValue)) : String(level.displayValue)) || DASH : DASH
        });
    }
    return map;
}

// ---------------------------------------------------------------------------
// Zone references: which sheet zones hold the selected elements on screen
// ---------------------------------------------------------------------------
const ZONE_RINGS = ['top', 'bottom', 'left', 'right'].map(side => [...document.querySelectorAll(`.zones--${side} span`)]);

function selectionScreenRect(ids) {
    const viewer = currentViewer;
    const tree = viewer?.model?.getInstanceTree();
    if (!tree || !ids.length) return null;
    const fragments = viewer.model.getFragmentList();
    const box = new THREE.Box3();
    const part = new THREE.Box3();
    for (const id of ids) {
        tree.enumNodeFragments(id, fragId => {
            fragments.getWorldBounds(fragId, part);
            box.union(part);
        }, true);
    }
    if (box.isEmpty()) return null;

    const frame = viewer.container.getBoundingClientRect();
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const p = viewer.worldToClient(new THREE.Vector3(x, y, z));
        left = Math.min(left, frame.left + p.x);
        right = Math.max(right, frame.left + p.x);
        top = Math.min(top, frame.top + p.y);
        bottom = Math.max(bottom, frame.top + p.y);
    }
    // Only the part that is actually visible in the drawing counts.
    left = Math.max(left, frame.left);
    right = Math.min(right, frame.right);
    top = Math.max(top, frame.top);
    bottom = Math.min(bottom, frame.bottom);
    return right > left && bottom > top ? { left, right, top, bottom } : 'outside';
}

function overlapping(spans, from, to, horizontal) {
    return spans
        .map((span, index) => ({ index, r: span.getBoundingClientRect() }))
        .filter(({ r }) => horizontal ? r.right > from && r.left < to : r.bottom > from && r.top < to)
        .map(({ index }) => index);
}

function updateZones() {
    ZONE_RINGS.flat().forEach(span => span.classList.remove('lit'));
    const ids = currentViewer?.getSelection() || [];
    const owner = activeOwner;
    const rect = ids.length ? selectionScreenRect(ids) : null;
    let label = '';
    if (rect === 'outside') {
        label = 'outside the current view';
    } else if (rect) {
        const cols = overlapping(ZONE_RINGS[0], rect.left, rect.right, true);
        const rows = overlapping(ZONE_RINGS[2], rect.top, rect.bottom, false);
        if (cols.length && rows.length) {
            cols.forEach(i => { ZONE_RINGS[0][i].classList.add('lit'); ZONE_RINGS[1][i].classList.add('lit'); });
            rows.forEach(i => { ZONE_RINGS[2][i].classList.add('lit'); ZONE_RINGS[3][i].classList.add('lit'); });
            const name = (row, col) => `${ZONE_RINGS[2][row].textContent}${ZONE_RINGS[0][col].textContent}`;
            const first = name(rows[0], cols[0]);
            const last = name(rows[rows.length - 1], cols[cols.length - 1]);
            label = first === last ? `zone ${first}` : `zones ${first}–${last}`;
        }
    }
    document.querySelector('.sheet').classList.toggle('is-latest-zones', Boolean(owner?.classList.contains('is-latest')));
    if (owner && ids.length) {
        setDrawingTag(owner.dataset.mark, label || plural(ids.length, 'element', 'elements') + ' selected', owner.classList.contains('is-latest'));
        const ref = owner.querySelector('.zone-ref__text');
        if (ref) ref.textContent = label || DASH;
    }
}

// ---------------------------------------------------------------------------
// Selection in the model
// ---------------------------------------------------------------------------
// Orange belongs to the newest entry; selections made from older entries are blue.
function highlight(ids, owner) {
    activeOwner = owner || null;
    const latest = !owner || owner.classList.contains('is-latest');
    if (!currentViewer?.model) {
        pendingSelection = { ids, owner };
        return;
    }
    try {
        currentViewer.setSelectionColor(new THREE.Color(latest ? ACCENT : OLDER), Autodesk.Viewing.SelectionType.MIXED);
        currentViewer.clearSelection();
        currentViewer.select(ids);
        currentViewer.fitToView(ids);
        setTimeout(updateZones, 700);   // after the camera settles on the selection
    } catch (err) {
        pendingSelection = { ids, owner };
        console.warn('Selection deferred until the model is ready.', err);
    }
}

function clearHighlight(owner) {
    pendingSelection = null;
    if (currentViewer?.model) currentViewer.clearSelection();
    activeOwner = owner || null;
    updateZones();
}

// The drawing carries the revision too: which entry the model is showing.
function setDrawingTag(mark, text, latest) {
    const tag = document.getElementById('viewRev');
    tag.hidden = !mark;
    tag.classList.toggle('is-latest', Boolean(latest));
    document.getElementById('viewRevMark').textContent = mark || '';
    document.getElementById('viewRevText').textContent = text || '';
}

// ---------------------------------------------------------------------------
// Schedule of answers
// ---------------------------------------------------------------------------
const log = document.getElementById('promptInput');
// A copy of the starting "General notes", so New sheet can put them back.
const notesTemplate = document.getElementById('chatEmpty').cloneNode(true);
const composer = document.getElementById('composer');
const promptBox = document.getElementById('fname');
const sendButton = composer.querySelector('button[type="submit"]');

function updateCounts() {
    document.getElementById('answerCount').textContent = plural(entryCount, 'entry', 'entries');
    document.getElementById('tbEntries').textContent = entryCount;
}

function addEntry(prompt) {
    document.getElementById('chatEmpty')?.remove();
    entryCount += 1;
    updateCounts();

    const entry = el('article', 'entry');
    entry.dataset.mark = markFor(entryCount);
    entry.setAttribute('aria-label', `Entry ${markFor(entryCount)}`);

    const head = el('div', 'entry__head msg--user');
    head.append(deltaMark(markFor(entryCount)), el('p', 'msg__body entry__query', prompt));

    const answer = el('div', 'entry__answer msg--assistant');
    const body = el('div', 'msg__body is-pending');
    body.setAttribute('aria-busy', 'true');
    body.append(el('p', 'entry__status', 'Querying the model'), el('span', 'progress-line'));
    answer.append(body);

    entry.append(head, answer);
    log.append(entry);
    log.scrollTop = log.scrollHeight;
    return { entry, body };
}

function settle(body) {
    body.classList.remove('is-pending');
    body.removeAttribute('aria-busy');
    body.replaceChildren();
}

// The newest answer is marked in orange; older entries drop back to ink.
function makeLatest(entry) {
    log.querySelectorAll('.entry.is-latest').forEach(old => {
        old.classList.remove('is-latest');
        old.querySelectorAll('.result-item[aria-pressed="true"]').forEach(row => row.setAttribute('aria-pressed', 'false'));
    });
    entry.classList.add('is-latest');
    document.getElementById('tbRev').textContent = entry.dataset.mark;
    if (!entry.dataset.selects) {
        clearHighlight(entry);
        setDrawingTag(entry.dataset.mark, 'no elements selected', true);
    }
}

function renderText(entry, body, text) {
    settle(body);
    body.classList.add('entry__note');
    String(text).split('\n').filter(Boolean).forEach(line => body.append(el('p', null, line)));
    makeLatest(entry);
}

// Today's free tokens are used up: say so, and offer signing in instead of "Try again".
function renderLimit(entry, body, message) {
    settle(body);
    body.classList.add('is-error');
    const signIn = el('a', 'btn-line', 'Sign in to keep asking');
    signIn.href = signInUrl('limit');
    body.append(el('p', 'entry__flag', 'Daily limit reached'), el('p', null, message), signIn);
    makeLatest(entry);
}

function renderError(entry, body, message, retry) {
    settle(body);
    body.classList.add('is-error');
    body.append(el('p', 'entry__flag', 'Not answered'), el('p', null, message));
    const again = el('button', 'btn-line', 'Try again');
    again.type = 'button';
    again.addEventListener('click', () => {
        entry.remove();
        retry();
    });
    body.append(again);
}

async function renderElements(entry, body, data) {
    settle(body);
    const elements = await toViewerIds((data.message.elements || []).map(e => ({ id: e.id, externalId: e.externalId, name: e.name })));

    if (elements.length === 0) {
        body.append(el('p', 'result-summary', 'No matching elements found in this model.'));
        body.append(el('p', 'entry__hint', 'Try another element type, level or material, e.g. "show me the columns".'));
        makeLatest(entry);
        return;
    }

    // v2 sends the real total in message.count (it returns at most 500 elements) and a
    // sentence saying what was searched in `answer`, e.g. "Found 42 Structural Framing
    // elements where Structural Material contains "steel"." That sentence is the evidence.
    const total = data.message.count ?? elements.length;
    const summary = el('p', 'result-summary');
    summary.append(el('span', null, data.answer || `${total} elements found`), el('span', 'result-summary__count', String(total)));
    body.append(summary);

    const method = data.propertyPath || describeFilter(data.filter);
    if (method) {
        const line = el('p', 'entry__method');
        line.append(el('span', 'caps', 'Matched on'), el('span', null, method));
        body.append(line);
    }

    const zone = el('p', 'zone-ref');
    zone.append(el('span', 'caps', 'In view'), el('span', 'zone-ref__text', 'locating…'));
    body.append(zone);

    const table = el('div', 'result-table');
    table.setAttribute('role', 'list');
    const header = el('div', 'result-table__head');
    header.append(el('span', 'caps', 'Type'), el('span', 'caps', 'Level'), el('span', 'caps', 'ID'));
    body.append(header, table);

    let details = new Map();
    let limit = ROWS_SHOWN;
    const renderRows = () => {
        table.replaceChildren(...elements.slice(0, limit).map(element => {
            const info = details.get(element.id);
            const row = el('button', 'result-item');
            row.type = 'button';
            row.dataset.id = element.id;
            row.setAttribute('role', 'listitem');
            row.setAttribute('aria-pressed', 'false');
            const type = el('span', 'result-item__name');
            type.append(el('span', null, info?.type || stripId(element.name)));
            if (info?.material) type.append(el('small', null, info.material));
            row.append(type, el('span', 'result-item__level', info?.level || DASH), el('span', 'result-item__id', String(element.modelId ?? element.id)));
            row.addEventListener('click', () => {
                table.querySelectorAll('[aria-pressed="true"]').forEach(other => other.setAttribute('aria-pressed', 'false'));
                row.setAttribute('aria-pressed', 'true');
                highlight([element.id], entry);
            });
            return row;
        }));
    };
    renderRows();

    const actions = el('div', 'entry__actions');
    const button = (label, handler) => {
        const b = el('button', 'btn-line', label);
        b.type = 'button';
        b.addEventListener('click', handler);
        return b;
    };
    if (total > elements.length) {
        body.append(el('p', 'entry__hint', `The first ${elements.length} of ${total} are listed and selected.`));
    }
    if (elements.length > ROWS_SHOWN) {
        const note = el('span', 'entry__hint', `Showing ${ROWS_SHOWN} of ${elements.length}`);
        const all = button('Show all', () => {
            limit = elements.length;
            renderRows();
            note.remove();
            all.remove();
        });
        actions.append(note, all);
    }
    const ids = elements.map(e => e.id);
    actions.append(
        button('Isolate', () => {
            highlight(ids, entry);
            currentViewer?.isolate(ids);
        }),
        button('Clear', () => {
            table.querySelectorAll('[aria-pressed="true"]').forEach(row => row.setAttribute('aria-pressed', 'false'));
            currentViewer?.showAll();
            clearHighlight(entry);
            setDrawingTag(entry.dataset.mark, 'selection cleared', entry.classList.contains('is-latest'));
            zone.querySelector('.zone-ref__text').textContent = DASH;
        })
    );
    body.append(actions);

    entry.dataset.selects = '1';
    makeLatest(entry);
    highlight(ids, entry);

    details = await describeElements(elements);
    renderRows();
}

// 👍/👎 under an answer, saved in the question log (POST /feedback). A 👎 is saved at
// once, then asks in one optional line what was wrong (sent again with the note).
function addFeedback(body, questionId) {
    const bar = el('div', 'feedback');
    const label = el('span', 'entry__hint', 'Was this right?');
    const save = (vote, note) => fetch('/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId, vote, note })
    }).then(r => r.ok).catch(() => false);

    const button = (vote, text, title) => {
        const b = el('button', 'btn-line', text);
        b.type = 'button';
        b.title = title;
        b.setAttribute('aria-label', title);
        b.addEventListener('click', () => choose(vote, b));
        return b;
    };
    const up = button('up', '👍', 'Right answer');
    const down = button('down', '👎', 'Wrong answer');
    bar.append(label, up, down);
    body.append(bar);

    async function choose(vote, pressed) {
        up.disabled = down.disabled = true;
        pressed.setAttribute('aria-pressed', 'true');
        const saved = await save(vote);
        if (!saved) { label.textContent = 'Could not save your rating, sorry.'; return; }
        if (vote === 'up') { label.textContent = 'Thanks!'; return; }

        label.textContent = 'Thanks. What was wrong?';
        const form = el('form', 'feedback__form');
        const input = el('input');
        input.type = 'text';
        input.maxLength = 300;
        input.placeholder = 'Optional, e.g. "wrong level"';
        input.setAttribute('aria-label', 'What was wrong with this answer');
        const send = el('button', 'btn-line', 'Send');
        send.type = 'submit';
        form.append(input, send);
        bar.append(form);
        input.focus();
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const note = input.value.trim();
            form.remove();
            if (!note) { label.textContent = 'Thanks, noted.'; return; }
            label.textContent = (await save('down', note)) ? 'Thanks, noted.' : 'Could not save your note, sorry.';
        });
    }
}

// Questions above this many tokens (prompt + answer, all LLM calls) get a notice.
const TOKEN_WARNING = 2000;

function updateTokens(data) {
    const usage = data?.token?.currentRequest;
    document.getElementById('compToken').textContent = usage?.completionTokens ?? 0;
    document.getElementById('promptToken').textContent = usage?.promptTokens ?? 0;
    if ((usage?.totalTokens ?? 0) > TOKEN_WARNING) {
        showToast('High token use',
            `This question used ${usage.totalTokens.toLocaleString()} tokens (the limit is ${TOKEN_WARNING.toLocaleString()}). ` +
            'It needed the full model description. Naming the category, level or material directly keeps questions cheaper.');
    }
}

// Guests: past 80% of today's budget, say how much is left (once per page visit,
// so it doesn't pop up after every question).
let budgetWarned = false;
function warnAboutBudget(budget) {
    if (!budget || budget.kind !== 'guest' || !budget.warn || budgetWarned) return;
    budgetWarned = true;
    const left = Math.max(0, budget.limit - budget.used);
    showToast('Free questions almost used',
        `You have about ${left.toLocaleString()} of today's ${budget.limit.toLocaleString()} free tokens left. Sign in to keep asking without a limit.`);
}

// A small notice in the corner that closes itself after 8 s (or with its × button).
// Unlike showNotification it doesn't cover the model, so work can go on.
// `action` (optional): { label, href } for a link button in the notice, e.g. "Sign in".
// `role`: 'status' for information, 'alert' for something the user tried that didn't work.
let toastTimer;
function showToast(title, message, action = null, role = 'status') {
    document.querySelector('.toast')?.remove();
    clearTimeout(toastTimer);
    const toast = el('div', 'toast');
    toast.setAttribute('role', role);   // screen readers announce it without moving focus
    const close = el('button', 'toast__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => toast.remove());
    toast.append(el('strong', 'toast__title', title), el('p', 'toast__text', message));
    if (action) {
        const link = el('a', 'btn-line toast__action', action.label);
        link.href = action.href;
        toast.append(link);
    }
    toast.append(close);
    document.body.append(toast);
    // A notice with a button stays longer: the user may want to read it and act.
    toastTimer = setTimeout(() => toast.remove(), action ? 12000 : 8000);
}

function setBusy(value) {
    busy = value;
    sendButton.disabled = value;
    promptBox.setAttribute('aria-disabled', String(value));
}

// Which sheet the questions belong to. The server remembers the last question per
// sheet, so "and on level 3?" builds on it. New sheet (and picking another model)
// starts a new id: then the next question starts afresh.
const newConversationId = () => (crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9-]/g, '');
let conversationId = newConversationId();

async function ask(prompt) {
    setBusy(true);
    const { entry, body } = addEntry(prompt);
    try {
        const response = await fetch(`/${routeselect}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, urn: currentUrn(), conversationId })   // the model in the dropdown, this sheet
        });
        if (response.status === 401) return signInAgain('member');

        let data;
        try {
            data = await response.json();
        } catch {
            throw new Error(response.ok
                ? 'The server sent an answer the page could not read.'
                : `The server returned an error (${response.status}).`);
        }
        if (data?.limitReached) {
            showToast('Daily limit reached', 'Sign in to keep asking, or come back tomorrow: the free tokens start again every day.');
            return renderLimit(entry, body, data.message);
        }
        if (!response.ok) {
            throw new Error(typeof data?.message === 'string' ? data.message : `The server returned an error (${response.status}).`);
        }

        updateTokens(data);
        warnAboutBudget(data.budget);
        // If the status check failed earlier (e.g. the model was still processing),
        // a working answer means the model is ready now: refresh the chip.
        if (data.cache && indexStatus.state !== 'ready') loadIndexStatus(currentUrn());
        if (data.message && typeof data.message === 'object') {
            await renderElements(entry, body, data);
        } else {
            renderText(entry, body, data.message ?? '');
        }
        // "and on level 3?": say that the answer builds on the previous question.
        if (data.followUp) {
            const note = el('p', 'entry__method');
            note.append(el('span', 'caps', 'Follow-up'), el('span', null, 'Built on your previous question. Press New sheet to start afresh.'));
            body.prepend(note);
        }
        if (data.questionId) addFeedback(body, data.questionId);
    } catch (err) {
        console.error('Query failed:', err);
        renderError(entry, body, err.message || 'Check your connection and try again.', () => {
            entryCount -= 1;
            updateCounts();
            send(prompt);
        });
    } finally {
        setBusy(false);
        if (entry.isConnected) log.scrollTop = Math.max(0, entry.offsetTop - 12);
    }
}

function send(prompt) {
    const text = prompt.trim();
    if (!text || busy) return;
    ask(text);
}

composer.addEventListener('submit', event => {
    event.preventDefault();
    const text = promptBox.value;
    if (!text.trim() || busy) return;
    promptBox.value = '';
    send(text);
});

promptBox.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        composer.requestSubmit();
    }
});

log.addEventListener('click', event => {
    const example = event.target.closest('.example');
    if (example) send(example.textContent);
});

// ---------------------------------------------------------------------------
// New sheet: clear the schedule and the selection, start again at A-01
// ---------------------------------------------------------------------------
document.getElementById('newSheet').addEventListener('click', () => {
    if (busy) return;   // let a running question finish first
    startNewSheet();
    promptBox.focus();
});

// Also used when a different model is picked (see onModelSelected).
function startNewSheet() {
    conversationId = newConversationId();   // follow-up questions don't reach across sheets
    log.replaceChildren(notesTemplate.cloneNode(true));
    entryCount = 0;
    updateCounts();
    document.getElementById('tbRev').textContent = DASH;
    document.getElementById('promptToken').textContent = '0';
    document.getElementById('compToken').textContent = '0';
    currentViewer?.showAll();   // undo any "Isolate"
    clearHighlight(null);
    setDrawingTag(null);
}

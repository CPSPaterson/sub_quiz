import { normalize, shuffle, formatTime } from './names.js';

const $ = id => document.getElementById(id);

function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

// ---------- Map + basemaps ----------
const map = L.map('map', { preferCanvas: true, zoomSnap: 0.25, zoomControl: false, maxZoom: 19, keyboard: false });
L.control.zoom({ position: 'topright' }).addTo(map);
const renderer = L.canvas({ padding: 0.5, tolerance: 2 });

// Satellite imagery has no place names, so it doesn't give answers away.
const satellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
  });
// Street map: OpenFreeMap vector tiles (free, no API key) with every text/icon layer removed.
let street = null;
async function getStreetLayer() {
  if (!street) {
    const res = await fetch('https://tiles.openfreemap.org/styles/liberty');
    const style = await res.json();
    style.layers = style.layers.filter(l => l.type !== 'symbol');
    street = L.maplibreGL({
      style,
      attribution: '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; OpenMapTiles &copy; OpenStreetMap contributors',
    });
  }
  return street;
}
const BASEMAPS = ['street', 'satellite', 'none'];
let basemap = BASEMAPS.includes(load('basemap')) ? load('basemap') : 'street';

// "Fit to region" button under the zoom buttons
const FitControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    const a = L.DomUtil.create('a', 'fit-btn', div);
    a.href = '#';
    a.title = 'Zoom to region';
    a.innerHTML = '&#x2922;';
    L.DomEvent.on(a, 'click', e => { L.DomEvent.preventDefault(e); fitRegion(); });
    L.DomEvent.disableClickPropagation(div);
    return div;
  },
});
new FitControl().addTo(map);

// ---------- Styling ----------
const FILL = { found: '#22c55e', partial: '#f59e0b', missed: '#ef4444', hint: '#ef4444', wrong: '#f87171' };
const THEMES = {
  satellite: {
    base: { color: '#ffffff', weight: 1, opacity: 0.85, fillColor: '#ffffff', fillOpacity: 0.04 },
    inactive: { color: '#ffffff', weight: 0.5, opacity: 0.25, fillColor: '#000000', fillOpacity: 0.45 },
    answeredOpacity: 0.55,
    hover: '#facc15',
    hint: '#ffffff',
  },
  street: {
    base: { color: '#334155', weight: 0.9, opacity: 0.9, fillColor: '#64748b', fillOpacity: 0.06 },
    inactive: { color: '#94a3b8', weight: 0.5, opacity: 0.5, fillColor: '#ffffff', fillOpacity: 0.6 },
    answeredOpacity: 0.55,
    hover: '#0f172a',
    hint: '#7f1d1d',
  },
  none: {
    base: { color: '#475569', weight: 0.7, opacity: 1, fillColor: '#cbd5e1', fillOpacity: 0.35 },
    inactive: { color: '#94a3b8', weight: 0.5, opacity: 0.5, fillColor: '#e2e8f0', fillOpacity: 0.15 },
    answeredOpacity: 0.7,
    hover: '#0f172a',
    hint: '#7f1d1d',
  },
};

// ---------- State ----------
let suburbs = [];          // [{ id, name, region, layer }]
const byKey = new Map();   // normalized name -> [id]
const status = [];         // id -> null | found | partial | missed | hint
const active = [];         // id -> in the selected region?
let activeIds = [];
const flashing = new Set();
let hovered = null;
let mode = null;
let region = '';

function styleFor(id) {
  const t = THEMES[basemap];
  if (!active[id]) return t.inactive;
  const s = flashing.has(id) ? 'wrong' : status[id];
  const style = { ...t.base };
  if (s) {
    style.fillColor = FILL[s];
    style.fillOpacity = t.answeredOpacity;
  }
  if (s === 'hint') {
    style.color = t.hint;
    style.weight = 3;
    style.opacity = 1;
  }
  if (hovered === id) {
    style.color = t.hover;
    style.weight = Math.max(style.weight, 2.5);
    style.opacity = 1;
  }
  return style;
}

function refresh(id) {
  suburbs[id].layer.setStyle(styleFor(id));
}

function setStatus(id, s) {
  status[id] = s;
  const layer = suburbs[id].layer;
  // Names only appear on hover once a suburb has been answered or revealed.
  if (s && s !== 'hint') {
    if (!layer.getTooltip()) layer.bindTooltip(suburbs[id].name, { sticky: true, className: 'suburb-tip' });
  } else {
    layer.unbindTooltip();
  }
  refresh(id);
}

function resetMap() {
  suburbs.forEach(s => setStatus(s.id, null));
}

function flash(id) {
  flashing.add(id);
  refresh(id);
  setTimeout(() => { flashing.delete(id); refresh(id); }, 700);
}

function zoomTo(id, maxZoom = 14) {
  map.flyToBounds(suburbs[id].layer.getBounds(), { maxZoom, padding: [80, 80], duration: 0.6 });
}

function regionBounds() {
  const b = L.latLngBounds([]);
  activeIds.forEach(id => b.extend(suburbs[id].layer.getBounds()));
  return b;
}

function fitRegion() {
  map.flyToBounds(regionBounds(), { padding: [20, 20], duration: 0.6 });
}

async function setBasemap(name) {
  basemap = name;
  save('basemap', name);
  $('basemapSelect').value = name;
  suburbs.forEach(s => refresh(s.id));
  if (name === 'satellite') satellite.addTo(map); else satellite.remove();
  try {
    const layer = await getStreetLayer();
    if (basemap === 'street') layer.addTo(map); else layer.remove();
  } catch (err) {
    console.error('Street map failed to load', err);
  }
}

function setRegion(name) {
  region = name;
  save('region', name);
  $('regionSelect').value = name;
  activeIds = [];
  suburbs.forEach(s => {
    active[s.id] = !name || s.region === name;
    s.layer.options.interactive = active[s.id];
    if (active[s.id]) activeIds.push(s.id);
  });
  if (mode) setMode(mode); // restart the current game for the new region
  fitRegion();
}

function makeTimer(el) {
  let start = null, handle = null;
  return {
    start() {
      if (handle) return;
      start = Date.now();
      handle = setInterval(() => { el.textContent = formatTime(Date.now() - start); }, 250);
    },
    stop() { clearInterval(handle); handle = null; return start ? Date.now() - start : 0; },
    reset() { this.stop(); start = null; el.textContent = '0:00'; },
  };
}

function setFeedback(el, text, kind = '') {
  el.textContent = text || ' ';
  el.className = `feedback ${kind}`;
}

const regionLabel = () => region || 'Sydney';

// ---------- Mode 1: name them all ----------
const typeTimer = makeTimer($('typeTimer'));
let typeFound = 0;
let typeOver = false;
let pendingTimer = null;

function typeReset() {
  clearTimeout(pendingTimer);
  resetMap();
  typeFound = 0;
  typeOver = false;
  typeTimer.reset();
  $('guess').disabled = false;
  $('guess').value = '';
  $('recent').innerHTML = '';
  $('giveUpBtn').disabled = false;
  setFeedback($('typeFeedback'), '');
  typeUpdateStats();
  $('guess').focus();
}

function typeUpdateStats() {
  $('typeCount').textContent = typeFound;
  $('typeTotal').textContent = activeIds.length;
  $('typeBar').style.width = `${(100 * typeFound) / activeIds.length}%`;
}

function addRecent(id) {
  const li = document.createElement('li');
  li.textContent = suburbs[id].name;
  li.addEventListener('click', () => zoomTo(id));
  $('recent').prepend(li);
  while ($('recent').children.length > 8) $('recent').lastChild.remove();
}

function typeAccept(ids) {
  clearTimeout(pendingTimer);
  typeTimer.start();
  ids.forEach(id => { setStatus(id, 'found'); addRecent(id); });
  typeFound += ids.length;
  setFeedback($('typeFeedback'), `✓ ${suburbs[ids[0]].name}`, 'good');
  $('guess').value = '';
  typeUpdateStats();
  if (typeFound === activeIds.length) typeFinish(true);
}

// Is there a not-yet-found suburb whose name starts with this one? ("Bondi" -> "Bondi Beach")
function hasLongerUnfound(key) {
  return activeIds.some(id => {
    if (status[id]) return false;
    const k = normalize(suburbs[id].name);
    return k.length > key.length && k.startsWith(key);
  });
}

// Returns true if the text was a recognised suburb.
function typeCheck(pressedEnter) {
  clearTimeout(pendingTimer);
  const key = normalize($('guess').value);
  if (!key) return true;
  const all = byKey.get(key) || [];
  const ids = all.filter(id => active[id]);
  const fresh = ids.filter(id => !status[id]);

  if (fresh.length) {
    if (!pressedEnter && hasLongerUnfound(key)) {
      // Wait a moment in case they're typing a longer name, e.g. "Bondi Beach".
      setFeedback($('typeFeedback'), `${suburbs[fresh[0]].name}? Keep typing or press Enter`);
      pendingTimer = setTimeout(() => typeAccept(fresh), 1200);
    } else {
      typeAccept(fresh);
    }
    return true;
  }
  if (ids.length) {
    // Already found: leave the text alone so a longer name can still be typed.
    if (pressedEnter) {
      setFeedback($('typeFeedback'), `Already found ${suburbs[ids[0]].name}`);
      $('guess').value = '';
    }
    return true;
  }
  if (all.length && pressedEnter) {
    setFeedback($('typeFeedback'), `${suburbs[all[0]].name} isn't in ${regionLabel()}`, 'bad');
    $('guess').value = '';
    return true;
  }
  return false;
}

function typeFinish(won) {
  typeOver = true;
  clearTimeout(pendingTimer);
  const time = formatTime(typeTimer.stop());
  $('guess').disabled = true;
  $('giveUpBtn').disabled = true;
  if (won) {
    setFeedback($('typeFeedback'), `All ${activeIds.length} found in ${time}!`, 'good');
  } else {
    activeIds.forEach(id => { if (!status[id]) setStatus(id, 'missed'); });
    setFeedback($('typeFeedback'), `You found ${typeFound} of ${activeIds.length}. Missed ones are red — hover to see names.`, 'bad');
  }
}

$('guess').addEventListener('input', () => typeCheck(false));
$('guess').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !$('guess').value.trim()) return;
  if (!typeCheck(true)) {
    setFeedback($('typeFeedback'), `"${$('guess').value.trim()}" isn't on the map`, 'bad');
    $('guess').classList.remove('shake');
    void $('guess').offsetWidth; // restart the animation
    $('guess').classList.add('shake');
  }
});
// Keep the text box ready after panning or clicking the map (mouse only, so phones
// don't pop the keyboard up after every pan), and send stray keystrokes to it.
function refocusGuess() {
  if (mode === 'type' && !$('guess').disabled) $('guess').focus({ preventScroll: true });
}
map.getContainer().addEventListener('pointerup', e => { if (e.pointerType === 'mouse') refocusGuess(); });
document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) refocusGuess();
});

$('giveUpBtn').addEventListener('click', () => { if (!typeOver) typeFinish(false); });
$('typeRestartBtn').addEventListener('click', typeReset);

// ---------- Mode 2: find on map ----------
const clickTimer = makeTimer($('clickTimer'));
let queue = [];
let qi = 0;
let misses = 0;
let tally = { found: 0, partial: 0, missed: 0 };
let clickRunning = false;

function clickShowSetup() {
  resetMap();
  clickRunning = false;
  clickTimer.reset();
  $('clickSetup').hidden = false;
  $('clickGame').hidden = true;
  $('clickDone').hidden = true;
}

function clickStart() {
  resetMap();
  const n = $('questionCount').value;
  queue = shuffle(activeIds);
  if (n !== 'all') queue = queue.slice(0, Number(n));
  qi = 0;
  tally = { found: 0, partial: 0, missed: 0 };
  clickRunning = true;
  $('clickSetup').hidden = true;
  $('clickDone').hidden = true;
  $('clickGame').hidden = false;
  $('qTotal').textContent = queue.length;
  setFeedback($('clickFeedback'), '');
  clickTimer.reset();
  clickTimer.start();
  clickAsk();
}

function clickAsk() {
  misses = 0;
  $('target').textContent = suburbs[queue[qi]].name;
  $('qNum').textContent = qi + 1;
  $('clickBar').style.width = `${(100 * qi) / queue.length}%`;
}

function clickAnswer(result) {
  setStatus(queue[qi], result);
  tally[result]++;
  qi++;
  if (qi >= queue.length) clickFinish();
  else clickAsk();
}

function onSuburbClick(id) {
  if (mode !== 'click' || !clickRunning || !active[id]) return;
  const target = queue[qi];
  if (id === target) {
    const result = misses === 0 ? 'found' : misses < 3 ? 'partial' : 'missed';
    setFeedback($('clickFeedback'), result === 'found' ? `✓ ${suburbs[id].name}` : suburbs[id].name, result === 'found' ? 'good' : '');
    clickAnswer(result);
    return;
  }
  if (status[id] && status[id] !== 'hint') {
    setFeedback($('clickFeedback'), `That's ${suburbs[id].name} (already answered)`);
    return;
  }
  misses++;
  flash(id);
  if (misses >= 3) {
    setStatus(target, 'hint');
    zoomTo(target, 14);
    setFeedback($('clickFeedback'), `That's ${suburbs[id].name}. ${suburbs[target].name} is outlined — click it.`, 'bad');
  } else {
    setFeedback($('clickFeedback'), `That's ${suburbs[id].name}. ${3 - misses} ${3 - misses === 1 ? 'try' : 'tries'} left.`, 'bad');
  }
}

function clickSkip() {
  if (!clickRunning) return;
  const target = queue[qi];
  setFeedback($('clickFeedback'), `${suburbs[target].name} is shown in red`, 'bad');
  zoomTo(target, 14);
  clickAnswer('missed');
}

function clickFinish() {
  clickRunning = false;
  const time = formatTime(clickTimer.stop());
  const n = queue.length;
  const pct = Math.round((100 * (tally.found + 0.5 * tally.partial)) / n);
  $('clickBar').style.width = '100%';
  $('clickGame').hidden = true;
  $('clickDone').hidden = false;
  $('summary').innerHTML =
    `<strong>${pct}%</strong> in ${time}<br>` +
    `${tally.found} first try · ${tally.partial} with 2–3 tries · ${tally.missed} missed<br>` +
    `<small>Hover over coloured suburbs to see their names.</small>`;
}

$('clickStartBtn').addEventListener('click', clickStart);
$('clickAgainBtn').addEventListener('click', clickShowSetup);
$('clickRestartBtn').addEventListener('click', clickShowSetup);
$('skipBtn').addEventListener('click', clickSkip);

// ---------- Mode switching ----------
function setMode(m) {
  mode = m;
  document.querySelectorAll('.mode').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  $('typePanel').hidden = m !== 'type';
  $('clickPanel').hidden = m !== 'click';
  typeTimer.stop();
  clickTimer.stop();
  if (m === 'type') typeReset();
  else clickShowSetup();
}
document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('regionSelect').addEventListener('change', e => setRegion(e.target.value));
$('basemapSelect').addEventListener('change', e => setBasemap(e.target.value));

// ---------- Load data ----------
async function init() {
  try {
    const res = await fetch('./src/data/suburbs.geojson');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const geo = await res.json();

    for (const r of geo.regions || []) {
      $('regionSelect').add(new Option(r, r));
    }

    const all = L.geoJSON(geo, {
      renderer,
      style: () => THEMES.none.base,
      onEachFeature: (feature, layer) => {
        const id = suburbs.length;
        suburbs.push({ id, name: feature.properties.name, region: feature.properties.region, layer });
        status.push(null);
        active.push(true);
        const key = normalize(feature.properties.name);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(id);

        layer.on('click', () => onSuburbClick(id));
        layer.on('mouseover', () => { if (!active[id]) return; hovered = id; refresh(id); });
        layer.on('mouseout', () => { if (hovered === id) hovered = null; refresh(id); });
      },
    }).addTo(map);

    const bounds = all.getBounds();
    map.fitBounds(bounds, { padding: [10, 10] });
    map.setMaxBounds(bounds.pad(0.5));
    map.setMinZoom(map.getZoom() - 1);

    setBasemap(basemap);
    const saved = load('region', '');
    setRegion((geo.regions || []).includes(saved) ? saved : '');
    $('loading').hidden = true;
    setMode('type');
  } catch (err) {
    console.error(err);
    $('loading').textContent = location.protocol === 'file:'
      ? 'Open this through a local web server (see README) — browsers block loading data from file://'
      : `Could not load suburb data (${err.message})`;
  }
}

init();

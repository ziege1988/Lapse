// Lapse – Steuerung der Oberfläche.

import { Project, newManual, DEFAULT_SETTINGS } from './project.js';
import { Aligner, importFiles, sortFrames, alignAll, refineFrame, StatsEngine, anchorUniqueness, trackAllAnchors, refineAnchored, snapFrameAnchors } from './pipeline.js';
import { Player } from './player.js';
import { FORMATS, findConfig, mediaRecorderType, outputSize, sourceDetail, runExport, exportPlan, qualityName } from './export.js';
import { inv, mul, apply, I3 } from './geometry.js';
import { BUILD, BUILD_DATE, isDev } from './version.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const num = (v, d = 0) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });

const project = new Project();
const store = {
  get(k, d) { try { const v = localStorage.getItem('lapse.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lapse.' + k, JSON.stringify(v)); } catch { /* privat/blockiert */ } },
};
Object.assign(project.settings, store.get('settings', {}));
if (project.settings.refMode === 'manual') project.settings.refMode = 'middle';
// Ab Version 2: "Freihand" ist Standard (robuster bei Handaufnahmen)
if (store.get('settingsVersion', 1) < 2) { if (project.settings.model === 'similarity') project.settings.model = 'homography'; store.set('settingsVersion', 2); }

const ui = {
  view: 'photos', tab: 'video', selected: null, compare: 'off',
  exp: Object.assign({ format: 'mp4-avc', shortEdge: 1080, gifLong: 480, sizeMode: 'quality', q: 65, targetMB: 16 }, store.get('export', {})),
  result: null,
};

if (ui.exp.quality) { ui.exp.q = { standard: 42, high: 65, max: 86 }[ui.exp.quality] ?? 65; delete ui.exp.quality; }

let aligner = null, stats = null, player = null;
const getAligner = () => (aligner ||= new Aligner());

// ---------------------------------------------------------------- Hilfen

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

const progress = {
  cancelled: false,
  open(title, { cancellable = true } = {}) {
    this.cancelled = false;
    $('#progress-title').textContent = title;
    $('#progress-text').textContent = '';
    $('#progress-bar').style.width = '0%';
    $('#progress-cancel').hidden = !cancellable;
    $('#progress').hidden = false;
  },
  set(frac, text) {
    if (frac != null) $('#progress-bar').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    if (text != null) $('#progress-text').textContent = text;
  },
  close() { $('#progress').hidden = true; },
};
$('#progress-cancel').onclick = () => { progress.cancelled = true; progress.set(null, 'Wird abgebrochen …'); };

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* nicht verfügbar */ }
}

function fmtClock(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1).replace('.', ',')}`;
}

// ---------------------------------------------------------------- Ansichten

function showView(v) {
  if (anc.on && v !== 'edit') closeAnchors({ refreshAfter: false });
  ui.view = v;
  for (const s of ['photos', 'edit', 'export']) $('#view-' + s).hidden = s !== v;
  $$('.step').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (v !== 'edit') player?.pause();
  if (v === 'edit') { layoutStage(); renderStrip(); updateFramePanel(); player.invalidate(); }
  if (v === 'export') refreshExport();
  updatePrimary();
  window.scrollTo({ top: 0 });
}

function updateSteps() {
  const ok = project.aligned && project.included.length >= 2;
  $$('.step').forEach(b => { if (b.dataset.view !== 'photos') b.disabled = !ok; });
}

function updatePrimary() {
  const b = $('#primary'), n = project.frames.length;
  b.disabled = false;
  if (ui.view === 'photos') {
    if (!n) b.textContent = 'Fotos auswählen';
    else if (n < 2) { b.textContent = 'Mindestens 2 Fotos nötig'; b.disabled = true; }
    else if (!project.aligned) b.textContent = `Ausrichten & weiter (${n} Fotos)`;
    else b.textContent = 'Weiter zur Bearbeitung';
  } else if (ui.view === 'edit') b.textContent = 'Weiter zum Export';
  else b.textContent = ui.exp.format === 'zip' ? 'Einzelbilder exportieren' : ui.exp.format === 'gif' ? 'GIF erstellen' : 'Video erstellen';
}

$$('.step').forEach(b => b.onclick = () => !b.disabled && showView(b.dataset.view));

$('#primary').onclick = () => {
  if (ui.view === 'photos') {
    if (!project.frames.length) $('#file').click();
    else if (!project.aligned) runAlign();
    else showView('edit');
  } else if (ui.view === 'edit') showView('export');
  else doExport();
};

// ---------------------------------------------------------------- Fotos

$('#file').onchange = async e => {
  const files = [...e.target.files].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp|tiff?)$/i.test(f.name));
  e.target.value = '';
  if (files.length) await addFiles(files);
};

async function addFiles(files) {
  $('#empty').hidden = true;
  $('#photos-main').hidden = false;
  progress.open(`${files.length} Fotos werden geladen`);
  let lastGrid = 0;
  const errors = await importFiles(files, project, getAligner(), {
    isCancelled: () => progress.cancelled,
    onProgress: (d, t) => progress.set(d / t, `Foto ${d} von ${t} wird analysiert …`),
    onFrame: () => {
      const now = performance.now();
      if (now - lastGrid > 400) { lastGrid = now; renderGrid(); }
    },
  });
  progress.close();
  applySort();
  project.aligned = false;
  renderGrid();
  updateSteps();
  updatePrimary();
  if (errors.length) toast(`${errors.length} Datei(en) konnten nicht gelesen werden.`, 4500);
  else if (project.frames.length >= 2) toast('Fotos bereit – jetzt ausrichten.');
}

function renderGrid() {
  const n = project.frames.length;
  $('#empty').hidden = n > 0;
  $('#photos-main').hidden = n === 0;
  $('#photo-count').textContent = n;
  const busy = project.frames.filter(f => f.analyzing).length;
  $('#analyze-state').textContent = busy ? `· ${busy} in Analyse` : '';
  $('#grid').innerHTML = project.frames.map((f, i) => `
    <div class="tile${f.analyzing ? ' busy' : ''}" data-id="${f.id}">
      <img src="${f.thumbUrl}" alt="" loading="lazy" decoding="async">
      <span class="num">${i + 1}</span>
      <button class="rm" data-rm="${f.id}" aria-label="Foto entfernen">×</button>
    </div>`).join('');
  updatePrimary();
}

$('#grid').onclick = e => {
  const id = e.target.closest('[data-rm]')?.dataset.rm;
  if (id) removeFrames([id]);
};

function removeFrames(ids) {
  for (const id of ids) {
    const i = project.frames.findIndex(f => f.id === id);
    if (i < 0) continue;
    const f = project.frames[i];
    URL.revokeObjectURL(f.thumbUrl);
    aligner?.call({ type: 'drop', id });
    player?.forget(id);
    stats?.forget(id);
    project.frames.splice(i, 1);
    if (project.refId === id) project.refId = null;
    if (ui.selected === f) ui.selected = null;
  }
  project.aligned = false;
  renderGrid();
  updateSteps();
}

$('#clear-all').onclick = () => {
  if (confirm('Alle Fotos aus Lapse entfernen? (Deine Originale bleiben unberührt.)')) removeFrames(project.frames.map(f => f.id));
};

function applySort() {
  const want = $('#sort').value, used = sortFrames(project, want);
  if (want !== used && !applySort.warned) {
    applySort.warned = true;
    toast('Nicht alle Fotos enthalten eine Aufnahmezeit – es wird nach Dateiname sortiert.', 5000);
  }
}

$('#sort').onchange = () => {
  applySort.warned = false;
  applySort();
  project.aligned = false;
  renderGrid();
  updateSteps();
};

// ---------------------------------------------------------------- Ausrichten

async function runAlign() {
  const failed = project.frames.filter(f => !f.featRes);
  for (const f of failed) f.excluded = true;
  if (project.included.length < 2) { toast('Zu wenige auswertbare Fotos.'); return; }
  progress.open('Fotos werden ausgerichtet');
  await keepAwake(true);
  try {
    const auto = await alignAll(project, getAligner(), {
      isCancelled: () => progress.cancelled,
      onProgress: (d, t) => progress.set(d / t * 0.7, `Ausrichten: Foto ${d} von ${t}`),
    });
    if (!auto) { progress.close(); toast('Abgebrochen.'); return; }
    progress.set(0.7, 'Zuschnitt und Farbangleich werden berechnet …');
    await refresh({ onProgress: (d, t) => progress.set(0.7 + 0.3 * d / t, `Helligkeit & Farbe messen: ${d} von ${t}`) });
    progress.close();
    updateSteps();
    if (!player) initPlayer();
    showView('edit');
    const flagged = project.included.filter(f => f.quality !== 'good').length;
    const skipped = auto.length + failed.length;
    const parts = [skipped ? `${skipped} Foto(s) ließen sich nicht ausrichten und wurden ausgeschlossen (grau markiert).` : '',
      flagged ? `${flagged} Foto(s) bitte prüfen.` : ''].filter(Boolean);
    toast(parts.length ? 'Fertig. ' + parts.join(' ') : 'Fertig – alle Fotos sauber ausgerichtet.', parts.length ? 6000 : 3500);
  } catch (err) {
    progress.close();
    console.error(err);
    toast('Fehler beim Ausrichten: ' + err.message, 6000);
  } finally {
    keepAwake(false);
  }
}

// Neuberechnung nach Änderungen (Zuschnitt -> Messung -> Farbangleich -> Qualität)
let refreshGen = 0, refreshTimer = 0;
async function refresh({ onProgress } = {}) {
  const gen = ++refreshGen;
  stats ||= new StatsEngine();
  project.computeCrop();
  if (ui.view === 'edit') layoutStage();
  await stats.measure(project, { onProgress, isCancelled: () => gen !== refreshGen });
  if (gen !== refreshGen) return false;
  project.computeColor();
  project.assessQuality();
  $('#recalc').hidden = true;
  player?.invalidate();
  if (ui.view === 'edit') { renderStrip(); updateFramePanel(); updateCropHelp(); }
  renderNotice();
  return true;
}
function scheduleRefresh(delay = 450) {
  clearTimeout(refreshTimer);
  $('#recalc').hidden = false;
  refreshTimer = setTimeout(() => refresh().catch(err => { console.error(err); $('#recalc').hidden = true; }), delay);
}

// ---------------------------------------------------------------- Bearbeiten

function initPlayer() {
  player = new Player($('#preview'), project);
  player.onTime = (t, dur, frame) => {
    if (!scrubbing) $('#scrub').value = dur ? Math.round(t / dur * 1000) : 0;
    $('#time').textContent = `${fmtClock(t)} / ${fmtClock(dur)}`;
    markCurrent(frame);
  };
  player.onPlayState = on => $('#play').classList.toggle('playing', on);
  window.addEventListener('resize', () => ui.view === 'edit' && layoutStage());
}

function layoutStage() {
  if (!player || !project.crop) return;
  // Ankerpunkt-Modus: ganzes Foto, größer dargestellt
  const aspect = anc.on ? anc.frame.w / anc.frame.h : project.crop.w / project.crop.h;
  const avail = $('.stage-wrap').clientWidth || window.innerWidth - 32;
  // Vorschau bleibt angeheftet -> Höhe begrenzen, damit genug Platz für die Regler bleibt
  const maxH = Math.min(window.innerHeight * (anc.on ? 0.5 : 0.36), anc.on ? 900 : 560);
  let w = Math.min(avail, maxH * aspect), h = w / aspect;
  $('#stage').style.width = w + 'px';
  $('#stage').style.height = h + 'px';
  player.setSize(w, h);
}

let scrubbing = false;
$('#play').onclick = () => {
  if (player.playing) player.pause();
  else { setCompare('off', false); player.play(); }
};
$('#scrub').addEventListener('input', () => {
  scrubbing = true;
  player.pause();
  player.seek($('#scrub').value / 1000 * player.timeline().duration);
});
$('#scrub').addEventListener('change', () => { scrubbing = false; });

let lastCurrent = null;
function markCurrent(frame) {
  if (!frame || frame === lastCurrent) return;
  lastCurrent = frame;
  const strip = $('#strip');
  strip.querySelector('.sf.cur')?.classList.remove('cur');
  const el = strip.querySelector(`[data-id="${frame.id}"]`);
  if (el) {
    el.classList.add('cur');
    if (player?.playing || scrubbing) strip.scrollLeft = el.offsetLeft - strip.clientWidth / 2 + el.offsetWidth / 2;
  }
}

function renderStrip() {
  const frames = project.frames.filter(f => f.featRes > 0);
  $('#strip').innerHTML = frames.map(f => {
    const badges = [];
    if (f.id === project.refId) badges.push('<span class="b ref" title="Referenz">★</span>');
    if (f.excluded) badges.push('<span class="b ex" title="Ausgeschlossen">–</span>');
    else if (f.quality === 'bad') badges.push('<span class="b bad" title="Ausrichtung fehlgeschlagen">!</span>');
    else if (f.quality === 'warn') badges.push('<span class="b warn" title="Bitte prüfen">?</span>');
    return `<button class="sf${f.excluded ? ' ex' : ''}${ui.selected === f ? ' sel' : ''}" data-id="${f.id}" role="option">
      <img src="${f.thumbUrl}" alt="" loading="lazy" decoding="async">${badges.join('')}</button>`;
  }).join('');
  lastCurrent = null;
  const inc = project.included;
  const flagged = inc.filter(f => f.quality === 'warn' || f.quality === 'bad');
  $('#strip-info').textContent = `${inc.length} von ${frames.length} Fotos im Video`;
  const fx = $('#fix-flagged');
  fx.hidden = !flagged.length;
  fx.textContent = `${flagged.length} auffällige präzise nachrechnen`;
  updateDuration();
}

$('#strip').onclick = e => {
  const id = e.target.closest('.sf')?.dataset.id;
  const f = id && project.byId(id);
  if (f && anc.on) showAnchorFrame(f);
  else if (f) selectFrame(f);
};

function selectFrame(f, { switchTab = true } = {}) {
  ui.selected = f;
  $$('#strip .sf.sel').forEach(el => el.classList.remove('sel'));
  $(`#strip [data-id="${f.id}"]`)?.classList.add('sel');
  player.showFrame(f, ui.compare);
  if (switchTab) setTab('frame');
  updateFramePanel();
  const el = $(`#strip [data-id="${f.id}"]`), strip = $('#strip');
  if (el) strip.scrollLeft = el.offsetLeft - strip.clientWidth / 2 + el.offsetWidth / 2;
}

function setTab(t) {
  ui.tab = t;
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  for (const p of ['video', 'look', 'frame']) $('#panel-' + p).hidden = p !== t;
}
$$('.tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));

function setCompare(v, apply = true) {
  ui.compare = v;
  $$('#compare button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  if (apply && ui.selected) player.showFrame(ui.selected, v);
}
$$('#compare button').forEach(b => b.onclick = () => setCompare(b.dataset.v));

// Einzelbild-Regler (− Regler +)
const GEOM = new Set(['dx', 'dy', 'rot', 'scale']);
$$('.nudge').forEach(el => {
  const { man, step, min, max, label, unit } = el.dataset;
  el.innerHTML = `<span class="nl">${label}</span><span class="nv"></span>
    <div class="nr"><button data-d="-1" aria-label="${label} verringern">−</button>
    <input type="range" min="${min}" max="${max}" step="${step}" aria-label="${label}">
    <button data-d="1" aria-label="${label} erhöhen">+</button></div>`;
  const input = el.querySelector('input');
  const set = v => {
    const f = ui.selected;
    if (!f) return;
    v = Math.max(+min, Math.min(+max, Math.round(v / +step) * +step));
    f.manual[man] = +v.toFixed(4);
    input.value = v;
    el.querySelector('.nv').textContent = fmtManual(man, v, unit);
    if (GEOM.has(man)) { f.manualChecked = true; scheduleRefresh(); }
    player.showFrame(f, ui.compare);
  };
  input.addEventListener('input', () => set(+input.value));
  el.querySelectorAll('button').forEach(b => {
    let timer = 0;
    const fire = () => set((ui.selected?.manual[man] ?? 0) + +b.dataset.d * +step);
    b.addEventListener('pointerdown', () => { fire(); timer = setTimeout(function rep() { fire(); timer = setTimeout(rep, 60); }, 400); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(timer));
  });
});

function fmtManual(key, v, unit) {
  if (key === 'scale') return `${num(v, 3)} ${unit}`;
  if (key === 'temp' || key === 'tint') return `${v > 0 ? '+' : ''}${Math.round(v)}`;
  return `${v > 0 ? '+' : ''}${num(v, 2)} ${unit}`;
}

function updateFramePanel() {
  const f = ui.selected;
  $('#frame-none').hidden = !!f;
  $('#frame-ui').hidden = !f;
  if (!f) return;
  const all = project.frames.filter(x => x.featRes > 0), idx = all.indexOf(f);
  $('#frame-thumb').src = f.thumbUrl;
  $('#frame-title').textContent = f.name;
  const when = f.date ? new Date(f.date).toLocaleString('de-DE', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'medium' }) : 'ohne Aufnahmezeit';
  $('#frame-meta').textContent = `Foto ${idx + 1} von ${all.length} · ${when} · ${f.w}×${f.h}`;
  const q = $('#frame-quality');
  const a = f.align;
  if (f.id === project.refId) { q.className = 'quality good'; q.textContent = '★ Referenzbild – alle anderen werden hierauf ausgerichtet'; }
  else if (f.excluded) {
    q.className = 'quality' + (f.autoExcluded ? ' bad' : '');
    q.textContent = f.autoExcluded ? 'Automatisch ausgeschlossen: keine sichere Ausrichtung gefunden. Tipp: „Mit Ankerpunkten ausrichten“.' : 'Ausgeschlossen – erscheint nicht im Video';
  }
  else {
    const pct = v => `${Math.round(v * 100)} %`;
    let detail = '';
    if (a?.ok) {
      if (a.method === 'anker') detail = ` (Ankerpunkte: ${a.used} von ${project.anchors.length}, Sicherheit ${pct(a.anchorScore)}${a.refined ? ', flächig verfeinert' : ''})`;
      else if (a.anchorsRejected) detail = ` (Übereinstimmung ${pct(a.ncc ?? 0)} · automatisch, Ankerpunkte widersprechen)`;
      else if (a.confirmedByAnchors) detail = ` (Übereinstimmung ${pct(a.ncc ?? 1)} · durch ${a.used} Ankerpunkte bestätigt)`;
      else if (a.ncc != null) detail = ` (Übereinstimmung ${pct(a.ncc)} · ${a.method === 'flächig' ? 'Flächenvergleich' : 'Merkmale'}${a.inliers ? `, ${a.inliers} Punkte` : ''})`;
      else detail = ` (${a.inliers} Punkte, Abweichung ${num(a.rms, 2)} px${a.via ? ', über Nachbarbild' : ''})`;
    }
    q.className = 'quality ' + (f.quality || 'good');
    q.textContent = f.quality === 'good' ? `✓ ${f.manualChecked ? 'Geprüft' : 'Gut ausgerichtet'}${detail}` : `⚠ ${f.qualityNote || 'Bitte prüfen'}${detail}`;
  }
  $$('.nudge').forEach(el => {
    const k = el.dataset.man, v = f.manual[k];
    el.querySelector('input').value = v;
    el.querySelector('.nv').textContent = fmtManual(k, v, el.dataset.unit);
  });
  $('#f-exclude').textContent = f.excluded ? 'Foto wieder aufnehmen' : 'Foto ausschließen';
  $('#f-ref').disabled = f.id === project.refId || f.excluded;
  $('#f-exclude').disabled = f.id === project.refId;
  $('#f-refine').disabled = f.id === project.refId;
  $('#f-prev').disabled = idx <= 0;
  $('#f-next').disabled = idx >= all.length - 1;
}

$('#f-prev').onclick = () => stepFrame(-1);
$('#f-next').onclick = () => stepFrame(1);
function stepFrame(d) {
  const all = project.frames.filter(x => x.featRes > 0), i = all.indexOf(ui.selected);
  const f = all[i + d];
  if (f) selectFrame(f, { switchTab: false });
}

$('#f-reset').onclick = () => {
  const f = ui.selected;
  if (!f) return;
  f.manual = newManual();
  f.manualChecked = false;
  updateFramePanel();
  scheduleRefresh(0);
};

$('#f-ok').onclick = () => {
  const f = ui.selected;
  if (!f) return;
  f.manualChecked = true;
  project.assessQuality();
  renderStrip();
  updateFramePanel();
  toast('Als geprüft markiert.');
};

$('#f-exclude').onclick = () => {
  const f = ui.selected;
  if (!f || f.id === project.refId) return;
  f.excluded = !f.excluded;
  if (project.included.length < 2) { f.excluded = false; toast('Mindestens 2 Fotos müssen im Video bleiben.'); return; }
  if (!f.excluded && f.autoExcluded) { f.autoExcluded = false; f.keepIncluded = true; toast('Wieder aufgenommen – bitte mit „Vergleich“ prüfen und ggf. per Position korrigieren.', 5000); }
  updateFramePanel();
  renderStrip();
  scheduleRefresh(0);
};

$('#f-ref').onclick = () => {
  const f = ui.selected;
  if (!f || f.excluded) return;
  // Ankerpunkte gelten für das alte Referenzbild -> verwerfen
  const hadAnchors = project.anchors.length > 0;
  project.resetAnchors(false);
  // Transformationen exakt auf das neue Referenzbild umrechnen (kein erneutes Matching nötig)
  const Tinv = inv(project.transform(f));
  if (!Tinv) return;
  const oldRef = project.ref;
  const fAlign = f.align;
  for (const g of project.frames) {
    if (!g.align) continue;
    const T = mul(Tinv, project.transform(g));
    g.align = { ...g.align, H: T };
    g.manual = { ...g.manual, dx: 0, dy: 0, rot: 0, scale: 1 };
  }
  if (oldRef && oldRef !== f) oldRef.align = { ...oldRef.align, ok: true, inliers: fAlign?.inliers ?? 0, rms: fAlign?.rms ?? 0 };
  f.align = { ...f.align, ok: true, H: I3(), inliers: Infinity, rms: 0, ncc: 1, method: 'ref', via: null };
  project.settings.refMode = 'manual';
  project.refId = f.id;
  scheduleRefresh(0);
  updateFramePanel();
  renderStrip();
  toast(hadAnchors ? 'Neues Referenzbild gesetzt. Ankerpunkte bitte neu setzen.' : 'Neues Referenzbild gesetzt.');
};

$('#f-refine').onclick = async () => {
  const f = ui.selected;
  if (!f) return;
  progress.open('Präzise Ausrichtung', { cancellable: false });
  progress.set(0.3, 'Original wird in hoher Auflösung analysiert …');
  try {
    const before = f.align ? { ...f.align } : null;
    await refineFrame(project, getAligner(), f);
    f.manual = { ...f.manual, dx: 0, dy: 0, rot: 0, scale: 1 };
    progress.set(0.8, 'Zuschnitt und Farbe werden aktualisiert …');
    await refresh();
    progress.close();
    const a = f.align;
    const sc = x => (x?.ok ? (x.ncc != null ? `${Math.round(x.ncc * 100)} % Übereinstimmung` : `${x.inliers} Punkte`) : 'keine');
    toast(a.ok ? `Neu ausgerichtet: ${sc(a)}${before?.ok ? ` (vorher ${sc(before)})` : ''}.` : 'Keine sichere Ausrichtung gefunden – Tipp: „Mit Ankerpunkten ausrichten“.', 5000);
    player.showFrame(f, ui.compare);
  } catch (err) {
    progress.close();
    toast('Fehler: ' + err.message, 5000);
  }
};

$('#fix-flagged').onclick = async () => {
  const list = project.included.filter(f => f.quality === 'warn' || f.quality === 'bad');
  if (!list.length) return;
  progress.open('Auffällige Fotos präzise ausrichten');
  await keepAwake(true);
  try {
    for (let i = 0; i < list.length && !progress.cancelled; i++) {
      progress.set(i / list.length, `Foto ${i + 1} von ${list.length}: ${list[i].name}`);
      await refineFrame(project, getAligner(), list[i]);
    }
    progress.set(0.95, 'Zuschnitt und Farbe werden aktualisiert …');
    await refresh();
    const still = project.included.filter(f => f.quality === 'warn' || f.quality === 'bad').length;
    toast(still ? `${list.length - still} verbessert, ${still} weiterhin auffällig – bitte per Vergleich prüfen.` : 'Alle auffälligen Fotos sind jetzt sauber ausgerichtet.', 5000);
  } catch (err) {
    toast('Fehler: ' + err.message, 5000);
  } finally {
    progress.close();
    keepAwake(false);
  }
};

// Hinweis: einzelnes Foto verkleinert den Ausschnitt stark
let noticeFrame = null;
function renderNotice() {
  const lim = project.aligned ? project.cropLimiters() : [];
  noticeFrame = lim[0]?.frame || null;
  $('#notice').hidden = !noticeFrame;
  if (!noticeFrame) return;
  const k = lim[0].factor;
  $('#notice-text').textContent = `„${noticeFrame.name}“ begrenzt den Bildausschnitt: Ohne dieses Foto wäre er ${num(k, 1)}× so groß (weniger Zoom, mehr Bildinhalt).`;
}
$('#notice-view').onclick = () => noticeFrame && selectFrame(noticeFrame);
$('#notice-exclude').onclick = () => {
  if (!noticeFrame) return;
  noticeFrame.excluded = true;
  if (ui.selected === noticeFrame) updateFramePanel();
  renderStrip();
  scheduleRefresh(0);
};
$('#notice-keep').onclick = () => {
  if (!noticeFrame) return;
  noticeFrame.cropOk = true;
  renderNotice();
};

// ---------------------------------------------------------------- Ankerpunkte
// Der Nutzer setzt im Referenzbild markante Stellen; Lapse sucht sie in allen Fotos
// und richtet danach aus. Falsch gefundene Punkte lassen sich per Finger korrigieren.

const anc = { on: false, frame: null, drag: null, bmp: null, bmpId: null, active: 0 };
const MAX_ANCHORS = 6;
const ancFrames = () => project.frames.filter(f => f.featRes > 0);
const canonToPct = (f, x, y) => { const m = Math.max(f.w, f.h); return [x * m / f.w * 100, y * m / f.h * 100]; };

function openAnchors(frame = project.ref) {
  if (!project.aligned || !player) { toast('Bitte zuerst die Fotos ausrichten (Schritt 1 → „Ausrichten & weiter“).', 4000); return; }
  anc.on = true;
  $('#view-edit').classList.add('anchor-mode');
  document.body.classList.add('anchor-mode');
  $('#panel-anchors').hidden = false;
  $('#anchor-layer').hidden = false;
  showAnchorFrame(frame);
  if (project.anchors.length) anchorUniqueness(project, getAligner()).then(renderAnchors).catch(() => {});
}

function closeAnchors({ refreshAfter = true } = {}) {
  anc.on = false;
  $('#view-edit').classList.remove('anchor-mode');
  document.body.classList.remove('anchor-mode');
  $('#panel-anchors').hidden = true;
  $('#anchor-layer').hidden = true;
  $('#loupe').hidden = true;
  setTab(ui.tab);
  player?.stopInspect();
  layoutStage();
  renderStrip();
  if (refreshAfter) scheduleRefresh(0);
}

async function showAnchorFrame(f) {
  anc.frame = f;
  anc.active = Math.max(0, (f.anchorPts || []).findIndex(p => !p?.manual));
  if (f.anchorPts && f.anchorPts.every(p => p?.manual)) anc.active = -1;
  player.showRaw(f);
  layoutStage();
  renderAnchors();
  $$('#strip .sf.sel').forEach(el => el.classList.remove('sel'));
  const el = $(`#strip [data-id="${f.id}"]`), strip = $('#strip');
  if (el) { el.classList.add('sel'); strip.scrollLeft = el.offsetLeft - strip.clientWidth / 2 + el.offsetWidth / 2; }
  if (anc.bmpId !== f.id) {
    anc.bmp?.close?.();
    anc.bmp = null; anc.bmpId = f.id;
    try { const b = await createImageBitmap(f.previewBlob); if (anc.bmpId === f.id) anc.bmp = b; else b.close?.(); } catch { /* Lupe ohne Bild */ }
  }
}

/** Punkte für die Anzeige im aktuellen Foto (kanonische Bildkoordinaten). */
function anchorPointsFor(f) {
  if (f.id === project.refId) {
    return project.anchors.map(a => ({ x: a.x, y: a.y, cls: a.uniq == null ? '' : a.uniq >= 0.5 ? 'good' : a.uniq >= 0.25 ? 'warn' : 'bad', uniq: a.uniq, reason: a.uniqReason }));
  }
  const Ti = inv(project.transform(f)) || I3();
  return project.anchors.map((a, k) => {
    const p = f.anchorPts?.[k];
    if (p && p.pred) return { x: p.x, y: p.y, cls: 'pred', pred: true };
    if (p) return { x: p.x, y: p.y, cls: p.outlier ? 'bad' : (p.manual && !p.snapped && !p.pinned) ? 'warn' : p.manual ? 'manual' : p.score >= 0.55 ? 'good' : p.score >= 0.3 ? 'warn' : 'bad', score: p.score, manual: p.manual, outlier: p.outlier };
    const [x, y] = apply(Ti, a.x, a.y);
    return { x, y, cls: 'pred', pred: true };
  });
}

function renderAnchors() {
  if (!anc.on) return;
  const f = anc.frame, isRef = f.id === project.refId, pts = anchorPointsFor(f);
  $('#anchor-layer').innerHTML = pts.map((p, k) => {
    const [l, t] = canonToPct(f, p.x, p.y);
    const act = !isRef && anc.active === k ? ' active' : '';
    return `<div class="anchor-pt ${p.cls}${p.pred ? ' pred' : ''}${act}${anc.drag?.k === k ? ' drag' : ''}" style="left:${l}%;top:${t}%"><span>${k + 1}</span></div>`;
  }).join('');
  // Referenz klein einblenden, damit man weiß, wo die Punkte hingehören
  const mini = $('#anc-mini'), ref = project.ref;
  mini.hidden = isRef || !project.anchors.length;
  if (!mini.hidden) {
    const rm = Math.max(ref.w, ref.h);
    mini.style.aspectRatio = `${ref.w} / ${ref.h}`;
    mini.innerHTML = `<img src="${ref.thumbUrl}" alt="Referenzbild">` + project.anchors.map((a, k) =>
      `<span class="mini-pt${anc.active === k ? ' active' : ''}" style="left:${a.x * rm / ref.w * 100}%;top:${a.y * rm / ref.h * 100}%">${k + 1}</span>`).join('');
  }
  const list = ancFrames(), idx = list.indexOf(f);
  $('#anc-title').textContent = isRef ? 'Ankerpunkte im Referenzbild' : 'Ankerpunkte prüfen';
  $('#anc-pos').textContent = `${isRef ? '★ Referenz · ' : ''}Foto ${idx + 1} von ${list.length} · ${f.name}`;
  const tracked = project.frames.some(g => g.anchorPts);
  let help;
  if (isRef && !pts.length) help = 'Tippe im Bild auf 3–5 Stellen, die in ALLEN Fotos vorhanden sind und sich nicht bewegen – z. B. die ersten Haferflocken (nicht später hinzugefügte), Flecken oder Ecken. Möglichst weit auseinander. Nicht auf das, was sich bewegt oder wächst.';
  else if (isRef) help = 'Punkt antippen und ziehen zum Verschieben (die Lupe zeigt die Stelle vergrößert). Weitere Punkte durch Tippen hinzufügen. Danach „In allen Fotos suchen“.';
  else if (anc.active >= 0) {
    const nMan = (f.anchorPts || []).filter(p => p?.manual).length;
    help = `Tippe im Foto auf die Stelle von Punkt ${anc.active + 1} (siehe kleines Referenzbild). ` +
      (nMan < 2 ? 'Nach zwei getippten Punkten erkennt Lapse Drehung und Zoom, sucht die übrigen Punkte selbst und rastet deine Tipps exakt ein.' : 'Übrige Punkte prüfen – falsch liegende antippen oder ziehen.');
  }
  else help = 'Alle Punkte in diesem Foto sind von Hand gesetzt ✓ – weiter mit „Weiter ›“. Punkte lassen sich weiterhin ziehen.';
  $('#anc-help').textContent = help;
  $('#anc-list').innerHTML = pts.map((p, k) => {
    let t;
    if (isRef) {
      t = p.uniq == null ? 'wird geprüft …' : p.uniq >= 0.5 ? 'eindeutige Stelle ✓'
        : p.reason === 'flach' ? 'einfarbige Fläche – bitte andere Stelle wählen'
        : p.reason === 'rand' ? 'zu nah am Rand' : 'nicht eindeutig (gerade Kante/Muster?) – besser eine Ecke wählen';
    } else if (p.pred) t = anc.active === k ? '← jetzt im Foto antippen' : 'noch nicht gesetzt';
    else if (p.outlier && p.manual) t = 'weicht von den anderen ab – bitte mit der Lupe genauer setzen (antippen und ziehen)';
    else if (p.outlier) t = 'passt nicht zu den anderen Punkten – liegt er auf etwas, das sich bewegt? Bitte verschieben oder im Referenzbild löschen';
    else if (p.manual && p.snapped) t = `getippt & eingerastet ✓ (${Math.round(p.snapScore * 100)} %)`;
    else if (p.manual && p.pinned) t = 'von Hand platziert ✓';
    else if (p.manual) t = 'getippt, nicht eingerastet – für Genauigkeit ziehen (Lupe)';
    else t = p.score >= 0.55 ? `gefunden (${Math.round(p.score * 100)} %) ✓` : p.score >= 0.3 ? `unsicher (${Math.round(p.score * 100)} %) – bitte prüfen` : 'nicht gefunden – bitte von Hand setzen';
    return `<li data-k="${k}" class="${!isRef && anc.active === k ? 'active' : ''}"><span class="n ${p.cls}">${k + 1}</span><span class="t">${t}</span>${isRef ? `<button data-del="${k}" aria-label="Punkt ${k + 1} löschen">×</button>` : ''}</li>`;
  }).join('');
  $('#anc-prev').disabled = idx <= 0;
  $('#anc-next').disabled = idx >= list.length - 1;
  $('#anc-ref').disabled = isRef;
  $('#anc-track').disabled = !project.anchors.length;
  $('#anc-track').textContent = tracked ? 'Erneut in allen Fotos suchen' : 'In allen Fotos suchen';
  $('#anc-off').hidden = !project.anchorsActive;
  $('#anc-clear').hidden = !project.anchors.length;
  $('#anc-next-bad').hidden = !tracked;
}

/** Punkte im Referenzbild geändert -> gefundene Punkte verwerfen, Eindeutigkeit neu prüfen. */
let uniqTimer = 0;
function anchorsChanged() {
  if (project.anchorsActive) project.disableAnchors();
  for (const g of project.frames) g.anchorPts = null;
  renderAnchors();
  clearTimeout(uniqTimer);
  uniqTimer = setTimeout(() => anchorUniqueness(project, getAligner()).then(renderAnchors).catch(() => {}), 250);
}

$('#anc-list').onclick = e => {
  const li = e.target.closest('li[data-k]');
  if (li && !e.target.closest('[data-del]') && anc.frame?.id !== project.refId) { anc.active = +li.dataset.k; renderAnchors(); return; }
  const k = e.target.closest('[data-del]')?.dataset.del;
  if (k == null) return;
  project.anchors.splice(+k, 1);
  anchorsChanged();
};

// Antippen = Punkt setzen (nur Referenz), Ziehen = verschieben (relativ, mit Lupe)
const layer = $('#anchor-layer');
layer.addEventListener('pointerdown', e => {
  const f = anc.frame;
  if (!f) return;
  const rect = layer.getBoundingClientRect(), m = Math.max(f.w, f.h);
  const pts = anchorPointsFor(f), isRef = f.id === project.refId;
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  let hit = -1, best = 28;
  pts.forEach((p, k) => {
    const d = Math.hypot(p.x * m / f.w * rect.width - sx, p.y * m / f.h * rect.height - sy);
    if (d < best) { best = d; hit = k; }
  });
  const tapX = sx / rect.width * f.w / m, tapY = sy / rect.height * f.h / m;
  if (!isRef && !f.anchorPts) {
    if (!project.anchors.length) { toast('Erst im Referenzbild Punkte setzen.'); return; }
    // noch nicht gesucht: geschätzte Lagen als Platzhalter, nur Handpunkte zählen
    f.anchorPts = pts.map(p => ({ x: p.x, y: p.y, score: 0, manual: false, pred: true }));
  }
  if (!isRef) {
    const hp = hit >= 0 ? f.anchorPts[hit] : null;
    if (hp && !hp.pred && hit !== anc.active) {
      // vorhandenen (gefundenen/gesetzten) Punkt verschieben – relativ zum Finger
      const p = anchorPointsFor(f)[hit];
      anc.drag = { k: hit, mode: 'move', cx: e.clientX, cy: e.clientY, ox: p.x, oy: p.y, rect, m, moved: false };
    } else {
      // aktiven Punkt genau hier setzen; solange der Finger liegt, folgt er (mit Lupe)
      if (anc.active < 0) { toast('Alle Punkte sind gesetzt – zum Korrigieren einen Punkt ziehen.'); return; }
      const k = anc.active;
      f.anchorPts[k] = { x: tapX, y: tapY, score: 1, manual: true, pinned: false };
      anc.drag = { k, mode: 'place', cx: e.clientX, cy: e.clientY, ox: tapX, oy: tapY, rect, m, moved: true };
    }
    layer.setPointerCapture(e.pointerId);
    drawLoupe(f.anchorPts[anc.drag.k].x, f.anchorPts[anc.drag.k].y);
    renderAnchors();
    return;
  }
  if (hit < 0) {
    if (project.anchors.length >= MAX_ANCHORS) { toast(`Höchstens ${MAX_ANCHORS} Punkte.`); return; }
    project.anchors.push({ x: tapX, y: tapY });
    toast(`Punkt ${project.anchors.length} gesetzt`, 1200);
    hit = project.anchors.length - 1;
    anchorsChanged();
  }
  const p = anchorPointsFor(f)[hit];
  anc.drag = { k: hit, mode: 'move', cx: e.clientX, cy: e.clientY, ox: p.x, oy: p.y, rect, m, moved: false };
  layer.setPointerCapture(e.pointerId);
  drawLoupe(p.x, p.y);
  renderAnchors();
});
layer.addEventListener('pointermove', e => {
  const d = anc.drag, f = anc.frame;
  if (!d) return;
  const k = d.k;
  let x = d.ox + (e.clientX - d.cx) / d.rect.width * f.w / d.m;
  let y = d.oy + (e.clientY - d.cy) / d.rect.height * f.h / d.m;
  x = Math.max(0, Math.min(f.w / d.m, x)); y = Math.max(0, Math.min(f.h / d.m, y));
  if (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) > 2) d.moved = true;
  if (f.id === project.refId) { project.anchors[k].x = x; project.anchors[k].y = y; }
  else if (d.moved) f.anchorPts[k] = { x, y, score: 1, manual: true, pinned: d.mode === 'move' };
  renderAnchors();
  drawLoupe(x, y);
});
const endDrag = () => {
  const d = anc.drag, f = anc.frame;
  if (!d) return;
  anc.drag = null;
  $('#loupe').hidden = true;
  if (f.id === project.refId) { if (d.moved) anchorsChanged(); }
  else if (d.moved) {
    if (anc.active === d.k) {
      // weiter zum nächsten noch nicht gesetzten Punkt
      const next = f.anchorPts.findIndex((p, j) => j > d.k && !p?.manual);
      anc.active = next >= 0 ? next : f.anchorPts.findIndex(p => !p?.manual);
      if (anc.active < 0) toast('Alle Punkte gesetzt ✓ – weiter mit „Weiter ›“.');
    }
    commitFrameAnchors(f);
    return;
  }
  renderAnchors();
};

/** Handpunkte eines Fotos übernehmen: Ausrichtung sofort neu berechnen. */
function commitFrameAnchors(f) {
  project.applyAnchors(f);
  project.anchorsActive = true;
  project.assessQuality();
  renderAnchors();
  renderStrip();
  const manual = f.anchorPts.filter(p => p?.manual).length;
  if (manual >= 2) {
    // Ab zwei Handpunkten: übrige Punkte suchen, Tipps exakt einrasten
    snapFrameAnchors(project, getAligner(), f).then(ok => {
      if (!ok || anc.frame !== f) return;
      const pending = f.anchorPts.findIndex(p => !p?.manual && !(p && !p.pred && p.score >= 0.55 && !p.outlier));
      anc.active = pending;
      project.assessQuality();
      renderAnchors();
      renderStrip();
      if (pending < 0) toast('Foto ausgerichtet ✓ – weiter mit „Weiter ›“.');
    }).catch(err => toast('Fehler beim Einrasten: ' + err.message));
  } else if (!manual) {
    refineAnchored(project, getAligner(), f).then(() => { project.assessQuality(); renderAnchors(); renderStrip(); }).catch(() => {});
  }
}
layer.addEventListener('pointerup', endDrag);
layer.addEventListener('pointercancel', endDrag);

function drawLoupe(x, y) {
  const f = anc.frame, c = $('#loupe'), rect = layer.getBoundingClientRect(), m = Math.max(f.w, f.h);
  const u = x * m / f.w, v = y * m / f.h;
  const px = u * rect.width, py = v * rect.height;
  c.hidden = false;
  c.style.left = Math.max(0, Math.min(rect.width - 120, px - 60)) + 'px';
  c.style.top = (py - 150 >= 0 ? py - 150 : Math.min(rect.height - 120, py + 30)) + 'px';
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 240, 240);
  const b = anc.bmp;
  if (b) {
    const scale = rect.width / b.width, src = 120 / (3 * scale); // 3-fache Vergrößerung
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(b, u * b.width - src / 2, v * b.height - src / 2, src, src, 0, 0, 240, 240);
  }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(120, 90); ctx.lineTo(120, 110); ctx.moveTo(120, 130); ctx.lineTo(120, 150);
  ctx.moveTo(90, 120); ctx.lineTo(110, 120); ctx.moveTo(130, 120); ctx.lineTo(150, 120); ctx.stroke();
}

$('#anchor-btn').onclick = () => openAnchors();
$('#f-anchors').onclick = () => {
  const f = ui.selected;
  openAnchors(f && f.anchorPts && f.id !== project.refId ? f : project.ref);
  if (f && f.id !== project.refId && !project.anchors.length) toast('Erst im Referenzbild Punkte setzen, dann „In allen Fotos suchen“.', 4500);
};
$('#anc-done').onclick = () => closeAnchors();
$('#anc-ref').onclick = () => showAnchorFrame(project.ref);
$('#anc-prev').onclick = () => { const l = ancFrames(), i = l.indexOf(anc.frame); if (i > 0) showAnchorFrame(l[i - 1]); };
$('#anc-next').onclick = () => { const l = ancFrames(), i = l.indexOf(anc.frame); if (i < l.length - 1) showAnchorFrame(l[i + 1]); };
$('#anc-next-bad').onclick = () => {
  const l = ancFrames(), i = l.indexOf(anc.frame);
  const bad = g => g.id !== project.refId && g.anchorPts && g.anchorPts.some(p => p.outlier || (!p.manual && p.score < 0.55));
  const next = [...l.slice(i + 1), ...l.slice(0, i + 1)].find(bad);
  if (next) showAnchorFrame(next); else toast('Keine unsicheren Punkte mehr – alles geprüft.');
};
$('#anc-clear').onclick = () => {
  if (!confirm('Alle Ankerpunkte löschen? Die automatische Ausrichtung wird wiederhergestellt.')) return;
  project.resetAnchors(false);
  renderAnchors();
};
$('#anc-off').onclick = () => {
  project.disableAnchors();
  project.assessQuality();
  renderAnchors();
  toast('Automatische Ausrichtung wiederhergestellt. Die Punkte bleiben gespeichert.');
};
$('#anc-track').onclick = async () => {
  if (!project.anchors.length) return;
  const weak = project.anchors.filter(a => a.uniq != null && a.uniq < 0.25).length;
  if (weak && !confirm(`${weak} Punkt(e) liegen auf nicht eindeutigen Stellen und werden evtl. falsch gefunden. Trotzdem suchen?`)) return;
  progress.open('Ankerpunkte werden gesucht');
  await keepAwake(true);
  try {
    const ok = await trackAllAnchors(project, getAligner(), {
      isCancelled: () => progress.cancelled,
      onProgress: (d, t) => progress.set(d / t, `Foto ${d} von ${t}`),
    });
    progress.close();
    if (!ok) { toast('Abgebrochen.'); return; }
    project.assessQuality();
    const unsure = ancFrames().filter(g => g.id !== project.refId && g.anchorPts?.some(p => p.outlier || (!p.manual && p.score < 0.55))).length;
    renderStrip();
    renderAnchors();
    toast(unsure ? `Fertig. ${unsure} Foto(s) mit unsicheren Punkten – mit „Nächstes unsicheres Foto“ prüfen.` : 'Fertig – alle Punkte sicher gefunden.', 5000);
  } catch (err) {
    progress.close();
    console.error(err);
    toast('Fehler bei der Suche: ' + err.message, 6000);
  } finally {
    keepAwake(false);
  }
};

// ---------------------------------------------------------------- Einstellungen (generisch)

const OUT = {
  pps: v => `${v}`,
  smoothing: v => (v <= 1 ? 'Aus' : `${v} Fotos`),
  holdStart: v => `${num(v, 2)} s`,
  holdEnd: v => `${num(v, 2)} s`,
  zoom: v => `${Math.round(v * 100)} %`,
  colorStrength: v => `${Math.round(v * 100)} %`,
  colorWindow: v => `${v} Fotos`,
  exposure: v => `${v > 0 ? '+' : ''}${num(v, 2)} EV`,
  contrast: v => `${Math.round(v * 100)} %`,
  saturation: v => `${Math.round(v * 100)} %`,
};
const HELP = {
  model: {
    translation: 'Für Stativaufnahmen: Nur Verschiebungen werden korrigiert – am stabilsten.',
    similarity: 'Korrigiert Verschiebung, Drehung, Zoom und leichte Verzerrung – für Stativ mit leichtem Wackeln.',
    homography: 'Korrigiert zusätzlich die Perspektive – richtig für Aufnahmen aus der Hand (empfohlen).',
  },
  colorMode: {
    off: 'Fotos bleiben unverändert (nur deine manuellen Korrekturen wirken).',
    deflicker: 'Entfernt Helligkeits- und Farbsprünge zwischen benachbarten Fotos. Natürliche Verläufe wie Sonnenuntergänge bleiben erhalten.',
    reference: 'Gleicht alle Fotos in Helligkeit und Farbe an das Referenzbild an – für gleichmäßiges Licht.',
  },
};
const VIDEO_KEYS = new Set(['fps', 'pps', 'crossfade', 'smoothing', 'pingpong', 'holdStart', 'holdEnd']);
const COLOR_KEYS = new Set(['colorMode', 'colorStrength', 'colorWindow', 'colorChannels']);
const GLOBAL_KEYS = new Set(['exposure', 'contrast', 'saturation']);
const ALIGN_KEYS = new Set(['model', 'precision', 'refMode']);

function syncSettingsUI() {
  const s = project.settings;
  $$('.seg[data-set]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(s[seg.dataset.set]))));
  $$('input[data-set]').forEach(i => { if (i.type === 'checkbox') i.checked = !!s[i.dataset.set]; else i.value = s[i.dataset.set]; });
  $$('output[data-out]').forEach(o => { o.textContent = OUT[o.dataset.out]?.(s[o.dataset.out]) ?? s[o.dataset.out]; });
  $$('[data-help]').forEach(p => { p.textContent = HELP[p.dataset.help]?.[s[p.dataset.help]] || ''; });
  $$('[data-if]').forEach(el => {
    const [, k, op, v] = el.dataset.if.match(/(\w+)(==|!=)(\w+)/);
    el.hidden = op === '==' ? String(s[k]) !== v : String(s[k]) === v;
  });
  const names = { translation: 'Stativ', similarity: 'Leicht bewegt', homography: 'Freihand' };
  $('#align-summary').textContent = `· ${names[s.model]}, ${s.precision === 'precise' ? 'präzise' : 'schnell'}`;
}

function onSetting(key) {
  const s = project.settings;
  store.set('settings', s);
  syncSettingsUI();
  if (VIDEO_KEYS.has(key)) { player?.invalidate(); updateDuration(); }
  else if (key === 'aspect' || key === 'zoom') { if (project.aligned) { project.computeCrop(); layoutStage(); player?.invalidate(); scheduleRefresh(); } }
  else if (COLOR_KEYS.has(key)) { project.computeColor(); player?.render(); }
  else if (GLOBAL_KEYS.has(key)) player?.render();
  else if (ALIGN_KEYS.has(key)) {
    if (key === 'refMode' && s.refMode !== 'manual') project.refId = null;
    if (key !== 'precision' && project.aligned) { project.aligned = false; updateSteps(); toast('Einstellung geändert – Fotos werden beim Weitergehen neu ausgerichtet.'); }
    updatePrimary();
  }
}

$$('.seg[data-set]').forEach(seg => seg.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  const k = seg.dataset.set;
  project.settings[k] = seg.hasAttribute('data-num') ? Number(b.dataset.v) : b.dataset.v;
  onSetting(k);
}));
$$('input[data-set]').forEach(i => i.addEventListener('input', () => {
  const k = i.dataset.set;
  project.settings[k] = i.type === 'checkbox' ? i.checked : Number(i.value);
  onSetting(k);
}));

function updateDuration() {
  if (!project.included.length) return;
  const tl = project.timeline();
  $('#dur-readout').textContent = `${fmtClock(tl.duration)} s · ${tl.frames} Videobilder aus ${tl.sequence.length} Fotos`;
}

function updateCropHelp() {
  const c = project.crop, ref = project.ref;
  if (!c || !ref) return;
  const [rw] = Project.dims(ref);
  const pct = Math.round(c.full.w / rw * 100);
  $('#crop-help').textContent = project.cropFailed
    ? 'Achtung: Die Fotos überlappen kaum – bitte stark abweichende Fotos ausschließen oder korrigieren.'
    : `Automatischer Ausschnitt ohne leere Ränder: ${pct} % der Bildbreite der Referenz.`;
}

// ---------------------------------------------------------------- Export

const capCache = new Map();
async function supported(format, w, h, fps) {
  const key = `${format}|${w}|${h}|${fps}`;
  if (!capCache.has(key)) capCache.set(key, findConfig(format, w, h, fps).then(Boolean));
  return capCache.get(key);
}

async function refreshExport() {
  if (!project.crop) return;
  const aspect = project.crop.w / project.crop.h, fps = project.settings.fps;
  const hasEncoder = typeof VideoEncoder !== 'undefined';
  const mr = mediaRecorderType();
  const avail = {};
  for (const f of ['mp4-avc', 'mp4-hevc', 'webm-vp9']) {
    const { w, h } = outputSize(aspect, 720);
    avail[f] = hasEncoder && await supported(f, w, h, fps);
  }
  if (!avail['mp4-avc'] && mr) avail['mp4-avc'] = 'fallback';
  avail.gif = true; avail.zip = true;
  if (!avail[ui.exp.format]) ui.exp.format = Object.keys(avail).find(k => avail[k]);
  $('#formats').innerHTML = Object.entries(FORMATS).map(([k, F]) => {
    const ok = avail[k];
    const note = !ok ? 'Auf diesem Gerät nicht verfügbar' : ok === 'fallback' ? 'Echtzeit-Aufnahme (älteres iOS) – dauert so lange wie das Video' : F.note;
    return `<label class="radio${ok ? '' : ' off'}"><input type="radio" name="fmt" value="${k}" ${ui.exp.format === k ? 'checked' : ''} ${ok ? '' : 'disabled'}>
      <b>${F.label}</b><small>${note}</small></label>`;
  }).join('');
  $$('#formats input').forEach(i => i.onchange = () => { ui.exp.format = i.value; store.set('export', ui.exp); refreshExport(); });

  // Auflösung
  const fmt = ui.exp.format, isGif = fmt === 'gif';
  const detail = sourceDetail(project);
  let opts;
  if (isGif) opts = [[320, 'Klein · 320 px'], [480, 'Mittel · 480 px'], [720, 'Groß · 720 px']];
  else opts = [[720, '720p'], [1080, '1080p'], [1440, '1440p'], [2160, '4K']];
  const cur = isGif ? ui.exp.gifLong : ui.exp.shortEdge;
  const states = await Promise.all(opts.map(async ([v]) => {
    if (isGif || fmt === 'zip' || avail[fmt] === 'fallback') return true;
    const { w, h } = outputSize(aspect, v);
    return supported(fmt, w, h, fps);
  }));
  if (!isGif && !states[opts.findIndex(o => o[0] === cur)]) {
    const best = opts.filter((o, i) => states[i] && o[0] <= cur).pop() || opts.find((o, i) => states[i]);
    if (best) ui.exp.shortEdge = best[0];
  }
  const sel = isGif ? ui.exp.gifLong : ui.exp.shortEdge;
  $('#res').innerHTML = opts.map(([v, l], i) => {
    const d = isGif ? '' : (() => { const { w, h } = outputSize(aspect, v); return `<br><small class="muted">${w}×${h}</small>`; })();
    return `<button data-v="${v}" class="${v === sel ? 'on' : ''}" ${states[i] ? '' : 'disabled'} style="line-height:1.15;padding:6px">${l}${d}</button>`;
  }).join('');
  $$('#res button').forEach(b => b.onclick = () => {
    if (isGif) ui.exp.gifLong = +b.dataset.v; else ui.exp.shortEdge = +b.dataset.v;
    store.set('export', ui.exp);
    refreshExport();
  });
  const help = [];
  if (!isGif && ui.exp.shortEdge > detail * 1.05) help.push(`Hinweis: Der Ausschnitt deiner Fotos hat an der kurzen Kante ca. ${detail} px – höhere Auflösungen werden hochgerechnet.`);
  if (states.some(s => !s)) help.push('Ausgegraute Größen unterstützt der Video-Encoder dieses Geräts nicht.');
  $('#res-help').textContent = help.join(' ');
  ui.resStates = Object.fromEntries(opts.map(([v], i) => [v, states[i]]));
  updateQualityUI();
  updatePrimary();
}

// ---- Qualität & Dateigröße (wirkt auf alle Formate) ----
const fmtMB = mb => (mb < 10 ? num(mb, 1) : num(mb, 0)) + ' MB';
const SIZE_CHIPS = [8, 16, 25, 50, 100, 250];
const sizeToSlider = (mb, p) => Math.round(1000 * Math.log(mb / p.minMB) / Math.log(p.maxMB / p.minMB));
const sliderToSize = (v, p) => p.minMB * Math.pow(p.maxMB / p.minMB, v / 1000);

function updateQualityUI() {
  if (!project.crop) return;
  const e = ui.exp, fmt = e.format, isVideo = fmt !== 'gif' && fmt !== 'zip';
  if (!isVideo) e.sizeMode = 'quality';
  $('#size-mode').hidden = !isVideo;
  $$('#size-mode button').forEach(b => b.classList.toggle('on', b.dataset.v === e.sizeMode));
  const bySize = isVideo && e.sizeMode === 'size';
  $('#q-quality').hidden = bySize;
  $('#q-size').hidden = !bySize;
  let p = exportPlan(project, e);
  if (bySize) {
    // Zielgröße auf den möglichen Bereich begrenzen
    const mb = Math.min(p.maxMB, Math.max(p.minMB, e.targetMB));
    if (Math.abs(mb - e.targetMB) > 1e-6) { e.targetMB = +mb.toFixed(2); p = exportPlan(project, e); }
    $('#s-slider').value = sizeToSlider(e.targetMB, p);
    $('#s-out').textContent = fmtMB(e.targetMB);
    $('#s-chips').innerHTML = SIZE_CHIPS.map(mb => `<button data-mb="${mb}" class="${Math.abs(mb - e.targetMB) < 0.01 ? 'on' : ''}" ${mb > p.maxMB * 1.001 || mb < p.minMB ? 'disabled' : ''}>${mb} MB</button>`).join('');
  } else {
    $('#q-slider').value = e.q;
    $('#q-out').textContent = `${qualityName(e.q)} · ${e.q} %`;
  }
  // Kennzahlen
  const est = p.estBytes / 1e6;
  const cells = isVideo
    ? [[bySize ? `max. ${fmtMB(e.targetMB)}` : `≈ ${fmtMB(est)}`, 'Dateigröße'], [`${num(p.bitrate / 1e6, 1)} Mbit/s`, 'Datenrate'], [`${p.w}×${p.h}`, `${p.fps} fps`]]
    : fmt === 'gif'
      ? [[`≈ ${fmtMB(est)}`, 'Dateigröße'], [`${p.colors}`, 'Farben'], [`${p.w}×${p.h}`, `${p.fps} fps`]]
      : [[`≈ ${fmtMB(est)}`, 'Gesamtgröße'], [`${Math.round(p.jpegQ * 100)} %`, 'JPEG-Qualität'], [`${p.w}×${p.h}`, `${p.photos} Fotos`]];
  $('#q-info').innerHTML = cells.map(([a, b]) => `<div><b>${a}</b><small>${b}</small></div>`).join('');
  // Hinweise & Empfehlung
  const help = $('#q-help');
  help.classList.remove('warn-text');
  let text = '';
  if (isVideo) {
    if (p.bpp < 0.045) {
      help.classList.add('warn-text');
      // höchste Auflösung finden, bei der die Datenrate für saubere Bilder reicht
      const better = [2160, 1440, 1080, 720].filter(v => v < e.shortEdge && ui.resStates?.[v] !== false)
        .find(v => exportPlan(project, { ...e, shortEdge: v }).bpp >= 0.06);
      text = `Sehr niedrige Datenrate für ${p.w}×${p.h} – Blockbildung und Unschärfe möglich.` + (better ? ` <button class="link" data-res="${better}">Auf ${better === 2160 ? '4K' : better + 'p'} wechseln</button> (gleiche Dateigröße, sauberere Bilder).` : '');
    } else if (p.capped === 'max') text = 'Höchste sinnvolle Datenrate erreicht – mehr verbessert die Qualität nicht sichtbar.';
    else if (bySize) text = 'Die Datenrate wird so gewählt, dass das Video die Zielgröße möglichst nicht überschreitet – z. B. für Messenger oder E-Mail mit Größenlimit.';
    else text = 'Höhere Qualität = größere Datei. „Hoch“ ist für Fotos-App und Teilen ideal, „Maximal“ für die Weiterbearbeitung.';
    if (fmt === 'mp4-hevc' && !bySize) text += ' HEVC braucht für gleiche Qualität rund 40 % weniger Daten.';
  } else if (fmt === 'gif') text = 'Beeinflusst Farbanzahl und Bildrate des GIFs – die größten Hebel für die Dateigröße. Zusätzlich hilft eine kleinere Pixelgröße.';
  else text = 'Bestimmt die JPEG-Kompression der Einzelbilder.';
  help.innerHTML = text;
  help.querySelector('[data-res]')?.addEventListener('click', ev => { e.shortEdge = +ev.target.dataset.res; store.set('export', e); refreshExport(); });

  // Übersicht
  const rows = fmt === 'zip'
    ? [['Fotos', p.photos], ['Bildgröße', `${p.w}×${p.h}`], ['Dateigröße', `≈ ${fmtMB(est)}`]]
    : [['Dauer', `${fmtClock(p.duration)} s`], ['Bildrate', `${p.fps} fps`], ['Fotos', `${p.sequence}`], ['Bildgröße', `${p.w}×${p.h}`],
      ['Dateigröße', bySize ? `max. ${fmtMB(e.targetMB)}` : `≈ ${fmtMB(est)}`]];
  $('#summary').innerHTML = `<h2>Übersicht</h2><dl>${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>`;
}

const saveExp = () => store.set('export', ui.exp);
$$('#size-mode button').forEach(b => b.onclick = () => { ui.exp.sizeMode = b.dataset.v; saveExp(); updateQualityUI(); });
$('#q-slider').addEventListener('input', e => { ui.exp.q = +e.target.value; updateQualityUI(); });
$('#q-slider').addEventListener('change', saveExp);
$('#s-slider').addEventListener('input', e => {
  const p = exportPlan(project, ui.exp);
  const mb = sliderToSize(+e.target.value, p);
  ui.exp.targetMB = +(mb < 10 ? mb.toFixed(1) : mb.toFixed(0));
  updateQualityUI();
});
$('#s-slider').addEventListener('change', saveExp);
$('#s-chips').addEventListener('click', e => {
  const mb = e.target.closest('[data-mb]')?.dataset.mb;
  if (mb) { ui.exp.targetMB = +mb; saveExp(); updateQualityUI(); }
});

async function doExport() {
  if (!project.crop) return;
  player?.pause();
  progress.open(ui.exp.format === 'zip' ? 'Einzelbilder werden erstellt' : 'Video wird erstellt');
  progress.set(0, 'Bitte die App geöffnet und den Bildschirm an lassen.');
  await keepAwake(true);
  try {
    const plan = exportPlan(project, ui.exp);
    const res = await runExport(project, ui.exp, {
      isCancelled: () => progress.cancelled,
      onProgress: (f, t) => progress.set(f, t),
    });
    progress.close();
    showResult(res, plan);
  } catch (err) {
    progress.close();
    if (err.name === 'AbortError') toast('Export abgebrochen.');
    else { console.error(err); toast('Export fehlgeschlagen: ' + err.message, 7000); }
  } finally {
    keepAwake(false);
  }
}

function showResult(res, plan) {
  if (ui.result) URL.revokeObjectURL(ui.result.url);
  const url = URL.createObjectURL(res.blob);
  ui.result = { ...res, url };
  const media = $('#result-media');
  if (res.blob.type.startsWith('video/')) media.innerHTML = `<video src="${url}" controls playsinline loop muted autoplay></video>`;
  else if (res.blob.type === 'image/gif') media.innerHTML = `<img src="${url}" alt="Erstelltes GIF">`;
  else media.innerHTML = '';
  let info = `${res.name} · ${res.w}×${res.h} · ${num(res.blob.size / 1e6, 1)} MB${res.duration ? ` · ${fmtClock(res.duration)} s` : ''}`;
  if (plan?.bySize) {
    const over = res.blob.size / 1e6 / ui.exp.targetMB;
    info += over > 1.03 ? ` – ${Math.round((over - 1) * 100)} % über der Zielgröße; für ein sicheres Limit etwas kleiner wählen.` : ' – innerhalb der Zielgröße.';
  }
  $('#result-info').textContent = info;
  $('#share').textContent = res.blob.type.startsWith('video/') ? 'In Fotos sichern / Teilen' : 'Teilen / Sichern';
  $('#result').hidden = false;
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(`Fertig: ${res.name}`);
}

$('#share').onclick = async () => {
  const r = ui.result;
  if (!r) return;
  const file = new File([r.blob], r.name, { type: r.blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Lapse' }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  download();
};
$('#download').onclick = () => download();
function download() {
  const r = ui.result;
  if (!r) return;
  const a = document.createElement('a');
  a.href = r.url;
  a.download = r.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------- Start

let allowLeave = false;
window.addEventListener('beforeunload', e => { if (project.frames.length && !allowLeave) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- Automatische Updates
// Neue Versionen werden beim Start und beim Zurückkehren in die App erkannt. Ohne geladenes
// Projekt wird sofort aktualisiert, sonst erst nach Bestätigung (damit keine Arbeit verloren geht).
$('#version').textContent = isDev ? 'Entwicklungsversion' : `Version ${BUILD} · ${BUILD_DATE}`;

function offerUpdate(apply) {
  if (!project.frames.length) { apply(); return; }
  if ($('.update-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.innerHTML = '<span>Eine neue Lapse-Version ist da.</span><button class="btn small primary">Jetzt laden</button><button class="btn small ghost">Später</button>';
  const [now, later] = bar.querySelectorAll('button');
  now.onclick = () => {
    if (confirm('Beim Aktualisieren wird das aktuelle Projekt geschlossen. Fertige Exporte vorher sichern. Jetzt aktualisieren?')) apply();
  };
  later.onclick = () => bar.remove();
  document.body.appendChild(bar);
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  let reloading = false;
  // Erstinstallation übernimmt nur die Kontrolle -> nicht neu laden; jeder spätere Wechsel ist ein Update
  let controller = navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const had = controller;
    controller = navigator.serviceWorker.controller;
    if (reloading || !had) return;
    reloading = true;
    window.onbeforeunload = null;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    const activate = w => () => { allowLeave = true; w.postMessage('activate-now'); };
    const watch = w => w && w.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(activate(w));
    });
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(activate(reg.waiting));
    watch(reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    const check = () => reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
    setInterval(check, 30 * 60 * 1000);
  }).catch(() => {});
}

// Fehlende Browserfunktionen früh melden
(function checkSupport() {
  const probs = [];
  if (typeof createImageBitmap === 'undefined') probs.push('Bilddekodierung');
  try { const c = document.createElement('canvas'); if (!(c.getContext('webgl2') || c.getContext('webgl'))) probs.push('WebGL'); } catch { probs.push('WebGL'); }
  if (probs.length) toast(`Dieser Browser unterstützt nicht: ${probs.join(', ')}. Bitte iOS/Safari aktualisieren.`, 8000);
})();

function measureHeader() {
  document.documentElement.style.setProperty('--head-h', $('.top').offsetHeight + 'px');
}
window.addEventListener('resize', measureHeader);
measureHeader();
syncSettingsUI();
updatePrimary();

// Für Tests/Fehlersuche
window.__lapse = { project, ui, DEFAULT_SETTINGS, getAligner };

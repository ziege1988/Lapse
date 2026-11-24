// Lapse – Steuerung der Oberfläche.

import { Project, newManual, DEFAULT_SETTINGS } from './project.js';
import { Aligner, importFiles, sortFrames, alignAll, refineFrame, StatsEngine } from './pipeline.js';
import { Player } from './player.js';
import { FORMATS, findConfig, mediaRecorderType, outputSize, sourceDetail, runExport, fmtTime } from './export.js';
import { inv, mul, I3 } from './geometry.js';

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

const ui = {
  view: 'photos', tab: 'video', selected: null, compare: 'off',
  exp: Object.assign({ format: 'mp4-avc', shortEdge: 1080, quality: 'high', gifLong: 480 }, store.get('export', {})),
  result: null,
};

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
  const aspect = project.crop.w / project.crop.h;
  const avail = $('.stage-wrap').clientWidth || window.innerWidth - 32;
  // Vorschau bleibt angeheftet -> Höhe begrenzen, damit genug Platz für die Regler bleibt
  const maxH = Math.min(window.innerHeight * 0.36, 560);
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
  if (f) selectFrame(f);
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
    q.textContent = f.autoExcluded ? 'Automatisch ausgeschlossen: keine sichere Ausrichtung gefunden (anderes Motiv, Nebel, Unschärfe?).' : 'Ausgeschlossen – erscheint nicht im Video';
  }
  else {
    const detail = a?.ok ? ` (${a.inliers} Punkte, Abweichung ${num(a.rms, 2)} px${a.via ? ', über Nachbarbild' : ''})` : '';
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
  f.align = { ...f.align, ok: true, H: I3(), inliers: Infinity, rms: 0, via: null };
  project.settings.refMode = 'manual';
  project.refId = f.id;
  scheduleRefresh(0);
  updateFramePanel();
  renderStrip();
  toast('Neues Referenzbild gesetzt.');
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
    toast(a.ok ? `Neu ausgerichtet: ${a.inliers} Punkte, Abweichung ${num(a.rms, 2)} px${before?.ok ? ` (vorher ${before.inliers})` : ''}.` : 'Keine sichere Ausrichtung gefunden – bitte manuell korrigieren oder ausschließen.', 4500);
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
    similarity: 'Korrigiert Verschiebung, Drehung und leichten Zoom. Für die meisten Aufnahmen richtig.',
    homography: 'Korrigiert zusätzlich die Perspektive – für Aufnahmen aus der Hand oder von leicht wechselnden Standpunkten.',
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
  const names = { translation: 'Stativ', similarity: 'Standard', homography: 'Freihand' };
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
  $('#quality-card').hidden = isGif || fmt === 'zip';
  $$('#quality button').forEach(b => b.classList.toggle('on', b.dataset.v === ui.exp.quality));

  // Übersicht
  const tl = project.timeline();
  let { w, h } = outputSize(aspect, ui.exp.shortEdge);
  if (isGif) { const k = Math.min(1, ui.exp.gifLong / Math.max(w, h)); w = Math.round(w * k / 2) * 2; h = Math.round(h * k / 2) * 2; }
  const bpp = { standard: 0.09, high: 0.16, max: 0.28 }[ui.exp.quality];
  const fps2 = isGif ? Math.min(25, fps) : fps;
  let size = '';
  if (fmt === 'zip') size = `ca. ${num(project.included.length * w * h * 0.35 / 1e6, 0)} MB`;
  else if (isGif) size = `ca. ${num(tl.duration * fps2 * w * h * 0.25 / 1e6, 0)} MB`;
  else size = `ca. ${num(Math.min(80e6, w * h * fps * bpp) * tl.duration / 8 / 1e6 * (fmt === 'mp4-hevc' ? 0.6 : 0.75), 0)} MB`;
  const rows = fmt === 'zip'
    ? [['Fotos', project.included.length], ['Bildgröße', `${w}×${h}`], ['Dateigröße', size]]
    : [['Dauer', `${fmtClock(tl.duration)} s`], ['Bildrate', `${fps2} fps`], ['Fotos', `${tl.sequence.length}`], ['Bildgröße', `${w}×${h}`], ['Dateigröße', size]];
  $('#summary').innerHTML = `<h2>Übersicht</h2><dl>${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>`;
  updatePrimary();
}

$$('#quality button').forEach(b => b.onclick = () => { ui.exp.quality = b.dataset.v; store.set('export', ui.exp); refreshExport(); });

async function doExport() {
  if (!project.crop) return;
  player?.pause();
  progress.open(ui.exp.format === 'zip' ? 'Einzelbilder werden erstellt' : 'Video wird erstellt');
  progress.set(0, 'Bitte die App geöffnet und den Bildschirm an lassen.');
  await keepAwake(true);
  try {
    const res = await runExport(project, {
      format: ui.exp.format, shortEdge: ui.exp.shortEdge, quality: ui.exp.quality, gifLong: ui.exp.gifLong,
      isCancelled: () => progress.cancelled,
      onProgress: (f, t) => progress.set(f, t),
    });
    progress.close();
    showResult(res);
  } catch (err) {
    progress.close();
    if (err.name === 'AbortError') toast('Export abgebrochen.');
    else { console.error(err); toast('Export fehlgeschlagen: ' + err.message, 7000); }
  } finally {
    keepAwake(false);
  }
}

function showResult(res) {
  if (ui.result) URL.revokeObjectURL(ui.result.url);
  const url = URL.createObjectURL(res.blob);
  ui.result = { ...res, url };
  const media = $('#result-media');
  if (res.blob.type.startsWith('video/')) media.innerHTML = `<video src="${url}" controls playsinline loop muted autoplay></video>`;
  else if (res.blob.type === 'image/gif') media.innerHTML = `<img src="${url}" alt="Erstelltes GIF">`;
  else media.innerHTML = '';
  $('#result-info').textContent = `${res.name} · ${res.w}×${res.h} · ${num(res.blob.size / 1e6, 1)} MB${res.duration ? ` · ${fmtClock(res.duration)} s` : ''}`;
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

window.addEventListener('beforeunload', e => { if (project.frames.length) { e.preventDefault(); e.returnValue = ''; } });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
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
window.__lapse = { project, ui, DEFAULT_SETTINGS };

// Lapse – Steuerung der Oberfläche.

import { Project, newManual, DEFAULT_SETTINGS } from './project.js';
import { Aligner, importFiles, sortFrames, alignAll, refineFrame, StatsEngine, anchorUniqueness, trackAllAnchors, refineAnchored, snapFrameAnchors, alignByAnchors, correctByTaps } from './pipeline.js';
import { Player } from './player.js';
import { FORMATS, findConfig, mediaRecorderType, outputSize, sourceDetail, runExport, exportPlan, qualityName } from './export.js';
import { inv, mul, apply, I3 } from './geometry.js';
import { BUILD, BUILD_DATE, isDev } from './version.js';
import { ProjectStore } from './store.js';
import { Capture } from './capture.js';
import { Hero } from './hero.js';
import { mmPerUnit, fmtLength, makeOverlay, overlaySig, effectiveRoi } from './overlay.js';
import { log, onLog, installHooks, buildReport, counts, stamp } from './diag.js';

installHooks();
log(`Lapse gestartet · Version ${BUILD.startsWith('__') ? 'Entwicklung' : BUILD.slice(0, 7)}`);

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

// ---------------------------------------------------------------- Speichern auf dem Gerät
// Projekt (Fotos, Fixpunkte, Ausrichtung, Einstellungen) und letztes Video werden laufend
// gesichert – damit nichts verloren geht, wenn iOS den Tab neu lädt.
const db = new ProjectStore();
let saveTimer = 0, saving = false, dirty = false, resumeOffered = false;
function scheduleSave(delay = 1200) {
  if (!db.available || !project.frames.length) return;
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!dirty || saving || !project.frames.length) return;
  saving = true; dirty = false;
  try { await db.save(project); }
  catch (err) {
    console.error(err);
    if (!saveNow.warned) { saveNow.warned = true; toast('Projekt konnte nicht auf dem Gerät gesichert werden (Speicher voll?).', 6000); }
  } finally { saving = false; if (dirty) scheduleSave(); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
window.addEventListener('pagehide', () => saveNow());
const getAligner = () => (aligner ||= new Aligner());

// ---------------------------------------------------------------- Hilfen

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

// ---- Startbild (lebendige Petrischale) – läuft nur, wenn die Startseite sichtbar ist
let hero = null;
function heroRun(on) {
  if (on && !hero) { try { hero = new Hero($('#hero-canvas'), { t: $('#hh-t'), f: $('#hh-f'), a: $('#hh-a'), d: $('#hh-d') }); } catch (err) { console.error(err); return; } }
  if (!hero) return;
  const vis = on && !document.hidden && !document.body.classList.contains('capture-open');
  vis ? hero.start() : hero.stop();
}
document.addEventListener('visibilitychange', () => heroRun(ui.view === 'photos' && !project.frames.length));
new MutationObserver(() => heroRun(ui.view === 'photos' && !project.frames.length)).observe(document.body, { attributes: true, attributeFilter: ['class'] });

const escHtml = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** Rechenprotokoll: zeigt live, was im Hintergrund berechnet wird (statt eines reinen Ladebalkens). */
const progress = {
  cancelled: false,
  open(title, { cancellable = true } = {}) {
    this.cancelled = false;
    this.title = title; this.t0 = Date.now(); this.frac = 0; this.lastText = ''; this.since = Date.now() - 1;
    $('#progress-title').textContent = title;
    $('#progress-text').textContent = '';
    $('#progress-bar').style.width = '0%';
    $('#proc-pct').textContent = '0 %';
    $('#proc-eta').textContent = 'REST –';
    $('#proc-rate').textContent = '';
    $('#proc-log').innerHTML = '';
    $('#progress-cancel').hidden = !cancellable;
    $('#progress').hidden = false;
    log(`▶ ${title}`);
    clearInterval(this.timer);
    this.timer = setInterval(() => this.meta(), 500);
    this.meta();
  },
  set(frac, text) {
    if (frac != null) {
      this.frac = Math.max(0, Math.min(1, frac));
      $('#progress-bar').style.width = (this.frac * 100).toFixed(1) + '%';
      $('#proc-pct').textContent = Math.round(this.frac * 100) + ' %';
    }
    if (text != null && text !== this.lastText) {
      this.lastText = text;
      $('#progress-text').textContent = text;
      if (!/\d+ von \d+/.test(text)) log(text, 'd'); // Zähler nur anzeigen, Messzeilen protokollieren
    }
    this.meta();
  },
  meta() {
    if ($('#progress').hidden) return;
    const el = (Date.now() - this.t0) / 1000, f = this.frac;
    const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    $('#proc-elapsed').textContent = 'T+' + mmss(el);
    $('#proc-eta').textContent = f > 0.03 && f < 1 && el > 2 ? 'REST ~' + mmss(el / f * (1 - f)) : 'REST –';
  },
  close() {
    if (!$('#progress').hidden) log(`■ ${this.title} · ${((Date.now() - this.t0) / 1000).toFixed(1)} s${this.cancelled ? ' · abgebrochen' : ''}`, this.cancelled ? 'w' : 'ok');
    clearInterval(this.timer);
    $('#progress').hidden = true;
  },
};
// Protokollzeilen live in der Konsole und Warnleuchten aktualisieren
onLog(e => {
  if (!$('#progress').hidden && e.t >= progress.since) {
    const box = $('#proc-log');
    box.insertAdjacentHTML('beforeend', `<span class="l ${e.level}"><span class="t">${stamp(e.t)}</span> ${escHtml(e.msg)}</span>`);
    while (box.children.length > 12) box.firstChild.remove();
  }
  if (e.level === 'e' || e.level === 'w') updateLeds();
  if (e.level === 'e' && Date.now() - (updateLeds.lastToast || 0) > 15000) {
    updateLeds.lastToast = Date.now();
    setTimeout(() => toast('Ein Fehler wurde protokolliert – oben „DIAG“ antippen und den Bericht senden.', 5000), 0);
  }
});
function updateLeds() {
  const c = counts();
  for (const led of $$('.diag-btn .led')) { led.classList.toggle('err', c.errors > 0); led.classList.toggle('warn', !c.errors && c.warnings > 0); }
}

// ---- Diagnose
async function openDiag() {
  const report = await buildReport({ project, ui, build: BUILD.startsWith('__') ? 'Entwicklung' : BUILD });
  const c = counts();
  $('#diag-stats').innerHTML = `<div class="${c.errors ? 'bd' : ''}"><small>Fehler</small><b>${c.errors}</b></div><div class="${c.warnings ? 'wn' : ''}"><small>Warnungen</small><b>${c.warnings}</b></div><div><small>Protokoll</small><b>${c.lines}</b></div>`;
  $('#diag-led').className = 'led' + (c.errors ? ' err' : c.warnings ? ' warn' : '');
  $('#diag-log').textContent = report;
  $('#diag').hidden = false;
  openDiag.report = report;
}
$('#diag-btn').onclick = openDiag;
$('#proc-diag').onclick = openDiag;
$('#diag-close').onclick = () => { $('#diag').hidden = true; };
$('#diag-copy').onclick = async () => {
  const text = openDiag.report || '';
  try { await navigator.clipboard.writeText(text); toast('Bericht kopiert – jetzt im Chat einfügen.', 3500); return; } catch { /* Rückfall */ }
  const r = document.createRange(); r.selectNodeContents($('#diag-log'));
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  const ok = document.execCommand?.('copy');
  toast(ok ? 'Bericht kopiert – jetzt im Chat einfügen.' : 'Text ist markiert – über „Kopieren“ übernehmen.', 3500);
};
$('#diag-share').onclick = async () => {
  try { await navigator.share({ title: 'Lapse Diagnose', text: openDiag.report || '' }); }
  catch (err) { if (err.name !== 'AbortError') toast('Teilen nicht möglich – bitte „Bericht kopieren“.', 3500); }
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

const onStage = () => ui.view === 'edit' || ui.view === 'crop';
function showView(v) {
  if (ui.review && v !== 'edit') endReview();
  if (cropUI.on && v !== 'crop') closeCrop(true, { silent: true }); // Zuschnitt beim Verlassen übernehmen
  if (anc.on && !cropUI.on && v !== 'edit') closeAnchors({ refreshAfter: false });
  ui.view = v;
  if (v !== 'edit') exitFullscreen();
  const sec = v === 'crop' ? 'edit' : v;
  for (const s of ['photos', 'points', 'edit', 'export']) $('#view-' + s).hidden = s !== sec;
  $('#guide-edit').hidden = v === 'crop';
  $('#guide-crop').hidden = v !== 'crop';
  $$('.step').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (v !== 'edit') player?.pause();
  if (v === 'edit') { layoutStage(); renderStrip(); updateFramePanel(); player.invalidate(); }
  if (v === 'crop') openCrop();
  if (v === 'export') { refreshExport(); updateCropState(); syncExportScale(); }
  if (v === 'points') renderPoints();
  updatePrimary();
  window.scrollTo({ top: 0 });
}

function updateSteps() {
  const ok = project.aligned && project.included.length >= 2;
  const canPoints = project.frames.length >= 2 && !project.frames.some(f => f.analyzing);
  $$('.step').forEach(b => {
    if (b.dataset.view === 'points') b.disabled = !canPoints;
    else if (b.dataset.view !== 'photos') b.disabled = !ok;
  });
}

function updatePrimary() {
  const b = $('#primary'), n = project.frames.length;
  b.disabled = false;
  // Startseite: zwei Wege als Karten – unten kein zusätzlicher Knopf
  const choosing = ui.view === 'photos' && !n;
  document.body.classList.toggle('choosing', choosing);
  heroRun(choosing);
  if (cropUI.on) { b.textContent = 'Übernehmen & weiter zum Export'; return; }
  if (ui.review) {
    const r = ui.review, last = reviewRemaining() <= 1;
    if (r.mode === 'tap') {
      b.textContent = r.busy ? 'Wird ausgerichtet …' : `Noch ${3 - r.taps.length} Flocke${3 - r.taps.length === 1 ? '' : 'n'} antippen`;
      b.disabled = true;
    } else b.textContent = last ? 'Ja, passt – fertig' : 'Ja, passt – nächstes Foto';
    return;
  }
  if (ui.view === 'photos') {
    if (!n) b.textContent = 'Fotos auswählen';
    else if (n < 2) { b.textContent = 'Mindestens 2 Fotos nötig'; b.disabled = true; }
    else b.textContent = project.aligned ? 'Weiter zur Vorschau' : 'Weiter: Bezugspunkte setzen';
  } else if (ui.view === 'points') {
    const k = project.anchors.length;
    b.textContent = k < 2 ? `Noch ${4 - k} Punkte setzen` : k < 4 ? `Ausrichten (besser ${4 - k} Punkt${4 - k === 1 ? '' : 'e'} mehr)` : `Alle ${n} Fotos ausrichten`;
    b.disabled = k < 2;
  } else if (ui.view === 'edit') b.textContent = 'Weiter: Zuschnitt';
  else b.textContent = ui.exp.format === 'zip' ? 'Einzelbilder exportieren' : ui.exp.format === 'gif' ? 'GIF erstellen' : 'Video erstellen';
}

$$('.step').forEach(b => b.onclick = () => !b.disabled && showView(b.dataset.view));

$('#primary').onclick = () => {
  if (cropUI.on) { showView('export'); return; }
  if (ui.review) { if (ui.review.mode === 'ask') reviewAccept(); return; }
  if (ui.view === 'photos') {
    if (!project.frames.length) $('#file').click();
    else if (project.aligned) showView('edit');
    else showView('points');
  } else if (ui.view === 'points') runAnchorAlign();
  else if (ui.view === 'edit') showView('crop');
  else doExport();
};

// ---------------------------------------------------------------- Fotos

$('#file').onchange = async e => {
  const files = [...e.target.files].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp|tiff?)$/i.test(f.name));
  e.target.value = '';
  if (files.length) await addFiles(files);
};

async function addFiles(files) {
  if (resumeOffered && !project.frames.length) { resumeOffered = false; $('#resume').hidden = true; try { await db.clearProject(); } catch { /* egal */ } }
  db.persist();
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
  scheduleSave(0);
  if (errors.length) toast(`${errors.length} Datei(en) konnten nicht gelesen werden.`, 4500);
  else if (project.frames.length >= 2) toast('Fotos bereit – weiter mit dem orangen Knopf.');
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

function removeFrames(ids, { keepAligned = false } = {}) {
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
  // Nach dem Ausrichten bleibt die Ausrichtung der übrigen Fotos gültig
  if (!keepAligned || project.included.length < 2 || !project.ref) project.aligned = false;
  renderGrid();
  updateSteps();
  if (db.available) {
    (project.frames.length ? db.removeFrames(ids).then(() => scheduleSave(0)) : db.clearProject()).catch(() => {});
  }
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
    if (!openReview()) toast(parts.length ? 'Fertig. ' + parts.join(' ') : 'Fertig – alle Fotos sauber ausgerichtet.', parts.length ? 6000 : 3500);
  } catch (err) {
    progress.close();
    console.error(err);
    toast('Fehler beim Ausrichten: ' + err.message, 6000);
  } finally {
    keepAwake(false);
  }
}

/** Hauptweg: Punkte einmal gesetzt -> alle Fotos danach ausrichten. */
async function runAnchorAlign() {
  if (project.anchors.length < 2) return;
  const n = project.frames.length;
  progress.open('Fotos werden ausgerichtet');
  await keepAwake(true);
  try {
    const res = await alignByAnchors(project, getAligner(), {
      isCancelled: () => progress.cancelled,
      onProgress: (d, t) => progress.set(d / t * 0.75, `Punkte suchen: Foto ${d} von ${t}`),
    });
    if (!res) { progress.close(); toast('Abgebrochen.'); return; }
    progress.set(0.75, 'Zuschnitt, Helligkeit und Farbe werden berechnet …');
    await refresh({ onProgress: (d, t) => progress.set(0.75 + 0.25 * d / t, `Helligkeit & Farbe messen: ${d} von ${t}`) });
    progress.close();
    updateSteps();
    if (!player) initPlayer();
    showView('edit');
    if (!openReview()) toast(`Alle ${n} Fotos ausgerichtet. Vorschau antippen für Vollbild.`, 4500);
  } catch (err) {
    progress.close();
    console.error(err);
    toast('Fehler beim Ausrichten: ' + err.message, 6000);
  } finally {
    keepAwake(false);
  }
}

// ---- Problemfotos: prüfen, korrigieren oder entfernen ----
function problemFrames() {
  return project.frames.filter(f => f.id !== project.refId && f.featRes > 0 && !f.manualChecked &&
    ((f.excluded && f.autoExcluded) || (!f.excluded && (f.quality === 'warn' || f.quality === 'bad'))));
}

function updateIssues() {
  const n = project.aligned ? problemFrames().length : 0;
  $('#issues').hidden = !n;
  $('#issues-text').textContent = `⚠ ${n} Foto${n === 1 ? '' : 's'} nicht sicher ausgerichtet`;
}
$('#issues-btn').onclick = () => openReview();

/** Zeigt das Prüf-Fenster, falls es Problemfotos gibt. Rückgabe: ob es angezeigt wurde. */
function openReview() {
  const list = problemFrames();
  if (!list.length) { $('#review').hidden = true; updateIssues(); return false; }
  const n = list.length;
  $('#review-title').textContent = `Fast fertig – ${n} Foto${n === 1 ? '' : 's'} prüfen`;
  $('#review-text').textContent = `Bei ${n === 1 ? 'diesem Foto' : 'diesen Fotos'} ist Lapse nicht ganz sicher. Oft passt es trotzdem: „Nacheinander ansehen“ zeigt jedes Foto – mit einem Tipp bestätigen, korrigieren oder entfernen.`;
  $('#review-start').textContent = n === 1 ? 'Foto ansehen' : `${n} Fotos nacheinander ansehen`;
  $('#review-list').innerHTML = list.map(f => `<li>
      <img src="${f.thumbUrl}" alt="">
      <div class="rn">${f.name}<small>${f.excluded ? 'Punkte nicht gefunden – derzeit nicht im Video' : 'unsicher ausgerichtet – bitte ansehen'}</small></div>
      <div class="rb"><button class="btn" data-fix="${f.id}">Ansehen</button><button class="btn ghost" data-rm="${f.id}">Entfernen</button></div>
    </li>`).join('');
  $('#review-remove-all').textContent = n === 1 ? 'Foto entfernen und weiter' : `Alle ${n} entfernen und weiter`;
  $('#review').hidden = false;
  return true;
}

function removeProblem(ids) {
  removeFrames(ids, { keepAligned: true });
  if (!project.aligned) { $('#review').hidden = true; showView('photos'); toast('Zu wenige Fotos übrig – bitte Fotos hinzufügen.', 5000); return; }
  scheduleRefresh(0);
  renderStrip();
}

$('#review-list').onclick = e => {
  const rm = e.target.closest('[data-rm]')?.dataset.rm, fix = e.target.closest('[data-fix]')?.dataset.fix;
  if (rm) {
    removeProblem([rm]);
    if (!openReview()) toast('Alles bereit – Vorschau antippen für Vollbild.');
  } else if (fix) startReview(fix);
};
$('#review-start').onclick = () => startReview();

// ---- Geführte Prüfung: ein Foto nach dem anderen, klares Ende ----
// Pro Foto nur eine Frage: „Sitzen die Ringe auf den Flocken?“ – Ja (weiter) oder
// 3 Flocken antippen (Reihenfolge egal, Zuordnung über die Abstände) oder entfernen.
function reviewRemaining() {
  const r = ui.review;
  return r ? r.ids.slice(r.i).filter(id => project.byId(id)).length : 0;
}
function startReview(startId) {
  const ids = startId && !problemFrames().some(f => f.id === startId) ? [startId] : problemFrames().map(f => f.id);
  if (!ids.length) return;
  $('#review').hidden = true;
  const i = Math.max(0, ids.indexOf(startId));
  ui.review = { ids, i, pos: i + 1, total: ids.length, mode: 'ask', taps: [], done: new Set() };
  if (ui.view !== 'edit') showView('edit');
  exitFullscreen();
  anc.on = true;
  document.body.classList.add('anchor-mode', 'review-mode');
  $('#view-edit').classList.add('anchor-mode');
  $('#panel-review').hidden = false;
  $('#anchor-layer').hidden = false;
  showReviewFrame();
}
function reviewFrame() { const r = ui.review; return r && project.byId(r.ids[r.i]); }
// Ganzes Bezugsfoto als Ausschnitt (kanonisch)
const refFullCrop = () => { const r = project.ref, m = Math.max(r.w, r.h); return { x: 0, y: 0, w: r.w / m, h: r.h / m }; };
async function showReviewFrame() {
  const f = reviewFrame();
  if (!f) return;
  const r = ui.review;
  // Prüfen: Foto ausgerichtet in Lage des Bezugsfotos; Antippen: Originalfoto
  if (r.mode === 'tap' || !f.align?.ok) { anc.frame = f; player.showRaw(f); }
  else { anc.frame = project.ref; player.showAligned(f, refFullCrop()); }
  layoutStage();
  renderReview();
  window.scrollTo({ top: 0 });
}
function renderReview() {
  const r = ui.review, f = reviewFrame();
  if (!r || !f) return;
  const m = Math.max(f.w, f.h);
  // Ringe: vermutete Lage der Bezugspunkte in diesem Foto (ohne Nummern)
  let html = '';
  if (r.mode === 'ask' && f.align?.ok) {
    // ausgerichtete Ansicht: Ringe an den festen Bezugspositionen
    const ref = project.ref, rm = Math.max(ref.w, ref.h);
    html = project.anchors.map(a => `<div class="ring" style="left:${a.x * rm / ref.w * 100}%;top:${a.y * rm / ref.h * 100}%"></div>`).join('');
  }
  html += r.taps.map(t => `<div class="tapdot" style="left:${t.x * m / f.w * 100}%;top:${t.y * m / f.h * 100}%"></div>`).join('');
  $('#anchor-layer').innerHTML = html;
  // Bezugsfoto mit Ringen
  const ref = project.ref, rm = Math.max(ref.w, ref.h), mini = $('#rv-mini');
  mini.style.aspectRatio = `${ref.w} / ${ref.h}`;
  mini.innerHTML = `<img src="${ref.thumbUrl}" alt="">` + project.anchors.map(a => `<span class="mini-ring" style="left:${a.x * rm / ref.w * 100}%;top:${a.y * rm / ref.h * 100}%"></span>`).join('');
  $('#rv-title').textContent = `Foto ${r.pos} von ${r.total}`;
  $('#rv-name').textContent = f.name;
  $('#rv-dots').innerHTML = r.ids.map((id, k) => `<i class="${k === r.i ? 'cur' : r.done.has(id) ? 'done' : ''}"></i>`).join('');
  $('#rv-q').textContent = r.busy ? 'Einen Moment – das Foto wird ausgerichtet …'
    : r.mode === 'tap' ? `Tippe im Foto auf 3 der markierten Haferflocken – die Reihenfolge ist egal. (${r.taps.length} von 3)`
    : !f.align?.ok ? 'Lapse hat die Flocken hier nicht gefunden. Tippe 3 der markierten Haferflocken an – oder entferne das Foto.'
    : 'Liegen die Haferflocken in den orangen Ringen – genau wie im Bezugsfoto? Zum Vergleich „Bezugsfoto zeigen“ gedrückt halten.';
  $('#rv-retap').textContent = r.mode === 'tap' ? 'Antippen abbrechen' : 'Nein – Flocken antippen';
  $('#rv-retap').disabled = !!r.busy;
  $('#rv-hold').hidden = r.mode !== 'ask' || !f.align?.ok;
  if (r.mode === 'ask' && !f.align?.ok) { r.mode = 'tap'; showReviewFrame(); return; }
  updatePrimary();
}
function reviewGoto(step) {
  const r = ui.review;
  r.i += step;
  while (r.i < r.ids.length && !project.byId(r.ids[r.i])) r.i++;
  if (r.i >= r.ids.length) { endReview(true); return; }
  r.pos = Math.min(r.total, r.i + 1);
  r.mode = 'ask'; r.taps = [];
  showReviewFrame();
}
/** „Ja, passt“: Foto als geprüft markieren und zum nächsten */
function reviewAccept() {
  const f = reviewFrame();
  if (f) {
    f.manualChecked = true;
    if (f.excluded && f.align?.ok) { f.excluded = false; f.autoExcluded = false; }
    ui.review.done.add(f.id);
  }
  scheduleSave();
  reviewGoto(1);
}
function endReview(done) {
  ui.review = null;
  anc.on = false;
  document.body.classList.remove('anchor-mode', 'review-mode');
  $('#view-edit').classList.remove('anchor-mode');
  $('#panel-review').hidden = true;
  $('#anchor-layer').hidden = true;
  $('#anchor-layer').innerHTML = '';
  setTab(ui.tab);
  player?.stopInspect();
  layoutStage();
  renderStrip();
  scheduleRefresh(0);
  updatePrimary();
  if (done) toast('Alle Fotos geprüft ✓ – Vorschau antippen für Vollbild.', 4000);
}
// Tippen ins Foto: Flocke markieren; nach 3 Tipps automatisch ausrichten
async function reviewTap(e) {
  const r = ui.review, f = reviewFrame();
  if (!r || !f || r.busy) return;
  const rect = $('#anchor-layer').getBoundingClientRect(), m = Math.max(f.w, f.h);
  const x = (e.clientX - rect.left) / rect.width * f.w / m, y = (e.clientY - rect.top) / rect.height * f.h / m;
  if (r.mode === 'ask') { r.mode = 'tap'; r.taps = []; showReviewFrame(); return; } // erst Original zeigen, dann tippen
  r.taps.push({ x, y });
  renderReview();
  if (r.taps.length < 3) return;
  r.busy = true; renderReview();
  try {
    const res = await correctByTaps(project, getAligner(), f, r.taps);
    r.busy = false; r.taps = [];
    if (res.ok) { r.mode = 'ask'; project.assessQuality(); showReviewFrame(); toast('Neu ausgerichtet – bitte kurz prüfen.', 2500); }
    else toast(res.reason === 'ambiguous' ? 'Nicht eindeutig – bitte 3 Flocken antippen, die weiter auseinander liegen.' : 'Diese 3 Stellen passen nicht zu den markierten Flocken – bitte nochmal antippen.', 4500);
  } catch (err) { r.busy = false; r.taps = []; toast('Fehler: ' + err.message, 5000); }
  renderReview();
}
$('#rv-retap').onclick = () => {
  const r = ui.review;
  if (!r) return;
  r.mode = r.mode === 'tap' && reviewFrame()?.align?.ok ? 'ask' : 'tap';
  r.taps = [];
  showReviewFrame();
};
// Bezugsfoto zum Vergleich einblenden, solange gedrückt
const holdBtn = $('#rv-hold');
const holdOn = e => { e.preventDefault(); if (!ui.review) return; holdBtn.classList.add('on'); player.showAligned(project.ref, refFullCrop()); };
const holdOff = () => { if (!ui.review) return; holdBtn.classList.remove('on'); const f = reviewFrame(); if (f && ui.review.mode === 'ask') player.showAligned(f, refFullCrop()); };
holdBtn.addEventListener('pointerdown', holdOn);
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) holdBtn.addEventListener(ev, holdOff);
holdBtn.addEventListener('contextmenu', e => e.preventDefault());
$('#rv-remove').onclick = () => {
  const f = reviewFrame();
  if (!f || f.id === project.refId) return;
  removeProblem([f.id]);
  toast(`„${f.name}“ entfernt.`);
  reviewGoto(1);
};
$('#rv-quit').onclick = () => endReview(false);
$('#review-remove-all').onclick = () => {
  const ids = problemFrames().map(f => f.id);
  $('#review').hidden = true;
  removeProblem(ids);
  toast(`${ids.length} Foto${ids.length === 1 ? '' : 's'} entfernt – Vorschau antippen für Vollbild.`, 4000);
};
$('#review-continue').onclick = () => { $('#review').hidden = true; updateIssues(); };

// Aus der Punkt-Korrektur heraus entfernen
$('#anc-remove').onclick = () => {
  const f = anc.frame;
  if (!f || f.id === project.refId) return;
  removeProblem([f.id]);
  toast(`„${f.name}“ entfernt.`);
  if (ui.review) { ui.review.total = Math.max(1, ui.review.total); reviewGoto(1); return; }
  closeAnchors();
};

// ---- Eigener Bildausschnitt ----
// Rahmen im Bezugsfoto verschieben/aufziehen; bleibt im Bereich, den alle Fotos abdecken.
const cropUI = { on: false, rect: null, key: 'frei', drag: null, quads: null };
const CROP_ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4 };

function openCrop() {
  if (!project.crop || !player || cropUI.on) return;
  exitFullscreen();
  player.pause();
  const c = project.crop;
  cropUI.on = true;
  cropUI.rect = { x: c.x, y: c.y, w: c.w, h: c.h };
  cropUI.orig = project.customCrop ? { ...project.customCrop } : null;
  cropUI.auto = !project.customCrop;
  cropUI.key = project.customCrop?.key || 'frei';
  cropUI.quads = project.validQuads();
  cropUI.area = null;
  anc.on = true; anc.frame = project.ref;   // ganzes Bezugsfoto anzeigen
  document.body.classList.add('anchor-mode', 'crop-mode');
  $('#view-edit').classList.add('anchor-mode');
  $('#panel-crop').hidden = false;
  $('#crop-layer').hidden = false;
  player.showRaw(project.ref);
  layoutStage();
  renderCrop();
  updateScaleUI();
  updateRoiUI();
  updatePrimary();
  window.scrollTo({ top: 0 });
}

function closeCrop(apply, { silent = false } = {}) {
  if (!cropUI.on) return;
  stopCropPlay();
  if (ed.open) closeEditor(false);
  if (scl.edit) { scl.edit = false; document.body.classList.remove('scale-mode'); }
  if (apply && cropUI.rect) {
    project.customCrop = cropUI.auto ? null : { ...cropUI.rect, key: cropUI.key };
    if (!silent) toast(cropUI.auto ? 'Automatischer Ausschnitt.' : 'Eigener Bildausschnitt übernommen.');
  } else project.customCrop = cropUI.orig;
  cropUI.on = false;
  anc.on = false;
  document.body.classList.remove('anchor-mode', 'crop-mode');
  $('#view-edit').classList.remove('anchor-mode');
  $('#panel-crop').hidden = true;
  $('#crop-layer').hidden = true;
  setTab(ui.tab);
  player?.stopInspect();
  project.computeCrop();
  layoutStage();
  updatePrimary();
  updateCropState();
  scheduleRefresh(0);
  scheduleSave();
}

function updateCropState() {
  const auto = cropUI.on ? cropUI.auto : !project.customCrop, key = cropUI.on ? cropUI.key : project.customCrop?.key;
  const t = auto ? 'automatisch (größtmöglich)' : `eigener Ausschnitt${key && key !== 'frei' ? ' · ' + key : ''}`;
  $('#crop-state').textContent = t;
  if ($('#crop-summary')) $('#crop-summary').textContent = t.charAt(0).toUpperCase() + t.slice(1);
}

function renderCrop() {
  const ref = project.ref, m = Math.max(ref.w, ref.h), rw = ref.w / m, rh = ref.h / m, r = cropUI.rect;
  // randfreier Bereich = Schnittmenge aller Foto-Umrisse (eine Linie), außerhalb stark abgedunkelt
  const area = cropUI.area || (cropUI.area = intersectAll(cropUI.quads, [[0, 0], [rw, 0], [rw, rh], [0, rh]]));
  const areaPath = area.length ? `M${area.map(p => p.join(' ')).join('L')}Z` : '';
  const hs = 0.035 * Math.max(rw, rh);
  const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
  const svg = `<svg viewBox="0 0 ${rw} ${rh}" preserveAspectRatio="none">
    <path d="M0 0H${rw}V${rh}H0Z ${areaPath}" fill="rgba(0,0,0,.6)" fill-rule="evenodd"/>
    <path d="${areaPath} M${r.x} ${r.y}V${r.y + r.h}H${r.x + r.w}V${r.y}Z" fill="rgba(0,0,0,.35)" fill-rule="evenodd"/>
    <path d="${areaPath}" fill="none" stroke="rgba(255,255,255,.8)" stroke-width="${0.004 * rw}" stroke-dasharray="${0.012 * rw} ${0.008 * rw}"/>
    <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#f3c08a" stroke-width="${0.006 * rw}"/>
    <path d="M${r.x + r.w / 3} ${r.y}V${r.y + r.h}M${r.x + 2 * r.w / 3} ${r.y}V${r.y + r.h}M${r.x} ${r.y + r.h / 3}H${r.x + r.w}M${r.x} ${r.y + 2 * r.h / 3}H${r.x + r.w}" stroke="rgba(255,255,255,.35)" stroke-width="${0.002 * rw}"/>
    ${corners.map(([x, y]) => `<rect x="${x - hs / 2}" y="${y - hs / 2}" width="${hs}" height="${hs}" rx="${hs / 4}" fill="#f3c08a" stroke="#000" stroke-width="${0.002 * rw}"/>`).join('')}
  ${scaleSvg(rw)}${pageRoiSvg(rw)}</svg>`;
  if (!(ed.open && (cropUI.drag || scl.drag))) $('#crop-layer').innerHTML = svg + '<span class="crop-tap">✎ Antippen zum Bearbeiten</span>';
  if (ed.open) $('#ed-svg').innerHTML = ed.mode === 'roi' ? roiSvg(rw, rh) : svg;
  $$('#crop-aspect button, #ed-aspect button').forEach(b => b.classList.toggle('on', b.dataset.v === cropUI.key));
  updateCropState();
}

// ---- Vollbild-Editor für Zuschnitt und Maßstab
const ed = { open: false, mode: 'crop', url: null, img: null, saved: null };

function openEditor(mode) {
  if (!cropUI.on) return;
  stopCropPlay();
  ed.mode = mode;
  ed.saved = { rect: { ...cropUI.rect }, key: cropUI.key, auto: cropUI.auto };
  const ref = project.ref;
  if (ed.url) URL.revokeObjectURL(ed.url);
  ed.url = URL.createObjectURL(ref.previewBlob);
  const img = $('#ed-img');
  img.onload = () => { ed.img = img; edLayout(); };
  img.src = ed.url;
  ed.open = true;
  $('#ed-done').disabled = false;
  $('#ed').hidden = false;
  document.body.classList.add('ed-open');
  $('#ed-title').textContent = mode === 'scale' ? 'Maßstab kalibrieren' : mode === 'roi' ? 'Region of Interest' : 'Bildausschnitt';
  $('#ed-crop').hidden = mode !== 'crop';
  $('#ed-scale').hidden = mode !== 'scale';
  $('#ed-roi').hidden = mode !== 'roi';
  if (mode === 'roi') {
    const c = cropUI.rect, r = project.settings.roi;
    ed.roi = r ? { ...r } : { x: c.x + c.w * 0.35, y: c.y + c.h * 0.35, w: c.w * 0.3, h: c.h * 0.3 };
    setRoiRect(ed.roi);
  }
  $('#ed-hint').textContent = mode === 'scale'
    ? 'Zwei Punkte mit bekanntem Abstand antippen – am besten gegenüberliegende Außenkanten der Schale. Zum Feinjustieren den Punkt mit dem Finger ziehen (Lupe).'
    : mode === 'roi'
      ? 'Region aufziehen, verschieben oder an Ecken/Kanten ziehen. Sie wird im Video weiß umrahmt und in einer Ecke vergrößert gezeigt.'
      : 'Rahmen verschieben, an Ecken oder Kanten ziehen – oder außerhalb des Rahmens einen neuen aufziehen. Der helle Bereich enthält in allen Fotos Bildinhalt.';
  edLayout();
  renderCrop(); updateScaleUI();
}

function closeEditor(apply) {
  if (!ed.open) return;
  if (ed.mode === 'scale') {
    if (apply && !applyScale()) return;
    scl.edit = false; scl.drag = null;
  } else if (ed.mode === 'roi') {
    if (apply) {
      project.settings.roi = { ...ed.roi }; project.settings.roiOn = true;
      log(`Region of Interest gesetzt: ${['x', 'y', 'w', 'h'].map(k => ed.roi[k].toFixed(3)).join(' ')}`, 'ok');
      scheduleSave(); player?.render();
    }
  } else if (!apply && ed.saved) {
    cropUI.rect = ed.saved.rect; cropUI.key = ed.saved.key; cropUI.auto = ed.saved.auto;
  }
  ed.open = false;
  $('#ed').hidden = true;
  $('#ed-loupe').hidden = true;
  document.body.classList.remove('ed-open');
  renderCrop(); updateScaleUI(); updateRoiUI();
}

/** Bild im verfügbaren Platz einpassen (Seitenverhältnis des Bezugsfotos). */
function edLayout() {
  if (!ed.open) return;
  const v = $('#ed-view'), ref = project.ref, a = ref.w / ref.h;
  const W = v.clientWidth - 16, H = v.clientHeight - 16;
  let w = W, h = w / a;
  if (h > H) { h = H; w = h * a; }
  Object.assign($('#ed-box').style, { width: Math.floor(w) + 'px', height: Math.floor(h) + 'px' });
}
window.addEventListener('resize', edLayout);

/** Lupe über dem Finger: vergrößerter Ausschnitt mit Fadenkreuz am Punkt (x, y kanonisch). */
function showLoupe(cx, cy, x, y) {
  const img = ed.img, c = $('#ed-loupe');
  if (!img || !img.naturalWidth) return;
  const ctx = c.getContext('2d'), S = c.width, m = Math.max(img.naturalWidth, img.naturalHeight);
  const box = $('#ed-box').getBoundingClientRect(), zoom = 3.5;
  const srcPerCss = img.naturalWidth / box.width, half = S / 2 / zoom * srcPerCss / (S / 132);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x * m - half, y * m - half, half * 2, half * 2, 0, 0, S, S);
  ctx.strokeStyle = 'rgba(127,211,230,.95)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(S / 2, S * 0.2); ctx.lineTo(S / 2, S * 0.42); ctx.moveTo(S / 2, S * 0.58); ctx.lineTo(S / 2, S * 0.8);
  ctx.moveTo(S * 0.2, S / 2); ctx.lineTo(S * 0.42, S / 2); ctx.moveTo(S * 0.58, S / 2); ctx.lineTo(S * 0.8, S / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(S / 2, S / 2, 3, 0, Math.PI * 2); ctx.fillStyle = 'rgba(127,211,230,.95)'; ctx.fill();
  // oberhalb des Fingers, am Rand nach unten ausweichen
  const top = cy - 132 - 46 < 8 ? cy + 46 : cy - 132 - 46;
  Object.assign(c.style, { left: Math.max(8, Math.min(innerWidth - 140, cx - 66)) + 'px', top: top + 'px' });
  c.hidden = false;
}

$('#ed-cancel').onclick = () => closeEditor(false);
$('#ed-done').onclick = () => closeEditor(true);
$('#crop-layer').addEventListener('click', () => openEditor('crop'));
$('#crop-edit').onclick = () => openEditor('crop');
$('#ed-aspect').addEventListener('click', e => { const b = e.target.closest('button'); if (b) $(`#crop-aspect button[data-v="${b.dataset.v}"]`)?.click(); });
$('#ed-auto').onclick = () => $('#crop-auto').click();

// ---- Region of Interest (vergrößerte Darstellung in einer Ecke)
const edRect = () => (ed.open && ed.mode === 'roi' ? ed.roi : cropUI.rect);

/** Region übernehmen, aber innerhalb des Bildausschnitts halten. */
function setRoiRect(c) {
  const C = cropUI.rect, min = 0.04 * Math.min(C.w, C.h);
  const w = Math.max(min, Math.min(c.w, C.w)), h = Math.max(min, Math.min(c.h, C.h));
  ed.roi = { x: Math.min(Math.max(c.x, C.x), C.x + C.w - w), y: Math.min(Math.max(c.y, C.y), C.y + C.h - h), w, h };
  updateRoiInfo();
}

function updateRoiInfo() {
  if (!ed.open || ed.mode !== 'roi') return;
  const C = cropUI.rect, r = ed.roi, k = mmPerUnit(project);
  const size = k ? ` · ${fmtLength(r.w * k)} × ${fmtLength(r.h * k)}` : '';
  const ins = (project.settings.insetSize || 0.38) / (r.w / C.w);
  $('#roi-info').textContent = `Region ${Math.round(r.w / C.w * 100)} × ${Math.round(r.h / C.h * 100)} % des Ausschnitts${size} → im Video ca. ${String(+Math.max(1, ins).toFixed(1)).replace('.', ',')}× vergrößert`;
}

/** Editor-Darstellung im Modus „roi“: Ausschnitt hell, Region weiß mit Griffen. */
function roiSvg(rw, rh) {
  const C = cropUI.rect, r = ed.roi, hs = 0.03 * Math.max(rw, rh), lw = 0.004 * rw;
  const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
  return `<svg viewBox="0 0 ${rw} ${rh}" preserveAspectRatio="none">
    <path d="M0 0H${rw}V${rh}H0Z M${C.x} ${C.y}V${C.y + C.h}H${C.x + C.w}V${C.y}Z" fill="rgba(0,0,0,.68)" fill-rule="evenodd"/>
    <path d="M${C.x} ${C.y}V${C.y + C.h}H${C.x + C.w}V${C.y}Z M${r.x} ${r.y}V${r.y + r.h}H${r.x + r.w}V${r.y}Z" fill="rgba(0,0,0,.3)" fill-rule="evenodd"/>
    <rect x="${C.x}" y="${C.y}" width="${C.w}" height="${C.h}" fill="none" stroke="rgba(243,192,138,.7)" stroke-width="${lw}" stroke-dasharray="${lw * 3} ${lw * 2}"/>
    <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#fff" stroke-width="${lw * 1.2}"/>
    ${corners.map(([x, y]) => `<rect x="${x - hs / 2}" y="${y - hs / 2}" width="${hs}" height="${hs}" rx="${hs / 4}" fill="#fff" stroke="#000" stroke-width="${lw * 0.5}"/>`).join('')}
  </svg>`;
}

/** Auf der Seite: gewählte Region dezent zeigen (wenn eingeschaltet). */
function pageRoiSvg(rw) {
  const st = project.settings, eff = st.roiOn && st.roi ? effectiveRoi(project, cropUI.rect) : null, r = eff?.frame;
  if (!r || (ed.open && ed.mode === 'roi')) return '';
  return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="${0.004 * rw}"/>`;
}

function updateRoiUI() {
  const st = project.settings, has = !!st.roi;
  $('#roi-on').checked = !!st.roiOn && has;
  $('#roi-edit').textContent = has ? '⌖ Region ändern' : '⌖ Region wählen';
  $('.roi-opts').classList.toggle('dim', !(st.roiOn && has));
  $$('#inset-pos button').forEach(b => b.classList.toggle('on', b.dataset.v === (st.insetPos || 'tr')));
  $$('#inset-size button').forEach(b => b.classList.toggle('on', Math.abs(+b.dataset.v - (st.insetSize || 0.38)) < 1e-6));
  const k = mmPerUnit(project), eff = st.roiOn && has ? effectiveRoi(project, cropUI.on ? cropUI.rect : project.crop) : null;
  const zf = z => String(+z.toFixed(1)).replace('.', ',') + '×';
  $('#roi-state').classList.toggle('off', !eff);
  $('#roi-state').textContent = eff ? (k ? `${fmtLength(eff.frame.w * k)} × ${fmtLength(eff.frame.h * k)} · ` : '') + zf(eff.zoom) : 'aus';
  $('.roi-zoom').classList.toggle('dim', !eff);
  const Z = zoomList(), r = $('#roi-zoom'), cur = eff ? eff.zoom : 2;
  r.max = Z.length - 1;
  r.value = Z.reduce((bi, v, i) => (Math.abs(Math.log(v / cur)) < Math.abs(Math.log(Z[bi] / cur)) ? i : bi), 0);
  $('#roi-zoom-out').textContent = eff ? zf(eff.zoom) + (st.insetZoom > 0 ? '' : ' (auto)') : '–';
  $$('#roi-zoom-chips button').forEach(b => b.classList.toggle('on', +b.dataset.z === (st.insetZoom > 0 ? st.insetZoom : 0)));
}
function zoomList() { return [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8]; }
function setRoiZoom(z) { project.settings.insetZoom = z; roiChanged(); }
$('#roi-zoom').addEventListener('input', e => setRoiZoom(zoomList()[+e.target.value]));
$('#roi-zoom-chips').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setRoiZoom(+b.dataset.z); });
function roiChanged() { updateRoiUI(); renderCrop(); player?.render(); scheduleSave(); }
$('#roi-on').onchange = e => {
  if (e.target.checked && !project.settings.roi) { e.target.checked = false; openEditor('roi'); return; }
  project.settings.roiOn = e.target.checked; roiChanged();
};
$('#roi-edit').onclick = () => { stopCropPlay(); openEditor('roi'); };
$('#inset-pos').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; project.settings.insetPos = b.dataset.v; roiChanged(); });
$('#inset-size').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; project.settings.insetSize = +b.dataset.v; roiChanged(); });

// ---- Video im Zuschnitt-Schritt abspielen (mit Zuschnitt, Region of Interest und Einblendungen)
let cropPlaying = false;
function startCropPlay() {
  if (!cropUI.on || cropPlaying) return;
  // aktuellen Rahmen schon für die Wiedergabe übernehmen
  project.customCrop = cropUI.auto ? null : { ...cropUI.rect, key: cropUI.key };
  project.computeCrop();
  cropPlaying = true;
  anc.on = false;
  $('#crop-layer').hidden = true;
  $('#crop-play').classList.add('on');
  $('#crop-play').textContent = '■ Stopp';
  player.invalidate();
  layoutStage();
  player.stopInspect();
  player.play();
}
function stopCropPlay() {
  if (!cropPlaying) return;
  cropPlaying = false;
  player.pause();
  $('#crop-play').classList.remove('on');
  $('#crop-play').textContent = '▶ Video abspielen';
  if (!cropUI.on) return;
  anc.on = true; anc.frame = project.ref;
  $('#crop-layer').hidden = false;
  player.showRaw(project.ref);
  layoutStage();
  renderCrop();
}
$('#crop-play').onclick = () => (cropPlaying ? stopCropPlay() : startCropPlay());
$('#preview').addEventListener('click', () => { if (cropPlaying) stopCropPlay(); });

// ---- Maßstab: Kalibrierung im Bezugsfoto, Balken im Video
const scl = { edit: false, pts: [], mm: 90, drag: null };

/** SVG-Elemente: Messstrecke (beim Kalibrieren) und Vorschau des Balkens im gewählten Ausschnitt. */
function scaleSvg(rw) {
  let out = '';
  const lw = 0.004 * rw, rr = 0.014 * rw, fs = 0.032 * rw;
  const pts = scl.edit ? scl.pts : []; // Messstrecke nur beim Kalibrieren zeigen
  if (pts.length) {
    const col = scl.edit ? '#7fd3e6' : 'rgba(127,211,230,.55)';
    if (pts.length === 2) {
      const [a, b] = pts, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      out += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${col}" stroke-width="${lw}" stroke-dasharray="${lw * 3} ${lw * 2}"/>`;
      const mm = scl.edit ? scl.mm : project.scale.mm;
      if (mm > 0) out += `<text x="${mx}" y="${my - fs * 0.6}" fill="#fff" stroke="#000" stroke-width="${lw * 0.8}" paint-order="stroke" font-size="${fs}" font-family="ui-monospace,Menlo,monospace" text-anchor="middle">${fmtLength(mm)}</text>`;
    }
    for (const p of pts) out += `<circle cx="${p.x}" cy="${p.y}" r="${rr}" fill="rgba(127,211,230,.18)" stroke="${col}" stroke-width="${lw}"/><circle cx="${p.x}" cy="${p.y}" r="${lw}" fill="${col}"/>`;
  }
  // Vorschau der Einblendungen im Rahmen – exakt wie im Video
  const r = cropUI.rect;
  if (r) {
    const tmp = scl.edit && scl.pts.length === 2 && scl.mm > 0
      ? { settings: project.settings, refId: project.refId, scale: { p1: scl.pts[0], p2: scl.pts[1], mm: scl.mm, refId: project.refId } }
      : project;
    const W = 720, H = Math.max(2, Math.round(W * r.h / r.w)), sig = overlaySig(tmp, W, H, r);
    if (sig !== 'none' && !(cropUI.drag && scaleSvg.url)) {
      if (scaleSvg.sig !== sig) { scaleSvg.sig = sig; scaleSvg.url = makeOverlay(tmp, W, H, r)?.toDataURL('image/png') || ''; }
      if (scaleSvg.url) out += `<image href="${scaleSvg.url}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" preserveAspectRatio="none"/>`;
    }
  }
  return out;
}

function updateScaleUI() {
  const k = mmPerUnit(project), ref = project.ref, m = ref ? Math.max(ref.w, ref.h) : 1;
  const st = $('#scale-state');
  st.classList.toggle('off', !k);
  st.textContent = k ? `kalibriert · ${fmtLength(project.scale.mm)} · ${(k / m * 1000).toFixed(1).replace('.', ',')} µm/px` : 'nicht kalibriert';
  const so = project.settings, barOn = !!so.scaleBar && so.scaleBar !== 'off';
  $$('#scale-pos button').forEach(b => b.classList.toggle('on', b.dataset.v === (barOn ? so.scaleBar : so.scalePos || 'bl')));
  $('#scale-pos').classList.toggle('dim', !barOn);
  $('#sb-on').checked = barOn; $('#ruler-on').checked = !!so.ruler;
  syncExportScale();
  $('#scale-cal').textContent = k ? '📏 Neu kalibrieren' : '📏 Maßstab kalibrieren';
  $('#scale-clear').hidden = !k;
  document.body.classList.toggle('scale-mode', scl.edit);
  if (scl.edit) {
    $$('#scale-chips button').forEach(b => b.classList.toggle('on', +b.dataset.mm === scl.mm));
    if (document.activeElement !== $('#scale-mm')) $('#scale-mm').value = scl.mm || '';
    const n = scl.pts.length;
    if (n < 2) $('#scale-info').textContent = n ? 'Jetzt den zweiten Punkt antippen.' : 'Ersten Punkt im Foto antippen.';
    else {
      const px = Math.hypot(scl.pts[1].x - scl.pts[0].x, scl.pts[1].y - scl.pts[0].y) * m;
      $('#scale-info').textContent = `Strecke ${Math.round(px)} px im Original → ${scl.mm > 0 ? (scl.mm / px * 1000).toFixed(1).replace('.', ',') + ' µm pro Pixel' : 'Abstand eingeben'}`;
    }
    if (ed.open && ed.mode === 'scale') $('#ed-done').disabled = n < 2 || !(scl.mm > 0);
  }
}

function setScaleEdit(on) {
  scl.edit = on; scl.drag = null;
  if (on) {
    const cur = mmPerUnit(project) ? project.scale : null;
    scl.pts = cur ? [{ ...cur.p1 }, { ...cur.p2 }] : [];
    scl.mm = cur ? cur.mm : (scl.mm || 90);
    openEditor('scale');
    return;
  }
  if (ed.open && ed.mode === 'scale') closeEditor(false);
  renderCrop(); updateScaleUI();
}
$('#scale-cal').onclick = () => setScaleEdit(true);
$('#scale-chips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; scl.mm = +b.dataset.mm; renderCrop(); updateScaleUI(); });
$('#scale-mm').oninput = e => { scl.mm = parseFloat(String(e.target.value).replace(',', '.')) || 0; renderCrop(); updateScaleUI(); };
/** Kalibrierung übernehmen (Fertig im Editor). Rückgabe false = noch unvollständig. */
function applyScale() {
  if (scl.pts.length < 2 || !(scl.mm > 0)) { toast(scl.pts.length < 2 ? 'Bitte zwei Punkte setzen.' : 'Bitte den Abstand in mm angeben.'); return false; }
  project.scale = { p1: scl.pts[0], p2: scl.pts[1], mm: scl.mm, refId: project.refId };
  if ((!project.settings.scaleBar || project.settings.scaleBar === 'off') && !project.settings.ruler) project.settings.scaleBar = project.settings.scalePos || 'bl';
  log(`Maßstab kalibriert: ${fmtLength(scl.mm)} · ${(mmPerUnit(project) / Math.max(project.ref.w, project.ref.h) * 1000).toFixed(2)} µm/px`, 'ok');
  scheduleSave();
  toast('Maßstab übernommen – erscheint in Vorschau und Export.');
  return true;
}
$('#scale-clear').onclick = () => {
  if (!confirm('Maßstab entfernen? Balken und Lineal werden ausgeblendet.')) return;
  project.scale = null; project.settings.scaleBar = 'off'; project.settings.ruler = false;
  setScaleEdit(false); scheduleSave();
};
$('#scale-pos').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  project.settings.scalePos = b.dataset.v;
  project.settings.scaleBar = b.dataset.v;
  scaleChanged();
});

/** Balken und Lineal ein-/ausschalten (Zuschnitt und Export teilen sich die Einstellung). */
function setOverlayOpt(kind, on) {
  const st = project.settings;
  if (kind === 'bar') st.scaleBar = on ? (st.scalePos || 'bl') : 'off';
  else st.ruler = on;
  if (on && !mmPerUnit(project)) {
    if (cropUI.on) setScaleEdit(true);
    else { toast('Erst kalibrieren: Schritt 04 Zuschnitt › Maßstab.', 3500); }
  }
  scaleChanged();
}
function scaleChanged() {
  if (cropUI.on) { renderCrop(); updateScaleUI(); } else syncExportScale();
  player?.render();
  scheduleSave();
}
function syncExportScale() {
  const st = project.settings, k = !!mmPerUnit(project);
  $('#sb-on2').checked = k && !!st.scaleBar && st.scaleBar !== 'off';
  $('#ruler-on2').checked = k && !!st.ruler;
  $('#sb-on2').disabled = $('#ruler-on2').disabled = !k;
  $('#exp-scale-help').textContent = k ? `Kalibriert: ${fmtLength(project.scale.mm)}. Erscheint im Video.` : 'Noch nicht kalibriert – in Schritt 04 Zuschnitt unter „Maßstab“.';
}
$('#sb-on').onchange = e => setOverlayOpt('bar', e.target.checked);
$('#ruler-on').onchange = e => setOverlayOpt('ruler', e.target.checked);
$('#sb-on2').onchange = e => setOverlayOpt('bar', e.target.checked);
$('#ruler-on2').onchange = e => setOverlayOpt('ruler', e.target.checked);

/** Schnittmenge konvexer Polygone (Sutherland-Hodgman). */
function intersectAll(quads, start) {
  let poly = start;
  for (const q of quads) {
    let area = 0;
    for (let i = 0; i < q.length; i++) { const [a, b] = q[i], [c, d] = q[(i + 1) % q.length]; area += a * d - c * b; }
    const sg = area >= 0 ? 1 : -1;
    for (let i = 0; i < q.length && poly.length; i++) {
      const [ax, ay] = q[i], [bx, by] = q[(i + 1) % q.length];
      const side = ([x, y]) => ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) * sg;
      const out = [];
      for (let j = 0; j < poly.length; j++) {
        const P = poly[j], Q = poly[(j + 1) % poly.length], sp = side(P), sq = side(Q);
        if (sp >= 0) out.push(P);
        if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
      }
      poly = out;
    }
  }
  return poly;
}

/** Rahmen übernehmen, aber nie über den randfreien Bereich hinaus („stößt an“). */
function setCropRect(cand) {
  if (cand.w < 0.06 || cand.h < 0.06) return;
  cropUI.auto = false;
  if (Project.rectInside(cropUI.quads, cand)) { cropUI.rect = cand; return; }
  const a = cropUI.rect;
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) {
    const t = (lo + hi) / 2;
    const r = { x: a.x + (cand.x - a.x) * t, y: a.y + (cand.y - a.y) * t, w: a.w + (cand.w - a.w) * t, h: a.h + (cand.h - a.h) * t };
    if (Project.rectInside(cropUI.quads, r)) lo = t; else hi = t;
  }
  cropUI.rect = { x: a.x + (cand.x - a.x) * lo, y: a.y + (cand.y - a.y) * lo, w: a.w + (cand.w - a.w) * lo, h: a.h + (cand.h - a.h) * lo };
}

const cropLayer = $('#ed-svg');   // Ziehen/Antippen nur im Vollbild-Editor (groß, ohne Scrollen)
cropLayer.addEventListener('pointerdown', e => {
  if (!cropUI.on) return;
  const ref = project.ref, m = Math.max(ref.w, ref.h), rect = cropLayer.getBoundingClientRect();
  const sx = rect.width / (ref.w / m);   // Bildschirmpunkte je kanonische Einheit
  const x = (e.clientX - rect.left) / sx, y = (e.clientY - rect.top) / sx, r = edRect();
  if (scl.edit) {
    // Maßstab: Punkt setzen, nächstgelegenen Punkt greifen oder (bei 2 Punkten) den näheren versetzen
    let k = scl.pts.findIndex(p => Math.hypot(p.x - x, p.y - y) < 34 / sx);
    if (k < 0) {
      if (scl.pts.length < 2) { scl.pts.push({ x, y }); k = scl.pts.length - 1; }
      else { k = Math.hypot(scl.pts[0].x - x, scl.pts[0].y - y) < Math.hypot(scl.pts[1].x - x, scl.pts[1].y - y) ? 0 : 1; scl.pts[k] = { x, y }; }
    }
    scl.drag = { k, sx, rect };
    cropLayer.setPointerCapture(e.pointerId);
    renderCrop(); updateScaleUI();
    showLoupe(e.clientX, e.clientY, scl.pts[k].x, scl.pts[k].y);
    return;
  }
  // Was wurde gegriffen? Ecke > Kante > Innenfläche; außerhalb: neuen Rahmen aufziehen
  const tol = 28 / sx;
  const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
  let corner = -1, best = tol;
  corners.forEach(([cx, cy], k) => { const d = Math.hypot(cx - x, cy - y); if (d < best) { best = d; corner = k; } });
  const inY = y > r.y - tol && y < r.y + r.h + tol, inX = x > r.x - tol && x < r.x + r.w + tol;
  let edge = null;
  if (corner < 0) {
    if (inY && Math.abs(x - r.x) < tol) edge = 'l';
    else if (inY && Math.abs(x - r.x - r.w) < tol) edge = 'r';
    else if (inX && Math.abs(y - r.y) < tol) edge = 't';
    else if (inX && Math.abs(y - r.y - r.h) < tol) edge = 'b';
  }
  const inside = x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;
  const mode = corner >= 0 ? 'corner' : edge ? 'edge' : inside ? 'move' : 'new';
  cropUI.drag = { mode, corner, edge, x0: x, y0: y, r0: { ...r }, sx, rect };
  cropLayer.setPointerCapture(e.pointerId);
});

let cropRaf = 0;
const scheduleCropRender = () => { if (!cropRaf) cropRaf = requestAnimationFrame(() => { cropRaf = 0; renderCrop(); }); };

cropLayer.addEventListener('pointermove', e => {
  if (scl.drag) {
    const d = scl.drag;
    const ref = project.ref, m = Math.max(ref.w, ref.h);
    const x = Math.max(0, Math.min(ref.w / m, (e.clientX - d.rect.left) / d.sx)), y = Math.max(0, Math.min(ref.h / m, (e.clientY - d.rect.top) / d.sx));
    scl.pts[d.k] = { x, y };
    scheduleCropRender(); updateScaleUI();
    showLoupe(e.clientX, e.clientY, x, y);   // Lupe nur beim Kalibrieren
    return;
  }
  const d = cropUI.drag;
  if (!d) return;
  const x = (e.clientX - d.rect.left) / d.sx, y = (e.clientY - d.rect.top) / d.sx, r0 = d.r0;
  const ratio = ed.mode === 'roi' ? null : CROP_ASPECTS[cropUI.key];
  const setRect = ed.mode === 'roi' ? setRoiRect : setCropRect;
  // Rahmen aus fester Ecke (fx, fy) und Fingerposition, Seitenverhältnis beachten
  const fromFixed = (fx, fy) => {
    let w = Math.abs(x - fx), h = Math.abs(y - fy);
    if (ratio) { if (w / h > ratio) h = w / ratio; else w = h * ratio; }
    return { x: x < fx ? fx - w : fx, y: y < fy ? fy - h : fy, w, h };
  };
  if (d.mode === 'move') {
    // getrennt nach Achsen -> der Rahmen gleitet am Rand entlang statt stehen zu bleiben
    setRect({ ...edRect(), x: r0.x + x - d.x0 });
    setRect({ ...edRect(), y: r0.y + y - d.y0 });
  } else if (d.mode === 'corner') {
    setRect(fromFixed(d.corner % 2 === 0 ? r0.x + r0.w : r0.x, d.corner < 2 ? r0.y + r0.h : r0.y));
  } else if (d.mode === 'edge') {
    let n = { ...r0 };
    if (d.edge === 'l') { n.x = Math.min(x, r0.x + r0.w - 0.06); n.w = r0.x + r0.w - n.x; }
    if (d.edge === 'r') n.w = Math.max(0.06, x - r0.x);
    if (d.edge === 't') { n.y = Math.min(y, r0.y + r0.h - 0.06); n.h = r0.y + r0.h - n.y; }
    if (d.edge === 'b') n.h = Math.max(0.06, y - r0.y);
    if (ratio) { // Seitenverhältnis halten: andere Achse mittig anpassen
      if (d.edge === 'l' || d.edge === 'r') { const h = n.w / ratio; n.y = r0.y + (r0.h - h) / 2; n.h = h; }
      else { const w = n.h * ratio; n.x = r0.x + (r0.w - w) / 2; n.w = w; }
    }
    setRect(n);
  } else if (Math.hypot(x - d.x0, y - d.y0) > 12 / d.sx) {
    // neuer Rahmen: vom Startpunkt aufziehen
    setRect(fromFixed(d.x0, d.y0));
  }
  scheduleCropRender();
});
const cropEnd = () => { const was = cropUI.drag || scl.drag; cropUI.drag = null; scl.drag = null; $('#ed-loupe').hidden = true; if (was) renderCrop(); };
cropLayer.addEventListener('pointerup', cropEnd);
cropLayer.addEventListener('pointercancel', cropEnd);

$('#crop-aspect').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  cropUI.key = b.dataset.v;
  cropUI.auto = false;
  const ratio = CROP_ASPECTS[cropUI.key];
  if (ratio) {
    const r = cropUI.rect, nr = Project.maxRectAt(cropUI.quads, r.x + r.w / 2, r.y + r.h / 2, ratio);
    if (nr) cropUI.rect = nr;
  }
  renderCrop();
});
$('#crop-auto').onclick = () => {
  // automatischen (größtmöglichen) Ausschnitt im Editor anzeigen
  const keep = project.customCrop;
  project.customCrop = null; project.computeCrop();
  const c = project.crop;
  project.customCrop = keep;
  cropUI.rect = { x: c.x, y: c.y, w: c.w, h: c.h };
  cropUI.key = 'frei'; cropUI.auto = true;
  renderCrop();
};
$('#crop-cancel').onclick = () => {
  const o = cropUI.orig;
  project.customCrop = o; project.computeCrop();
  const c = project.crop;
  cropUI.rect = { x: c.x, y: c.y, w: c.w, h: c.h };
  cropUI.key = o?.key || 'frei'; cropUI.auto = !o;
  renderCrop();
};
$('#crop-btn2').onclick = () => showView('crop');

// ---- Vollbild-Vorschau (Antippen der Vorschau) ----
function enterFullscreen() {
  if (!player || ui.fs) return;
  ui.fs = true;
  $('#stage').classList.add('fs');
  document.body.classList.add('fs-open');
  $('#fs-hint').textContent = 'Antippen zum Schließen';
  layoutStage();
  player.play();
}
function exitFullscreen() {
  if (!ui.fs) return;
  ui.fs = false;
  $('#stage').classList.remove('fs');
  document.body.classList.remove('fs-open');
  $('#fs-hint').textContent = '⤢ Antippen für Vollbild';
  player?.pause();
  layoutStage();
}
$('#stage').addEventListener('click', e => {
  if (anc.on || cropUI.on || e.target.closest('.anchor-layer') || e.target.closest('.crop-layer')) return;
  ui.fs ? exitFullscreen() : enterFullscreen();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') exitFullscreen(); });

// ---- Punkte-Ansicht: Bezugspunkte einmal setzen ----
const pv = { bmp: null, bmpId: null, drag: null, rect: null };
function ptsRef() {
  if (!project.ref || !project.frames.includes(project.ref)) {
    project.settings.refMode = 'manual';
    project.refId = project.frames[0]?.id || null;
  }
  return project.ref;
}

async function renderPoints() {
  const f = ptsRef();
  if (!f) return;
  const wrap = $('#view-points .stage-wrap');
  const aspect = f.w / f.h, avail = wrap.clientWidth || window.innerWidth - 32;
  const maxH = Math.min(window.innerHeight * 0.55, 900);
  const w = Math.min(avail, maxH * aspect), h = w / aspect;
  const st = $('#pts-stage');
  st.style.width = w + 'px'; st.style.height = h + 'px';
  if (pv.bmpId !== f.id) {
    pv.bmp?.close?.(); pv.bmp = null; pv.bmpId = f.id;
    try { pv.bmp = await createImageBitmap(f.previewBlob); } catch { /* ohne Bild */ }
  }
  const c = $('#pts-canvas'), dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  if (pv.bmp) { const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(pv.bmp, 0, 0, c.width, c.height); }
  renderPointMarkers();
}

function renderPointMarkers() {
  const f = project.ref;
  if (!f) return;
  $('#pts-layer').innerHTML = project.anchors.map((a, k) => {
    const [l, t] = canonToPct(f, a.x, a.y);
    const cls = a.uniq == null ? '' : a.uniq >= 0.5 ? 'good' : a.uniq >= 0.25 ? 'warn' : 'bad';
    return `<div class="anchor-pt ${cls}${pv.drag?.k === k ? ' drag' : ''}" style="left:${l}%;top:${t}%"><span>${k + 1}</span></div>`;
  }).join('');
  const n = project.anchors.length;
  $('#pts-help').innerHTML = n === 0
    ? '<b>Tippe auf 4–5 Stellen</b>, die in <b>allen</b> Fotos vorhanden sind und sich nicht bewegen – z. B. die ersten Haferflocken (nicht später hinzugefügte). Möglichst über die ganze Schale verteilt. Lapse findet sie danach in allen Fotos selbst.'
    : n < 4 ? `Noch <b>${4 - n} Punkt${4 - n === 1 ? '' : 'e'}</b> antippen. Mit weniger als 4 Punkten kann Lapse ähnliche Flocken verwechseln.`
    : n === 4 ? 'Gut. Ein 5. Punkt macht es noch sicherer – dann unten <b>„Alle Fotos ausrichten“</b>. Punkte lassen sich ziehen.'
    : 'Prima – jetzt unten <b>„Alle Fotos ausrichten“</b>. Punkte lassen sich ziehen.';
  $('#pts-list').innerHTML = project.anchors.map((a, k) => {
    const t = a.uniq == null ? 'wird geprüft …' : a.uniq >= 0.5 ? 'gut erkennbare Stelle ✓'
      : a.uniqReason === 'flach' ? 'einfarbige Fläche – bitte andere Stelle wählen'
      : a.uniqReason === 'rand' ? 'zu nah am Rand' : 'schwer erkennbar – besser eine markantere Stelle';
    const cls = a.uniq == null ? '' : a.uniq >= 0.5 ? 'good' : a.uniq >= 0.25 ? 'warn' : 'bad';
    return `<li><span class="n ${cls}">${k + 1}</span><span class="t">${t}</span><button data-del="${k}" aria-label="Punkt ${k + 1} löschen">×</button></li>`;
  }).join('');
  $('#pts-undo').disabled = !n;
  updatePrimary();
}

let ptsTimer = 0;
function pointsChanged() {
  // geänderte Punkte -> neu ausrichten nötig
  if (project.aligned && project.anchorsActive) { project.aligned = false; updateSteps(); }
  project.resetAnchors(true);
  renderPointMarkers();
  scheduleSave();
  clearTimeout(ptsTimer);
  ptsTimer = setTimeout(() => anchorUniqueness(project, getAligner()).then(renderPointMarkers).catch(() => {}), 300);
}

const ptsLayer = $('#pts-layer');
ptsLayer.addEventListener('pointerdown', e => {
  const f = project.ref;
  if (!f) return;
  const rect = ptsLayer.getBoundingClientRect(), m = Math.max(f.w, f.h);
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  let hit = -1, best = 28;
  project.anchors.forEach((a, k) => {
    const d = Math.hypot(a.x * m / f.w * rect.width - sx, a.y * m / f.h * rect.height - sy);
    if (d < best) { best = d; hit = k; }
  });
  if (hit < 0) {
    if (project.anchors.length >= 5) { toast('Höchstens 5 Punkte.'); return; }
    project.anchors.push({ x: sx / rect.width * f.w / m, y: sy / rect.height * f.h / m });
    hit = project.anchors.length - 1;
    pointsChanged();
  }
  const a = project.anchors[hit];
  pv.drag = { k: hit, cx: e.clientX, cy: e.clientY, ox: a.x, oy: a.y, rect, m, moved: false };
  ptsLayer.setPointerCapture(e.pointerId);
  drawPtsLoupe(a.x, a.y);
  renderPointMarkers();
});
ptsLayer.addEventListener('pointermove', e => {
  const d = pv.drag, f = project.ref;
  if (!d) return;
  if (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) > 2) d.moved = true;
  const a = project.anchors[d.k];
  a.x = Math.max(0, Math.min(f.w / d.m, d.ox + (e.clientX - d.cx) / d.rect.width * f.w / d.m));
  a.y = Math.max(0, Math.min(f.h / d.m, d.oy + (e.clientY - d.cy) / d.rect.height * f.h / d.m));
  renderPointMarkers();
  drawPtsLoupe(a.x, a.y);
});
const ptsEnd = () => {
  const d = pv.drag;
  if (!d) return;
  pv.drag = null;
  $('#pts-loupe').hidden = true;
  if (d.moved) { project.anchors[d.k].uniq = null; pointsChanged(); } else renderPointMarkers();
};
ptsLayer.addEventListener('pointerup', ptsEnd);
ptsLayer.addEventListener('pointercancel', ptsEnd);

function drawPtsLoupe(x, y) {
  const f = project.ref, c = $('#pts-loupe'), rect = ptsLayer.getBoundingClientRect(), m = Math.max(f.w, f.h);
  const u = x * m / f.w, v = y * m / f.h, px = u * rect.width, py = v * rect.height;
  c.hidden = false;
  c.style.left = Math.max(0, Math.min(rect.width - 120, px - 60)) + 'px';
  c.style.top = (py - 150 >= 0 ? py - 150 : Math.min(rect.height - 120, py + 30)) + 'px';
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 240, 240);
  const b = pv.bmp;
  if (b) { const src = 120 / (3 * rect.width / b.width); ctx.drawImage(b, u * b.width - src / 2, v * b.height - src / 2, src, src, 0, 0, 240, 240); }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(120, 90); ctx.lineTo(120, 110); ctx.moveTo(120, 130); ctx.lineTo(120, 150);
  ctx.moveTo(90, 120); ctx.lineTo(110, 120); ctx.moveTo(130, 120); ctx.lineTo(150, 120); ctx.stroke();
}

$('#pts-list').onclick = e => {
  const k = e.target.closest('[data-del]')?.dataset.del;
  if (k == null) return;
  project.anchors.splice(+k, 1);
  pointsChanged();
};
$('#pts-undo').onclick = () => { project.anchors.pop(); pointsChanged(); };
$('#pts-choose').onclick = () => {
  const strip = $('#pts-strip');
  strip.hidden = !strip.hidden;
  if (strip.hidden) return;
  strip.innerHTML = project.frames.map(f => `<button class="sf${f.id === project.refId ? ' sel' : ''}" data-id="${f.id}"><img src="${f.thumbUrl}" alt="" loading="lazy"></button>`).join('');
};
$('#pts-strip').onclick = e => {
  const id = e.target.closest('.sf')?.dataset.id;
  if (!id || id === project.refId) return;
  if (project.anchors.length && !confirm('Bezugsfoto wechseln? Die gesetzten Punkte werden gelöscht.')) return;
  project.settings.refMode = 'manual';
  project.refId = id;
  project.anchors = [];
  project.aligned = false;
  updateSteps();
  $('#pts-strip').hidden = true;
  pointsChanged();
  renderPoints();
};
window.addEventListener('resize', () => { if (ui.view === 'points') renderPoints(); });
$('#pts-auto').onclick = () => { project.resetAnchors(false); runAlign(); };

// Neuberechnung nach Änderungen (Zuschnitt -> Messung -> Farbangleich -> Qualität)
let refreshGen = 0, refreshTimer = 0;
async function refresh({ onProgress } = {}) {
  const gen = ++refreshGen;
  stats ||= new StatsEngine();
  project.computeCrop();
  if (onStage()) layoutStage();
  await stats.measure(project, { onProgress, isCancelled: () => gen !== refreshGen });
  if (gen !== refreshGen) return false;
  project.computeColor();
  project.checkConsistency();
  project.assessQuality();
  {
    const inc = project.included, q = k => inc.filter(f => f.quality === k);
    const c = project.crop;
    log(`Bewertung: ${q('good').length} gut · ${q('warn').length} prüfen · ${q('bad').length} fehlerhaft · ${project.frames.length - inc.length} ausgeschlossen${c ? ` · Zuschnitt ${(c.w * 100).toFixed(0)}×${(c.h * 100).toFixed(0)} %` : ''}`, 'i');
    for (const f of [...q('warn'), ...q('bad')]) log(`  ${f.name}: ${f.qualityNote || f.quality}${f.inconsistent ? ' (Nachbarprüfung)' : ''}`, 'd');
  }
  $('#recalc').hidden = true;
  player?.invalidate();
  if (ui.view === 'edit') { renderStrip(); updateFramePanel(); updateCropHelp(); }
  renderNotice();
  updateIssues();
  scheduleSave();
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
    renderHud(t, dur, frame);
  };
  player.onPlayState = on => $('#play').classList.toggle('playing', on);
  window.addEventListener('resize', () => onStage() && layoutStage());
}

function layoutStage() {
  if (!player || !project.crop) return;
  if (ui.fs) {
    const a = project.crop.w / project.crop.h, W = window.innerWidth, H = window.innerHeight;
    let w = Math.min(W, H * a), h = w / a;
    const c = $('#preview');
    c.style.width = w + 'px'; c.style.height = h + 'px';
    player.setSize(w, h);
    return;
  }
  $('#preview').style.width = ''; $('#preview').style.height = '';
  // Ankerpunkt-Modus: ganzes Foto, größer dargestellt
  const aspect = anc.on ? anc.frame.w / anc.frame.h : project.crop.w / project.crop.h;
  const avail = $('.stage-wrap').clientWidth || window.innerWidth - 32;
  // Vorschau bleibt angeheftet -> Höhe begrenzen, damit genug Platz für die Regler bleibt
  // Prüfansicht: Foto so groß, dass Frage und Knöpfe ohne Scrollen sichtbar bleiben
  const maxH = Math.min(window.innerHeight * (ui.review ? 0.4 : anc.on ? 0.5 : 0.36), anc.on ? 900 : 560);
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
// Messwerte in der Vorschau: Bildnummer, Zeitabstand zur ersten Aufnahme, Qualität
const fmtDelta = ms => {
  if (!isFinite(ms)) return '';
  const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return `${d ? d + ' d ' : ''}${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')} h`;
};
function renderHud(t, dur, frame) {
  const inc = project.included;
  if (!frame || !inc.length || anc.on) { $('#hud-frame').textContent = ''; $('#hud-time').textContent = ''; return; }
  const i = inc.indexOf(frame), when = f => f.date ?? f.modified;
  const q = frame.quality === 'good' ? 'ok' : frame.quality === 'warn' ? 'wn' : 'bd';
  const dt = when(frame) != null && when(inc[0]) != null ? fmtDelta(when(frame) - when(inc[0])) : '';
  $('#hud-frame').innerHTML = `<span class="k">FRAME</span> ${String(i + 1).padStart(3, '0')}/${String(inc.length).padStart(3, '0')}${frame.id === project.refId ? ' <span class="ok">REF</span>' : ''}\n<span class="${q}">●</span> ${escHtml(frame.name.replace(/\.[^.]+$/, ''))}`;
  const s = project.settings;
  $('#hud-time').innerHTML = `${dt ? `<span class="k">Δt</span> +${dt}\n` : ''}<span class="k">T</span> ${fmtClock(t)} · ${s.fps || ''} fps`;
}

// Messreihe: Ausrichtungsgüte (Balken) und Helligkeit roh/korrigiert (Linien) je Foto
function renderSeries() {
  const c = $('#series');
  if (!c || !c.clientWidth) return;
  const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const fr = project.frames.filter(f => f.featRes > 0);
  renderSeries.frames = fr;
  if (fr.length < 2) return;
  const n = fr.length, bw = W / n, top = 14 * dpr, bot = H - 4 * dpr, hgt = bot - top;
  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
  ctx.beginPath(); for (const v of [0.25, 0.5, 0.75]) { ctx.moveTo(0, bot - v * hgt); ctx.lineTo(W, bot - v * hgt); } ctx.stroke();
  // Balken: Güte der Ausrichtung
  fr.forEach((f, i) => {
    const a = f.align || {};
    let v = a.ncc != null ? a.ncc : f.geoSupport != null && project.anchors.length ? f.geoSupport / project.anchors.length : a.ok ? 0.8 : 0;
    if (f.id === project.refId) v = 1;
    const col = f.excluded ? 'rgba(255,255,255,.12)' : f.quality === 'bad' ? '#ff6b5e' : f.quality === 'warn' ? '#f3c08a' : '#5ad39a';
    ctx.fillStyle = col; ctx.globalAlpha = f.excluded ? 1 : 0.55;
    const h = Math.max(2 * dpr, Math.max(0, Math.min(1, v)) * hgt * 0.55);
    ctx.fillRect(i * bw + bw * 0.2, bot - h, Math.max(1, bw * 0.6), h);
  });
  ctx.globalAlpha = 1;
  // Linien: Helligkeit
  const lum = (f, cor) => {
    if (!f.stats) return null;
    const m = f.stats.mean, g = cor && f.color ? f.color.gain : [1, 1, 1], o = cor && f.color ? f.color.off : [0, 0, 0];
    return 0.2126 * (g[0] * m[0] + o[0]) + 0.7152 * (g[1] * m[1] + o[1]) + 0.0722 * (g[2] * m[2] + o[2]);
  };
  const vals = fr.flatMap(f => [lum(f, false), lum(f, true)]).filter(v => v != null);
  if (vals.length) {
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 0.08) { const m = (hi + lo) / 2; lo = m - 0.04; hi = m + 0.04; }
    const y = v => bot - (v - lo) / (hi - lo) * hgt * 0.9 - hgt * 0.05;
    for (const [cor, col, lw] of [[false, 'rgba(255,255,255,.45)', 1], [true, '#7fd3e6', 1.5]]) {
      ctx.strokeStyle = col; ctx.lineWidth = lw * dpr; ctx.beginPath();
      let started = false;
      fr.forEach((f, i) => { const v = lum(f, cor); if (v == null || f.excluded) return; const X = (i + 0.5) * bw; started ? ctx.lineTo(X, y(v)) : ctx.moveTo(X, y(v)); started = true; });
      ctx.stroke();
    }
  }
  // aktuelles Bild
  const cur = fr.indexOf(ui.selected || lastCurrent);
  if (cur >= 0) { ctx.fillStyle = 'rgba(243,192,138,.9)'; ctx.fillRect((cur + 0.5) * bw - dpr / 2, top - 6 * dpr, Math.max(1, dpr), H); }
}
$('#series').addEventListener('click', e => {
  const fr = renderSeries.frames || [], r = e.currentTarget.getBoundingClientRect();
  const f = fr[Math.floor((e.clientX - r.left) / r.width * fr.length)];
  if (f && player && !anc.on) selectFrame(f);
});
window.addEventListener('resize', () => onStage() && renderSeries());

function markCurrent(frame) {
  if (!frame || frame === lastCurrent) return;
  lastCurrent = frame;
  renderSeries();
  const strip = $('#strip');
  strip.querySelector('.sf.cur')?.classList.remove('cur');
  const el = strip.querySelector(`[data-id="${frame.id}"]`);
  if (el) {
    el.classList.add('cur');
    if (player?.playing || scrubbing) strip.scrollLeft = el.offsetLeft - strip.clientWidth / 2 + el.offsetWidth / 2;
  }
}

function renderStrip() {
  requestAnimationFrame(renderSeries);
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
  fx.hidden = !flagged.length || project.anchorsActive;
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
  // Bei Ausrichtung über Punkte (gedrehte Fotos) ist ein kleinerer Ausschnitt normal -> kein Hinweis
  const lim = project.aligned && !project.anchorsActive ? project.cropLimiters() : [];
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
  $('#anc-title').textContent = ui.review ? `Foto ${ui.review.pos} von ${ui.review.total} prüfen` : isRef ? 'Ankerpunkte im Referenzbild' : 'Ankerpunkte prüfen';
  $('#anc-pos').textContent = ui.review ? f.name : `${isRef ? '★ Referenz · ' : ''}Foto ${idx + 1} von ${list.length} · ${f.name}`;
  $('#anc-done').textContent = ui.review ? 'Prüfen beenden' : 'Fertig';
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
  if (ui.review && !isRef) help = 'Liegen die Ringe auf denselben Stellen wie im kleinen Bezugsbild? Dann unten „Passt“. Sonst einen Ring antippen und an die richtige Stelle ziehen – oder „Foto entfernen“.';
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
  $('#anc-remove').hidden = isRef;
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
  scheduleSave();
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
  if (ui.review) { reviewTap(e); return; }
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
  scheduleSave();
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
  if (ui.selected && ui.selected.id !== project.refId && project.anchors.length >= 3) { startReview(ui.selected.id); return; }
  const f = ui.selected;
  openAnchors(f && f.anchorPts && f.id !== project.refId ? f : project.ref);
  if (f && f.id !== project.refId && !project.anchors.length) toast('Erst im Referenzbild Punkte setzen, dann „In allen Fotos suchen“.', 4500);
};
$('#anc-done').onclick = () => {
  if (ui.review) { endReview(false); return; }
  closeAnchors();
  // gibt es noch unsichere Fotos, das Prüf-Fenster nach der Neuberechnung erneut anbieten
  setTimeout(() => { if (problemFrames().length) updateIssues(); }, 800);
};
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
    const ok = await alignByAnchors(project, getAligner(), {
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
  if (typeof syncTempo === 'function' && $('#spf')) syncTempo();
  $$('output[data-out]').forEach(o => { o.textContent = OUT[o.dataset.out]?.(s[o.dataset.out]) ?? s[o.dataset.out]; });
  $$('[data-help]').forEach(p => { p.textContent = HELP[p.dataset.help]?.[s[p.dataset.help]] || ''; });
  $$('[data-if]').forEach(el => {
    const [, k, op, v] = el.dataset.if.match(/(\w+)(==|!=)(\w+)/);
    el.hidden = op === '==' ? String(s[k]) !== v : String(s[k]) === v;
  });
}

function onSetting(key) {
  const s = project.settings;
  scheduleSave();
  store.set('settings', s);
  syncSettingsUI();
  if (VIDEO_KEYS.has(key)) { player?.invalidate(); updateDuration(); }
  else if (key === 'aspect' || key === 'zoom') {
    if (project.customCrop) { project.customCrop = null; toast('Eigener Ausschnitt durch neues Format ersetzt.'); } if (project.aligned) { project.computeCrop(); layoutStage(); player?.invalidate(); scheduleRefresh(); } }
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

// ---- Tempo als „Zeit pro Foto“ (intern: Fotos pro Sekunde = 1 / Zeit)
function spfList() { return [0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.25, 1.5, 2]; }
function fmtSec(v) { return String(+v.toFixed(3)).replace(".", ",") + " s"; }
//  String(+v.toFixed(3)).replace('.', ',') + ' s';
function syncTempo() {
  const pps = project.settings.pps || 12, spf = 1 / pps;
  const L = spfList(), i = L.reduce((bi, v, k) => (Math.abs(Math.log(v / spf)) < Math.abs(Math.log(L[bi] / spf)) ? k : bi), 0);
  const r = $("#spf"); r.max = L.length - 1; r.value = i;
  const ppsTxt = pps >= 1 ? String(+pps.toFixed(1)).replace('.', ',') : String(+pps.toFixed(2)).replace('.', ',');
  $('#spf-out').textContent = `${fmtSec(spf)} · ${ppsTxt} Fotos/s`;
  $$('#spf-chips button').forEach(b => b.classList.toggle('on', Math.abs(+b.dataset.s - spf) < 1e-6));
}
function setTempo(spf) {
  project.settings.pps = 1 / spf;
  syncTempo();
  onSetting('pps');
}
$('#spf').addEventListener('input', e => setTempo(spfList()[+e.target.value]));
$('#spf-chips').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTempo(+b.dataset.s); });

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

function showResult(res, plan, opts = {}) {
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
  if (opts.modal === false) return;
  // Deutliches Fenster zum Sichern (Export allein speichert noch nichts)
  const isVid = res.blob.type.startsWith('video/');
  $('#done-title').textContent = isVid ? 'Video fertig ✓' : res.blob.type === 'image/gif' ? 'GIF fertig ✓' : 'Einzelbilder fertig ✓';
  $('#done-media').innerHTML = isVid ? `<video src="${url}" controls playsinline loop muted autoplay></video>` : res.blob.type === 'image/gif' ? `<img src="${url}" alt="">` : '';
  $('#done-info').textContent = info;
  $('#done-share').textContent = isVid ? 'In Fotos sichern' : 'Teilen / Sichern';
  $('#done').hidden = false;
  db.saveExport(res).then(() => showLastVideo(res)).catch(() => toast('Hinweis: Das Video konnte nicht in Lapse aufbewahrt werden – bitte jetzt sichern.', 6000));
}

function showLastVideo(r) {
  if (!r) return;
  $('#lv-info').textContent = `${r.name} · ${r.w}×${r.h} · ${num((r.blob?.size || 0) / 1e6, 1)} MB`;
  $('#last-video').hidden = false;
}
$('#done-close').onclick = () => { $('#done').hidden = true; };
$('#done-share').onclick = () => shareResult();
$('#done-download').onclick = () => download();
$('#lv-share').onclick = () => shareResult();
$('#lv-download').onclick = () => download();

$('#share').onclick = () => shareResult();
async function shareResult() {
  const r = ui.result;
  if (!r) return;
  const file = new File([r.blob], r.name, { type: r.blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Lapse' }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  download();
}
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

// Gespeichertes Projekt / letztes Video anbieten
async function resumeProject() {
  progress.open('Projekt wird geladen', { cancellable: false });
  try {
    const data = await db.load();
    if (!data || !data.frames.length) { toast('Kein gespeichertes Projekt gefunden.'); $('#resume').hidden = true; return; }
    resumeOffered = false;
    $('#resume').hidden = true;
    Object.assign(project.settings, data.meta.settings || {});
    project.frames = data.frames.map(f => ({ ...f, thumbUrl: URL.createObjectURL(f.thumbBlob || f.previewBlob) }));
    project.refId = data.meta.refId;
    project.anchors = data.meta.anchors || [];
    project.anchorsActive = !!data.meta.anchorsActive;
    project.customCrop = data.meta.customCrop || null;
    project.scale = data.meta.scale || null;
    project.aligned = !!data.meta.aligned && project.frames.some(f => f.id === project.refId);
    syncSettingsUI();
    renderGrid();
    updateSteps();
    if (project.aligned) {
      progress.set(0.4, 'Zuschnitt und Farbe werden berechnet …');
      if (!player) initPlayer();
      await refresh();
      showView('edit');
    }
    toast(`Projekt mit ${project.frames.length} Fotos wiederhergestellt.`);
  } catch (err) {
    console.error(err);
    toast('Projekt konnte nicht geladen werden: ' + err.message, 6000);
  } finally {
    progress.close();
  }
}
$('#resume-btn').onclick = () => resumeProject();
$('#resume-discard').onclick = async () => {
  if (!confirm('Gespeichertes Projekt verwerfen? (Deine Originalfotos bleiben unberührt.)')) return;
  await db.clearProject().catch(() => {});
  resumeOffered = false;
  $('#resume').hidden = true;
};
const startupCheck = (async () => {
  if (!db.available) return;
  try {
    const info = await db.info();
    if (info && !project.frames.length) {
      resumeOffered = true;
      const when = new Date(info.savedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
      $('#resume-info').textContent = `${info.count} Fotos · zuletzt gespeichert ${when}`;
      $('#resume').hidden = false;
    }
    const lv = await db.lastExport();
    if (lv?.blob) {
      showResult({ blob: lv.blob, name: lv.name, w: lv.w, h: lv.h, duration: lv.duration }, null, { modal: false });
      showLastVideo(lv);
    }
  } catch (err) { console.error(err); }
})();

// ---------------------------------------------------------------- Zeitraffer-Aufnahme

const capture = new Capture({ toast, store: db, onImport: importCaptured });
capture.onClosed = () => checkCaptureResume();
$('#choose-capture').onclick = () => capture.open();
$('#choose-photos').onclick = () => $('#file').click();

/** Aufgenommene Fotos übernehmen: Bezugsfoto = erste Aufnahme, Punkte aus dem Testfoto, direkt ausrichten. */
async function importCaptured(files, anchors) {
  if (project.frames.length) {
    if (!confirm('Das aktuelle Projekt wird durch die Aufnahme ersetzt. Fortfahren?')) return;
    removeFrames(project.frames.map(f => f.id));
  }
  showView('photos');
  await addFiles(files);
  if (project.frames.length < 2) { toast('Für ein Video werden mindestens 2 Aufnahmen gebraucht.', 4000); return; }
  project.settings.refMode = 'manual';
  project.refId = project.frames[0].id;
  project.anchors = anchors.map(a => ({ x: a.x, y: a.y }));
  project.resetAnchors(true);
  syncSettingsUI();
  scheduleSave(0);
  if (project.anchors.length >= 2) await runAnchorAlign();
  else showView('points');
}

async function checkCaptureResume() {
  if (!db.available) return;
  try {
    const m = await db.captureMeta();
    const card = $('#cap-resume');
    if (!m || !m.taken) { card.hidden = true; return; }
    const when = new Date(m.startedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
    const st = m.imported ? 'bereits übernommen' : m.status === 'running' ? 'unterbrochen' : 'abgeschlossen';
    $('#cap-resume-info').textContent = `${m.taken} Fotos · gestartet ${when} · ${st}`;
    card.hidden = false;
  } catch (err) { console.error(err); }
}
$('#cap-resume-use').onclick = async () => { await capture.openSaved(); capture.importAll(); };
$('#cap-resume-save').onclick = () => capture.openSaved();
$('#cap-resume-discard').onclick = async () => {
  if (!confirm('Gespeicherte Aufnahme aus Lapse löschen? (Bereits in Fotos gesicherte Bilder bleiben erhalten.)')) return;
  await db.clearCaptures().catch(() => {});
  $('#cap-resume').hidden = true;
};
const capCheck = checkCaptureResume();

// Startseite erst zeigen, wenn klar ist, welche Karten (Projekt, Video, Aufnahme) erscheinen –
// verhindert das kurze Aufblitzen beim Start
Promise.race([Promise.allSettled([startupCheck, capCheck]), new Promise(r => setTimeout(r, 1500))])
  .then(() => document.body.classList.remove('booting'));

// Für Tests/Fehlersuche
$('#cap-diag').onclick = openDiag;
window.__lapse = { project, ui, DEFAULT_SETTINGS, getAligner, refresh, capture, openDiag, cropRect: () => ({ ...cropUI.rect }) };

// Verarbeitungskette: Import -> Merkmale -> Ausrichtung -> Zuschnitt -> Farbstatistik.

import { readCaptureTime } from './exif.js';
import { decode, sizeOf, release, scaleTo, toBlob, grayOf, freeCanvas, makeCanvas } from './images.js';
import { mul, I3 } from './geometry.js';
import { newManual, statsOf } from './project.js';
import { Renderer } from './renderer.js';

const ANALYSIS = { fast: { res: 1024, feats: 1500 }, precise: { res: 1600, feats: 2500 }, refine: { res: 2048, feats: 3500 } };
export const PREVIEW_RES = 960;

export class Aligner {
  constructor() {
    this.worker = new Worker(new URL('./align-worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.seq = 0;
    this.worker.onmessage = e => {
      const p = this.pending.get(e.data.reqId);
      if (!p) return;
      this.pending.delete(e.data.reqId);
      e.data.type === 'error' ? p.reject(new Error(e.data.message)) : p.resolve(e.data);
    };
    this.worker.onerror = e => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Worker-Fehler'));
      this.pending.clear();
    };
  }
  call(msg, transfer = []) {
    const reqId = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.worker.postMessage({ ...msg, reqId }, transfer);
    });
  }
}

let uid = 0;
const nextId = () => 'f' + (++uid) + '_' + Date.now().toString(36);

/** Merkmale eines dekodierten Bildes an den Worker senden. */
function sendFeatures(aligner, id, src, mode) {
  const a = ANALYSIS[mode];
  const c = scaleTo(src, a.res);
  const { gray, w, h } = grayOf(c);
  freeCanvas(c);
  return aligner.call({ type: 'features', id, gray: gray.buffer, w, h, maxFeatures: a.feats, levels: 4 }, [gray.buffer])
    .then(() => Math.max(w, h));
}

/**
 * Importiert Dateien: Vorschaubilder erzeugen, Aufnahmezeit lesen, Merkmale berechnen.
 * onFrame(frame) wird je Bild aufgerufen, onProgress(done, total).
 */
export async function importFiles(files, project, aligner, { onFrame, onProgress, isCancelled } = {}) {
  const mode = project.settings.precision === 'precise' ? 'precise' : 'fast';
  let inflight = Promise.resolve();
  const errors = [];
  for (let i = 0; i < files.length; i++) {
    if (isCancelled?.()) break;
    const file = files[i];
    let src;
    try {
      const date = await readCaptureTime(file);
      src = await decode(file);
      const { w, h } = sizeOf(src);
      const thumb = scaleTo(src, 256);
      const thumbBlob = await toBlob(thumb, 'image/jpeg', 0.75);
      freeCanvas(thumb);
      const prev = scaleTo(src, PREVIEW_RES);
      const previewBlob = await toBlob(prev, 'image/jpeg', 0.88);
      freeCanvas(prev);
      const frame = {
        id: nextId(), file, name: file.name, date, modified: file.lastModified, order: project.frames.length,
        w, h, thumbUrl: URL.createObjectURL(thumbBlob), previewBlob,
        featRes: 0, align: null, manual: newManual(), excluded: false, analyzing: true,
      };
      await inflight; // höchstens eine Analyse parallel -> begrenzter Speicher
      // sendFeatures skaliert synchron herunter -> Original danach sofort freigeben
      inflight = sendFeatures(aligner, frame.id, src, mode)
        .then(res => { frame.featRes = res; frame.analyzing = false; onFrame?.(frame, 'analyzed'); })
        .catch(err => { frame.analyzing = false; frame.featError = String(err.message || err); });
      release(src);
      src = null;
      project.frames.push(frame);
      project.aligned = false;
      onFrame?.(frame, 'added');
    } catch (err) {
      errors.push(`${file.name}: ${err.message || err}`);
      release(src);
    }
    onProgress?.(i + 1, files.length);
  }
  await inflight;
  return errors;
}

/**
 * Sortiert die Bilder. Ohne Aufnahmezeit in allen Fotos wird nach Dateiname sortiert
 * (das Dateidatum ist auf dem iPhone meist nur der Importzeitpunkt).
 * Rückgabe: tatsächlich verwendeter Modus.
 */
export function sortFrames(project, mode) {
  if (mode === 'time' && project.frames.some(f => f.date == null)) mode = 'name';
  const by = {
    time: (a, b) => a.date - b.date || a.name.localeCompare(b.name, undefined, { numeric: true }),
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    added: (a, b) => a.order - b.order,
  }[mode] || ((a, b) => a.order - b.order);
  project.frames.sort(by);
  return mode;
}

const GOOD_INLIERS = 30;

/** Richtet alle Bilder auf das Referenzbild aus (mit Rückfall über Nachbarbilder). */
export async function alignAll(project, aligner, { onProgress, isCancelled } = {}) {
  project.chooseReference();
  const ref = project.ref;
  const list = project.frames.filter(f => f.featRes > 0);
  const ri = list.indexOf(ref);
  if (ri < 0) throw new Error('Referenzbild hat keine Merkmale.');
  ref.align = { ok: true, H: I3(), inliers: Infinity, total: 0, rms: 0, via: null };
  // Von der Referenz nach außen arbeiten, damit Nachbarn schon ausgerichtet sind
  const order = [];
  for (let d = 1; d < list.length; d++) {
    if (ri - d >= 0) order.push([ri - d, +1]);
    if (ri + d < list.length) order.push([ri + d, -1]);
  }
  let done = 0;
  for (const [i, toward] of order) {
    if (isCancelled?.()) return false;
    const f = list[i];
    f.align = await alignOne(project, aligner, f, list[i + toward], {});
    onProgress?.(++done, order.length);
  }
  // Nicht ausrichtbare Fotos automatisch ausschließen (können manuell wieder aufgenommen werden)
  const auto = [];
  for (const f of list) {
    if (f === ref) continue;
    const unreliable = !f.align.ok || f.align.inliers < 12;
    if (unreliable && !f.excluded && !f.keepIncluded) { f.excluded = true; f.autoExcluded = true; auto.push(f); }
    else if (!unreliable && f.autoExcluded) { f.excluded = false; f.autoExcluded = false; }
  }
  project.aligned = true;
  return auto;
}

async function alignOne(project, aligner, f, neighbor, { iterations, threshPx, model } = {}) {
  const ref = project.ref;
  model = model || project.settings.model;
  const direct = await aligner.call({ type: 'align', id: f.id, refId: ref.id, model, iterations, threshPx });
  let best = direct.ok ? { ...direct, via: null } : null;
  if ((!best || best.inliers < GOOD_INLIERS) && neighbor && neighbor !== ref && neighbor.align?.ok) {
    const r = await aligner.call({ type: 'align', id: f.id, refId: neighbor.id, model, iterations, threshPx });
    if (r.ok && r.inliers > (best ? best.inliers * 1.3 : 0)) {
      best = { ...r, H: mul(neighbor.align.H, r.H), via: neighbor.id, inliers: Math.min(r.inliers, neighbor.align.inliers) };
    }
  }
  if (!best) {
    // Rückfall: Transformation des Nachbarn übernehmen (Bild wird markiert)
    const H = neighbor?.align?.H ? neighbor.align.H.slice() : I3();
    return { ok: false, H, inliers: 0, total: direct.matches || 0, rms: Infinity, via: neighbor?.id || null };
  }
  return { ok: true, H: best.H, inliers: best.inliers, total: best.total, rms: best.rms, via: best.via };
}

/** Präzise Neuausrichtung eines Bildes: höhere Auflösung, mehr Merkmale, mehr Iterationen. */
export async function refineFrame(project, aligner, f) {
  const ref = project.ref;
  const need = ANALYSIS.refine.res;
  for (const g of new Set([f, ref])) {
    if (g.featRes >= need) continue;
    const src = await decode(g.file);
    try { g.featRes = await sendFeatures(aligner, g.id, src, 'refine'); } finally { release(src); }
  }
  if (f === ref) return;
  const inc = project.frames.filter(x => x.featRes > 0);
  const i = inc.indexOf(f), ri = inc.indexOf(ref);
  const neighbor = inc[i + (ri > i ? 1 : -1)];
  const r = await alignOne(project, aligner, f, neighbor, { iterations: 5000, threshPx: 2.0 });
  // Nur übernehmen, wenn nicht schlechter
  const old = f.align;
  if (!old || !old.ok || (r.ok && r.inliers * (old.rms || 1) >= old.inliers * 0.8 * (r.rms || 1)) || r.inliers > old.inliers) f.align = r;
  f.manualChecked = false;
  return f.align;
}

/**
 * Misst Helligkeit/Farbe jedes Bildes im endgültigen Zuschnitt (für den Farbangleich).
 * Nutzt einen eigenen kleinen WebGL-Kontext.
 */
export class StatsEngine {
  constructor() {
    this.canvas = makeCanvas(4, 4);
    this.r = new Renderer(this.canvas);
    this.cache = new Map(); // id -> ImageBitmap-Textur vorhanden
  }
  async measure(project, { onProgress, isCancelled, only } = {}) {
    const crop = project.crop;
    if (!crop) return;
    const aspect = crop.w / crop.h;
    const W = 96, H = Math.max(8, Math.round(W / aspect));
    const list = only || project.included;
    let done = 0;
    for (const f of list) {
      if (isCancelled?.()) return;
      const key = 's' + f.id;
      if (!this.r.has(key)) {
        const bmp = await createImageBitmap(f.previewBlob);
        this.r.upload(key, bmp, bmp.width, bmp.height);
        bmp.close?.();
      }
      const L = { key, M: project.layerMatrix(f), weight: 1 };
      this.r.draw([L], { target: { w: W, h: H } });
      f.stats = statsOf(this.r.readTarget());
      this.r.trim(80);
      onProgress?.(++done, list.length);
      if (done % 8 === 0) await new Promise(r => setTimeout(r, 0));
    }
  }
  forget(id) { this.r.drop('s' + id); }
}

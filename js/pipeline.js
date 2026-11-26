// Verarbeitungskette: Import -> Merkmale -> Ausrichtung -> Zuschnitt -> Farbstatistik.

import { readCaptureTime } from './exif.js';
import { decode, sizeOf, release, scaleTo, toBlob, grayOf, grayChromaOf, freeCanvas, makeCanvas } from './images.js';
import { mul, I3, fitModel } from './geometry.js';
import { assignTaps } from './anchors.js';
import { newManual, statsOf } from './project.js';
import { Renderer } from './renderer.js';

const ANALYSIS = { fast: { res: 1024, feats: 3000 }, precise: { res: 1600, feats: 4000 }, refine: { res: 2048, feats: 5000 } };
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
        w, h, thumbUrl: URL.createObjectURL(thumbBlob), thumbBlob, previewBlob,
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

// Auflösung der Graubilder für flächenbasierte Ausrichtung und Ankerpunkte
export const DIRECT_RES = 640;

/** Graubild aus dem Vorschaubild (schnell, kein erneutes Dekodieren des Originals). */
async function grayFromPreview(f, res = DIRECT_RES, withChroma = false) {
  const bmp = await createImageBitmap(f.previewBlob);
  const c = scaleTo(bmp, res);
  bmp.close?.();
  const g = withChroma ? grayChromaOf(c) : grayOf(c);
  freeCanvas(c);
  return g;
}

/** Referenzbild im Worker hinterlegen (für flächenbasierte Ausrichtung und Ankerpunkte). */
export async function setReference(project, aligner) {
  const ref = project.ref;
  if (!ref || aligner.refSet === ref.id) return;
  const g = await grayFromPreview(ref, DIRECT_RES, true);
  await aligner.call({ type: 'setRef', id: ref.id, gray: g.gray.buffer, chroma: g.chroma.buffer, w: g.w, h: g.h }, [g.gray.buffer, g.chroma.buffer]);
  aligner.refSet = ref.id;
}

/** Richtet alle Bilder auf das Referenzbild aus. */
export async function alignAll(project, aligner, { onProgress, isCancelled } = {}) {
  const prevRef = project.refId;
  project.chooseReference();
  const ref = project.ref;
  const list = project.frames.filter(f => f.featRes > 0);
  const ri = list.indexOf(ref);
  if (ri < 0) throw new Error('Referenzbild hat keine Merkmale.');
  // Ankerpunkte bleiben nur bei gleicher Referenz erhalten (müssen neu gesucht werden)
  project.resetAnchors(prevRef === project.refId);
  await setReference(project, aligner);
  ref.align = { ok: true, H: I3(), inliers: Infinity, total: 0, rms: 0, ncc: 1, method: 'ref', via: null };
  // Von der Referenz nach außen arbeiten, damit Nachbarn als Startwert dienen können
  const order = [];
  for (let d = 1; d < list.length; d++) {
    if (ri - d >= 0) order.push([ri - d, +1]);
    if (ri + d < list.length) order.push([ri + d, -1]);
  }
  let done = 0;
  for (const [i, toward] of order) {
    if (isCancelled?.()) return false;
    const f = list[i];
    f.align = await alignOne(project, aligner, f, list[i + toward]);
    onProgress?.(++done, order.length);
  }
  // Nicht ausrichtbare Fotos automatisch ausschließen (können manuell wieder aufgenommen werden)
  const auto = [];
  for (const f of list) {
    if (f === ref) continue;
    const unreliable = !f.align.ok;
    if (unreliable && !f.excluded && !f.keepIncluded) { f.excluded = true; f.autoExcluded = true; auto.push(f); }
    else if (!unreliable && f.autoExcluded) { f.excluded = false; f.autoExcluded = false; }
  }
  project.aligned = true;
  return auto;
}

async function alignOne(project, aligner, f, neighbor, { thorough = false } = {}) {
  const ref = project.ref, model = project.settings.model;
  await setReference(project, aligner);
  const g = await grayFromPreview(f);
  const inits = [];
  if (neighbor?.align?.ok) inits.push(neighbor.align.H);   // Nachbarbild ist meist sehr ähnlich
  if (f.align?.ok) inits.push(f.align.H);
  const r = await aligner.call({
    type: 'align', id: f.id, refId: ref.id, model, gray: g.gray.buffer, w: g.w, h: g.h, inits, thorough,
    iterations: thorough ? 5000 : undefined, threshPx: thorough ? 2.0 : undefined,
  }, [g.gray.buffer]);
  if (r.ok) return { ok: true, H: r.H, inliers: r.inliers, total: r.total, rms: r.rms, ncc: r.ncc, method: r.method, ambiguous: r.ambiguous, via: null };
  // Rückfall: Merkmale zum Nachbarbild, verkettet
  if (neighbor && neighbor !== ref && neighbor.align?.ok) {
    const c = await aligner.call({ type: 'align', id: f.id, refId: neighbor.id, model });
    if (c.ok && c.inliers >= 20) {
      return { ok: true, H: mul(neighbor.align.H, c.H), inliers: c.inliers, total: c.total, rms: c.rms, ncc: null, method: 'kette', via: neighbor.id };
    }
  }
  const H = neighbor?.align?.H ? neighbor.align.H.slice() : I3();
  return { ok: false, H, inliers: 0, total: r.total || r.matches || 0, rms: Infinity, ncc: r.ncc, method: r.method, via: neighbor?.id || null };
}

/** Präzise Neuausrichtung eines Bildes: mehr Merkmale, gründlichere Flächensuche. */
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
  const old = f.align;
  const r = await alignOne(project, aligner, f, neighbor, { thorough: true });
  // Nur übernehmen, wenn nicht schlechter
  const q = a => (a?.ok ? (a.ncc ?? 0) + Math.min(a.inliers || 0, 200) / 1000 : -1);
  if (q(r) >= q(old) - 1e-4) f.align = r;
  f.manualChecked = false;
  return f.align;
}

// ---------- Ankerpunkte ----------

/** Eindeutigkeit der Ankerpunkte im Referenzbild (0..1). */
export async function anchorUniqueness(project, aligner) {
  await setReference(project, aligner);
  const r = await aligner.call({ type: 'uniq', refId: project.refId, anchors: project.anchors.map(a => ({ x: a.x, y: a.y })) });
  r.values?.forEach((v, k) => { if (project.anchors[k]) Object.assign(project.anchors[k], { uniq: v.value, uniqReason: v.reason }); });
}

/**
 * Verfeinert die Ausrichtung aus Ankerpunkten per Flächenvergleich (Perspektive, Subpixel).
 * Übernahme nur, wenn sie flächig nicht schlechter ist und die Punkte grob passen
 * (gefundene Punkte: 4 % der Bildgröße, von Hand gesetzte: 1 %).
 */
/** Bereich der Fixpunkte im Referenzbild: konvexe Hülle, um 60 % um den Schwerpunkt vergrößert. */
export function anchorRegion(project) {
  const P = project.anchors.map(a => [a.x, a.y]);
  if (P.length < 2) return null;
  if (P.length === 2) {
    // Zwei Punkte: Rechteck um die Verbindungslinie (beidseitig verbreitert)
    const [[x1, y1], [x2, y2]] = P, dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux, e = 0.35 * L, wdt = 0.45 * L;
    return [[x1 - ux * e + nx * wdt, y1 - uy * e + ny * wdt], [x2 + ux * e + nx * wdt, y2 + uy * e + ny * wdt],
      [x2 + ux * e - nx * wdt, y2 + uy * e - ny * wdt], [x1 - ux * e - nx * wdt, y1 - uy * e - ny * wdt]];
  }
  const pts = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of pts.slice().reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  const hull = lo.slice(0, -1).concat(hi.slice(0, -1));
  if (hull.length < 3) return null;
  const cx = hull.reduce((a, p) => a + p[0], 0) / hull.length, cy = hull.reduce((a, p) => a + p[1], 0) / hull.length;
  return hull.map(([x, y]) => [cx + (x - cx) * 1.6, cy + (y - cy) * 1.6]);
}

export async function refineAnchored(project, aligner, f) {
  const a = f.align;
  if (!a?.ok || a.method !== 'anker' || f.id === project.refId || !f.anchorHyps?.length) return false;
  await setReference(project, aligner);
  const hyps = f.anchorHyps.map(h => ({
    H: h.H,
    pairs: h.set.map(k => ({ fx: f.anchorPts[k].x, fy: f.anchorPts[k].y, rx: project.anchors[k].x, ry: project.anchors[k].y })),
  }));
  const g = await grayFromPreview(f);
  const manual = f.anchorPts.some(p => p?.manual);
  const tolPx = (manual ? 0.01 : 0.04) * DIRECT_RES;
  const r = await aligner.call({ type: 'refineAnchored', refId: project.refId, gray: g.gray.buffer, w: g.w, h: g.h, hyps, model: project.settings.model, tolPx, roi: anchorRegion(project) }, [g.gray.buffer]);
  if (f.align !== a || !r.ok) return false; // inzwischen geändert (z. B. erneut gezogen)
  // Passt die automatische Ausrichtung flächig klar besser, bleibt sie – außer der Nutzer
  // hat Punkte von Hand gesetzt (dann gilt seine Vorgabe).
  const auto = f.autoAlign;
  if (!manual && auto?.ok && auto.ncc != null && auto.ncc >= 0.85 && auto.ncc > (r.ncc ?? 0) + 0.02) {
    project.keepAutoOverAnchors(f);
    return false;
  }
  project.chooseAnchorHyp(f, r.idx, r.H, r.ncc);
  f.align.refined = r.refined;
  return true;
}

/**
 * Fixpunkte von Hand: Ab zwei getippten Punkten ergibt sich Drehung (beliebig, auch 90°/180°),
 * Zoom und Lage. Damit werden die übrigen Punkte gesucht und getippte Punkte auf die exakte
 * Stelle eingerastet (Fingerungenauigkeit). Gezogene Punkte („pinned“) bleiben, wo sie sind.
 */
export async function snapFrameAnchors(project, aligner, f) {
  const pts = f.anchorPts || [];
  const man = [];
  pts.forEach((p, k) => { if (p?.manual && project.anchors[k]) man.push(k); });
  if (man.length < 2) return false;
  const src = [], dst = [];
  pts.forEach((p, k) => { src.push(p?.x ?? 0, p?.y ?? 0); dst.push(project.anchors[k]?.x ?? 0, project.anchors[k]?.y ?? 0); });
  const Hs = fitModel('similarity', src, dst, man);
  if (!Hs) return false;
  await setReference(project, aligner);
  const g = await grayFromPreview(f);
  const anchors = project.anchors.map(a => ({ x: a.x, y: a.y }));
  // Zwei Durchgänge: 1. grob (Vorhersage aus Fingertipps, weite Toleranz),
  // 2. genau (Vorhersage aus den sicher gefundenen Punkten)
  let pred = Hs;
  for (let pass = 0; pass < 2; pass++) {
    const gray = g.gray.slice().buffer;
    const r = await aligner.call({ type: 'track', id: f.id, refId: project.refId, gray, w: g.w, h: g.h, anchors, predH: pred, wide: pass === 0 }, [gray]);
    if (!r.ok || f.anchorPts !== pts) return false;
    r.points.forEach((q, k) => {
      const p = pts[k];
      if (p?.manual) {
        if (p.pinned) return;
        const tx = p.tapX ?? p.x, ty = p.tapY ?? p.y;
        // einrasten, wenn sicher gefunden und nahe am Tipp (≤ 3 % der langen Bildkante)
        if (q.score >= 0.45 && Math.hypot(q.x - tx, q.y - ty) <= 0.03) pts[k] = { ...p, x: q.x, y: q.y, tapX: tx, tapY: ty, snapped: true, snapScore: q.score };
        else pts[k] = { ...p, x: tx, y: ty, tapX: tx, tapY: ty, snapped: false };
      } else {
        pts[k] = { x: q.x, y: q.y, score: q.score, manual: false };
      }
    });
    project.applyAnchors(f);
    if (!f.align?.ok) break;
    pred = f.align.H;
  }
  // Feinausrichtung per Flächenvergleich im Bereich der Fixpunkte (Drehung kommt aus den Punkten)
  if (f.align?.ok && f.align.method === 'anker') await refineAnchored(project, aligner, f);
  return true;
}

/**
 * Hauptweg: Punkte einmal im Bezugsfoto setzen -> Lapse findet sie in allen Fotos
 * (beliebige Drehung/Zoom), richtet danach aus und verfeinert im Bereich der Punkte.
 * Rückgabe: { ok: [Fotos], failed: [Fotos] } oder false bei Abbruch.
 */
export async function alignByAnchors(project, aligner, { onProgress, isCancelled } = {}) {
  const ref = project.ref;
  await setReference(project, aligner);
  const anchors = project.anchors.map(a => ({ x: a.x, y: a.y }));
  const list = project.frames.filter(f => f !== ref);
  ref.align = { ok: true, H: I3(), inliers: Infinity, total: 0, rms: 0, ncc: 1, method: 'ref', via: null };
  ref.anchorPts = null; ref.autoAlign = null;
  const ok = [], failed = [];
  let done = 0;
  for (const f of list) {
    if (isCancelled?.()) return false;
    f.autoAlign = null; f.anchorPts = null; f.align = null;
    f.manual = { ...f.manual, dx: 0, dy: 0, rot: 0, scale: 1 };
    const g = await grayFromPreview(f, DIRECT_RES, true);
    const r = await aligner.call({ type: 'locate', id: f.id, refId: ref.id, gray: g.gray.buffer, chroma: g.chroma.buffer, w: g.w, h: g.h, anchors }, [g.gray.buffer, g.chroma.buffer]);
    f.geoSupport = r.ok ? r.geoSupport : 0;
    if (r.ok) {
      f.anchorPts = r.points.map(p => ({ x: p.x, y: p.y, score: p.score, manual: false, blob: !!p.blob }));
      project.applyAnchors(f);
      // Flächige Verfeinerung nur, wenn das Aussehen zuverlässig ist (nicht bei Lage aus der Anordnung)
      if (f.align?.ok && r.source !== 'anordnung') await refineAnchored(project, aligner, f);
    }
    const sure = (f.anchorPts || []).filter(p => !p.outlier && p.score >= 0.55).length;
    if (f.align?.ok && f.align.used >= 2 && sure >= 2) {
      ok.push(f);
      if (f.autoExcluded) { f.excluded = false; f.autoExcluded = false; }
    } else {
      // nicht sicher gefunden: vorerst aus dem Video nehmen, in „Fotos“ korrigierbar
      if (!f.align) f.align = { ok: false, H: I3(), inliers: 0, ncc: null, method: 'anker', used: 0, anchorScore: 0 };
      if (!f.anchorPts && r.predH) f.anchorPts = null;
      if (!f.excluded) { f.excluded = true; f.autoExcluded = true; }
      failed.push(f);
    }
    onProgress?.(++done, list.length);
  }
  project.anchorsActive = true;
  project.aligned = true;
  return { ok, failed };
}

/**
 * Korrektur per Antippen: 3+ Flocken in beliebiger Reihenfolge -> Zuordnung über die Abstände,
 * dann alle Punkte auf die passenden Flocken setzen und neu ausrichten.
 * Rückgabe: { ok, reason } (reason: 'nomatch' | 'ambiguous').
 */
export async function correctByTaps(project, aligner, f, taps) {
  const anchors = project.anchors.map(a => ({ x: a.x, y: a.y }));
  const as = assignTaps(taps, anchors, fitModel);
  if (!as || as.rms > 0.03) return { ok: false, reason: 'nomatch' };
  await setReference(project, aligner);
  const g = await grayFromPreview(f, DIRECT_RES, true);
  // Jede plausible Zuordnung am Bild prüfen: Bei der richtigen liegen auch die
  // nicht angetippten Punkte auf Flocken
  let best = null;
  for (const cand of as.alternatives) {
    const gray = g.gray.slice().buffer, chroma = g.chroma.slice().buffer;
    const r = await aligner.call({ type: 'snapTaps', refId: project.refId, gray, chroma, w: g.w, h: g.h, anchors, taps, map: cand.map, H: cand.H }, [gray, chroma]);
    if (!r.ok) continue;
    const others = r.points.filter(p => !p.tapped && p.snapped).length, tapped = r.points.filter(p => p.tapped && p.snapped).length;
    const score = others * 2 + tapped - cand.rms * 20;
    if (!best || score > best.score) best = { score, r, others };
  }
  if (!best) return { ok: false, reason: 'nomatch' };
  if (anchors.length > taps.length && best.others === 0 && as.ambiguous) return { ok: false, reason: 'ambiguous' };
  const r = best.r;
  if (!f.autoAlign) f.autoAlign = f.align;
  f.anchorPts = r.points.map(p => (p.tapped
    ? { x: p.x, y: p.y, score: 1, manual: true, snapped: p.snapped, pinned: false, tapX: p.x, tapY: p.y }
    : p.snapped ? { x: p.x, y: p.y, score: 0.6, manual: false } : { x: p.x, y: p.y, score: 0, manual: false, pred: true }));
  f.geoSupport = r.points.filter(p => p.snapped).length;
  project.applyAnchors(f);
  project.anchorsActive = true;
  return { ok: !!f.align?.ok };
}

/** Sucht die Ankerpunkte in allen Fotos und richtet danach aus. */
export async function trackAllAnchors(project, aligner, { onProgress, isCancelled } = {}) {
  const ref = project.ref;
  await setReference(project, aligner);
  const list = project.frames.filter(f => f.featRes > 0);
  const ri = list.indexOf(ref);
  const order = [];
  for (let d = 1; d < list.length; d++) {
    if (ri - d >= 0) order.push([ri - d, +1]);
    if (ri + d < list.length) order.push([ri + d, -1]);
  }
  const anchors = project.anchors.map(a => ({ x: a.x, y: a.y }));
  const trackOne = async (f, pred) => {
    const g = await grayFromPreview(f);
    const r = await aligner.call({ type: 'track', id: f.id, refId: ref.id, gray: g.gray.buffer, w: g.w, h: g.h, anchors, predH: pred }, [g.gray.buffer]);
    const old = f.anchorPts || [];
    f.anchorPts = r.points.map((p, k) => (old[k]?.manual ? old[k] : { x: p.x, y: p.y, score: p.score, manual: false }));
    project.applyAnchors(f);
    await refineAnchored(project, aligner, f);
  };
  // 1. Durchgang: Vorhersage aus eigener Automatik, sonst vom Nachbarn
  const second = [];
  let done = 0;
  const total = order.length;
  for (const [i, toward] of order) {
    if (isCancelled?.()) return false;
    const f = list[i], nb = list[i + toward];
    const auto = f.autoAlign || f.align;
    const reliable = auto?.ok && (auto.ncc ?? 0) >= 0.85;
    const pred = auto?.ok ? auto.H : (nb.align?.ok ? nb.align.H : null);
    await trackOne(f, pred);
    if (!reliable && f.align?.ok) second.push(f);
    onProgress?.(++done, total + second.length);
  }
  // 2. Durchgang: mit der jetzt guten Lage als Vorhersage -> Punkte subpixelgenau
  for (const f of second) {
    if (isCancelled?.()) return false;
    await trackOne(f, f.align.H);
    onProgress?.(++done, total + second.length);
  }
  project.anchorsActive = true;
  return true;
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

// Einblendungen im Video (Vorschau und Export identisch): derzeit der Maßstabsbalken.
// Der Maßstab wird einmal im Bezugsfoto kalibriert (zwei Punkte mit bekanntem Abstand)
// und gilt nach dem Ausrichten für alle Fotos, weil alle in die Lage des Bezugsfotos gebracht werden.

const NICE = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
import { drawSevenSeg, sevenSegWidth, fmtElapsed, fmtClockTime } from './sevenseg.js';

const FONT = '"SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** Millimeter je kanonischer Einheit (Bezugsfoto, Länge relativ zur langen Kante) oder null. */
export function mmPerUnit(project) {
  const s = project.scale;
  if (!s || !(s.mm > 0) || !s.p1 || !s.p2 || (s.refId && s.refId !== project.refId)) return null;
  const d = Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y);
  return d > 1e-4 ? s.mm / d : null;
}

/** Runde Balkenlänge (mm) für eine gewünschte Länge. */
export function niceLength(target) {
  let best = NICE[0];
  for (const v of NICE) if (Math.abs(Math.log(v / target)) < Math.abs(Math.log(best / target))) best = v;
  return best;
}

export function fmtLength(mm) {
  const de = v => String(+v.toFixed(2)).replace('.', ',');
  if (mm >= 1000) return de(mm / 1000) + ' m';
  if (mm < 1) return de(mm * 1000) + ' µm';
  return de(mm) + ' mm';
}

const barOn = st => st.scaleBar && st.scaleBar !== 'off';

/** Region of Interest (kanonisch, Bezugsfoto), beschnitten auf den Bildausschnitt – oder null. */
export function roiOf(project, crop = project.crop) {
  const st = project.settings, r = st.roi;
  if (!st.roiOn || !r || !crop) return null;
  const x = Math.max(r.x, crop.x), y = Math.max(r.y, crop.y);
  const w = Math.min(r.x + r.w, crop.x + crop.w) - x, h = Math.min(r.y + r.h, crop.y + crop.h) - y;
  return w > crop.w * 0.03 && h > crop.h * 0.03 ? { x, y, w, h } : null;
}

/**
 * Lage des Zoom-Fensters im Ausgabebild (Pixel, oben links) und die gezeigte Region.
 * Größe: Anteil der Bildbreite (insetSize); Seitenverhältnis = das der Region.
 */
export function insetSpec(project, W, H, crop = project.crop) {
  const roi = roiOf(project, crop);
  if (!roi) return null;
  const st = project.settings, a = roi.w / roi.h, m = Math.round(4.5 * Math.min(W, H) / 100);
  let w = W * (st.insetSize || 0.38), h = w / a;
  if (h > H * 0.62) { h = H * 0.62; w = h * a; }
  if (w > W * 0.62) { w = W * 0.62; h = w / a; }
  w = Math.round(w); h = Math.round(h);
  const pos = st.insetPos || 'tr';
  const off = stackOffset(project, W, H, pos, 'inset');
  const x = pos.endsWith('l') ? m : W - m - w, y = pos.startsWith('t') ? m + off : H - m - off - h;
  // Vergrößerung gegenüber dem Hauptbild: automatisch (Region füllt das Fenster) oder fest (insetZoom).
  // Der Rahmen im Hauptbild bleibt immer die gewählte Region; nur der Bildinhalt im Fenster zoomt
  // (um die Mitte der Region).
  let shown = roi, zoom = w / (roi.w / crop.w * W);
  if (st.insetZoom > 0) {
    zoom = st.insetZoom;
    let rw = w / zoom / W * crop.w, rh = rw / a;
    if (rw > crop.w) { rw = crop.w; rh = rw / a; }
    if (rh > crop.h) { rh = crop.h; rw = rh * a; }
    const cx = roi.x + roi.w / 2, cy = roi.y + roi.h / 2;
    shown = { x: Math.min(Math.max(cx - rw / 2, crop.x), crop.x + crop.w - rw), y: Math.min(Math.max(cy - rh / 2, crop.y), crop.y + crop.h - rh), w: rw, h: rh };
    zoom = w / (rw / crop.w * W);
  }
  return { roi: shown, frame: roi, rect: { x, y, w, h }, zoom };
}

/** Tatsächlich gezeigte Region und Vergrößerung (für die Bedienung, Bezug Full-HD). */
export function effectiveRoi(project, crop = project.crop) {
  if (!crop) return null;
  const W = 1920, H = Math.round(W * crop.h / crop.w);
  return insetSpec(project, W, H, crop);
}

/** Rahmen in Ausgabepixeln für eine kanonische Region. */
const toPx = (r, crop, W, H) => ({ x: (r.x - crop.x) / crop.w * W, y: (r.y - crop.y) / crop.h * H, w: r.w / crop.w * W, h: r.h / crop.h * H });

/**
 * Ein Videobild vollständig zeichnen: Hauptbild, Region of Interest (vergrößert), Einblendungen.
 * Vorschau und Export nutzen dieselbe Funktion – deshalb sehen beide gleich aus.
 */
export function drawComposite(r, project, layers, { global, W, H, overlay = true } = {}) {
  r.draw(layers, { global });
  const ins = insetSpec(project, W, H);
  if (ins) r.draw(layers.map(L => ({ ...L, M: project.layerMatrix(L.frame, ins.roi) })), { global, viewport: ins.rect, clear: false });
  if (overlay) r.drawOverlay();
  // Zeitanzeige: ändert sich mit jedem Videobild, deshalb eigene kleine Ebene
  const st = stampFor(project, layers, W, H);
  if (st) r.drawImage(st.canvas, st.rect);
  for (const b of infoBlocks(project, layers, W, H)) r.drawImage(b.canvas, b.rect);
}

// ---------- Zeitanzeige ----------

/**
 * Zeitpunkte der Fotos (ms). Quelle: Aufnahmezeit aus den Metadaten (wenn alle Fotos eine haben)
 * oder ein festes Intervall (Einstellung stampInterval, Sekunden). Ergebnis wird zwischengespeichert.
 */
export function frameTimes(project) {
  const st = project.settings, inc = project.included;
  const allMeta = inc.length > 0 && inc.every(f => f.date != null);
  const source = st.stampSource === 'interval' || !allMeta ? (st.stampInterval > 0 ? 'interval' : null) : 'meta';
  const sig = `${inc.length}|${inc[0]?.id}|${inc[inc.length - 1]?.id}|${source}|${st.stampInterval}`;
  if (project._times?.sig === sig) return project._times;
  const map = new Map();
  if (source === 'meta') for (const f of inc) map.set(f, f.date);
  else if (source === 'interval') inc.forEach((f, i) => map.set(f, i * st.stampInterval * 1000));
  const vals = [...map.values()];
  project._times = { sig, source, map, allMeta, t0: vals.length ? Math.min(...vals) : 0, t1: vals.length ? Math.max(...vals) : 0 };
  return project._times;
}

/** Zeit des aktuellen Videobilds: bei Überblendung gewichtet zwischen den Fotos (läuft weich weiter). */
export function timeAt(project, layers) {
  const T = frameTimes(project);
  if (!T.source) return null;
  let sw = 0, sum = 0;
  for (const L of layers) { const v = T.map.get(L.frame); if (v != null) { sum += v * L.weight; sw += L.weight; } }
  return sw ? { t: sum / sw, T } : null;
}

const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
let stampCanvas = null;

/** Zeichnet die digitale Zeitanzeige für dieses Videobild; Rückgabe { canvas, rect } oder null. */
export function stampFor(project, layers, W, H) {
  const st = project.settings;
  if (!st.stampOn || !layers.length) return null;
  const at = timeAt(project, layers);
  if (!at) return null;
  const clock = st.stampMode === 'clock' && at.T.source === 'meta';
  const text = clock ? fmtClockTime(at.t) : fmtElapsed(at.t - at.T.t0);
  const d = new Date(at.t), p2 = n => String(n).padStart(2, '0');
  const label = clock ? `${WD[d.getDay()]} ${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}` : 'T+ LAUFZEIT';
  const u = Math.min(W, H) / 100, dh = Math.max(16, Math.round(5.4 * u)), fs = Math.max(8, Math.round(dh * 0.3)), pad = Math.round(dh * 0.32);
  const cw = Math.ceil(sevenSegWidth(text, dh) + 2 * pad + dh * 0.1), chh = Math.ceil(dh + fs * 1.5 + 2 * pad);
  const c = stampCanvas ||= document.createElement('canvas');
  if (c.width !== cw || c.height !== chh) { c.width = cw; c.height = chh; }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, cw, chh);
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(0, 0, cw, chh, Math.round(u)); else ctx.rect(0, 0, cw, chh); ctx.fill();
  ctx.font = `600 ${fs}px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.textBaseline = 'top';
  ctx.fillText(label, pad, pad * 0.8);
  drawSevenSeg(ctx, text, pad, pad * 0.8 + fs * 1.5, dh);
  const m = Math.round(4.5 * u), pos = st.stampPos || 'tr', off = stackOffset(project, W, H, pos, 'stamp');
  const x = pos.endsWith('l') ? m : W - m - cw, y = pos.startsWith('t') ? m + off : H - m - off - chh;
  return { canvas: c, rect: { x, y, w: cw, h: chh } };
}

// ---------- Datenanzeige (wie auf der Startseite) und Anordnung in den Ecken ----------

const GAP = u => Math.round(1.5 * u);
const infoFont = u => Math.max(9, Math.round(2.5 * u));

/** Zeilen der Datenblöcke je Ecke (ohne Werte, die sich je Videobild ändern). */
function infoLines(project) {
  const st = project.settings, T = frameTimes(project), out = { tl: [], bl: [], br: [] };
  if (st.probeOn) out.tl.push('probe');
  if (st.nameOn && (st.nameText || '').trim()) out.tl.push('name');
  if (st.areaOn) out.bl.push('area', 'growth');
  if (st.dishOn) out.br.push('dish');
  if (st.dateOn && T.source === 'meta') out.br.push('date');
  return out;
}

/** Größe (Höhe) eines Elements in einer Ecke – für das Stapeln. */
function itemHeight(project, W, H, kind, corner) {
  const u = Math.min(W, H) / 100, st = project.settings;
  if (kind === 'info') {
    const n = (infoLines(project)[corner] || []).length;
    if (!n) return 0;
    const fs = infoFont(u);
    return Math.round(fs * 1.5 * n + 2 * Math.round(1.1 * u));
  }
  if (kind === 'stamp') {
    if (!st.stampOn || (st.stampPos || 'tr') !== corner || !frameTimes(project).source) return 0;
    const dh = Math.max(16, Math.round(5.4 * u)), fs = Math.max(8, Math.round(dh * 0.3)), pad = Math.round(dh * 0.32);
    return Math.ceil(dh + fs * 1.5 + 2 * pad);
  }
  if (kind === 'bar') {
    if (!barOn(st) || st.scaleBar !== corner || !mmPerUnit(project)) return 0;
    const th = Math.max(5, 2.6 * u), fs = Math.max(10, 3.3 * u), pad = 1.6 * u;
    return Math.ceil(th + 0.8 * u + fs * 1.05 + pad * 1.6);
  }
  return 0;
}

/** Abstand vom Bildrand, ab dem ein Element in seiner Ecke beginnt (Reihenfolge: Daten, Zeit, Maßstab, Region). */
export function stackOffset(project, W, H, corner, kind) {
  const order = ['info', 'stamp', 'bar', 'inset'], u = Math.min(W, H) / 100;
  let off = 0;
  for (const k of order) {
    if (k === kind) break;
    const h = itemHeight(project, W, H, k, corner);
    if (h) off += h + GAP(u);
  }
  return off;
}

/** Flächenanteil des aktuellen Videobilds (bei Überblendung gewichtet). */
function areaAt(project, layers) {
  let sw = 0, sum = 0;
  for (const L of layers) if (L.frame?.area != null) { sum += L.frame.area * L.weight; sw += L.weight; }
  return sw ? sum / sw : null;
}

let infoCanvas = null;
const de = (v, d = 1) => v.toFixed(d).replace('.', ',');

/** Datenblöcke für dieses Videobild zeichnen: [{ canvas, rect }] (Canvas wird je Block neu benutzt). */
export function* infoBlocks(project, layers, W, H) {
  const st = project.settings, lines = infoLines(project), u = Math.min(W, H) / 100;
  const fs = infoFont(u), pad = Math.round(1.1 * u), m = Math.round(4.5 * u), lh = Math.round(fs * 1.5);
  const k = mmPerUnit(project), crop = project.crop;
  const first = project.included.find(f => f.area != null);
  for (const corner of ['tl', 'bl', 'br']) {
    const L = lines[corner];
    if (!L.length) continue;
    const rows = [];
    for (const kind of L) {
      if (kind === 'probe') rows.push([`PROBE ${(st.probeText || '01').trim()}`, true]);
      else if (kind === 'name') rows.push([st.nameText.trim(), false]);
      else if (kind === 'dish') rows.push([`SCHALE ${(st.dishText || '').trim() || '–'}`, false]);
      else if (kind === 'date') {
        const at = timeAt(project, layers);
        if (at) { const d = new Date(at.t), p2 = n => String(n).padStart(2, '0'); rows.push([`${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`, false]); }
      } else if (kind === 'area') {
        const a = areaAt(project, layers);
        if (a == null) continue;
        if (k && crop) {
          const mm2 = a * crop.w * crop.h * k * k;
          rows.push([`FLÄCHE ${mm2 >= 100 ? de(mm2 / 100, 2) + ' CM²' : de(mm2, 1) + ' MM²'}`, false]);
        } else rows.push([`FLÄCHE ${de(a * 100)} %`, false]);
      } else if (kind === 'growth') {
        const a = areaAt(project, layers);
        if (a == null || !first?.area) continue;
        const g = (a / first.area - 1) * 100;
        rows.push([`WACHSTUM ${g >= 0 ? '+' : '−'}${de(Math.abs(g), 0)} %`, false]);
      }
    }
    if (!rows.length) continue;
    const c = infoCanvas ||= document.createElement('canvas'), ctx = c.getContext('2d');
    ctx.font = `600 ${fs}px ${FONT}`;
    const tw = Math.max(...rows.map(([t]) => ctx.measureText(t.toUpperCase()).width + t.length * fs * 0.06));
    const cw = Math.ceil(tw + 2 * pad), chh = itemHeight(project, W, H, 'info', corner);
    if (c.width !== cw || c.height !== chh) { c.width = cw; c.height = chh; }
    ctx.clearRect(0, 0, cw, chh);
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(0, 0, cw, chh, Math.round(u)); else ctx.rect(0, 0, cw, chh); ctx.fill();
    ctx.font = `600 ${fs}px ${FONT}`; ctx.textBaseline = 'middle';
    const right = corner.endsWith('r');
    ctx.textAlign = right ? 'right' : 'left';
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(fs * 0.06).toFixed(1)}px`;
    rows.forEach(([t, accent], i) => {
      ctx.fillStyle = accent ? '#f3c08a' : i === 0 ? 'rgba(255,255,255,.95)' : 'rgba(215,227,234,.85)';
      ctx.fillText(t.toUpperCase(), right ? cw - pad : pad, pad + lh * (i + 0.5));
    });
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    const x = right ? W - m - cw : m, y = corner.startsWith('t') ? m : H - m - chh;
    yield { canvas: c, rect: { x, y, w: cw, h: chh } };
  }
}

/** Kennung des aktuellen Zustands – ändert sie sich, muss die Einblendung neu gezeichnet werden. */
export function overlaySig(project, W, H, crop = project.crop) {
  if (!crop) return 'none';
  const st = project.settings;
  const k = mmPerUnit(project), ins = insetSpec(project, W, H, crop);
  const scale = k && (barOn(st) || st.ruler);
  if (!scale && !ins) return 'none';
  const lay = ['probeOn', 'nameOn', 'areaOn', 'dishOn', 'dateOn', 'stampOn', 'stampPos'].map(k => st[k] ? String(st[k]) : '-').join(',') + (st.nameText ? 'n' : '');
  return `${lay}|${W}x${H}|${scale ? (barOn(st) ? st.scaleBar : '-') + (st.ruler ? 'R' : '-') + k.toFixed(6) : 'noscale'}|${crop.x.toFixed(5)},${crop.y.toFixed(5)},${crop.w.toFixed(5)}|${ins ? JSON.stringify(ins.rect) + JSON.stringify(ins.roi) : 'noroi'}`;
}

/**
 * Zeichnet die Einblendungen in Ausgabegröße W×H (transparent) oder liefert null.
 * crop: Bildausschnitt (Standard: der aktuelle des Projekts; im Zuschnitt-Editor der gerade gezogene).
 */
export function makeOverlay(project, W, H, crop = project.crop) {
  if (overlaySig(project, W, H, crop) === 'none') return null;
  const st = project.settings, k = mmPerUnit(project);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const u = Math.min(W, H) / 100;                      // Grundmaß relativ zur Bildgröße
  const ins = insetSpec(project, W, H, crop);
  if (k && st.ruler) drawRuler(ctx, W, H, u, k * crop.w / W);
  if (ins) drawInsetFrames(ctx, ins, crop, W, H, u);
  if (k && barOn(st)) drawBar(ctx, W, H, u, k * crop.w / W, st.scaleBar, stackOffset(project, W, H, st.scaleBar, 'bar'));
  return c;
}

/** Dezenter weißer Kasten um die Region im Hauptbild und um die vergrößerte Darstellung, dazu der Faktor. */
function drawInsetFrames(ctx, ins, crop, W, H, u) {
  const R = toPx(ins.frame, crop, W, H), I = ins.rect;
  ctx.save();
  const box = (x, y, w, h, lw) => {
    ctx.lineWidth = lw + Math.max(1, 0.25 * u); ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.strokeRect(x, y, w, h);
    ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(255,255,255,.88)'; ctx.strokeRect(x, y, w, h);
  };
  box(Math.round(R.x) + 0.5, Math.round(R.y) + 0.5, Math.round(R.w), Math.round(R.h), Math.max(1, 0.22 * u));
  box(I.x + 0.5, I.y + 0.5, I.w - 1, I.h - 1, Math.max(1.5, 0.3 * u));
  // Zoomfaktor im Fenster
  const fs = Math.max(9, 2.4 * u), txt = `${String(+ins.zoom.toFixed(1)).replace('.', ',')}×`;
  ctx.font = `600 ${fs}px ${FONT}`;
  const tw = ctx.measureText(txt).width, pad = 0.8 * u;
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.fillRect(I.x + I.w - tw - 2 * pad - 0.6 * u, I.y + I.h - fs - 1.4 * pad - 0.6 * u, tw + 2 * pad, fs + 1.4 * pad);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'right';
  ctx.fillText(txt, I.x + I.w - pad - 0.6 * u, I.y + I.h - 0.7 * pad - 0.6 * u);
  ctx.restore();
}

/** Maßstabsbalken mit runder Länge, unten links (bl) oder rechts (br). */
function drawBar(ctx, W, H, u, mmPerPx, pos, off = 0) {
  const L = niceLength(W * 0.2 * mmPerPx), len = L / mmPerPx;
  const m = Math.round(4.5 * u), bh = Math.max(2, 0.8 * u), th = Math.max(5, 2.6 * u);
  const x0 = pos === 'br' ? W - m - len - 1.6 * u : m + 1.6 * u, y = H - m - off - 1.6 * u;
  const fs = Math.max(10, 3.3 * u);
  ctx.save();
  ctx.font = `600 ${fs}px ${FONT}`;
  const text = fmtLength(L);
  // dunkle Unterlage – lesbar auf hellem wie dunklem Untergrund
  const tw = ctx.measureText(text).width, pad = 1.6 * u;
  const bx = (pos === 'br' ? Math.min(x0, x0 + len - tw) : x0) - pad, bw = Math.max(len, tw) + 2 * pad;
  const by = y - th - 0.8 * u - fs * 1.05 - pad * 0.6, bhh = y + pad - by;
  ctx.fillStyle = 'rgba(0,0,0,.42)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bhh, u); else ctx.rect(bx, by, bw, bhh);
  ctx.fill();
  ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = Math.max(1, 0.5 * u);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x0, y - bh, len, bh);
  ctx.fillRect(x0, y - th, Math.max(2, bh * 0.75), th);
  ctx.fillRect(x0 + len - Math.max(2, bh * 0.75), y - th, Math.max(2, bh * 0.75), th);
  ctx.fillRect(x0 + len / 2 - Math.max(1, bh * 0.35), y - th * 0.6, Math.max(2, bh * 0.7), th * 0.6);
  ctx.textBaseline = 'bottom';
  ctx.textAlign = pos === 'br' ? 'right' : 'left';
  ctx.fillText(text, pos === 'br' ? x0 + len : x0, y - th - 0.8 * u);
  ctx.restore();
}

/**
 * Lineal: eine Grundlinie quer durch die Bildmitte, Striche stehen nach oben –
 * lang für cm, mittel für 0,5 cm, kurz für mm. Keine Zahlen. Nullpunkt links.
 * Bei sehr starker oder schwacher Vergrößerung verschiebt sich die Teilung um Zehnerstufen
 * (z. B. 1 mm / 0,5 mm / 0,1 mm), damit die Striche erkennbar bleiben.
 */
function drawRuler(ctx, W, H, u, mmPerPx) {
  const pxPerMm = 1 / mmPerPx;
  let unit = 10;                                        // Hauptteilung in mm (Standard: 1 cm)
  while (unit / 10 * pxPerMm < 3 && unit < 1e5) unit *= 10;   // feinste Striche mind. ~3 px auseinander
  while (unit * pxPerMm > W * 0.6 && unit > 1e-3) unit /= 10; // mind. ~2 Hauptstriche im Bild
  const fine = unit / 10, step = fine * pxPerMm;
  const showFine = step >= 3, showHalf = step * 5 >= 3;
  const y = Math.round(H / 2) + 0.5, x0 = Math.max(1, 1.2 * u);
  const Lc = Math.max(8, 4.2 * u), Lh = Lc * 0.62, Lm = Lc * 0.34;
  // Strichliste: [x1, y1, x2, y2, Breite]
  const segs = [[0, y, W, y, Math.max(1, 0.2 * u)]];
  const n = Math.floor((W - x0) / step);
  for (let i = 0; i <= n; i++) {
    const cm = i % 10 === 0, half = i % 10 === 5;
    if (!cm && !half && !showFine) continue;
    if (half && !showHalf) continue;
    const x = Math.round(x0 + i * step) + 0.5;
    segs.push([x, y, x, y - (cm ? Lc : half ? Lh : Lm), Math.max(1, (cm ? 0.2 : half ? 0.16 : 0.12) * u)]);
  }
  ctx.save();
  ctx.lineCap = 'square';
  // erst dunkle Kontur (lesbar auf hellem Papier), dann helle Linie (lesbar auf Dunklem)
  for (const [col, extra] of [['rgba(0,0,0,.38)', Math.max(1.5, 0.22 * u)], ['rgba(255,255,255,.9)', 0]]) {
    ctx.strokeStyle = col;
    for (const lw of [...new Set(segs.map(q => q[4]))]) {
      ctx.lineWidth = lw + extra;
      ctx.beginPath();
      for (const [a, b, c, d, w] of segs) if (w === lw) { ctx.moveTo(a, b); ctx.lineTo(c, d); }
      ctx.stroke();
    }
  }
  ctx.restore();
}

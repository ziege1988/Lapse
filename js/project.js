// Projektmodell: Bilder, Einstellungen und alle daraus abgeleiteten Berechnungen
// (Gesamttransformation, Zuschnitt, Farbangleich, Zeitplan des Videos).

import { mul, inv, apply, similarityAbout, largestRect, quadOf, isConvexQuad, halfPlanes, I3 } from './geometry.js';

export const DEFAULT_SETTINGS = {
  // Ausrichtung
  model: 'similarity',      // translation | similarity | homography
  precision: 'fast',        // fast | precise
  refMode: 'middle',        // middle | first | last | manual
  // Bild
  aspect: '16:9',           // 16:9 | 9:16 | 4:3 | 3:4 | 3:2 | 1:1 | original
  zoom: 1,                  // zusätzlicher Zoom >= 1
  colorMode: 'deflicker',   // off | deflicker | reference
  colorStrength: 0.85,
  colorWindow: 9,           // Glättungsfenster (Bilder)
  colorChannels: true,      // Farbe (Weißabgleich) mit angleichen
  exposure: 0, contrast: 1, saturation: 1,
  // Video
  fps: 30,
  pps: 12,                  // Fotos pro Sekunde
  crossfade: true,
  smoothing: 1,             // Bewegungsglättung (Anzahl Fotos)
  pingpong: false,
  holdStart: 0,
  holdEnd: 0.5,
};

export const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3, '3:4': 3 / 4, '3:2': 3 / 2, '1:1': 1 };

export const newManual = () => ({ dx: 0, dy: 0, rot: 0, scale: 1, ev: 0, temp: 0, tint: 0 });

export class Project {
  constructor() {
    this.frames = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this.refId = null;
    this.crop = null;
    this.aligned = false;
  }

  get included() { return this.frames.filter(f => !f.excluded); }
  byId(id) { return this.frames.find(f => f.id === id); }
  get ref() { return this.byId(this.refId); }

  chooseReference() {
    const inc = this.included;
    if (!inc.length) { this.refId = null; return; }
    if (this.settings.refMode === 'manual' && this.ref && !this.ref.excluded) return;
    const m = this.settings.refMode;
    const f = m === 'first' ? inc[0] : m === 'last' ? inc[inc.length - 1] : inc[(inc.length - 1) >> 1];
    this.refId = f.id;
  }

  /** Kanonische Größe eines Bildes (lange Kante = 1). */
  static dims(f) { const m = Math.max(f.w, f.h); return [f.w / m, f.h / m]; }

  /** Manuelle Korrektur als Matrix im Referenzraum (um die Bildmitte der Referenz). */
  manualMatrix(f) {
    const r = this.ref || f, [rw, rh] = Project.dims(r), m = f.manual;
    if (!m.dx && !m.dy && !m.rot && m.scale === 1) return I3();
    return similarityAbout(rw / 2, rh / 2, m.dx * rw / 100, m.dy * rw / 100, m.rot, m.scale);
  }

  /** Bild (kanonisch) -> Referenz (kanonisch), inkl. manueller Korrektur. */
  transform(f) {
    return mul(this.manualMatrix(f), f.align?.H || I3());
  }

  aspectValue() {
    const a = this.settings.aspect;
    if (a === 'original') { const r = this.ref; return r ? r.w / r.h : 16 / 9; }
    return ASPECTS[a] || 16 / 9;
  }

  /** Größter gemeinsamer Bildbereich im gewünschten Seitenverhältnis. */
  computeCrop() {
    const inc = this.included, ref = this.ref;
    if (!inc.length || !ref) { this.crop = null; return null; }
    const polys = [];
    for (const f of inc) {
      const [w, h] = Project.dims(f);
      const q = quadOf(this.transform(f), w, h);
      if (isConvexQuad(q)) polys.push(q);
    }
    const [rw, rh] = Project.dims(ref);
    const aspect = this.aspectValue();
    let rect = largestRect(polys, aspect, [rw / 2, rh / 2]);
    if (!rect) {
      // Notlösung: Referenzbild mittig
      const h = Math.min(rh, rw / aspect);
      rect = { x: (rw - h * aspect) / 2, y: (rh - h) / 2, w: h * aspect, h };
      this.cropFailed = true;
    } else this.cropFailed = false;
    const z = Math.max(1, this.settings.zoom);
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2, w = rect.w / z, h = rect.h / z;
    this.crop = { x: cx - w / 2, y: cy - h / 2, w, h, full: rect };
    return this.crop;
  }

  /**
   * Findet Fotos, die den Ausschnitt deutlich verkleinern (z. B. versehentlich gezoomt
   * oder stark verdreht). Nur die Fotos, deren Kanten den Ausschnitt tatsächlich
   * begrenzen, werden testweise weggelassen – daher auch bei vielen Fotos schnell.
   * Rückgabe: [{ frame, factor }] mit factor = Flächengewinn ohne dieses Foto.
   */
  cropLimiters(minFactor = 1.25) {
    const crop = this.crop, inc = this.included;
    if (!crop || inc.length < 3) return [];
    const r = crop.full, aspect = r.w / r.h;
    const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
    const quads = inc.map(f => { const [w, h] = Project.dims(f); return quadOf(this.transform(f), w, h); });
    const tol = 1e-6 + r.h * 1e-4;
    const binding = [];
    inc.forEach((f, i) => {
      if (f.id === this.refId || f.cropOk) return;
      const planes = halfPlanes(quads[i]);
      const slack = Math.min(...planes.flatMap(([nx, ny, d]) => corners.map(([x, y]) => nx * x + ny * y - d)));
      if (slack < tol) binding.push(i);
    });
    const out = [];
    for (const i of binding.slice(0, 6)) {
      const polys = quads.filter((q, k) => k !== i && isConvexQuad(q));
      const alt = largestRect(polys, aspect, [r.x + r.w / 2, r.y + r.h / 2]);
      if (!alt) continue;
      const factor = (alt.w * alt.h) / (r.w * r.h);
      if (factor >= minFactor) out.push({ frame: inc[i], factor });
    }
    return out.sort((a, b) => b.factor - a.factor);
  }

  /** Matrix: Ausgabe (0..1, y nach unten) -> Texturkoordinaten des Bildes. */
  layerMatrix(f, crop = this.crop) {
    const C = [crop.w, 0, crop.x, 0, crop.h, crop.y, 0, 0, 1];
    const Ti = inv(this.transform(f)) || I3();
    const m = Math.max(f.w, f.h);
    const S = [m / f.w, 0, 0, 0, m / f.h, 0, 0, 0, 1];
    return mul(S, mul(Ti, C));
  }

  /** Farbparameter eines Bildes für den Shader. */
  colorOf(f) {
    const m = f.manual, ev = Math.pow(2, m.ev || 0);
    const t = (m.temp || 0) / 100, g = (m.tint || 0) / 100;
    const mulv = [ev * (1 + 0.25 * t), ev * (1 - 0.18 * g), ev * (1 - 0.25 * t)];
    const c = f.color || { gain: [1, 1, 1], off: [0, 0, 0] };
    return { gain: c.gain, off: c.off, mul: mulv };
  }

  globalParams() {
    const s = this.settings;
    return [Math.pow(2, s.exposure), s.contrast, s.saturation];
  }

  layer(f, weight = 1, keyPrefix = 'p') {
    return { key: keyPrefix + f.id, frame: f, M: this.layerMatrix(f), weight, ...this.colorOf(f) };
  }

  // ---------- Farbangleich ----------

  /** Berechnet Gain/Offset je Bild aus f.stats (vorher via Renderer ermittelt). */
  computeColor() {
    const s = this.settings, inc = this.included.filter(f => f.stats);
    for (const f of this.frames) f.color = { gain: [1, 1, 1], off: [0, 0, 0] };
    if (s.colorMode === 'off' || inc.length < 2) return;
    const series = inc.map(f => s.colorChannels ? f.stats : {
      mean: [f.stats.lmean, f.stats.lmean, f.stats.lmean], std: [f.stats.lstd, f.stats.lstd, f.stats.lstd],
    });
    let targets;
    if (s.colorMode === 'reference') {
      const ri = Math.max(0, inc.findIndex(f => f.id === this.refId));
      targets = series.map(() => series[ri]);
    } else {
      targets = smoothSeries(series, Math.max(3, s.colorWindow | 0));
    }
    const k = s.colorStrength;
    inc.forEach((f, i) => {
      const gain = [0, 0, 0], off = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const m = series[i].mean[c], sd = Math.max(series[i].std[c], 0.004);
        const g = Math.min(1.8, Math.max(0.55, targets[i].std[c] / sd));
        const o = targets[i].mean[c] - g * m;
        gain[c] = 1 + k * (g - 1);
        off[c] = k * o;
      }
      f.color = { gain, off };
    });
  }

  // ---------- Zeitplan ----------

  sequence() {
    const inc = this.included;
    if (!this.settings.pingpong || inc.length < 3) return inc;
    return inc.concat(inc.slice(1, -1).reverse());
  }

  timeline() {
    const s = this.settings, seq = this.sequence(), S = seq.length;
    const main = S / Math.max(0.1, s.pps);
    const total = s.holdStart + main + s.holdEnd;
    const frames = Math.max(1, Math.round(total * s.fps));
    const smooth = s.crossfade || s.smoothing > 1;
    const R = smooth ? Math.max(1, (s.smoothing + 1) / 2) : 0;
    const sample = t => {
      if (!S) return [];
      let x;
      const tt = t - s.holdStart;
      if (tt <= 0) x = 0;
      else if (tt >= main) x = S - 1;
      else x = smooth ? (tt / main) * (S - 1) : Math.min(S - 1, Math.floor(tt * s.pps));
      if (R === 0) return [{ frame: seq[Math.round(x)], weight: 1 }];
      const out = [];
      for (let i = Math.ceil(x - R + 1e-9); i <= Math.floor(x + R - 1e-9); i++) {
        if (i < 0 || i >= S) continue;
        const w = 1 - Math.abs(i - x) / R;
        if (w > 1e-4) out.push({ frame: seq[i], weight: w });
      }
      if (!out.length) out.push({ frame: seq[Math.round(Math.min(S - 1, Math.max(0, x)))], weight: 1 });
      return out;
    };
    return { duration: total, frames, fps: s.fps, sample, sequence: seq };
  }

  // ---------- Qualität ----------

  /** Bewertet die Ausrichtung und erkennt Sprünge gegenüber Nachbarbildern. */
  assessQuality() {
    const inc = this.included, ref = this.ref;
    if (!ref) return;
    const [rw] = Project.dims(ref);
    const centers = inc.map(f => {
      const [w, h] = Project.dims(f);
      return apply(this.transform(f), w / 2, h / 2);
    });
    inc.forEach((f, i) => {
      const a = f.align;
      let q = 'good', note = '';
      if (!a || !a.ok) { q = 'bad'; note = 'Keine sichere Ausrichtung gefunden'; }
      else if (f.id !== this.refId && (a.inliers < 15 || a.rms > 3)) { q = 'bad'; note = 'Sehr wenige übereinstimmende Punkte'; }
      else if (f.id !== this.refId && (a.inliers < 40 || a.rms > 1.8)) { q = 'warn'; note = 'Ausrichtung unsicher'; }
      // Sprungerkennung: Abstand zum Median der Nachbarn
      const nb = [];
      for (let j = Math.max(0, i - 3); j <= Math.min(inc.length - 1, i + 3); j++) if (j !== i) nb.push(centers[j]);
      if (nb.length >= 2 && q !== 'bad') {
        const med = k => nb.map(c => c[k]).sort((x, y) => x - y)[nb.length >> 1];
        const d = Math.hypot(centers[i][0] - med(0), centers[i][1] - med(1));
        if (d > 0.04 * rw) { q = 'warn'; note = 'Sprung gegenüber Nachbarbildern'; }
      }
      f.quality = f.manualChecked ? 'good' : q;
      f.qualityNote = note;
    });
  }
}

/** Robuste zeitliche Glättung: Median, danach gleitender Mittelwert. */
export function smoothSeries(series, win) {
  const n = series.length, r = win >> 1;
  const med = series.map((_, i) => {
    const lo = Math.max(0, i - r), hi = Math.min(n - 1, i + r);
    const res = { mean: [0, 0, 0], std: [0, 0, 0] };
    for (const k of ['mean', 'std']) for (let c = 0; c < 3; c++) {
      const v = [];
      for (let j = lo; j <= hi; j++) v.push(series[j][k][c]);
      v.sort((a, b) => a - b);
      res[k][c] = v[v.length >> 1];
    }
    return res;
  });
  return med.map((_, i) => {
    const lo = Math.max(0, i - r), hi = Math.min(n - 1, i + r);
    const res = { mean: [0, 0, 0], std: [0, 0, 0] };
    let wsum = 0;
    for (let j = lo; j <= hi; j++) {
      const w = 1 - Math.abs(j - i) / (r + 1);
      wsum += w;
      for (const k of ['mean', 'std']) for (let c = 0; c < 3; c++) res[k][c] += med[j][k][c] * w;
    }
    for (const k of ['mean', 'std']) for (let c = 0; c < 3; c++) res[k][c] /= wsum;
    return res;
  });
}

/** Statistik aus RGBA-Bytes. */
export function statsOf(px) {
  const n = px.length / 4;
  const sum = [0, 0, 0], sq = [0, 0, 0];
  let ls = 0, lq = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    sum[0] += r; sum[1] += g; sum[2] += b;
    sq[0] += r * r; sq[1] += g * g; sq[2] += b * b;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    ls += l; lq += l * l;
  }
  const mean = sum.map(v => v / n), std = sq.map((v, c) => Math.sqrt(Math.max(0, v / n - mean[c] ** 2)));
  const lmean = ls / n, lstd = Math.sqrt(Math.max(0, lq / n - lmean * lmean));
  return { mean, std, lmean, lstd };
}

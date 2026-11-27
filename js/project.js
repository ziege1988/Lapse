// Projektmodell: Bilder, Einstellungen und alle daraus abgeleiteten Berechnungen
// (Gesamttransformation, Zuschnitt, Farbangleich, Zeitplan des Videos).

import { mul, inv, apply, similarityAbout, largestRect, quadOf, isConvexQuad, halfPlanes, fitModel, I3 } from './geometry.js';

export const DEFAULT_SETTINGS = {
  // Ausrichtung
  model: 'homography',      // translation (Stativ) | similarity (leicht bewegt) | homography (Freihand)
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
  scaleBar: 'off',          // Maßstab im Video: off | bl (unten links) | br (unten rechts)
  scalePos: 'bl',           // gemerkte Position des Balkens
  ruler: false,             // Lineal (Zollstock) quer durch die Bildmitte
  roiOn: false,             // Zoom-Ausschnitt (Region of Interest) im Video zeigen
  roi: null,                // Region {x, y, w, h} im Bezugsfoto (kanonisch)
  insetPos: 'tr',           // Ecke des Zoom-Fensters: tl | tr | bl | br
  insetSize: 0.38,          // Breite des Zoom-Fensters (Anteil der Videobreite)
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
    this.anchors = [];          // Ankerpunkte im Referenzbild (kanonisch): [{x, y, uniq}]
    this.anchorsActive = false; // Ausrichtung kommt aus den Ankerpunkten
    this.customCrop = null;     // eigener Bildausschnitt {x, y, w, h, key} im Bezugsfoto (kanonisch)
    this.scale = null;          // Maßstab: {p1, p2, mm, refId} – zwei Punkte im Bezugsfoto mit bekanntem Abstand
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
    // Eigener Ausschnitt: übernehmen, falls nötig in den gültigen Bereich einpassen
    if (this.customCrop) {
      const quads = this.validQuads();
      let r = { x: this.customCrop.x, y: this.customCrop.y, w: this.customCrop.w, h: this.customCrop.h };
      if (!Project.rectInside(quads, r)) r = Project.fitRect(quads, r);
      if (r && r.w > 0.01 && r.h > 0.01) {
        this.crop = { ...r, full: rect, custom: true };
        return this.crop;
      }
    }
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

  // ---------- Eigener Ausschnitt ----------

  /** Umrisse aller Fotos im Bezugsfoto – innerhalb aller liegt der randfreie Bereich. */
  validQuads() {
    return this.included.map(f => { const [w, h] = Project.dims(f); return quadOf(this.transform(f), w, h); }).filter(isConvexQuad);
  }

  static pointInQuad(q, x, y) {
    let sign = 0;
    for (let i = 0; i < q.length; i++) {
      const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % q.length];
      const c = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
      if (Math.abs(c) < 1e-12) continue;
      const s = Math.sign(c);
      if (!sign) sign = s; else if (s !== sign) return false;
    }
    return true;
  }

  /** Liegt das Rechteck vollständig im randfreien Bereich? */
  static rectInside(quads, r) {
    const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
    return quads.every(q => pts.every(([x, y]) => Project.pointInQuad(q, x, y)));
  }

  /** Rechteck um seine Mitte so weit verkleinern, bis es passt. */
  static fitRect(quads, r) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2, t = { x: cx - r.w * m / 2, y: cy - r.h * m / 2, w: r.w * m, h: r.h * m };
      if (Project.rectInside(quads, t)) lo = m; else hi = m;
    }
    return lo > 0.02 ? { x: cx - r.w * lo / 2, y: cy - r.h * lo / 2, w: r.w * lo, h: r.h * lo } : null;
  }

  /** Größtes Rechteck mit Seitenverhältnis aspect um den Mittelpunkt (cx, cy). */
  static maxRectAt(quads, cx, cy, aspect) {
    let lo = 0, hi = 2;
    for (let i = 0; i < 30; i++) {
      const h = (lo + hi) / 2, w = h * aspect;
      if (Project.rectInside(quads, { x: cx - w / 2, y: cy - h / 2, w, h })) lo = h; else hi = h;
    }
    return lo > 0.01 ? { x: cx - lo * aspect / 2, y: cy - lo / 2, w: lo * aspect, h: lo } : null;
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
      if (f.id === this.refId) { f.quality = 'good'; f.qualityNote = ''; return; }
      if (!a || !a.ok) { q = 'bad'; note = 'Keine sichere Ausrichtung gefunden'; }
      else if (a.method === 'anker') {
        // Bewertung: sicher gefundene Punkte + Bildübereinstimmung im Bereich der Punkte
        const pts = (f.anchorPts || []).filter(p => p && !p.outlier && !p.pred);
        const sure = pts.filter(p => p.manual ? (p.snapped || p.pinned) : p.score >= 0.55).length;
        const onlyTaps = (f.anchorPts || []).some(p => p?.manual && !p.snapped && !p.pinned) && a.used <= 2;
        // Anordnung eindeutig getroffen (fast alle Punkte liegen auf Flecken) -> sicher
        const geoOk = this.anchors.length >= 4 && f.geoSupport >= 4;
        if (a.used < Math.min(2, this.anchors.length)) { q = 'bad'; note = 'Zu wenige Punkte gefunden'; }
        else if (geoOk && !(f.anchorPts || []).some(p => p?.manual && !p.snapped && !p.pinned)) { /* gut */ }
        else if (a.ncc != null && a.ncc < 0.5) { q = 'warn'; note = 'Bild passt im Bereich der Punkte schlecht – bitte ansehen'; }
        else if (onlyTaps) { q = 'warn'; note = 'Nur ungefähr getippt – Punkte mit der Lupe genau setzen (ziehen)'; }
        else if (sure < 2) { q = 'warn'; note = 'Punkte unsicher gefunden – bitte ansehen'; }
        else if (a.outliers && (a.ncc == null || a.ncc < 0.55)) { q = 'warn'; note = 'Ein Punkt passt nicht zu den anderen – bitte ansehen'; }
      } else if (a.anchorsRejected) {
        q = 'warn'; note = 'Ankerpunkte passen nicht zum Bild (bewegt sich etwas?) – automatische Ausrichtung beibehalten';
      } else if (a.ambiguous && !a.confirmedByAnchors) {
        q = 'warn'; note = 'Drehung nicht eindeutig (z. B. runde Schale) – bitte mit Fixpunkten ausrichten';
      } else if (a.ncc != null) {
        // Flächenvergleich mit der Referenz (1 = identisch)
        if (a.ncc < 0.6) { q = 'bad'; note = 'Geringe Übereinstimmung mit der Referenz'; }
        else if (a.ncc < 0.8 && !(a.inliers >= 40)) { q = 'warn'; note = 'Ausrichtung unsicher'; }
      } else {
        if (a.inliers < 15 || a.rms > 3) { q = 'bad'; note = 'Sehr wenige übereinstimmende Punkte'; }
        else if (a.inliers < 40 || a.rms > 1.8) { q = 'warn'; note = 'Ausrichtung unsicher'; }
        // Ohne Flächenprüfung: Sprung gegenüber Nachbarn als Warnsignal
        const nb = [];
        for (let j = Math.max(0, i - 3); j <= Math.min(inc.length - 1, i + 3); j++) if (j !== i) nb.push(centers[j]);
        if (nb.length >= 2 && q === 'good') {
          const med = k => nb.map(c => c[k]).sort((x, y) => x - y)[nb.length >> 1];
          if (Math.hypot(centers[i][0] - med(0), centers[i][1] - med(1)) > 0.04 * rw) { q = 'warn'; note = 'Sprung gegenüber Nachbarbildern'; }
        }
      }
      if (q === 'good' && f.inconsistent) { q = 'warn'; note = 'Passt nicht zu den Nachbarbildern – vermutlich verrutscht'; }
      f.quality = f.manualChecked ? 'good' : q;
      f.qualityNote = note;
    });
  }

  /**
   * Nachbarprüfung: Ein verrutschtes Foto passt im Video schlechter zu seinen Nachbarn als
   * diese zueinander. Markiert solche Fotos (f.inconsistent) für die Prüfung.
   */
  checkConsistency() {
    const inc = this.included.filter(f => f.cvec);
    const sim = (a, b) => { if (!a?.cvec || !b?.cvec || a.cvec.length !== b.cvec.length) return null; let s = 0; for (let i = 0; i < a.cvec.length; i++) s += a.cvec[i] * b.cvec[i]; return s; };
    for (const f of this.frames) f.inconsistent = false;
    if (inc.length < 4) return;
    inc.forEach((f, i) => {
      if (f.id === this.refId) return;
      const p = inc[i - 1], n = inc[i + 1];
      let own, ref;
      if (p && n) { own = Math.max(sim(f, p), sim(f, n)); ref = sim(p, n); }
      else if (n && inc[i + 2]) { own = sim(f, n); ref = sim(n, inc[i + 2]); }
      else if (p && inc[i - 2]) { own = sim(f, p); ref = sim(p, inc[i - 2]); }
      if (own == null || ref == null) return;
      // deutlich unähnlicher zu den Nachbarn als diese untereinander → vermutlich verrutscht/gezoomt
      if (own < ref - 0.12 && own < 0.75) f.inconsistent = true;
    });
  }

  // ---------- Ankerpunkte ----------

  /** Ankerpunkte zurücksetzen; keepPoints: Punkte im Referenzbild behalten. */
  resetAnchors(keepPoints = true) {
    for (const f of this.frames) {
      if (this.anchorsActive && f.autoAlign) f.align = f.autoAlign;
      f.autoAlign = null;
      f.anchorPts = null;
    }
    this.anchorsActive = false;
    if (!keepPoints) this.anchors = [];
  }

  /** Ankerpunkte nicht mehr verwenden (automatische Ausrichtung wiederherstellen). */
  disableAnchors() {
    for (const f of this.frames) if (f.autoAlign) { f.align = f.autoAlign; f.autoAlign = null; }
    this.anchorsActive = false;
  }

  /**
   * Transformation eines Fotos aus seinen Ankerpunkten (Bild -> Referenz, kanonisch).
   * Modell je nach Punktzahl: 1 Verschiebung, 2 Ähnlichkeit, 3 affin, ab 4 Perspektive.
   * Unsichere Punkte (Score < 0,3) werden ignoriert, Ausreißer ab 4 Punkten verworfen.
   */
  anchorFit(f) {
    const pts = f.anchorPts || [];
    const cand = [];
    // Mit Handpunkten zählen automatisch gefundene nur, wenn sie sicher sind (verwechselbare Flocken)
    const hasManual = pts.some(p => p?.manual);
    const minScore = hasManual ? 0.55 : 0.3;
    pts.forEach((p, k) => { if (p && this.anchors[k] && !p.pred && (p.manual || p.score >= minScore)) cand.push(k); });
    for (const p of pts) if (p) p.outlier = false;
    if (!cand.length) return null;
    const src = [], dst = [];
    pts.forEach((p, k) => { src.push(p?.x ?? 0, p?.y ?? 0); dst.push(this.anchors[k]?.x ?? 0, this.anchors[k]?.y ?? 0); });
    const resid = (H, k) => { const [x, y] = apply(H, src[2 * k], src[2 * k + 1]); return Math.hypot(x - dst[2 * k], y - dst[2 * k + 1]); };
    // Von Hand getippte Punkte geben die grobe Lage vor (Finger: ca. ±3 %). Automatisch gefundene
    // Punkte, die dem widersprechen, sind verwechselte Stellen (z. B. später hinzugefügte Flocken).
    const manualIdx = cand.filter(k => pts[k].manual);
    if (manualIdx.length >= 2) {
      const Htap = fitModel('similarity', src, dst, manualIdx);
      if (Htap) for (let i = cand.length - 1; i >= 0; i--) {
        const k = cand[i];
        if (!pts[k].manual && resid(Htap, k) > 0.035) { cand.splice(i, 1); pts[k].outlier = true; }
      }
    }
    // Ungenaue Fingertipps (nicht eingerastet) nur nutzen, solange es nicht genug sichere Punkte gibt
    const sure = k => pts[k].manual ? (pts[k].snapped || pts[k].pinned) : pts[k].score >= 0.55;
    if (cand.filter(sure).length >= 3) {
      for (let i = cand.length - 1; i >= 0; i--) {
        const p = pts[cand[i]];
        if (p.manual && !p.snapped && !p.pinned && p.tapX != null) cand.splice(i, 1);
      }
    }
    // Konsens: welche Punkte passen geometrisch zusammen? (Ähnlichkeit aus je zwei Punkten)
    // Punkte auf sich bewegenden/verändernden Dingen fallen dabei heraus.
    const TOL = 0.01; // ca. 1 % der langen Bildkante (Rest übernimmt der Flächenvergleich)
    // Alle gleich großen Konsens-Gruppen sammeln; bei Gleichstand entscheidet später das Bild selbst
    let groups = [cand];
    if (cand.length >= 3) {
      const found = new Map();
      for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
        const Hs = fitModel('similarity', src, dst, [cand[i], cand[j]]);
        if (!Hs) continue;
        const set = cand.filter(k => resid(Hs, k) < TOL || (pts[k].manual && resid(Hs, k) < TOL * 1.5));
        if (set.length >= 2) found.set(set.join(','), set);
      }
      // Ab vier Punkten auch schräg aufgenommene Fotos zulassen (affin aus je drei Punkten)
      if (cand.length >= 4) {
        for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) for (let l = j + 1; l < cand.length; l++) {
          const tri = [cand[i], cand[j], cand[l]];
          const [a1, a2, a3] = tri.map(k => [dst[2 * k], dst[2 * k + 1]]);
          const area = Math.abs((a2[0] - a1[0]) * (a3[1] - a1[1]) - (a3[0] - a1[0]) * (a2[1] - a1[1]));
          if (area < 0.002) continue; // fast auf einer Linie -> unzuverlässig
          const Ha = fitModel('affine', src, dst, tri);
          if (!Ha) continue;
          const set = cand.filter(k => resid(Ha, k) < TOL || (pts[k].manual && resid(Ha, k) < TOL * 1.5));
          if (set.length >= 4) found.set(set.join(','), set);
        }
      }
      const all = [...found.values()];
      if (all.length) {
        const rank = set => [set.length, set.filter(k => pts[k].manual).length];
        all.sort((a, b) => { const ra = rank(a), rb = rank(b); return rb[0] - ra[0] || rb[1] - ra[1]; });
        const top = rank(all[0]);
        groups = all.filter(g => { const r = rank(g); return r[0] === top[0] && r[1] === top[1]; }).slice(0, 6);
        // innerhalb des Gleichstands vorläufig: sicherer gefundene zuerst
        const sc = g => g.reduce((a, k) => a + (pts[k].manual ? 1 : pts[k].score), 0);
        groups.sort((a, b) => sc(b) - sc(a));
      }
    }
    const modelFor = n => {
      const m = n <= 1 ? 'translation' : n <= 3 ? 'similarity' : n <= 5 ? 'affine' : 'homography';
      if (this.settings.model === 'translation') return 'translation';
      if (this.settings.model === 'similarity' && m === 'homography') return 'affine';
      return m;
    };
    const hyps = groups.map(set => ({ set, H: fitModel(modelFor(set.length), src, dst, set) })).filter(h => h.H);
    if (!hyps.length) return null;
    return { hyps, cand, used: hyps[0].set.length };
  }

  /** Markiert Ausreißer und liefert Kennzahlen für eine gewählte Punktgruppe. */
  _useHyp(f, cand, hyp) {
    const pts = f.anchorPts;
    for (const k of cand) pts[k].outlier = !hyp.set.includes(k);
    const scores = hyp.set.map(k => (pts[k].manual ? 1 : pts[k].score));
    return { used: hyp.set.length, outliers: cand.length - hyp.set.length, anchorScore: Math.min(...scores) };
  }

  /** Ausrichtung eines Fotos aus den Ankerpunkten übernehmen. */
  applyAnchors(f) {
    if (f.id === this.refId) return;
    const fit = this.anchorFit(f);
    if (!f.autoAlign) f.autoAlign = f.align;
    const auto = f.autoAlign;
    f.anchorHyps = fit ? fit.hyps : null;
    f.anchorCand = fit ? fit.cand : null;
    if (!fit) { f.align = { ...(auto || {}), ok: false, method: 'anker', used: 0, anchorScore: 0 }; return; }
    // Bestätigt eine Punktgruppe die automatische Ausrichtung, bleibt diese (genauer, nutzt alle Pixel)
    const confirmed = auto?.ok && fit.hyps.find(h => h.set.length >= 2 && h.set.every(k => {
      const p = f.anchorPts[k], a = this.anchors[k];
      const [x, y] = apply(auto.H, p.x, p.y);
      return Math.hypot(x - a.x, y - a.y) < 0.006;
    }));
    if (confirmed) {
      const info = this._useHyp(f, fit.cand, confirmed);
      f.align = { ...auto, confirmedByAnchors: true, ...info };
    } else {
      const info = this._useHyp(f, fit.cand, fit.hyps[0]);
      f.align = { ok: true, H: fit.hyps[0].H, method: 'anker', ...info, inliers: info.used, rms: 0, ncc: null, via: null };
    }
    f.manual = { ...f.manual, dx: 0, dy: 0, rot: 0, scale: 1 };
    this._maybeInclude(f);
  }

  /** Automatisch ausgeschlossene Fotos wieder aufnehmen, sobald die Punkte sicher sind. */
  _maybeInclude(f) {
    const a = f.align;
    if (f.autoExcluded && a?.ok && a.anchorScore >= 0.55 && a.used >= Math.min(2, this.anchors.length)) { f.excluded = false; f.autoExcluded = false; }
  }

  /** Automatik behalten; Punkte, die ihr widersprechen, als Ausreißer markieren. */
  keepAutoOverAnchors(f) {
    const auto = f.autoAlign;
    let used = 0;
    for (const k of f.anchorCand || []) {
      const p = f.anchorPts[k], a = this.anchors[k];
      const [x, y] = apply(auto.H, p.x, p.y);
      p.outlier = Math.hypot(x - a.x, y - a.y) >= 0.006;
      if (!p.outlier) used++;
    }
    f.align = { ...auto, confirmedByAnchors: used >= 2, anchorsRejected: used < 2, used, outliers: (f.anchorCand?.length || 0) - used };
  }

  /** Nach der Bildprüfung im Worker: gewählte Punktgruppe übernehmen. */
  chooseAnchorHyp(f, idx, H, ncc) {
    const hyp = f.anchorHyps?.[idx];
    if (!hyp) return;
    const info = this._useHyp(f, f.anchorCand, hyp);
    // Handpunkte nach der flächigen Feinkorrektur großzügig prüfen (Finger sind ungenau)
    for (const k of f.anchorCand || []) {
      const p = f.anchorPts[k], a = this.anchors[k];
      if (!p.manual) continue;
      const [x, y] = apply(H, p.x, p.y);
      p.outlier = Math.hypot(x - a.x, y - a.y) > 0.025;
    }
    f.align = { ok: true, H, method: 'anker', ...info, inliers: info.used, rms: 0, ncc, via: null, refined: true };
    this._maybeInclude(f);
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

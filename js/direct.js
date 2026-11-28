// Flächenbasierte (direkte) Ausrichtung: vergleicht ganze Bildflächen statt einzelner
// Ecken. Robust bei wenig Struktur (glatte Teller, Himmel, Nebel) und bei Handaufnahmen.
// Verfahren: Bildpyramide, grobe Suche (Verschiebung × Drehung × Zoom per NCC),
// dann Gauß-Newton (Lucas-Kanade, vorwärts-kompositional) mit Helligkeitsausgleich
// (Gain/Offset) und robuster Gewichtung, damit sich bewegende Bildteile wenig stören.

import { mul, inv, I3 } from './geometry.js';
import { blur } from './features.js';

/** Graustufen-Pyramide (Ebene 0 = volle Größe), Bilder als Float32Array. */
export function pyramid(gray, w, h, minSide = 40) {
  let img = blur(Float32Array.from(gray), w, h, 0.8);
  const levels = [{ img, w, h, s: 1 }];
  while (Math.min(w, h) / 2 >= minSide) {
    const nw = w >> 1, nh = h >> 1, out = new Float32Array(nw * nh), b = blur(img, w, h, 1.0);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const i = 2 * y * w + 2 * x;
      out[y * nw + x] = (b[i] + b[i + 1] + b[i + w] + b[i + w + 1]) * 0.25;
    }
    img = out; w = nw; h = nh;
    levels.push({ img, w, h, s: levels[levels.length - 1].s * 2 });
  }
  return levels;
}

// Skaliert eine Pixel-Abbildung (Ebene 0) auf eine Pyramidenebene mit Faktor s
const toLevel = (W, s) => mul([1 / s, 0, 0, 0, 1 / s, 0, 0, 0, 1], mul(W, [s, 0, 0, 0, s, 0, 0, 0, 1]));
const fromLevel = (W, s) => toLevel(W, 1 / s);

/** Bild I mit Abbildung W (Ref-Pixel -> Bild-Pixel) in das Raster der Referenz verziehen. */
function warpInto(I, Iw, Ih, W, w, h, out, mask, step = 1) {
  const [a, b, c, d, e, f, g, hh, k] = W;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = y * w + x, z = g * x + hh * y + k;
      const u = (a * x + b * y + c) / z, v = (d * x + e * y + f) / z;
      if (!(u >= 0 && v >= 0 && u < Iw - 1 && v < Ih - 1)) { mask[i] = 0; continue; }
      const x0 = u | 0, y0 = v | 0, tx = u - x0, ty = v - y0, j = y0 * Iw + x0;
      out[i] = (I[j] * (1 - tx) + I[j + 1] * tx) * (1 - ty) + (I[j + Iw] * (1 - tx) + I[j + Iw + 1] * tx) * ty;
      mask[i] = 1;
    }
  }
}

/** Normierte Kreuzkorrelation zweier Raster auf gültigen Pixeln. */
function ncc(T, A, mask, n, step = 1, w = 0) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    if (step > 1 && ((i % w) % step || ((i / w) | 0) % step)) continue;
    if (!mask[i]) continue;
    const p = T[i], q = A[i];
    sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q; cnt++;
  }
  if (cnt < n * 0.25 / (step * step)) return { r: -1, cover: cnt / n * step * step };
  const va = saa - sa * sa / cnt, vb = sbb - sb * sb / cnt;
  const r = va > 1e-6 && vb > 1e-6 ? (sab - sa * sb / cnt) / Math.sqrt(va * vb) : -1;
  return { r, cover: cnt / n * step * step };
}

/** Drehwinkel einer Abbildung (Bogenmaß, -π..π). */
export const angleOf = W => Math.atan2(W[3] - W[1], W[0] + W[4]);

const DOF = { translation: 2, similarity: 4, affine: 6, homography: 8 };

/** Kleine Änderung ΔW (in normierten Koordinaten) als Matrix. */
function deltaMatrix(model, p) {
  switch (model) {
    case 'translation': return [1, 0, p[0], 0, 1, p[1], 0, 0, 1];
    case 'similarity': return [1 + p[0], -p[1], p[2], p[1], 1 + p[0], p[3], 0, 0, 1];
    case 'affine': return [1 + p[0], p[1], p[2], p[3], 1 + p[4], p[5], 0, 0, 1];
    default: return [1 + p[0], p[1], p[2], p[3], 1 + p[4], p[5], p[6], p[7], 1];
  }
}

/** Jacobi-Zeile ∂ΔW/∂p am Punkt (x,y) (normiert), kombiniert mit Bildgradient (gx,gy). */
function jac(model, x, y, gx, gy, J) {
  switch (model) {
    case 'translation': J[0] = gx; J[1] = gy; return;
    case 'similarity': J[0] = gx * x + gy * y; J[1] = -gx * y + gy * x; J[2] = gx; J[3] = gy; return;
    case 'affine': J[0] = gx * x; J[1] = gx * y; J[2] = gx; J[3] = gy * x; J[4] = gy * y; J[5] = gy; return;
    default:
      J[0] = gx * x; J[1] = gx * y; J[2] = gx; J[3] = gy * x; J[4] = gy * y; J[5] = gy;
      J[6] = -(gx * x + gy * y) * x; J[7] = -(gx * x + gy * y) * y;
  }
}

function solveSym(A, b, n) {
  // Cholesky mit kleiner Dämpfung (Levenberg)
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) A[i * n + i] *= 1.0001;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) { if (s <= 1e-12) return null; L[i * n + i] = Math.sqrt(s); }
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n), x = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}

/** Gauß-Newton auf einer Ebene. W: Ref-Pixel -> Bild-Pixel (dieser Ebene). */
function refineLevel(T, I, L, W, model, iters, roi = null) {
  const { w, h } = L, n = w * h;
  const cx = w / 2, cy = h / 2, sn = Math.max(w, h) / 2;
  const N = [1 / sn, 0, -cx / sn, 0, 1 / sn, -cy / sn, 0, 0, 1], Ni = [sn, 0, cx, 0, sn, cy, 0, 0, 1];
  const Iw = new Float32Array(n), mask = new Uint8Array(n);
  const P = DOF[model], Q = P + 2; // + Gain/Offset
  const J = new Float64Array(Q);
  let sigma = 0;
  for (let it = 0; it < iters; it++) {
    warpInto(I.img, I.w, I.h, W, w, h, Iw, mask);
    // Helligkeit: Iw ≈ α·T + β, über kleinste Quadrate
    let sT = 0, sI = 0, sTT = 0, sTI = 0, cnt = 0;
    if (roi) for (let i = 0; i < n; i++) if (!roi[i]) mask[i] = 0; // nur im Bereich der Fixpunkte
    let nRoi = n;
    if (roi) { nRoi = 0; for (let i = 0; i < n; i++) nRoi += roi[i]; }
    for (let i = 0; i < n; i++) if (mask[i]) { sT += T[i]; sI += Iw[i]; sTT += T[i] * T[i]; sTI += T[i] * Iw[i]; cnt++; }
    if (cnt < nRoi * 0.2) return { W, ok: false };
    const varT = sTT - sT * sT / cnt;
    const alpha = varT > 1e-6 ? (sTI - sT * sI / cnt) / varT : 1, beta = (sI - alpha * sT) / cnt;
    // Residuenstreuung für robuste Gewichte
    if (it % 3 === 0) {
      let se = 0;
      for (let i = 0; i < n; i++) if (mask[i]) { const e = Iw[i] - alpha * T[i] - beta; se += e * e; }
      sigma = Math.sqrt(se / cnt) + 1e-3;
    }
    const k = 1.5 * sigma;
    const A = new Float64Array(Q * Q), bv = new Float64Array(Q);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!mask[i] || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) continue;
        const gx = (Iw[i + 1] - Iw[i - 1]) * 0.5, gy = (Iw[i + w] - Iw[i - w]) * 0.5;
        const e = Iw[i] - alpha * T[i] - beta;
        const ae = Math.abs(e), wt = ae <= k ? 1 : k / ae; // Huber
        const xn = (x - cx) / sn, yn = (y - cy) / sn;
        jac(model, xn, yn, gx * sn, gy * sn, J);
        J[P] = -T[i]; J[P + 1] = -1; // Ableitung nach Δα, Δβ
        for (let r = 0; r < Q; r++) {
          const jr = J[r] * wt;
          bv[r] -= jr * e;
          for (let c = 0; c <= r; c++) A[r * Q + c] += jr * J[c];
        }
      }
    }
    for (let r = 0; r < Q; r++) for (let c = r + 1; c < Q; c++) A[r * Q + c] = A[c * Q + r];
    const dp = solveSym(A, bv, Q);
    if (!dp) return { W, ok: false };
    // Vorwärts-kompositional: W <- W ∘ ΔW (ΔW in normierten Koordinaten)
    const D = mul(Ni, mul(deltaMatrix(model, dp), N));
    W = mul(W, D);
    let mag = 0;
    for (let r = 0; r < P; r++) mag = Math.max(mag, Math.abs(dp[r]));
    if (mag * sn < 0.01) break;
  }
  return { W, ok: true };
}

/** Bewertet eine Abbildung (Ref-Pixel -> Bild-Pixel, Ebene 0) per NCC auf einer Ebene. */
export function score(refPyr, imgPyr, W0, level = 0, roi = null) {
  const lv = Math.min(level, refPyr.length - 1);
  const L = refPyr[lv], I = imgPyr[Math.min(level, imgPyr.length - 1)];
  const W = toLevel(W0, L.s);
  const n = L.w * L.h, Iw = new Float32Array(n), mask = new Uint8Array(n);
  warpInto(I.img, I.w, I.h, W, L.w, L.h, Iw, mask);
  if (roi?.[lv]) { const R = roi[lv]; let nr = 0; for (let i = 0; i < n; i++) { if (!R[i]) mask[i] = 0; nr += R[i]; } const res = ncc(L.img, Iw, mask, n); return res.cover * n >= nr * 0.25 ? { r: res.r === -1 ? nccAll(L.img, Iw, mask, n) : res.r, cover: res.cover } : { r: -1, cover: res.cover }; }
  return ncc(L.img, Iw, mask, n);
}

function nccAll(T, A, mask, n) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, c = 0;
  for (let i = 0; i < n; i++) if (mask[i]) { const p = T[i], q = A[i]; sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q; c++; }
  if (c < 16) return -1;
  const va = saa - sa * sa / c, vb = sbb - sb * sb / c;
  return va > 1e-6 && vb > 1e-6 ? (sab - sa * sb / c) / Math.sqrt(va * vb) : -1;
}

/** Bereichsmaske (konvexes Polygon in Pixeln der Ebene 0) für alle Pyramidenebenen. */
export function roiPyramid(refPyr, poly) {
  return refPyr.map(L => {
    const m = new Uint8Array(L.w * L.h), P = poly.map(([x, y]) => [x / L.s, y / L.s]);
    let area = 0; for (let i = 0; i < P.length; i++) { const [a, b] = P[i], [c, d] = P[(i + 1) % P.length]; area += a * d - c * b; }
    const sg = area >= 0 ? 1 : -1;
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      let inside = true;
      for (let i = 0; i < P.length && inside; i++) {
        const [a, b] = P[i], [c, d] = P[(i + 1) % P.length];
        if (((c - a) * (y - b) - (d - b) * (x - a)) * sg < 0) inside = false;
      }
      m[y * L.w + x] = inside ? 1 : 0;
    }
    return m;
  });
}

/** Grobe Suche auf der kleinsten Ebene: Drehung × Zoom × Verschiebung. */
function coarseSearch(refPyr, imgPyr, base, { rots, scales, shift }) {
  const lv = refPyr.length - 1;
  const L = refPyr[lv], I = imgPyr[Math.min(lv, imgPyr.length - 1)];
  const n = L.w * L.h, Iw = new Float32Array(n), mask = new Uint8Array(n);
  const cx = L.w / 2, cy = L.h / 2;
  const R = Math.round(Math.max(L.w, L.h) * shift);
  const cands = [];
  for (const rot of rots) for (const sc of scales) {
    const t = rot * Math.PI / 180, c = Math.cos(t) * sc, s = Math.sin(t) * sc;
    const S = [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy, 0, 0, 1];
    const B = mul(toLevel(base, L.s), S);
    for (let dy = -R; dy <= R; dy += 1) for (let dx = -R; dx <= R; dx += 1) {
      const W = mul([1, 0, dx, 0, 1, dy, 0, 0, 1], B);
      warpInto(I.img, I.w, I.h, W, L.w, L.h, Iw, mask, 2);
      const { r } = ncc(L.img, Iw, mask, n, 2, L.w);
      cands.push({ r, W: fromLevel(W, L.s) });
    }
  }
  cands.sort((a, b) => b.r - a.r);
  // Mehrere unterschiedliche Kandidaten behalten
  const out = [];
  for (const c of cands) {
    if (out.length >= 6) break;
    if (out.every(o => Math.hypot(o.W[2] - c.W[2], o.W[5] - c.W[5]) > 3 * L.s || Math.abs(angleOf(o.W) - angleOf(c.W)) > 0.15)) out.push(c);
  }
  return out;
}

/**
 * Richtet ein Bild flächenbasiert auf die Referenz aus.
 * inits: Liste von Startabbildungen (Ref-Pixel -> Bild-Pixel, Ebene 0).
 * Rückgabe: { W (Ref->Bild), r (NCC 0..1), cover (Überdeckung) } oder null.
 */
export function alignDirect(refPyr, imgPyr, { model = 'homography', inits = [], search = true, roi = null } = {}) {
  const starts = inits.map(W => ({ W, r: score(refPyr, imgPyr, W, refPyr.length - 1).r, init: true }));
  if (search) {
    // volle Drehung (Hoch-/Querformat gemischt, gedrehte Schale) in 20°-Schritten
    const rots = []; for (let a = -160; a <= 180; a += 20) rots.push(a);
    starts.push(...coarseSearch(refPyr, imgPyr, I3(), { rots, scales: [0.8, 1, 1.25], shift: 0.2 }));
  }
  starts.sort((a, b) => b.r - a.r);
  // Startwerte aus dem Aufrufer immer verfeinern, dazu die besten Suchergebnisse
  const chosen = [...starts.filter(s => s.init), ...starts.filter(s => !s.init).slice(0, 5)];
  const finals = [];
  for (const st of chosen) {
    let W = st.W;
    // grob -> fein; einfache Modelle zuerst, damit die Suche stabil bleibt
    for (let lv = refPyr.length - 1; lv >= 0; lv--) {
      const L = refPyr[lv], I = imgPyr[Math.min(lv, imgPyr.length - 1)];
      let Wl = toLevel(W, L.s);
      const coarse = lv >= refPyr.length - 2;
      const m = coarse && model !== 'translation' ? 'similarity' : model;
      const res = refineLevel(L.img, I, L, Wl, m, lv === 0 ? 12 : 20, roi ? roi[lv] : null);
      if (!res.ok) break;
      Wl = res.W;
      W = fromLevel(Wl, L.s);
    }
    const sc = score(refPyr, imgPyr, W, 0, roi);
    finals.push({ W, r: sc.r, cover: sc.cover });
  }
  finals.sort((a, b) => b.r - a.r);
  const best = finals[0];
  if (!best) return null;
  // Mehrdeutige Drehung (z. B. runde Schale): ein deutlich anders gedrehtes Ergebnis passt fast gleich gut
  const a0 = angleOf(best.W);
  const rival = finals.find(f => {
    let d = Math.abs(angleOf(f.W) - a0); if (d > Math.PI) d = 2 * Math.PI - d;
    return d > 0.14 && f.r >= best.r - 0.03;
  });
  return { ...best, ambiguous: !!rival, rivalR: rival?.r };
}

export { inv };

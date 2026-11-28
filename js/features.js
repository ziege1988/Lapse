// Merkmalserkennung für die Ausrichtung: Harris-Ecken auf einer Bildpyramide,
// Subpixel-Verfeinerung, Orientierung per Intensitätsschwerpunkt und rotierte
// BRIEF-Deskriptoren (256 Bit). Binäre Vergleiche machen die Deskriptoren
// unempfindlich gegen Helligkeitsänderungen (z. B. Tag/Nacht-Verläufe).

import { rng } from './geometry.js';

const PATCH = 15;          // Radius des Deskriptor-Fensters
const BORDER = 24;         // Randabstand (rotiertes Muster passt sicher hinein)
const NBITS = 256, NWORDS = NBITS / 32;
const ANGLE_BINS = 32;

// Feste Testpaare (isotrope Gauß-Verteilung, abgeschnitten auf das Fenster)
const PAIRS = (() => {
  const rand = rng(2024);
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const s = (2 * PATCH + 1) / 5;
  const clip = v => Math.max(-PATCH, Math.min(PATCH, Math.round(v)));
  const p = new Int8Array(NBITS * 4);
  for (let i = 0; i < NBITS; i++) {
    let x1, y1, x2, y2;
    do { x1 = clip(gauss() * s); y1 = clip(gauss() * s); x2 = clip(gauss() * s); y2 = clip(gauss() * s); }
    while (x1 === x2 && y1 === y2);
    p.set([x1, y1, x2, y2], i * 4);
  }
  return p;
})();

// Vorberechnete rotierte Muster
const ROTATED = (() => {
  const out = [];
  for (let b = 0; b < ANGLE_BINS; b++) {
    const a = (b / ANGLE_BINS) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
    const r = new Int8Array(NBITS * 4);
    for (let i = 0; i < NBITS * 4; i += 2) {
      const x = PAIRS[i], y = PAIRS[i + 1];
      r[i] = Math.round(c * x - s * y);
      r[i + 1] = Math.round(s * x + c * y);
    }
    out.push(r);
  }
  return out;
})();

/** Kontrast normieren (1.–99. Perzentil auf 0..255), Ergebnis Float32. */
function normalizeContrast(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const n = gray.length;
  let acc = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.01) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.01) { hi = i; break; } }
  const span = Math.max(8, hi - lo), k = 255 / span;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(255, (gray[i] - lo) * k));
  return out;
}

function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

export function blur(src, w, h, sigma) {
  const k = gaussKernel(sigma), r = (k.length - 1) / 2;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        let xx = x + i; xx = xx < 0 ? -xx : xx >= w ? 2 * w - xx - 2 : xx;
        s += src[row + xx] * k[i + r];
      }
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        let yy = y + i; yy = yy < 0 ? -yy : yy >= h ? 2 * h - yy - 2 : yy;
        s += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

function resample(src, w, h, nw, nh) {
  const out = new Float32Array(nw * nh), sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(h - 1.001, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = fy | 0, ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.min(w - 1.001, Math.max(0, (x + 0.5) * sx - 0.5)), x0 = fx | 0, tx = fx - x0;
      const i = y0 * w + x0;
      out[y * nw + x] = (src[i] * (1 - tx) + src[i + 1] * tx) * (1 - ty) + (src[i + w] * (1 - tx) + src[i + w + 1] * tx) * ty;
    }
  }
  return out;
}

/** Harris-Antwort (Sobel-Gradienten, 5x5-Fenster). */
function harris(img, w, h) {
  const n = w * h;
  const xx = new Float32Array(n), yy = new Float32Array(n), xy = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (img[i - w + 1] + 2 * img[i + 1] + img[i + w + 1]) - (img[i - w - 1] + 2 * img[i - 1] + img[i + w - 1]);
      const gy = (img[i + w - 1] + 2 * img[i + w] + img[i + w + 1]) - (img[i - w - 1] + 2 * img[i - w] + img[i - w + 1]);
      xx[i] = gx * gx; yy[i] = gy * gy; xy[i] = gx * gy;
    }
  }
  const sxx = boxFilter(xx, w, h, 2), syy = boxFilter(yy, w, h, 2), sxy = boxFilter(xy, w, h, 2);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = sxx[i], b = syy[i], c = sxy[i], tr = a + b;
    R[i] = a * b - c * c - 0.04 * tr * tr;
  }
  return R;
}

function boxFilter(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function orientation(img, w, x, y) {
  let m01 = 0, m10 = 0;
  for (let dy = -PATCH; dy <= PATCH; dy++) {
    const span = Math.floor(Math.sqrt(PATCH * PATCH - dy * dy));
    const row = (y + dy) * w + x;
    for (let dx = -span; dx <= span; dx++) {
      const v = img[row + dx];
      m10 += dx * v; m01 += dy * v;
    }
  }
  return Math.atan2(m01, m10);
}

function describe(img, w, x, y, angle, out, off) {
  let a = angle / (2 * Math.PI);
  a -= Math.floor(a);
  const pat = ROTATED[Math.round(a * ANGLE_BINS) % ANGLE_BINS];
  const c = y * w + x;
  for (let wd = 0; wd < NWORDS; wd++) {
    let bits = 0;
    for (let b = 0; b < 32; b++) {
      const p = (wd * 32 + b) * 4;
      if (img[c + pat[p + 1] * w + pat[p]] < img[c + pat[p + 3] * w + pat[p + 2]]) bits |= (1 << b);
    }
    out[off + wd] = bits;
  }
}

/**
 * Merkmale eines Graustufenbildes berechnen.
 * @returns {{n:number, xy:Float32Array, desc:Uint32Array, w:number, h:number}}
 *          Koordinaten in Pixeln des Eingangsbildes.
 */
export function detect(gray, w, h, { maxFeatures = 1500, levels = 4, scaleStep = 0.7071 } = {}) {
  let img = blur(normalizeContrast(gray), w, h, 0.6);
  let lw = w, lh = h, scale = 1;
  const pyr = [];
  for (let l = 0; l < levels; l++) {
    if (lw < 2 * BORDER + 32 || lh < 2 * BORDER + 32) break;
    pyr.push({ img, w: lw, h: lh, scale });
    const nw = Math.round(lw * scaleStep), nh = Math.round(lh * scaleStep);
    img = resample(blur(img, lw, lh, 0.8), lw, lh, nw, nh);
    lw = nw; lh = nh; scale /= scaleStep;
  }
  const totalArea = pyr.reduce((s, p) => s + p.w * p.h, 0);
  const xs = [], ys = [], descs = [];
  for (const L of pyr) {
    const budget = Math.max(30, Math.round(maxFeatures * (L.w * L.h) / totalArea));
    const R = harris(L.img, L.w, L.h);
    let maxR = 0;
    for (let i = 0; i < R.length; i++) if (R[i] > maxR) maxR = R[i];
    const thr = maxR * 1e-4;
    // Rasterbasierte Verteilung: jede Zelle behält ihre stärksten Ecken
    const gx = 12, gy = Math.max(6, Math.round(12 * L.h / L.w));
    const perCell = Math.max(2, Math.ceil(budget / (gx * gy) * 1.6));
    const cells = Array.from({ length: gx * gy }, () => []);
    for (let y = BORDER; y < L.h - BORDER; y++) {
      for (let x = BORDER; x < L.w - BORDER; x++) {
        const i = y * L.w + x, r = R[i];
        if (r <= thr) continue;
        let isMax = true;
        for (let dy = -2; dy <= 2 && isMax; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            if ((dx || dy) && R[i + dy * L.w + dx] >= r) {
              if (R[i + dy * L.w + dx] > r || dy < 0 || (dy === 0 && dx < 0)) { isMax = false; break; }
            }
          }
        if (!isMax) continue;
        const c = Math.min(gy - 1, (y * gy / L.h) | 0) * gx + Math.min(gx - 1, (x * gx / L.w) | 0);
        cells[c].push([r, x, y]);
      }
    }
    let cand = [];
    for (const cell of cells) {
      cell.sort((a, b) => b[0] - a[0]);
      for (let k = 0; k < Math.min(perCell, cell.length); k++) cand.push(cell[k]);
    }
    cand.sort((a, b) => b[0] - a[0]);
    cand = cand.slice(0, budget);
    const smooth = blur(L.img, L.w, L.h, 1.6);
    for (const [, x, y] of cand) {
      // Subpixel per Parabelanpassung der Harris-Antwort
      const i = y * L.w + x;
      const dxn = R[i - 1] - 2 * R[i] + R[i + 1], dyn = R[i - L.w] - 2 * R[i] + R[i + L.w];
      let ox = dxn < 0 ? 0.5 * (R[i - 1] - R[i + 1]) / dxn : 0;
      let oy = dyn < 0 ? 0.5 * (R[i - L.w] - R[i + L.w]) / dyn : 0;
      ox = Math.max(-0.5, Math.min(0.5, ox)); oy = Math.max(-0.5, Math.min(0.5, oy));
      const ang = orientation(smooth, L.w, x, y);
      const d = new Uint32Array(NWORDS);
      describe(smooth, L.w, x, y, ang, d, 0);
      // Pixelzentren: Level-Koordinate -> Eingangsbild
      xs.push((x + ox + 0.5) * L.scale - 0.5);
      ys.push((y + oy + 0.5) * L.scale - 0.5);
      descs.push(d);
    }
  }
  const n = xs.length;
  const xy = new Float32Array(n * 2), desc = new Uint32Array(n * NWORDS);
  for (let i = 0; i < n; i++) { xy[2 * i] = xs[i]; xy[2 * i + 1] = ys[i]; desc.set(descs[i], i * NWORDS); }
  return { n, xy, desc, w, h };
}

function popcnt(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

function nearest(A, B, ia, out) {
  // out: [best, second, bestIdx]
  let b1 = 1e9, b2 = 1e9, bi = -1;
  const oa = ia * NWORDS;
  for (let j = 0; j < B.n; j++) {
    const ob = j * NWORDS;
    let d = 0;
    for (let k = 0; k < NWORDS; k++) {
      d += popcnt(A.desc[oa + k] ^ B.desc[ob + k]);
      if (d >= b2) break;
    }
    if (d < b1) { b2 = b1; b1 = d; bi = j; } else if (d < b2) b2 = d;
  }
  out[0] = b1; out[1] = b2; out[2] = bi;
}

/**
 * Gegenseitig beste Treffer mit Ratio-Test.
 * @returns {Array<[number, number, number]>} [indexA, indexB, distanz]
 */
export function match(A, B, { ratio = 0.82, maxDist = 90 } = {}) {
  const fwd = new Int32Array(A.n).fill(-1), fdist = new Int32Array(A.n);
  const tmp = [0, 0, 0];
  for (let i = 0; i < A.n; i++) {
    nearest(A, B, i, tmp);
    if (tmp[0] <= maxDist && tmp[0] < ratio * tmp[1]) { fwd[i] = tmp[2]; fdist[i] = tmp[0]; }
  }
  // Rückwärtsprüfung nur für Kandidaten
  const needed = new Map();
  for (let i = 0; i < A.n; i++) if (fwd[i] >= 0) needed.set(fwd[i], -1);
  for (const j of needed.keys()) {
    nearest(B, A, j, tmp);
    needed.set(j, tmp[2]);
  }
  const out = [];
  for (let i = 0; i < A.n; i++) if (fwd[i] >= 0 && needed.get(fwd[i]) === i) out.push([i, fwd[i], fdist[i]]);
  return out;
}

export const DESCRIPTOR_WORDS = NWORDS;

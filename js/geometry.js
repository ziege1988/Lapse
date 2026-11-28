// Geometrie: 3x3-Matrizen (zeilenweise), Transformationsmodelle, RANSAC, Zuschnitt.
// Alle Funktionen sind rein rechnerisch und laufen im Hauptthread wie im Worker.

export const I3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return C;
}

export function inv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!isFinite(det) || Math.abs(det) < 1e-14) return null;
  const s = 1 / det;
  return [
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
}

export function apply(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function translate(tx, ty) { return [1, 0, tx, 0, 1, ty, 0, 0, 1]; }

/** Ähnlichkeitstransformation um Zentrum (cx,cy): Verschiebung, Drehung (Grad), Skalierung. */
export function similarityAbout(cx, cy, dx, dy, rotDeg, scale) {
  const t = rotDeg * Math.PI / 180, c = Math.cos(t) * scale, s = Math.sin(t) * scale;
  // x' = R*(x-c) + c + d
  return [c, -s, cx - c * cx + s * cy + dx, s, c, cy - s * cx - c * cy + dy, 0, 0, 1];
}

export function normalize(H) {
  const k = H[8];
  return Math.abs(k) > 1e-12 ? H.map(v => v / k) : H.slice();
}

// ---------- Lineare Algebra ----------

/** Löst A x = b (n x n, zeilenweise Arrays) mit Gauß + Pivotisierung. */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col, best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-12) return null;
    if (piv !== col) { const t = M[col]; M[col] = M[piv]; M[piv] = t; }
    const p = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / p;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x.every(isFinite) ? x : null;
}

// ---------- Modellschätzung (src -> dst), Punkte als flache Arrays [x0,y0,x1,y1,...] ----------

export const MODEL_MIN = { translation: 1, similarity: 2, affine: 3, homography: 4 };

function fitTranslation(src, dst, idx) {
  let tx = 0, ty = 0;
  for (const i of idx) { tx += dst[2 * i] - src[2 * i]; ty += dst[2 * i + 1] - src[2 * i + 1]; }
  return translate(tx / idx.length, ty / idx.length);
}

// Umeyama (2D, ohne Spiegelung)
function fitSimilarity(src, dst, idx) {
  const n = idx.length;
  let mxs = 0, mys = 0, mxd = 0, myd = 0;
  for (const i of idx) { mxs += src[2 * i]; mys += src[2 * i + 1]; mxd += dst[2 * i]; myd += dst[2 * i + 1]; }
  mxs /= n; mys /= n; mxd /= n; myd /= n;
  let a = 0, b = 0, v = 0;
  for (const i of idx) {
    const xs = src[2 * i] - mxs, ys = src[2 * i + 1] - mys;
    const xd = dst[2 * i] - mxd, yd = dst[2 * i + 1] - myd;
    a += xs * xd + ys * yd;
    b += xs * yd - ys * xd;
    v += xs * xs + ys * ys;
  }
  if (v < 1e-18) return null;
  const c = a / v, s = b / v; // c = k*cos, s = k*sin
  return [c, -s, mxd - c * mxs + s * mys, s, c, myd - s * mxs - c * mys, 0, 0, 1];
}

function fitAffine(src, dst, idx) {
  // Normalgleichungen für [a b c] und [d e f]
  const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
  for (const i of idx) {
    const x = src[2 * i], y = src[2 * i + 1], v = [x, y, 1];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) N[r][c] += v[r] * v[c];
      bx[r] += v[r] * dst[2 * i];
      by[r] += v[r] * dst[2 * i + 1];
    }
  }
  const p = solve(N, bx), q = solve(N, by);
  if (!p || !q) return null;
  return [p[0], p[1], p[2], q[0], q[1], q[2], 0, 0, 1];
}

function normTransform(pts, idx) {
  let mx = 0, my = 0;
  for (const i of idx) { mx += pts[2 * i]; my += pts[2 * i + 1]; }
  mx /= idx.length; my /= idx.length;
  let d = 0;
  for (const i of idx) d += Math.hypot(pts[2 * i] - mx, pts[2 * i + 1] - my);
  d /= idx.length;
  const s = d > 1e-12 ? Math.SQRT2 / d : 1;
  return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
}

function fitHomography(src, dst, idx) {
  const Ts = normTransform(src, idx), Td = normTransform(dst, idx);
  const A = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const b = new Array(8).fill(0);
  const add = (row, rhs) => {
    for (let r = 0; r < 8; r++) {
      if (row[r] === 0) continue;
      for (let c = 0; c < 8; c++) A[r][c] += row[r] * row[c];
      b[r] += row[r] * rhs;
    }
  };
  for (const i of idx) {
    const [x, y] = apply(Ts, src[2 * i], src[2 * i + 1]);
    const [u, v] = apply(Td, dst[2 * i], dst[2 * i + 1]);
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solve(A, b);
  if (!h) return null;
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const TdInv = inv(Td);
  if (!TdInv) return null;
  return normalize(mul(TdInv, mul(Hn, Ts)));
}

export function fitModel(model, src, dst, idx) {
  switch (model) {
    case 'translation': return fitTranslation(src, dst, idx);
    case 'similarity': return fitSimilarity(src, dst, idx);
    case 'affine': return fitAffine(src, dst, idx);
    default: return fitHomography(src, dst, idx);
  }
}

/** Plausibilitätsprüfung: keine Spiegelung, keine extreme Skalierung/Perspektive. */
export function isPlausible(H, extent = 1) {
  if (!H || !H.every(isFinite)) return false;
  const det = H[0] * H[4] - H[1] * H[3];
  if (det <= 0) return false;
  const sc = Math.sqrt(det);
  if (sc < 0.33 || sc > 3) return false;
  if (Math.abs(H[6]) * extent > 0.6 || Math.abs(H[7]) * extent > 0.6) return false;
  // Ecken dürfen nicht hinter den Horizont fallen
  for (const [x, y] of [[0, 0], [extent, 0], [0, extent], [extent, extent]]) {
    if (H[6] * x + H[7] * y + H[8] <= 0.05) return false;
  }
  return true;
}

/** Deterministischer Zufallsgenerator (mulberry32). */
export function rng(seed = 12345) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function residuals2(H, src, dst, n) {
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [x, y] = apply(H, src[2 * i], src[2 * i + 1]);
    const dx = x - dst[2 * i], dy = y - dst[2 * i + 1];
    r[i] = dx * dx + dy * dy;
  }
  return r;
}

/**
 * Robuste Schätzung mit RANSAC + iterativer Verfeinerung per kleinsten Quadraten.
 * weights (optional): Matchqualität 0..1 zur Bevorzugung guter Kandidaten.
 */
export function ransac(src, dst, model, thresh, { iterations = 1500, confidence = 0.999, seed = 7, extent = 1 } = {}) {
  const n = src.length / 2, k = MODEL_MIN[model];
  if (n < k) return null;
  const rand = rng(seed);
  const t2 = thresh * thresh;
  let best = null, bestCount = 0, bestCost = Infinity;
  let maxIter = iterations;
  const sample = new Array(k);
  for (let it = 0; it < maxIter; it++) {
    // Stichprobe ohne Wiederholung
    for (let j = 0; j < k; j++) {
      let s, ok;
      do { s = (rand() * n) | 0; ok = true; for (let q = 0; q < j; q++) if (sample[q] === s) ok = false; } while (!ok);
      sample[j] = s;
    }
    if (k >= 2 && degenerateSample(src, sample)) continue;
    const H = fitModel(model, src, dst, sample);
    if (!H || (model !== 'translation' && !isPlausible(H, extent))) continue;
    const r = residuals2(H, src, dst, n);
    let count = 0, cost = 0;
    for (let i = 0; i < n; i++) {
      if (r[i] < t2) { count++; cost += r[i]; } else cost += t2; // MSAC-Kosten
    }
    if (cost < bestCost) {
      bestCost = cost; bestCount = count; best = H;
      const w = count / n;
      const pNoOutlier = 1 - Math.pow(w, k);
      if (pNoOutlier < 1e-9) maxIter = Math.min(maxIter, it + 1);
      else maxIter = Math.min(iterations, Math.ceil(Math.log(1 - confidence) / Math.log(pNoOutlier)) + 20);
    }
  }
  if (!best || bestCount < k) return null;
  // Verfeinerung: wiederholtes Neuschätzen auf Inliers mit schrumpfender Schwelle
  let H = best, inliers = [];
  for (let pass = 0; pass < 4; pass++) {
    const th = pass < 2 ? t2 : t2 * 0.6;
    const r = residuals2(H, src, dst, n);
    inliers = [];
    for (let i = 0; i < n; i++) if (r[i] < th) inliers.push(i);
    if (inliers.length < k) break;
    const H2 = fitModel(model, src, dst, inliers);
    if (!H2 || (model !== 'translation' && !isPlausible(H2, extent))) break;
    H = H2;
  }
  const r = residuals2(H, src, dst, n);
  inliers = [];
  let se = 0;
  for (let i = 0; i < n; i++) if (r[i] < t2) { inliers.push(i); se += r[i]; }
  return { H, inliers, rms: inliers.length ? Math.sqrt(se / inliers.length) : Infinity, total: n };
}

function degenerateSample(src, s) {
  for (let a = 0; a < s.length; a++)
    for (let b = a + 1; b < s.length; b++) {
      const dx = src[2 * s[a]] - src[2 * s[b]], dy = src[2 * s[a] + 1] - src[2 * s[b] + 1];
      if (dx * dx + dy * dy < 1e-6) return true;
    }
  if (s.length >= 3) {
    // Kollinearität von drei Punkten
    for (let a = 0; a < s.length; a++)
      for (let b = a + 1; b < s.length; b++)
        for (let c = b + 1; c < s.length; c++) {
          const x1 = src[2 * s[b]] - src[2 * s[a]], y1 = src[2 * s[b] + 1] - src[2 * s[a] + 1];
          const x2 = src[2 * s[c]] - src[2 * s[a]], y2 = src[2 * s[c] + 1] - src[2 * s[a] + 1];
          if (Math.abs(x1 * y2 - x2 * y1) < 1e-5) return true;
        }
  }
  return false;
}

// ---------- Zuschnitt ----------

/** Halbebenen (nx, ny, d) eines konvexen Polygons; Punkt p ist innen, wenn n·p >= d. */
export function halfPlanes(poly) {
  // Orientierung bestimmen
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    area += x1 * y2 - x2 * y1;
  }
  const sgn = area >= 0 ? 1 : -1;
  const planes = [];
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    let nx = -(y2 - y1) * sgn, ny = (x2 - x1) * sgn;
    const len = Math.hypot(nx, ny);
    if (len < 1e-12) continue;
    nx /= len; ny /= len;
    planes.push([nx, ny, nx * x1 + ny * y1]);
  }
  return planes;
}

/**
 * Größtes achsparalleles Rechteck mit Seitenverhältnis aspect (b/h), das in allen
 * konvexen Polygonen liegt. Gibt {x, y, w, h} zurück oder null.
 */
export function largestRect(polys, aspect, hint) {
  const planes = polys.flatMap(halfPlanes);
  const offs = [[-aspect / 2, -0.5], [aspect / 2, -0.5], [-aspect / 2, 0.5], [aspect / 2, 0.5]];
  // maximale Höhe s bei Mittelpunkt (cx, cy)
  const sAt = (cx, cy) => {
    let s = Infinity;
    for (const [nx, ny, d] of planes) {
      const slack = nx * cx + ny * cy - d;
      if (slack < 0) return -1;
      for (const [ox, oy] of offs) {
        const k = -(nx * ox + ny * oy);
        if (k > 1e-12) s = Math.min(s, slack / k);
      }
    }
    return s;
  };
  // Startpunkt: Hinweis oder Schwerpunkt der Eckpunkte
  let cx = 0, cy = 0, cnt = 0;
  for (const p of polys) for (const [x, y] of p) { cx += x; cy += y; cnt++; }
  cx /= cnt; cy /= cnt;
  if (hint && sAt(hint[0], hint[1]) > 0) { cx = hint[0]; cy = hint[1]; }
  let best = sAt(cx, cy);
  if (best <= 0) {
    // grobe Rastersuche nach einem gültigen Punkt
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of polys) for (const [x, y] of p) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    for (let i = 1; i < 40; i++) for (let j = 1; j < 40; j++) {
      const x = minX + (maxX - minX) * i / 40, y = minY + (maxY - minY) * j / 40, s = sAt(x, y);
      if (s > best) { best = s; cx = x; cy = y; }
    }
    if (best <= 0) return null;
  }
  // Mustersuche (s ist konkav in (cx, cy) -> konvergiert zum globalen Maximum)
  let step = best * 0.5;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]];
  while (step > 1e-7) {
    let improved = false;
    for (const [dx, dy] of dirs) {
      const s = sAt(cx + dx * step, cy + dy * step);
      if (s > best + 1e-12) { best = s; cx += dx * step; cy += dy * step; improved = true; break; }
    }
    if (!improved) step *= 0.5;
  }
  const h = best, w = best * aspect;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function quadOf(H, w, h) {
  return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => apply(H, x, y));
}

export function isConvexQuad(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4], [x3, y3] = q[(i + 2) % 4];
    const cr = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2);
    if (Math.abs(cr) < 1e-15) continue;
    const s = Math.sign(cr);
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}

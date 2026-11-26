// Ankerpunkte: vom Nutzer gesetzte markante Stellen im Referenzbild werden in jedem
// Foto per normierter Kreuzkorrelation (NCC) gesucht – grob auf einer kleinen
// Pyramidenebene mit Drehung/Zoom-Varianten, dann fein mit Subpixel-Genauigkeit.

import { mul, inv, apply } from './geometry.js';

const diag = (a, b = a) => [a, 0, 0, 0, b, 0, 0, 0, 1];

function sample(img, w, h, x, y) {
  if (!(x >= 0 && y >= 0 && x < w - 1 && y < h - 1)) return NaN;
  const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0, i = y0 * w + x0;
  return (img[i] * (1 - tx) + img[i + 1] * tx) * (1 - ty) + (img[i + w] * (1 - tx) + img[i + w + 1] * tx) * ty;
}

/** Vorlage (Template) um einen Punkt einer Ebene, als Offsets + normierte Werte. */
function template(L, px, py, r, step) {
  const offs = [], vals = [];
  for (let v = -r; v <= r; v += step) for (let u = -r; u <= r; u += step) {
    const val = sample(L.img, L.w, L.h, px + u, py + v);
    if (Number.isNaN(val)) return null;
    offs.push(u, v); vals.push(val);
  }
  const n = vals.length, mean = vals.reduce((a, b) => a + b, 0) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { vals[i] -= mean; ss += vals[i] * vals[i]; }
  const sd = Math.sqrt(ss);
  if (sd < 1e-3 * n) return { offs, vals: new Float32Array(vals), sd, flat: true };
  return { offs, vals: new Float32Array(vals), sd, flat: false };
}

/** NCC der Vorlage gegen das Bild bei Mittelpunkt (cx,cy) mit linearer Abbildung A (2x2). */
function nccAt(L, T, cx, cy, A) {
  const n = T.vals.length, buf = new Float32Array(n);
  let s = 0;
  for (let k = 0; k < n; k++) {
    const u = T.offs[2 * k], v = T.offs[2 * k + 1];
    const val = sample(L.img, L.w, L.h, cx + A[0] * u + A[1] * v, cy + A[2] * u + A[3] * v);
    if (Number.isNaN(val)) return -1;
    buf[k] = val; s += val;
  }
  const mean = s / n;
  let ss = 0, sp = 0;
  for (let k = 0; k < n; k++) { const d = buf[k] - mean; ss += d * d; sp += d * T.vals[k]; }
  return ss > 1e-6 ? sp / (Math.sqrt(ss) * T.sd) : -1;
}

/**
 * Sucht alle Ankerpunkte in einem Bild.
 * ref: { pyr, m }, img: { pyr, m }; anchors: [{x,y}] kanonisch im Referenzbild;
 * predH: Vorhersage Bild->Referenz (kanonisch) oder null.
 * Rückgabe: [{ x, y (kanonisch im Bild), score }]
 */
export function trackAnchors(ref, img, anchors, predH, { wide = false } = {}) {
  // Vorhersage als Pixelabbildung Ref(Ebene 0) -> Bild(Ebene 0)
  let W = diag(img.m / ref.m);
  if (predH) { const Hi = inv(predH); if (Hi) W = mul(diag(img.m), mul(Hi, diag(1 / ref.m))); }
  const cl = Math.max(0, img.pyr.findIndex(L => Math.max(L.w, L.h) <= 220));
  const lc = cl < 0 ? img.pyr.length - 1 : cl;
  const R0 = ref.pyr[0], Rc = ref.pyr[Math.min(lc, ref.pyr.length - 1)], I0 = img.pyr[0], Ic = img.pyr[lc];
  const sc = Ic.s;
  const out = [];
  for (const a of anchors) {
    const rx = a.x * ref.m, ry = a.y * ref.m;           // Ref-Pixel (Ebene 0)
    const [px, py] = apply(W, rx, ry);                 // vorhergesagte Lage im Bild
    // lokale lineare Abbildung der Vorhersage (Jacobi-Matrix) am Punkt
    const e = 1;
    const [ax, ay] = apply(W, rx + e, ry), [bx, by] = apply(W, rx, ry + e);
    const Jw = [ax - px, bx - px, ay - py, by - py];
    // --- grob ---
    const rT = Math.max(6, Math.round(0.05 * Math.max(Rc.w, Rc.h)));
    const Tc = template(Rc, rx / sc, ry / sc, rT, 1);
    if (!Tc || Tc.flat) { out.push({ x: px / img.m, y: py / img.m, score: 0, reason: Tc ? 'flach' : 'rand' }); continue; }
    const search = Math.round((predH ? 0.06 : 0.2) * Math.max(Ic.w, Ic.h));
    // wide: Vorhersage aus ungenauen Fingertipps -> mehr Drehungs-/Zoomvarianten
    const rots = !predH ? [-10, -5, 0, 5, 10] : wide ? [-9, -6, -3, 0, 3, 6, 9] : [-4, 0, 4];
    const scales = !predH ? [0.88, 1, 1.12] : wide ? [0.88, 0.94, 1, 1.06, 1.12] : [0.95, 1, 1.05];
    let best = { r: -2 };
    const step = search > 16 ? 2 : 1;
    for (const rot of rots) for (const s of scales) {
      const t = rot * Math.PI / 180, c = Math.cos(t) * s, sn = Math.sin(t) * s;
      const A = [Jw[0] * c - Jw[1] * sn, Jw[0] * sn + Jw[1] * c, Jw[2] * c - Jw[3] * sn, Jw[2] * sn + Jw[3] * c];
      for (let dy = -search; dy <= search; dy += step) for (let dx = -search; dx <= search; dx += step) {
        const r = nccAt(Ic, Tc, px / sc + dx, py / sc + dy, A);
        if (r > best.r) best = { r, x: px / sc + dx, y: py / sc + dy, A };
      }
    }
    // Mehrdeutigkeit prüfen: gibt es eine fast gleich gute Stelle weiter weg?
    let second = -1;
    {
      const A = best.A, minD = Math.max(3, rT * 0.6);
      for (let dy = -search; dy <= search; dy += 2) for (let dx = -search; dx <= search; dx += 2) {
        const x = px / sc + dx, y = py / sc + dy;
        if (Math.hypot(x - best.x, y - best.y) < minD) continue;
        const r = nccAt(Ic, Tc, x, y, A);
        if (r > second) second = r;
      }
    }
    if (step > 1) { // nachschärfen
      const b0 = best;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const r = nccAt(Ic, Tc, b0.x + dx, b0.y + dy, b0.A);
        if (r > best.r) best = { r, x: b0.x + dx, y: b0.y + dy, A: b0.A };
      }
    }
    // --- fein (Ebene 0) ---
    const rF = Math.max(8, Math.round(0.035 * Math.max(R0.w, R0.h)));
    const T0 = template(R0, rx, ry, rF, 1);
    let fx = best.x * sc, fy = best.y * sc, fr = best.r;
    if (T0 && !T0.flat) {
      const span = Math.ceil(sc) + 1;
      const grid = [];
      let bi = -1, bv = -2;
      for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
        const r = nccAt(I0, T0, best.x * sc + dx, best.y * sc + dy, best.A);
        grid.push(r);
        if (r > bv) { bv = r; bi = grid.length - 1; }
      }
      const side = 2 * span + 1, gx = bi % side, gy = (bi / side) | 0;
      fx = best.x * sc + gx - span; fy = best.y * sc + gy - span; fr = bv;
      // Subpixel per Parabel
      if (gx > 0 && gx < side - 1) { const l = grid[bi - 1], c = grid[bi], r = grid[bi + 1], d = l - 2 * c + r; if (d < 0) fx += Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / d)); }
      if (gy > 0 && gy < side - 1) { const u = grid[bi - side], c = grid[bi], dn = grid[bi + side], d = u - 2 * c + dn; if (d < 0) fy += Math.max(-0.5, Math.min(0.5, 0.5 * (u - dn) / d)); }
    }
    // Eindeutigkeit fließt in die Bewertung ein (gerade Kanten, Streifen -> unsicher)
    const unique = Math.max(0, Math.min(1, (best.r - second) / 0.15));
    out.push({ x: fx / img.m, y: fy / img.m, score: Math.max(0, fr) * (0.4 + 0.6 * unique), match: Math.max(0, fr), unique });
  }
  return out;
}

/** Wie eindeutig ist eine Stelle im Referenzbild? 0 = mehrdeutig/flach, 1 = sehr eindeutig. */
export function anchorUniqueness(ref, a) {
  const lc = Math.max(0, ref.pyr.findIndex(L => Math.max(L.w, L.h) <= 220));
  const L = ref.pyr[lc], sc = L.s;
  const rT = Math.max(6, Math.round(0.05 * Math.max(L.w, L.h)));
  const x = a.x * ref.m / sc, y = a.y * ref.m / sc;
  const T = template(L, x, y, rT, 1);
  if (!T) return { value: 0, reason: 'rand' };
  if (T.flat) return { value: 0, reason: 'flach' };
  const search = Math.round(0.1 * Math.max(L.w, L.h)), minD = Math.max(3, rT * 0.6);
  let second = -1;
  for (let dy = -search; dy <= search; dy += 1) for (let dx = -search; dx <= search; dx += 1) {
    if (Math.hypot(dx, dy) < minD) continue;
    const r = nccAt(L, T, x + dx, y + dy, [1, 0, 0, 1]);
    if (r > second) second = r;
  }
  return { value: Math.max(0, Math.min(1, (1 - second) / 0.25)), reason: second > 0.9 ? 'kante' : '' };
}

/**
 * Findet die Ankerpunkte in einem Foto ohne Vorwissen über Drehung/Zoom.
 * 1. Merkmale (dreh- und helligkeitsunabhängig) nur aus der Umgebung der Punkte
 *    im Referenzbild werden im ganzen Foto gesucht.
 * 2. Jede Lage, die sich aus zwei Zuordnungen ergibt, wird am Bild selbst geprüft:
 *    sieht es an den vorhergesagten Stellen (passend gedreht) aus wie an den Punkten?
 * 3. Die beste Lage dient als Vorhersage für die genaue Punktsuche.
 * refFeat/imgFeat: { n, xy (kanonisch), desc }; Rückgabe { predH, score } oder null.
 */
export function locateAnchors(ref, img, refFeat, imgFeat, anchors, { match, fitModel }) {
  const R = 0.08;
  const keep = [];
  for (let i = 0; i < refFeat.n; i++) {
    const x = refFeat.xy[2 * i], y = refFeat.xy[2 * i + 1];
    if (anchors.some(a => Math.hypot(x - a.x, y - a.y) < R)) keep.push(i);
  }
  if (keep.length < 4) return null;
  const W = refFeat.desc.length / refFeat.n;
  const sub = { n: keep.length, xy: new Float32Array(keep.length * 2), desc: new Uint32Array(keep.length * W) };
  keep.forEach((i, k) => { sub.xy[2 * k] = refFeat.xy[2 * i]; sub.xy[2 * k + 1] = refFeat.xy[2 * i + 1]; sub.desc.set(refFeat.desc.subarray(i * W, i * W + W), k * W); });
  const m = match(sub, imgFeat, { ratio: 0.9, maxDist: 100 });
  if (m.length < 2) return null;
  const src = [], dst = [];
  for (const [i, j] of m) { src.push(imgFeat.xy[2 * j], imgFeat.xy[2 * j + 1]); dst.push(sub.xy[2 * i], sub.xy[2 * i + 1]); }
  // Vorlagen der Punkte auf der groben Ebene
  const lc = Math.max(0, ref.pyr.findIndex(L => Math.max(L.w, L.h) <= 220));
  const Rc = ref.pyr[lc], Ic = img.pyr[Math.min(lc, img.pyr.length - 1)], sc = Rc.s;
  const rT = Math.max(6, Math.round(0.05 * Math.max(Rc.w, Rc.h)));
  const temps = anchors.map(a => template(Rc, a.x * ref.m / sc, a.y * ref.m / sc, rT, 1)).filter(Boolean);
  const verify = H => {
    // H: Bild -> Referenz (kanonisch); Lage der Punkte im Bild über H^-1
    const Hi = inv(H);
    if (!Hi) return -1;
    const ang = Math.atan2(Hi[3], Hi[0]), s = Math.hypot(Hi[0], Hi[3]) * img.m / ref.m;
    const A = [Math.cos(ang) * s, -Math.sin(ang) * s, Math.sin(ang) * s, Math.cos(ang) * s];
    let sum = 0, n = 0;
    anchors.forEach((a, k) => {
      const T = temps[k];
      if (!T || T.flat) return;
      const [x, y] = apply(Hi, a.x, a.y);
      const cx = x * img.m / sc, cy = y * img.m / sc;
      let best = -1;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) best = Math.max(best, nccAt(Ic, T, cx + dx, cy + dy, A));
      sum += Math.max(0, best); n++;
    });
    return n ? sum / n : -1;
  };
  // Hypothesen aus Paaren von Zuordnungen (Ähnlichkeit: Drehung, Zoom, Lage)
  const n = m.length, pairs = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  for (let i = pairs.length - 1; i > 0; i--) { const r = (i * 2654435761) % (i + 1); [pairs[i], pairs[r]] = [pairs[r], pairs[i]]; }
  let best = null;
  for (const [i, j] of pairs.slice(0, 1500)) {
    const d = Math.hypot(dst[2 * i] - dst[2 * j], dst[2 * i + 1] - dst[2 * j + 1]);
    if (d < 0.02) continue;
    const H = fitModel('similarity', src, dst, [i, j]);
    if (!H) continue;
    const zoom = Math.hypot(H[0], H[3]);
    if (zoom < 0.5 || zoom > 2) continue;
    // Stützende Zuordnungen (grob) als Vorauswahl
    let sup = 0;
    for (let k = 0; k < n; k++) { const [x, y] = apply(H, src[2 * k], src[2 * k + 1]); if (Math.hypot(x - dst[2 * k], y - dst[2 * k + 1]) < 0.006) sup++; }
    if (best && sup < best.sup * 0.5 && sup < 3) continue;
    const v = verify(H);
    const total = v + 0.01 * Math.min(sup, 20);
    if (!best || total > best.total) best = { H, v, sup, total };
  }
  if (!best) return null;
  // Schräg aufgenommene Fotos: aus allen zur besten Lage passenden Zuordnungen eine
  // affine Abbildung schätzen (erfasst Neigung/Perspektive näherungsweise)
  let H = best.H, v = best.v;
  const near = [];
  for (let k = 0; k < n; k++) { const [x, y] = apply(best.H, src[2 * k], src[2 * k + 1]); if (Math.hypot(x - dst[2 * k], y - dst[2 * k + 1]) < 0.04) near.push(k); }
  if (near.length >= 6) {
    let bestA = null;
    for (let t = 0; t < 300; t++) {
      const tri = [near[(t * 7919) % near.length], near[(t * 104729 + 1) % near.length], near[(t * 1299709 + 2) % near.length]];
      if (new Set(tri).size < 3) continue;
      const Ha = fitModel('affine', src, dst, tri);
      if (!Ha) continue;
      const inl = near.filter(k => { const [x, y] = apply(Ha, src[2 * k], src[2 * k + 1]); return Math.hypot(x - dst[2 * k], y - dst[2 * k + 1]) < 0.008; });
      if (!bestA || inl.length > bestA.inl.length) bestA = { Ha, inl };
    }
    if (bestA && bestA.inl.length >= 6) {
      const Hf = fitModel('affine', src, dst, bestA.inl);
      const vf = Hf ? verify(Hf) : -1;
      if (vf >= v - 0.02) { H = Hf; v = vf; }
    }
  }
  return { predH: H, score: v, support: best.sup };
}

// ---------- Sternbild-Verfahren: Anordnung der Punkte statt Aussehen ----------
// Flocken o. Ä. können ihr Aussehen stark ändern (z. B. vom Schleimpilz überwachsen,
// anderes Licht). Ihre Lage zueinander bleibt gleich. Daher: alle „Flecken“ passender
// Größe finden und die Punkte-Anordnung (gedreht/gezoomt) darauf zur Deckung bringen.

/** Flecken (Blobs) in einem Graubild finden – hell oder dunkel, Größe ~ size (kanonisch). */
export function detectBlobs(pyr, m, { maxBlobs = 24, cpyr = null } = {}) {
  const li = Math.max(0, pyr.findIndex(L => Math.max(L.w, L.h) <= 340));
  const idx = li < 0 ? pyr.length - 1 : li;
  const L = pyr[idx], C = cpyr ? cpyr[Math.min(idx, cpyr.length - 1)] : null;
  const { w, h } = L;
  const base = Math.max(w, h);
  // Helligkeit des Untergrunds: Flecken müssen auf hellem Grund liegen (Papier, nicht Holz/Rand)
  const lum = blurF(L.img, w, h, 0.004 * base);
  const sorted = Float32Array.from(lum).sort();
  const bright = sorted[Math.floor(sorted.length * 0.95)];
  const cands = [];
  for (const chan of C ? [L.img, C.img] : [L.img]) {
    // Hesse-Determinante: reagiert auf kompakte Flecken (hell oder dunkel), nicht auf Kanten
    for (const sig of [0.011, 0.015, 0.021].map(f => f * base)) {
      const g = blurF(chan, w, h, sig);
      const det = new Float32Array(w * h), ok = new Uint8Array(w * h);
      const s4 = sig * sig * sig * sig;
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const xx = g[i - 1] - 2 * g[i] + g[i + 1], yy = g[i - w] - 2 * g[i] + g[i + w];
        const xy = (g[i - w - 1] + g[i + w + 1] - g[i - w + 1] - g[i + w - 1]) / 4;
        const d = xx * yy - xy * xy, tr = xx + yy;
        det[i] = d * s4;
        ok[i] = d > 0 && (tr * tr) / d < 10 ? 1 : 0; // Kanten/Linien verwerfen
      }
      const r = Math.max(2, Math.round(sig * 1.2)), ring = Math.max(3, Math.round(sig * 2.4));
      for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
        const i = y * w + x, v = det[i];
        if (!ok[i] || v < 0.05) continue;
        let isMax = true;
        for (let dy = -r; dy <= r && isMax; dy++) for (let dx = -r; dx <= r; dx++) {
          if ((dx || dy) && det[i + dy * w + dx] > v) { isMax = false; break; }
        }
        if (!isMax) continue;
        // Ring um den Fleck: überwiegend hell (Papier)?
        let brightCnt = 0, tot = 0;
        for (let t = 0; t < 16; t++) {
          const a = t * Math.PI / 8, xx = Math.round(x + Math.cos(a) * ring), yy = Math.round(y + Math.sin(a) * ring);
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          tot++; if (lum[yy * w + xx] >= bright * 0.8) brightCnt++;
        }
        if (!tot || brightCnt / tot < 0.5) continue;
        cands.push({ x: (x + 0.5) * L.s / m, y: (y + 0.5) * L.s / m, v, sig: sig * L.s / m });
      }
    }
  }
  cands.sort((p, q) => q.v - p.v);
  const out = [];
  for (const c of cands) {
    if (out.length >= maxBlobs) break;
    if (out.every(o => Math.hypot(o.x - c.x, o.y - c.y) > Math.max(o.sig, c.sig) * 1.8)) out.push(c);
  }
  return out;
}

function blurF(src, w, h, sigma) {
  // schneller Gauß-Ersatz: dreifacher Boxfilter
  let a = Float32Array.from(src), b = new Float32Array(w * h);
  const r = Math.max(1, Math.round(sigma * 0.8));
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      let s = 0; const row = y * w;
      for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) { b[row + x] = s / (2 * r + 1); s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) { a[y * w + x] = s / (2 * r + 1); s += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x]; }
    }
  }
  return a;
}

/**
 * Wie gut passt eine Lage H (Bild -> Referenz, kanonisch) zur Punkte-Anordnung?
 * Rückgabe { support (Anzahl Punkte mit Fleck in der Nähe), cost, near[] }.
 */
export function constellationSupport(H, anchors, blobs, tol = 0.022) {
  const Hi = inv(H);
  if (!Hi) return { support: 0, cost: Infinity, strength: 0, near: [] };
  const zoom = Math.sqrt(Math.abs(Hi[0] * Hi[4] - Hi[1] * Hi[3])) || 1; // Bild/Referenz
  let support = 0, cost = 0, strength = 0;
  const near = anchors.map(a => {
    const [x, y] = apply(Hi, a.x, a.y);
    let best = null, bd = Infinity;
    for (const b of blobs) {
      // Größe muss zur Flocke im Bezugsfoto passen (falls bekannt)
      if (a.sig) { const r = b.sig / (a.sig * zoom); if (r < 0.55 || r > 1.8) continue; }
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bd) { bd = d; best = b; }
    }
    if (bd < tol) { support++; cost += bd; strength += best.v; return best; }
    cost += tol;
    return null;
  });
  return { support, cost, strength, near };
}

const better = (a, b) => !b || a.support > b.support || (a.support === b.support && (a.cost < b.cost * 0.85 || (a.cost <= b.cost * 1.15 && a.strength > b.strength)));

/** Sucht die Lage, bei der die meisten Punkte auf passenden Flecken liegen (beliebige Drehung, Zoom 0,6–1,7). */
export function matchConstellation(anchors, blobs, { fitModel, tol = 0.022 } = {}) {
  const n = anchors.length;
  if (n < 2 || blobs.length < 2) return null;
  // Lagen nur aus den deutlichsten Flecken bilden (Flocken sind meist die stärksten)
  const strong = blobs.slice(0, 14);
  let best = null;
  const src = [0, 0, 0, 0], dst = [0, 0, 0, 0];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const da = Math.hypot(anchors[b].x - anchors[a].x, anchors[b].y - anchors[a].y);
    if (da < 0.04) continue;
    for (let i = 0; i < strong.length; i++) for (let j = 0; j < strong.length; j++) {
      if (i === j) continue;
      const db = Math.hypot(strong[j].x - strong[i].x, strong[j].y - strong[i].y);
      const s = db / da;
      if (s < 0.6 || s > 1.7) continue;
      if (anchors[a].sig && (strong[i].sig / (anchors[a].sig * s) < 0.55 || strong[i].sig / (anchors[a].sig * s) > 1.8)) continue;
      src[0] = strong[i].x; src[1] = strong[i].y; src[2] = strong[j].x; src[3] = strong[j].y;
      dst[0] = anchors[a].x; dst[1] = anchors[a].y; dst[2] = anchors[b].x; dst[3] = anchors[b].y;
      const H = fitModel('similarity', src, dst, [0, 1]);
      if (!H) continue;
      const sup = constellationSupport(H, anchors, blobs, tol);
      if (sup.support < 2) continue;
      // Ausgleich über alle getroffenen Punkte -> genauere Bewertung
      const s2 = [], d2 = [], idx = [];
      sup.near.forEach((bb, k) => { if (bb) { idx.push(s2.length / 2); s2.push(bb.x, bb.y); d2.push(anchors[k].x, anchors[k].y); } });
      const Hf = idx.length >= 3 ? fitModel('similarity', s2, d2, idx) : H;
      const supF = Hf ? constellationSupport(Hf, anchors, blobs, tol) : sup;
      const cand = supF.support >= sup.support ? { H: Hf, ...supF } : { H, ...sup };
      if (better(cand, best)) best = cand;
    }
  }
  if (!best || best.support < Math.min(3, n)) return best && { ...best, weak: true };
  return best;
}

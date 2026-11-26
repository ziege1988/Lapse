// Web Worker: Merkmale berechnen und Bilder zueinander ausrichten.
// Koordinaten werden "kanonisch" gespeichert: Pixel / längste Bildkante,
// damit Ergebnisse unabhängig von der Analyseauflösung sind.
//
// Ausrichtung je Bild in zwei Stufen:
//  1. Merkmale (Ecken + Deskriptoren + RANSAC) – schnell, gut bei viel Struktur.
//  2. Flächenbasiert (direct.js) – robust bei wenig Struktur und Handaufnahmen;
//     startet von Merkmalsergebnis, Nachbarbild und einer groben Suche.
// Beide Ergebnisse werden mit derselben Kennzahl (NCC) bewertet, das bessere gewinnt.

import { detect, match } from './features.js';
import { ransac, I3, mul, inv, isPlausible } from './geometry.js';
import { pyramid, alignDirect, score } from './direct.js';
import { trackAnchors, anchorUniqueness } from './anchors.js';

const store = new Map(); // id -> { n, xy (kanonisch), desc, res }
let ref = null;          // { id, pyr, m } Referenz für flächenbasierte Ausrichtung / Ankerpunkte

const diag = (a, b = a) => [a, 0, 0, 0, b, 0, 0, 0, 1];
// kanonisch (Bild -> Referenz) <-> Pixel (Referenz -> Bild)
const toPixelW = (H, mRef, mImg) => { const Hi = inv(H); return Hi && mul(diag(mImg), mul(Hi, diag(1 / mRef))); };
const toCanonH = (W, mRef, mImg) => { const Wi = inv(W); return Wi && mul(diag(1 / mRef), mul(Wi, diag(mImg))); };

function featureAlign(A, B, model, msg) {
  const matches = match(A, B);
  const n = matches.length;
  const src = new Float64Array(n * 2), dst = new Float64Array(n * 2);
  matches.forEach(([i, j], k) => {
    src[2 * k] = A.xy[2 * i]; src[2 * k + 1] = A.xy[2 * i + 1];
    dst[2 * k] = B.xy[2 * j]; dst[2 * k + 1] = B.xy[2 * j + 1];
  });
  const res = Math.min(A.res, B.res);
  const thresh = (msg.threshPx ?? 2.5) / res;
  // Erst robustes einfaches Modell, dann ggf. Perspektive auf großzügigeren Inliers
  let r = ransac(src, dst, model === 'homography' ? 'similarity' : model, thresh * (model === 'homography' ? 4 : 1),
    { iterations: msg.iterations ?? 1500, seed: 11 });
  if (r && model === 'homography' && r.inliers.length >= 12) {
    const s2 = new Float64Array(r.inliers.length * 2), d2 = new Float64Array(r.inliers.length * 2);
    r.inliers.forEach((i, k) => { s2[2 * k] = src[2 * i]; s2[2 * k + 1] = src[2 * i + 1]; d2[2 * k] = dst[2 * i]; d2[2 * k + 1] = dst[2 * i + 1]; });
    const rh = ransac(s2, d2, 'homography', thresh, { iterations: msg.iterations ?? 1500, seed: 13 });
    if (rh && rh.inliers.length >= Math.max(10, r.inliers.length * 0.5)) r = { ...rh, total: n };
  }
  if (!r || r.inliers.length < 8) return { ok: false, matches: n };
  return { ok: true, H: r.H, inliers: r.inliers.length, total: n, rms: r.rms * res };
}

function handle(msg) {
  switch (msg.type) {
    case 'features': {
      const { id, gray, w, h, maxFeatures, levels } = msg;
      const f = detect(new Uint8Array(gray), w, h, { maxFeatures, levels });
      const m = Math.max(w, h);
      for (let i = 0; i < f.xy.length; i++) f.xy[i] /= m;
      store.set(id, { n: f.n, xy: f.xy, desc: f.desc, res: m });
      return { type: 'features', id, n: f.n };
    }
    case 'setRef': {
      const { id, gray, w, h } = msg;
      ref = { id, pyr: pyramid(new Uint8Array(gray), w, h), m: Math.max(w, h), w, h };
      return { type: 'setRef', id };
    }
    case 'align': {
      const { id, refId, model } = msg;
      if (id === refId) return { type: 'align', id, refId, ok: true, H: I3(), inliers: Infinity, total: 0, rms: 0, ncc: 1, method: 'ref' };
      const A = store.get(id), B = store.get(refId);
      const feat = A && B ? featureAlign(A, B, model, msg) : { ok: false, matches: 0 };
      // Ohne Graubild (oder andere Referenz) nur Merkmale
      if (!msg.gray || !ref || ref.id !== refId) {
        return { type: 'align', id, refId, ...feat, ok: feat.ok, ncc: null, method: 'merkmale' };
      }
      const mImg = Math.max(msg.w, msg.h);
      const pyr = pyramid(new Uint8Array(msg.gray), msg.w, msg.h);
      const cands = [];
      if (feat.ok && isPlausible(feat.H)) {
        const W = toPixelW(feat.H, ref.m, mImg);
        if (W) cands.push({ W, from: 'merkmale', r: score(ref.pyr, pyr, W, 0).r });
      }
      const strongFeat = feat.ok && feat.inliers >= 40 && cands[0]?.r >= 0.85;
      if (!strongFeat || msg.thorough) {
        const inits = [];
        if (cands[0]) inits.push(cands[0].W);
        for (const H of msg.inits || []) { const W = H && toPixelW(H, ref.m, mImg); if (W) inits.push(W); }
        inits.push(diag(mImg / ref.m)); // gleiche Lage
        const dmodel = model === 'translation' ? 'translation' : model === 'similarity' ? 'affine' : 'homography';
        const d = alignDirect(ref.pyr, pyr, { model: dmodel, inits, search: true });
        if (d) cands.push({ W: d.W, from: 'flächig', r: d.r, cover: d.cover });
      }
      cands.sort((a, b) => b.r - a.r);
      const best = cands[0];
      if (!best) return { type: 'align', id, refId, ok: false, matches: feat.matches || 0, ncc: null, method: 'keine' };
      const H = toCanonH(best.W, ref.m, mImg);
      if (!H || !isPlausible(H, 1)) return { type: 'align', id, refId, ok: false, matches: feat.matches || 0, ncc: best.r, method: best.from };
      return {
        type: 'align', id, refId, ok: best.r >= 0.5, H, ncc: best.r, method: best.from,
        inliers: feat.ok ? feat.inliers : 0, total: feat.total || feat.matches || 0, rms: feat.ok ? feat.rms : 0,
      };
    }
    case 'track': {
      // Ankerpunkte in einem Bild suchen (siehe anchors.js)
      if (!ref || ref.id !== msg.refId) return { type: 'track', id: msg.id, ok: false };
      const pyr = pyramid(new Uint8Array(msg.gray), msg.w, msg.h);
      const res = trackAnchors(ref, { pyr, m: Math.max(msg.w, msg.h) }, msg.anchors, msg.predH);
      return { type: 'track', id: msg.id, ok: true, points: res };
    }
    case 'refineAnchored': {
      // Je Punktgruppe (Hypothese) eine grobe Lage. Das Bild entscheidet, welche stimmt
      // (Gruppe auf unbewegtem Hintergrund passt flächig am besten), dann Verfeinerung
      // per Flächenvergleich. Übernahme nur, wenn die Punkte dieser Gruppe weiter passen.
      if (!ref || ref.id !== msg.refId) return { type: 'refineAnchored', ok: false };
      const mImg = Math.max(msg.w, msg.h);
      const pyr = pyramid(new Uint8Array(msg.gray), msg.w, msg.h);
      const lv = Math.min(1, ref.pyr.length - 1);
      let best = null;
      msg.hyps.forEach((h, i) => {
        const W = toPixelW(h.H, ref.m, mImg);
        if (!W) return;
        const r = score(ref.pyr, pyr, W, lv).r;
        if (!best || r > best.r) best = { i, W, r, pairs: h.pairs };
      });
      if (!best) return { type: 'refineAnchored', ok: false };
      const dmodel = msg.model === 'translation' ? 'translation' : msg.model === 'similarity' ? 'affine' : 'homography';
      const d = alignDirect(ref.pyr, pyr, { model: dmodel, inits: [best.W], search: false });
      let H = d && toCanonH(d.W, ref.m, mImg), ncc = d?.r ?? null;
      let worst = Infinity;
      if (H && isPlausible(H, 1)) {
        worst = 0;
        for (const p of best.pairs) {
          const z = H[6] * p.fx + H[7] * p.fy + H[8];
          const x = (H[0] * p.fx + H[1] * p.fy + H[2]) / z, y = (H[3] * p.fx + H[4] * p.fy + H[5]) / z;
          worst = Math.max(worst, Math.hypot(x - p.rx, y - p.ry) * ref.m);
        }
      }
      // Verfeinerung nur übernehmen, wenn sie flächig nicht schlechter ist und die Punkte grob passen
      const baseR = score(ref.pyr, pyr, best.W, 0).r;
      const refined = worst <= msg.tolPx && ncc != null && ncc >= baseR - 0.005;
      if (!refined) { H = msg.hyps[best.i].H; ncc = baseR; }
      return { type: 'refineAnchored', ok: true, idx: best.i, H, ncc, refined, worst };
    }
    case 'uniq': {
      if (!ref || ref.id !== msg.refId) return { type: 'uniq', values: [] };
      return { type: 'uniq', values: msg.anchors.map(a => anchorUniqueness(ref, a)) };
    }
    case 'drop': store.delete(msg.id); return { type: 'drop', id: msg.id };
    case 'reset': store.clear(); ref = null; return { type: 'reset' };
  }
  return { type: 'unknown' };
}

self.onmessage = e => {
  const msg = e.data;
  try {
    const out = handle(msg);
    self.postMessage({ ...out, reqId: msg.reqId });
  } catch (err) {
    self.postMessage({ type: 'error', reqId: msg.reqId, message: String(err && err.message || err) });
  }
};

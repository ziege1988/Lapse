// Web Worker: Merkmale berechnen und Bilder zueinander ausrichten.
// Koordinaten werden "kanonisch" gespeichert: Pixel / längste Bildkante,
// damit Ergebnisse unabhängig von der Analyseauflösung sind.

import { detect, match } from './features.js';
import { ransac, I3 } from './geometry.js';

const store = new Map(); // id -> { n, xy (kanonisch), desc, res }

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
    case 'align': {
      const { id, refId, model } = msg;
      const A = store.get(id), B = store.get(refId);
      if (!A || !B) return { type: 'align', id, refId, ok: false, reason: 'missing' };
      if (id === refId) return { type: 'align', id, refId, ok: true, H: I3(), inliers: A.n, total: A.n, rms: 0 };
      const matches = match(A, B);
      const n = matches.length;
      const src = new Float64Array(n * 2), dst = new Float64Array(n * 2);
      matches.forEach(([i, j], k) => {
        src[2 * k] = A.xy[2 * i]; src[2 * k + 1] = A.xy[2 * i + 1];
        dst[2 * k] = B.xy[2 * j]; dst[2 * k + 1] = B.xy[2 * j + 1];
      });
      const res = Math.min(A.res, B.res);
      const thresh = (msg.threshPx ?? 2.5) / res;
      // Erst robustes einfaches Modell, dann ggf. Perspektive auf dessen Inliers
      let r = ransac(src, dst, model === 'homography' ? 'similarity' : model, thresh * (model === 'homography' ? 3 : 1),
        { iterations: msg.iterations ?? 1500, seed: 11 });
      if (r && model === 'homography' && r.inliers.length >= 12) {
        const s2 = new Float64Array(r.inliers.length * 2), d2 = new Float64Array(r.inliers.length * 2);
        r.inliers.forEach((i, k) => { s2[2 * k] = src[2 * i]; s2[2 * k + 1] = src[2 * i + 1]; d2[2 * k] = dst[2 * i]; d2[2 * k + 1] = dst[2 * i + 1]; });
        const rh = ransac(s2, d2, 'homography', thresh, { iterations: msg.iterations ?? 1500, seed: 13 });
        if (rh && rh.inliers.length >= Math.max(10, r.inliers.length * 0.5)) r = { ...rh, total: n };
      }
      if (!r || r.inliers.length < 8) return { type: 'align', id, refId, ok: false, reason: 'nomatch', matches: n };
      return {
        type: 'align', id, refId, ok: true, H: r.H, inliers: r.inliers.length, total: n,
        rms: r.rms * res, // in Analysepixeln
      };
    }
    case 'drop': store.delete(msg.id); return { type: 'drop', id: msg.id };
    case 'reset': store.clear(); return { type: 'reset' };
    case 'has': return { type: 'has', id: msg.id, has: store.has(msg.id), res: store.get(msg.id)?.res ?? 0 };
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

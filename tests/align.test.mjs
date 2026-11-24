// Prüft die Ausrichtung mit synthetischen Bildern und bekannter Transformation.
// Aufruf: node tests/align.test.mjs
import { detect, match } from '../js/features.js';
import { ransac, apply, inv, similarityAbout, largestRect, quadOf } from '../js/geometry.js';
import assert from 'node:assert/strict';

function scene(w, h, seed = 1) {
  // Texturierte Szene: Rechtecke, Kreise, Rauschen
  let s = seed;
  const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const img = new Float32Array(w * h).fill(90);
  for (let k = 0; k < 400; k++) {
    const cx = r() * w, cy = r() * h, rad = 3 + r() * 25, v = r() * 255, rect = r() < 0.5;
    for (let y = Math.max(0, cy - rad | 0); y < Math.min(h, cy + rad); y++)
      for (let x = Math.max(0, cx - rad | 0); x < Math.min(w, cx + rad); x++)
        if (rect || (x - cx) ** 2 + (y - cy) ** 2 < rad * rad) img[y * w + x] = v;
  }
  return img;
}
function warp(src, w, h, H, gain = 1, bias = 0) {
  // out(p) = src(H^-1 p) bilinear
  const Hi = inv(H), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [u, v] = apply(Hi, x, y);
    let val = 0;
    if (u >= 0 && v >= 0 && u < w - 1 && v < h - 1) {
      const x0 = u | 0, y0 = v | 0, tx = u - x0, ty = v - y0, i = y0 * w + x0;
      val = (src[i] * (1 - tx) + src[i + 1] * tx) * (1 - ty) + (src[i + w] * (1 - tx) + src[i + w + 1] * tx) * ty;
    }
    out[y * w + x] = Math.max(0, Math.min(255, val * gain + bias + (Math.random() - 0.5) * 6));
  }
  return out;
}
const w = 800, h = 600, base = scene(w, h);
const ref = warp(base, w, h, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
const cases = [
  ['similarity', similarityAbout(400, 300, 23.4, -11.7, 2.5, 1.04), 1, 0],
  ['similarity', similarityAbout(400, 300, -40, 18, -4, 0.95), 0.55, 10],   // dunkler
  ['homography', [1.02, 0.03, -15, -0.02, 0.99, 12, 0.00004, -0.00003, 1], 1.3, -20],
];
const t0 = Date.now();
const fr = detect(ref, w, h, { maxFeatures: 1500 });
console.log('Referenz-Merkmale:', fr.n, `${Date.now() - t0} ms`);
for (const [model, H, g, b] of cases) {
  const t1 = Date.now();
  const img = warp(base, w, h, H, g, b);
  const f = detect(img, w, h, { maxFeatures: 1500 });
  const m = match(f, fr);
  const src = new Float64Array(m.length * 2), dst = new Float64Array(m.length * 2);
  m.forEach(([i, j], k) => { src.set([f.xy[2 * i], f.xy[2 * i + 1]], 2 * k); dst.set([fr.xy[2 * j], fr.xy[2 * j + 1]], 2 * k); });
  const r = ransac(src, dst, model, 2.5, { extent: 800 });
  // Erwartet: Bildpunkt -> Referenzpunkt = H^-1
  const Hexp = inv(H);
  let maxErr = 0;
  for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h], [400, 300]]) {
    const [a, c] = apply(r.H, x, y), [e, d] = apply(Hexp, x, y);
    maxErr = Math.max(maxErr, Math.hypot(a - e, c - d));
  }
  console.log(`${model}: Merkmale ${f.n}, Matches ${m.length}, Inlier ${r.inliers.length}, RMS ${r.rms.toFixed(2)} px, max. Eckfehler ${maxErr.toFixed(2)} px, ${Date.now() - t1} ms`);
  assert.ok(maxErr < 1.5, 'Ausrichtungsfehler zu groß');
}
// Zuschnitt: zwei verschobene Rechtecke
const rect = largestRect([quadOf([1, 0, 0, 0, 1, 0, 0, 0, 1], 4, 3), quadOf([1, 0, 0.5, 0, 1, 0.2, 0, 0, 1], 4, 3)], 4 / 3);
console.log('Zuschnitt', rect);
// Schnittmenge [0.5,4]x[0.2,3] -> Breite begrenzt: 3.5 x 2.625
assert.ok(Math.abs(rect.w - 3.5) < 1e-3 && Math.abs(rect.h - 2.625) < 1e-3);
console.log('OK');

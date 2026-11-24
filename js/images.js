// Bilder dekodieren und skalieren. Originale bleiben als File-Referenz erhalten,
// im Speicher liegen nur kleine Vorschauen (JPEG-Blobs) – wichtig fürs iPhone.

/** Dekodiert eine Bilddatei (EXIF-Ausrichtung wird vom Browser angewendet). */
export async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Rückfall (z. B. HEIC in älteren Safari-Versionen über <img>)
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}

export const sizeOf = src => ({ w: src.naturalWidth || src.width, h: src.naturalHeight || src.height });

export function release(src) {
  if (src && typeof src.close === 'function') src.close();
}

// iOS begrenzt die Canvas-Fläche (ca. 16,7 MP) und den Gesamtspeicher aller Canvas.
const MAX_AREA = 16_000_000;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function freeCanvas(c) { c.width = 0; c.height = 0; }

/**
 * Zeichnet src so, dass die lange Kante maxLong Pixel misst (nie hochskaliert).
 * Starke Verkleinerungen erfolgen in Halbierungsschritten für saubere Kanten.
 */
export function scaleTo(src, maxLong) {
  const { w, h } = sizeOf(src);
  let s = Math.min(1, maxLong / Math.max(w, h));
  if (w * h * s * s > MAX_AREA) s = Math.sqrt(MAX_AREA / (w * h));
  const tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
  let cur = src, cw = w, ch = h, tmp = null;
  while (cw / 2 >= tw * 1.0001 && ch / 2 >= th) {
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const c = makeCanvas(nw, nh);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, nw, nh);
    if (tmp) freeCanvas(tmp);
    tmp = c; cur = c; cw = nw; ch = nh;
  }
  const out = makeCanvas(tw, th);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, tw, th);
  if (tmp) freeCanvas(tmp);
  return out;
}

export function toBlob(canvas, type = 'image/jpeg', quality = 0.85) {
  return new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('Bild konnte nicht kodiert werden'))), type, quality));
}

/** Graustufen (Rec. 709 Luma) als Uint8Array. */
export function grayOf(canvas) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8;
  return { gray: g, w, h };
}

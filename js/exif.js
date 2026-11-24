// Minimaler EXIF-Leser für JPEG: liefert das Aufnahmedatum (DateTimeOriginal).
// HEIC/PNG werden nicht ausgewertet -> Rückfall auf Dateidatum/-namen.

export async function readCaptureTime(file) {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
    let p = 2;
    while (p + 4 < v.byteLength) {
      if (v.getUint8(p) !== 0xFF) return null;
      const marker = v.getUint8(p + 1), len = v.getUint16(p + 2);
      if (marker === 0xE1 && v.getUint32(p + 4) === 0x45786966) return parseTiff(v, p + 10);
      if (marker === 0xDA) return null;
      p += 2 + len;
    }
  } catch { /* nicht lesbar */ }
  return null;
}

function parseTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
  const readIfd = off => {
    const out = new Map();
    const n = u16(t + off);
    for (let i = 0; i < n; i++) {
      const e = t + off + 2 + i * 12;
      if (e + 12 > v.byteLength) break;
      out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
    }
    return out;
  };
  const str = ent => {
    if (!ent) return null;
    const o = ent.count > 4 ? t + u32(ent.at) : ent.at;
    let s = '';
    for (let i = 0; i < ent.count && o + i < v.byteLength; i++) {
      const c = v.getUint8(o + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const ifd0 = readIfd(u32(t + 4));
  let date = null, sub = null;
  const exifPtr = ifd0.get(0x8769);
  if (exifPtr) {
    const ex = readIfd(u32(exifPtr.at));
    date = str(ex.get(0x9003)) || str(ex.get(0x9004));
    sub = str(ex.get(0x9291));
  }
  date = date || str(ifd0.get(0x0132));
  if (!date) return null;
  const m = date.match(/(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const ms = sub ? Number(('0.' + sub.replace(/\D/g, '')).slice(0, 5)) * 1000 : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + ms;
}

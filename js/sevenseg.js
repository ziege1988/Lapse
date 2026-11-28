// 7-Segment-Ziffern (digitale Anzeige) für Startbild und Zeitanzeige im Video.

//  aaa
// f   b
//  ggg
// e   c
//  ddd
const MAP = {
  0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
  '-': 'g', d: 'bcdeg', h: 'cefg', ' ': '',
};

/** Breite eines Zeichens relativ zur Ziffernhöhe h. */
const charW = (ch, h) => (ch === ':' || ch === '.' ? h * 0.28 : ch === ' ' ? h * 0.3 : h * 0.56);

export function sevenSegWidth(text, h) {
  let w = 0;
  for (const ch of text) w += charW(ch, h) + h * 0.1;
  return Math.max(0, w - h * 0.1);
}

/**
 * Zeichnet text (Ziffern, ':', '.', '-', 'd', 'h', ' ') als 7-Segment-Anzeige.
 * (x, y) = linke obere Ecke; h = Ziffernhöhe. Unbeleuchtete Segmente werden schwach angedeutet.
 */
export function drawSevenSeg(ctx, text, x, y, h, { on = '#f3c08a', off = 'rgba(255,255,255,.07)', glow = true } = {}) {
  const t = Math.max(1.5, h * 0.12), w = h * 0.56, gap = t * 0.18;
  ctx.save();
  ctx.translate(x, y);
  ctx.transform(1, 0, -0.08, 1, h * 0.08, 0); // leichte Schrägstellung wie bei echten Anzeigen
  // Segment als Sechseck zwischen zwei Punkten
  const seg = (x1, y1, x2, y2) => {
    const horiz = y1 === y2, ht = t / 2;
    ctx.beginPath();
    if (horiz) {
      ctx.moveTo(x1 + gap, y1); ctx.lineTo(x1 + gap + ht, y1 - ht); ctx.lineTo(x2 - gap - ht, y1 - ht);
      ctx.lineTo(x2 - gap, y1); ctx.lineTo(x2 - gap - ht, y1 + ht); ctx.lineTo(x1 + gap + ht, y1 + ht);
    } else {
      ctx.moveTo(x1, y1 + gap); ctx.lineTo(x1 + ht, y1 + gap + ht); ctx.lineTo(x1 + ht, y2 - gap - ht);
      ctx.lineTo(x1, y2 - gap); ctx.lineTo(x1 - ht, y2 - gap - ht); ctx.lineTo(x1 - ht, y1 + gap + ht);
    }
    ctx.closePath(); ctx.fill();
  };
  const pos = {
    a: [t / 2, t / 2, w - t / 2, t / 2], b: [w - t / 2, t / 2, w - t / 2, h / 2], c: [w - t / 2, h / 2, w - t / 2, h - t / 2],
    d: [t / 2, h - t / 2, w - t / 2, h - t / 2], e: [t / 2, h / 2, t / 2, h - t / 2], f: [t / 2, t / 2, t / 2, h / 2], g: [t / 2, h / 2, w - t / 2, h / 2],
  };
  let cx = 0;
  for (const ch of text) {
    const cw = charW(ch, h);
    ctx.save(); ctx.translate(cx, 0);
    if (ch === ':' || ch === '.') {
      ctx.fillStyle = on;
      if (glow) { ctx.shadowColor = on; ctx.shadowBlur = h * 0.18; }
      const r = t * 0.62;
      if (ch === ':') { ctx.beginPath(); ctx.arc(cw / 2, h * 0.32, r, 0, Math.PI * 2); ctx.arc(cw / 2, h * 0.7, r, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.beginPath(); ctx.arc(cw / 2, h - r, r, 0, Math.PI * 2); ctx.fill(); }
    } else if (MAP[ch] !== undefined && ch !== ' ') {
      const lit = MAP[ch];
      ctx.shadowBlur = 0; ctx.fillStyle = off;
      for (const k of 'abcdefg') if (!lit.includes(k)) seg(...pos[k]);
      ctx.fillStyle = on;
      if (glow) { ctx.shadowColor = on; ctx.shadowBlur = h * 0.18; }
      for (const k of lit) seg(...pos[k]);
    }
    ctx.restore();
    cx += cw + h * 0.1;
  }
  ctx.restore();
  return cx - h * 0.1;
}

const p2 = n => String(Math.floor(n)).padStart(2, '0');

/** Laufzeit in ms → „HH:MM:SS“ (bis 99 h), darüber „Dd HH:MM“. */
export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600);
  if (h < 100) return `${p2(h)}:${p2((s % 3600) / 60)}:${p2(s % 60)}`;
  return `${Math.floor(h / 24)}d ${p2(h % 24)}:${p2((s % 3600) / 60)}`;
}

/** Uhrzeit → „HH:MM:SS“. */
export function fmtClockTime(ms) {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

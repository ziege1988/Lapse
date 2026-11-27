// Einblendungen im Video (Vorschau und Export identisch): derzeit der Maßstabsbalken.
// Der Maßstab wird einmal im Bezugsfoto kalibriert (zwei Punkte mit bekanntem Abstand)
// und gilt nach dem Ausrichten für alle Fotos, weil alle in die Lage des Bezugsfotos gebracht werden.

const NICE = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
const FONT = '"SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** Millimeter je kanonischer Einheit (Bezugsfoto, Länge relativ zur langen Kante) oder null. */
export function mmPerUnit(project) {
  const s = project.scale;
  if (!s || !(s.mm > 0) || !s.p1 || !s.p2 || (s.refId && s.refId !== project.refId)) return null;
  const d = Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y);
  return d > 1e-4 ? s.mm / d : null;
}

/** Runde Balkenlänge (mm) für eine gewünschte Länge. */
export function niceLength(target) {
  let best = NICE[0];
  for (const v of NICE) if (Math.abs(Math.log(v / target)) < Math.abs(Math.log(best / target))) best = v;
  return best;
}

export function fmtLength(mm) {
  const de = v => String(+v.toFixed(2)).replace('.', ',');
  if (mm >= 1000) return de(mm / 1000) + ' m';
  if (mm < 1) return de(mm * 1000) + ' µm';
  return de(mm) + ' mm';
}

/** Kennung des aktuellen Zustands – ändert sie sich, muss die Einblendung neu gezeichnet werden. */
export function overlaySig(project, W, H) {
  const pos = project.settings.scaleBar;
  if (!pos || pos === 'off') return 'none';
  const k = mmPerUnit(project), c = project.crop;
  if (!k || !c) return 'none';
  return `${W}x${H}|${pos}|${k.toFixed(6)}|${c.w.toFixed(5)}`;
}

/** Zeichnet die Einblendung in Ausgabegröße W×H (transparent) oder liefert null. */
export function makeOverlay(project, W, H) {
  const pos = project.settings.scaleBar;
  if (!pos || pos === 'off') return null;
  const k = mmPerUnit(project), crop = project.crop;
  if (!k || !crop) return null;
  const mmPerPx = k * crop.w / W;
  const L = niceLength(W * 0.2 * mmPerPx), len = L / mmPerPx;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const u = Math.min(W, H) / 100;                      // Grundmaß relativ zur Bildgröße
  const m = 4.5 * u, bh = Math.max(2, 0.8 * u), th = Math.max(5, 2.6 * u);
  const x0 = pos === 'br' ? W - m - len : m, y = H - m;
  const fs = Math.max(10, 3.3 * u);
  ctx.font = `600 ${fs}px ${FONT}`;
  const text = fmtLength(L);
  // dunkle Unterlage – lesbar auf hellem wie dunklem Untergrund
  const tw = ctx.measureText(text).width, pad = 1.6 * u;
  const bx = (pos === 'br' ? Math.min(x0, x0 + len - tw) : x0) - pad, bw = Math.max(len, tw) + 2 * pad;
  const by = y - th - 0.8 * u - fs * 1.05 - pad * 0.6, bhh = y + pad - by;
  ctx.fillStyle = 'rgba(0,0,0,.42)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bhh, u); else ctx.rect(bx, by, bw, bhh);
  ctx.fill();
  ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = Math.max(1, 0.5 * u);
  ctx.fillStyle = '#fff';
  // Balken mit Endstrichen und Mittelstrich
  ctx.fillRect(x0, y - bh, len, bh);
  ctx.fillRect(x0, y - th, Math.max(2, bh * 0.75), th);
  ctx.fillRect(x0 + len - Math.max(2, bh * 0.75), y - th, Math.max(2, bh * 0.75), th);
  ctx.fillRect(x0 + len / 2 - Math.max(1, bh * 0.35), y - th * 0.6, Math.max(2, bh * 0.7), th * 0.6);
  ctx.textBaseline = 'bottom';
  ctx.textAlign = pos === 'br' ? 'right' : 'left';
  ctx.fillText(text, pos === 'br' ? x0 + len : x0, y - th - 0.8 * u);
  return c;
}

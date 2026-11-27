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

const barOn = st => st.scaleBar && st.scaleBar !== 'off';

/** Kennung des aktuellen Zustands – ändert sie sich, muss die Einblendung neu gezeichnet werden. */
export function overlaySig(project, W, H, crop = project.crop) {
  const st = project.settings;
  if (!barOn(st) && !st.ruler) return 'none';
  const k = mmPerUnit(project);
  if (!k || !crop) return 'none';
  return `${W}x${H}|${barOn(st) ? st.scaleBar : '-'}|${st.ruler ? 'R' : '-'}|${k.toFixed(6)}|${crop.w.toFixed(5)}`;
}

/**
 * Zeichnet die Einblendungen in Ausgabegröße W×H (transparent) oder liefert null.
 * crop: Bildausschnitt (Standard: der aktuelle des Projekts; im Zuschnitt-Editor der gerade gezogene).
 */
export function makeOverlay(project, W, H, crop = project.crop) {
  const st = project.settings;
  if (!barOn(st) && !st.ruler) return null;
  const k = mmPerUnit(project);
  if (!k || !crop) return null;
  const mmPerPx = k * crop.w / W;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const u = Math.min(W, H) / 100;                      // Grundmaß relativ zur Bildgröße
  if (st.ruler) drawRuler(ctx, W, H, u, mmPerPx);
  if (barOn(st)) drawBar(ctx, W, H, u, mmPerPx, st.scaleBar);
  return c;
}

/** Maßstabsbalken mit runder Länge, unten links (bl) oder rechts (br). */
function drawBar(ctx, W, H, u, mmPerPx, pos) {
  const L = niceLength(W * 0.2 * mmPerPx), len = L / mmPerPx;
  const m = 4.5 * u, bh = Math.max(2, 0.8 * u), th = Math.max(5, 2.6 * u);
  const x0 = pos === 'br' ? W - m - len : m, y = H - m;
  const fs = Math.max(10, 3.3 * u);
  ctx.save();
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
  ctx.fillRect(x0, y - bh, len, bh);
  ctx.fillRect(x0, y - th, Math.max(2, bh * 0.75), th);
  ctx.fillRect(x0 + len - Math.max(2, bh * 0.75), y - th, Math.max(2, bh * 0.75), th);
  ctx.fillRect(x0 + len / 2 - Math.max(1, bh * 0.35), y - th * 0.6, Math.max(2, bh * 0.7), th * 0.6);
  ctx.textBaseline = 'bottom';
  ctx.textAlign = pos === 'br' ? 'right' : 'left';
  ctx.fillText(text, pos === 'br' ? x0 + len : x0, y - th - 0.8 * u);
  ctx.restore();
}

/**
 * Lineal („Zollstock“): leicht transparentes Band mittig über die ganze Bildbreite, Nullpunkt links.
 * Teilung passt sich an: Hauptstriche mit Zahl, Zwischen- und Feinstriche, sofern sie noch erkennbar sind.
 */
function drawRuler(ctx, W, H, u, mmPerPx) {
  const pxPerMm = 1 / mmPerPx;
  // Hauptteilung: runde Länge mit mindestens ~9u Abstand zwischen den Zahlen
  let major = NICE.find(v => v * pxPerMm >= 9 * u) || NICE[NICE.length - 1];
  const sub = [10, 5, 2].find(n => major / n * pxPerMm >= 0.9 * u) || 1;   // Feinstriche
  const minor = major / sub, half = sub % 2 === 0 ? sub / 2 : 0;
  const cm = major >= 10 && major % 10 === 0;          // Zahlen in cm (wie beim Zollstock)
  const bandH = Math.max(14, 7.5 * u), y0 = H / 2 - bandH / 2, x0 = Math.max(2, 1.5 * u);
  ctx.save();
  // Band
  ctx.fillStyle = 'rgba(243,192,138,.20)';
  ctx.fillRect(0, y0, W, bandH);
  ctx.fillStyle = 'rgba(20,21,23,.18)';
  ctx.fillRect(0, y0, W, bandH);
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = Math.max(1, 0.18 * u);
  ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.moveTo(0, y0 + bandH); ctx.lineTo(W, y0 + bandH); ctx.stroke();
  // Striche (oben und unten wie beim Zollstock)
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = Math.max(1, 0.35 * u);
  const n = Math.ceil((W - x0) / (minor * pxPerMm));
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + i * minor * pxPerMm) + 0.5;
    const isMajor = i % sub === 0, isHalf = half && i % half === 0;
    const len = isMajor ? 0.42 * bandH : isHalf ? 0.28 * bandH : 0.17 * bandH;
    ctx.moveTo(x, y0); ctx.lineTo(x, y0 + len);
    ctx.moveTo(x, y0 + bandH); ctx.lineTo(x, y0 + bandH - len * (isMajor ? 0.55 : 0.75));
  }
  ctx.lineWidth = Math.max(1, 0.16 * u);
  ctx.stroke();
  // Zahlen
  const fs = Math.max(9, 2.5 * u);
  ctx.font = `600 ${fs}px ${FONT}`;
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  const ty = y0 + bandH * 0.66;
  const de = v => String(+v.toFixed(2)).replace('.', ',');
  for (let i = 0; i * sub <= n; i++) {
    const x = x0 + i * major * pxPerMm, v = i * major;
    if (x > W - fs) break;
    const label = i === 0 ? (cm ? 'cm' : major >= 1 ? 'mm' : 'µm') : cm ? de(v / 10) : major >= 1 ? de(v) : de(v * 1000);
    ctx.textAlign = i === 0 ? 'left' : 'center';
    ctx.fillText(label, i === 0 ? x + 0.6 * u : x, ty);
  }
  ctx.restore();
}

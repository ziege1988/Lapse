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

/** Region of Interest (kanonisch, Bezugsfoto), beschnitten auf den Bildausschnitt – oder null. */
export function roiOf(project, crop = project.crop) {
  const st = project.settings, r = st.roi;
  if (!st.roiOn || !r || !crop) return null;
  const x = Math.max(r.x, crop.x), y = Math.max(r.y, crop.y);
  const w = Math.min(r.x + r.w, crop.x + crop.w) - x, h = Math.min(r.y + r.h, crop.y + crop.h) - y;
  return w > crop.w * 0.03 && h > crop.h * 0.03 ? { x, y, w, h } : null;
}

/**
 * Lage des Zoom-Fensters im Ausgabebild (Pixel, oben links) und die gezeigte Region.
 * Größe: Anteil der Bildbreite (insetSize); Seitenverhältnis = das der Region.
 */
export function insetSpec(project, W, H, crop = project.crop) {
  const roi = roiOf(project, crop);
  if (!roi) return null;
  const st = project.settings, a = roi.w / roi.h, m = Math.round(Math.min(W, H) * 0.035);
  let w = W * (st.insetSize || 0.38), h = w / a;
  if (h > H * 0.62) { h = H * 0.62; w = h * a; }
  if (w > W * 0.62) { w = W * 0.62; h = w / a; }
  w = Math.round(w); h = Math.round(h);
  const pos = st.insetPos || 'tr';
  const x = pos.endsWith('l') ? m : W - m - w, y = pos.startsWith('t') ? m : H - m - h;
  // Vergrößerung gegenüber der Darstellung im Hauptbild
  const zoom = w / (roi.w / crop.w * W);
  return { roi, rect: { x, y, w, h }, zoom };
}

/** Rahmen in Ausgabepixeln für eine kanonische Region. */
const toPx = (r, crop, W, H) => ({ x: (r.x - crop.x) / crop.w * W, y: (r.y - crop.y) / crop.h * H, w: r.w / crop.w * W, h: r.h / crop.h * H });

/**
 * Ein Videobild vollständig zeichnen: Hauptbild, Zoom-Fenster, Einblendungen.
 * Vorschau und Export nutzen dieselbe Funktion – deshalb sehen beide gleich aus.
 */
export function drawComposite(r, project, layers, { global, W, H, overlay = true } = {}) {
  r.draw(layers, { global });
  const ins = insetSpec(project, W, H);
  if (ins) r.draw(layers.map(L => ({ ...L, M: project.layerMatrix(L.frame, ins.roi) })), { global, viewport: ins.rect, clear: false });
  if (overlay) r.drawOverlay();
}

/** Kennung des aktuellen Zustands – ändert sie sich, muss die Einblendung neu gezeichnet werden. */
export function overlaySig(project, W, H, crop = project.crop) {
  if (!crop) return 'none';
  const st = project.settings;
  const k = mmPerUnit(project), ins = insetSpec(project, W, H, crop);
  const scale = k && (barOn(st) || st.ruler);
  if (!scale && !ins) return 'none';
  return `${W}x${H}|${scale ? (barOn(st) ? st.scaleBar : '-') + (st.ruler ? 'R' : '-') + k.toFixed(6) : 'noscale'}|${crop.x.toFixed(5)},${crop.y.toFixed(5)},${crop.w.toFixed(5)}|${ins ? JSON.stringify(ins.rect) + JSON.stringify(ins.roi) : 'noroi'}`;
}

/**
 * Zeichnet die Einblendungen in Ausgabegröße W×H (transparent) oder liefert null.
 * crop: Bildausschnitt (Standard: der aktuelle des Projekts; im Zuschnitt-Editor der gerade gezogene).
 */
export function makeOverlay(project, W, H, crop = project.crop) {
  if (overlaySig(project, W, H, crop) === 'none') return null;
  const st = project.settings, k = mmPerUnit(project);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const u = Math.min(W, H) / 100;                      // Grundmaß relativ zur Bildgröße
  const ins = insetSpec(project, W, H, crop);
  if (k && st.ruler) drawRuler(ctx, W, H, u, k * crop.w / W);
  if (ins) drawInsetFrames(ctx, ins, crop, W, H, u);
  if (k && barOn(st)) drawBar(ctx, W, H, u, k * crop.w / W, st.scaleBar);
  return c;
}

/** Dezenter weißer Kasten um die Region im Hauptbild und um das Zoom-Fenster, dazu der Zoomfaktor. */
function drawInsetFrames(ctx, ins, crop, W, H, u) {
  const R = toPx(ins.roi, crop, W, H), I = ins.rect;
  ctx.save();
  const box = (x, y, w, h, lw) => {
    ctx.lineWidth = lw + Math.max(1, 0.25 * u); ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.strokeRect(x, y, w, h);
    ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(255,255,255,.88)'; ctx.strokeRect(x, y, w, h);
  };
  box(Math.round(R.x) + 0.5, Math.round(R.y) + 0.5, Math.round(R.w), Math.round(R.h), Math.max(1, 0.22 * u));
  box(I.x + 0.5, I.y + 0.5, I.w - 1, I.h - 1, Math.max(1.5, 0.3 * u));
  // Zoomfaktor im Fenster
  const fs = Math.max(9, 2.4 * u), txt = `${String(+ins.zoom.toFixed(1)).replace('.', ',')}×`;
  ctx.font = `600 ${fs}px ${FONT}`;
  const tw = ctx.measureText(txt).width, pad = 0.8 * u;
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.fillRect(I.x + I.w - tw - 2 * pad - 0.6 * u, I.y + I.h - fs - 1.4 * pad - 0.6 * u, tw + 2 * pad, fs + 1.4 * pad);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'right';
  ctx.fillText(txt, I.x + I.w - pad - 0.6 * u, I.y + I.h - 0.7 * pad - 0.6 * u);
  ctx.restore();
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
 * Lineal: eine Grundlinie quer durch die Bildmitte, Striche stehen nach oben –
 * lang für cm, mittel für 0,5 cm, kurz für mm. Keine Zahlen. Nullpunkt links.
 * Bei sehr starker oder schwacher Vergrößerung verschiebt sich die Teilung um Zehnerstufen
 * (z. B. 1 mm / 0,5 mm / 0,1 mm), damit die Striche erkennbar bleiben.
 */
function drawRuler(ctx, W, H, u, mmPerPx) {
  const pxPerMm = 1 / mmPerPx;
  let unit = 10;                                        // Hauptteilung in mm (Standard: 1 cm)
  while (unit / 10 * pxPerMm < 3 && unit < 1e5) unit *= 10;   // feinste Striche mind. ~3 px auseinander
  while (unit * pxPerMm > W * 0.6 && unit > 1e-3) unit /= 10; // mind. ~2 Hauptstriche im Bild
  const fine = unit / 10, step = fine * pxPerMm;
  const showFine = step >= 3, showHalf = step * 5 >= 3;
  const y = Math.round(H / 2) + 0.5, x0 = Math.max(1, 1.2 * u);
  const Lc = Math.max(8, 4.2 * u), Lh = Lc * 0.62, Lm = Lc * 0.34;
  // Strichliste: [x1, y1, x2, y2, Breite]
  const segs = [[0, y, W, y, Math.max(1, 0.2 * u)]];
  const n = Math.floor((W - x0) / step);
  for (let i = 0; i <= n; i++) {
    const cm = i % 10 === 0, half = i % 10 === 5;
    if (!cm && !half && !showFine) continue;
    if (half && !showHalf) continue;
    const x = Math.round(x0 + i * step) + 0.5;
    segs.push([x, y, x, y - (cm ? Lc : half ? Lh : Lm), Math.max(1, (cm ? 0.2 : half ? 0.16 : 0.12) * u)]);
  }
  ctx.save();
  ctx.lineCap = 'square';
  // erst dunkle Kontur (lesbar auf hellem Papier), dann helle Linie (lesbar auf Dunklem)
  for (const [col, extra] of [['rgba(0,0,0,.38)', Math.max(1.5, 0.22 * u)], ['rgba(255,255,255,.9)', 0]]) {
    ctx.strokeStyle = col;
    for (const lw of [...new Set(segs.map(q => q[4]))]) {
      ctx.lineWidth = lw + extra;
      ctx.beginPath();
      for (const [a, b, c, d, w] of segs) if (w === lw) { ctx.moveTo(a, b); ctx.lineTo(c, d); }
      ctx.stroke();
    }
  }
  ctx.restore();
}

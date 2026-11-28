// Startbild: Schmetterling auf einem Blatt, der langsam die Flügel öffnet und schließt (wie beim Sonnen).
// Vektorgrafik, live gezeichnet; dazu Messwerte am Rand. Läuft nur, solange es sichtbar ist;
// bei „Bewegung reduzieren“ ein ruhendes Bild.

const TAU = Math.PI * 2;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const CYCLE = 4.2; // Sekunden pro Flügelzyklus

/** Flügelöffnung 0…1: lange offen (leichtes Zittern), dann ruhig schließen und wieder öffnen. */
const bask = t => {
  const p = (t % CYCLE) / CYCLE;
  return clamp(0.12 + 0.88 * (p < 0.55 ? 1 - 0.08 * (0.5 + 0.5 * Math.sin(p * TAU * 2)) : 0.5 + 0.5 * Math.cos((p - 0.55) / 0.45 * TAU)));
};

const TILT = 0.55;     // Blickwinkel leicht von vorn oben: hochgeklappte Flügel erscheinen nach oben versetzt
const MAX_ANGLE = 1.48; // ~85° hochgeklappt (geschlossen)

/**
 * Ein Flügel, gedreht um die Körperachse: angle 0 = flach offen, MAX_ANGLE = senkrecht nach oben.
 * Projektion: x' = x·cos, y' = y − x·sin·TILT  (Flügelspitzen wandern beim Schließen nach oben).
 */
function wing(ctx, side, angle) {
  const c = Math.cos(angle), sn = Math.sin(angle);
  ctx.save();
  ctx.transform(side * Math.max(0.04, c), -TILT * sn, 0, 1, 0, 0);
  const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 62);
  grad.addColorStop(0, '#5b3a22'); grad.addColorStop(0.3, '#d98c4a'); grad.addColorStop(0.7, '#f3c08a');
  grad.addColorStop(0.93, '#e9a964'); grad.addColorStop(1, '#3a2617');
  const fore = () => { ctx.beginPath(); ctx.moveTo(0, -3); ctx.bezierCurveTo(10, -36, 48, -46, 60, -26); ctx.bezierCurveTo(64, -14, 44, -2, 0, 2); ctx.closePath(); };
  const hind = () => { ctx.beginPath(); ctx.moveTo(0, 2); ctx.bezierCurveTo(30, 2, 50, 16, 44, 36); ctx.bezierCurveTo(38, 50, 14, 44, 0, 12); ctx.closePath(); };
  ctx.lineWidth = 2.2; ctx.strokeStyle = 'rgba(40,24,14,.95)';
  for (const shape of [hind, fore]) { shape(); ctx.fillStyle = grad; ctx.fill(); ctx.stroke(); }
  // Adern
  ctx.strokeStyle = 'rgba(60,34,18,.55)'; ctx.lineWidth = 0.9; ctx.beginPath();
  for (const [x, y] of [[54, -30], [58, -18], [40, -38], [44, 30], [30, 38], [40, 14]]) { ctx.moveTo(2, 0); ctx.quadraticCurveTo(x * 0.5, y * 0.3, x, y); }
  ctx.stroke();
  // helle Flecken an der Flügelspitze
  ctx.fillStyle = 'rgba(255,250,240,.9)';
  for (const [x, y, r] of [[50, -30, 2.4], [55, -23, 2], [45, -34, 1.6]]) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
  // Augenfleck
  ctx.beginPath(); ctx.arc(30, 27, 6, 0, TAU); ctx.fillStyle = '#2a1a10'; ctx.fill();
  ctx.beginPath(); ctx.arc(30, 27, 4, 0, TAU); ctx.fillStyle = '#7fd3e6'; ctx.fill();
  ctx.beginPath(); ctx.arc(29, 26, 1.4, 0, TAU); ctx.fillStyle = '#fff'; ctx.fill();
  // Licht: hochgeklappte Flügel wirken dunkler
  if (sn > 0.05) { ctx.fillStyle = `rgba(25,14,8,${(0.4 * sn).toFixed(3)})`; for (const shape of [hind, fore]) { shape(); ctx.fill(); } }
  ctx.restore();
}

function body(ctx) {
  ctx.fillStyle = '#2a1c12';
  ctx.beginPath(); ctx.ellipse(0, 10, 3.6, 21, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(0, -13, 4.4, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#2a1c12'; ctx.lineWidth = 1.2; ctx.beginPath();
  for (const sd of [-1, 1]) { ctx.moveTo(sd * 1.5, -16); ctx.quadraticCurveTo(sd * 6, -30, sd * 12, -36); }
  ctx.stroke();
  for (const sd of [-1, 1]) { ctx.beginPath(); ctx.arc(sd * 12, -36, 1.8, 0, TAU); ctx.fill(); }
}

/** open 1 = Flügel flach ausgebreitet, 0 = über dem Körper zusammengeklappt. */
function butterfly(ctx, x, y, s, open, rot) {
  const angle = (1 - open) * MAX_ANGLE;
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
  // Schatten auf dem Blatt: wird schmaler, wenn die Flügel hochgehen
  ctx.save(); ctx.globalAlpha = 0.25; ctx.filter = 'blur(6px)'; ctx.translate(6, 12);
  ctx.beginPath(); ctx.ellipse(0, 4, Math.max(8, 54 * Math.cos(angle)), 34, 0, 0, TAU); ctx.fillStyle = '#000'; ctx.fill(); ctx.restore();
  // Offen liegt der Körper sichtbar oben auf; hochgeklappt verdecken die Flügel den Körper
  const covered = angle > 0.75;
  if (covered) body(ctx);
  wing(ctx, -1, angle); wing(ctx, 1, angle);
  if (!covered) body(ctx);
  ctx.restore();
}

function leaf(ctx, x, y, len, wid, ang) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  const g = ctx.createLinearGradient(0, -wid, 0, wid);
  g.addColorStop(0, '#9cc0a4'); g.addColorStop(1, '#4f6f5a');
  ctx.beginPath(); ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.45, -wid, len, 0); ctx.quadraticCurveTo(len * 0.45, wid, 0, 0);
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(20,35,26,.7)'; ctx.lineWidth = 1.1; ctx.stroke();
  // Mittelrippe und Seitenadern
  ctx.strokeStyle = 'rgba(220,240,225,.45)'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len * 0.95, 0);
  for (let i = 1; i < 6; i++) {
    const px = len * i / 6.5, r = 0.5 * (1 - i / 7);
    ctx.moveTo(px, 0); ctx.lineTo(px + len * 0.11, -wid * r); ctx.moveTo(px, 0); ctx.lineTo(px + len * 0.11, wid * r);
  }
  ctx.stroke();
  // Stiel
  ctx.strokeStyle = '#5d7f68'; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(-len * 0.08, wid * 0.2, -len * 0.16, wid * 0.55); ctx.stroke();
  ctx.restore();
}

export class Hero {
  constructor(canvas, hud) {
    this.c = canvas; this.hud = hud;
    this.ctx = canvas.getContext('2d');
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.running = false;
    this.t0 = performance.now();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1), w = this.c.clientWidth, h = this.c.clientHeight;
    if (!w || !h) return;
    this.c.width = Math.round(w * dpr); this.c.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw(this.reduced ? 1.2 : (performance.now() - this.t0) / 1000);
  }

  start() {
    if (this.reduced) { this.draw(1.2); return; } // ruhendes Bild: Flügel offen
    if (this.running) return;
    this.running = true;
    let last = 0;
    const loop = now => {
      if (!this.running) return;
      if (now - last > 30) { last = now; this.draw((now - this.t0) / 1000); } // ~30 Bilder/s
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); }

  draw(t) {
    const ctx = this.ctx, W = this.c.clientWidth, H = this.c.clientHeight;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    const S = Math.min(W, H * 1.05), cx = W / 2, cy = H / 2;
    // Skala links (wie ein Messbild)
    ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = 1; ctx.beginPath();
    const y0 = H * 0.2, y1 = H * 0.8;
    for (let i = 0; i <= 40; i++) { const y = Math.round(y0 + i * (y1 - y0) / 40) + 0.5, l = i % 10 ? (i % 5 ? 3 : 6) : 10; ctx.moveTo(24, y); ctx.lineTo(24 + l, y); }
    ctx.stroke();
    // Blatt und Falter
    leaf(ctx, cx - S * 0.34, cy + S * 0.25, S * 0.8, S * 0.18, -0.3);
    const o = bask(t), bob = Math.sin(t * 1.3) * 1.5;
    butterfly(ctx, cx + S * 0.05, cy + S * 0.0 + bob, S / 180, o, -0.12);
    // Messwerte
    if (this.hud) {
      const min = Math.floor(t * 3) % 1440;
      this.hud.t.textContent = `T+ ${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')} h`;
      this.hud.f.textContent = `FLÜGEL ${Math.round(180 - 2 * (1 - o) * MAX_ANGLE * 180 / Math.PI)}°`;
      this.hud.a.textContent = `ÖFFNUNG ${Math.round(o * 100)} %`;
      this.hud.d.textContent = `ZYKLUS ${String(CYCLE).replace('.', ',')} S`;
    }
  }
}

// Startbild: Petrischale, in deren Mitte eine Pilzkolonie unregelmäßig wächst (verzweigende Hyphen,
// lappige Wachstumsfront), dazu eine digitale Zeitanzeige. Live gezeichnet, keine Bilddateien.
// Läuft nur, solange es sichtbar ist; bei „Bewegung reduzieren“ ein ruhendes Bild.

import { drawSevenSeg, sevenSegWidth, fmtElapsed } from './sevenseg.js';

const TAU = Math.PI * 2;
const SIM = 400;            // Simulationsraster (Schale: Radius SIM/2)
const R = SIM / 2 * 0.94;   // nutzbarer Radius (Agar)
const MAX_TIPS = 900;
const SEC_PER_STEP = 47;    // simulierte Sekunden je Schritt (ungerade -> alle Ziffern laufen)

export class Hero {
  constructor(canvas, hud) {
    this.c = canvas; this.hud = hud;
    this.ctx = canvas.getContext('2d');
    this.g = document.createElement('canvas'); this.g.width = SIM; this.g.height = SIM;
    this.gx = this.g.getContext('2d');
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.running = false;
    this.seed();
    if (this.reduced) { for (let i = 0; i < 520; i++) this.step(); this.measure(); }
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  seed() {
    this.gx.clearRect(0, 0, SIM, SIM);
    this.steps = 0; this.hold = 0; this.fade = 0;
    // Lappenform der Kolonie: je Richtung etwas andere Wachstumsgeschwindigkeit
    this.ph = [Math.random() * TAU, Math.random() * TAU, Math.random() * TAU];
    this.tips = [];
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * TAU + Math.random() * 0.3;
      this.tips.push({ x: SIM / 2 + Math.cos(a) * 3, y: SIM / 2 + Math.sin(a) * 3, a, born: 0 });
    }
    this.front = 4; this.cover = 0;
    // kleiner Impfpunkt
    const g = this.gx;
    g.fillStyle = 'rgba(243,200,150,.55)'; g.beginPath(); g.arc(SIM / 2, SIM / 2, 5, 0, TAU); g.fill();
  }

  lobe(a) {
    const [p1, p2, p3] = this.ph;
    return 0.72 + 0.2 * Math.sin(3 * a + p1) + 0.12 * Math.sin(5 * a + p2) + 0.08 * Math.sin(9 * a + p3);
  }

  step() {
    const g = this.gx, cx = SIM / 2, cy = SIM / 2, next = [];
    const fresh = new Path2D(), old = new Path2D(), haze = new Path2D();
    let front = 0;
    for (const t of this.tips) {
      const dx = t.x - cx, dy = t.y - cy, r = Math.hypot(dx, dy), radial = Math.atan2(dy, dx);
      // Richtung: zufällig schwankend, leicht nach außen gezogen
      let da = radial - t.a; da = Math.atan2(Math.sin(da), Math.cos(da));
      t.a += (Math.random() - 0.5) * 0.42 + da * 0.05;
      const v = 0.55 * this.lobe(radial) * (0.75 + Math.random() * 0.5);
      const nx = t.x + Math.cos(t.a) * v, ny = t.y + Math.sin(t.a) * v;
      const nr = Math.hypot(nx - cx, ny - cy);
      if (nr > R * 0.985) continue; // Rand der Schale erreicht
      const path = r < this.front * 0.55 ? old : fresh;
      path.moveTo(t.x, t.y); path.lineTo(nx, ny);
      haze.moveTo(t.x, t.y); haze.lineTo(nx, ny);
      t.x = nx; t.y = ny;
      front = Math.max(front, nr);
      // Absterben hinten in der Kolonie, Verzweigen an der Front
      if (nr < this.front * 0.45 && Math.random() < 0.02) continue;
      next.push(t);
      if (next.length < MAX_TIPS && Math.random() < (nr > this.front * 0.7 ? 0.055 : 0.012)) {
        next.push({ x: nx, y: ny, a: t.a + (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.4), born: this.steps });
      }
    }
    this.tips = next.length ? next : this.tips;
    this.front = Math.max(this.front * 0.98, front);
    // weicher Schleier (dichtes Myzel), darüber feine Hyphen
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(243,200,150,.022)'; g.lineWidth = 7; g.stroke(haze);
    g.strokeStyle = 'rgba(236,200,152,.5)'; g.lineWidth = 0.9; g.stroke(old);
    g.strokeStyle = 'rgba(255,249,238,.85)'; g.lineWidth = 0.75; g.stroke(fresh);
    // Sporenbildung im älteren Zentrum: kleine dunklere Punkte
    if (this.steps % 6 === 0 && this.front > 40) {
      g.fillStyle = 'rgba(196,128,70,.35)';
      for (let i = 0; i < 4; i++) {
        const a = Math.random() * TAU, rr = Math.sqrt(Math.random()) * this.front * 0.45;
        g.beginPath(); g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 0.9 + Math.random() * 1.1, 0, TAU); g.fill();
      }
    }
    this.steps++;
    if (this.steps % 15 === 0) this.measure();
  }

  /** Bewachsene Fläche messen (Anteil des Agars mit Myzel). */
  measure() {
    const N = 100, c = this.mc ||= Object.assign(document.createElement('canvas'), { width: N, height: N });
    const x = c.getContext('2d', { willReadFrequently: true });
    x.clearRect(0, 0, N, N); x.drawImage(this.g, 0, 0, N, N);
    const d = x.getImageData(0, 0, N, N).data, rr = (R / SIM * N) ** 2;
    let tot = 0, hit = 0;
    for (let y = 0; y < N; y++) for (let i = 0; i < N; i++) {
      if ((i - N / 2 + 0.5) ** 2 + (y - N / 2 + 0.5) ** 2 > rr) continue;
      tot++; if (d[(y * N + i) * 4 + 3] > 40) hit++;
    }
    this.cover = tot ? hit / tot * 100 : 0;
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1), w = this.c.clientWidth, h = this.c.clientHeight;
    if (!w || !h) return;
    this.c.width = Math.round(w * dpr); this.c.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  start() {
    if (this.reduced) { this.draw(); return; }
    if (this.running) return;
    this.running = true;
    let last = 0;
    const loop = now => {
      if (!this.running) return;
      if (now - last > 30) { // ~30 Bilder/s
        last = now;
        if (this.fade > 0) {
          this.fade -= 0.04;
          if (this.fade <= 0) this.seed();
        } else if (this.front > R * 0.86) {
          if (++this.hold > 90) this.fade = 1; // kurz stehen lassen, dann ausblenden
        } else { this.step(); this.step(); }
        this.draw();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); }

  draw() {
    const ctx = this.ctx, W = this.c.clientWidth, H = this.c.clientHeight;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2 + 6, Rd = Math.min(W, H) * 0.39;
    // Glasschale
    ctx.beginPath(); ctx.arc(cx, cy, Rd + 10, 0, TAU); ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.24)'; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, Rd + 4, 0, TAU); ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.stroke();
    // Agar
    const ag = ctx.createRadialGradient(cx - Rd * 0.2, cy - Rd * 0.25, Rd * 0.1, cx, cy, Rd);
    ag.addColorStop(0, 'rgba(243,214,170,.10)'); ag.addColorStop(1, 'rgba(243,192,138,.04)');
    ctx.beginPath(); ctx.arc(cx, cy, Rd, 0, TAU); ctx.fillStyle = ag; ctx.fill();
    // Kolonie
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, Rd, 0, TAU); ctx.clip();
    ctx.globalAlpha = this.fade > 0 ? Math.max(0, this.fade) : 1;
    ctx.imageSmoothingQuality = 'high';
    const k = Rd / R;
    ctx.drawImage(this.g, cx - SIM / 2 * k, cy - SIM / 2 * k, SIM * k, SIM * k);
    ctx.restore();
    // Glanzlicht
    ctx.beginPath(); ctx.arc(cx, cy, Rd + 7, Math.PI * 1.08, Math.PI * 1.42);
    ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.stroke();
    // Gradskala und Fadenkreuz-Marken
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.beginPath();
    for (let i = 0; i < 72; i++) {
      const w = i * Math.PI / 36, r1 = Rd + 15, r2 = r1 + (i % 6 ? 3 : 7);
      ctx.moveTo(cx + Math.cos(w) * r1, cy + Math.sin(w) * r1); ctx.lineTo(cx + Math.cos(w) * r2, cy + Math.sin(w) * r2);
    }
    ctx.stroke();
    // Messring an der Wachstumsfront
    const fr = this.front * k;
    ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(127,211,230,.5)';
    ctx.beginPath(); ctx.arc(cx, cy, fr, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    // Digitale Zeitanzeige oben rechts
    const text = fmtElapsed(this.steps * SEC_PER_STEP * 1000);
    const dh = Math.max(16, Math.min(W, H) * 0.06), tw = sevenSegWidth(text, dh);
    const x = W - 22 - tw, y = 20;
    ctx.font = `600 ${Math.round(dh * 0.36)}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = 'rgba(154,165,174,.95)'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('T+ LAUFZEIT', W - 22, y);
    drawSevenSeg(ctx, text, x, y + dh * 0.55, dh);
    ctx.textAlign = 'left';
    // Messwerte
    if (this.hud) {
      const mm = 2 * this.front / R * 43; // Schale 90 mm, Agar ~86 mm Durchmesser
      this.hud.a.textContent = `FLÄCHE ${this.cover.toFixed(1).replace('.', ',')} %`;
      this.hud.d.textContent = `FRONT Ø ${Math.min(86, mm).toFixed(1).replace('.', ',')} MM`;
    }
  }
}

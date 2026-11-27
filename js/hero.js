// Startbild: lebendige Petrischale. Ein vereinfachtes Schleimpilz-Modell (Physarum, Agenten auf
// einem Spurenfeld) wächst zwischen Haferflocken; dazu Messwerte wie in der Aufnahme.
// Läuft nur, solange es sichtbar ist; bei „Bewegung reduzieren“ ein ruhendes Bild.

const N = 200;                  // Rastergröße der Simulation
const R = N * 0.46;             // Radius der Schale im Raster
const AGENTS = 5200;
const SA = 0.42, SO = 8, RA = 0.38, STEP = 1, DEPOSIT = 1.4, DECAY = 0.86;
const OATS = [[0.30, 0.34, 0.6], [0.70, 0.30, -0.4], [0.74, 0.66, 0.9], [0.30, 0.70, 0.2], [0.52, 0.52, -0.9]];

export class Hero {
  constructor(canvas, hud) {
    this.c = canvas; this.hud = hud;
    this.ctx = canvas.getContext('2d');
    this.img = document.createElement('canvas'); this.img.width = N; this.img.height = N;
    this.ictx = this.img.getContext('2d');
    this.data = this.ictx.createImageData(N, N);
    this.trail = new Float32Array(N * N); this.tmp = new Float32Array(N * N);
    this.mask = new Uint8Array(N * N);
    let inside = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if ((x - N / 2) ** 2 + (y - N / 2) ** 2 < R * R) { this.mask[y * N + x] = 1; inside++; }
    }
    this.inside = inside;
    this.ax = new Float32Array(AGENTS); this.ay = new Float32Array(AGENTS); this.ah = new Float32Array(AGENTS);
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.running = false;
    this.seed();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  seed() {
    this.trail.fill(0);
    this.t = 0; this.frame = 0; this.cover0 = null;
    // Start: kleiner Fleck an einer Haferflocke (wie im echten Versuch)
    const [ox, oy] = OATS[4];
    for (let i = 0; i < AGENTS; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * N * 0.05;
      this.ax[i] = ox * N + Math.cos(a) * r; this.ay[i] = oy * N + Math.sin(a) * r;
      this.ah[i] = Math.random() * Math.PI * 2;
    }
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1), w = this.c.clientWidth, h = this.c.clientHeight;
    if (!w || !h) return;
    this.c.width = Math.round(w * dpr); this.c.height = Math.round(h * dpr);
    this.draw();
  }

  start() {
    if (this.running) return;
    if (this.reduced) { if (!this.t) for (let i = 0; i < 520; i++) this.step(); this.draw(); return; }
    this.running = true;
    let last = 0;
    const loop = now => {
      if (!this.running) return;
      if (now - last > 30) { // ~30 Bilder/s
        last = now;
        this.step(); this.step();
        if (this.t > 1900) this.seed(); // neuer Versuch
        this.draw();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); }

  sense(x, y) {
    const xi = x | 0, yi = y | 0;
    return xi < 0 || yi < 0 || xi >= N || yi >= N || !this.mask[yi * N + xi] ? -1 : this.trail[yi * N + xi];
  }

  step() {
    const T = this.trail, m = this.mask;
    // Nahrung: Haferflocken locken ständig an
    for (const [ox, oy] of OATS) {
      const cx = ox * N | 0, cy = oy * N | 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) T[(cy + dy) * N + cx + dx] += 0.9;
    }
    // Agenten: fühlen, drehen, laufen, Spur legen
    const grow = Math.min(1, 0.25 + this.t / 500); // anfangs wenige aktiv -> sichtbares Wachstum
    const active = AGENTS * grow | 0;
    for (let i = 0; i < active; i++) {
      let x = this.ax[i], y = this.ay[i], h = this.ah[i];
      const f = this.sense(x + Math.cos(h) * SO, y + Math.sin(h) * SO);
      const l = this.sense(x + Math.cos(h - SA) * SO, y + Math.sin(h - SA) * SO);
      const r = this.sense(x + Math.cos(h + SA) * SO, y + Math.sin(h + SA) * SO);
      if (f >= l && f >= r) { /* geradeaus */ }
      else if (f < l && f < r) h += (Math.random() < 0.5 ? -1 : 1) * RA;
      else if (l > r) h -= RA; else h += RA;
      h += (Math.random() - 0.5) * 0.12;
      const nx = x + Math.cos(h) * STEP, ny = y + Math.sin(h) * STEP;
      const ni = (ny | 0) * N + (nx | 0);
      if (nx < 0 || ny < 0 || nx >= N || ny >= N || !m[ni]) { h += Math.PI * (0.5 + Math.random()); }
      else { x = nx; y = ny; T[ni] += DEPOSIT; }
      this.ax[i] = x; this.ay[i] = y; this.ah[i] = h;
    }
    // Spur verteilen und abklingen lassen (3×3-Mittel)
    const o = this.tmp;
    for (let y = 1; y < N - 1; y++) {
      const row = y * N;
      for (let x = 1; x < N - 1; x++) {
        const i = row + x;
        if (!m[i]) { o[i] = 0; continue; }
        o[i] = (T[i] * 6 + T[i - 1] + T[i + 1] + T[i - N] + T[i + N]) / 10 * DECAY;
      }
    }
    this.trail = o; this.tmp = T;
    this.t++;
  }

  draw() {
    const W = this.c.width, H = this.c.height;
    if (!W) return;
    const ctx = this.ctx, T = this.trail, d = this.data.data;
    // Spurenfeld einfärben: dunkles Papier -> Bernstein -> helles Gelb
    let cover = 0;
    for (let i = 0, j = 0; i < N * N; i++, j += 4) {
      if (!this.mask[i]) { d[j + 3] = 0; continue; }
      const v = Math.min(1, Math.sqrt(T[i] / 9));
      if (v > 0.35) cover++;
      const e = v * v * (3 - 2 * v);
      d[j] = 26 + e * 218; d[j + 1] = 27 + e * 165 + e * e * 45; d[j + 2] = 30 + e * 95 + e * e * e * 95; d[j + 3] = 255;
    }
    this.ictx.putImageData(this.data, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const S = Math.min(W, H) * 0.92, x0 = (W - S) / 2, y0 = (H - S) / 2, k = S / N, cx = W / 2, cy = H / 2;
    const dpr = W / this.c.clientWidth;
    // Glas der Schale
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R * k + 6 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.025)'; ctx.fill();
    ctx.lineWidth = 1 * dpr; ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R * k + 2 * dpr, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.stroke();
    // Spurenbild mit Leuchten
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = `blur(${4 * dpr}px)`; ctx.globalAlpha = 0.45;
    ctx.drawImage(this.img, x0, y0, S, S);
    ctx.filter = 'none'; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.img, x0, y0, S, S);
    // Haferflocken mit Bezugsringen
    for (const [ox, oy, rot] of OATS) {
      const px = x0 + ox * S, py = y0 + oy * S;
      ctx.save(); ctx.translate(px, py); ctx.rotate(rot);
      ctx.beginPath(); ctx.ellipse(0, 0, 7 * dpr * S / 300, 4.6 * dpr * S / 300, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(236,222,196,.92)'; ctx.fill();
      ctx.restore();
      ctx.beginPath(); ctx.arc(px, py, 13 * dpr * S / 300, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(243,192,138,.85)'; ctx.lineWidth = 1.3 * dpr; ctx.stroke();
    }
    // Messring (dreht langsam) und Fadenkreuz
    const a = (this.t / 160) % (Math.PI * 2);
    ctx.setLineDash([3 * dpr, 5 * dpr]); ctx.strokeStyle = 'rgba(127,211,230,.55)'; ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.arc(cx, cy, R * k * 0.84, a, a + Math.PI * 1.55); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    const L = R * k + 16 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx - L, cy); ctx.lineTo(cx - L + 10 * dpr, cy); ctx.moveTo(cx + L, cy); ctx.lineTo(cx + L - 10 * dpr, cy);
    ctx.moveTo(cx, cy - L); ctx.lineTo(cx, cy - L + 10 * dpr); ctx.moveTo(cx, cy + L); ctx.lineTo(cx, cy + L - 10 * dpr);
    ctx.stroke();
    // Skala am Rand
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.beginPath();
    for (let i = 0; i < 72; i++) {
      const w = i * Math.PI / 36, r1 = R * k + 9 * dpr, r2 = r1 + (i % 6 ? 3 : 7) * dpr;
      ctx.moveTo(cx + Math.cos(w) * r1, cy + Math.sin(w) * r1); ctx.lineTo(cx + Math.cos(w) * r2, cy + Math.sin(w) * r2);
    }
    ctx.stroke();
    ctx.restore();
    // Messwerte
    const cov = cover / this.inside * 100;
    if (this.cover0 == null && this.t > 5) this.cover0 = cov;
    this.frame = Math.floor(this.t / 8);
    const min = this.t * 3, hh = Math.floor(min / 60), mm = min % 60;
    if (this.hud) {
      this.hud.t.textContent = `T+ ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} h`;
      this.hud.f.textContent = `FRAME ${String(this.frame).padStart(4, '0')}`;
      this.hud.a.textContent = `FLÄCHE ${cov.toFixed(1).replace('.', ',')} %`;
      this.hud.d.textContent = `Δ ${this.cover0 != null ? '+' + (cov - this.cover0).toFixed(1).replace('.', ',') : '0,0'} %`;
    }
  }
}

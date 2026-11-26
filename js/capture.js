// Zeitraffer-Aufnahme: Kamera einrichten (Live-Messwerte, Histogramm), Testfoto prüfen,
// Bezugspunkte vorschlagen, Intervall-Timer, jedes Foto sofort auf dem Gerät sichern,
// danach direkt ausrichten lassen oder in die Fotomediathek übernehmen.

import { pyramid } from './direct.js';
import { detectBlobs } from './anchors.js';
import { scaleTo, grayChromaOf, toBlob } from './images.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad = (n, k = 3) => String(n).padStart(k, '0');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const UNIT = { s: 1, m: 60, h: 3600 };
const BATCH = 20;            // Fotos je „In Fotos sichern“
const MAX_PTS = 5;
const LS_KEY = 'lapse.capture.timer';

function fmtDur(sec) {
  if (!isFinite(sec)) return 'offen';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h} h ${pad(m, 2)} min`;
  if (m) return `${m} min${s ? ' ' + pad(s, 2) + ' s' : ''}`;
  return `${s} s`;
}
const fmtClock = sec => { sec = Math.max(0, Math.ceil(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return (h ? h + ':' + pad(m, 2) : pad(m, 2)) + ':' + pad(s, 2); };
const fmtMB = b => b >= 1e9 ? (b / 1e9).toFixed(1).replace('.', ',') + ' GB' : Math.round(b / 1e6) + ' MB';
const timeStr = d => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Messwerte eines Bildes (RGBA): Histogramme, Helligkeit, Clipping, Farbbalance. */
function measure(px, w, h) {
  const hr = new Float32Array(64), hg = new Float32Array(64), hb = new Float32Array(64), hl = new Float32Array(64);
  const n = w * h, lum = new Float32Array(n);
  let sl = 0, sr = 0, sg = 0, sb = 0, hi = 0, lo = 0;
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const r = px[i], g = px[i + 1], b = px[i + 2], l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[j] = l;
    hr[r >> 2]++; hg[g >> 2]++; hb[b >> 2]++; hl[Math.min(63, l >> 2)]++;
    sl += l; sr += r; sg += g; sb += b;
    if (r >= 250 || g >= 250 || b >= 250) hi++;
    if (l <= 6) lo++;
  }
  return {
    hist: [hr, hg, hb, hl], lum, w, h,
    L: sl / n / 255, clipHi: hi / n, clipLo: lo / n,
    rgb: [sr / n, sg / n, sb / n],
  };
}

/**
 * Schärfe-Index (0–100): Verhältnis Laplace/Gradient an den stärksten 2 % der Kanten (720 px).
 * Weitgehend unabhängig von Motiv und Helligkeit; kalibriert an echten Fotos:
 * scharf ≈ 65–75, leicht weich ≈ 45, unscharf ≈ 20, stark unscharf ≈ 10.
 */
function sharpness(lum, w, h) {
  const n = (w - 2) * (h - 2), g = new Float32Array(n), l = new Float32Array(n);
  let k = 0, gmax = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++, k++) {
    const i = y * w + x;
    g[k] = Math.hypot(lum[i + 1] - lum[i - 1], lum[i + w] - lum[i - w]);
    l[k] = Math.abs(4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w] - lum[i + w]);
    if (g[k] > gmax) gmax = g[k];
  }
  if (gmax < 4) return 0;
  // 98. Perzentil des Gradienten über ein Histogramm
  const bins = new Uint32Array(512), sc = 511 / gmax;
  for (let i = 0; i < n; i++) bins[(g[i] * sc) | 0]++;
  let acc = 0, b = 511;
  for (; b > 0; b--) { acc += bins[b]; if (acc >= n * 0.02) break; }
  const thr = b / sc;
  let sl = 0, sg = 0;
  for (let i = 0; i < n; i++) if (g[i] >= thr) { sl += l[i]; sg += g[i]; }
  return sg ? Math.min(100, sl / sg * 100) : 0;
}

export class Capture {
  constructor({ toast, store, onImport, keepAwake }) {
    this.toast = toast; this.store = store; this.onImport = onImport; this.keepAwake = keepAwake;
    this.el = $('#view-capture');
    this.video = $('#cap-video');
    this.p = 'live';
    this.points = [];
    this.tilt = null;
    this.timer = { mode: 'interval', every: 10, everyU: 'm', count: 144, open: false, scount: 120, span: 24, spanU: 'h' };
    try { Object.assign(this.timer, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch { /* egal */ }
    this.run = null;
    this.ana = document.createElement('canvas');
    this.anaS = document.createElement('canvas');
    this.bind();
  }

  // ------------------------------------------------------------ Grundgerüst

  bind() {
    $('#cap-close').onclick = () => this.close();
    $('#cap-primary').onclick = () => this.primary();
    $('#cap-retest').onclick = () => this.setPhase('live');
    $('#run-pause').onclick = () => this.togglePause();
    $('#run-stop').onclick = () => { if (confirm('Aufnahme jetzt beenden? Bisherige Fotos bleiben erhalten.')) this.finish(); };
    $('#run-dim').onclick = () => this.dim(true);
    $('#cap-dim').onclick = () => this.dim(false);
    $('#cap-save').onclick = () => this.saveToPhotos();
    $('#cap-discard').onclick = () => this.discard();
    $('#cap-view').addEventListener('pointerdown', e => this.viewTap(e));
    // Timer-Einstellungen
    $('#cap-mode').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { this.timer.mode = b.dataset.v; this.renderTimer(); } });
    $('#cap-every-u').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { this.timer.everyU = b.dataset.v; this.renderTimer(); } });
    $('#cap-span-u').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { this.timer.spanU = b.dataset.v; this.renderTimer(); } });
    $('#cap-open').onchange = e => { this.timer.open = e.target.checked; this.renderTimer(); };
    const LIM = { every: [1, 999], count: [2, 9999], scount: [2, 9999], span: [1, 9999] };
    for (const st of $$('.stepper', this.el)) {
      const k = st.dataset.k, [lo, hi] = LIM[k];
      st.innerHTML = `<button type="button" data-d="-1" aria-label="weniger">−</button><input type="number" inputmode="numeric" min="${lo}" max="${hi}"><button type="button" data-d="1" aria-label="mehr">+</button>`;
      const inp = $('input', st);
      st.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        const v = this.timer[k], step = v >= 1000 ? 100 : v >= 200 ? 10 : v >= 50 ? 5 : 1;
        this.timer[k] = clamp(v + step * +b.dataset.d, lo, hi); this.renderTimer();
      });
      inp.onchange = () => { this.timer[k] = clamp(Math.round(+inp.value || lo), lo, hi); this.renderTimer(); };
    }
    document.addEventListener('visibilitychange', () => this.onVisibility());
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('deviceorientation', e => {
      if (e.beta == null) return;
      const flat = Math.abs(e.beta) < 50; // Handy liegt (Kamera nach unten) oder steht aufrecht
      this.tilt = flat ? { flat, x: e.gamma, y: e.beta, a: Math.hypot(e.beta, e.gamma) } : { flat, x: e.gamma, y: 0, a: Math.abs(e.gamma) };
    });
  }

  async open() {
    // Bewegungssensor (Wasserwaage) braucht auf iOS eine Erlaubnis – nur direkt im Antippen möglich
    try { DeviceOrientationEvent?.requestPermission?.().catch(() => {}); } catch { /* egal */ }
    document.body.classList.add('capture-open');
    this.el.hidden = false;
    this.still = null; this.points = [];
    this.setPhase('live');
    await this.startCamera();
  }

  close() {
    if (this.run && !this.run.done) {
      if (!confirm('Aufnahme läuft. Beenden und schließen? Bisherige Fotos bleiben in Lapse gespeichert.')) return;
      this.finish(true);
    }
    this.stopCamera();
    this.dim(false);
    this.el.hidden = true;
    document.body.classList.remove('capture-open');
    this.onClosed?.();
  }

  setPhase(p) {
    this.p = p;
    this.el.dataset.phase = p;
    $$('.cap-step', this.el).forEach(s => (s.hidden = s.dataset.p !== p));
    const order = ['live', 'check', 'timer', 'run'], cur = order.indexOf(p === 'done' ? 'run' : p);
    $$('#cap-phases li').forEach((li, i) => { li.classList.toggle('on', i === cur && p !== 'done'); li.classList.toggle('done', i < cur || p === 'done'); });
    const still = $('#cap-still');
    still.hidden = !(p === 'check' && this.still) && !(p === 'done' && this.lastUrl);
    if (p === 'check' && this.still) still.src = this.still.url;
    if (p === 'done' && this.lastUrl) still.src = this.lastUrl;
    if (p === 'timer') this.renderTimer();
    this.renderPoints();
    this.updatePrimary();
    this.layout();
    $('.cap-panel', this.el).scrollTop = 0;
  }

  updatePrimary() {
    const b = $('#cap-primary'), foot = $('.cap-action', this.el);
    foot.hidden = this.p === 'run';
    b.disabled = false;
    if (this.p === 'live') { b.textContent = this.busy ? 'Wird analysiert …' : 'Testfoto aufnehmen'; b.disabled = !this.stream || this.busy; }
    else if (this.p === 'check') { b.textContent = 'Weiter: Timer einstellen'; }
    else if (this.p === 'timer') { b.textContent = 'Aufnahme starten'; b.disabled = !this.stream; }
    else if (this.p === 'done') { b.textContent = 'Weiter: Ausrichten & Video'; b.disabled = !this.doneCount; }
  }

  primary() {
    if (this.p === 'live') this.testShot();
    else if (this.p === 'check') {
      if (this.points.length < 2 && !confirm('Weniger als 2 Bezugspunkte. Ohne Punkte richtet Lapse später automatisch aus – bei stillstehender Kamera meist kein Problem. Trotzdem weiter?')) return;
      this.setPhase('timer');
    } else if (this.p === 'timer') this.start();
    else if (this.p === 'done') this.importAll();
  }

  // ------------------------------------------------------------ Kamera

  async startCamera() {
    this.msg('');
    if (!navigator.mediaDevices?.getUserMedia) {
      this.msg('Dieser Browser erlaubt keinen Kamerazugriff. Bitte Lapse in Safari öffnen (über HTTPS).');
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 }, frameRate: { ideal: 30 } },
      });
    } catch (err) {
      this.stream = null;
      this.msg(err.name === 'NotAllowedError'
        ? 'Kamerazugriff wurde nicht erlaubt. iPhone: Einstellungen › Apps › Safari › Kamera › „Erlauben“ – dann Lapse neu öffnen.'
        : 'Kamera konnte nicht gestartet werden: ' + err.message);
      this.updatePrimary();
      return false;
    }
    this.track = this.stream.getVideoTracks()[0];
    this.track.addEventListener('ended', () => this.onTrackEnded());
    this.video.srcObject = this.stream;
    try { await this.video.play(); } catch { /* autoplay: muted + playsinline */ }
    await new Promise(r => (this.video.videoWidth ? r() : this.video.addEventListener('loadedmetadata', r, { once: true })));
    this.caps = this.track.getCapabilities?.() || {};
    this.buildControls();
    this.layout();
    this.loop();
    this.updatePrimary();
    return true;
  }

  stopCamera() {
    clearTimeout(this._loop); this._loop = 0;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null; this.track = null;
    this.video.srcObject = null;
  }

  async onTrackEnded() {
    if (!this.run || this.run.done) return;
    this.warn('Kamera wurde vom System beendet – wird neu gestartet …');
    await this.startCamera();
  }

  /** Bedienelemente nur für Funktionen, die diese Kamera wirklich anbietet. */
  buildControls() {
    const c = this.caps, box = $('#cap-controls');
    const rows = [];
    const set = this.track.getSettings?.() || {};
    if (c.zoom && c.zoom.max > c.zoom.min) rows.push(['zoom', 'Zoom', c.zoom.min, Math.min(c.zoom.max, 10), c.zoom.step || 0.1, set.zoom ?? c.zoom.min, v => v.toFixed(1) + '×']);
    if (c.exposureCompensation && c.exposureCompensation.max > c.exposureCompensation.min) {
      const e = c.exposureCompensation;
      rows.push(['exposureCompensation', 'Belichtung', Math.max(e.min, -3), Math.min(e.max, 3), e.step || 0.1, set.exposureCompensation ?? 0, v => (v > 0 ? '+' : '') + v.toFixed(1) + ' EV']);
    }
    this.lockable = ['exposureMode', 'focusMode', 'whiteBalanceMode'].filter(k => Array.isArray(c[k]) && c[k].includes('manual') && c[k].includes('continuous'));
    box.innerHTML = rows.map(([k, label, lo, hi, st, v, f]) =>
      `<label class="cap-ctl"><span>${label}</span><input type="range" data-c="${k}" min="${lo}" max="${hi}" step="${st}" value="${v}"><output data-o="${k}">${f(+v)}</output></label>`).join('')
      + `<div class="cap-toggles">${c.torch ? '<button class="btn small" data-t="torch">☀ Licht</button>' : ''}${this.lockable.length ? '<button class="btn small" data-t="lock">◎ Belichtung &amp; Fokus fixieren</button>' : ''}</div>`;
    const fmt = Object.fromEntries(rows.map(r => [r[0], r[6]]));
    $$('input[data-c]', box).forEach(inp => inp.oninput = () => {
      const k = inp.dataset.c, v = +inp.value;
      $(`output[data-o="${k}"]`, box).textContent = fmt[k](v);
      this.track.applyConstraints({ advanced: [{ [k]: v }] }).catch(() => {});
    });
    $$('[data-t]', box).forEach(b => b.onclick = async () => {
      if (b.dataset.t === 'torch') { this.torch = !this.torch; await this.track.applyConstraints({ advanced: [{ torch: this.torch }] }).catch(() => {}); b.classList.toggle('on', this.torch); }
      else { await this.setLock(!this.locked); b.classList.toggle('on', this.locked); }
    });
  }

  async setLock(on) {
    if (!this.lockable?.length || !this.track) return false;
    try {
      await this.track.applyConstraints({ advanced: [Object.fromEntries(this.lockable.map(k => [k, on ? 'manual' : 'continuous']))] });
      this.locked = on;
      return true;
    } catch { return false; }
  }

  msg(t) { const m = $('#cap-msg'); m.textContent = t; m.hidden = !t; }

  // ------------------------------------------------------------ Darstellung

  /** Inhaltsrechteck des Bildes (object-fit: contain) in der Vorschau. */
  contentRect() {
    const v = $('#cap-view'), cw = v.clientWidth, ch = v.clientHeight;
    const src = this.p === 'check' && this.still ? this.still : { w: this.video.videoWidth, h: this.video.videoHeight };
    if (!src.w) return { x: 0, y: 0, w: cw, h: ch, cw, ch, iw: cw, ih: ch };
    const s = Math.min(cw / src.w, ch / src.h), w = src.w * s, h = src.h * s;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h, cw, ch, iw: src.w, ih: src.h };
  }

  layout() {
    if (this.el.hidden) return;
    const r = this.contentRect(), pts = $('#cap-pts');
    Object.assign(pts.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    const dpr = Math.min(2, devicePixelRatio || 1);
    for (const c of [$('#cap-overlay'), $('#cap-hist')]) {
      const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    }
    this.renderPoints();
    this.drawOverlay();
  }

  renderPoints() {
    const show = (this.p === 'check' || this.p === 'run') && this.still;
    const box = $('#cap-pts');
    if (!show) { box.innerHTML = ''; return; }
    const m = Math.max(this.still.w, this.still.h);
    box.innerHTML = this.points.map((p, k) =>
      `<div class="ring" style="left:${p.x * m / this.still.w * 100}%;top:${p.y * m / this.still.h * 100}%"><b>${k + 1}</b></div>`).join('');
    const n = this.points.length;
    $('#cap-pts-n').textContent = `${n}/${MAX_PTS}`;
  }

  viewTap(e) {
    if (this.p === 'run' && this.dimmed) return;
    if (this.p !== 'check' || !this.still) return;
    const r = this.contentRect(), vr = $('#cap-view').getBoundingClientRect();
    const sx = e.clientX - vr.left - r.x, sy = e.clientY - vr.top - r.y;
    if (sx < 0 || sy < 0 || sx > r.w || sy > r.h) return;
    const m = Math.max(this.still.w, this.still.h);
    const k = this.points.findIndex(p => Math.hypot(p.x * m / this.still.w * r.w - sx, p.y * m / this.still.h * r.h - sy) < 26);
    if (k >= 0) this.points.splice(k, 1);
    else if (this.points.length >= MAX_PTS) { this.toast(`Höchstens ${MAX_PTS} Punkte – zuerst einen Ring antippen, um ihn zu entfernen.`); return; }
    else this.points.push({ x: sx / r.w * this.still.w / m, y: sy / r.h * this.still.h / m, manual: true });
    this.renderPoints();
    this.renderIssues();
  }

  drawOverlay() {
    const c = $('#cap-overlay'), ctx = c.getContext('2d'), W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (this.p === 'check' || !this.video.videoWidth) return;
    const k = W / Math.max(1, c.clientWidth), r = this.contentRect();
    const x0 = r.x * k, y0 = r.y * k, w = r.w * k, h = r.h * k, cx = x0 + w / 2, cy = y0 + h / 2;
    ctx.lineWidth = 1 * k;
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.beginPath();
    for (const t of [1 / 3, 2 / 3]) { ctx.moveTo(x0 + w * t, y0); ctx.lineTo(x0 + w * t, y0 + h); ctx.moveTo(x0, y0 + h * t); ctx.lineTo(x0 + w, y0 + h * t); }
    ctx.stroke();
    // Hilfskreis (z. B. Petrischale mittig)
    ctx.setLineDash([6 * k, 6 * k]);
    ctx.strokeStyle = 'rgba(127,211,230,.55)';
    ctx.beginPath(); ctx.arc(cx, cy, Math.min(w, h) * 0.43, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // Fadenkreuz
    const cs = 14 * k;
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.beginPath(); ctx.moveTo(cx - cs, cy); ctx.lineTo(cx - cs / 3, cy); ctx.moveTo(cx + cs / 3, cy); ctx.lineTo(cx + cs, cy);
    ctx.moveTo(cx, cy - cs); ctx.lineTo(cx, cy - cs / 3); ctx.moveTo(cx, cy + cs / 3); ctx.lineTo(cx, cy + cs); ctx.stroke();
    // Wasserwaage
    if (this.tilt) {
      const R = 26 * k, t = this.tilt, ok = t.a < 2;
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      const bx = cx + clamp(t.x / 15, -1, 1) * R, by = cy + clamp(t.y / 15, -1, 1) * R;
      ctx.fillStyle = ok ? 'rgba(90,211,154,.9)' : 'rgba(255,181,71,.9)';
      ctx.beginPath(); ctx.arc(bx, by, 5 * k, 0, Math.PI * 2); ctx.fill();
    }
    // Bezugspunkte während der Aufnahme: zeigen, ob die Kamera verrutscht
    if (this.p === 'run' && this.still) {
      const m = Math.max(this.still.w, this.still.h);
      ctx.strokeStyle = 'rgba(255,181,71,.9)'; ctx.lineWidth = 2 * k;
      for (const p of this.points) { ctx.beginPath(); ctx.arc(x0 + p.x * m / this.still.w * w, y0 + p.y * m / this.still.h * h, 15 * k, 0, Math.PI * 2); ctx.stroke(); }
    }
  }

  drawHist(meas) {
    const c = $('#cap-hist'), ctx = c.getContext('2d'), W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const t of [0.25, 0.5, 0.75]) { ctx.moveTo(W * t, 0); ctx.lineTo(W * t, H); }
    ctx.stroke();
    if (!meas) return;
    const [hr, hg, hb, hl] = meas.hist;
    let max = 1;
    for (const hh of [hr, hg, hb]) for (let i = 1; i < 63; i++) max = Math.max(max, hh[i]);
    const top = H * 0.08, base = H * 0.86, y = v => base - Math.min(1, v / max) * (base - top);
    ctx.globalCompositeOperation = 'lighter';
    for (const [hh, col] of [[hr, 'rgba(255,70,60,.55)'], [hg, 'rgba(70,220,110,.5)'], [hb, 'rgba(80,140,255,.6)']]) {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(0, base);
      for (let i = 0; i < 64; i++) ctx.lineTo((i + 0.5) / 64 * W, y(hh[i]));
      ctx.lineTo(W, base); ctx.closePath(); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(235,240,245,.85)'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < 64; i++) { const X = (i + 0.5) / 64 * W; i ? ctx.lineTo(X, y(hl[i])) : ctx.moveTo(X, y(hl[i])); }
    ctx.stroke();
    // Clipping-Marker
    if (meas.clipHi > 0.005) { ctx.fillStyle = '#ff6b5e'; ctx.fillRect(W - 4, top, 4, base - top); }
    if (meas.clipLo > 0.02) { ctx.fillStyle = '#6cb6ff'; ctx.fillRect(0, top, 4, base - top); }
  }

  // ------------------------------------------------------------ Live-Analyse

  loop() {
    clearTimeout(this._loop);
    const step = () => {
      if (!this.stream || this.el.hidden) return;
      if (!document.hidden && this.video.videoWidth) { try { this.analyzeLive(); } catch (err) { console.error(err); } }
      this._loop = setTimeout(step, this.dimmed ? 1000 : 250);
    };
    step();
  }

  analyzeLive() {
    const v = this.video, vw = v.videoWidth, vh = v.videoHeight;
    const s = 160 / Math.max(vw, vh), w = Math.round(vw * s), h = Math.round(vh * s);
    const a = this.ana; if (a.width !== w || a.height !== h) { a.width = w; a.height = h; this.prevLum = null; }
    const ctx = a.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    const meas = measure(ctx.getImageData(0, 0, w, h).data, w, h);
    // Bewegung: mittlere Änderung gegenüber dem letzten Bild
    if (this.prevLum && this.prevLum.length === meas.lum.length) {
      let d = 0; for (let i = 0; i < meas.lum.length; i++) d += Math.abs(meas.lum[i] - this.prevLum[i]);
      const mo = d / meas.lum.length / 255 * 100;
      this.motion = this.motion == null ? mo : this.motion * 0.6 + mo * 0.4;
    }
    this.prevLum = meas.lum;
    // Schärfe (größeres Bild, jedes 2. Mal)
    this._sh = (this._sh || 0) + 1;
    if (this._sh % 3 === 0) {
      const s2 = 720 / Math.max(vw, vh), w2 = Math.round(vw * s2), h2 = Math.round(vh * s2), b = this.anaS;
      if (b.width !== w2 || b.height !== h2) { b.width = w2; b.height = h2; }
      const c2 = b.getContext('2d', { willReadFrequently: true });
      c2.imageSmoothingQuality = 'high';
      c2.drawImage(this.halved(v, vw, vh, w2), 0, 0, w2, h2);
      const m2 = measure(c2.getImageData(0, 0, w2, h2).data, w2, h2);
      const sh = sharpness(m2.lum, w2, h2);
      this.sharp = this.sharp == null ? sh : this.sharp * 0.5 + sh * 0.5;
    }
    this.live = meas;
    if (this.dimmed) { this.updateDim(); return; }
    this.drawHist(meas);
    this.drawOverlay();
    this.renderHud();
    if (this.p === 'live') this.renderMeters();
  }

  /** In Halbierungsschritten verkleinern (sauber gefiltert, ohne Treppeneffekte) bis knapp über tw. */
  halved(src, w, h, tw) {
    let cur = src;
    this._half ||= [];
    for (let i = 0; w / 2 >= tw; i++) {
      w = Math.round(w / 2); h = Math.round(h / 2);
      const c = this._half[i] ||= document.createElement('canvas');
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, w, h);
      cur = c;
    }
    return cur;
  }

  status() {
    const m = this.live; if (!m) return {};
    const L = m.L, mo = this.motion ?? 0, sh = this.sharp ?? 0, t = this.tilt?.a;
    return {
      exp: L < 0.18 || L > 0.88 ? 'bd' : L < 0.28 || L > 0.78 || m.clipHi > 0.02 ? 'wn' : 'ok',
      sharp: sh < 25 ? 'bd' : sh < 40 ? 'wn' : 'ok',
      motion: mo > 1.5 ? 'bd' : mo > 0.6 ? 'wn' : 'ok',
      tilt: t == null ? 'na' : t > 6 ? 'bd' : t > 2 ? 'wn' : 'ok',
    };
  }

  renderMeters() {
    const m = this.live, st = this.status(), mo = this.motion ?? 0, sh = this.sharp ?? 0, t = this.tilt?.a;
    const tile = (key, label, val, frac, s) => `<div class="meter ${s === 'ok' || s === 'na' ? '' : s}"><div class="mk">${label}</div><div class="mv">${val}</div><div class="mb"><i style="width:${clamp(frac, 0, 1) * 100}%"></i></div></div>`;
    $('#cap-meters').innerHTML =
      tile('exp', 'Licht', (m.L * 100).toFixed(0) + '%', m.L, st.exp) +
      tile('sharp', 'Schärfe', sh.toFixed(0), sh / 70, st.sharp) +
      tile('motion', 'Ruhe', mo < 0.3 ? 'stabil' : mo.toFixed(1) + '%', 1 - mo / 2, st.motion) +
      tile('tilt', 'Lage', t == null ? '—' : t.toFixed(1) + '°', t == null ? 0 : 1 - t / 10, st.tilt);
  }

  renderHud() {
    const m = this.live, v = this.video, s = this.track?.getSettings?.() || {};
    const st = this.status(), cls = k => (st[k] === 'bd' ? 'bd' : st[k] === 'wn' ? 'wn' : 'ok');
    const r = this.run, now = new Date();
    $('#hud-tl').innerHTML = `<span class="k">RES </span>${v.videoWidth}×${v.videoHeight}\n<span class="k">FPS </span>${s.frameRate ? Math.round(s.frameRate) : '—'}${s.zoom ? `\n<span class="k">ZOOM</span> ${(+s.zoom).toFixed(1)}×` : ''}${this.locked ? '\n<span class="ok">AE/AF LOCK</span>' : ''}`;
    $('#hud-tr').innerHTML = r && !r.done
      ? `<span class="rec">● REC</span> ${pad(r.taken)}${isFinite(r.count) ? '/' + pad(r.count) : ''}\n${timeStr(now)}`
      : `<span class="k">LIVE</span> ${timeStr(now)}`;
    const [R, G, B] = m.rgb, g = Math.max(1, G);
    $('#hud-bl').innerHTML = `<span class="k">LUM </span><span class="${cls('exp')}">${(m.L * 100).toFixed(1)} %</span>\n<span class="k">CLIP</span> ▲${(m.clipHi * 100).toFixed(1)} ▼${(m.clipLo * 100).toFixed(1)} %\n<span class="k">RGB </span>${(R / g).toFixed(2)} 1.00 ${(B / g).toFixed(2)}`;
    $('#hud-br').innerHTML = `<span class="k">SHARP </span><span class="${cls('sharp')}">${(this.sharp ?? 0).toFixed(0)}</span>\n<span class="k">MOTION </span><span class="${cls('motion')}">${(this.motion ?? 0).toFixed(2)} %</span>\n<span class="k">TILT </span>${this.tilt ? `<span class="${cls('tilt')}">${this.tilt.a.toFixed(1)}°</span>` : '—'}`;
  }

  // ------------------------------------------------------------ Testfoto

  async grab(q = 0.92) {
    const v = this.video, w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) throw new Error('Kein Kamerabild');
    const c = this.full ||= document.createElement('canvas');
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    return { canvas: c, blob: await toBlob(c, 'image/jpeg', q), w, h };
  }

  async testShot() {
    if (this.busy || !this.stream) return;
    this.busy = true; this.updatePrimary();
    try {
      this.flash();
      const motion = this.motion ?? 0, tilt = this.tilt ? { ...this.tilt } : null;
      const { canvas, blob, w, h } = await this.grab();
      if (this.still?.url) URL.revokeObjectURL(this.still.url);
      this.still = { blob, w, h, url: URL.createObjectURL(blob), motion, tilt };
      // Analyse
      const small = scaleTo(canvas, 1024);
      const sctx = small.getContext('2d', { willReadFrequently: true });
      const meas = measure(sctx.getImageData(0, 0, small.width, small.height).data, small.width, small.height);
      const s2 = scaleTo(canvas, 720), c2 = s2.getContext('2d', { willReadFrequently: true });
      const sh = sharpness(measure(c2.getImageData(0, 0, s2.width, s2.height).data, s2.width, s2.height).lum, s2.width, s2.height);
      this.still.meas = meas; this.still.sharp = sh;
      this.points = this.suggestPoints(canvas);
      this.still.found = this.points.length;
      this.setPhase('check');
      this.renderIssues();
      this.drawHist(meas);
    } catch (err) {
      console.error(err);
      this.toast('Testfoto fehlgeschlagen: ' + err.message, 5000);
    } finally {
      this.busy = false; this.updatePrimary();
    }
  }

  /** Markante, gut verteilte Punkte (z. B. Haferflocken) im Testfoto vorschlagen. */
  suggestPoints(canvas) {
    const c = scaleTo(canvas, 640);
    const { gray, chroma, w, h } = grayChromaOf(c);
    const pyr = pyramid(gray, w, h), cpyr = pyramid(chroma, w, h);
    const m = Math.max(w, h);
    // nur Flecken, die rundum auf hellem Untergrund liegen (nicht am Schalenrand/Papierrand)
    const L = pyr.find(l => Math.max(l.w, l.h) <= 340) || pyr[pyr.length - 1];
    const sorted = Float32Array.from(L.img).sort(), bright = sorted[Math.floor(sorted.length * 0.95)] * 0.78;
    const inside = bl => {
      const r = Math.max(4 * bl.sig, 0.035) * m / L.s;
      let ok = 0;
      for (let t = 0; t < 24; t++) {
        const a = t * Math.PI / 12, x = Math.round(bl.x * m / L.s + Math.cos(a) * r), y = Math.round(bl.y * m / L.s + Math.sin(a) * r);
        if (x >= 0 && y >= 0 && x < L.w && y < L.h && L.img[y * L.w + x] >= bright) ok++;
      }
      return ok >= 21;
    };
    const blobs = detectBlobs(pyr, m, { maxBlobs: 20, cpyr }).filter(inside);
    if (!blobs.length) return [];
    const vmax = blobs[0].v, out = [blobs[0]];
    const rest = blobs.slice(1, 14);
    while (out.length < MAX_PTS && rest.length) {
      let best = -1, bi = -1;
      rest.forEach((b, i) => {
        const d = Math.min(...out.map(o => Math.hypot(o.x - b.x, o.y - b.y)));
        if (d < 0.05) return;
        const sc = d * Math.pow(b.v / vmax, 0.35);
        if (sc > best) { best = sc; bi = i; }
      });
      if (bi < 0) break;
      out.push(rest.splice(bi, 1)[0]);
    }
    return out.map(b => ({ x: b.x, y: b.y, auto: true }));
  }

  issues() {
    const s = this.still; if (!s) return [];
    const m = s.meas, L = m.L, out = [];
    const ev = this.caps?.exposureCompensation ? 'exp' : null;
    // Belichtung
    if (L < 0.18) out.push(['bd', 'Zu dunkel', `${(L * 100).toFixed(0)} %`, 'Mehr Licht ans Motiv bringen' + (ev ? ' oder Belichtung erhöhen.' : '.'), ev && ['+0,7 EV', 0.7]]);
    else if (L < 0.28) out.push(['wn', 'Eher dunkel', `${(L * 100).toFixed(0)} %`, 'Mehr Licht verbessert Schärfe und verringert Rauschen.', ev && ['+0,3 EV', 0.3]]);
    else if (L > 0.85) out.push(['bd', 'Zu hell', `${(L * 100).toFixed(0)} %`, 'Licht reduzieren' + (ev ? ' oder Belichtung senken.' : '.'), ev && ['−0,7 EV', -0.7]]);
    else out.push(['ok', 'Belichtung', `${(L * 100).toFixed(0)} %`]);
    if (m.clipHi > 0.02) out.push(['wn', 'Überstrahlte Stellen', `${(m.clipHi * 100).toFixed(1)} %`, 'Helle Flächen verlieren Zeichnung (z. B. Spiegelungen auf dem Deckel). Licht seitlich/indirekt setzen' + (ev ? ' oder Belichtung senken.' : '.'), ev && ['−0,3 EV', -0.3]]);
    // Schärfe
    if (s.sharp < 25) out.push(['bd', 'Unscharf', `Index ${s.sharp.toFixed(0)}`, 'Abstand vergrößern (Nahgrenze ca. 10–15 cm), Linse reinigen, Kamera ruhig halten.']);
    else if (s.sharp < 40) out.push(['wn', 'Leicht unscharf', `Index ${s.sharp.toFixed(0)}`, 'Etwas mehr Abstand (Nahgrenze), mehr Licht oder Linse reinigen.']);
    else out.push(['ok', 'Schärfe', `Index ${s.sharp.toFixed(0)}`]);
    // Ruhe & Lage
    if (s.motion > 0.6) out.push([s.motion > 1.5 ? 'bd' : 'wn', 'Kamera bewegt sich', `${s.motion.toFixed(2)} %`, 'Für einen ruhigen Zeitraffer das iPhone fest einspannen (Stativ, Halterung oder Bücherstapel).']);
    else out.push(['ok', 'Kamera ruhig', `${(s.motion || 0).toFixed(2)} %`]);
    if (s.tilt) {
      if (s.tilt.a > 2) out.push([s.tilt.a > 6 ? 'bd' : 'wn', 'Schräg', `${s.tilt.a.toFixed(1)}°`, s.tilt.flat ? 'iPhone parallel zur Schale ausrichten (Punkt der Wasserwaage in die Mitte).' : 'iPhone gerade ausrichten.']);
      else out.push(['ok', 'Lage', `${s.tilt.a.toFixed(1)}°`]);
    }
    // Farbstich (nur Hinweis – Lapse gleicht Farben später aus)
    const [R, G, B] = m.rgb, cast = Math.max(R, G, B) / Math.max(1, Math.min(R, G, B));
    if (cast > 1.35) out.push(['in', R > B ? 'Warmer Farbstich' : 'Kühler Farbstich', `R/B ${(R / Math.max(1, B)).toFixed(2)}`, 'Unkritisch – Lapse gleicht Farben aus. Wichtig ist gleichbleibendes Licht (kein wechselndes Tageslicht).']);
    // Bezugspunkte
    const n = this.points.length;
    if (n < 2) out.push(['bd', 'Keine Bezugspunkte', `${n}`, 'Lege 3–5 kleine, feste Markierungen in die Schale (z. B. Haferflocken) oder tippe selbst auf markante Stellen, die sich nicht bewegen.']);
    else if (n < 4) out.push(['wn', 'Wenige Bezugspunkte', `${n}`, 'Mit 4–5 verteilten Punkten wird die Ausrichtung zuverlässiger. Tippe auf weitere markante Stellen.']);
    else {
      const xs = this.points.map(p => p.x), ys = this.points.map(p => p.y);
      const spread = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      if (spread < 0.12) out.push(['wn', 'Punkte liegen eng beieinander', '', 'Weiter verteilte Punkte machen die Ausrichtung genauer.']);
      else out.push(['ok', 'Bezugspunkte', `${n} gesetzt`]);
    }
    // Belichtung fixieren
    if (this.lockable?.length) out.push(['in', 'Belichtung & Fokus', this.locked ? 'fixiert' : 'automatisch', 'Wird beim Start automatisch fixiert – das verhindert Flackern im Video.']);
    if (Math.max(s.w, s.h) < 1920) out.push(['in', 'Auflösung', `${s.w}×${s.h}`, 'Der Browser liefert nur diese Auflösung – für ein Full-HD-Video reicht das knapp.']);
    return out;
  }

  renderIssues() {
    const list = this.issues();
    const rank = { bd: 0, wn: 1, in: 2, ok: 3 };
    list.sort((a, b) => rank[a[0]] - rank[b[0]]);
    $('#cap-issues').innerHTML = list.map(([s, t, val, help, act], i) => `<li class="${s}"><span class="dot"></span><div><b>${t}</b>${val ? `<span class="val">${val}</span>` : ''}${help ? `<p>${help}</p>` : ''}${act ? `<button class="btn small" data-fix="${i}">Belichtung ${act[0]} &amp; neues Testfoto</button>` : ''}</div></li>`).join('');
    $$('#cap-issues [data-fix]').forEach(b => b.onclick = async () => {
      const act = list[+b.dataset.fix][4], e = this.caps.exposureCompensation;
      const cur = this.track.getSettings?.().exposureCompensation ?? 0, v = clamp(cur + act[1], e.min, e.max);
      await this.track.applyConstraints({ advanced: [{ exposureCompensation: v }] }).catch(() => {});
      const inp = $('input[data-c="exposureCompensation"]'); if (inp) { inp.value = v; inp.oninput(); }
      this.setPhase('live');
      setTimeout(() => this.testShot(), 900); // Belichtung einschwingen lassen
    });
  }

  // ------------------------------------------------------------ Timer

  plan() {
    const t = this.timer;
    let interval, count;
    if (t.mode === 'interval') { interval = t.every * UNIT[t.everyU]; count = t.open ? Infinity : t.count; }
    else { count = t.scount; interval = t.span * UNIT[t.spanU] / Math.max(1, count - 1); }
    interval = Math.max(2, interval);
    return { interval, count, duration: isFinite(count) ? (count - 1) * interval : Infinity };
  }

  async renderTimer() {
    const t = this.timer;
    try { localStorage.setItem(LS_KEY, JSON.stringify(t)); } catch { /* egal */ }
    $$('#cap-mode button').forEach(b => b.classList.toggle('on', b.dataset.v === t.mode));
    $$('#cap-every-u button').forEach(b => b.classList.toggle('on', b.dataset.v === t.everyU));
    $$('#cap-span-u button').forEach(b => b.classList.toggle('on', b.dataset.v === t.spanU));
    $('#tm-interval').hidden = t.mode !== 'interval';
    $('#tm-span').hidden = t.mode !== 'span';
    $('#cap-open').checked = t.open;
    for (const st of $$('.stepper', this.el)) $('input', st).value = this.timer[st.dataset.k];
    $('.stepper[data-k="count"]').style.opacity = t.open ? 0.4 : 1;
    const p = this.plan(), size = this.still?.blob.size || 2.5e6;
    const end = isFinite(p.duration) ? new Date(Date.now() + p.duration * 1000) : null;
    const endTxt = end ? end.toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
    let free = null;
    try { const e = await navigator.storage?.estimate?.(); if (e?.quota) free = e.quota - (e.usage || 0); } catch { /* egal */ }
    const need = isFinite(p.count) ? p.count * size : null;
    const rows = [
      ['Intervall', fmtDur(p.interval)],
      ['Aufnahmen', isFinite(p.count) ? p.count : 'bis Stopp'],
      ['Dauer', fmtDur(p.duration)],
      ['Ende ca.', endTxt],
      ['Video 30 fps', isFinite(p.count) ? fmtDur(p.count / 30).replace(' s', ',' + Math.round((p.count / 30 % 1) * 10) + ' s') : '—'],
      ['Speicher ca.', need ? fmtMB(need) : fmtMB(size) + ' / Foto', need && free != null && need > free * 0.8 ? 'wn' : ''],
    ];
    if (free != null) rows.push(['Frei für Lapse', fmtMB(free)]);
    $('#cap-plan').innerHTML = rows.map(([k, v, c]) => `<tr class="${c || ''}"><td>${k}</td><td>${v}</td></tr>`).join('');
    // Checkliste
    const long = !isFinite(p.duration) || p.duration > 1800;
    const wl = 'wakeLock' in navigator;
    const items = [
      [wl ? 'ok' : 'wn', 'Display bleibt an', wl ? 'Lapse hält das Display während der Aufnahme wach. Zur Sicherheit: Einstellungen › Anzeige & Helligkeit › Automatische Sperre › „Nie“.' : 'Bitte Einstellungen › Anzeige & Helligkeit › Automatische Sperre › „Nie“ wählen – sonst stoppt die Aufnahme.'],
      ['wn', 'Lapse geöffnet lassen', 'Nicht in andere Apps wechseln und das iPhone nicht sperren – Safari pausiert sonst die Kamera. Verpasste Aufnahmen werden protokolliert.'],
      [long ? 'wn' : 'ok', 'Strom', long ? 'Ladekabel anschließen – Kamera und Display brauchen viel Energie.' : 'Für kurze Aufnahmen reicht der Akku.'],
      ['ok', 'Ruhe', 'Kontrollzentrum: Ausrichtungssperre an, Fokus „Nicht stören“ gegen Anrufe und Mitteilungen.'],
      [this.lockable?.length ? 'ok' : 'wn', 'Gleichmäßige Helligkeit', this.lockable?.length ? 'Belichtung & Fokus werden beim Start fixiert.' : 'Belichtung lässt sich hier nicht fixieren – Lapse gleicht Helligkeitsschwankungen später aus. Möglichst gleichbleibendes Kunstlicht verwenden.'],
    ];
    $('#cap-check').innerHTML = items.map(([s, t, d]) => `<li class="${s}"><span class="dot"></span><div><b>${t}</b><p>${d}</p></div></li>`).join('');
  }

  // ------------------------------------------------------------ Aufnahme

  async start() {
    if (!this.stream) return;
    const p = this.plan();
    if (this.lockable?.length && !this.locked) await this.setLock(true);
    const session = Date.now();
    this.run = { session, ...p, t0: Date.now(), wall0: Date.now(), k: 0, taken: 0, missed: 0, paused: false, done: false, bytes: 0, last: null, log: [] };
    try { await this.store.clearCaptures(); } catch { /* egal */ }
    await this.saveMeta('running');
    await this.wake(true);
    this.setPhase('run');
    this.warn('');
    clearInterval(this._tick);
    this._tick = setInterval(() => this.tick(), 250);
    this.tick();
  }

  async saveMeta(status) {
    const r = this.run; if (!r) return;
    const meta = {
      session: r.session, status, startedAt: r.wall0, interval: r.interval, count: isFinite(r.count) ? r.count : null,
      taken: r.taken, missed: r.missed, anchors: this.points.map(p => ({ x: p.x, y: p.y })),
      w: this.still?.w || this.video.videoWidth, h: this.still?.h || this.video.videoHeight, bytes: r.bytes, endedAt: status === 'done' ? Date.now() : null,
    };
    try { await this.store.setCaptureMeta(meta); } catch (err) { console.error(err); }
    return meta;
  }

  tick() {
    const r = this.run; if (!r || r.done) return;
    const now = Date.now();
    if (!r.paused && !r.shooting && now >= r.t0 + r.k * r.interval * 1000) this.shoot();
    // Anzeige
    const next = r.paused ? r.pauseLeft : (r.t0 + r.k * r.interval * 1000 - now) / 1000;
    $('#run-n').textContent = pad(r.taken);
    $('#run-of').textContent = isFinite(r.count) ? '/ ' + pad(r.count) : '/ ∞';
    $('#run-next').textContent = r.paused ? 'PAUSE' : r.shooting ? '● ● ●' : fmtClock(next);
    $('#run-bar').style.width = isFinite(r.count) ? (r.k / r.count * 100) + '%' : '0%';
    const el = (Date.now() - r.wall0) / 1000;
    const rows = [
      ['Laufzeit', fmtDur(el)],
      ['Restzeit', isFinite(r.count) ? fmtDur(Math.max(0, (r.count - 1) * r.interval - el)) : 'offen'],
      ['Intervall', fmtDur(r.interval)],
      ['Letzte Aufnahme', r.last ? timeStr(new Date(r.last)) : '—'],
      ['Gespeichert', fmtMB(r.bytes)],
      ['Verpasst', r.missed, r.missed ? 'wn' : ''],
      ['Display wach', this.wakeLock ? 'ja (Wake Lock)' : 'Auto-Sperre beachten', this.wakeLock ? '' : 'wn'],
    ];
    $('#run-table').innerHTML = rows.map(([k, v, c]) => `<tr class="${c || ''}"><td>${k}</td><td>${v}</td></tr>`).join('');
    if (this.dimmed) this.updateDim();
  }

  async shoot() {
    const r = this.run;
    r.shooting = true;
    const idx = r.taken;
    try {
      if (!this.video.videoWidth || this.video.readyState < 2) throw new Error('Kamera nicht bereit');
      const { blob, w, h } = await this.grab(0.93);
      const t = Date.now();
      await this.store.putCapture({ key: `${r.session}-${pad(idx, 5)}`, session: r.session, idx, t, w, h, blob });
      r.taken++; r.bytes += blob.size; r.last = t;
      if (!this.dimmed) this.flash();
    } catch (err) {
      console.error(err);
      r.missed++;
      this.warn('Aufnahme fehlgeschlagen: ' + err.message);
    }
    // nächster Termin; wurde Zeit verpasst (Hintergrund), Termine überspringen
    r.k++;
    const cur = Math.floor((Date.now() - r.t0) / (r.interval * 1000));
    if (!r.paused && cur > r.k) { r.missed += cur - r.k; r.k = cur; } // Termine im Hintergrund verpasst
    r.shooting = false;
    this.saveMeta('running');
    if (r.k >= r.count) this.finish();
  }

  togglePause() {
    const r = this.run; if (!r || r.done) return;
    if (!r.paused) { r.paused = true; r.pauseAt = Date.now(); r.pauseLeft = (r.t0 + r.k * r.interval * 1000 - r.pauseAt) / 1000; $('#run-pause').textContent = '▶ Fortsetzen'; }
    else { r.t0 += Date.now() - r.pauseAt; r.paused = false; $('#run-pause').textContent = '❚❚ Pause'; }
    this.tick();
  }

  async finish(silent = false) {
    const r = this.run; if (!r || r.done) return;
    while (r.shooting) await new Promise(res => setTimeout(res, 100));
    r.done = true;
    clearInterval(this._tick);
    await this.saveMeta('done');
    await this.wake(false);
    if (this.locked) await this.setLock(false);
    this.dim(false);
    this.stopCamera();
    if (!silent) await this.showDone();
  }

  async showDone(meta) {
    const r = this.run;
    meta ||= { taken: r.taken, missed: r.missed, startedAt: r.wall0, endedAt: Date.now(), bytes: r.bytes, w: this.still?.w, h: this.still?.h, interval: r.interval };
    this.doneMeta = meta;
    this.captures = await this.store.listCaptures().catch(() => []);
    this.doneCount = this.captures.length;
    const stamp = new Date(meta.startedAt || Date.now());
    const base = `LAPSE_${stamp.getFullYear()}${pad(stamp.getMonth() + 1, 2)}${pad(stamp.getDate(), 2)}_${pad(stamp.getHours(), 2)}${pad(stamp.getMinutes(), 2)}`;
    this.files = this.captures.map((c, i) => new File([c.blob], `${base}_${pad(i + 1, 4)}.jpg`, { type: 'image/jpeg', lastModified: c.t }));
    this.saveIdx = 0;
    if (this.lastUrl) URL.revokeObjectURL(this.lastUrl);
    const last = this.captures[this.captures.length - 1];
    this.lastUrl = last ? URL.createObjectURL(last.blob) : null;
    $('#hud-tl').innerHTML = last ? `<span class="k">RES </span>${last.w}×${last.h}\n<span class="k">LETZTES FOTO</span>` : '';
    $('#hud-tr').innerHTML = `<span class="ok">✓ ${this.captures.length} FOTOS</span>\n${last ? timeStr(new Date(last.t)) : ''}`;
    $('#hud-bl').innerHTML = ''; $('#hud-br').innerHTML = '';
    $('#cap-overlay').getContext('2d').clearRect(0, 0, 1e5, 1e5);
    const rows = [
      ['Aufnahmen', this.doneCount],
      ['Verpasst', meta.missed || 0, meta.missed ? 'wn' : ''],
      ['Dauer', fmtDur(((meta.endedAt || Date.now()) - meta.startedAt) / 1000)],
      ['Intervall', meta.interval ? fmtDur(meta.interval) : '—'],
      ['Auflösung', meta.w ? `${meta.w}×${meta.h}` : '—'],
      ['Größe', fmtMB(this.captures.reduce((s, c) => s + c.blob.size, 0))],
      ['Video 30 fps', fmtDur(this.doneCount / 30)],
    ];
    $('#done-table').innerHTML = rows.map(([k, v, c]) => `<tr class="${c || ''}"><td>${k}</td><td>${v}</td></tr>`).join('');
    this.updateSaveBtn();
    this.setPhase('done');
  }

  updateSaveBtn() {
    const n = this.files?.length || 0, parts = Math.ceil(n / BATCH), b = $('#cap-save');
    b.disabled = !n || !navigator.canShare;
    if (!navigator.canShare) b.textContent = 'In Fotos sichern (nicht unterstützt)';
    else if (this.saveIdx >= n && n) b.textContent = '✓ Alle in Fotos gesichert';
    else b.textContent = parts > 1 ? `In Fotos sichern · Teil ${Math.floor(this.saveIdx / BATCH) + 1} von ${parts}` : `In Fotos sichern (${n})`;
  }

  /** iOS erlaubt das Sichern in Fotos nur über das Teilen-Menü („Bilder sichern“). */
  async saveToPhotos() {
    const all = this.files || [];
    if (!all.length) return;
    if (this.saveIdx >= all.length) this.saveIdx = 0;
    const batch = all.slice(this.saveIdx, this.saveIdx + BATCH);
    if (!navigator.canShare?.({ files: batch })) { this.toast('Teilen von Fotos wird hier nicht unterstützt.', 4000); return; }
    try {
      await navigator.share({ files: batch });
      this.saveIdx += batch.length;
      this.toast(this.saveIdx >= all.length ? 'Fertig – alle Fotos übergeben. Im Menü „Bilder sichern“ wählen.' : `Teil gesichert – weiter mit Teil ${Math.floor(this.saveIdx / BATCH) + 1}.`, 3500);
    } catch (err) {
      if (err.name !== 'AbortError') this.toast('Sichern fehlgeschlagen: ' + err.message, 5000);
    }
    this.updateSaveBtn();
  }

  async importAll() {
    if (!this.files?.length) return;
    const anchors = (this.doneMeta?.anchors || this.points).map(p => ({ x: p.x, y: p.y }));
    const files = this.files;
    this.close();
    await this.onImport(files, anchors);
    try { const m = await this.store.captureMeta(); if (m) await this.store.setCaptureMeta({ ...m, imported: true }); } catch { /* egal */ }
  }

  async discard() {
    if (!confirm('Alle Fotos dieser Aufnahme aus Lapse löschen? (Bereits in Fotos gesicherte Bilder bleiben erhalten.)')) return;
    await this.store.clearCaptures().catch(() => {});
    this.files = []; this.captures = []; this.doneCount = 0; this.run = null;
    this.close();
    this.toast('Aufnahme verworfen.');
  }

  /** Gespeicherte Aufnahme (z. B. nach Neuladen) öffnen: Übersicht, Sichern, Weiterverarbeiten. */
  async openSaved() {
    const meta = await this.store.captureMeta();
    if (!meta) return;
    document.body.classList.add('capture-open');
    this.el.hidden = false;
    this.run = null; this.points = meta.anchors || [];
    await this.showDone(meta);
  }

  // ------------------------------------------------------------ Display / Hintergrund

  async wake(on) {
    try {
      if (on && 'wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      } else if (!on && this.wakeLock) { await this.wakeLock.release(); this.wakeLock = null; }
    } catch { this.wakeLock = null; }
  }

  async onVisibility() {
    const r = this.run;
    if (!r || r.done) return;
    if (document.hidden) { r.hiddenAt = Date.now(); return; }
    await this.wake(true);
    if (!this.track || this.track.readyState === 'ended') await this.startCamera();
    else this.video.play().catch(() => {});
    if (r.hiddenAt) {
      const gone = (Date.now() - r.hiddenAt) / 1000;
      if (gone > r.interval * 0.9) this.warn(`Lapse war ${fmtDur(gone)} im Hintergrund – dabei können keine Fotos entstehen. Bitte Lapse geöffnet lassen.`);
      r.hiddenAt = null;
    }
  }

  warn(t) { const w = $('#run-warn'); w.textContent = t; w.hidden = !t; }

  dim(on) {
    this.dimmed = on;
    $('#cap-dim').hidden = !on;
    if (on) this.updateDim();
    this.loop();
  }

  updateDim() {
    const r = this.run; if (!r) return;
    const next = r.paused ? 'PAUSE' : fmtClock((r.t0 + r.k * r.interval * 1000 - Date.now()) / 1000);
    $('#cap-dim-txt').textContent = `● REC ${pad(r.taken)}${isFinite(r.count) ? '/' + pad(r.count) : ''}\nnächste ${next}`;
  }

  flash() {
    const f = $('#cap-flash');
    f.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
  }
}

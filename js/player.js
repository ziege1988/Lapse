// Vorschau-Player: spielt den Zeitplan des Projekts in Echtzeit ab (Vorschaubilder),
// zeigt Einzelbilder und Vergleichsansichten zur Referenz.

import { Renderer } from './renderer.js';
import { I3 } from './geometry.js';

const CACHE = 48;

export class Player {
  constructor(canvas, project) {
    this.canvas = canvas;
    this.project = project;
    this.r = new Renderer(canvas);
    this.r.onRestore = () => this.render();
    this.loading = new Map();
    this.t = 0;
    this.playing = false;
    this.inspect = null;    // { frame, compare: 'off'|'overlay'|'difference'|'blink' }
    this.onTime = null;     // Rückruf (t, duration, currentFrame)
    this._raf = 0;
    this._blink = 0;
  }

  setSize(cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    const k = Math.min(1, 1280 / Math.max(w, h));
    w = Math.max(2, Math.round(w * k)); h = Math.max(2, Math.round(h * k));
    this.r.resize(w, h);
    this.render();
  }

  ensure(f) {
    const key = 'p' + f.id;
    if (this.r.has(key)) return Promise.resolve(true);
    if (this.loading.has(key)) return this.loading.get(key);
    const p = createImageBitmap(f.previewBlob).then(bmp => {
      if (!this.r.lost) this.r.upload(key, bmp, bmp.width, bmp.height);
      bmp.close?.();
      this.loading.delete(key);
      return true;
    }).catch(() => { this.loading.delete(key); return false; });
    this.loading.set(key, p);
    return p;
  }

  forget(id) { this.r.drop('p' + id); }
  clearCache() { this.r.clear(); }

  timeline() {
    if (!this._tl) this._tl = this.project.timeline();
    return this._tl;
  }
  invalidate() { this._tl = null; this.render(); }

  /** Ebenen für den aktuellen Zustand bestimmen. */
  layers() {
    const p = this.project;
    if (this.inspect?.raw) {
      // ganzes Foto ohne Zuschnitt/Korrektur (zum Setzen von Ankerpunkten)
      const f = this.inspect.frame;
      return { layers: [{ key: 'p' + f.id, frame: f, M: I3(), weight: 1 }], mode: 'normal', neutral: true };
    }
    if (!p.crop) return { layers: [], mode: 'normal' };
    if (this.inspect?.crop) {
      // ausgerichtet in einem festen Ausschnitt (z. B. ganzes Bezugsfoto) – für die Prüfung
      const L = p.layer(this.inspect.frame, 1);
      L.M = p.layerMatrix(this.inspect.frame, this.inspect.crop);
      return { layers: [L], mode: 'normal' };
    }
    if (this.inspect) {
      const { frame, compare } = this.inspect;
      const ref = p.ref;
      if (compare === 'overlay' && ref && ref !== frame) return { layers: [p.layer(frame, 0.5), p.layer(ref, 0.5)], mode: 'normal' };
      if (compare === 'difference' && ref && ref !== frame) {
        // Helligkeit/Farbe vorher normieren, damit nur Ausrichtungsfehler sichtbar werden
        const a = p.layer(frame, 1), b = p.layer(ref, 1);
        const fs = frame.stats, rs = ref.stats;
        a.gain = [1, 1, 1]; a.off = [0, 0, 0]; a.mul = [1, 1, 1];
        b.gain = [1, 1, 1]; b.off = [0, 0, 0]; b.mul = [1, 1, 1];
        if (fs && rs) for (let c = 0; c < 3; c++) {
          a.gain[c] = Math.min(4, rs.std[c] / Math.max(fs.std[c], 0.004));
          a.off[c] = rs.mean[c] - a.gain[c] * fs.mean[c];
        }
        return { layers: [a, b], mode: 'difference', neutral: true };
      }
      if (compare === 'blink' && ref) return { layers: [p.layer(this._blink ? ref : frame, 1)], mode: 'normal' };
      return { layers: [p.layer(frame, 1)], mode: 'normal' };
    }
    const tl = this.timeline();
    return { layers: tl.sample(this.t).map(s => p.layer(s.frame, s.weight)), mode: 'normal' };
  }

  render() {
    if (this._pending) return;
    this._pending = true;
    requestAnimationFrame(() => { this._pending = false; this._draw(); });
  }

  _draw() {
    const { layers, mode, neutral } = this.layers();
    const missing = layers.filter(L => !this.r.has(L.key));
    if (missing.length) {
      Promise.all(missing.map(L => this.ensure(L.frame))).then(() => this.render());
      // Während des Ladens nur zeichnen, wenn mindestens ein Bild bereitsteht
      if (missing.length === layers.length) return;
    }
    this.r.draw(layers, { global: neutral ? [1, 1, 1] : this.project.globalParams(), mode });
    this.r.trim(CACHE, new Set(layers.map(L => L.key)));
    const tl = this.timeline();
    this.onTime?.(this.t, tl.duration, layers[0]?.frame);
  }

  play() {
    if (this.playing) return;
    this.inspect = null;
    const tl = this.timeline();
    if (this.t >= tl.duration - 1e-3) this.t = 0;
    this.playing = true;
    let last = performance.now();
    const step = now => {
      if (!this.playing) return;
      const tl2 = this.timeline();
      this.t += (now - last) / 1000;
      last = now;
      if (this.t >= tl2.duration) this.t = 0; // Endlosschleife
      this._preload(tl2);
      const { layers } = this.layers();
      if (layers.every(L => this.r.has(L.key))) this._draw();
      else Promise.all(layers.map(L => this.ensure(L.frame))); // kurz warten statt zu ruckeln
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
    this.onPlayState?.(true);
  }

  _preload(tl) {
    // die nächsten ~1,5 s vorladen
    const seen = new Set();
    for (let k = 1; k <= 12; k++) {
      const t = (this.t + k * 0.125) % tl.duration;
      for (const s of tl.sample(t)) if (!seen.has(s.frame.id)) { seen.add(s.frame.id); this.ensure(s.frame); }
    }
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this._raf);
    this.onPlayState?.(false);
  }

  seek(t) {
    const tl = this.timeline();
    this.t = Math.max(0, Math.min(tl.duration, t));
    this.inspect = null;
    this.render();
  }

  /** Zeit, zu der ein bestimmtes Bild im Video (erstmals) voll sichtbar ist. */
  timeOf(frame) {
    const tl = this.timeline();
    for (let j = 0; j < tl.frames; j++) {
      const t = j / tl.fps, s = tl.sample(t);
      const hit = s.find(x => x.frame === frame);
      if (hit && hit.weight >= Math.max(...s.map(x => x.weight))) return t;
    }
    return 0;
  }

  showFrame(frame, compare = 'off') {
    this.pause();
    this.inspect = { frame, compare };
    clearInterval(this._blinkTimer);
    if (compare === 'blink') {
      this._blinkTimer = setInterval(() => { this._blink ^= 1; this.render(); }, 450);
    }
    this.render();
  }

  /** Foto ausgerichtet im Ausschnitt crop (Bezugsfoto-Koordinaten) zeigen. */
  showAligned(frame, crop) {
    this.pause();
    clearInterval(this._blinkTimer);
    this.inspect = { frame, crop };
    this.render();
  }

  showRaw(frame) {
    this.pause();
    clearInterval(this._blinkTimer);
    this.inspect = { frame, raw: true };
    this.render();
  }

  stopInspect() {
    clearInterval(this._blinkTimer);
    this.inspect = null;
    this.render();
  }
}

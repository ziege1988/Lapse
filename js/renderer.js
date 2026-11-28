// WebGL-Renderer: Entzerrung (Homographie), Farbangleich, globale Korrekturen und
// Überblendung mehrerer Bilder. Vorschau und Export nutzen denselben Code, damit
// die Vorschau dem fertigen Video entspricht.

const VS = `
attribute vec2 a_pos;
varying vec2 v_pos;
void main() {
  v_pos = a_pos;
  gl_Position = vec4(a_pos.x * 2.0 - 1.0, 1.0 - a_pos.y * 2.0, 0.0, 1.0);
}`;

const FS = `
precision highp float;
varying vec2 v_pos;
uniform sampler2D u_tex0, u_tex1;
uniform mat3 u_m0, u_m1;
uniform vec3 u_gain0, u_off0, u_mul0, u_gain1, u_off1, u_mul1;
uniform vec3 u_global; // Belichtung (Faktor), Kontrast, Sättigung
uniform float u_weight;
uniform int u_mode;    // 0 = normal, 1 = Differenz zu Bild 1, 2 = Einblendung (RGBA unverändert)
vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec4 fetch(sampler2D t, mat3 m, vec3 gain, vec3 off, vec3 mul) {
  vec3 q = m * vec3(v_pos, 1.0);
  vec2 uv = q.xy / q.z;
  if (q.z <= 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  vec3 c = texture2D(t, uv).rgb;
  c = c * gain + off;
  vec3 lin = toLin(c) * mul * u_global.x;
  c = toSrgb(lin);
  c = (c - 0.5) * u_global.y + 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, u_global.z);
  return vec4(clamp(c, 0.0, 1.0), 1.0);
}
void main() {
  if (u_mode == 2) { gl_FragColor = texture2D(u_tex0, v_pos); return; }
  vec4 a = fetch(u_tex0, u_m0, u_gain0, u_off0, u_mul0);
  if (u_mode == 1) {
    vec4 b = fetch(u_tex1, u_m1, u_gain1, u_off1, u_mul1);
    vec3 d = abs(a.rgb - b.rgb);
    float v = clamp(dot(d, vec3(0.333)) * 3.0, 0.0, 1.0);
    gl_FragColor = vec4(mix(vec3(0.08), vec3(1.0, 0.85, 0.2), v), 1.0);
    return;
  }
  gl_FragColor = vec4(a.rgb * u_weight, u_weight);
}`;

export class Renderer {
  constructor(canvas, { preserve = false } = {}) {
    this.canvas = canvas;
    this.textures = new Map(); // key -> { tex, w, h, used }
    this.preserve = preserve;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; this.textures.clear(); });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this._init(); this.onRestore?.(); });
    this._init();
  }

  _init() {
    const opts = { preserveDrawingBuffer: this.preserve, premultipliedAlpha: false, alpha: false, antialias: false };
    const gl = this.canvas.getContext('webgl2', opts) || this.canvas.getContext('webgl', opts);
    if (!gl) throw new Error('WebGL wird nicht unterstützt.');
    this.gl = gl;
    this.isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    this.prog = p;
    this.loc = {};
    for (const n of ['u_tex0', 'u_tex1', 'u_m0', 'u_m1', 'u_gain0', 'u_off0', 'u_mul0', 'u_gain1', 'u_off1', 'u_mul1', 'u_global', 'u_weight', 'u_mode'])
      this.loc[n] = gl.getUniformLocation(p, n);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(p, 'a_pos');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(this.loc.u_tex0, 0);
    gl.uniform1i(this.loc.u_tex1, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.fbo = null;
  }

  has(key) { return this.textures.has(key); }

  upload(key, source, w, h) {
    const gl = this.gl;
    const old = this.textures.get(key);
    const tex = old ? old.tex : gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (this.isGL2) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    this.textures.set(key, { tex, w, h, used: performance.now() });
  }

  /** Einblendung (z. B. Maßstab) setzen; source = Canvas in Ausgabegröße oder null. */
  setOverlay(source) {
    const gl = this.gl;
    if (!source) { if (this.ov) { gl.deleteTexture(this.ov); this.ov = null; } return; }
    this.ov ||= gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ov);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  }

  /** Kleines Bild (z. B. Zeitanzeige) in ein Rechteck zeichnen (Pixel, oben links). */
  drawImage(source, rect) {
    const gl = this.gl;
    if (this.lost) return;
    this.stampTex ||= gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stampTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const H = this._vh || this.canvas.height;
    gl.viewport(Math.round(rect.x), Math.round(H - rect.y - rect.h), Math.round(rect.w), Math.round(rect.h));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(this.loc.u_mode, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.uniform1i(this.loc.u_mode, 0);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, this._vw || this.canvas.width, H);
  }

  /** Einblendung über das ganze Bild legen (nach allen Ebenen). */
  drawOverlay() {
    if (!this.ov || this.lost) return;
    this.gl.viewport(0, 0, this._vw || this.canvas.width, this._vh || this.canvas.height);
    this._drawOverlay();
  }

  _drawOverlay() {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(this.loc.u_mode, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ov);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.uniform1i(this.loc.u_mode, 0);
    gl.disable(gl.BLEND);
  }

  drop(key) {
    const t = this.textures.get(key);
    if (t) { this.gl.deleteTexture(t.tex); this.textures.delete(key); }
  }

  /** Entfernt die am längsten ungenutzten Texturen bis auf `keep` Stück (außer `protect`). */
  trim(keep, protect = new Set()) {
    if (this.textures.size <= keep) return;
    const list = [...this.textures.entries()].filter(([k]) => !protect.has(k)).sort((a, b) => a[1].used - b[1].used);
    for (const [k] of list) {
      if (this.textures.size <= keep) break;
      this.drop(k);
    }
  }

  clear() { for (const k of [...this.textures.keys()]) this.drop(k); }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  _setLayer(i, L) {
    const gl = this.gl, t = this.textures.get(L.key);
    t.used = performance.now();
    gl.activeTexture(i === 0 ? gl.TEXTURE0 : gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    const M = L.M; // zeilenweise -> spaltenweise für GLSL
    gl.uniformMatrix3fv(this.loc['u_m' + i], false, [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]]);
    gl.uniform3fv(this.loc['u_gain' + i], L.gain || [1, 1, 1]);
    gl.uniform3fv(this.loc['u_off' + i], L.off || [0, 0, 0]);
    gl.uniform3fv(this.loc['u_mul' + i], L.mul || [1, 1, 1]);
  }

  /**
   * Zeichnet Ebenen [{key, M, gain, off, mul, weight}] (Gewichte summieren zu 1).
   * opts: { global:[exp,contrast,sat], mode:'normal'|'difference', target: {w,h} für Offscreen }
   */
  draw(layers, { global = [1, 1, 1], mode = 'normal', target = null, overlay = false, viewport = null, clear = true } = {}) {
    const gl = this.gl;
    if (this.lost) return false;
    let w = this.canvas.width, h = this.canvas.height;
    if (target) { this._bindFbo(target.w, target.h); w = target.w; h = target.h; }
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._vw = w; this._vh = h;
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, w, h);
    if (clear) { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    // Teilbereich (z. B. Zoom-Ausschnitt), Angabe von oben links in Pixeln
    if (viewport) gl.viewport(Math.round(viewport.x), Math.round(h - viewport.y - viewport.h), Math.round(viewport.w), Math.round(viewport.h));
    const usable = layers.filter(L => this.textures.has(L.key) && L.weight > 0);
    if (!usable.length) return false;
    gl.uniform3fv(this.loc.u_global, global);
    if (mode === 'difference' && usable.length >= 2) {
      gl.uniform1i(this.loc.u_mode, 1);
      this._setLayer(0, usable[0]);
      this._setLayer(1, usable[1]);
      gl.uniform1f(this.loc.u_weight, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return true;
    }
    gl.uniform1i(this.loc.u_mode, 0);
    const sum = usable.reduce((s, L) => s + L.weight, 0);
    usable.forEach((L, i) => {
      if (i === 1) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); }
      this._setLayer(0, L);
      gl.uniform1f(this.loc.u_weight, L.weight / sum);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    });
    gl.disable(gl.BLEND);
    if (overlay && this.ov) this._drawOverlay();
    return true;
  }

  _bindFbo(w, h) {
    const gl = this.gl;
    if (!this.fbo || this.fbo.w !== w || this.fbo.h !== h) {
      if (this.fbo) { gl.deleteFramebuffer(this.fbo.fb); gl.deleteTexture(this.fbo.tex); }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.fbo = { fb, tex, w, h };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.fb);
  }

  /** Liest den Offscreen-Puffer (nach draw mit target) als RGBA-Bytes. */
  readTarget() {
    const gl = this.gl, { w, h } = this.fbo;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return px;
  }

  destroy() {
    this.clear();
    this.setOverlay(null);
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}

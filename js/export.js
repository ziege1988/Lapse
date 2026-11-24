// Export: rendert jedes Videobild in voller Auflösung aus den Originaldateien und
// kodiert es (WebCodecs + MP4/WebM-Muxer, GIF oder JPEG-Einzelbilder als ZIP).

import { Renderer } from './renderer.js';
import { decode, release, scaleTo, freeCanvas, makeCanvas, toBlob } from './images.js';
import { ZipWriter } from './zip.js';

export const FORMATS = {
  'mp4-avc': { label: 'MP4 · H.264', ext: 'mp4', mime: 'video/mp4', note: 'Empfohlen – läuft überall, auch in der Fotos-App' },
  'mp4-hevc': { label: 'MP4 · HEVC (H.265)', ext: 'mp4', mime: 'video/mp4', note: 'Kleinere Datei bei gleicher Qualität' },
  'webm-vp9': { label: 'WebM · VP9', ext: 'webm', mime: 'video/webm', note: 'Für Web & Android; nicht für die iPhone-Fotos-App' },
  'gif': { label: 'GIF (animiert)', ext: 'gif', mime: 'image/gif', note: 'Für Messenger & Web; max. 720 px, 256 Farben' },
  'zip': { label: 'JPEG-Einzelbilder (ZIP)', ext: 'zip', mime: 'application/zip', note: 'Ausgerichtete & angeglichene Fotos zur Weiterverarbeitung' },
};

const CODECS = {
  'mp4-avc': ['avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.64002A', 'avc1.640028', 'avc1.4D0028', 'avc1.42E01F'],
  'mp4-hevc': ['hvc1.1.6.L153.B0', 'hvc1.1.6.L150.B0', 'hvc1.1.6.L123.B0', 'hev1.1.6.L123.B0'],
  'webm-vp9': ['vp09.00.40.08', 'vp09.00.31.08', 'vp09.00.10.08'],
};

const QUALITY_BPP = { standard: 0.09, high: 0.16, max: 0.28 };

function encoderConfig(format, codec, w, h, fps, quality) {
  const bitrate = Math.round(Math.min(80e6, Math.max(1.5e6, w * h * fps * QUALITY_BPP[quality])));
  const cfg = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality', bitrateMode: 'variable' };
  if (format === 'mp4-avc') cfg.avc = { format: 'avc' };
  if (format === 'mp4-hevc') cfg.hevc = { format: 'hevc' };
  return cfg;
}

/** Erste unterstützte Codec-Konfiguration für Format & Größe, sonst null. */
export async function findConfig(format, w, h, fps, quality = 'high') {
  if (typeof VideoEncoder === 'undefined' || !CODECS[format]) return null;
  for (const codec of CODECS[format]) {
    const cfg = encoderConfig(format, codec, w, h, fps, quality);
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r.supported) return r.config || cfg;
    } catch { /* weiter */ }
  }
  return null;
}

export function mediaRecorderType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'])
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  return null;
}

/** Ausgabegröße aus Kurzkante und Seitenverhältnis (gerade Pixelzahlen). */
export function outputSize(aspect, shortEdge) {
  const even = v => Math.max(2, Math.round(v / 2) * 2);
  return aspect >= 1 ? { w: even(shortEdge * aspect), h: even(shortEdge) } : { w: even(shortEdge), h: even(shortEdge / aspect) };
}

/** Pixel des Originals entlang der kurzen Zuschnittkante (für den Hochskalierungs-Hinweis). */
export function sourceDetail(project) {
  const ref = project.ref, crop = project.crop;
  if (!ref || !crop) return 0;
  return Math.round(Math.min(crop.w, crop.h) * Math.max(ref.w, ref.h));
}

class HiResSource {
  constructor(project, renderer, outW) {
    this.p = project; this.r = renderer; this.outW = outW;
    this.loading = new Map();
  }
  sizeFor(f) {
    const T = this.p.transform(f);
    const s = Math.sqrt(Math.abs(T[0] * T[4] - T[1] * T[3])) || 1;
    const need = (this.outW / this.p.crop.w) * s * 1.25;
    return Math.min(Math.max(f.w, f.h), this.r.maxTex, Math.ceil(need));
  }
  ensure(f) {
    const key = 'x' + f.id;
    if (this.r.has(key)) return Promise.resolve();
    if (this.loading.has(key)) return this.loading.get(key);
    const p = (async () => {
      const src = await decode(f.file);
      try {
        const c = scaleTo(src, this.sizeFor(f));
        this.r.upload(key, c, c.width, c.height);
        freeCanvas(c);
      } finally { release(src); }
    })().finally(() => this.loading.delete(key));
    this.loading.set(key, p);
    return p;
  }
}

const tick = () => new Promise(r => setTimeout(r, 0));

/**
 * Führt den Export aus.
 * opts: { format, shortEdge, quality, onProgress(frac, text), isCancelled }
 * Rückgabe: { blob, name, mime, w, h, duration }
 */
export async function runExport(project, opts) {
  const { format, quality = 'high', onProgress, isCancelled } = opts;
  const crop = project.crop;
  const aspect = crop.w / crop.h;
  let { w, h } = outputSize(aspect, opts.shortEdge);
  if (format === 'gif') {
    const k = Math.min(1, (opts.gifLong || 480) / Math.max(w, h));
    ({ w, h } = { w: Math.round(w * k / 2) * 2, h: Math.round(h * k / 2) * 2 });
  }
  const canvas = makeCanvas(w, h);
  const r = new Renderer(canvas, { preserve: true });
  const src = new HiResSource(project, r, w);
  const global = project.globalParams();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  try {
    if (format === 'zip') return await exportZip(project, r, src, canvas, global, { w, h, stamp, onProgress, isCancelled });
    const tl = project.timeline();
    const fps = format === 'gif' ? Math.min(tl.fps, 25) : tl.fps;
    const total = Math.max(1, Math.round(tl.duration * fps));
    const drawAt = async j => {
      const samples = tl.sample(j / fps);
      await Promise.all(samples.map(s => src.ensure(s.frame)));
      // nächstes Bild schon vorbereiten
      const next = tl.sample((j + 1) / fps);
      for (const s of next) if (!r.has('x' + s.frame.id)) { src.ensure(s.frame).catch(() => {}); break; }
      const layers = samples.map(s => project.layer(s.frame, s.weight, 'x'));
      r.draw(layers, { global });
      r.trim(6, new Set([...layers.map(L => L.key), ...next.map(s => 'x' + s.frame.id)]));
    };
    if (format === 'gif') return await exportGif(canvas, drawAt, { w, h, fps, total, stamp, onProgress, isCancelled });
    return await exportVideo(format, canvas, drawAt, { w, h, fps, total, quality, stamp, onProgress, isCancelled });
  } finally {
    r.destroy();
    freeCanvas(canvas);
  }
}

async function exportVideo(format, canvas, drawAt, { w, h, fps, total, quality, stamp, onProgress, isCancelled }) {
  const cfg = await findConfig(format, w, h, fps, quality);
  if (!cfg) return exportMediaRecorder(canvas, drawAt, { fps, total, w, h, quality, stamp, onProgress, isCancelled });
  const isMp4 = format.startsWith('mp4');
  const lib = isMp4 ? await import('../vendor/mp4-muxer.mjs') : await import('../vendor/webm-muxer.mjs');
  const target = new lib.ArrayBufferTarget();
  const muxer = isMp4
    ? new lib.Muxer({ target, video: { codec: format === 'mp4-hevc' ? 'hevc' : 'avc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' })
    : new lib.Muxer({ target, video: { codec: 'V_VP9', width: w, height: h, frameRate: fps }, firstTimestampBehavior: 'offset' });
  let encError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { encError = e; },
  });
  encoder.configure(cfg);
  const dur = Math.round(1e6 / fps), gop = Math.max(1, Math.round(fps * 2));
  const t0 = performance.now();
  for (let j = 0; j < total; j++) {
    if (isCancelled?.()) { encoder.close(); throw new DOMException('Abgebrochen', 'AbortError'); }
    if (encError) throw encError;
    await drawAt(j);
    const vf = new VideoFrame(canvas, { timestamp: j * dur, duration: dur });
    encoder.encode(vf, { keyFrame: j % gop === 0 });
    vf.close();
    while (encoder.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 4));
    report(onProgress, j + 1, total, t0, 'Video wird kodiert');
    if (j % 4 === 0) await tick();
  }
  await encoder.flush();
  if (encError) throw encError;
  encoder.close();
  muxer.finalize();
  const f = isMp4 ? 'mp4' : 'webm';
  return { blob: new Blob([target.buffer], { type: isMp4 ? 'video/mp4' : 'video/webm' }), name: `lapse_${stamp}.${f}`, w, h, duration: total / fps };
}

async function exportMediaRecorder(canvas, drawAt, { fps, total, w, h, quality, stamp, onProgress, isCancelled }) {
  const type = mediaRecorderType();
  if (!type || !canvas.captureStream) throw new Error('Dieses Gerät unterstützt keine Videokodierung im Browser. Bitte iOS aktualisieren oder GIF/ZIP wählen.');
  // Echtzeitaufnahme (Rückfall für ältere Geräte)
  canvas.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;';
  document.body.appendChild(canvas);
  const stream = canvas.captureStream(0), track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: Math.round(w * h * fps * QUALITY_BPP[quality]) });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const stopped = new Promise(r => { rec.onstop = r; });
  rec.start(1000);
  const t0 = performance.now(), frameMs = 1000 / fps;
  for (let j = 0; j < total; j++) {
    if (isCancelled?.()) { rec.stop(); canvas.remove(); throw new DOMException('Abgebrochen', 'AbortError'); }
    await drawAt(j);
    track.requestFrame?.();
    const due = t0 + (j + 1) * frameMs;
    await new Promise(r => setTimeout(r, Math.max(0, due - performance.now())));
    report(onProgress, j + 1, total, t0, 'Video wird aufgezeichnet (Echtzeit)');
  }
  rec.stop();
  await stopped;
  canvas.remove();
  const mime = type.split(';')[0];
  return { blob: new Blob(chunks, { type: mime }), name: `lapse_${stamp}.${mime.endsWith('mp4') ? 'mp4' : 'webm'}`, w, h, duration: total / fps };
}

async function exportGif(canvas, drawAt, { w, h, fps, total, stamp, onProgress, isCancelled }) {
  const { GIFEncoder, quantize, applyPalette } = await import('../vendor/gifenc.esm.js');
  const gif = GIFEncoder();
  const c2 = makeCanvas(w, h), ctx = c2.getContext('2d', { willReadFrequently: true });
  const delay = Math.round(100 / fps) * 10;
  const t0 = performance.now();
  for (let j = 0; j < total; j++) {
    if (isCancelled?.()) throw new DOMException('Abgebrochen', 'AbortError');
    await drawAt(j);
    ctx.drawImage(canvas, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);
    const palette = quantize(data, 256, { format: 'rgb444' });
    gif.writeFrame(applyPalette(data, palette, 'rgb444'), w, h, { palette, delay, repeat: 0 });
    report(onProgress, j + 1, total, t0, 'GIF wird erstellt');
    if (j % 2 === 0) await tick();
  }
  gif.finish();
  freeCanvas(c2);
  return { blob: new Blob([gif.bytes()], { type: 'image/gif' }), name: `lapse_${stamp}.gif`, w, h, duration: total / fps };
}

async function exportZip(project, r, src, canvas, global, { w, h, stamp, onProgress, isCancelled }) {
  const zip = new ZipWriter();
  const list = project.included;
  const t0 = performance.now();
  for (let i = 0; i < list.length; i++) {
    if (isCancelled?.()) throw new DOMException('Abgebrochen', 'AbortError');
    const f = list[i];
    await src.ensure(f);
    r.draw([project.layer(f, 1, 'x')], { global });
    r.trim(2, new Set(['x' + f.id]));
    const blob = await toBlob(canvas, 'image/jpeg', 0.93);
    const base = f.name.replace(/\.[^.]+$/, '');
    await zip.add(`lapse_${String(i + 1).padStart(4, '0')}_${base}.jpg`, blob, f.date ? new Date(f.date) : new Date());
    report(onProgress, i + 1, list.length, t0, 'Einzelbilder werden gespeichert');
  }
  return { blob: zip.finish(), name: `lapse_${stamp}_einzelbilder.zip`, w, h, duration: 0 };
}

function report(onProgress, done, total, t0, text) {
  if (!onProgress) return;
  const el = (performance.now() - t0) / 1000;
  const eta = done > 2 ? el / done * (total - done) : null;
  onProgress(done / total, `${text} – ${done}/${total}${eta != null ? ` · noch ca. ${fmtTime(eta)}` : ''}`);
}

export function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min`;
}

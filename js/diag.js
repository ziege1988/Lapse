// Protokoll & Diagnose: Lapse schreibt laufend mit, was berechnet wird (Rechenprotokoll),
// sammelt Fehler und erstellt auf Knopfdruck einen Bericht zum Kopieren.
// Der Bericht enthält Messwerte und Dateinamen – keine Bilder.

const MAX = 1500;
const buf = [];
const listeners = new Set();
const T0 = Date.now();
let errors = 0, warnings = 0;

const clean = v => (v instanceof Error ? `${v.name}: ${v.message}${v.stack ? '\n    ' + v.stack.split('\n').slice(1, 4).map(s => s.trim()).join('\n    ') : ''}`
  : typeof v === 'object' ? (() => { try { return JSON.stringify(v); } catch { return String(v); } })() : String(v));

/** Eintrag ins Protokoll. level: 'i' Info, 'ok' Erfolg, 'w' Warnung, 'e' Fehler, 'd' Detail */
export function log(msg, level = 'i') {
  const e = { t: Date.now(), level, msg: String(msg) };
  buf.push(e);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  if (level === 'e') errors++;
  if (level === 'w') warnings++;
  for (const f of listeners) { try { f(e); } catch { /* egal */ } }
  return e;
}
export const onLog = f => { listeners.add(f); return () => listeners.delete(f); };
export const counts = () => ({ errors, warnings, lines: buf.length });
export const entries = () => buf.slice();
export const stamp = t => { const s = (t - T0) / 1000, m = Math.floor(s / 60); return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };

let hooked = false;
/** Ungefangene Fehler und console.error/warn ins Protokoll übernehmen. */
export function installHooks() {
  if (hooked) return; hooked = true;
  window.addEventListener('error', e => log(`Ungefangener Fehler: ${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno})`, 'e'));
  window.addEventListener('unhandledrejection', e => log('Unbehandeltes Promise: ' + clean(e.reason), 'e'));
  for (const [k, lv] of [['error', 'e'], ['warn', 'w']]) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { log(a.map(clean).join(' '), lv); orig(...a); };
  }
}

const yes = b => (b ? 'ja' : 'nein');
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const num = (v, d = 2) => (v == null || !isFinite(v) ? '–' : (+v).toFixed(d));

async function deviceInfo() {
  const n = navigator, out = [];
  out.push(`Browser   ${n.userAgent}`);
  out.push(`Anzeige   ${screen.width}×${screen.height} @${devicePixelRatio}x · Fenster ${innerWidth}×${innerHeight} · ${matchMedia('(display-mode: standalone)').matches || n.standalone ? 'Home-Bildschirm-App' : 'Browser-Tab'}`);
  out.push(`Rechner   ${n.hardwareConcurrency || '?'} Kerne${n.deviceMemory ? ' · ' + n.deviceMemory + ' GB' : ''} · Sprache ${n.language}`);
  let avc = '?';
  try { avc = typeof VideoEncoder !== 'undefined' ? yes((await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 8e6, framerate: 30 })).supported) : 'nein (kein WebCodecs)'; } catch { avc = 'Fehler'; }
  out.push(`Funktionen  H.264-Encoder ${avc} · WakeLock ${yes('wakeLock' in n)} · Teilen(Dateien) ${yes(!!n.canShare)} · Kamera ${yes(!!n.mediaDevices?.getUserMedia)} · OffscreenCanvas ${yes(typeof OffscreenCanvas !== 'undefined')}`);
  try { const e = await n.storage?.estimate?.(); if (e) out.push(`Speicher  belegt ${(e.usage / 1e6).toFixed(0)} MB von ${(e.quota / 1e6).toFixed(0)} MB`); } catch { /* egal */ }
  return out;
}

function projectInfo(project) {
  if (!project) return ['(kein Projekt)'];
  const p = project, out = [];
  const inc = p.included || [];
  out.push(`Fotos ${p.frames.length} · im Video ${inc.length} · ausgerichtet ${yes(p.aligned)} · Bezug ${p.ref?.name || '–'} · Ankerpunkte ${p.anchors.length}${p.anchorsActive ? ' (aktiv)' : ''}`);
  if (p.anchors.length) out.push(`Punkte    ${p.anchors.map(a => `(${num(a.x, 3)},${num(a.y, 3)})`).join(' ')}`);
  if (p.scale) out.push(`Maßstab   ${p.scale.mm} mm über (${num(p.scale.p1.x, 3)},${num(p.scale.p1.y, 3)})–(${num(p.scale.p2.x, 3)},${num(p.scale.p2.y, 3)}) · Balken ${p.settings.scaleBar} · Lineal ${p.settings.ruler ? 'an' : 'aus'}`);
  if (p.settings.roi) out.push(`Zoom      ${p.settings.roiOn ? 'an' : 'aus'} · Region ${['x', 'y', 'w', 'h'].map(k => num(p.settings.roi[k], 3)).join(' ')} · Ecke ${p.settings.insetPos} · Größe ${p.settings.insetSize} · Vergrößerung ${p.settings.insetZoom > 0 ? p.settings.insetZoom + '×' : 'auto'}`);
  out.push(`Daten     ${['probeOn', 'nameOn', 'dateOn', 'areaOn', 'dishOn'].filter(k => p.settings[k]).join(', ') || 'aus'} · Fläche ${p.included.filter(f => f.area != null).map(f => (f.area * 100).toFixed(1)).join('/') || '–'} %`);
  out.push(`Zeit      ${p.settings.stampOn ? 'an' : 'aus'} · ${p.settings.stampMode} · Quelle ${p.settings.stampSource}${p.settings.stampInterval ? ' · Intervall ' + p.settings.stampInterval + ' s' : ''} · Fotos mit Aufnahmezeit ${p.included.filter(f => f.date != null).length}/${p.included.length}`);
  if (p.crop) out.push(`Zuschnitt ${['x', 'y', 'w', 'h'].map(k => num(p.crop[k], 3)).join(' ')}${p.customCrop ? ' · eigener' : ' · automatisch'}`);
  try { out.push(`Einst.    ${JSON.stringify(p.settings)}`); } catch { /* egal */ }
  out.push('');
  out.push(' #  ' + pad('Datei', 16) + pad('Größe', 11) + pad('Qual.', 6) + pad('Methode', 10) + pad('NCC', 6) + pad('Stütze', 7) + pad('Punkte', 30) + ' Hinweis');
  p.frames.forEach((f, i) => {
    const a = f.align || {};
    const pts = (f.anchorPts || []).map(q => num(q.score, 2) + (q.outlier ? 'x' : '')).join('/');
    const st = f.excluded ? (f.autoExcluded ? 'AUS(auto)' : 'AUS') : (f.quality || '–');
    out.push(String(i + 1).padStart(3) + ' ' + pad(f.name || f.id, 16) + pad(`${f.w}×${f.h}`, 11) + pad(st, 6) + pad((a.method || '–') + (a.refined ? '+' : ''), 10)
      + pad(num(a.ncc), 6) + pad(f.geoSupport ?? '–', 7) + pad(pts || '–', 30) + ' ' + (f.qualityNote || '') + (f.inconsistent ? ' [Nachbar]' : '') + (f.manualChecked ? ' [geprüft]' : ''));
  });
  return out;
}

/** Vollständiger Diagnosebericht als Text. */
export async function buildReport({ project, ui, build, maxLines = 300 } = {}) {
  const now = new Date();
  const L = [];
  L.push('=== LAPSE DIAGNOSE ===');
  L.push(`Version ${build || '?'} · ${now.toLocaleString('de-DE')} · Laufzeit ${stamp(Date.now())} · Fehler ${errors} · Warnungen ${warnings}`);
  L.push(`Ansicht ${ui?.view || '?'}${ui?.review ? ' · Prüfen ' + (ui.review.mode || '') : ''}`);
  L.push('', '--- GERÄT ---', ...(await deviceInfo()));
  L.push('', '--- PROJEKT ---', ...projectInfo(project));
  const errs = buf.filter(e => e.level === 'e' || e.level === 'w');
  L.push('', `--- FEHLER & WARNUNGEN (${errs.length}) ---`);
  if (!errs.length) L.push('keine');
  for (const e of errs.slice(-40)) L.push(`${stamp(e.t)} ${e.level === 'e' ? 'FEHLER' : 'WARN  '} ${e.msg}`);
  const tail = buf.slice(-maxLines);
  L.push('', `--- PROTOKOLL (letzte ${tail.length} von ${buf.length}) ---`);
  const tag = { i: '·', ok: '✓', w: '!', e: '✗', d: ' ' };
  for (const e of tail) L.push(`${stamp(e.t)} ${tag[e.level] || '·'} ${e.msg}`);
  L.push('=== ENDE ===');
  return L.join('\n');
}

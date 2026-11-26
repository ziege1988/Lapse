// Browser-Gesamttest: erzeugt verwackelte, flackernde Testfotos, lädt sie in Lapse,
// richtet aus, prüft Qualität und exportiert MP4/WebM/GIF/ZIP.
// Voraussetzung: Playwright mit Chromium. Aufruf: node tests/e2e.cjs
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rsp.writeHead(404); return rsp.end(); }
      rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(rsp);
    }).listen(0, () => res(srv));
  });
}

async function makePhotos(page, N) {
  return page.evaluate(async N => {
    const W = 2400, H = 1600, scene = document.createElement('canvas');
    scene.width = W; scene.height = H;
    const g = scene.getContext('2d');
    let s = 7; const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#3a5a8c'); sky.addColorStop(0.6, '#e8a060'); sky.addColorStop(1, '#2b2b2b');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 260; i++) {
      const x = r() * W, w = 20 + r() * 140, h = 60 + r() * 600;
      g.fillStyle = `hsl(${r() * 360},${20 + r() * 40}%,${15 + r() * 50}%)`;
      g.fillRect(x, H - h, w, h);
      for (let k = 0; k < 12; k++) { g.fillStyle = r() < 0.5 ? '#ffd27a' : '#222'; g.fillRect(x + r() * w, H - h + r() * h, 6 + r() * 10, 8 + r() * 10); }
    }
    const out = [];
    for (let n = 0; n < N; n++) {
      const c = document.createElement('canvas'); c.width = 1600; c.height = 1200;
      const x = c.getContext('2d');
      const flick = n % 5 === 2 ? 1.35 : n % 7 === 3 ? 0.7 : 1;
      x.filter = `brightness(${flick})`;
      x.translate(800 + (r() - 0.5) * 60, 600 + (r() - 0.5) * 40);
      x.rotate((r() - 0.5) * 3 * Math.PI / 180);
      x.drawImage(scene, -1200 + n * 4, -800);
      const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.9));
      const u8 = new Uint8Array(await blob.arrayBuffer());
      let bin = ''; for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
      out.push(btoa(bin));
    }
    return out;
  }, N);
}

// Handaufnahmen eines Tellers: wenig Struktur, Perspektive, Zoom, Drehung, schmelzende Butter
async function makePlatePhotos(page, N) {
  return page.evaluate(async N => {
    const G = await import('./js/geometry.js');
    let s = 5; const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
    const W = 1800, H = 2400, OW = 900, OH = 1200, out = [];
    for (let n = 0; n < N; n++) {
      const sc = document.createElement('canvas'); sc.width = W; sc.height = H; const g = sc.getContext('2d');
      let s2 = 99; const r2 = () => ((s2 = (s2 * 1103515245 + 12345) >>> 0) / 4294967296);
      for (let y = 0; y < H; y++) { const v = 55 + 22 * Math.sin(y * 0.018 + Math.sin(y * 0.004) * 3) + r2() * 12; g.fillStyle = `rgb(${v + 45},${v + 18},${v - 8})`; g.fillRect(0, y, W, 1); }
      for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(30,15,5,${0.2 + r2() * 0.3})`; g.beginPath(); g.ellipse(r2() * W, r2() * H, 4 + r2() * 30, 2 + r2() * 6, r2(), 0, 7); g.fill(); }
      g.fillStyle = '#5a3a22'; g.beginPath(); g.arc(W / 2, H / 2, 820, 0, 7); g.fill();
      const grd = g.createRadialGradient(W / 2 - 120, H / 2 - 170, 60, W / 2, H / 2, 760); grd.addColorStop(0, '#ebe8e3'); grd.addColorStop(1, '#cfcac3');
      g.fillStyle = grd; g.beginPath(); g.arc(W / 2, H / 2, 750, 0, 7); g.fill();
      for (const [x, y, a] of [[620, 720, 1], [1100, 600, 2], [1300, 1300, 0.5], [850, 1650, 2.5], [720, 1250, 1.7]]) { g.save(); g.translate(x, y); g.rotate(a); g.fillStyle = '#e8d9b5'; g.beginPath(); g.ellipse(0, 0, 80, 52, 0, 0, 7); g.fill(); g.strokeStyle = '#b59a6a'; g.lineWidth = 5; g.stroke(); g.restore(); }
      const m = n * 14;
      g.fillStyle = '#f2c230'; g.beginPath(); g.moveTo(850 - m, 1000 - m); g.lineTo(1060 + m, 950); g.lineTo(1080 + m, 1180 + m); g.lineTo(870, 1230 + m); g.fill();
      const src = g.getImageData(0, 0, W, H).data;
      const rot = (r() - 0.5) * 10, zoom = 0.9 + r() * 0.2, tx = (r() - 0.5) * 180, ty = (r() - 0.5) * 220;
      const px = (r() - 0.5) * 3.2e-4, py = (r() - 0.5) * 3.2e-4, gain = 0.75 + r() * 0.5;
      let M = G.mul([W / OW, 0, 0, 0, H / OH, 0, 0, 0, 1], G.similarityAbout(OW / 2, OH / 2, tx * OW / W, ty * OH / H, rot, 1 / zoom));
      M = G.mul(M, G.mul(G.translate(OW / 2, OH / 2), G.mul([1, 0, 0, 0, 1, 0, px, py, 1], G.translate(-OW / 2, -OH / 2))));
      const oc = document.createElement('canvas'); oc.width = OW; oc.height = OH; const ox = oc.getContext('2d');
      const id = ox.createImageData(OW, OH), d = id.data;
      for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
        const [u, v] = G.apply(M, x, y), o = 4 * (y * OW + x);
        if (u >= 0 && v >= 0 && u < W - 1 && v < H - 1) {
          const x0 = u | 0, y0 = v | 0, a = u - x0, c = v - y0, i = 4 * (y0 * W + x0);
          for (let ch = 0; ch < 3; ch++) d[o + ch] = ((src[i + ch] * (1 - a) + src[i + 4 + ch] * a) * (1 - c) + (src[i + 4 * W + ch] * (1 - a) + src[i + 4 * W + 4 + ch] * a) * c) * gain + (r() - 0.5) * 6;
        }
        d[o + 3] = 255;
      }
      ox.putImageData(id, 0, 0);
      const blob = await new Promise(res => oc.toBlob(res, 'image/jpeg', 0.9));
      const u8 = new Uint8Array(await blob.arrayBuffer()); let bin = ''; for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
      out.push(btoa(bin));
    }
    return out;
  }, N);
}

async function plateScenario(browser, base, check) {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  const photos = await makePlatePhotos(page, 12);
  await page.setInputFiles('#file', photos.map((b, i) => ({ name: `IMG_${9363 + i}.jpeg`, mimeType: 'image/jpeg', buffer: Buffer.from(b, 'base64') })));
  await page.waitForFunction(() => document.querySelector('#progress').hidden, null, { timeout: 120000 });
  await page.click('#primary');
  await page.waitForFunction(() => !document.querySelector('#view-edit').hidden && document.querySelector('#progress').hidden, null, { timeout: 300000 });
  const res = await page.evaluate(() => window.__lapse.project.frames.map(f => ({ ok: f.align.ok, ex: f.excluded, ncc: f.align.ncc })));
  const good = res.filter(r => r.ok && !r.ex).length;
  check(good === res.length, `Teller aus der Hand: ${good} von ${res.length} Fotos ausgerichtet (min. Übereinstimmung ${Math.round(Math.min(...res.map(r => r.ncc ?? 1)) * 100)} %)`);
  check(!errors.length, `Teller-Szenario ohne Browserfehler${errors.length ? ': ' + errors.join(' | ') : ''}`);
}

(async () => {
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}/index.html`;
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  let failed = false;
  const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failed = true; };
  try {
    await page.goto(base);
    const photos = await makePhotos(page, 16);
    await page.setInputFiles('#file', photos.map((b, i) => ({ name: `IMG_${1000 + i}.jpg`, mimeType: 'image/jpeg', buffer: Buffer.from(b, 'base64') })));
    await page.waitForFunction(() => document.querySelector('#progress').hidden, null, { timeout: 120000 });
    check(await page.evaluate(() => window.__lapse.project.frames.length) === 16, '16 Fotos importiert');
    await page.click('#primary');
    await page.waitForFunction(() => !document.querySelector('#view-edit').hidden && document.querySelector('#progress').hidden, null, { timeout: 180000 });
    const frames = await page.evaluate(() => window.__lapse.project.frames.map(f => ({ q: f.quality, ok: f.align.ok, rms: f.align.rms, gain: f.stats ? f.color.gain[1] : 1 })));
    check(frames.every(f => f.ok && f.q === 'good'), 'alle Fotos gut ausgerichtet');
    check(Math.max(...frames.map(f => f.rms)) < 1, `Restabweichung < 1 px (max ${Math.max(...frames.map(f => f.rms)).toFixed(2)})`);
    check(frames[2].gain < 0.9 && frames[3].gain > 1.15, 'Flackern erkannt und ausgeglichen');
    await page.click('#primary');
    await page.waitForTimeout(800);
    for (const fmt of ['mp4-avc', 'webm-vp9', 'gif', 'zip']) {
      if (!(await page.$eval(`#formats input[value="${fmt}"]`, i => !i.disabled))) { console.log(`– ${fmt} in diesem Browser nicht verfügbar`); continue; }
      await page.click(`#formats input[value="${fmt}"]`);
      await page.waitForTimeout(400);
      await page.click('#primary');
      await page.waitForFunction(() => document.querySelector('#progress').hidden, null, { timeout: 300000 });
      const r = await page.evaluate(() => { const r = window.__lapse.ui.result; return r && { name: r.name, size: r.blob.size }; });
      check(r && r.size > 10000 && r.name.endsWith(fmt === 'mp4-avc' ? '.mp4' : fmt === 'webm-vp9' ? '.webm' : '.' + fmt), `Export ${fmt}: ${r ? `${r.name}, ${(r.size / 1e6).toFixed(2)} MB` : 'fehlgeschlagen'}`);
      await page.evaluate(() => { window.__lapse.ui.result = null; });
    }
    // Qualität & Dateigröße
    const exportMp4 = async () => {
      await page.click('#primary');
      await page.waitForFunction(() => document.querySelector('#progress').hidden, null, { timeout: 300000 });
      return page.evaluate(() => window.__lapse.ui.result.blob.size);
    };
    if (await page.$eval('#formats input[value="mp4-avc"]', i => !i.disabled)) {
      await page.click('#formats input[value="mp4-avc"]');
      await page.waitForTimeout(400);
      await page.click('#size-mode button[data-v="quality"]');
      await page.$eval('#q-slider', el => { el.value = 15; el.dispatchEvent(new Event('input')); });
      const small = await exportMp4();
      await page.$eval('#q-slider', el => { el.value = 90; el.dispatchEvent(new Event('input')); });
      const big = await exportMp4();
      check(big > small * 2, `Qualitätsregler wirkt (Klein ${(small / 1e6).toFixed(2)} MB < Maximal ${(big / 1e6).toFixed(2)} MB)`);
      await page.click('#size-mode button[data-v="size"]');
      await page.$eval('#s-slider', el => { el.value = 450; el.dispatchEvent(new Event('input')); });
      const target = await page.evaluate(() => window.__lapse.ui.exp.targetMB);
      const est = await page.textContent('#q-info');
      const sized = await exportMp4();
      check(sized <= target * 1e6 * 1.05, `Zielgröße eingehalten (Ziel ${target} MB, Ergebnis ${(sized / 1e6).toFixed(2)} MB; Anzeige: ${est.replace(/\s+/g, ' ')})`);
    }
    await plateScenario(browser, base, check);
    check(!errors.length, `keine Browserfehler${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } finally {
    await browser.close();
    srv.close();
  }
  process.exit(failed ? 1 : 0);
})();

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
    check(!errors.length, `keine Browserfehler${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } finally {
    await browser.close();
    srv.close();
  }
  process.exit(failed ? 1 : 0);
})();

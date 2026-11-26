// Dauerhafte Speicherung auf dem Gerät (IndexedDB): Projekt, Fotos und letztes Video.
// Nichts verlässt das Gerät. Schützt vor Verlust, wenn iOS den Tab neu lädt.

const DB_NAME = 'lapse', VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['meta', 'frames', 'blobs', 'exports']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const done = tx => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('abgebrochen')); });
const get = (store, key) => new Promise((res, rej) => { const r = store.get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// Felder eines Fotos, die gespeichert werden (ohne große Daten und abgeleitete Werte)
const FRAME_FIELDS = ['id', 'name', 'date', 'modified', 'order', 'w', 'h', 'featRes', 'align', 'autoAlign', 'manual',
  'excluded', 'autoExcluded', 'keepIncluded', 'manualChecked', 'cropOk', 'anchorPts', 'geoSupport'];

export class ProjectStore {
  constructor() { this.dbp = null; this.saved = new Set(); }
  db() { return (this.dbp ||= open()); }
  get available() { return typeof indexedDB !== 'undefined'; }

  /** Speicher möglichst vor automatischem Löschen schützen. */
  async persist() { try { return await navigator.storage?.persist?.(); } catch { return false; } }

  async save(project) {
    const db = await this.db();
    const tx = db.transaction(['meta', 'frames', 'blobs'], 'readwrite');
    const meta = tx.objectStore('meta'), frames = tx.objectStore('frames'), blobs = tx.objectStore('blobs');
    for (const f of project.frames) {
      const rec = {};
      for (const k of FRAME_FIELDS) if (f[k] !== undefined) rec[k] = f[k];
      frames.put(JSON.parse(JSON.stringify(rec, (k, v) => (v === Infinity ? 1e9 : v))), f.id);
      if (!this.saved.has(f.id)) { blobs.put({ file: f.file, preview: f.previewBlob, thumb: f.thumbBlob }, f.id); this.saved.add(f.id); }
    }
    meta.put({
      settings: project.settings, refId: project.refId, anchors: project.anchors, anchorsActive: project.anchorsActive,
      aligned: project.aligned, order: project.frames.map(f => f.id), savedAt: Date.now(),
    }, 'project');
    await done(tx);
  }

  async removeFrames(ids) {
    const db = await this.db();
    const tx = db.transaction(['frames', 'blobs'], 'readwrite');
    for (const id of ids) { tx.objectStore('frames').delete(id); tx.objectStore('blobs').delete(id); this.saved.delete(id); }
    await done(tx);
  }

  async clearProject() {
    const db = await this.db();
    const tx = db.transaction(['meta', 'frames', 'blobs'], 'readwrite');
    for (const s of ['meta', 'frames', 'blobs']) tx.objectStore(s).clear();
    this.saved.clear();
    await done(tx);
  }

  /** Kurzinfo zum gespeicherten Projekt (ohne Fotos zu laden). */
  async info() {
    const db = await this.db();
    const tx = db.transaction(['meta'], 'readonly');
    const m = await get(tx.objectStore('meta'), 'project');
    return m && m.order?.length ? { count: m.order.length, savedAt: m.savedAt, aligned: m.aligned } : null;
  }

  /** Lädt das Projekt; Rückgabe { meta, frames } mit wiederhergestellten Fotos. */
  async load() {
    const db = await this.db();
    const tx = db.transaction(['meta', 'frames', 'blobs'], 'readonly');
    const meta = await get(tx.objectStore('meta'), 'project');
    if (!meta) return null;
    const frames = [];
    for (const id of meta.order) {
      const rec = await get(tx.objectStore('frames'), id);
      const b = await get(tx.objectStore('blobs'), id);
      if (!rec || !b?.file) continue;
      if (rec.align?.inliers === 1e9) rec.align.inliers = Infinity;
      frames.push({ ...rec, file: b.file, previewBlob: b.preview, thumbBlob: b.thumb, analyzing: false });
      this.saved.add(id);
    }
    return { meta, frames };
  }

  async saveExport(res) {
    const db = await this.db();
    const tx = db.transaction(['exports'], 'readwrite');
    tx.objectStore('exports').put({ blob: res.blob, name: res.name, type: res.blob.type, w: res.w, h: res.h, duration: res.duration, createdAt: Date.now() }, 'last');
    await done(tx);
  }

  async lastExport() {
    const db = await this.db();
    const tx = db.transaction(['exports'], 'readonly');
    return get(tx.objectStore('exports'), 'last');
  }
}

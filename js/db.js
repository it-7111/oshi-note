// IndexedDB の薄いラッパー。kv: データ一式 / images: グッズ画像（キー = "シート:ID"）
const DB_NAME = 'oshi-app';
const STORES = ['kv', 'images'];
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => STORES.forEach((s) => req.result.objectStoreNames.contains(s) || req.result.createObjectStore(s));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const set = (store, key, val) => tx(store, 'readwrite', (s) => s.put(val, key));
export const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const keys = (store) => tx(store, 'readonly', (s) => s.getAllKeys());
export const clear = (store) => tx(store, 'readwrite', (s) => s.clear());

export async function getMany(store, list) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const s = t.objectStore(store);
    const out = {};
    list.forEach((k) => { s.get(k).onsuccess = (e) => { out[k] = e.target.result; }; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}

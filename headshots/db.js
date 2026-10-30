// A key/value corner of IndexedDB, so a shoot survives closing the tab.
// Holds the scan results, the corrected names and the folder handle — all of
// which stay on this device. "Forget this shoot" empties it.

const DB_NAME = "headshots";
const STORE = "kv";

let dbPromise = null;
function db() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function tx(mode, run) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const get = key => tx("readonly", s => s.get(key));
export const set = (key, value) => tx("readwrite", s => s.put(value, key));
export const del = key => tx("readwrite", s => s.delete(key));
export const clear = () => tx("readwrite", s => s.clear());

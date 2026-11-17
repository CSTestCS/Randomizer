'use strict';
/* ======================================================================
   On-device storage for builds without the Go server (Android app).
   Implements the same small REST API the desktop server provides, backed
   by IndexedDB: the library JSON, uploaded files (as Blobs) and sessions.
   ====================================================================== */
const LOCAL_MODE = /RandomizerAndroid/.test(navigator.userAgent) || new URLSearchParams(location.search).has('local');

const LocalStore = (() => {
  const urls = new Map(); // file name -> object URL
  let dbp = null;

  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('randomizer', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore('kv');
          d.createObjectStore('files');
          d.createObjectStore('sessions');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function op(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
    });
  }
  const randomName = (ext) => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('') + ext;

  return {
    // Create object URLs for every stored file so <img src> can be built synchronously.
    async init() {
      try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
      const d = await db();
      await new Promise((resolve, reject) => {
        const tx = d.transaction('files', 'readonly');
        const req = tx.objectStore('files').openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return;
          urls.set(c.key, URL.createObjectURL(c.value));
          c.continue();
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },
    url(file) { return urls.get(file) || ''; },
    async request(method, path, body) {
      const [route, query] = path.split('?');
      if (route === '/api/library') {
        if (method === 'GET') return (await op('kv', 'readonly', (s) => s.get('library'))) || { collections: [] };
        await op('kv', 'readwrite', (s) => s.put(typeof body === 'string' ? JSON.parse(body) : body, 'library'));
        return null;
      }
      if (route === '/api/images' && method === 'POST') {
        const name = new URLSearchParams(query).get('name') || '';
        const ext = (name.match(/\.[A-Za-z0-9]+$/) || ['.bin'])[0].toLowerCase();
        const file = randomName(ext);
        await op('files', 'readwrite', (s) => s.put(body, file));
        urls.set(file, URL.createObjectURL(body));
        return { file };
      }
      if (route === '/api/sessions' && method === 'GET') return (await op('sessions', 'readonly', (s) => s.getAll())) || [];
      if (route.startsWith('/api/sessions/')) {
        const id = decodeURIComponent(route.slice('/api/sessions/'.length));
        if (method === 'PUT') await op('sessions', 'readwrite', (s) => s.put(body, id));
        else if (method === 'DELETE') await op('sessions', 'readwrite', (s) => s.delete(id));
        return null;
      }
      throw new Error('Unknown request ' + method + ' ' + path);
    },
  };
})();

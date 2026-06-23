import type { WebContents } from "electron";

import type {
  CookieEntry,
  IndexedDbDatabase,
  StorageArea,
  StorageEntry,
  StorageReport,
  TabId
} from "../../../../packages/shared/src/index.js";

/**
 * Storage inspector — localStorage / sessionStorage / cookies / IndexedDB
 * reads and writes over CDP. Extracted from `TabManager` (which now delegates).
 * Each function assumes the CDP debugger is already attached to `webContents`.
 */

/** Full snapshot of all storage areas for the tab's current origin. */
export async function capture(webContents: WebContents, tabId: TabId): Promise<StorageReport> {
  const url = webContents.getURL();

  const storageResult = await webContents.debugger.sendCommand("Runtime.evaluate", {
    expression: `(function() {
      function dump(store) {
        var out = [];
        for (var i = 0; i < store.length; i++) {
          var k = store.key(i);
          var v = store.getItem(k) ?? '';
          out.push({ key: k, value: v, bytes: k.length + v.length });
        }
        return out;
      }
      return { local: dump(localStorage), session: dump(sessionStorage) };
    })()`,
    returnByValue: true,
    awaitPromise: false
  }) as { result: { value: { local: StorageEntry[]; session: StorageEntry[] } } };

  const cookieResult = await webContents.debugger.sendCommand("Network.getCookies", {
    urls: [url]
  }) as { cookies: Array<{
    name: string; value: string; domain: string; path: string;
    expires: number; httpOnly: boolean; secure: boolean;
    sameSite?: string; size: number;
  }> };

  const cookies: CookieEntry[] = (cookieResult.cookies ?? []).map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires === -1 ? null : c.expires * 1000,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: (c.sameSite ?? "") as CookieEntry["sameSite"],
    size: c.size
  }));

  const idbResult = await webContents.debugger.sendCommand("Runtime.evaluate", {
    expression: `(async function() {
      async function getDbs() {
        var dbs = await indexedDB.databases();
        var result = [];
        for (var dbInfo of dbs) {
          try {
            var db = await new Promise(function(resolve, reject) {
              var req = indexedDB.open(dbInfo.name, dbInfo.version);
              req.onsuccess = function() { resolve(req.result); };
              req.onerror = reject;
            });
            var stores = [];
            for (var storeName of Array.from(db.objectStoreNames)) {
              try {
                var tx = db.transaction(storeName, 'readonly');
                var store = tx.objectStore(storeName);
                var count = await new Promise(function(res, rej) {
                  var r = store.count(); r.onsuccess = function() { res(r.result); }; r.onerror = rej;
                });
                var rows = await new Promise(function(res, rej) {
                  var r = store.openCursor(); var out = [];
                  r.onsuccess = function(e) {
                    var cursor = e.target.result;
                    if (cursor && out.length < 100) {
                      try { out.push({ key: String(cursor.key), value: JSON.stringify(cursor.value) }); } catch(_) { out.push({ key: String(cursor.key), value: '[unserializable]' }); }
                      cursor.continue();
                    } else { res(out); }
                  };
                  r.onerror = rej;
                });
                stores.push({
                  name: storeName,
                  keyPath: store.keyPath,
                  autoIncrement: store.autoIncrement,
                  count: count,
                  rows: rows
                });
              } catch(e) { stores.push({ name: storeName, keyPath: null, autoIncrement: false, count: 0, rows: [] }); }
            }
            db.close();
            result.push({ name: dbInfo.name, version: dbInfo.version || 1, objectStores: stores });
          } catch(e) { result.push({ name: dbInfo.name, version: dbInfo.version || 1, objectStores: [] }); }
        }
        return result;
      }
      return getDbs();
    })()`,
    returnByValue: true,
    awaitPromise: true
  }) as { result: { value: IndexedDbDatabase[] } };

  const local: StorageEntry[] = storageResult.result.value?.local ?? [];
  const session: StorageEntry[] = storageResult.result.value?.session ?? [];
  const idb: IndexedDbDatabase[] = idbResult.result.value ?? [];

  const totalBytes =
    local.reduce((s, e) => s + e.bytes, 0) +
    session.reduce((s, e) => s + e.bytes, 0) +
    cookies.reduce((s, c) => s + c.size, 0);

  return { tabId, url, capturedAt: Date.now(), localStorage: local, sessionStorage: session, cookies, indexedDb: idb, totalBytes };
}

/** Read all entries (or a single key) from localStorage or sessionStorage. */
export async function read(webContents: WebContents, area: StorageArea, key?: string): Promise<StorageEntry[]> {
  const storeName = area === "local" ? "localStorage" : "sessionStorage";

  const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
    expression: key
      ? `(function(){var v=${storeName}.getItem(${JSON.stringify(key)});return v===null?null:[{key:${JSON.stringify(key)},value:v,bytes:${JSON.stringify(key)}.length+v.length}];})()`
      : `(function(){var out=[];for(var i=0;i<${storeName}.length;i++){var k=${storeName}.key(i);var v=${storeName}.getItem(k)??"";out.push({key:k,value:v,bytes:k.length+v.length});}return out;})()`,
    returnByValue: true,
    awaitPromise: false
  }) as { result: { value: StorageEntry[] | null } };

  return result.result.value ?? [];
}

/** Set one or more key/value pairs in localStorage or sessionStorage. */
export async function write(webContents: WebContents, area: StorageArea, entries: Record<string, string>): Promise<void> {
  const storeName = area === "local" ? "localStorage" : "sessionStorage";
  const pairs = Object.entries(entries)
    .map(([k, v]) => `${storeName}.setItem(${JSON.stringify(k)},${JSON.stringify(v)})`)
    .join(";");

  await webContents.debugger.sendCommand("Runtime.evaluate", {
    expression: `(function(){${pairs}})()`,
    returnByValue: false,
    awaitPromise: false
  });
}

/** Remove specific keys or clear the entire area. */
export async function clear(webContents: WebContents, area: StorageArea, keys?: string[]): Promise<void> {
  const storeName = area === "local" ? "localStorage" : "sessionStorage";
  const expr = keys && keys.length
    ? `(function(){${keys.map(k => `${storeName}.removeItem(${JSON.stringify(k)})`).join(";")};})()`
    : `${storeName}.clear()`;

  await webContents.debugger.sendCommand("Runtime.evaluate", {
    expression: expr,
    returnByValue: false,
    awaitPromise: false
  });
}

/** Set (upsert) a cookie. Defaults to the tab's current origin. */
export async function setCookie(webContents: WebContents, cookie: Partial<CookieEntry> & { name: string; value: string }): Promise<void> {
  const url = webContents.getURL();
  await webContents.debugger.sendCommand("Network.setCookie", {
    url,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? "/",
    httpOnly: cookie.httpOnly ?? false,
    secure: cookie.secure ?? false,
    sameSite: cookie.sameSite || undefined,
    expires: cookie.expires != null ? Math.floor(cookie.expires / 1000) : undefined
  });
}

/** Delete a cookie by name (and optionally a target URL). */
export async function deleteCookie(webContents: WebContents, name: string, url?: string): Promise<void> {
  await webContents.debugger.sendCommand("Network.deleteCookies", {
    name,
    url: url ?? webContents.getURL()
  });
}

/** Clear all cookies for the tab's current origin (or a given URL). */
export async function clearCookies(webContents: WebContents, url?: string): Promise<void> {
  const targetUrl = url ?? webContents.getURL();
  const res = await webContents.debugger.sendCommand("Network.getCookies", { urls: [targetUrl] }) as { cookies: Array<{ name: string }> };
  for (const c of (res.cookies ?? [])) {
    await webContents.debugger.sendCommand("Network.deleteCookies", { name: c.name, url: targetUrl });
  }
}

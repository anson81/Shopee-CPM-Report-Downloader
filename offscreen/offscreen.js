/**
 * Writes a report straight into the folder the seller chose.
 *
 * WHY THIS FILE EXISTS AT ALL.
 *
 * `chrome.downloads.download({filename})` only REQUESTS a name. Any other
 * installed extension holding the "downloads" permission can override it from
 * onDeterminingFilename, and Chrome settles the tie by install recency — the
 * last extension installed whose listener passes a suggestion wins.
 *
 * So the winner changes whenever some unrelated extension updates itself in
 * the background. On 23 Aug 2026 this extension answered Chrome synchronously,
 * on a warm worker, with the correct path for five consecutive reports — its
 * own log records "placed at Shopee daily report/…/Order.all….xlsx" for each —
 * and every one of them still landed in plain Downloads under Chrome's own
 * name. The retry lost too: downloads.download() was called with the full path
 * attached and Chrome produced "download (4).csv".
 *
 * There is no way to win that contest reliably, so this stops entering it. A
 * file written through a FileSystemDirectoryHandle never touches Chrome's
 * download naming, and no other extension is consulted.
 *
 * The File System Access API needs a document, and an MV3 service worker is
 * not one — hence an offscreen document rather than doing this in
 * background.js.
 */

const DB_NAME = 'shopee-dl-updater';
const STORE = 'handles';
/** Where reports go. Deliberately NOT the key the self-updater uses. */
const OUTPUT_KEY = 'outputFolder';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Walks (and creates) a folder path under the chosen root.
 *
 * Empty segments are dropped rather than passed through: getDirectoryHandle('')
 * throws, and a blank segment in a built path is an easy mistake to make — the
 * download route shipped exactly that bug as "Shopee daily report//report.xlsx".
 */
async function folderFor(root, segments) {
  let dir = root;
  for (const part of (segments || []).filter(Boolean)) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

function bytesFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Reports why it could not write, rather than just failing.
 *
 * 'no-folder' and 'permission' are worth telling apart: both are settled on
 * the Options page and neither is a bug.
 */
async function write({ segments, filename, base64, probe }) {
  const root = await idbGet(OUTPUT_KEY);
  if (!root) return { ok: false, reason: 'no-folder' };

  // requestPermission() needs a user gesture and there is none here, so this
  // can only ever check. The Options page re-grants it.
  const granted = await root.queryPermission({ mode: 'readwrite' });
  if (granted !== 'granted') return { ok: false, reason: 'permission' };

  // A probe asks only "could you write?" — it must not create anything. The
  // popup asks this before every run, and a probe that left an empty folder
  // behind would litter one per popup open.
  if (probe) return { ok: true, path: '' };

  const dir = await folderFor(root, segments);
  const handle = await dir.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytesFromBase64(base64));
  } finally {
    // Closing is what commits the file. Skipping it on a failed write would
    // leave a zero-byte file that looks like a successful save.
    await writable.close();
  }

  return { ok: true, path: `${(segments || []).filter(Boolean).join('/')}/${filename}` };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Returning undefined is what tells Chrome we are not answering. Returning
  // true and never calling back would hang the sender for ever.
  if (!msg || msg.target !== 'offscreen-writer') return undefined;

  write(msg)
    .then(sendResponse)
    .catch((err) =>
      sendResponse({ ok: false, reason: 'error', error: (err && err.message) || String(err) })
    );
  return true;
});

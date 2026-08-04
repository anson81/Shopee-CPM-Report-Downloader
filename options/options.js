/**
 * Options page: update checking and installation.
 *
 * An unpacked extension cannot rewrite its own files through any chrome.* API,
 * so the install path uses the File System Access API instead: the user grants
 * this page a handle to the extension folder once, and it writes the new files
 * there directly, then calls chrome.runtime.reload().
 *
 * The picker cannot be opened from the toolbar popup (opening a file dialog
 * closes it), which is why all of this lives on a full page.
 */
'use strict';

const el = {
  version: document.getElementById('version'),
  status: document.getElementById('status'),
  notes: document.getElementById('notes'),
  check: document.getElementById('check'),
  install: document.getElementById('install'),
  progress: document.getElementById('progress'),
  folderStatus: document.getElementById('folder-status'),
  pickFolder: document.getElementById('pick-folder'),
  forgetFolder: document.getElementById('forget-folder'),
  owner: document.getElementById('owner'),
  repo: document.getElementById('repo'),
  branch: document.getElementById('branch'),
  saveSource: document.getElementById('save-source'),
  sourceSaved: document.getElementById('source-saved')
};

let latest = null; // last successful check result

/* ------------------------------------------------------------------ *
 * Directory handle storage. Handles are structured-clonable but not
 * JSON-serialisable, so chrome.storage cannot hold them — IndexedDB can.
 * ------------------------------------------------------------------ */
const DB_NAME = 'shopee-dl-updater';
const STORE = 'handles';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/* ------------------------------------------------------------------ *
 * UI helpers
 * ------------------------------------------------------------------ */
function setStatus(node, text, kind) {
  node.textContent = text;
  node.className = `status${kind ? ' ' + kind : ''}`;
}

function log(line) {
  el.progress.hidden = false;
  el.progress.textContent += `${line}\n`;
  el.progress.scrollTop = el.progress.scrollHeight;
}

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/* ------------------------------------------------------------------ *
 * Update source
 * ------------------------------------------------------------------ */
async function loadSource() {
  const { updateSource } = await chrome.storage.local.get('updateSource');
  if (!updateSource) return null;
  el.owner.value = updateSource.owner || '';
  el.repo.value = updateSource.repo || '';
  el.branch.value = updateSource.branch || 'main';
  return updateSource;
}

el.saveSource.addEventListener('click', async () => {
  const owner = el.owner.value.trim();
  const repo = el.repo.value.trim();
  const branch = el.branch.value.trim() || 'main';
  if (!owner || !repo) {
    setStatus(el.status, 'Enter both the GitHub owner and repo name.', 'err');
    return;
  }
  await chrome.storage.local.set({ updateSource: { owner, repo, branch } });
  await chrome.storage.local.remove('updateCache');
  el.sourceSaved.hidden = false;
  setTimeout(() => (el.sourceSaved.hidden = true), 2000);
  checkForUpdate(true);
});

/* ------------------------------------------------------------------ *
 * Folder access
 * ------------------------------------------------------------------ */
async function handlePermission(handle, request) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!request) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

/** Refuse to write into anything that is not this extension's folder. */
async function verifyFolder(handle) {
  let file;
  try {
    file = await (await handle.getFileHandle('manifest.json')).getFile();
  } catch (_) {
    return 'That folder has no manifest.json — pick the folder you chose with "Load unpacked".';
  }
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed.name !== chrome.runtime.getManifest().name) {
      return `That folder holds "${parsed.name}", not this extension.`;
    }
  } catch (_) {
    return 'That folder\'s manifest.json could not be read.';
  }
  return null;
}

async function refreshFolderStatus() {
  const handle = await idbGet('extensionDir');
  if (!handle) {
    setStatus(el.folderStatus, 'Not granted yet.', 'warn');
    el.forgetFolder.hidden = true;
    el.pickFolder.textContent = 'Choose the extension folder…';
    return null;
  }
  const granted = await handlePermission(handle, false);
  setStatus(
    el.folderStatus,
    granted
      ? `Granted: ${handle.name}`
      : `Granted earlier (${handle.name}) — Chrome will ask again on first write.`,
    granted ? 'ok' : 'warn'
  );
  el.forgetFolder.hidden = false;
  el.pickFolder.textContent = 'Choose a different folder…';
  return handle;
}

el.pickFolder.addEventListener('click', async () => {
  if (!window.showDirectoryPicker) {
    setStatus(el.folderStatus, 'This Chrome build has no directory picker.', 'err');
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (_) {
    return; // user cancelled
  }
  const problem = await verifyFolder(handle);
  if (problem) {
    setStatus(el.folderStatus, problem, 'err');
    return;
  }
  if (!(await handlePermission(handle, true))) {
    setStatus(el.folderStatus, 'Write permission was declined.', 'err');
    return;
  }
  await idbSet('extensionDir', handle);
  await refreshFolderStatus();
});

el.forgetFolder.addEventListener('click', async () => {
  await idbDelete('extensionDir');
  await refreshFolderStatus();
});

/* ------------------------------------------------------------------ *
 * Checking
 * ------------------------------------------------------------------ */
function renderNotes(notes) {
  el.notes.innerHTML = '';
  if (!notes || !notes.length) {
    el.notes.hidden = true;
    return;
  }
  for (const note of notes) {
    const li = document.createElement('li');
    li.textContent = note;
    el.notes.appendChild(li);
  }
  el.notes.hidden = false;
}

async function checkForUpdate(force) {
  el.check.disabled = true;
  setStatus(el.status, 'Checking…');
  const res = await send({ type: 'checkUpdate', force: !!force });
  el.check.disabled = false;

  el.version.textContent = `v${(res && res.current) || '?'}`;

  if (!res || !res.ok) {
    setStatus(el.status, (res && res.error) || 'Check failed.', 'err');
    renderNotes([]);
    el.install.hidden = true;
    return;
  }
  if (!res.configured) {
    setStatus(el.status, 'No update source set yet — add your GitHub repo below.', 'warn');
    renderNotes([]);
    el.install.hidden = true;
    return;
  }

  latest = res;
  if (res.hasUpdate) {
    setStatus(el.status, `Update available: v${res.latest} (you have v${res.current}).`, 'warn');
    renderNotes(res.notes);
    el.install.hidden = false;
  } else {
    setStatus(el.status, `You are on the latest version (v${res.current}).`, 'ok');
    renderNotes([]);
    el.install.hidden = true;
  }
}

el.check.addEventListener('click', () => checkForUpdate(true));

/* ------------------------------------------------------------------ *
 * Installing
 * ------------------------------------------------------------------ */
async function writeFile(dirHandle, relPath, contents) {
  const parts = relPath.split('/').filter(Boolean);
  const name = parts.pop();
  let dir = dirHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(contents);
  await writable.close();
}

el.install.addEventListener('click', async () => {
  if (!latest || !latest.files || !latest.files.length) {
    setStatus(el.status, 'update.json lists no files to fetch.', 'err');
    return;
  }

  const handle = await idbGet('extensionDir');
  if (!handle) {
    setStatus(el.status, 'Grant access to the extension folder first (below).', 'err');
    return;
  }
  if (!(await handlePermission(handle, true))) {
    setStatus(el.status, 'Write permission was declined.', 'err');
    return;
  }

  el.install.disabled = true;
  el.check.disabled = true;
  el.progress.textContent = '';

  const cfg = await loadSource();
  const branch = (cfg && cfg.branch) || 'main';
  const base = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${branch}/`;

  try {
    // Fetch EVERYTHING first. A half-written extension folder will not load,
    // so nothing touches the disk until every file is in hand.
    const fetched = [];
    for (const file of latest.files) {
      log(`fetching ${file}`);
      const res = await fetch(`${base}${file}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
      fetched.push({ file, blob: await res.blob() });
    }

    // The new manifest must at least parse, and must be this extension.
    const manifestEntry = fetched.find((f) => f.file === 'manifest.json');
    if (manifestEntry) {
      const parsed = JSON.parse(await manifestEntry.blob.text());
      if (parsed.name !== chrome.runtime.getManifest().name) {
        throw new Error('the downloaded manifest.json is for a different extension');
      }
      log(`downloaded manifest declares v${parsed.version}`);
    }

    log(`writing ${fetched.length} files…`);
    for (const { file, blob } of fetched) {
      await writeFile(handle, file, blob);
      log(`wrote ${file}`);
    }

    setStatus(el.status, `Installed v${latest.latest}. Reloading the extension…`, 'ok');
    log('reloading extension');
    await chrome.storage.local.remove('updateCache');
    setTimeout(() => chrome.runtime.reload(), 800);
  } catch (e) {
    el.install.disabled = false;
    el.check.disabled = false;
    const message = (e && e.message) || String(e);
    log(`FAILED: ${message}`);
    setStatus(
      el.status,
      `Update failed: ${message}. Nothing was changed unless a "wrote" line appears above.`,
      'err'
    );
  }
});

/* ------------------------------------------------------------------ */
(async function init() {
  el.version.textContent = `v${chrome.runtime.getManifest().version}`;
  await loadSource();
  await refreshFolderStatus();
  await checkForUpdate(false);
})();

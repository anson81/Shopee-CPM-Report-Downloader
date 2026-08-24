# Reports Folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write Shopee report files straight into a folder the seller picks, so Chrome's download naming — which any other extension can override — is never involved.

**Architecture:** An offscreen document holds a `FileSystemDirectoryHandle` from IndexedDB and writes bytes into `<chosen>/Shopee daily report/<DDMMYYYY-Day-HHMM>/`. The service worker sends it base64 and folder segments. `chrome.downloads.onDeterminingFilename` is removed entirely. With no fallback to Downloads, a run refuses to start unless the folder is usable.

**Tech Stack:** Chrome MV3, plain JavaScript, no build step. File System Access API, IndexedDB, `chrome.offscreen`. Tests are Node scripts run with `node tools/test-<name>.js`, booting the shipped source in a `vm` sandbox against a stub `chrome`.

Spec: `docs/superpowers/specs/2026-08-24-reports-folder-design.md`

---

## Background the engineer needs

**Why not just pass `filename` to `chrome.downloads.download()`?** It has been tried and it loses. `onDeterminingFilename` is browser-wide, and Chrome gives the final word to the most recently installed extension that answers. On 23 Aug 2026 this extension answered synchronously with the correct path for reports 6–10 and every file still landed in `~/Downloads`. Read `CLAUDE.md` — that code has the worst history in the repo.

**Why an offscreen document?** The File System Access API needs a document. An MV3 service worker is not one. `sitegiant-downloader/offscreen/offscreen.js` is the working precedent; read it before Task 1.

**Never `New-Item -Force` on a file** and never `mkdir` the scratchpad — irrelevant here, but the repo has no build step, so every file you write ships as-is.

## File structure

| File | Responsibility |
|---|---|
| `offscreen/offscreen.html` | Empty host page for the writer script. |
| `offscreen/offscreen.js` | **New.** Owns the directory handle and all disk writes. Knows nothing about reports. |
| `background/background.js` | Modify. Routes saves to the writer, gates the run on folder readiness, no longer registers a filename listener. |
| `options/options.js`, `options.html` | Modify. Reports-folder section: choose, show, forget, re-grant. |
| `popup/popup.js`, `popup.html` | Modify. Settings button, no-folder banner, run disabled without a folder. |
| `content/content.js` | Modify. Prefer captured bytes over Chrome's own download. |
| `tools/test-folder-writer.js` | **New.** Covers `offscreen.js` against stubs. |
| `tools/test-realtime-pin.js` | **New.** Covers the pin clearing itself. |
| `tools/test-filename-listener.js` | **Delete** with the code it covers. |

---

## Task 1: The offscreen writer

**Files:**
- Create: `offscreen/offscreen.html`
- Create: `offscreen/offscreen.js`
- Test: `tools/test-folder-writer.js`

- [ ] **Step 1: Read the precedent**

Read `../sitegiant-downloader/offscreen/offscreen.js` end to end. This task ports it. Do not paraphrase from memory — the comments in it record two shipped bugs.

- [ ] **Step 2: Write the failing test**

Create `tools/test-folder-writer.js`:

```js
/**
 * Unit tests for offscreen/offscreen.js.
 *
 * The writer is the only thing standing between a captured report and the
 * seller's disk, and it runs in a context no other test touches. Booted here
 * in a vm sandbox with a stub indexedDB and a stub chrome, so every branch is
 * reachable without a browser.
 *
 * Run: node tools/test-folder-writer.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** A directory handle that records what was asked of it. */
function fakeDir(log, name) {
  return {
    name,
    children: {},
    async getDirectoryHandle(part, opts) {
      log.push(`dir:${part}:${opts && opts.create ? 'create' : 'plain'}`);
      const child = fakeDir(log, part);
      this.children[part] = child;
      return child;
    },
    async getFileHandle(file, opts) {
      log.push(`file:${file}:${opts && opts.create ? 'create' : 'plain'}`);
      return {
        async createWritable() {
          return {
            async write(bytes) {
              log.push(`write:${bytes.length}`);
            },
            async close() {
              log.push('close');
            }
          };
        }
      };
    },
    async queryPermission() {
      return 'granted';
    }
  };
}

function boot({ root = undefined } = {}) {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'offscreen', 'offscreen.js'),
    'utf8'
  );
  let listener = null;
  const sandbox = {
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    Uint8Array,
    console,
    // The writer only ever reads one key, so the store is a single value.
    indexedDB: {
      open() {
        const req = {};
        setTimeout(() => {
          req.result = {
            objectStoreNames: { contains: () => true },
            transaction: () => ({
              objectStore: () => ({
                get() {
                  const r = {};
                  setTimeout(() => {
                    r.result = root;
                    r.onsuccess && r.onsuccess();
                  }, 0);
                  return r;
                }
              })
            })
          };
          req.onsuccess && req.onsuccess();
        }, 0);
        return req;
      }
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            listener = fn;
          }
        }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    send: (msg) =>
      new Promise((resolve) => {
        listener(msg, null, resolve);
      })
  };
}

const MSG = {
  target: 'offscreen-writer',
  segments: ['Shopee daily report', '23082026-Sunday-1418'],
  filename: 'Order.all.20260723_20260821.xlsx',
  base64: Buffer.from('hello').toString('base64')
};

test('writes into the nested folders, in order', async () => {
  const log = [];
  const { send } = boot({ root: fakeDir(log, 'Documents') });
  const reply = await send(MSG);

  assert.strictEqual(reply.ok, true);
  assert.deepStrictEqual(log, [
    'dir:Shopee daily report:create',
    'dir:23082026-Sunday-1418:create',
    'file:Order.all.20260723_20260821.xlsx:create',
    'write:5',
    'close'
  ]);
});

test('keeps the filename exactly as given', async () => {
  const log = [];
  const { send } = boot({ root: fakeDir(log, 'Documents') });
  await send({ ...MSG, filename: 'Shop+GMV+MAX-Detail-Data-23_08_2026.csv' });

  assert.ok(
    log.includes('file:Shop+GMV+MAX-Detail-Data-23_08_2026.csv:create'),
    'the original name must reach disk untouched: ' + log.join(', ')
  );
});

test('drops empty segments rather than passing them on', async () => {
  const log = [];
  const { send } = boot({ root: fakeDir(log, 'Documents') });
  // getDirectoryHandle('') throws, and a blank segment is an easy mistake to
  // make when a run folder is not known yet.
  await send({ ...MSG, segments: ['Shopee daily report', '', null] });

  assert.ok(!log.some((l) => l.startsWith('dir::')), 'empty segment was passed through');
});

test('no folder chosen is reported, not thrown', async () => {
  const { send } = boot({ root: undefined });
  const reply = await send(MSG);

  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.reason, 'no-folder');
});

test('a lapsed permission is reported, and nothing is written', async () => {
  const log = [];
  const root = fakeDir(log, 'Documents');
  root.queryPermission = async () => 'prompt';
  const { send } = boot({ root });
  const reply = await send(MSG);

  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.reason, 'permission');
  assert.deepStrictEqual(log, [], 'nothing may be written without permission');
});

test('close() still runs when write() throws', async () => {
  const log = [];
  const root = fakeDir(log, 'Documents');
  root.getFileHandle = async () => ({
    async createWritable() {
      return {
        async write() {
          throw new Error('disk full');
        },
        async close() {
          log.push('close');
        }
      };
    }
  });
  const { send } = boot({ root });
  const reply = await send(MSG);

  // Skipping close() leaves a zero-byte file that looks like a success.
  assert.ok(log.includes('close'), 'close() must run even on a failed write');
  assert.strictEqual(reply.ok, false);
});

test('says nothing about messages addressed elsewhere', async () => {
  const { send } = boot({ root: fakeDir([], 'Documents') });
  let answered = false;
  const listenerResult = await Promise.race([
    send({ target: 'someone-else' }).then(() => {
      answered = true;
    }),
    new Promise((r) => setTimeout(() => r('no answer'), 50))
  ]);

  assert.strictEqual(listenerResult, 'no answer');
  assert.strictEqual(answered, false);
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
node tools/test-folder-writer.js
```

Expected: fails at `boot()` — `ENOENT ... offscreen/offscreen.js`.

- [ ] **Step 4: Create `offscreen/offscreen.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Shopee Report Downloader — writer</title>
  </head>
  <body>
    <script src="offscreen.js"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `offscreen/offscreen.js`**

```js
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
 * the background. On 23 Aug 2026 this extension answered Chrome synchronously
 * with the correct path for five consecutive reports and every one of them
 * still landed in plain Downloads under Chrome's own name.
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
 * throws, and a blank segment in a built path is an easy mistake to make.
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
async function write({ segments, filename, base64 }) {
  const root = await idbGet(OUTPUT_KEY);
  if (!root) return { ok: false, reason: 'no-folder' };

  // requestPermission() needs a user gesture and there is none here, so this
  // can only ever check. Options re-grants it.
  const granted = await root.queryPermission({ mode: 'readwrite' });
  if (granted !== 'granted') return { ok: false, reason: 'permission' };

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
  if (!msg || msg.target !== 'offscreen-writer') return undefined;

  write(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, reason: 'error', error: err?.message || String(err) }));
  return true;
});
```

- [ ] **Step 6: Run the test until it passes**

```bash
node tools/test-folder-writer.js
```

Expected: all seven tests pass.

- [ ] **Step 7: Add `offscreen` to the manifest**

In `manifest.json`, add `"offscreen"` to `permissions`, keeping the list alphabetical:

```json
  "permissions": [
    "activeTab",
    "clipboardWrite",
    "downloads",
    "offscreen",
    "scripting",
    "storage",
    "tabs"
  ],
```

`downloads` stays — the run still reads Chrome's download record to notice strays.

- [ ] **Step 8: Commit**

```bash
git add offscreen tools/test-folder-writer.js manifest.json
git commit -m "Write files through a directory handle, not Chrome's downloads"
```

---

## Task 2: Choosing the folder in Options

**Files:**
- Modify: `options/options.html:26-38`
- Modify: `options/options.js`

- [ ] **Step 1: Add the section to `options.html`**

Insert immediately after `<main>` opens, **above** the Updates card — it is the setting that stops the extension working when unset, so it comes first:

```html
      <section class="card">
        <h2>Reports folder</h2>
        <p class="hint">
          Where your reports are saved. Pick it once on this computer.
          Reports are written straight into it, so no other extension can
          rename them or move them somewhere else.
        </p>
        <div id="output-status" class="status">No folder chosen yet.</div>
        <div class="row">
          <button id="pick-output" class="primary">Choose folder&hellip;</button>
          <button id="forget-output" hidden>Forget it</button>
        </div>
      </section>
```

- [ ] **Step 2: Add the key and the element refs to `options.js`**

Beside the existing `DB_NAME` / `STORE` constants (`options/options.js:43`):

```js
/** The self-updater's grant. Separate from the reports folder on purpose. */
const HANDLE_KEY = 'extensionFolder';
/** Where reports go. Revocable without touching the updater's grant. */
const OUTPUT_KEY = 'outputFolder';
```

If `HANDLE_KEY` already exists under another name, keep the existing name and add only `OUTPUT_KEY`.

- [ ] **Step 3: Add the handlers**

```js
const outputStatus = document.getElementById('output-status');
const pickOutput = document.getElementById('pick-output');
const forgetOutput = document.getElementById('forget-output');

/**
 * Shows what is chosen, and whether Chrome still lets us write to it.
 *
 * A handle survives a browser restart but its permission does not always come
 * back with it. Saying "chosen" when writes would fail is the kind of quiet
 * wrongness this extension has already shipped once.
 */
async function refreshOutputFolder() {
  const handle = await idbGet(OUTPUT_KEY).catch(() => null);
  if (!handle) {
    outputStatus.textContent = 'No folder chosen yet — reports cannot be saved.';
    outputStatus.className = 'status warn';
    forgetOutput.hidden = true;
    return;
  }

  const granted = await handle.queryPermission({ mode: 'readwrite' });
  if (granted === 'granted') {
    outputStatus.textContent = `Saving reports to: ${handle.name}`;
    outputStatus.className = 'status ok';
  } else {
    outputStatus.textContent =
      `Chosen: ${handle.name} — but Chrome needs you to allow it again. ` +
      'Click Choose folder and pick the same one.';
    outputStatus.className = 'status warn';
  }
  forgetOutput.hidden = false;
}

pickOutput.addEventListener('click', async () => {
  if (!window.showDirectoryPicker) {
    outputStatus.textContent = 'This browser cannot pick a folder.';
    return;
  }
  let chosen;
  try {
    chosen = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (_) {
    return; // the user closed the picker
  }
  await idbSet(OUTPUT_KEY, chosen);
  await refreshOutputFolder();
});

forgetOutput.addEventListener('click', async () => {
  await idbDelete(OUTPUT_KEY);
  await refreshOutputFolder();
});
```

- [ ] **Step 4: Call it on load**

Find where the page initialises (the same place `refreshFolder()` or equivalent is called for the extension folder) and add `refreshOutputFolder();` beside it.

- [ ] **Step 5: Load the extension and check by hand**

Load unpacked in Chrome, open Options, click **Choose folder…**, pick `Documents`. Reload the page.

Expected: `Saving reports to: Documents`.

- [ ] **Step 6: Commit**

```bash
git add options
git commit -m "Let the seller choose where reports are saved"
```

---

## Task 3: Route every save through the folder

**Files:**
- Modify: `background/background.js` — `targetDir()` (~line 279), `saveFile()` (~line 932), `runExports()` (~line 1652)

- [ ] **Step 1: Replace `targetDir()` with `folderSegments()`**

Delete `targetDir()` and put this in its place. Note the layout change: the day folder is gone, per the design.

```js
/**
 * The folders this run writes into, beneath the folder the seller chose — or
 * null when the run folder is not known yet.
 *
 * Callers must handle null rather than build a path out of it. Writing to the
 * wrong folder is worse than saying the folder is not known.
 */
function folderSegments() {
  if (!state.runFolder) return null;
  return [ROOT_FOLDER, state.runFolder];
}

/** For messages to the user: "Shopee daily report/23082026-Sunday-1418". */
function targetDir() {
  const segments = folderSegments();
  return segments ? segments.join('/') : null;
}
```

- [ ] **Step 2: Add the offscreen plumbing**

Above `saveFile()`:

```js
/* ------------------------------------------------------------------ *
 * Writing the file ourselves
 *
 * See offscreen/offscreen.js for why the download route was abandoned. There
 * is no fallback to chrome.downloads here on purpose: a file landing quietly
 * in Downloads under Chrome's own name is the exact failure this replaced.
 * ------------------------------------------------------------------ */
let offscreenReady = null;

async function ensureOffscreen() {
  // createDocument() throws if one already exists and there is no
  // get-or-create, so asking Chrome what is open is the only race-free way.
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;

  if (!offscreenReady) {
    offscreenReady = chrome.offscreen
      .createDocument({
        url: 'offscreen/offscreen.html',
        // The nearest true reason Chrome offers. There is no "FILE_SYSTEM".
        reasons: ['BLOBS'],
        justification: 'Write report files into the folder the seller chose'
      })
      .finally(() => {
        offscreenReady = null;
      });
  }
  await offscreenReady;
}

/** Plain-English wording for each way the folder can be unusable. */
const FOLDER_TROUBLE = {
  'no-folder':
    'No folder has been chosen yet. Open Settings and pick where reports should be saved.',
  permission:
    'Chrome needs you to allow the reports folder again. Open Settings and choose the same folder.',
  error: 'The reports folder could not be written to.'
};

/**
 * Can this run save anything at all? Asked BEFORE a run starts, so a run that
 * cannot save never opens ten tabs and never touches Shopee.
 */
async function folderReady() {
  try {
    await ensureOffscreen();
    const reply = await chrome.runtime.sendMessage({
      target: 'offscreen-writer',
      probe: true,
      segments: [],
      filename: '',
      base64: ''
    });
    if (reply && reply.ok) return { ok: true };
    const reason = (reply && reply.reason) || 'error';
    return { ok: false, reason, error: FOLDER_TROUBLE[reason] || FOLDER_TROUBLE.error };
  } catch (e) {
    return {
      ok: false,
      reason: 'error',
      error: 'The reports folder could not be opened: ' + ((e && e.message) || e)
    };
  }
}
```

- [ ] **Step 3: Teach the writer to answer a probe**

`folderReady()` must not create a file. In `offscreen/offscreen.js`, change `write()`'s signature to take `probe` and return early — after the permission check, before `folderFor()`:

```js
async function write({ segments, filename, base64, probe }) {
  const root = await idbGet(OUTPUT_KEY);
  if (!root) return { ok: false, reason: 'no-folder' };

  // requestPermission() needs a user gesture and there is none here, so this
  // can only ever check. Options re-grants it.
  const granted = await root.queryPermission({ mode: 'readwrite' });
  if (granted !== 'granted') return { ok: false, reason: 'permission' };

  // A probe asks only "could you write?" — it must not create anything.
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
```

The rest of the function is unchanged from Task 1 Step 5.

- [ ] **Step 4: Add the probe test**

Append to `tools/test-folder-writer.js`:

```js
test('a probe checks permission without creating anything', async () => {
  const log = [];
  const { send } = boot({ root: fakeDir(log, 'Documents') });
  const reply = await send({ target: 'offscreen-writer', probe: true, segments: [], filename: '' });

  assert.strictEqual(reply.ok, true);
  assert.deepStrictEqual(log, [], 'a probe must not touch the disk');
});

test('a probe still fails when no folder is chosen', async () => {
  const { send } = boot({ root: undefined });
  const reply = await send({ target: 'offscreen-writer', probe: true, segments: [], filename: '' });

  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.reason, 'no-folder');
});
```

Run: `node tools/test-folder-writer.js` — expected: nine tests pass.

- [ ] **Step 5: Rewrite `saveFile()`**

Replace the whole function (`background/background.js:932-1042`) with:

```js
/**
 * Save a captured report into the run folder.
 *
 * `dataUrl` is a data: URL from the content script; the writer needs the
 * base64 payload alone.
 */
async function saveFile(dataUrl, filename) {
  if (!dataUrl || !dataUrl.startsWith('data:')) {
    return { ok: false, error: 'Nothing to save — the captured file was empty.' };
  }
  const name = basename(filename) || 'shopee-report';

  // Wait for the run folder rather than guessing at it. On a worker Chrome
  // restarted mid-run this field is empty until hydration finishes.
  if (!folderSegments()) await hydrating;

  const segments = folderSegments();
  if (!segments) {
    return {
      ok: false,
      error: `Cannot save "${name}": this run's folder is not known. ` +
        'Chrome most likely restarted the extension mid-run. Run the report again.'
    };
  }

  const comma = dataUrl.indexOf(',');
  const base64 = comma === -1 ? '' : dataUrl.slice(comma + 1);
  if (!base64) return { ok: false, error: `Nothing to save — "${name}" had no content.` };

  try {
    await ensureOffscreen();
    const reply = await chrome.runtime.sendMessage({
      target: 'offscreen-writer',
      segments,
      filename: name,
      base64
    });

    if (reply && reply.ok) {
      // Nothing to verify: the bytes are on disk under this exact name,
      // because we put them there. No download id exists.
      state.lastSavedPath = reply.path;
      persist();
      return { ok: true, filename: name, path: reply.path };
    }

    const reason = (reply && reply.reason) || 'error';
    return { ok: false, error: `Could not save "${name}". ${FOLDER_TROUBLE[reason] || FOLDER_TROUBLE.error}` };
  } catch (e) {
    return { ok: false, error: `Could not save "${name}": ${(e && e.message) || e}` };
  }
}
```

- [ ] **Step 6: Add `lastSavedPath` to the state**

In the state object (`background/background.js:86`), replace `lastDownloadId: null,` with:

```js
  lastSavedPath: '', // where the last report actually landed, for the popup
```

Then fix every reference. `grep -n "lastDownloadId" background/background.js` must come back empty when you are done. `pendingSavePath` also goes — nothing re-asserts a path any more.

Two references matter and are easy to miss:

- The `lastRun` record written at the end of `runExports()` carries `downloadId: state.lastDownloadId`. Replace that line with `path: state.lastSavedPath,` — Task 7 reads `lastRun.path`.
- `confirmDownload()` sets `state.lastDownloadId` in two places (`state.watch.capturedId` and `landed.id`). Both go; that function's whole job was checking where Chrome put a file, and Chrome no longer places our files. Reduce it to returning the name the content script reported.

- [ ] **Step 7: Gate the run**

At the top of `runExports()`, before `state.running = true`:

```js
  // A run that cannot save must never start. Ten tabs, six minutes of
  // Shopee's time and a folder full of nothing is worse than a clear refusal.
  const folder = await folderReady();
  if (!folder.ok) return { ok: false, error: folder.error };
```

- [ ] **Step 8: Run every test**

```bash
for t in tools/test-*.js; do echo "$t"; node "$t" || break; done
```

Expected: `test-filename-listener.js` fails — Task 5 deletes it. Everything else passes.

- [ ] **Step 9: Commit**

```bash
git add background/background.js offscreen/offscreen.js tools/test-folder-writer.js
git commit -m "Save reports into the chosen folder, and refuse to run without one"
```

---

## Task 4: Prefer captured bytes over Chrome's download

**Files:**
- Modify: `content/content.js:985-1010` (`triggerAndCapture`)

- [ ] **Step 1: Understand what is there**

`triggerAndCapture()` polls each round and checks `bg({type:'checkDownload'})` **first**. The moment Chrome's own download is seen it returns `{via:'browser'}` and never looks at the captured blob. That was right when the background rewrote the download's path. It is wrong now: a browser download is a file we cannot write, so it must be the last resort, not the first.

- [ ] **Step 2: Invert the order**

Replace the polling loop body:

```js
    for (let i = 0; i <= extraRounds; i++) {
      checkCancel();

      // Captured bytes first. We can write those into the seller's folder
      // ourselves; a browser download is a file Chrome has already placed
      // where it likes, and nothing can move it afterwards.
      const saved = await saveFromCaptures(o);
      if (saved) return saved;

      const watch = await bg({ type: 'checkDownload' });
      if (watch && watch.captured) {
        // Chrome took it. Keep waiting a little for the bytes to show up
        // anyway — the blob usually arrives a beat after the download starts.
        report('Chrome started its own download — waiting for the file itself…');
      }

      if (i < extraRounds) {
        report(`Waiting for the file… ${(i + 1) * 2}s`);
        await wait(2000);
      }
    }

    throw new AppError(ERR.NO_BLOB);
```

- [ ] **Step 3: Load the extension and run report #9 alone**

Open the popup, click **9**, watch it.

Expected: the file appears in `<chosen>/Shopee daily report/<today>-HHMM/Order.all.*.xlsx` with Shopee's own name. A stray copy in Downloads is acceptable at this stage and is Task 7's reporting problem, not a failure.

- [ ] **Step 4: Commit**

```bash
git add content/content.js
git commit -m "Take the report's own bytes rather than whatever Chrome downloaded"
```

---

## Task 5: Stop arbitrating other extensions' downloads

**Files:**
- Modify: `background/background.js:777-877`
- Delete: `tools/test-filename-listener.js`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Delete the listener**

Remove the whole `chrome.downloads.onDeterminingFilename.addListener(...)` block, `decideDownloadPath()`, `lastDecisionReason`, `noteDecision()`, `filenameDecisions`, `flushDecisions()`, `decisionFlush` and `DECISION_LIMIT`.

Keep `otherDownloaders` / `noteOtherDownloader()` — the diagnostics section that lists other download-handling extensions is still worth having, now fed from `onCreated`.

Keep `workerStartedAt`: the diagnostics report prints it.

- [ ] **Step 2: Downgrade `onCreated` to reporting**

```js
/**
 * Notices downloads, and no longer places them.
 *
 * This extension writes its files itself now, so a Shopee download appearing
 * here is a STRAY: Chrome's own copy of a report we are also saving properly.
 * Recorded so the run can say so, never deleted — removing a seller's files is
 * not this extension's business.
 */
chrome.downloads.onCreated.addListener(async (item) => {
  try {
    if (item.byExtensionId) {
      noteOtherDownloader(item.byExtensionId, Date.now());
      return;
    }
    await hydrating;
    if (!state.running) return;
    const haystack = [item.url, item.finalUrl, item.referrer].filter(Boolean).join(' ');
    if (!SHOPEE_HOST_RE.test(haystack)) return;
    state.strays.push(basename(item.filename) || String(item.id));
    persistRun();
  } catch (_) {
    /* a missed sighting must never sink a run */
  }
});
```

Add `strays: []` to the state object and to `RUN_KEYS`, and reset it in `runExports()` beside `state.orderLog = [];` — a stray from yesterday's run must not be reported against today's.

Then surface them. In the `lastRun` record written at the end of `runExports()`, add `strays: state.strays,` and in `popup.js`'s `render()`:

```js
  if (lastRun && lastRun.strays && lastRun.strays.length) {
    showBanner(
      `Chrome also left ${lastRun.strays.length} spare cop${lastRun.strays.length === 1 ? 'y' : 'ies'} ` +
      `in your Downloads folder. Your reports are safe in the folder above — these are duplicates you can delete.`
    );
  }
```

- [ ] **Step 3: Remove `decisions` from the diagnostics payload**

In the `getDiagnostics` handler (`background/background.js:1952`), delete the `decisions: filenameDecisions,` line. `lib/diagnostics.js` already treats the section as optional — read its comment at line 77 to confirm before assuming.

- [ ] **Step 4: Delete the obsolete test**

```bash
git rm tools/test-filename-listener.js
```

This test is the record of two shipped bugs, and it is being removed deliberately because the code it covers is gone. Leaving it passing against nothing would be worse.

- [ ] **Step 5: Update `CLAUDE.md`**

Replace the section "The rule that has broken twice" with a short note that the extension no longer registers `onDeterminingFilename`, that files are written through a directory handle, and that this is why. Keep the history — the reasoning is why nobody should add the listener back.

- [ ] **Step 6: Run every test**

```bash
for t in tools/test-*.js; do echo "$t"; node "$t" || break; done
```

Expected: all pass, `test-filename-listener.js` no longer present.

- [ ] **Step 7: Commit**

```bash
git add -A background/background.js tools CLAUDE.md
git commit -m "Stop answering Chrome about filenames at all"
```

---

## Task 6: The pinned date clears itself

**Files:**
- Modify: `background/background.js` — `runExports()` end (~line 1756)
- Test: `tools/test-realtime-pin.js`

- [ ] **Step 1: Write the failing test**

Create `tools/test-realtime-pin.js`:

```js
/**
 * The Real Time pin must not outlive the run it was set for.
 *
 * Set on 23 Aug to fetch the 22nd, it stayed pinned, and every later run filed
 * itself under 22082026-Saturday while the popup warned in small red text that
 * nobody read. A setting that silently changes tomorrow's behaviour is a trap.
 *
 * Run: node tools/test-realtime-pin.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', 'background', 'background.js');
const text = fs.readFileSync(SOURCE, 'utf8');

test('the run clears the pin when it finishes', () => {
  // Asserted against the source because runExports() needs a whole browser to
  // execute. Crude, and still better than shipping this untested twice.
  assert.match(
    text,
    /chrome\.storage\.local\.remove\('realtimeDate'\)/,
    'runExports() must clear realtimeDate when it ends'
  );
});

test('the pin is cleared before lastRun is written, so a reopened popup agrees', () => {
  const clearAt = text.indexOf("remove('realtimeDate')");
  const lastRunAt = text.indexOf('lastRun: {');
  assert.ok(clearAt > -1 && lastRunAt > -1);
  assert.ok(clearAt < lastRunAt, 'clear the pin before recording the run');
});

test('a pin of today or later is still treated as unset', () => {
  const start = text.indexOf('/* PURE-DATES-START */');
  const end = text.indexOf('/* PURE-DATES-END */');
  const vm = require('node:vm');
  const box = {};
  vm.createContext(box);
  vm.runInContext(text.slice(start, end), box);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // getRealtimeDate() is not pure, but its rule is: parsed < today.
  assert.ok(box.parseYmd(iso(today)) >= today, 'today must not count as pinned');
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node tools/test-realtime-pin.js
```

Expected: the first two tests fail — no `remove('realtimeDate')` in the source.

- [ ] **Step 3: Clear the pin**

In `runExports()`, immediately after `stopKeepAlive();` and **before** the `chrome.storage.local.set({ lastRun: ... })` call:

```js
  // The pin covered THIS run and nothing after it. Left set, it silently
  // files every later run under an old date — which is exactly what happened
  // on 23 Aug 2026.
  await chrome.storage.local.remove('realtimeDate');
  state.realtimeDate = '';
```

- [ ] **Step 4: Run the test**

```bash
node tools/test-realtime-pin.js
```

Expected: three tests pass.

- [ ] **Step 5: Update the popup hint**

In `popup/popup.js:407`, change the pinned wording so it says the pin is temporary:

```js
    el.realtimeHint.textContent =
      `Saving to ${targetFolder}, not today's folder. Back to today after this run.`;
```

- [ ] **Step 6: Commit**

```bash
git add background/background.js popup/popup.js tools/test-realtime-pin.js
git commit -m "The Real Time pin covers one run, not every run after it"
```

---

## Task 7: The popup tells the truth about the folder

**Files:**
- Modify: `popup/popup.html:56-62`
- Modify: `popup/popup.js:298-307` and `render()`
- Modify: `background/background.js` — `revealFolder()` (~line 1626) and the `getExports` handler

- [ ] **Step 1: Replace the Open folder button**

There is no API that opens an arbitrary folder, and `chrome.downloads.show()` needs a download id that no longer exists. Showing the path is the honest replacement.

In `popup.html`, replace the `open-folder` button with:

```html
      <span id="where" class="where"></span>
```

- [ ] **Step 2: Add a Settings button**

In `popup.html`, inside `<footer>`:

```html
      <button id="settings" type="button" title="Choose where reports are saved">
        &#9881; Settings
      </button>
```

- [ ] **Step 3: Wire them in `popup.js`**

Delete the `el.openFolder` listener block entirely, and add:

```js
el.settings.addEventListener('click', async () => {
  await send({ type: 'openOptions' });
  window.close();
});
```

In `render()`, replace the last-run line's folder display with the real path:

```js
  const where = lastRun && (lastRun.path || lastRun.runFolder);
  el.where.textContent = where ? `Saved in ${where}` : '';
```

- [ ] **Step 4: Block the run when there is no folder**

`getExports` already runs when the popup opens. Add the folder state to its reply (`background/background.js:1903`):

```js
      const folder = await folderReady();
      return {
        ok: true,
        realtimeDate,
        folderReady: folder.ok,
        folderTrouble: folder.ok ? '' : folder.error,
        folder: `${ROOT_FOLDER}/${runFolder(reportDay(new Date(), realtimeDate), new Date())}`,
        exports: ...
      };
```

In `popup.js`'s `loadExports()`:

```js
  if (res && res.folderReady === false) {
    showBanner(res.folderTrouble);
    el.runFurious.disabled = true;
    document.querySelectorAll('#picker button').forEach((b) => {
      b.disabled = true;
    });
  }
```

`buildPicker()` runs after `renderRealtime()`, so disable the picker buttons after building them — put this block at the end of `loadExports()`.

- [ ] **Step 5: Delete `revealFolder()`**

Remove the function and the `case 'openFolder':` handler. `grep -n "revealFolder\|openFolder" background/background.js popup/popup.js` must come back empty.

- [ ] **Step 6: Check by hand**

Open Options, click **Forget it**, then open the popup.

Expected: a banner saying no folder has been chosen, and **Fast n Furious** greyed out. Choose a folder again, reopen the popup: banner gone, button live.

- [ ] **Step 7: Commit**

```bash
git add popup background/background.js
git commit -m "Popup names the real folder, and will not start a run that cannot save"
```

---

## Task 8: Diagnostics reports the real folder

**Files:**
- Modify: `background/background.js:1948` (the `folder:` object in `getDiagnostics`)

- [ ] **Step 1: Report the truth**

The comment above it says this extension has never had a reports folder. It does now, so both the comment and the `null` go:

```js
          folder: {
            chosen: folderChosen,
            name: folderName,
            extensionFolderGranted: msg.extensionFolderGranted === true
          },
```

The Options page already knows the handle, so pass it in with the message rather than reaching for IndexedDB from the worker, which cannot see it. In `options/options.js`, where `getDiagnostics` is sent, add:

```js
  const output = await idbGet(OUTPUT_KEY).catch(() => null);
  const res = await chrome.runtime.sendMessage({
    type: 'getDiagnostics',
    extensionFolderGranted: !!(await idbGet(HANDLE_KEY).catch(() => null)),
    reportsFolder: !!output,
    reportsFolderName: output ? output.name : ''
  });
```

And in the handler, read them:

```js
    case 'getDiagnostics': {
      const folderChosen = msg.reportsFolder === true;
      const folderName = msg.reportsFolderName || '';
```

- [ ] **Step 2: Run the diagnostics test**

```bash
node tools/test-diagnostics.js
```

Expected: passes. `lib/diagnostics.js` is shared across three extensions — do not change it.

- [ ] **Step 3: Check by hand**

Options → Copy diagnostics. Expected line: `Reports folder chosen: yes: Documents`.

- [ ] **Step 4: Commit**

```bash
git add background/background.js options/options.js
git commit -m "Diagnostics say which folder reports go to"
```

---

## Task 9: Release

**Files:**
- Modify: `manifest.json`, `update.json`

- [ ] **Step 1: Run every test one more time**

```bash
for t in tools/test-*.js; do printf "%-40s" "$t"; node "$t" >/dev/null 2>&1 && echo PASS || echo FAIL; done
```

Expected: every line PASS. Do not continue past a FAIL.

- [ ] **Step 2: Bump both files together**

`manifest.json` → `"version": "1.19.0"`. `update.json` → `"version": "1.19.0"`.

`checkUpdate()` reads only `update.json`. Leave it behind and no machine is ever offered the fix, silently.

- [ ] **Step 3: Add the new files to `update.json`**

The installer downloads exactly the `files` list. A file left out is never delivered, so machines run new code beside old:

```json
    "offscreen/offscreen.html",
    "offscreen/offscreen.js",
```

Remove nothing else from the list — `tools/` was never shipped.

- [ ] **Step 4: Write the notes in plain English**

```json
    "notes": [
        "Reports now save into a folder you choose, instead of Chrome's Downloads folder. Open Settings in the popup and pick one - Documents, for example - and every report goes into 'Shopee daily report' inside it, in a folder named for the date and time of the run.",
        "This also fixes files arriving as 'download (12).xlsx'. The extension now writes each file itself, so no other extension can rename it or move it. Shopee's own filename is what you get.",
        "The extension will not start a run until you have chosen a folder, because there is nowhere safe to put the files until you do.",
        "The Real Time date now goes back to today after one run, instead of staying pinned to an old date."
    ],
```

- [ ] **Step 5: Verify the release is consistent**

```bash
node tools/test-release-consistency.js
```

Expected: PASS. This test exists because a release once shipped with a file missing from the list.

- [ ] **Step 6: Commit and push**

```bash
git add manifest.json update.json
git commit -m "v1.19.0 - reports go where you tell them, under the name Shopee gave them"
git push
```

The updater reads `raw.githubusercontent.com` on the branch. A commit sitting on one PC does not exist as far as every other PC is concerned.

- [ ] **Step 7: Confirm it is really live**

```bash
curl -s https://raw.githubusercontent.com/anson81/Shopee-CPM-Report-Downloader/main/update.json | head -3
```

Expected: `"version": "1.19.0"`.

---

## First real run — what to check

On the Linux machine: Options → **Check** → install → **Choose folder…** → run all ten.

1. Every report in `<chosen>/Shopee daily report/<today>-HHMM/`, under Shopee's own names.
2. No `download (N).xlsx` anywhere new.
3. If any report failed, it says which and why — that is the risk the spec names, and the answer is per-report and visible.
4. Strays in Downloads are reported, not deleted.

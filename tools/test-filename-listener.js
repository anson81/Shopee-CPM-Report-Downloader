/**
 * Does this extension keep its hands off other extensions' downloads?
 *
 * Chrome's onDeterminingFilename is browser-wide: every extension holding the
 * downloads permission is asked about every download, with no notion of which
 * site it came from. Answering — even with a blank suggest() — counts as an
 * opinion, and Chrome hands the final say to the most recently installed
 * extension that answered. So a blank answer about someone else's file wipes
 * that file's name and folder, and it lands in plain Downloads as
 * "download.zip", "download (1).zip", and so on.
 *
 * That is what broke the SiteGiant twin. The v1.14.5 fix covered the warm
 * worker but not the cold one, which is the case that matters: this worker is
 * asleep precisely while the other extension is running.
 *
 * Run:  node tools/test-filename-listener.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, '..', 'background', 'background.js');
const OWN_ID = 'shopee-extension-id';
const TWIN_ID = 'sitegiant-extension-id';

/**
 * Boots background.js in a sandbox with a stub `chrome`, and hands back the
 * filename listener it registered.
 *
 * `sessionDelayMs` is the whole point of the harness: storage.session.get is
 * an async round trip, so a worker woken by a download event handles that
 * event before hydration settles. Delaying the stub reproduces a cold worker
 * exactly, which no amount of reading the code can prove on its own.
 */
function bootWorker({ session = {}, sessionDelayMs = 0 } = {}) {
  const listeners = {};
  const event = (name) => ({
    addListener: (fn) => {
      (listeners[name] = listeners[name] || []).push(fn);
    },
    removeListener() {},
    hasListener: () => false,
  });

  const sessionStore = JSON.parse(JSON.stringify(session));

  const chrome = {
    runtime: {
      id: OWN_ID,
      lastError: undefined,
      getManifest: () => ({ version: 'test' }),
      getPlatformInfo: () => Promise.resolve({ os: 'win' }),
      getContexts: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve({}),
      openOptionsPage() {},
      reload() {},
      onInstalled: event('installed'),
      onMessage: event('message'),
      onStartup: event('startup'),
    },
    action: {
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
    },
    downloads: {
      download: () => Promise.resolve(1),
      search: () => Promise.resolve([]),
      show() {},
      showDefaultFolder() {},
      removeFile: () => Promise.resolve(),
      onDeterminingFilename: event('determiningFilename'),
      onCreated: event('downloadCreated'),
      onChanged: event('downloadChanged'),
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
      session: {
        get: (key) =>
          new Promise((resolve) =>
            setTimeout(() => {
              if (typeof key === 'string') resolve({ [key]: sessionStore[key] });
              else resolve({ ...sessionStore });
            }, sessionDelayMs)
          ),
        set: (obj) => {
          Object.assign(sessionStore, obj);
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
      },
      onChanged: event('storageChanged'),
    },
    scripting: { executeScript: () => Promise.resolve([]) },
    tabs: {
      create: () => Promise.resolve({ id: 1 }),
      get: () => Promise.resolve({ id: 1 }),
      query: () => Promise.resolve([]),
      reload: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      sendMessage: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      onUpdated: event('tabUpdated'),
      onRemoved: event('tabRemoved'),
    },
    alarms: { create() {}, clear: () => Promise.resolve(), onAlarm: event('alarm') },
    offscreen: { createDocument: () => Promise.resolve(), closeDocument: () => Promise.resolve() },
    permissions: { contains: () => Promise.resolve(true) },
  };

  const sandbox = {
    chrome,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fetch: () => Promise.reject(new Error('no network in tests')),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextEncoder,
    TextDecoder,
    URL,
    Blob: class {},
    structuredClone: (v) => JSON.parse(JSON.stringify(v)),
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), sandbox, { filename: SOURCE });

  const listener = (listeners.determiningFilename || [])[0];
  if (!listener) throw new Error('background.js registered no onDeterminingFilename listener');
  return { listener };
}

/** Fires the listener and reports everything Chrome would observe. */
function ask(listener, item) {
  const calls = [];
  const returned = listener(item, (arg) => calls.push(arg));
  return { returned, calls };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

const twinDownload = {
  id: 41,
  // The twin saves its zip from an in-memory data: URL, which carries no name
  // of its own. That is why Chrome's fallback name is "download.zip".
  url: 'data:application/zip;base64,UEsDBAoAAAAAAA==',
  finalUrl: 'data:application/zip;base64,UEsDBAoAAAAAAA==',
  filename: 'download.zip',
  byExtensionId: TWIN_ID,
  byExtensionName: 'SiteGiant Downloader',
};

async function main() {
  console.log('onDeterminingFilename — hands off other extensions\n');

  // 1. Cold worker, twin's download. THE REGRESSION: this worker is asleep
  //    exactly when the twin is running, so this is the everyday case, not an
  //    edge case.
  {
    const { listener } = bootWorker({ sessionDelayMs: 250 });
    const { returned, calls } = ask(listener, twinDownload);
    await settle(600); // long enough for any late answer to arrive
    check(
      'cold worker says nothing about the twin\'s download',
      calls.length === 0 && returned !== true,
      calls.length
        ? `answered ${JSON.stringify(calls[0])} — a blank answer still counts, and wipes the twin's name`
        : returned === true
          ? 'returned true, which commits Chrome to waiting for an answer'
          : ''
    );
  }

  // 2. Warm worker, twin's download, no run of our own in progress.
  {
    const { listener } = bootWorker({ sessionDelayMs: 0 });
    await settle(20);
    const { returned, calls } = ask(listener, twinDownload);
    await settle(100);
    check(
      'warm worker says nothing about the twin\'s download',
      calls.length === 0 && returned !== true,
      calls.length ? `answered ${JSON.stringify(calls[0])}` : ''
    );
  }

  // 3. Warm worker, twin's download, WHILE we are mid-run. The tempting shape
  //    of this bug: our own run makes us feel entitled to answer.
  {
    const { listener } = bootWorker({
      sessionDelayMs: 0,
      session: {
        runtimeState: {
          running: true,
          folder: '2026-08-18',
          runFolder: 'run-1',
          expectedName: '',
          pendingSavePath: 'Shopee daily report/2026-08-18/run-1/ours.xlsx',
          watch: { armed: false, capturedId: null, capturedName: '' },
        },
      },
    });
    await settle(20);
    const { returned, calls } = ask(listener, twinDownload);
    await settle(100);
    check(
      'mid-run, still says nothing about the twin\'s download',
      calls.length === 0 && returned !== true,
      calls.length ? `answered ${JSON.stringify(calls[0])} — that is the twin's file, not ours` : ''
    );
  }

  // 4. Our own page-started download must still be placed. The guard is
  //    worthless if it silences us about our own files.
  {
    const { listener } = bootWorker({
      sessionDelayMs: 0,
      session: {
        runtimeState: {
          running: true,
          folder: '2026-08-18',
          runFolder: 'run-1',
          expectedName: '',
          pendingSavePath: '',
          watch: { armed: false, capturedId: null, capturedName: '' },
        },
      },
    });
    await settle(20);
    const { calls } = ask(listener, {
      id: 7,
      url: 'https://seller.shopee.com.my/api/v3/export/report.xlsx',
      finalUrl: 'https://seller.shopee.com.my/api/v3/export/report.xlsx',
      filename: 'report.xlsx',
      // Started by Shopee's own page, so Chrome reports no extension at all.
      byExtensionId: undefined,
    });
    await settle(100);
    const named = calls[0] && calls[0].filename;
    check(
      'our own Shopee download still gets its folder and name',
      named === 'Shopee daily report/2026-08-18/run-1/report.xlsx',
      named ? `got ${named}` : 'no suggestion made — the file would land loose in Downloads'
    );
  }

  // 5. Our own data: save (the zip/xlsx we hold in memory) must still be
  //    placed. This one carries OUR extension id, which the guard must allow.
  {
    const ourPath = 'Shopee daily report/2026-08-18/run-1/ours.xlsx';
    const { listener } = bootWorker({
      sessionDelayMs: 0,
      session: {
        runtimeState: {
          running: true,
          folder: '2026-08-18',
          runFolder: 'run-1',
          expectedName: '',
          pendingSavePath: ourPath,
          watch: { armed: false, capturedId: null, capturedName: '' },
        },
      },
    });
    await settle(20);
    const { calls } = ask(listener, {
      id: 8,
      url: 'data:application/vnd.ms-excel;base64,AAAA',
      finalUrl: 'data:application/vnd.ms-excel;base64,AAAA',
      filename: 'download.xlsx',
      byExtensionId: OWN_ID,
    });
    await settle(100);
    const named = calls[0] && calls[0].filename;
    check(
      'our own saved file still gets its folder and name',
      named === ourPath,
      named ? `got ${named}` : 'no suggestion made — our own file would land loose in Downloads'
    );
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Boots background.js in a sandbox with a stub `chrome`.
 *
 * Shared by the harnesses in this folder so they all exercise the file that
 * actually ships, rather than a paraphrase of it.
 *
 * `sessionDelayMs` is the reason this exists at all: storage.session.get is an
 * async round trip, so a worker woken by a download event handles that event
 * before hydration settles. Delaying the stub reproduces a cold worker exactly,
 * which no amount of reading the code can prove on its own.
 *
 * `downloads` and `tabs` are merged over the defaults, so a harness can decide
 * what Chrome reports back — where a file landed, what the content script says
 * when asked to save its own copy.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, '..', 'background', 'background.js');
const OWN_ID = 'shopee-extension-id';
const TWIN_ID = 'sitegiant-extension-id';

function bootWorker({ session = {}, sessionDelayMs = 0, downloads = {}, tabs = {} } = {}) {
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
      ...downloads,
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
      ...tabs,
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

  // `const state = …` at the top of a classic script is a lexical binding, not
  // a property of the global object, so it cannot be read off `sandbox`.
  // Evaluating the name inside the same context resolves it the way the script
  // itself would.
  const evaluate = (expression) => vm.runInContext(expression, sandbox);

  return { listener, listeners, chrome, sandbox, evaluate };
}

/** Fires the filename listener and reports everything Chrome would observe. */
function ask(listener, item) {
  const calls = [];
  const returned = listener(item, (arg) => calls.push(arg));
  return { returned, calls };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shared PASS/FAIL tally, so every harness prints and exits the same way. */
function reporter(title) {
  const results = [];
  console.log(`${title}\n`);

  return {
    check(name, passed, detail) {
      results.push({ name, passed, detail });
      console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
    },
    finish() {
      const failed = results.filter((r) => !r.passed).length;
      console.log(`\n${results.length - failed}/${results.length} passed`);
      process.exit(failed ? 1 : 0);
    },
  };
}

module.exports = { bootWorker, ask, settle, reporter, SOURCE, OWN_ID, TWIN_ID };

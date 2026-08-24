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

/**
 * A directory handle that records what was asked of it.
 *
 * `failWrite` has to travel down to the child handles: the file is created on
 * the LAST folder in the path, not on the root, so overriding the root alone
 * tests nothing. That mistake made this suite pass a broken close().
 */
function fakeDir(log, name, failWrite) {
  return {
    name,
    async getDirectoryHandle(part, opts) {
      log.push(`dir:${part}:${opts && opts.create ? 'create' : 'plain'}`);
      return fakeDir(log, part, failWrite);
    },
    async getFileHandle(file, opts) {
      log.push(`file:${file}:${opts && opts.create ? 'create' : 'plain'}`);
      return {
        async createWritable() {
          return {
            async write(bytes) {
              if (failWrite) throw new Error('disk full');
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

function boot({ root = undefined, saved = {} } = {}) {
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
            transaction: () => {
              const tx = {};
              setTimeout(() => {
                if (tx.oncomplete) tx.oncomplete();
              }, 0);
              tx.objectStore = () => ({
                get() {
                  const r = {};
                  setTimeout(() => {
                    r.result = root;
                    if (r.onsuccess) r.onsuccess();
                  }, 0);
                  return r;
                },
                put(value, key) {
                  saved[key] = value;
                  const r = {};
                  setTimeout(() => {
                    if (r.onsuccess) r.onsuccess();
                  }, 0);
                  return r;
                }
              });
              return tx;
            }
          };
          if (req.onsuccess) req.onsuccess();
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
  // offscreen.html loads lib/safe-name.js ahead of offscreen.js, and the writer
  // calls self.SRD_safeFileName at the disk boundary. Booting without it would
  // test a document that does not exist.
  sandbox.self = sandbox;
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'lib', 'safe-name.js'), 'utf8'),
    sandbox
  );
  vm.runInContext(source, sandbox);
  return {
    listener: () => listener,
    send: (msg) =>
      new Promise((resolve) => {
        const returned = listener(msg, null, resolve);
        // A listener that declines returns undefined and never calls back.
        if (returned !== true) resolve(undefined);
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
  // The "+" in GMV Max's name has been mangled before now.
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
  const { send } = boot({ root: fakeDir(log, 'Documents', true) });
  const reply = await send(MSG);

  // Skipping close() leaves a zero-byte file that looks like a success.
  assert.ok(log.includes('close'), 'close() must run even on a failed write');
  assert.strictEqual(reply.ok, false);
});

test('says nothing about messages addressed elsewhere', async () => {
  const { listener } = boot({ root: fakeDir([], 'Documents') });
  let answered = false;
  const returned = listener({ target: 'someone-else' }, null, () => {
    answered = true;
  });

  // Returning undefined is what tells Chrome we are not answering. Returning
  // true and then never calling back would hang the sender for ever.
  assert.notStrictEqual(returned, true);
  assert.strictEqual(answered, false);
});

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

test('remembers the folder it wrote into, so Open folder can go there', async () => {
  const log = [];
  const saved = {};
  const { send } = boot({ root: fakeDir(log, 'Documents'), saved });
  await send(MSG);

  // The popup opens the picker at THIS handle - the run folder, not the root -
  // so a click lands on the files just written rather than three levels above
  // them.
  assert.ok(saved.lastRunFolder, 'the run folder handle was not remembered');
  assert.strictEqual(saved.lastRunFolder.name, '23082026-Sunday-1418');
});

test('a probe does not overwrite the remembered folder', async () => {
  const saved = { lastRunFolder: { name: 'from-an-earlier-run' } };
  const { send } = boot({ root: fakeDir([], 'Documents'), saved });
  await send({ target: 'offscreen-writer', probe: true, segments: [], filename: '' });

  // The popup probes on every open. If that reset the memory, Open folder
  // would drift back to the root the first time the popup was looked at.
  assert.strictEqual(saved.lastRunFolder.name, 'from-an-earlier-run');
});

test('an unsafe name is made safe at the disk boundary', async () => {
  const log = [];
  const { send } = boot({ root: fakeDir(log, 'Documents') });
  // Nothing sanitised this on the way in. getFileHandle() would throw on the
  // slash on every OS, and keep the colon on Linux while failing on Windows.
  const reply = await send({ ...MSG, filename: 'a/b/re:port.csv' });

  assert.strictEqual(reply.ok, true);
  assert.ok(log.includes('file:report.csv:create'), log.join(', '));
  // The reported path must name the file that actually landed, not the one we
  // were asked for - otherwise the popup points at a file that is not there.
  assert.ok(reply.path.endsWith('/report.csv'), reply.path);
});

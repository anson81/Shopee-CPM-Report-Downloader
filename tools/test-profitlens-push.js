/**
 * The push to ProfitLens, without a browser.
 *
 * Two halves:
 *  - which finished reports are sent, and the line each row then shows — the
 *    PURE-PUSH region of background/background.js, sliced out and run alone;
 *  - content/profitlens.js itself, in a vm sandbox with a stubbed fetch, so the
 *    upload and especially the error wording are checked against the envelope
 *    ProfitLens really sends. The SiteGiant copy of this script read
 *    `error.message` off a STRING and showed "HTTP 400" instead of the reason.
 *
 * Run: node tools/test-profitlens-push.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadPurePush() {
  const text = fs.readFileSync(path.join(ROOT, 'background', 'background.js'), 'utf8');
  const start = text.indexOf('/* PURE-PUSH-START */');
  const end = text.indexOf('/* PURE-PUSH-END */');
  if (start === -1 || end === -1) throw new Error('PURE-PUSH markers not found');
  const sandbox = {};
  vm.createContext(sandbox);
  // `const` does not land on the sandbox; hand the names out explicitly.
  vm.runInContext(
    text.slice(start, end) +
      '\n;this.out = { PUSH_ENDPOINT, pushCandidates, pushSummary, pushFailure };',
    sandbox
  );
  return sandbox.out;
}

const P = loadPurePush();

const EXPORTS = [
  { id: 1, kind: 'bi' },
  { id: 2, kind: 'bi' },
  { id: 6, kind: 'ads' },
  { id: 8, kind: 'bi' },
  { id: 9, kind: 'order' },
  { id: 11, kind: 'bi' }
];

/* --- which reports are pushed ---------------------------------------- */

test('only finished Product Performance files are pushed, in report order', () => {
  const results = {
    1: { status: 'done', filename: 'parentskudetail.20261021_20261021.xlsx' },
    2: { status: 'error', filename: '' },
    6: { status: 'done', filename: 'Shopee-Ads-Overall-Data.csv' },
    8: { status: 'done', filename: 'parentskudetail.20260921_20261020.xlsx' },
    9: { status: 'done', filename: 'Order.all.20260921_20261020.xlsx' },
    11: { status: 'done', filename: 'parentskudetail.20260901_20260930.xlsx' }
  };
  assert.deepStrictEqual(Array.from(P.pushCandidates(results, EXPORTS)), [1, 8, 11]);
});

test('a skipped duplicate (done, no file) is not pushed', () => {
  const results = { 2: { status: 'done', filename: '' } };
  assert.deepStrictEqual(Array.from(P.pushCandidates(results, EXPORTS)), []);
});

test('a BI row holding some other file is not pushed', () => {
  const results = { 1: { status: 'done', filename: 'download.csv' } };
  assert.deepStrictEqual(Array.from(P.pushCandidates(results, EXPORTS)), []);
});

test('the endpoint is the one ProfitLens serves', () => {
  assert.strictEqual(P.PUSH_ENDPOINT, '/api/import/product-performance');
});

/* --- what each row then says ----------------------------------------- */

test('a pushed row shows the counts', () => {
  assert.strictEqual(
    P.pushSummary({ created: 312, updated: 0, unchanged: 4 }),
    'ProfitLens: 312 new · 0 updated · 4 unchanged'
  );
});

test('not logged in says the file is saved and what to do', () => {
  assert.strictEqual(
    P.pushFailure('NOT_LOGGED_IN'),
    'ProfitLens: Not logged in to ProfitLens — the file is saved, log in and press Push'
  );
});

test('any other failure keeps ProfitLens own words and offers Push', () => {
  const line = P.pushFailure('This shop has no synced price list');
  assert.match(line, /^ProfitLens: This shop has no synced price list/);
  assert.match(line, /the file is saved, press Push/);
});

/* --- content/profitlens.js against a stubbed ProfitLens --------------- */

function bootContentScript(fetchImpl) {
  let listener = null;
  const sandbox = {
    // The page bridge (srd:hello, srd:createVouchers) listens on window.
    window: { addEventListener: () => {}, postMessage: () => {} },
    location: { href: 'https://profitlens.my/campaign-planner', origin: 'https://profitlens.my' },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Uint8Array,
    Blob: class Blob {
      constructor(parts, opts) {
        this.parts = parts;
        this.type = opts && opts.type;
      }
    },
    FormData: class FormData {
      constructor() {
        this.fields = [];
      }
      append(name, value, filename) {
        this.fields.push({ name, value, filename });
      }
    },
    fetch: fetchImpl,
    chrome: { runtime: { onMessage: { addListener: (fn) => (listener = fn) } } }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'content', 'profitlens.js'), 'utf8'), sandbox);
  return (msg) => new Promise((resolve) => listener(msg, {}, resolve));
}

const jsonResponse = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body
});

const PUSH = {
  type: 'push',
  endpoint: '/api/import/product-performance',
  filename: 'parentskudetail.20260901_20260930.xlsx',
  base64: Buffer.from('PK fake xlsx').toString('base64')
};

test('a successful push sends the file and returns the counts', async () => {
  const calls = [];
  const send = bootContentScript(async (url, opts) => {
    calls.push({ url, opts });
    if (url === '/api/auth/refresh') return jsonResponse(200, { data: { accessToken: 'tok' } });
    return jsonResponse(200, {
      success: true,
      data: { created: 300, updated: 11, unchanged: 0, listings: 311, shop: { name: 'QFM' } }
    });
  });

  const res = await send(PUSH);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.created, 300);
  assert.strictEqual(res.updated, 11);
  assert.strictEqual(res.shop, 'QFM');

  const upload = calls[1];
  assert.strictEqual(upload.url, '/api/import/product-performance');
  assert.strictEqual(upload.opts.headers.Authorization, 'Bearer tok');
  const field = upload.opts.body.fields[0];
  assert.strictEqual(field.name, 'file');
  assert.strictEqual(field.filename, PUSH.filename);
});

test('ProfitLens own error wording comes through (string envelope)', async () => {
  const send = bootContentScript(async (url) => {
    if (url === '/api/auth/refresh') return jsonResponse(200, { data: { accessToken: 'tok' } });
    return jsonResponse(400, {
      success: false,
      error: 'Expected a file named like parentskudetail.20260722_20260820.xlsx'
    });
  });
  const res = await send(PUSH);
  assert.strictEqual(res.error, 'Expected a file named like parentskudetail.20260722_20260820.xlsx');
});

test('an object envelope still yields words', async () => {
  const send = bootContentScript(async (url) => {
    if (url === '/api/auth/refresh') return jsonResponse(200, { data: { accessToken: 'tok' } });
    return jsonResponse(500, { error: { message: 'Database unavailable' } });
  });
  assert.strictEqual((await send(PUSH)).error, 'Database unavailable');
});

test('no JSON at all falls back to the status code', async () => {
  const send = bootContentScript(async (url) => {
    if (url === '/api/auth/refresh') return jsonResponse(200, { data: { accessToken: 'tok' } });
    return { status: 502, ok: false, json: async () => { throw new Error('not json'); } };
  });
  assert.strictEqual((await send(PUSH)).error, 'HTTP 502');
});

test('no ProfitLens session is reported as NOT_LOGGED_IN', async () => {
  const send = bootContentScript(async () => jsonResponse(401, { success: false, error: 'No session' }));
  assert.strictEqual((await send(PUSH)).error, 'NOT_LOGGED_IN');
});

test('pushJson sends the campaign calendar as JSON and returns what ProfitLens counted', async () => {
  const calls = [];
  const send = bootContentScript(async (url, opts) => {
    calls.push({ url, opts });
    if (url === '/api/auth/refresh') return jsonResponse(200, { data: { accessToken: 'tok' } });
    return jsonResponse(200, { success: true, data: { campaigns: 5, sessions: 12 } });
  });
  const body = { shopId: '50237726', capturedAt: '2026-10-21T01:30:00.000Z', campaigns: [{ id: '1' }] };
  const res = await send({ type: 'pushJson', endpoint: '/api/import/shopee-campaigns', body });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.sessions, 12);
  assert.strictEqual(calls[1].opts.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(calls[1].opts.body), body);
});

test('pushJson reports ProfitLens own words on a refusal', async () => {
  const send = bootContentScript(async (url) => {
    if (url === '/api/auth/refresh') return jsonResponse(200, { data: { accessToken: 'tok' } });
    return jsonResponse(400, { success: false, error: 'Shopee shop 1 is not connected to this account.' });
  });
  const res = await send({ type: 'pushJson', endpoint: '/api/import/shopee-campaigns', body: {} });
  assert.match(res.error, /not connected/);
});
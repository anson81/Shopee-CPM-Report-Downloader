/**
 * A report tab Chrome holds back must be woken, not waited out.
 *
 * On the P50 (Chrome on Linux, 6 Nov 2026) a tab opened in the background did
 * not load until it was clicked, and every run lost five to seven of eleven
 * reports to "took too long to load". loadNudge() decides when to reload or
 * bring a tab forward; the wiring around it needs a browser, so it is asserted
 * against the source.
 *
 * Run: node tools/test-tab-wake.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = path.join(__dirname, '..', 'background', 'background.js');
const text = fs.readFileSync(SOURCE, 'utf8');

function lift(name) {
  const start = text.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`background.js has no function ${name}`);
  // Top-level functions there close on a brace at the start of a line.
  return text.slice(start, text.indexOf('\n}\n', start) + 2);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${lift('loadNudge')}\nthis.loadNudge = loadNudge;`, sandbox);
const { loadNudge } = sandbox;

const none = () => ({ reload: false, activate: false });

test('a tab that is loading is left alone at first', () => {
  assert.strictEqual(loadNudge({ status: 'loading' }, 1000, none()), 'wait');
  assert.strictEqual(loadNudge({ status: 'loading' }, 9000, none()), 'wait');
});

test('a tab Chrome never started, or put to sleep, is reloaded', () => {
  assert.strictEqual(loadNudge({ status: 'unloaded' }, 3000, none()), 'reload');
  assert.strictEqual(loadNudge({ status: 'loading', discarded: true }, 3000, none()), 'reload');
});

test('a sleeping tab gets a moment before the reload, and only one', () => {
  assert.strictEqual(loadNudge({ status: 'unloaded' }, 1000, none()), 'wait');
  const reloaded = { reload: true, activate: false };
  assert.strictEqual(loadNudge({ status: 'unloaded' }, 5000, reloaded), 'wait');
});

test('a tab still not done after 10 seconds is brought forward, once', () => {
  assert.strictEqual(loadNudge({ status: 'loading' }, 10000, none()), 'activate');
  const reloaded = { reload: true, activate: false };
  assert.strictEqual(loadNudge({ status: 'unloaded' }, 12000, reloaded), 'activate');
  const both = { reload: true, activate: true };
  assert.strictEqual(loadNudge({ status: 'loading' }, 60000, both), 'wait');
});

test('awaitTabLoad acts on the nudge', () => {
  const body = lift('awaitTabLoad');
  assert.match(body, /loadNudge\(/, 'awaitTabLoad must ask loadNudge');
  assert.match(body, /chrome\.tabs\.reload\(tabId\)/, 'a sleeping tab must be reloaded');
  assert.match(body, /chrome\.tabs\.update\(tabId, \{ active: true \}\)/, 'a slow tab must be brought forward');
});

test('report tabs are woken and kept from sleeping before the load wait', () => {
  const body = lift('preloadTabs');
  const keep = body.indexOf('autoDiscardable: false');
  const wake = body.indexOf('await wakeTabs(');
  const wait = body.indexOf('await loadReportTab(');
  assert.ok(keep > -1, 'report tabs must not be discardable');
  assert.ok(wake > -1, 'preloadTabs must wake its tabs');
  assert.ok(wait > -1, 'preloadTabs must still wait for each tab');
  assert.ok(wake < wait, 'tabs are woken before the load wait starts');
});

test('a tab that failed to load gets a second try, in front, before it is an error', () => {
  const body = lift('preloadTabs');
  assert.match(body, /loadReportTab\(t\.tabId, false\)/, 'first load is all at once');
  assert.match(body, /retryableLoad\(message\)/, 'only timeouts are tried again');
  assert.match(body, /loadReportTab\(r\.t\.tabId, true\)/, 'the second try is one tab at a time');
  const again = lift('loadReportTab');
  assert.match(again, /active: true[\s\S]*chrome\.tabs\.reload\(tabId\)/, 'brought forward, then reloaded');
});

test('a loaded page that will not answer is brought forward, and says so when it still will not', () => {
  const body = lift('waitForContentScript');
  assert.match(body, /chrome\.tabs\.update\(tabId, \{ active: true \}\)/);
  assert.match(body, /ERR\.PAGE_SILENT/);
  vm.runInContext(
    `const ERR = { PAGE_TIMEOUT: 'a', PAGE_SILENT: 'b', TAB_GONE: 'c' };\n${lift('retryableLoad')}\nthis.retryableLoad = retryableLoad;`,
    sandbox
  );
  assert.strictEqual(sandbox.retryableLoad('a'), true);
  assert.strictEqual(sandbox.retryableLoad('b'), true);
  assert.strictEqual(sandbox.retryableLoad('c'), false);
});

test('a TikTok page still not built after two looks is brought forward once', () => {
  vm.runInContext(
    `const TIKTOK_WEB_FORWARD_AFTER = 2;\n${lift('tiktokNudge')}\nthis.tiktokNudge = tiktokNudge;`,
    sandbox
  );
  assert.strictEqual(sandbox.tiktokNudge(1, false), false);
  assert.strictEqual(sandbox.tiktokNudge(2, false), true);
  assert.strictEqual(sandbox.tiktokNudge(5, true), false);
});

test('a TikTok read brings its tab forward and gives the seller their tab back', () => {
  const body = lift('readTikTokPage');
  assert.match(body, /const before = await activeTab\(\)/, 'remembers the tab the seller is on');
  assert.match(body, /tiktokNudge\(/);
  assert.match(body, /chrome\.tabs\.update\(tabId, \{ active: true \}\)/);
  assert.match(body, /chrome\.tabs\.update\(before\.id, \{ active: true \}\)/, 'returns to it afterwards');
});

test('TikTok Studio is opened at most once in 25 minutes, whoever asks', () => {
  vm.runInContext(`const STUDIO_READ_GAP_MS = 25 * 60_000;\n${lift('studioReadDue')}\nthis.studioReadDue = studioReadDue;`, sandbox);
  const min = 60_000;
  const now = 1_000_000 * min;
  assert.strictEqual(sandbox.studioReadDue(0, now), true, 'never read');
  assert.strictEqual(sandbox.studioReadDue(now - 5 * min, now), false, 'read 5 min ago');
  assert.strictEqual(sandbox.studioReadDue(now - 24 * min, now), false);
  assert.strictEqual(sandbox.studioReadDue(now - 25 * min, now), true);
  assert.strictEqual(sandbox.studioReadDue(now + 5 * min, now), true, 'a clock set back does not block it for good');
  const body = text.slice(text.indexOf('async function readTikTokStudioPosts('));
  assert.match(body.slice(0, 600), /studioReadDue\(/, 'the one read function checks it, so runs and ProfitLens both do');
});

test('a sign-in page is named after its own site', () => {
  const own = { URL };
  vm.createContext(own);
  vm.runInContext(
    `const ERR = { NOT_LOGGED_IN: 'shopee' };\n${lift('signInProblem')}\nthis.signInProblem = signInProblem;`,
    own
  );
  const s = own.signInProblem;
  assert.strictEqual(s('https://seller.shopee.com.my/datacenter/product/overview'), null);
  assert.strictEqual(s('https://accounts.shopee.com.my/seller/login'), 'shopee');
  assert.strictEqual(s('https://www.tiktok.com/tiktokstudio/upload'), null);
  assert.match(s('https://www.tiktok.com/login?redirect_url=x'), /Sign in to TikTok in this Chrome/);
  assert.match(s('https://seller-my.tiktok.com/account/login'), /TikTok Seller Center/);
  assert.match(s('https://affiliate.tiktok.com/login'), /Affiliate Center/);
  assert.strictEqual(s(''), null);
});

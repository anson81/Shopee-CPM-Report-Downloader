/**
 * The campaign calendar's pure part, against the shapes Seller Centre really
 * sends (seen on 21 Oct 2026), and the content script's capture against a
 * stubbed Seller Centre.
 *
 * Run: node tools/test-campaigns.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'campaigns.js'), 'utf8'), sandbox);
const C = sandbox.SRD_Campaigns;
// Values made inside the vm have its own Array prototype; compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

// Big Campaign layout.
const BIG = {
  code: 0,
  data: {
    total_count: 3,
    general: {
      product_session: [
        { session_id: '1', session_name: '11.11 Big Sale 2026', statistics: { approved_count: 6 } },
        { session_id: '2', session_name: 'Nov 15 Mid-Month Madness 2026' },
      ],
      voucher_session: [{ session_id: '3', session_name: '11.11 Vouchers' }],
    },
    session_view_type_statistics: { available_session_num: 3 },
  },
};
// Shocking Sale layout: grouped by day.
const FLASH = {
  code: 0,
  data: {
    total_count: 2,
    list: [
      { start_time: 1793030400, product_session: [{ session_id: '10', session_name: 'Slot 6 (8pm - 12am)' }] },
      { start_time: 1793116800, product_session: [{ session_id: '11', session_name: 'Slot 1' }, { session_id: '10', session_name: 'dup' }] },
    ],
  },
};

test('finds sessions in the Big Campaign layout, product and voucher', () => {
  assert.deepStrictEqual(plain(C.flattenSessions(BIG.data)).map((s) => s.session_id), ['1', '2', '3']);
});

test('finds sessions in the by-day layout, each once', () => {
  assert.deepStrictEqual(plain(C.flattenSessions(FLASH.data)).map((s) => s.session_id), ['10', '11']);
});

test('an empty answer has no sessions', () => {
  assert.deepStrictEqual(plain(C.flattenSessions({})), []);
  assert.deepStrictEqual(plain(C.flattenSessions(null)), []);
});

test('strips links and the Shopee staff email, keeps everything else', () => {
  const out = C.stripCampaign({ id: '1', name: 'Nov', url: 'https://x', creator: 'someone@shopee.com', banner: 'b', app_banner: 'a', square_banner: 's', campaign_tier: { name: 'Mega' } });
  assert.deepStrictEqual(Object.keys(out).sort(), ['campaign_tier', 'id', 'name']);
});

test('batches for the upload limit', () => {
  assert.deepStrictEqual(plain(C.chunk([1, 2, 3, 4, 5, 6, 7], 3)), [[1, 2, 3], [4, 5, 6], [7]]);
  assert.deepStrictEqual(plain(C.chunk([], 3)), []);
});

test('says what happened in one line', () => {
  assert.strictEqual(C.summary({ campaigns: 24, sessions: 61 }), 'Campaigns: 24 sent to ProfitLens (61 sessions)');
  assert.strictEqual(C.summary({ error: 'Not logged in to ProfitLens' }), 'Campaigns: Not logged in to ProfitLens');
});

/* --- content.js captureCampaigns against a stubbed Seller Centre -------- */

function bootContent(routes) {
  let listener = null;
  const calls = [];
  class XHR {
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader() {}
    send(body) {
      calls.push({ method: this.method, url: this.url, body: body ? JSON.parse(body) : null });
      const route = routes(this.url, body ? JSON.parse(body) : null);
      setTimeout(() => {
        this.status = route ? 200 : 500;
        this.responseText = route ? JSON.stringify(route) : 'ERROR_CODEC_NOT_FOUND';
        this.onload && this.onload();
      }, 0);
    }
  }
  const sb = {
    window: {},
    document: { readyState: 'complete', addEventListener() {}, querySelectorAll: () => [], querySelector: () => null },
    location: { href: 'https://seller.shopee.com.my/portal/marketing/cmt/campaign' },
    XMLHttpRequest: XHR,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    console,
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: { runtime: { sendMessage: () => Promise.resolve({ ok: true }), onMessage: { addListener: (fn) => (listener = fn) } } },
  };
  sb.self = sb;
  sb.window = sb;
  sb.addEventListener = () => {};
  sb.removeEventListener = () => {};
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'campaigns.js'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'content', 'content.js'), 'utf8'), sb);
  return { send: (msg) => new Promise((resolve) => listener(msg, {}, resolve)), calls };
}

const LIST = (offset) => ({
  code: 0,
  data: {
    pagination: { offset, limit: 50, total_cnt: 2 },
    list: [
      { id: '2048108187', name: 'November Campaigns 2026', url: 'https://x', creator: 'a@shopee.com', start_time: 1, end_time: 2 },
      { id: '2048108290', name: 'Shocking Sale 27 Oct', start_time: 1, end_time: 2 },
    ],
  },
});

test('captures the shop, every campaign and its sessions', async () => {
  const { send, calls } = bootContent((url, body) => {
    if (url.includes('shop_info')) return { code: 0, data: { shop_id: 50237726, name: 'QFM Modest', shop_region: 'MY' } };
    if (url.includes('get_landing_page_campaign_list')) return LIST(body.pagination.offset);
    if (url.includes('get_session_list')) return body.campaign_id === '2048108187' ? BIG : FLASH;
    return null;
  });
  const res = await send({ type: 'captureCampaigns' });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.shopId, '50237726');
  assert.strictEqual(res.campaigns.length, 2);
  const nov = res.campaigns[0];
  assert.strictEqual(nov.url, undefined, 'links are stripped');
  assert.strictEqual(nov.creator, undefined, 'staff emails are stripped');
  assert.deepStrictEqual(plain(nov.sessions).map((s) => s.session_id), ['1', '2', '3']);
  // The session list wants the campaign id as a STRING — a number is refused.
  const sessionCalls = calls.filter((c) => c.url.includes('get_session_list'));
  assert.ok(sessionCalls.every((c) => typeof c.body.campaign_id === 'string'));
});

test('one campaign whose sessions fail is kept, without sessions, and says so', async () => {
  const { send } = bootContent((url, body) => {
    if (url.includes('shop_info')) return { code: 0, data: { shop_id: 1, name: 'S' } };
    if (url.includes('get_landing_page_campaign_list')) return LIST(body.pagination.offset);
    if (url.includes('get_session_list')) return body.campaign_id === '2048108187' ? null : FLASH;
    return null;
  });
  const res = await send({ type: 'captureCampaigns' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(plain(res.campaigns[0].sessions), []);
  assert.strictEqual(res.sessionErrors, 1);
});

test('not logged in to Seller Centre is a clear error', async () => {
  const { send } = bootContent(() => null);
  const res = await send({ type: 'captureCampaigns' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /log in to Shopee Seller Cent/i);
});

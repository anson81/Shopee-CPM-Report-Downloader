/**
 * CPM Voucher Hack's pure part: what may be sent to Seller Centre, and what is.
 *
 * Run: node tools/test-vouchers.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const sandbox = { Date };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'vouchers.js'), 'utf8'), sandbox);
const V = sandbox.SRD_Vouchers;
const plain = (v) => JSON.parse(JSON.stringify(v));

const NOW = Date.parse('2026-10-26T02:00:00Z');
const voucher = (over = {}) => ({
  period: 1,
  name: 'A606 VC1',
  code: 'A6061',
  startAt: '2026-10-27T16:00:00.000Z',
  endAt: '2026-10-30T15:59:00.000Z',
  quantity: 3,
  amountSen: 100,
  ...over
});
const request = (over = {}) => ({ itemIds: ['27209230021'], vouchers: [voucher()], ...over });

test('a correct request has no problems', () => {
  assert.deepStrictEqual(plain(V.problems(request(), NOW)), []);
});

test('refuses what Seller Centre must never be sent', () => {
  const p = (r) => V.problems(r, NOW).join(' | ');
  assert.match(p({ itemIds: ['1'], vouchers: [voucher()] }), /item id/);
  assert.match(p(request({ vouchers: [voucher({ code: 'A606-1' })] })), /code must be/);
  assert.match(p(request({ vouchers: [voucher(), voucher({ period: 2 })] })), /used twice/);
  assert.match(p(request({ vouchers: [voucher({ startAt: '2026-10-25T00:00:00Z' })] })), /in the past/);
  assert.match(p(request({ vouchers: [voucher({ quantity: 0 })] })), /quantity/);
  assert.match(p(request({ vouchers: [voucher({ amountSen: 0 })] })), /amount/);
  assert.match(p(request({ vouchers: [1, 2, 3, 4, 5].map((i) => voucher({ code: `A606${i}`, period: i })) })), /At most 4/);
  assert.match(p({}), /No vouchers/);
});

test('sends what Seller Centre itself sends (captured from a real create, 26 Oct 2026)', () => {
  const NOW_MS = Date.parse('2026-10-26T06:00:00Z');
  const body = plain(V.payload(voucher(), ['27209230021'], 'QFMW', NOW_MS));
  assert.deepStrictEqual(body, {
    name: 'A606 VC1',
    voucher_code: 'QFMWA6061',
    start_time: Date.parse('2026-10-27T16:00:00Z') / 1000,
    end_time: Date.parse('2026-10-30T15:59:00Z') / 1000,
    discount: null,
    value: 1,
    max_value: null,
    min_price: 0,
    usage_quantity: 3,
    rule: {
      usage_limit_per_user: 1,
      items: [{ itemid: 27209230021 }],
      coin_cashback_voucher: { coin_percentage_real: null, max_coin: null },
      voucher_landing_page: 1,
      display_from: NOW_MS / 1000,
      exclusive_channel_type: null,
      hide: 0,
      reward_type: 0,
      backend_created: 0,
      display_voucher_early: true,
      choose_users: { shop_order_count: 0, shop_order_count_period: 0 }
    }
  });
  assert.strictEqual(V.payload(voucher({ amountSen: 150 }), ['1'], 'QFMW', NOW_MS).value, 1.5);
});

test('the code prefix is the first four letters of the shop login', () => {
  assert.strictEqual(V.codePrefix('qfmwholesales'), 'QFMW');
  assert.strictEqual(V.codePrefix('ab_c-d9x'), 'ABCD');
  assert.strictEqual(V.codePrefix(''), '');
});

test('says how far it got', () => {
  assert.strictEqual(V.summary([{ ok: true }, { ok: true }]), '2 vouchers created');
  assert.strictEqual(V.summary([{ ok: true }, { ok: false, error: 'Code already exists' }]), '1 created, then stopped: Code already exists');
});

test('finds planned codes Shopee already has (one product, two listings)', () => {
  const plan = [1, 2, 3, 4].map((p) => voucher({ code: `3289${p}` }));
  assert.deepStrictEqual(V.takenCodes(['QFMW32891', 'qfmw32892', 'QFMWA6061'], plan, 'QFMW'), ['32891', '32892']);
  assert.deepStrictEqual(V.takenCodes([], plan, 'QFMW'), []);
});

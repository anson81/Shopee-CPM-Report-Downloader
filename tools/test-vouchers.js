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

test('sends a fixed-amount product voucher: no minimum spend, one per buyer, shown on all pages', () => {
  const body = plain(V.payload(voucher(), ['27209230021']));
  assert.strictEqual(body.name, 'A606 VC1');
  assert.strictEqual(body.voucher_code, 'A6061');
  assert.strictEqual(body.start_time, Date.parse('2026-10-27T16:00:00Z') / 1000);
  assert.strictEqual(body.end_time, Date.parse('2026-10-30T15:59:00Z') / 1000);
  assert.strictEqual(body.value, '1.00');
  assert.strictEqual(body.discount, 0);
  assert.strictEqual(body.min_price, '0.00');
  assert.strictEqual(body.usage_quantity, 3);
  assert.deepStrictEqual(body.rule.items, [{ itemid: 27209230021 }]);
  assert.strictEqual(body.rule.usecase, 2);
  assert.strictEqual(body.rule.usage_limit_per_user, 1);
  assert.strictEqual(body.rule.hide, false);
  assert.strictEqual(body.rule.display_voucher_early, true);
});

test('says how far it got', () => {
  assert.strictEqual(V.summary([{ ok: true }, { ok: true }]), '2 vouchers created');
  assert.strictEqual(V.summary([{ ok: true }, { ok: false, error: 'Code already exists' }]), '1 created, then stopped: Code already exists');
});

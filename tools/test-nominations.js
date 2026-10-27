/**
 * Campaign nomination's pure part, checked against the requests Seller Centre
 * itself sent on 27 Oct 2026 (Nov 25 Payday Sale, Aprilia 1318).
 *
 * Run: node tools/test-nominations.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const sandbox = { Date, Map };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'nominations.js'), 'utf8'), sandbox);
const N = sandbox.SRD_Nominations;
const plain = (v) => JSON.parse(JSON.stringify(v));

const request = (over = {}) => ({
  shopId: '50237726',
  campaignId: '2048108187',
  sessionId: '130000000066788',
  items: [{ itemId: '21493849870', models: [{ modelId: '177897460416', priceSen: 2790, originalPriceSen: 2990, stock: 4 }] }],
  ...over,
});

// preview_list as Seller Centre answered it (trimmed to the fields used).
const PREVIEW = {
  entity_list_data: {
    recruiting_entities: [
      {
        entity_type: 2,
        product: {
          item_id: '21493849870',
          models: [
            {
              item_id: '21493849870',
              model_id: '177897460416',
              nomination_id: '2900000003314176916',
              pricing_application_info: { max_campaign_entry_price: 2989000, reference_price_by_shopee: 2989000 },
            },
          ],
        },
      },
    ],
  },
};

test('accepts a whole request and says plainly what is wrong with a bad one', () => {
  assert.deepStrictEqual(plain(N.problems(request())), []);
  const bad = N.problems(request({ sessionId: '', items: [{ itemId: 'x', models: [{ modelId: '1', priceSen: 3000, originalPriceSen: 2990, stock: -1 }] }] }));
  assert.ok(bad.includes('The campaign session is missing'));
  assert.ok(bad.includes('Product 1: the Shopee item id is missing'));
  assert.ok(bad.includes('Product 1: a price is above the listed price'));
  assert.ok(bad.includes('Product 1: campaign stock must be 0 or more'));
  assert.deepStrictEqual(plain(N.problems(request({ items: [] }))), ['No products to nominate']);
});

test("adds to Pending Submission exactly as Seller Centre's Add Products did", () => {
  assert.deepStrictEqual(plain(N.addBody(request(), 1793062831000)), {
    session_id: '130000000066788',
    preview_no: '',
    entity_list_data: {
      recruiting_entities: [{ entity_type: 2, product: { item_id: '21493849870', models: [{ item_id: '21493849870', model_id: '177897460416' }] } }],
    },
    fill_recommend_price: true,
    operate_start_time: 1793062831,
  });
});

test("reads each nomination id and Shopee's highest price, and flags a price above it", () => {
  const models = N.pendingModels(PREVIEW);
  assert.deepStrictEqual(plain(models.get('21493849870:177897460416')), { nominationId: '2900000003314176916', maxSen: 2989 });
  assert.deepStrictEqual(plain(N.pendingItems(PREVIEW)), ['21493849870']);
  assert.deepStrictEqual(plain(N.overMax(request(), models)), []);
  const over = request({ items: [{ itemId: '21493849870', models: [{ modelId: '177897460416', priceSen: 2990, originalPriceSen: 2990, stock: 4 }] }] });
  assert.deepStrictEqual(plain(N.overMax(over, models)), [{ itemId: '21493849870', modelId: '177897460416', priceSen: 2990, maxSen: 2989 }]);
});

test("edits to the seller's price and stock exactly as Seller Centre's Edit did", () => {
  const { body, missing } = N.editBody(request(), N.pendingModels(PREVIEW));
  assert.deepStrictEqual(plain(missing), []);
  assert.deepStrictEqual(plain(body), {
    session_id: '130000000066788',
    entity_type: 2,
    products: [
      {
        item_id: '21493849870',
        nomination_id: '2900000003314176916',
        model_id: '177897460416',
        campaign_price_type: 1,
        discount: '6.688963210702341',
        campaign_price: '2790000',
        campaign_stock: '4',
      },
    ],
  });
});

test('submits, and opens the session page', () => {
  assert.deepStrictEqual(plain(N.submitBody(request())), { session_id: '130000000066788', entity_type: 2, confirm_risky: false });
  assert.strictEqual(N.sessionUrl(request()), 'https://seller.shopee.com.my/portal/marketing/cmt-product/campaign/2048108187/session/130000000066788');
  assert.strictEqual(N.units(2790), '2790000');
});

test('the page relays only the nomination endpoints', () => {
  const src = fs.readFileSync(path.join(ROOT, 'content', 'interceptor.js'), 'utf8');
  const PAGE_API = eval(src.match(/const PAGE_API = (\/.*\/);/)[1]);
  for (const ok of [
    '/api/mkt/cmt/preview/add?SPC_CDS=x&SPC_CDS_VER=2',
    '/api/mkt/cmt/preview/preview_list',
    '/api/mkt/cmt/preview/submit_entity_online?SPC_CDS=x',
    '/api/mkt/cmt/nominated/edit_entity_online',
    '/api/mkt/cmt/nominated/nominated_entity_list?SPC_CDS=x',
  ]) assert.ok(PAGE_API.test(ok), ok);
  for (const no of [
    '/api/mkt/cmt/nominated/withdraw_entity',
    '/api/mkt/cmt/preview/delete',
    '/api/mkt/cmt/preview/add_more',
    'https://evil.example/api/mkt/cmt/preview/add',
    '/api/marketing/v4/voucher/create',
  ]) assert.ok(!PAGE_API.test(no), no);
});

// nominated_entity_list as Seller Centre answered it on 27 Oct 2026 (Nov 15 Mid-Month,
// Kiara 1598): the edit "succeeded" but two variations kept Shopee's price and No Limit.
const NOMINATED = {
  entity_list_data: {
    recruiting_entities: [
      {
        product: {
          item_id: '29067904151',
          models: [
            { item_id: '29067904151', model_id: '197984469939', model_name: 'Ash Brown,Free size', campaign_price: '2889000', campaign_stock: '6', reserved_stock: 0 },
            { item_id: '29067904151', model_id: '197984469938', model_name: 'Ash Grey,Free size', campaign_price: '3989000', campaign_stock: '0', reserved_stock: 0 },
          ],
        },
      },
    ],
  },
};

test("reads the Nominated tab back and names what is not at the seller's price and stock", () => {
  const req = {
    sessionId: '130000000066787',
    campaignId: '2048108187',
    items: [
      {
        itemId: '29067904151',
        models: [
          { modelId: '197984469939', priceSen: 2889, originalPriceSen: 3990, stock: 6 },
          { modelId: '197984469938', priceSen: 2889, originalPriceSen: 3990, stock: 0 },
        ],
      },
    ],
  };
  assert.deepStrictEqual(plain(N.nominatedListBody(req, 2)), { session_id: '130000000066787', entity_type: [2], entity_tab: 0, page_num: 2, page_size: 10 });
  const held = N.nominatedModels(NOMINATED);
  assert.deepStrictEqual(plain(held.get('29067904151:197984469938')), { name: 'Ash Grey,Free size', priceSen: 3989, stock: 0 });
  assert.deepStrictEqual(plain(N.notApplied(req, held)), [
    { itemId: '29067904151', modelId: '197984469938', name: 'Ash Grey,Free size', wantPriceSen: 2889, wantStock: 0, gotPriceSen: 3989, gotStock: 0 },
  ]);
  // Stock 0 is Shopee's No Limit, and goes as "0".
  assert.strictEqual(N.editBody(req, new Map([['29067904151:197984469938', { nominationId: '1', maxSen: 3989 }]])).body.products[0].campaign_stock, '0');
});

test("turns Shopee's failed_reason into readable lines, whatever its shape", () => {
  assert.deepStrictEqual(plain(N.reasons(null)), []);
  assert.deepStrictEqual(plain(N.reasons('price too low')), ['price too low']);
  assert.deepStrictEqual(plain(N.reasons([{ model_name: 'Ash Grey', reason: 'overlaps another campaign' }, 'x'])), ['Ash Grey: overlaps another campaign', 'x']);
});

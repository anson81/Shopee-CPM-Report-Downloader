/**
 * TikTok campaign list's pure part, checked against what Seller Center's
 * Campaigns page sent and got on 27 Oct 2026 (Queen Fashion Malaysia).
 *
 * Run: node tools/test-tiktok-campaigns.js
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
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'tiktok-campaigns.js'), 'utf8'), sandbox);
const T = sandbox.SRD_TikTokCampaigns;
const plain = (v) => JSON.parse(JSON.stringify(v));

// One parent and one sub-campaign, trimmed to the fields used, plus the kinds of field stripped.
const LIST = {
  campaigns_list: [
    {
      campaign_info: {
        campaign_id: '7685603301035394834',
        title: 'TikTok Shop Q4 2026 Campaigns Registration',
        cover: { uri: 'x' },
        language_field_map: { 'ms-MY': { campaign_name: 'TikTok Shop Pendaftaran Kempen' } },
      },
      is_invited: true,
      com_campaign_total_count: 1,
      com_campaigns_list: [
        {
          id: '7689310386373347078',
          title: '[BXP Sellers Co-Fund Voucher] 11.11 Mega Syok Sale & October Payday Sale',
          description: 'https://seller-my.tiktok.com/university/article?knowledge_id=1',
          registration_end_time: '1794326400000',
          has_joined: false,
          benefits: [{}, { benefit_type: 7, discount_percentage: { range_value: { max: '32', min: '7' } } }],
          app_cover: { thumb_url_list: ['https://p16-oec-sg.ibyteimg.com/x.jpeg?dr=1'] },
        },
      ],
    },
  ],
  total_count: 1,
};

test("asks for the list the way Seller Center's page does", () => {
  assert.deepStrictEqual(plain(T.listBody(2)), {
    page_index: 2,
    page_size: 20,
    is_available: true,
    is_registration_period: true,
    need_filter_short_term_campaign_visibility: true,
  });
  assert.strictEqual(
    T.listUrl('7494690219360291509'),
    '/api/v1/promotion/campaign/seller/parents_campaigns/list?locale=en&language=en&oec_seller_id=7494690219360291509&aid=4068&app_name=i18n_ecom_shop'
  );
});

test('keeps the campaigns, drops images, links and other languages', () => {
  const parents = plain(T.parentsOf(LIST));
  assert.strictEqual(parents.length, 1);
  assert.deepStrictEqual(parents[0].campaign_info, { campaign_id: '7685603301035394834', title: 'TikTok Shop Q4 2026 Campaigns Registration' });
  const sub = parents[0].com_campaigns_list[0];
  assert.strictEqual(sub.id, '7689310386373347078');
  assert.strictEqual(sub.description, undefined);
  assert.strictEqual(sub.app_cover, undefined);
  assert.deepStrictEqual(sub.benefits[1].discount_percentage.range_value, { max: '32', min: '7' });
  assert.strictEqual(T.subCount(parents), 1);
  assert.deepStrictEqual(plain(T.parentsOf(null)), []);
});

test('finds the seller id in the addresses the page has called', () => {
  assert.strictEqual(T.sellerIdFrom(['https://x/y', 'https://seller-my.tiktok.com/api/v1/a?locale=en&oec_seller_id=7494690219360291509&aid=4068']), '7494690219360291509');
  assert.strictEqual(T.sellerIdFrom(['https://seller-my.tiktok.com/api/v1/a?locale=en']), null);
});

test('the page relays only the campaign list (POST) and the criteria (GET)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'content', 'tiktok-interceptor.js'), 'utf8');
  const ALLOWED = eval('(' + src.match(/const ALLOWED = (\{[\s\S]*?\});/)[1] + ')');
  assert.ok(ALLOWED.POST.test(T.listUrl('1')));
  assert.ok(ALLOWED.GET.test(T.criteriaUrl('1', '2')));
  assert.ok(!ALLOWED.GET.test(T.listUrl('1')));
  assert.ok(!ALLOWED.POST.test(T.criteriaUrl('1', '2')));
  for (const no of [
    '/api/v1/promotion/campaign/seller/register',
    '/api/v1/promotion/campaign/seller/parents_campaigns/list_more',
    'https://evil.example/api/v1/promotion/campaign/seller/parents_campaigns/list',
    '/api/v1/promotion/activity/update',
    '/api/v1/promotion/campaign/seller/get_more?x=1',
    'https://evil.example/api/v1/promotion/campaign/seller/get?x=1',
  ]) {
    assert.ok(!ALLOWED.POST.test(no), no);
    assert.ok(!ALLOWED.GET.test(no), no);
  }
});

test('summarises a run in one line', () => {
  assert.strictEqual(T.summary({ campaigns: 6 }), 'TikTok campaigns: 6 sent to ProfitLens');
  assert.strictEqual(T.summary({ error: 'Not logged in to TikTok Seller Center' }), 'TikTok campaigns: Not logged in to TikTok Seller Center');
});

// The Criteria tab's answer for October New Arrivals, 28 Oct 2026, trimmed.
const CRITERIA = {
  registration_criteria: {
    registration_criteria_desc: [
      {
        criteria_category: 'Campaign sale price',
        criteria_type: 1,
        criteria_desc_detail: [
          {
            desc_format: 'Campaign price must be at least {{value1}}% off the retail price.',
            desc_param: [
              { param_key: 'starling_arr', param_value: '["promotion_product_campaign_detail_campaign_discount_range"]' },
              { param_key: 'comparator', param_value: 'less than' },
              { param_key: 'wrapper_operate_factor', param_value: '0.8' },
              { param_key: 'factor_percent_off', param_value: '20' },
              { param_key: 'value1', param_value: '20' },
            ],
            product_tier: 2,
          },
          { desc_format: 'Campaign price must be at least {{value1}}% off the retail price.', desc_param: [{ param_key: 'value1', param_value: '20' }, { param_key: 'factor_percent_off', param_value: '20' }] },
        ],
      },
      { criteria_category: '', criteria_type: 2, criteria_desc_detail: [{ desc_format: 'Only invited shops can register for this campaign', desc_param: [] }] },
    ],
  },
};

test('criteriaOf: the price rules in the Criteria tab words, with the % off retail', () => {
  assert.deepStrictEqual(plain(T.criteriaOf(CRITERIA)), [
    { category: 'Campaign sale price', text: 'Campaign price must be at least 20% off the retail price.', percentOff: 20 },
  ]);
});

test('criteriaOf: a rule with no % off, a slot left unfilled, and nothing at all', () => {
  const data = {
    registration_criteria: {
      registration_criteria_desc: [
        {
          criteria_category: 'Campaign sale price',
          criteria_type: 1,
          criteria_desc_detail: [
            { desc_format: 'Campaign price must be lower than retail price', desc_param: [{ param_key: 'comparator', param_value: 'less than' }] },
            { desc_format: 'Paid in the past {{value2}} days, {{other}}', desc_param: [{ param_key: 'value2', param_value: '14' }] },
          ],
        },
      ],
    },
  };
  assert.deepStrictEqual(plain(T.criteriaOf(data)), [
    { category: 'Campaign sale price', text: 'Campaign price must be lower than retail price', percentOff: null },
    { category: 'Campaign sale price', text: 'Paid in the past 14 days, {{other}}', percentOff: null },
  ]);
  assert.deepStrictEqual(plain(T.criteriaOf(null)), []);
  assert.deepStrictEqual(plain(T.criteriaOf({})), []);
});

test('criteriaUrl and subIds', () => {
  assert.strictEqual(
    T.criteriaUrl('7494690219360291509', '7686147017822816007'),
    '/api/v1/promotion/campaign/seller/get?locale=en&language=en&oec_seller_id=7494690219360291509&aid=4068&app_name=i18n_ecom_shop&sub_campaign_id=7686147017822816007'
  );
  assert.deepStrictEqual(plain(T.subIds(T.parentsOf(LIST))), ['7689310386373347078']);
});

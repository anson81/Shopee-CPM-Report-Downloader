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

test('the page relays only the campaign list', () => {
  const src = fs.readFileSync(path.join(ROOT, 'content', 'tiktok-interceptor.js'), 'utf8');
  const ALLOWED = eval(src.match(/const ALLOWED = (\/.*\/);/)[1]);
  assert.ok(ALLOWED.test(T.listUrl('1')));
  for (const no of [
    '/api/v1/promotion/campaign/seller/register',
    '/api/v1/promotion/campaign/seller/parents_campaigns/list_more',
    'https://evil.example/api/v1/promotion/campaign/seller/parents_campaigns/list',
    '/api/v1/promotion/activity/update',
  ]) assert.ok(!ALLOWED.test(no), no);
});

test('summarises a run in one line', () => {
  assert.strictEqual(T.summary({ campaigns: 6 }), 'TikTok campaigns: 6 sent to ProfitLens');
  assert.strictEqual(T.summary({ error: 'Not logged in to TikTok Seller Center' }), 'TikTok campaigns: Not logged in to TikTok Seller Center');
});

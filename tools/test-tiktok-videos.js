/**
 * TikTok video links' pure part, checked against what Seller Center's
 * Analytics → Video → Details sent and got on 30 Oct 2026 (Queen Fashion Malaysia).
 *
 * Run: node tools/test-tiktok-videos.js
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
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'tiktok-videos.js'), 'utf8'), sandbox);
const V = sandbox.SRD_TikTokVideos;
const plain = (v) => JSON.parse(JSON.stringify(v));

// 30 Oct 2026, 13:00 in Malaysia.
const NOW = Date.parse('2026-10-30T05:00:00Z');

test('asks for the last 28 days, the way the page does, with the page\'s own figures', () => {
  const body = plain(V.listBody([3], 2, NOW));
  const p = body.request.params[0];
  assert.deepStrictEqual(p.time_descriptor, { start: '2026-10-02', end: '2026-10-30', timezone_offset: 28800, scenario: 4, granularity: '28D', with_previous_period: false });
  assert.deepStrictEqual(p.filter, { author_type: [3] });
  assert.deepStrictEqual(p.list_control.pagination, { size: 100, page: 2 });
  // Fewer figures and the answer carries no video addresses.
  assert.ok(p.stats_types.length >= 13);
});

test('the day turns at midnight in Malaysia, not UTC', () => {
  // 30 Oct 23:30 UTC is 31 Oct in Malaysia.
  assert.deepStrictEqual(plain(V.window28(Date.parse('2026-10-30T23:30:00Z'))), { start: '2026-10-03', end: '2026-10-31' });
});

test('the address carries the seller id and no signatures', () => {
  const u = V.listUrl('7494690219360291509');
  assert.ok(u.startsWith('/api/v2/insights/seller/shop/video/analytics/video/list?'));
  assert.ok(u.includes('oec_seller_id=7494690219360291509'));
  assert.ok(!/X-Bogus|msToken/.test(u));
});

test('takes each video\'s play address and when it expires; skips rows without one', () => {
  const answer = {
    code: 0,
    data: {
      segments: [
        {
          list_control: { next_pagination: { has_more: true, next_page: 1, total: 1509 } },
          timed_lists: [
            {
              stats: [
                {
                  video_meta: {
                    id: '7538793947800325383',
                    video: {
                      id: 'v0',
                      video_infos: [
                        {
                          main_url: 'https://v16m.tiktokcdn.com/abc/6ae5913c/video/tos/alisg/x/?a=1180&mime_type=video_mp4',
                          backup_url: 'https://v19m.tiktokcdn.com/abc/6ae5913c/video/tos/alisg/x/?a=1180',
                          url_expire: 1793429820,
                          width: 576,
                          height: 1024,
                          size: 1152229,
                        },
                      ],
                    },
                  },
                },
                { video_meta: { id: '7532499735890906376', video: {} } },
                { video_meta: { id: '1', video: { video_infos: [{ main_url: 'https://evil.example.com/x.mp4', url_expire: 1 }] } } },
              ],
            },
          ],
        },
      ],
    },
  };
  const got = plain(V.linksOf(answer));
  assert.strictEqual(got.hasMore, true);
  assert.strictEqual(got.rows, 3);
  assert.deepStrictEqual(got.links, [
    {
      videoId: '7538793947800325383',
      url: 'https://v16m.tiktokcdn.com/abc/6ae5913c/video/tos/alisg/x/?a=1180&mime_type=video_mp4',
      backupUrl: 'https://v19m.tiktokcdn.com/abc/6ae5913c/video/tos/alisg/x/?a=1180',
      expiresAt: '2026-10-31T06:57:00.000Z',
      width: 576,
      height: 1024,
      size: 1152229,
    },
  ]);
});

test('an empty answer is no links, not an error', () => {
  assert.deepStrictEqual(plain(V.linksOf({ code: 0, data: { segments: [] } })), { links: [], rows: 0, hasMore: false });
  assert.deepStrictEqual(plain(V.linksOf(null)), { links: [], rows: 0, hasMore: false });
});

test('one line for the popup', () => {
  assert.strictEqual(V.summary({ videos: 1776 }), 'TikTok video links: 1776 sent to ProfitLens');
  assert.strictEqual(V.summary({ error: 'Not logged in to TikTok Seller Center' }), 'TikTok video links: Not logged in to TikTok Seller Center');
});

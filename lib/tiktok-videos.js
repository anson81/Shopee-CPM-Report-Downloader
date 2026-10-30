/**
 * TikTok video links — the pure part.
 *
 * tiktok.com will not play some videos in a browser — a creator's selling
 * video that is also used in ads answers with an empty play address
 * (checked 30 Oct 2026: @ecahzaaim88's 15 Aug 2025 knitwear video, in its
 * own page and in both embed players). Seller Center's Analytics → Video →
 * Details plays them, from one same-origin call, recorded 30 Oct 2026:
 *
 *   POST /api/v2/insights/seller/shop/video/analytics/video/list
 *   { request: { params: [{ time_descriptor, filter: { author_type },
 *     list_control: { rules, pagination: { size, page } }, stats_types }] } }
 *
 * author_type [3] is creators (Affiliate accounts), [1, 2] the shop's own
 * (Linked accounts). Each row's video_meta.video.video_infos[] carries a
 * signed tiktokcdn.com address that plays without a sign-in for 24 hours
 * (url_expire, seconds). The addresses come back only when stats_types is the
 * page's own list — with fewer, video_infos is empty. 28D is the longest
 * window the call takes (30D answers code 28001001).
 *
 * content/tiktok.js makes the call; this file shapes what comes back so
 * ProfitLens can store it (POST /api/import/tiktok-video-links). Read-only.
 * A plain script attaching to `self`, like lib/tiktok-campaigns.js.
 */
(function (root) {
  'use strict';

  const LIST_PATH = '/api/v2/insights/seller/shop/video/analytics/video/list';
  const PAGE_SIZE = 100;
  const MAX_PAGES = 20;
  const DAYS = 28;
  const STATS_TYPES = [2, 6, 3, 5, 8, 100, 80, 63, 65, 203, 20, 60, 61, 420];
  const AUTHORS = { creators: [3], own: [1, 2] };

  function listUrl(sellerId) {
    return `${LIST_PATH}?locale=en&language=en&oec_seller_id=${encodeURIComponent(sellerId)}&aid=4068&app_name=i18n_ecom_shop&use_content_type_definition=1`;
  }

  /** YYYY-MM-DD in Malaysian time. */
  function myDay(ms) {
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }

  /** The last 28 whole days before today, Malaysian time — what the page calls "Last 28 days". */
  function window28(now) {
    const end = myDay(now);
    const start = new Date(Date.parse(`${end}T00:00:00Z`) - DAYS * 86400 * 1000).toISOString().slice(0, 10);
    return { start, end };
  }

  function listBody(authorType, page, now) {
    const { start, end } = window28(now);
    return {
      request: {
        params: [
          {
            time_descriptor: { start, end, timezone_offset: 28800, scenario: 4, granularity: `${DAYS}D`, with_previous_period: false },
            filter: { author_type: authorType },
            list_control: {
              rules: [{ direction: 2, field: 'SHOP_VIDEO_ANALYTICS_VIDEO_LIST_REVENUE' }],
              pagination: { size: PAGE_SIZE, page },
            },
            stats_types: STATS_TYPES,
          },
        ],
      },
    };
  }

  const CDN = /^https:\/\/[a-z0-9.-]+\.tiktokcdn(-[a-z]+)?\.com\//i;

  /** { links: [{ videoId, url, backupUrl, expiresAt, width, height, size }], hasMore } from one answer. */
  function linksOf(json) {
    const seg = json && json.data && json.data.segments && json.data.segments[0];
    const rows = (seg && seg.timed_lists && seg.timed_lists[0] && seg.timed_lists[0].stats) || [];
    const links = [];
    for (const r of rows) {
      const meta = r && r.video_meta;
      const info = meta && meta.video && (meta.video.video_infos || [])[0];
      if (!meta || !meta.id || !info || !CDN.test(String(info.main_url || ''))) continue;
      const expire = Number(info.url_expire);
      links.push({
        videoId: String(meta.id),
        url: info.main_url,
        backupUrl: CDN.test(String(info.backup_url || '')) ? info.backup_url : null,
        expiresAt: Number.isFinite(expire) && expire > 0 ? new Date(expire * 1000).toISOString() : null,
        width: Number(info.width) || null,
        height: Number(info.height) || null,
        size: Number(info.size) || null,
      });
    }
    const pg = seg && seg.list_control && seg.list_control.next_pagination;
    return { links, rows: rows.length, hasMore: !!(pg && pg.has_more) };
  }

  function summary(result) {
    if (!result) return '';
    if (result.error) return `TikTok video links: ${result.error}`;
    return `TikTok video links: ${result.videos} sent to ProfitLens`;
  }

  root.SRD_TikTokVideos = { LIST_PATH, PAGE_SIZE, MAX_PAGES, DAYS, STATS_TYPES, AUTHORS, listUrl, window28, listBody, linksOf, summary };
})(typeof self !== 'undefined' ? self : globalThis);

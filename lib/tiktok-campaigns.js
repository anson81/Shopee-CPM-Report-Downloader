/**
 * TikTok Shop campaign list — the pure part.
 *
 * TikTok's Partner API has no list of the platform campaigns a shop may join.
 * Seller Center's Campaigns page (Marketing → Campaigns → Register for
 * campaigns) is fed by one same-origin call, recorded 27 Oct 2026:
 *
 *   POST /api/v1/promotion/campaign/seller/parents_campaigns/list
 *   { page_index, page_size, is_available: true, is_registration_period: true,
 *     need_filter_short_term_campaign_visibility: true }
 *
 * answering { code: 0, data: { campaigns_list: [...], total_count } }. Each
 * entry is a parent ("TikTok Shop Q4 2026 Campaigns Registration") with its
 * sub-campaigns in com_campaigns_list — those are what a seller registers for.
 * content/tiktok.js makes the call; this file shapes what comes back so
 * ProfitLens can store it (POST /api/import/tiktok-campaigns). Read-only.
 *
 * The list does not carry a campaign's own price rules ("Campaign price must
 * be at least 20% off the retail price"). The campaign page's Criteria tab is
 * fed by a second call, recorded 28 Oct 2026:
 *
 *   GET /api/v1/promotion/campaign/seller/get?sub_campaign_id=…
 *
 * answering data.registration_criteria.registration_criteria_desc[] — each
 * { criteria_category, criteria_type, criteria_desc_detail: [{ desc_format,
 * desc_param: [{ param_key, param_value }] }] }. desc_format has {{value1}}
 * slots filled from desc_param; "at least N% off" carries factor_percent_off.
 * criteria_type 1 is a price or stock rule, 2 who may register.
 *
 * A plain script attaching to `self`, like lib/campaigns.js.
 */
(function (root) {
  'use strict';

  const PAGE_SIZE = 20;
  const MAX_PAGES = 10;
  const LIST_PATH = '/api/v1/promotion/campaign/seller/parents_campaigns/list';

  /** The body Seller Center's own page sends, at a bigger page. */
  function listBody(pageIndex) {
    return {
      page_index: pageIndex,
      page_size: PAGE_SIZE,
      is_available: true,
      is_registration_period: true,
      need_filter_short_term_campaign_visibility: true,
    };
  }

  /** Images, links and the other languages — never sent on. */
  const DROP = /cover|image|thumb|icon|banner|url|link|language_field_map/i;

  function strip(node) {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (DROP.test(k)) continue;
      // The description is a link to a TikTok doc, not text.
      if (typeof v === 'string' && /^https?:\/\//i.test(v)) continue;
      out[k] = strip(v);
    }
    return out;
  }

  /** Parent campaigns in one list answer, stripped. */
  function parentsOf(data) {
    return ((data && data.campaigns_list) || []).map(strip);
  }

  /** Sub-campaigns across parents — what the seller registers for. */
  function subCount(parents) {
    return parents.reduce((n, p) => n + ((p && p.com_campaigns_list) || []).length, 0);
  }

  /** The shop's seller id, from any Seller Center API address the page has called. */
  function sellerIdFrom(urls) {
    for (const u of urls || []) {
      const m = /[?&]oec_seller_id=(\d{6,25})(?:&|$)/.exec(String(u));
      if (m) return m[1];
    }
    return null;
  }

  /** The list request's address — the same query the page sends, minus its signatures. */
  function listUrl(sellerId) {
    return `${LIST_PATH}?locale=en&language=en&oec_seller_id=${encodeURIComponent(sellerId)}&aid=4068&app_name=i18n_ecom_shop`;
  }

  const CRITERIA_PATH = '/api/v1/promotion/campaign/seller/get';

  /** The criteria request's address for one sub-campaign. */
  function criteriaUrl(sellerId, subCampaignId) {
    return `${CRITERIA_PATH}?locale=en&language=en&oec_seller_id=${encodeURIComponent(sellerId)}&aid=4068&app_name=i18n_ecom_shop&sub_campaign_id=${encodeURIComponent(subCampaignId)}`;
  }

  /**
   * A sub-campaign's price and stock rules, as the Criteria tab words them:
   * [{ category, text, percentOff }], each line once. percentOff is the
   * "at least N% off the retail price" figure, else null.
   */
  function criteriaOf(data) {
    const out = [];
    const seen = new Set();
    const groups = (data && data.registration_criteria && data.registration_criteria.registration_criteria_desc) || [];
    for (const g of groups) {
      if (!g || Number(g.criteria_type) !== 1) continue;
      for (const d of g.criteria_desc_detail || []) {
        if (!d || typeof d.desc_format !== 'string') continue;
        const params = {};
        for (const p of d.desc_param || []) if (p && p.param_key) params[p.param_key] = p.param_value;
        const text = d.desc_format.replace(/\{\{(\w+)\}\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m)).trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        const pct = Number(params.factor_percent_off);
        out.push({ category: String(g.criteria_category || ''), text, percentOff: Number.isFinite(pct) && pct > 0 && pct < 100 ? pct : null });
      }
    }
    return out;
  }

  /** Sub-campaign ids across parents. */
  function subIds(parents) {
    const ids = [];
    for (const p of parents || []) for (const s of (p && p.com_campaigns_list) || []) if (s && s.id) ids.push(String(s.id));
    return ids;
  }

  /** One line for the popup and the run record. */
  function summary(result) {
    if (!result) return '';
    if (result.error) return `TikTok campaigns: ${result.error}`;
    return `TikTok campaigns: ${result.campaigns} sent to ProfitLens`;
  }

  root.SRD_TikTokCampaigns = { PAGE_SIZE, MAX_PAGES, LIST_PATH, CRITERIA_PATH, listBody, strip, parentsOf, subCount, sellerIdFrom, listUrl, criteriaUrl, criteriaOf, subIds, summary };
})(typeof self !== 'undefined' ? self : globalThis);

/**
 * Shopee campaign calendar — the pure part.
 *
 * Shopee's Open Platform API has no campaign calendar (checked 21 Oct 2026).
 * Seller Centre's own campaign page is fed by two same-origin JSON calls, and
 * content/content.js makes those same calls; this file shapes what comes back
 * so ProfitLens can store it (POST /api/import/shopee-campaigns).
 *
 * A plain script attaching to `self`, like lib/diagnostics.js, so the content
 * script, the service worker and tools/test-campaigns.js can all load it.
 */
(function (root) {
  'use strict';

  /** Fields that are links or a Shopee staff member's email — never sent on. */
  const DROP = ['url', 'creator', 'banner', 'app_banner', 'square_banner'];

  function stripCampaign(c) {
    const out = {};
    for (const [k, v] of Object.entries(c || {})) {
      if (!DROP.includes(k)) out[k] = v;
    }
    return out;
  }

  /**
   * Every session in a get_session_list answer, whatever its layout.
   *
   * Seen on 21 Oct 2026 in two shapes: Big Campaigns put them in
   * data.general.product_session[]; Shocking Sale and Limited Time Deals group
   * them by day in data.list[].product_session[]. Voucher sessions may sit
   * beside product ones. So: any object carrying a session_id, at any depth,
   * counted once.
   */
  function flattenSessions(data) {
    const found = new Map();
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 6) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }
      if (node.session_id != null) {
        const key = String(node.session_id);
        if (!found.has(key)) found.set(key, node);
        return;
      }
      for (const v of Object.values(node)) walk(v, depth + 1);
    };
    walk(data, 0);
    return [...found.values()];
  }

  /** Batches small enough for ProfitLens's 2 MB request limit. */
  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  /** One line for the popup and the run history. */
  function summary(result) {
    if (!result) return '';
    if (result.error) return `Campaigns: ${result.error}`;
    const sessions = result.sessions ?? 0;
    return `Campaigns: ${result.campaigns} sent to ProfitLens (${sessions} session${sessions === 1 ? '' : 's'})`;
  }

  root.SRD_Campaigns = { stripCampaign, flattenSessions, chunk, summary, DROP };
})(typeof self !== 'undefined' ? self : globalThis);

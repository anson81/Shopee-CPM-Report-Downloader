/**
 * CPM Voucher Hack — the pure part.
 *
 * ProfitLens plans four Shopee product vouchers for one listing and hands them
 * to this extension; content/content.js creates them through Seller Centre's
 * own endpoint (POST /api/marketing/v3/voucher/) on the seller's signed-in
 * session. This file decides what is allowed and what Shopee is sent.
 *
 * Deliberately narrow: PRODUCT vouchers only (usecase 2), fixed RM amounts,
 * one per buyer, future dates, at most four at a time. It never edits, ends or
 * deletes a voucher — those endpoints are not called anywhere.
 *
 * A plain script attaching to `self`, like lib/campaigns.js, so the content
 * script, the service worker and tools/test-vouchers.js can all load it.
 */
(function (root) {
  'use strict';

  const MAX_VOUCHERS = 4;
  const MAX_QUANTITY = 10000;
  const MAX_AMOUNT_SEN = 100000;
  /** Seller Centre's code is its shop prefix ("QFMW") + 1–5 letters or digits. */
  const CODE = /^[A-Z0-9]{1,5}$/;

  const isId = (v) => /^\d{5,20}$/.test(String(v));

  /**
   * Every reason the request must not be sent, in words. An empty list is the
   * only way through.
   */
  function problems(request, now = Date.now()) {
    const out = [];
    const vouchers = request && request.vouchers;
    if (!Array.isArray(vouchers) || vouchers.length === 0) return ['No vouchers to create'];
    if (vouchers.length > MAX_VOUCHERS) out.push(`At most ${MAX_VOUCHERS} vouchers at a time`);
    if (!Array.isArray(request.itemIds) || request.itemIds.length === 0 || !request.itemIds.every(isId)) {
      out.push('The product (Shopee item id) is missing');
    }
    const codes = new Set();
    vouchers.forEach((v, i) => {
      const n = `Voucher ${i + 1}`;
      if (!v.name || String(v.name).length > 100) out.push(`${n}: name must be 1–100 characters`);
      if (!CODE.test(String(v.code || ''))) out.push(`${n}: code must be 1–5 letters or digits`);
      if (codes.has(v.code)) out.push(`${n}: code ${v.code} is used twice`);
      codes.add(v.code);
      const start = Date.parse(v.startAt);
      const end = Date.parse(v.endAt);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) out.push(`${n}: dates are wrong`);
      else if (start < now) out.push(`${n}: starts in the past`);
      if (!Number.isInteger(v.quantity) || v.quantity < 1 || v.quantity > MAX_QUANTITY) out.push(`${n}: quantity must be 1–${MAX_QUANTITY}`);
      if (!Number.isInteger(v.amountSen) || v.amountSen < 1 || v.amountSen > MAX_AMOUNT_SEN) out.push(`${n}: amount is wrong`);
    });
    return out;
  }

  const ringgit = (sen) => (sen / 100).toFixed(2);
  const seconds = (iso) => Math.floor(Date.parse(iso) / 1000);

  /**
   * The body Seller Centre's form sends to create one product voucher.
   *
   * Field names and shape from a voucher read back from the same endpoint
   * (GET /api/marketing/v3/voucher/, "606 VC1", 26 Oct 2026): a fixed-amount,
   * seller-funded product voucher on one listing, no minimum spend, one per
   * buyer, shown on all pages and shown before it starts.
   */
  function payload(voucher, itemIds) {
    const start = seconds(voucher.startAt);
    return {
      name: voucher.name,
      voucher_code: voucher.code,
      start_time: start,
      end_time: seconds(voucher.endAt),
      discount: 0,
      value: ringgit(voucher.amountSen),
      max_value: '0.00',
      min_price: '0.00',
      usage_quantity: voucher.quantity,
      rule: {
        items: itemIds.map((id) => ({ itemid: Number(id) })),
        hide: false,
        voucher_landing_page: 1,
        reward_type: 0,
        choose_users: { shop_order_count: 0, shop_order_count_period: 0 },
        display_from: Math.floor(Date.now() / 1000),
        display_voucher_early: true,
        usage_limit_per_user: 1,
        is_seller_absorbed: true,
        usecase: 2
      }
    };
  }

  /** One line for the popup and the page. */
  function summary(results) {
    const made = results.filter((r) => r.ok).length;
    const failed = results.find((r) => r.error);
    if (!failed) return `${made} voucher${made === 1 ? '' : 's'} created`;
    return `${made} created, then stopped: ${failed.error}`;
  }

  root.SRD_Vouchers = { problems, payload, summary, MAX_VOUCHERS, CODE };
})(typeof self !== 'undefined' ? self : globalThis);

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

  const seconds = (iso) => Math.floor(Date.parse(iso) / 1000);

  /**
   * The shop's code prefix: Seller Centre puts the first four letters or digits
   * of the shop's login name in front of every code ("qfmwholesales" -> QFMW),
   * and the code must be SENT with it.
   */
  function codePrefix(username) {
    return String(username || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
  }

  /**
   * The body Seller Centre's own form sends to create a product voucher —
   * captured from a real create on 26 Oct 2026 ("TEST A606 VC", voucher
   * 1539581213822976), not modelled: the full code with its prefix, amounts as
   * numbers, the product list in `rule.items` (which is what makes it a product
   * voucher — there is no type field). Shown early, as Anson's own were.
   */
  function payload(voucher, itemIds, prefix, now = Date.now()) {
    return {
      name: voucher.name,
      voucher_code: `${prefix}${voucher.code}`,
      start_time: seconds(voucher.startAt),
      end_time: seconds(voucher.endAt),
      discount: null,
      value: voucher.amountSen / 100,
      max_value: null,
      min_price: 0,
      usage_quantity: voucher.quantity,
      rule: {
        usage_limit_per_user: 1,
        items: itemIds.map((id) => ({ itemid: Number(id) })),
        coin_cashback_voucher: { coin_percentage_real: null, max_coin: null },
        voucher_landing_page: 1,
        display_from: Math.floor(now / 1000),
        exclusive_channel_type: null,
        hide: 0,
        reward_type: 0,
        backend_created: 0,
        display_voucher_early: true,
        choose_users: { shop_order_count: 0, shop_order_count_period: 0 }
      }
    };
  }

  /**
   * The planned codes Shopee already has, without the prefix. Seller Centre
   * refuses a code that exists ("voucher prefix already exist"), and one
   * product can be several listings — 3289 on two listings planned 32891 twice.
   */
  function takenCodes(existing, vouchers, prefix) {
    const have = new Set((existing || []).map((c) => String(c || '').toUpperCase()));
    return vouchers.map((v) => v.code).filter((code) => have.has(`${prefix}${code}`.toUpperCase()));
  }

  /** One line for the popup and the page. */
  function summary(results) {
    const made = results.filter((r) => r.ok).length;
    const failed = results.find((r) => r.error);
    if (!failed) return `${made} voucher${made === 1 ? '' : 's'} created`;
    return `${made} created, then stopped: ${failed.error}`;
  }

  root.SRD_Vouchers = { problems, payload, codePrefix, takenCodes, summary, MAX_VOUCHERS, CODE };
})(typeof self !== 'undefined' ? self : globalThis);

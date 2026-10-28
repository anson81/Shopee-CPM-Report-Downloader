/**
 * Campaign nomination — the pure part.
 *
 * ProfitLens prices the ticked listings for one Shopee campaign session and
 * hands them here; content/content.js nominates them through Seller Centre's
 * own requests, in the order its page makes them (recorded 27 Oct 2026, Nov 25
 * Payday Sale, Aprilia 1318):
 *
 *   1. POST /api/mkt/cmt/preview/add              — into Pending Submission,
 *      Shopee filling its recommended price (fill_recommend_price)
 *   2. POST /api/mkt/cmt/preview/preview_list     — read back: each variation's
 *      nomination_id and Shopee's highest allowed campaign price
 *   3. POST /api/mkt/cmt/preview/submit_entity_online — submits EVERYTHING
 *      pending, which is why nothing else may be pending
 *   4. POST /api/mkt/cmt/nominated/edit_entity_online — the seller's own price
 *      and campaign stock on each nomination
 *   5. POST /api/mkt/cmt/nominated/nominated_entity_list — read back. On 27 Oct
 *      2026 the edit answered success yet left 2 of 3 variations at Shopee's
 *      price, so "done" is decided by what the Nominated tab holds, not by it.
 *
 * Campaign stock "0" is Shopee's "No Limit": nothing set aside
 * (`reserved_stock` 0). Any other number is set aside for the session.
 *
 * Prices go in units of 1/100,000 ringgit, as strings ("2790000" = RM 27.90).
 * It never withdraws or deletes a nomination.
 *
 * A plain script attaching to `self`, like lib/vouchers.js.
 */
(function (root) {
  'use strict';

  const MAX_ITEMS = 50;
  const isId = (v) => /^\d{5,20}$/.test(String(v));
  const isModelId = (v) => /^\d{1,20}$/.test(String(v)); // 0 for a listing without variations

  /** Sen → Seller Centre's price units. */
  const units = (sen) => String(Math.round(sen) * 1000);

  /** Every reason the request must not be sent. Empty is the only way through. */
  function problems(request) {
    const out = [];
    if (!request || !isId(request.sessionId)) out.push('The campaign session is missing');
    if (!request || !isId(request.campaignId)) out.push('The campaign is missing');
    const items = request && request.items;
    if (!Array.isArray(items) || items.length === 0) return out.concat('No products to nominate');
    if (items.length > MAX_ITEMS) out.push(`At most ${MAX_ITEMS} products at a time`);
    items.forEach((it, i) => {
      const n = `Product ${i + 1}`;
      if (!isId(it.itemId)) out.push(`${n}: the Shopee item id is missing`);
      if (!Array.isArray(it.models) || it.models.length === 0) out.push(`${n}: no variations`);
      (it.models || []).forEach((m) => {
        if (!isModelId(m.modelId)) out.push(`${n}: a variation id is missing`);
        if (!Number.isInteger(m.priceSen) || m.priceSen <= 0) out.push(`${n}: a price is missing`);
        if (!Number.isInteger(m.originalPriceSen) || m.originalPriceSen <= 0) out.push(`${n}: the original price is missing`);
        else if (m.priceSen > m.originalPriceSen) out.push(`${n}: a price is above the listed price`);
        if (!Number.isInteger(m.stock) || m.stock < 0) out.push(`${n}: campaign stock must be 0 or more`);
      });
    });
    return out;
  }

  /** Step 1 — exactly the shape Seller Centre's "Add Products" sends. */
  function addBody(request, nowMs = Date.now()) {
    return {
      session_id: String(request.sessionId),
      preview_no: '',
      entity_list_data: {
        recruiting_entities: request.items.map((it) => ({
          entity_type: 2,
          product: {
            item_id: String(it.itemId),
            models: it.models.map((m) => ({ item_id: String(it.itemId), model_id: String(m.modelId) })),
          },
        })),
      },
      fill_recommend_price: true,
      operate_start_time: Math.floor(nowMs / 1000),
    };
  }

  /** Item ids pending in a preview_list answer. */
  function pendingItems(previewData) {
    const list = (previewData && previewData.entity_list_data && previewData.entity_list_data.recruiting_entities) || [];
    return list.filter((e) => e && e.product).map((e) => String(e.product.item_id));
  }

  /** Per "itemId:modelId": nomination id and Shopee's highest allowed price, from a preview_list answer. */
  function pendingModels(previewData) {
    const out = new Map();
    const list = (previewData && previewData.entity_list_data && previewData.entity_list_data.recruiting_entities) || [];
    for (const e of list) {
      for (const m of (e && e.product && e.product.models) || []) {
        const max = m.pricing_application_info && m.pricing_application_info.max_campaign_entry_price;
        out.set(`${m.item_id}:${m.model_id}`, {
          nominationId: m.nomination_id ? String(m.nomination_id) : null,
          maxSen: max ? Math.floor(Number(max) / 1000) : null,
        });
      }
    }
    return out;
  }

  /** Prices above Shopee's highest allowed campaign price for that variation. */
  function overMax(request, models) {
    const out = [];
    for (const it of request.items) {
      for (const m of it.models) {
        const p = models.get(`${it.itemId}:${m.modelId}`);
        if (p && p.maxSen && m.priceSen > p.maxSen) out.push({ itemId: String(it.itemId), modelId: String(m.modelId), priceSen: m.priceSen, maxSen: p.maxSen });
      }
    }
    return out;
  }

  /**
   * Step 4 — the seller's price and stock on each nomination, as Seller Centre's Edit sends it.
   * Sent one variation per request (`editBodies`): on 27 Oct 2026 a request carrying all of a
   * product's variations set only one of them (Kiara 1598: 1 of 3, Leesa 3381: 1 of 9).
   */
  function editBody(request, models) {
    const products = [];
    const missing = [];
    for (const it of request.items) {
      for (const m of it.models) {
        const p = models.get(`${it.itemId}:${m.modelId}`);
        if (!p || !p.nominationId) {
          missing.push(`${it.itemId}:${m.modelId}`);
          continue;
        }
        products.push({
          item_id: String(it.itemId),
          nomination_id: p.nominationId,
          model_id: String(m.modelId),
          campaign_price_type: 1,
          discount: String(((m.originalPriceSen - m.priceSen) / m.originalPriceSen) * 100),
          campaign_price: units(m.priceSen),
          campaign_stock: String(m.stock),
        });
      }
    }
    return { body: { session_id: String(request.sessionId), entity_type: 2, products }, missing };
  }

  /** editBody split into one request per variation. */
  function editBodies(request, models) {
    const { body, missing } = editBody(request, models);
    return { bodies: body.products.map((p) => ({ ...body, products: [p] })), missing };
  }

  /** Step 5 — the page Seller Centre's Nominated tab asks for (page_num from 1). */
  function nominatedListBody(request, pageNum, pageSize = 10) {
    return { session_id: String(request.sessionId), entity_type: [2], entity_tab: 0, page_num: pageNum, page_size: pageSize };
  }

  /**
   * The products in a nominated_entity_list answer. They sit at data.recruiting_entities —
   * unlike preview_list's data.entity_list_data.recruiting_entities, which the first read-back
   * assumed and so found nothing.
   */
  function nominatedEntities(listData) {
    if (!listData) return [];
    return listData.recruiting_entities || (listData.entity_list_data && listData.entity_list_data.recruiting_entities) || [];
  }

  /** Per "itemId:modelId" from a nominated_entity_list answer: name, price (sen) and campaign stock. */
  function nominatedModels(listData) {
    const out = new Map();
    for (const e of nominatedEntities(listData)) {
      for (const m of (e && e.product && e.product.models) || []) {
        out.set(`${m.item_id}:${m.model_id}`, {
          name: m.model_name || '',
          priceSen: Math.round(Number(m.campaign_price) / 1000),
          stock: Number(m.campaign_stock) || 0,
        });
      }
    }
    return out;
  }

  /** Variations the Nominated tab does not hold at the seller's price and stock. */
  function notApplied(request, nominated) {
    const out = [];
    for (const it of request.items) {
      for (const m of it.models) {
        const got = nominated.get(`${it.itemId}:${m.modelId}`);
        if (!got || got.priceSen !== m.priceSen || got.stock !== m.stock) {
          out.push({
            itemId: String(it.itemId),
            modelId: String(m.modelId),
            name: got ? got.name : '',
            wantPriceSen: m.priceSen,
            wantStock: m.stock,
            gotPriceSen: got ? got.priceSen : null,
            gotStock: got ? got.stock : null,
          });
        }
      }
    }
    return out;
  }

  /** Shopee's failed_reason, whatever its shape, as short readable lines. */
  function reasons(failed) {
    const list = Array.isArray(failed) ? failed : failed ? [failed] : [];
    return list
      .map((r) => {
        if (r === null || r === undefined) return '';
        if (typeof r !== 'object') return String(r);
        const who = r.model_name || r.item_name || r.model_id || r.item_id || '';
        const why = r.reason || r.failed_reason || r.msg || r.message || r.err_msg || '';
        return why ? (who ? `${who}: ${why}` : String(why)) : JSON.stringify(r).slice(0, 200);
      })
      .filter(Boolean);
  }

  /**
   * Why preview/add refused products, in Shopee's words. Only product_failed_num
   * was read until 28 Oct 2026, so the page said "not eligible" — a guess. Any
   * list under a key naming failure is read as reasons; when there is none, what
   * Shopee did send is shown, so the shape can be learnt. `names` maps item id
   * to product name.
   */
  function addFailures(data, names = {}) {
    const lists = [];
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 3) return;
      for (const [key, value] of Object.entries(node)) {
        if (Array.isArray(value) && /fail|invalid|reject|error/i.test(key)) lists.push(...value);
        else if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, depth + 1);
      }
    };
    walk(data, 0);
    const named = lists.map((r) =>
      r && typeof r === 'object' && !r.item_name && r.item_id && names[String(r.item_id)] ? { ...r, item_name: names[String(r.item_id)] } : r
    );
    const lines = reasons(named);
    if (lines.length) return lines;
    return [`Shopee gave no reason. Its answer: ${JSON.stringify(data ?? null).slice(0, 300)}`];
  }

  function submitBody(request) {
    return { session_id: String(request.sessionId), entity_type: 2, confirm_risky: false };
  }

  function sessionUrl(request) {
    return `https://seller.shopee.com.my/portal/marketing/cmt-product/campaign/${request.campaignId}/session/${request.sessionId}`;
  }

  root.SRD_Nominations = {
    problems, addBody, pendingItems, pendingModels, overMax, editBody, submitBody, sessionUrl, units, MAX_ITEMS,
    editBodies, nominatedListBody, nominatedEntities, nominatedModels, notApplied, reasons, addFailures,
  };
})(typeof self !== 'undefined' ? self : globalThis);

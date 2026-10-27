/**
 * TikTok Seller Center — ISOLATED world.
 *
 * Reads the campaign list (lib/tiktok-campaigns.js) through the page relay in
 * content/tiktok-interceptor.js and hands it to the service worker. Read-only.
 */
(() => {
  'use strict';

  if (window.__srdTikTokLoaded) return;
  window.__srdTikTokLoaded = true;

  const TAG = '__SRD_TIKTOK__';
  const waiting = new Map();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[TAG] !== true || d.kind !== 'pageApiResult') return;
    const done = waiting.get(d.id);
    if (done) {
      waiting.delete(d.id);
      done(d);
    }
  });

  function pageApi(url, body) {
    return new Promise((resolve, reject) => {
      const id = `t${Date.now()}${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('Seller Center did not answer'));
      }, 30000);
      waiting.set(id, (d) => {
        clearTimeout(timer);
        if (d.status !== 200) return reject(new Error(d.error || `Seller Center answered HTTP ${d.status}`));
        let json;
        try {
          json = JSON.parse(d.text);
        } catch (_) {
          return reject(new Error('Seller Center did not answer JSON'));
        }
        if (json && json.code) return reject(new Error(json.message || json.msg || `code ${json.code}`));
        resolve(json);
      });
      window.postMessage({ [TAG]: true, kind: 'pageApiRequest', id, url, body }, window.location.origin);
    });
  }

  /** The seller id, from the requests the page has already made; waits for the page's first ones. */
  async function sellerId() {
    const T = self.SRD_TikTokCampaigns;
    for (let i = 0; i < 40; i++) {
      const id = T.sellerIdFrom(performance.getEntriesByType('resource').map((e) => e.name));
      if (id) return id;
      await sleep(500);
    }
    return null;
  }

  async function captureTikTokCampaigns() {
    const T = self.SRD_TikTokCampaigns;
    const id = await sellerId();
    if (!id) return { ok: false, error: 'Not logged in to TikTok Seller Center (no shop found on the page)' };

    const parents = [];
    for (let page = 1; page <= T.MAX_PAGES; page++) {
      const json = await pageApi(T.listUrl(id), T.listBody(page));
      const got = T.parentsOf(json.data);
      parents.push(...got);
      const total = Number((json.data && json.data.total_count) || 0);
      if (got.length < T.PAGE_SIZE || parents.length >= total) break;
      await sleep(300);
    }
    return { ok: true, sellerId: id, campaigns: parents, subCampaigns: T.subCount(parents) };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return undefined;
    if (msg.type === 'ping') {
      sendResponse({ ok: true, url: location.href });
      return undefined;
    }
    if (msg.type !== 'captureTikTokCampaigns') return undefined;
    captureTikTokCampaigns()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true;
  });
})();

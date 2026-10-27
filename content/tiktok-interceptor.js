/**
 * TikTok Seller Center — MAIN world.
 *
 * One job: make the campaign-list request for content/tiktok.js with the
 * page's own fetch, as it is at call time. Seller Center wraps fetch to add
 * its signatures (X-Bogus, msToken…); a request from the isolated world would
 * go without them. Only the campaign list, and only POST; anything else is
 * refused. Nothing here registers, agrees to terms or changes anything.
 */
(() => {
  'use strict';

  if (window.__srdTikTokRelay) return;
  window.__srdTikTokRelay = true;

  const TAG = '__SRD_TIKTOK__';
  const ALLOWED = /^\/api\/v1\/promotion\/campaign\/seller\/parents_campaigns\/list(\?|$)/;
  const post = (payload) => window.postMessage(Object.assign({ [TAG]: true }, payload), window.location.origin);

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[TAG] !== true || d.kind !== 'pageApiRequest') return;
    if (typeof d.url !== 'string' || !ALLOWED.test(d.url)) {
      post({ kind: 'pageApiResult', id: d.id, status: 0, error: 'Not the campaign list' });
      return;
    }
    window
      .fetch(d.url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(d.body || {})
      })
      .then(async (res) => post({ kind: 'pageApiResult', id: d.id, status: res.status, text: await res.text() }))
      .catch((err) => post({ kind: 'pageApiResult', id: d.id, status: 0, error: String((err && err.message) || err) }));
  });
})();

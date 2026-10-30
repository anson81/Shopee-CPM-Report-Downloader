/**
 * TikTok Seller Center — MAIN world.
 *
 * One job: make the campaign-list, campaign-criteria and video-list requests for
 * content/tiktok.js with the page's own fetch, as it is at call time. Seller
 * Center wraps fetch to add its signatures (X-Bogus, msToken…); a request from
 * the isolated world would go without them. Only those three — the two lists by
 * POST, the criteria by GET; anything else is refused. Nothing here registers,
 * agrees to terms or changes anything.
 */
(() => {
  'use strict';

  if (window.__srdTikTokRelay) return;
  window.__srdTikTokRelay = true;

  const TAG = '__SRD_TIKTOK__';
  const ALLOWED = {
    POST: /^\/api\/(v1\/promotion\/campaign\/seller\/parents_campaigns\/list|v2\/insights\/seller\/shop\/video\/analytics\/video\/list)(\?|$)/,
    GET: /^\/api\/v1\/promotion\/campaign\/seller\/get\?/
  };
  const post = (payload) => window.postMessage(Object.assign({ [TAG]: true }, payload), window.location.origin);

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[TAG] !== true || d.kind !== 'pageApiRequest') return;
    const method = d.method === 'GET' ? 'GET' : 'POST';
    if (typeof d.url !== 'string' || !ALLOWED[method].test(d.url)) {
      post({ kind: 'pageApiResult', id: d.id, status: 0, error: 'Not the campaign list, criteria or video list' });
      return;
    }
    const init =
      method === 'GET'
        ? { method, credentials: 'include' }
        : { method, credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d.body || {}) };
    window
      .fetch(d.url, init)
      .then(async (res) => post({ kind: 'pageApiResult', id: d.id, status: res.status, text: await res.text() }))
      .catch((err) => post({ kind: 'pageApiResult', id: d.id, status: 0, error: String((err && err.message) || err) }));
  });
})();

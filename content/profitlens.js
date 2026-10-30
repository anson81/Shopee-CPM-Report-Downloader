/**
 * ProfitLens content script — ISOLATED world, on profitlens.my (or a local dev
 * server).
 *
 * Copied from the SiteGiant Downloader, which solved this first:
 *
 * ProfitLens issues its refresh token as an httpOnly, sameSite:'lax' cookie and
 * pins CORS to a single origin. An extension calling the API cross-origin
 * therefore fails twice over — no cookie is attached, and the preflight is
 * refused. Running the same calls from a content script ON profitlens.my makes
 * them same-origin, so both problems disappear.
 *
 * The consequence worth keeping: the extension stores no ProfitLens credential
 * of any kind. It borrows the session the seller already has in this browser,
 * and holds nothing once the tab closes.
 */
(() => {
  'use strict';

  // Its own flag: the SiteGiant twin's script may share this page, and the two
  // must not mistake each other for an earlier copy of themselves.
  if (window.__srdPlLoaded) return;
  window.__srdPlLoaded = true;

  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  /** base64 -> Blob, without a data: URL round trip. */
  function toBlob(base64, mime) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime || XLSX_MIME });
  }

  /**
   * Trades the httpOnly refresh cookie for a short-lived access token.
   * Same-origin, so the cookie rides along on its own.
   */
  async function getAccessToken() {
    let res;
    try {
      res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (err) {
      throw new Error(`Could not reach ProfitLens: ${(err && err.message) || err}`);
    }

    if (res.status === 401) throw new Error('NOT_LOGGED_IN');
    if (!res.ok) throw new Error(`ProfitLens refresh failed (HTTP ${res.status})`);

    const json = await res.json().catch(() => null);
    const token = json && json.data && json.data.accessToken;
    if (!token) throw new Error('ProfitLens did not return an access token');
    return token;
  }

  /**
   * The useful message out of ProfitLens's error envelope.
   *
   * ProfitLens answers `{ success: false, error: "message" }` — `error` is a
   * STRING. The SiteGiant copy reads `error.message`, which is undefined on a
   * string, so it shows "HTTP 400" where ProfitLens had said exactly what was
   * wrong ("Expected a file named like parentskudetail…"). Both shapes are read
   * here, so a future change on either side still produces words.
   */
  async function readError(res) {
    const json = await res.json().catch(() => null);
    const error = json && json.error;
    if (typeof error === 'string' && error) return error;
    if (error && typeof error.message === 'string' && error.message) return error.message;
    if (json && typeof json.message === 'string' && json.message) return json.message;
    return `HTTP ${res.status}`;
  }

  /** Uploads one Product Performance file. One multipart field, `file`. */
  async function push({ endpoint, filename, base64 }) {
    const token = await getAccessToken();

    const form = new FormData();
    form.append('file', toBlob(base64), filename);

    const res = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: `Bearer ${token}` },
      body: form // no Content-Type: the browser must set the multipart boundary
    });

    if (res.status === 401) throw new Error('NOT_LOGGED_IN');
    if (!res.ok) throw new Error(await readError(res));

    const json = await res.json().catch(() => null);
    const data = (json && json.data) || {};
    return {
      ok: true,
      filename,
      created: data.created || 0,
      updated: data.updated || 0,
      unchanged: data.unchanged || 0,
      listings: data.listings || 0,
      shop: (data.shop && data.shop.name) || ''
    };
  }

  /** Sends a JSON body — the campaign calendar — the same way. */
  async function pushJson({ endpoint, body }) {
    const token = await getAccessToken();
    const res = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 401) throw new Error('NOT_LOGGED_IN');
    if (!res.ok) throw new Error(await readError(res));
    const json = await res.json().catch(() => null);
    return { ok: true, data: (json && json.data) || {} };
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'ping':
        return { ok: true, url: location.href };
      case 'push':
        return push(msg);
      case 'pushJson':
        return pushJson(msg);
      default:
        return { error: `Unknown command: ${msg.type}` };
    }
  }

  /*
   * The page bridge: ProfitLens's own page talking to the extension.
   *
   * window.postMessage, and only between this page and itself — a message from
   * another window or origin is ignored. Two requests: "srd:hello" (is the
   * extension here, which version) and "srd:createVouchers" (the CPM Voucher
   * Hack the seller just confirmed). The background checks the request again
   * and that it came from ProfitLens before anything reaches Seller Centre.
   */
  const reply = (type, requestId, body) =>
    window.postMessage({ source: 'srd-extension', type, requestId, ...body }, location.origin);

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== 'profitlens-page' || typeof msg.type !== 'string') return;

    if (msg.type === 'srd:hello') {
      reply('srd:hello', msg.requestId, {
        version: chrome.runtime.getManifest().version, vouchers: true, nominations: true, tiktokCampaigns: true, verifyNominations: true, tiktokVideos: true,
      });
      return;
    }
    if (msg.type === 'srd:verifyNomination') {
      chrome.runtime
        .sendMessage({ type: 'verifyNomination', request: msg.request })
        .then((result) => reply('srd:verifyNomination', msg.requestId, { result: result || { ok: false, error: 'The extension did not answer' } }))
        .catch((err) => reply('srd:verifyNomination', msg.requestId, { result: { ok: false, error: (err && err.message) || String(err) } }));
      return;
    }
    if (msg.type === 'srd:nominateCampaign') {
      chrome.runtime
        .sendMessage({ type: 'nominateCampaign', request: msg.request })
        .then((result) => reply('srd:nominateCampaign', msg.requestId, { result: result || { ok: false, error: 'The extension did not answer' } }))
        .catch((err) => reply('srd:nominateCampaign', msg.requestId, { result: { ok: false, error: (err && err.message) || String(err) } }));
      return;
    }
    if (msg.type === 'srd:readTikTokCampaigns') {
      chrome.runtime
        .sendMessage({ type: 'readTikTokCampaigns' })
        .then((result) => reply('srd:readTikTokCampaigns', msg.requestId, { result: result || { ok: false, error: 'The extension did not answer' } }))
        .catch((err) => reply('srd:readTikTokCampaigns', msg.requestId, { result: { ok: false, error: (err && err.message) || String(err) } }));
      return;
    }
    if (msg.type === 'srd:readTikTokVideoLinks') {
      chrome.runtime
        .sendMessage({ type: 'readTikTokVideoLinks' })
        .then((result) => reply('srd:readTikTokVideoLinks', msg.requestId, { result: result || { ok: false, error: 'The extension did not answer' } }))
        .catch((err) => reply('srd:readTikTokVideoLinks', msg.requestId, { result: { ok: false, error: (err && err.message) || String(err) } }));
      return;
    }
    if (msg.type === 'srd:createVouchers') {
      chrome.runtime
        .sendMessage({ type: 'createVouchers', request: msg.request })
        .then((result) => reply('srd:createVouchers', msg.requestId, { result: result || { ok: false, error: 'The extension did not answer' } }))
        .catch((err) => reply('srd:createVouchers', msg.requestId, { result: { ok: false, error: (err && err.message) || String(err) } }));
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return undefined;
    handle(msg)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: (err && err.message) || String(err) }));
    return true;
  });
})();

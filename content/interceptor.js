/**
 * MAIN-world interceptor.
 *
 * Runs inside Shopee's own JavaScript context (not the extension's isolated
 * world) at document_start. This is mandatory: a content script that overrides
 * URL.createObjectURL only overrides it for itself, never for the page. Shopee
 * builds its BI report files as in-browser blobs, so the only way to see them
 * is from here.
 *
 * Everything captured is relayed to content.js via window.postMessage. This
 * script never touches chrome.* APIs (it has no access to them).
 */
(() => {
  'use strict';

  if (window.__shopeeDlHooked) return;
  window.__shopeeDlHooked = true;

  const TAG = '__SHOPEE_DL__';
  const MAX_BLOB_BYTES = 80 * 1024 * 1024;

  // Blob types that are never a report. Reading every blob the SPA makes
  // (images, fonts, worker source) would be wasteful and slow.
  const IGNORED_TYPE = /^(image|video|audio|font)\//i;
  const IGNORED_EXACT = /^(text\/html|text\/javascript|application\/javascript|application\/wasm)$/i;

  function post(payload) {
    try {
      window.postMessage(Object.assign({ [TAG]: true }, payload), window.location.origin);
    } catch (_) {
      /* ignore */
    }
  }

  function interesting(blob) {
    if (!(blob instanceof Blob)) return false;
    if (blob.size === 0 || blob.size > MAX_BLOB_BYTES) return false;
    const t = blob.type || '';
    if (IGNORED_TYPE.test(t)) return false;
    if (IGNORED_EXACT.test(t)) return false;
    return true;
  }

  function relayBlob(blob, objectUrl) {
    let reader;
    try {
      reader = new FileReader();
    } catch (_) {
      return;
    }
    reader.onload = () => {
      post({
        kind: 'blob',
        url: objectUrl,
        dataUrl: String(reader.result || ''),
        mime: blob.type || '',
        size: blob.size,
        at: Date.now()
      });
    };
    reader.onerror = () => post({ kind: 'blobError', url: objectUrl, at: Date.now() });
    try {
      reader.readAsDataURL(blob);
    } catch (_) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * 1. URL.createObjectURL — captures the report bytes.
   * ------------------------------------------------------------------ */
  const origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    const objectUrl = origCreate(obj);
    try {
      if (interesting(obj)) relayBlob(obj, objectUrl);
    } catch (_) {
      /* never break the page */
    }
    return objectUrl;
  };

  // Shopee revokes the object URL right after triggering the download. The
  // Blob itself stays alive as long as we hold a reference, but we have
  // already read it above, so revoke can pass straight through.
  const origRevoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = function (url) {
    return origRevoke(url);
  };

  /* ------------------------------------------------------------------ *
   * 2. Anchor clicks — captures Shopee's ORIGINAL filename, which the
   *    blob alone does not carry.
   * ------------------------------------------------------------------ */
  function reportAnchor(a) {
    try {
      const href = a.href || '';
      const name = a.getAttribute('download');
      if (href.startsWith('blob:')) {
        post({ kind: 'anchor', url: href, filename: name || '', at: Date.now() });
      } else if (name !== null && /^https?:/i.test(href)) {
        post({ kind: 'link', url: href, filename: name || '', at: Date.now() });
      }
    } catch (_) {
      /* ignore */
    }
  }

  const origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    reportAnchor(this);
    return origAnchorClick.apply(this, arguments);
  };

  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      const a = t.closest('a[download], a[href^="blob:"]');
      if (a) reportAnchor(a);
    },
    true
  );

  /* ------------------------------------------------------------------ *
   * 3. get_download_url API responses — mechanism #1 for the Ads exports.
   * ------------------------------------------------------------------ */
  const WATCHED_API = /get_download_url|direct_download|list_homepage_result/i;

  function relayApi(url, text) {
    try {
      post({ kind: 'api', url: String(url), json: JSON.parse(text), at: Date.now() });
    } catch (_) {
      /* not JSON — ignore */
    }
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url =
          typeof input === 'string' ? input : input && input.url ? input.url : '';
        if (WATCHED_API.test(url)) {
          p.then((res) => {
            try {
              res
                .clone()
                .text()
                .then((t) => relayApi(url, t))
                .catch(() => {});
            } catch (_) {
              /* ignore */
            }
          }).catch(() => {});
        }
      } catch (_) {
        /* ignore */
      }
      return p;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__shopeeDlUrl = url;
    } catch (_) {
      /* ignore */
    }
    return origOpen.apply(this, arguments);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    try {
      const url = this.__shopeeDlUrl || '';
      if (WATCHED_API.test(url)) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === '' || this.responseType === 'text') {
              relayApi(url, this.responseText);
            } else if (this.responseType === 'json' && this.response) {
              post({ kind: 'api', url: String(url), json: this.response, at: Date.now() });
            }
          } catch (_) {
            /* ignore */
          }
        });
      }
    } catch (_) {
      /* ignore */
    }
    return origSend.apply(this, arguments);
  };
})();

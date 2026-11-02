/**
 * Reading public TikTok pages for ProfitLens's Find a video (2 Nov 2026): a
 * creator's videos and one video's file, in a background tab of the seller's
 * own signed-in browser, read-only. Asked for by the seller from ProfitLens;
 * never in a run. A verification page or TikTok's rate limit is reported, not
 * worked around.
 *
 * pageRead* run inside the TikTok tab (chrome.scripting, MAIN world), so they
 * use nothing from outside themselves.
 */
(function (root) {
  'use strict';

  const MAX_FILE_BYTES = 40 * 1024 * 1024;

  /** "@name", "name" or a profile link -> the username, or null. */
  function usernameOf(text) {
    const s = String(text || '').trim();
    const inUrl = s.match(/tiktok\.com\/@([\w.]{2,30})/i);
    if (inUrl) return inUrl[1];
    const bare = s.replace(/^@/, '');
    return /^[\w.]{2,30}$/.test(bare) ? bare : null;
  }

  /** The canonical page of a video link (short links are left for TikTok to redirect). */
  function videoUrlOf(text) {
    const s = String(text || '').trim();
    if (!/^https:\/\/([a-z]+\.)?tiktok\.com\//i.test(s)) return null;
    return s.split('?')[0];
  }

  /** What is on a creator's page now; `state` says when there is nothing to read yet. */
  function pageReadCreator() {
    const title = document.title || '';
    if (document.querySelector('#captcha-verify-container, .captcha-disable-scroll')) return { state: 'VERIFY' };
    const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (!el) return { state: title === 'www.tiktok.com' ? 'LIMITED' : 'WAIT' };
    let detail = null;
    try {
      detail = JSON.parse(el.textContent).__DEFAULT_SCOPE__['webapp.user-detail'];
    } catch (_) {
      return { state: 'WAIT' };
    }
    if (!detail || detail.statusCode) return { state: 'NOT_FOUND' };
    const user = (detail.userInfo && detail.userInfo.user) || {};
    const stats = (detail.userInfo && detail.userInfo.stats) || {};
    const videos = [...document.querySelectorAll('[data-e2e="user-post-item"]')].slice(0, 30).map((item) => {
      const link = item.querySelector('a[href*="/video/"]');
      const img = item.querySelector('img');
      const views = item.querySelector('[data-e2e="video-views"]');
      return {
        id: link ? link.href.split('/video/')[1].split('?')[0] : null,
        url: link ? link.href.split('?')[0] : null,
        title: img ? img.alt || '' : '',
        cover: img ? img.src || '' : '',
        views: views ? views.innerText : '',
      };
    });
    return {
      state: videos.length || stats.videoCount === 0 ? 'READY' : 'WAIT',
      username: user.uniqueId || '',
      nickname: user.nickname || '',
      videoCount: stats.videoCount || 0,
      videos: videos.filter((v) => v.id),
    };
  }

  /** One video's page, then its file as base64 (a message cannot carry bytes). */
  async function pageReadVideoFile(maxBytes) {
    if (document.querySelector('#captcha-verify-container, .captcha-disable-scroll')) return { state: 'VERIFY' };
    const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (!el) return { state: document.title === 'www.tiktok.com' ? 'LIMITED' : 'WAIT' };
    let detail = null;
    try {
      detail = JSON.parse(el.textContent).__DEFAULT_SCOPE__['webapp.video-detail'];
    } catch (_) {
      return { state: 'WAIT' };
    }
    if (!detail) return { state: 'WAIT' };
    const item = detail.itemInfo && detail.itemInfo.itemStruct;
    if (detail.statusCode || !item) return { state: 'NOT_FOUND' };
    const address = (item.video && (item.video.playAddr || item.video.downloadAddr)) || '';
    const about = {
      id: String(item.id || ''),
      title: item.desc || '',
      username: (item.author && item.author.uniqueId) || '',
      durationSec: (item.video && item.video.duration) || null,
    };
    if (!address) return { state: 'NO_ADDRESS', ...about };
    const res = await fetch(address, { credentials: 'include' });
    if (!res.ok) return { state: 'NO_FILE', status: res.status, ...about };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) return { state: 'TOO_LARGE', ...about };
    let text = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) text += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    return { state: 'READY', ...about, mimeType: 'video/mp4', size: bytes.length, base64: btoa(text) };
  }

  /** A page's state, for the seller. Null when there is no problem to report. */
  function problemOf(state) {
    return {
      VERIFY: 'TikTok wants you to confirm you are a person. Open tiktok.com in Chrome, finish it, and try again.',
      LIMITED: 'TikTok is limiting page loads from this browser for now. Try again in a few minutes.',
      WAIT: 'TikTok did not finish loading the page. Try again.',
      NOT_FOUND: 'TikTok has no such page, or it is private.',
      NO_ADDRESS: 'TikTok gives no video address for this one (it happens with ad-authorised videos). If it is yours or your creator’s, play it from your own lists; otherwise save the file and use Duplicate a video file.',
      NO_FILE: 'TikTok would not send the video file. Save it and use Duplicate a video file.',
      TOO_LARGE: 'The video is too large to fetch this way. Save it and use Duplicate a video file.',
    }[state] || null;
  }

  root.SRD_TikTokWeb = { MAX_FILE_BYTES, usernameOf, videoUrlOf, pageReadCreator, pageReadVideoFile, problemOf };
})(typeof self !== 'undefined' ? self : globalThis);

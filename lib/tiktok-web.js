/**
 * TikTok pages for ProfitLens's Find a video (2 Nov 2026): Affiliate Center's
 * creator search, a creator's page and one video's file, in a background tab of
 * the seller's own signed-in browser, read-only; and filling TikTok Studio's
 * upload box for the seller to post. Asked for by the seller from ProfitLens;
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

  /**
   * One video's page, then its cover as base64 and its caption, for the wishlist.
   * Only ever reads: tiktok.com answers a server with a bot check, but not a person's
   * Chrome (3 Nov 2026), and the page itself can fetch the picture.
   */
  async function pageReadVideoCover(maxBytes) {
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
    const cover = item.video && (item.video.cover || item.video.originCover);
    if (!cover) return { state: 'NO_FILE' };
    const res = await fetch(cover);
    if (!res.ok) return { state: 'NO_FILE', status: res.status };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) return { state: 'TOO_LARGE' };
    let text = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) text += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    return { state: 'READY', title: item.desc || '', base64: btoa(text) };
  }

  /**
   * Affiliate Center's creator search, in its own tab: names and @handles, each
   * creator's figures and top videos with real file addresses, including the
   * selling videos tiktok.com leaves empty (read live 2 Nov 2026). Sent through
   * the page's XMLHttpRequest, which the page signs itself. Read-only: this is
   * what its Find creators box asks; nothing here invites or messages anyone.
   */
  function pageFindCreators(query) {
    const sellerId = new URLSearchParams(location.search).get('shop_id');
    // The page redirects to /affiliate/creator?…&shop_id= once it has loaded.
    if (!sellerId) return Promise.resolve({ state: /login|signin/i.test(location.pathname) ? 'NO_AFFILIATE' : 'WAIT' });
    const value = (f) => (f && f.value !== undefined ? f.value : null);
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('POST', `/api/v1/oec/affiliate/creator/marketplace/find?user_language=en&aid=4331&app_name=i18n_ecom_alliance&device_platform=web&oec_seller_id=${sellerId}&shop_region=MY`);
      x.setRequestHeader('Content-Type', 'application/json');
      x.withCredentials = true;
      x.onerror = () => resolve({ state: 'NO_AFFILIATE' });
      x.onload = () => {
        let j = null;
        try {
          j = JSON.parse(x.responseText);
        } catch (_) {
          /* reported below */
        }
        if (!j || j.code !== 0) return resolve({ state: 'NO_AFFILIATE' });
        const links = [];
        const creators = (j.creator_profile_list || []).map((c) => {
          const handle = value(c.handle) || '';
          const videos = (value(c.top_video_data) || []).map((t) => {
            const v = t.video || {};
            const info = (v.video_infos || [])[0] || {};
            // item_id is TikTok's id. video.id is Affiliate Center's own code and post_url is the
            // cover picture (read live 3 Nov 2026), so neither makes a link.
            const id = /^\d+$/.test(String(t.item_id || '')) ? String(t.item_id) : '';
            const hasFile = Boolean(id && info.main_url && info.url_expire);
            if (hasFile) {
              links.push({ videoId: id, url: info.main_url, backupUrl: info.backup_url || null, expiresAt: new Date(info.url_expire * 1000).toISOString() });
            }
            return {
              id,
              url: id ? `https://www.tiktok.com/@${handle}/video/${id}` : null,
              title: t.name || '',
              views: Number(t.play_cnt) || 0,
              likes: Number(t.like_cnt) || 0,
              durationSec: v.duration || null,
              postedAt: t.release_date || null,
              hasFile,
              products: (t.video_products || []).map((p) => ({ id: String(p.product_id || ''), name: p.name || '', price: (p.min_sale_price && p.min_sale_price.formatted_price) || '' })),
            };
          });
          return {
            handle,
            nickname: value(c.nickname) || '',
            followers: Number(value(c.follower_cnt)) || 0,
            unitsSold: Number(value(c.units_sold)) || 0,
            avgViews: Number(value(c.ec_video_avg_view_cnt)) || 0,
            engagement: value(c.ec_video_engagement),
            worksWithYou: value(c.has_collaborated) === true,
            videos,
          };
        });
        resolve({ state: 'READY', sellerId, creators, links });
      };
      x.send(JSON.stringify({ query, pagination: { size: 12, page: 0 }, query_type: 1, filter_params: {}, algorithm: 1 }));
    });
  }

  /**
   * Put a video into TikTok Studio's upload box. It stops there: the seller
   * adds the product and the AI label, and presses Post. Nothing here posts.
   */
  function pageFillUpload(base64, filename) {
    const input = document.querySelector('input[type="file"][accept*="video"]');
    if (!input) return { state: 'WAIT' };
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], filename, { type: 'video/mp4' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { state: 'READY' };
  }

  /**
   * Put the caption and hashtags into Studio's description, replacing the file
   * name TikTok starts it with. The box appears only once a file is chosen, so it
   * is asked for again until it is there. Read live on Studio, 3 Nov 2026:
   * - The box is Draft.js. A selection made in the browser does not reach it, so a
   *   paste lands after the file name; the selection is set on the editor itself.
   * - Text goes in as a paste, which the editor handles. Never execCommand('insertText'):
   *   typed past the editor, a line break throws Studio onto "Something went wrong".
   * - A pasted hashtag is only text. It becomes TikTok's own tag (bold, with its id)
   *   when picked from the list Studio offers, so each is pasted and its exact match
   *   picked. One TikTok does not list stays as text.
   */
  async function pageFillCaption(text, fileName, force) {
    const box =
      document.querySelector('[data-e2e="caption"] [contenteditable="true"]') ||
      document.querySelector('.public-DraftEditor-content') ||
      document.querySelector('.caption-editor [contenteditable="true"]');
    if (!box) return { state: 'WAIT' };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const words = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase();
    const want = words(text);
    const stateNow = () => {
      const now = words(box.innerText || '');
      if (now === want) return 'READY';
      return now.includes(want) ? 'LEFTOVER' : 'NOT_TAKEN';
    };
    const before = stateNow();
    if (before !== 'NOT_TAKEN') return { state: before };
    // TikTok writes the file name in shortly after the box appears; filling sooner is overwritten.
    const now = words(box.innerText || '');
    const stem = words((fileName || '').replace(/\.[^.]+$/, ''));
    if (!now || (stem && !now.includes(stem) && !force)) return { state: 'WAIT' };

    const editor = () => {
      let fiber = box[Object.keys(box).find((k) => k.startsWith('__reactFiber'))];
      for (; fiber; fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (props && props.editorState && typeof props.onChange === 'function') return props;
      }
      return null;
    };
    if (!editor()) return { state: 'NOT_TAKEN' };
    const select = async (whole) => {
      const { editorState: state, onChange } = editor();
      const content = state.getCurrentContent();
      const last = content.getLastBlock();
      const first = whole ? content.getFirstBlock() : last;
      onChange(state.constructor.forceSelection(state, state.getSelection().merge({
        anchorKey: first.getKey(),
        anchorOffset: whole ? 0 : last.getLength(),
        focusKey: last.getKey(),
        focusOffset: last.getLength(),
        isBackward: false,
        hasFocus: true,
      })));
      await sleep(200);
    };
    const paste = async (words_) => {
      const data = new DataTransfer();
      data.setData('text/plain', words_);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      await sleep(200);
    };
    const offered = (tag) =>
      [...document.querySelectorAll('.hashtag-suggestion-item')].find(
        (item) => (item.innerText || '').split('\n')[0].trim().toLowerCase() === tag.toLowerCase()
      );

    box.focus();
    await sleep(100);
    await select(true);
    const parts = text.match(/^([\s\S]*?)\s*((?:#\S+\s*)+)$/);
    if (!parts) await paste(text);
    else {
      if (parts[1]) await paste(`${parts[1]}\n\n`);
      const tags = parts[2].trim().split(/\s+/);
      for (let i = 0; i < tags.length; i++) {
        if (parts[1] || i > 0) await select(false);
        await paste(tags[i]);
        let item = null;
        for (let wait = 0; wait < 15 && !item; wait++) {
          await sleep(200);
          item = offered(tags[i]);
        }
        // Picking it adds the space itself.
        if (item) for (const type of ['mousedown', 'mouseup', 'click']) item.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        else {
          await select(false);
          await paste(' ');
        }
        await sleep(300);
      }
    }
    await sleep(300);
    return { state: stateNow() };
  }

  /**
   * Studio's product link: + Add → Products → Next → search by Product ID → pick →
   * Next → Add (read live 3 Nov 2026). Only ever clicks those. Anything else on the
   * way, such as terms, is left on screen for the seller: `POPUP`.
   */
  async function pageAddProduct(productId) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    if (document.querySelector('.anchor-tag-label')) return { state: 'READY' };
    const add = document.querySelector('.anchor-tag-container button');
    if (!add) return { state: 'WAIT' };
    const footer = () => [...document.querySelectorAll('.common-modal-footer button')];
    const press = (name) => {
      const button = footer().find((b) => b.innerText.trim() === name);
      if (button) button.click();
      return Boolean(button);
    };
    const until = async (test, tries = 20) => {
      for (let i = 0; i < tries; i++) {
        const value = test();
        if (value) return value;
        await sleep(250);
      }
      return null;
    };
    add.click();
    if (!(await until(() => footer().length))) return { state: 'NOT_SET' };
    const search = 'input[placeholder="Search products"]';
    if (!document.querySelector(search) && !press('Next')) return { state: 'POPUP' };
    const input = await until(() => document.querySelector(search));
    if (!input) return { state: 'POPUP' };
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, productId);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (const type of ['keydown', 'keyup']) input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    const row = await until(() => [...document.querySelectorAll('tr.product-tb-row')].find((r) => (r.innerText || '').includes(productId)));
    if (!row) {
      press('Cancel');
      return { state: 'NOT_FOUND' };
    }
    row.querySelector('input[type="radio"]').click();
    await sleep(300);
    if (!press('Next')) return { state: 'POPUP' };
    if (!(await until(() => footer().some((b) => b.innerText.trim() === 'Add')))) return { state: 'POPUP' };
    press('Add');
    return { state: (await until(() => document.querySelector('.anchor-tag-label'))) ? 'READY' : 'NOT_SET' };
  }

  /**
   * Choose Schedule and set Studio's date and time (`at` in Malaysian parts). Studio
   * shows the browser's own zone, so another zone is refused rather than posting at
   * the wrong hour. It stops there: the Schedule button is the seller's.
   */
  async function pageSetSchedule(at) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const radio = document.querySelector('input[type="radio"][value="schedule"]');
    if (!radio) return { state: 'WAIT' };
    if (new Date().getTimezoneOffset() !== -480) return { state: 'BAD_ZONE' };
    if (!radio.checked) radio.click();
    await sleep(500);
    const triggers = () => document.querySelectorAll('.schedule-picker .Picker__trigger');
    const values = () => [...document.querySelectorAll('.schedule-picker .Picker__value')].map((e) => e.innerText.trim());
    if (triggers().length < 2) return { state: 'WAIT' };
    const pad = (n) => String(n).padStart(2, '0');
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const wantDate = `${at.day} ${months[at.month - 1].slice(0, 3)} ${at.year}`;
    const wantTime = `${pad(at.hour)}:${pad(at.minute)}`;

    if (values()[0] !== wantDate) {
      triggers()[0].click();
      await sleep(400);
      const title = `${months[at.month - 1]} ${at.year}`;
      const shown = () => (document.querySelector('.DatePicker__title') || {}).innerText || '';
      for (let i = 0; i < 3 && shown().replace(/\s+/g, ' ').trim() !== title; i++) {
        const next = document.querySelectorAll('.DatePicker__nav')[1];
        if (!next) break;
        next.click();
        await sleep(300);
      }
      // The grid also shows the ends of the months either side.
      const same = [...document.querySelectorAll('.DatePicker__dayCell')].filter((c) => c.innerText.trim() === String(at.day));
      const cell = at.day < 15 ? same[0] : same[same.length - 1];
      if (cell) (cell.querySelector('button') || cell.firstElementChild || cell).click();
      await sleep(400);
    }
    if (values()[1] !== wantTime) {
      triggers()[1].click();
      await sleep(400);
      const pick = (column, text) => {
        const columns = document.querySelectorAll('.TimePicker__column');
        const item = columns[column] && [...columns[column].querySelectorAll('button.TimePicker__item')].find((b) => b.innerText.trim() === text);
        if (item) item.click();
      };
      pick(0, pad(at.hour));
      await sleep(300);
      pick(1, pad(at.minute));
      await sleep(300);
      if (document.querySelector('.TimePicker__panel')) triggers()[1].click();
      await sleep(300);
    }
    const [date, time] = values();
    return { state: date === wantDate && time === wantTime ? 'READY' : 'NOT_SET' };
  }

  /** Switch on AI-generated content, under Show more. A popup in reply stays on screen for the seller. */
  async function pageSetAiLabel() {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const find = () => {
      const label = [...document.querySelectorAll('span,div')].find((e) => e.children.length === 0 && e.textContent.trim() === 'AI-generated content');
      let box = label;
      for (let i = 0; box && i < 4; i++, box = box.parentElement) {
        const input = box.querySelector('input.Switch__input');
        if (input) return input;
      }
      return null;
    };
    if (!find()) {
      const more = [...document.querySelectorAll('button,div,span')].find((e) => e.children.length < 3 && (e.innerText || '').trim() === 'Show more');
      if (!more) return { state: 'WAIT' };
      more.click();
      await sleep(600);
    }
    const input = find();
    if (!input) return { state: 'WAIT' };
    if (input.checked) return { state: 'READY' };
    input.click();
    await sleep(800);
    if (document.querySelector('.common-modal-footer,[role="dialog"]')) return { state: 'POPUP' };
    return { state: find() && find().checked ? 'READY' : 'NOT_SET' };
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
      NO_AFFILIATE: 'TikTok Affiliate Center did not answer. Open affiliate.tiktok.com in Chrome, sign in, and try again.',
    }[state] || null;
  }

  root.SRD_TikTokWeb = { MAX_FILE_BYTES, usernameOf, videoUrlOf, pageReadCreator, pageReadVideoFile, pageFindCreators, pageReadVideoCover, pageFillUpload, pageFillCaption, pageAddProduct, pageSetSchedule, pageSetAiLabel, problemOf };
})(typeof self !== 'undefined' ? self : globalThis);

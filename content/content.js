/**
 * Isolated-world content script.
 *
 * Owns every DOM interaction described in the build spec: tab clicks, period
 * selection, the By Week calendar dance, the Ads dropdown, the GMV Max confirm
 * modal and API polling. The background service worker only navigates the tab
 * and writes files; all page knowledge lives here.
 *
 * One export == one message from the background == one page load. State is
 * never carried across navigations.
 */
'use strict';

(() => {
  if (window.__shopeeDlContentLoaded) return;
  window.__shopeeDlContentLoaded = true;

  /* ================================================================== *
   * Error messages (spec: ERROR HANDLING table)
   * ================================================================== */
  const ERR = {
    NOT_LOGGED_IN:
      'Please log in to Shopee Seller Center first, then click Download.',
    PAGE_TIMEOUT:
      'Shopee Seller Center took too long to load. Check your internet connection and try again.',
    NO_EXPORT_BUTTON:
      "Could not find the Export button on the page. Shopee's UI may have changed.",
    DOWNLOAD_TIMEOUT:
      'Report is still processing. Wait a moment and try again, or click Download again.',
    NO_BLOB: 'Download was triggered but no file was captured. Try again.',
    NO_GMV:
      'GMV Max report was not generated after 10 minutes. Try again later.',
    NO_CONFIRM:
      'Could not confirm GMV Max export. The modal may have been dismissed.',
    WEEK_FAILED:
      'Could not select the target week in the calendar. Try selecting it manually and re-run.',
    DAY_FAILED:
      'Could not select the target date in the calendar. Try selecting it manually and re-run.',
    NO_NEW_REPORT:
      'Shopee did not start a new report after clicking Export. It may still be rate-limited — wait a minute and try again.',
    STALE_REPORT:
      'Shopee served an older report instead of the new one. Wait a minute and re-run this export.',
    CANCELLED: 'Cancelled.'
  };

  class AppError extends Error {
    constructor(message) {
      super(message);
      this.name = 'AppError';
      this.friendly = true;
    }
  }

  class Cancelled extends Error {
    constructor() {
      super(ERR.CANCELLED);
      this.name = 'Cancelled';
      this.friendly = true;
    }
  }

  /* ================================================================== *
   * Capture bus — messages relayed from the MAIN-world interceptor
   * ================================================================== */
  const TAG = '__SHOPEE_DL__';
  const captures = { blobs: [], anchors: [], links: [], apis: [] };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[TAG] !== true) return;
    switch (d.kind) {
      case 'blob':
        captures.blobs.push(d);
        break;
      case 'anchor':
        captures.anchors.push(d);
        break;
      case 'link':
        captures.links.push(d);
        break;
      case 'api':
        captures.apis.push(d);
        break;
      default:
        break;
    }
  });

  function clearCaptures() {
    captures.blobs.length = 0;
    captures.anchors.length = 0;
    captures.links.length = 0;
    captures.apis.length = 0;
  }

  /* ================================================================== *
   * Background plumbing: progress, heartbeat, cancellation
   * ================================================================== */
  let cancelled = false;
  let heartbeatTimer = null;

  async function bg(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (_) {
      // Service worker restarting, or extension reloaded mid-run.
      return null;
    }
  }

  function report(text) {
    bg({ type: 'progress', text });
  }

  /**
   * Tell the background what this report is called, so that a download the
   * PAGE starts (Shopee sometimes fires its own, via a CDN redirect with no
   * filename) can be rescued from Chrome's "download (2).csv".
   */
  function expectName(name) {
    if (name) bg({ type: 'expectName', name });
  }

  function startHeartbeat() {
    stopHeartbeat();
    // Every message resets the MV3 service worker's idle timer, which keeps
    // the orchestrator alive through the long polling loops below.
    heartbeatTimer = setInterval(async () => {
      const res = await bg({ type: 'heartbeat' });
      if (res && res.cancel) cancelled = true;
    }, 10000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function checkCancel() {
    if (cancelled) throw new Cancelled();
  }

  /* ================================================================== *
   * DOM helpers
   * ================================================================== */
  const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  async function wait(ms) {
    // Cancellable sleep: checks roughly twice a second.
    const end = Date.now() + ms;
    while (Date.now() < end) {
      checkCancel();
      await sleep(Math.min(500, end - Date.now()));
    }
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function $$(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function $$vis(selector, root) {
    return $$(selector, root).filter(isVisible);
  }

  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'HEAD',
    'META',
    'LINK',
    'TITLE',
    'SVG',
    'PATH',
    'IFRAME'
  ]);

  /**
   * Playwright's `text=/regex/` engine, approximated: match the *innermost*
   * elements whose trimmed text matches, then keep only visible ones.
   * textContent (cheap) is used for the scan; innerText would force a reflow
   * per element and Shopee's DOM is enormous.
   */
  function queryText(re, opts) {
    const o = opts || {};
    const scope = o.scope || '*';
    const root = o.root || document;
    const maxLen = o.maxLen || 200;
    const matches = [];

    for (const el of root.querySelectorAll(scope)) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      const raw = el.textContent;
      if (!raw) continue;
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!text || text.length > maxLen) continue;
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      matches.push(el);
    }

    const innermost = matches.filter(
      (el) => !matches.some((other) => other !== el && el.contains(other))
    );
    return o.visibleOnly === false ? innermost : innermost.filter(isVisible);
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** "Past 7 Days" -> /Past\s+7\s+Days/i, hyphens made optional. */
  function labelRe(label, anchored) {
    const body = label
      .trim()
      .split(/\s+/)
      .map((word) => escapeRe(word).replace(/-/g, '[-\\s]?'))
      .join('\\s+');
    return new RegExp(anchored ? `^${body}$` : body, 'i');
  }

  async function waitFor(fn, opts) {
    const o = opts || {};
    const timeout = o.timeout == null ? 15000 : o.timeout;
    const interval = o.interval || 250;
    const end = Date.now() + timeout;
    for (;;) {
      checkCancel();
      let value = null;
      try {
        value = await fn();
      } catch (_) {
        value = null;
      }
      if (value) return value;
      if (Date.now() >= end) return null;
      await sleep(Math.min(interval, Math.max(0, end - Date.now())));
    }
  }

  function mouseEvent(type, el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'mousedown' || type === 'pointerdown' ? 1 : 0
    };
    const Ctor = type.startsWith('pointer') && window.PointerEvent
      ? PointerEvent
      : MouseEvent;
    if (Ctor === PointerEvent) {
      init.pointerId = 1;
      init.pointerType = 'mouse';
      init.isPrimary = true;
    }
    el.dispatchEvent(new Ctor(type, init));
  }

  /**
   * Shopee's EDS components listen on a mix of mousedown / mouseup / click,
   * so a bare el.click() is not always enough. Dispatch the full sequence.
   */
  function fullClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (_) {
      /* ignore */
    }
    for (const type of [
      'pointerover',
      'mouseover',
      'pointermove',
      'mousemove',
      'pointerdown',
      'mousedown',
      'pointerup',
      'mouseup'
    ]) {
      mouseEvent(type, el);
    }
    if (typeof el.click === 'function') el.click();
    else mouseEvent('click', el);
    return true;
  }

  /** The By Week calendar only renders on hover — a click would dismiss it. */
  function hover(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (_) {
      /* ignore */
    }
    for (const type of [
      'pointerover',
      'mouseover',
      'pointerenter',
      'mouseenter',
      'pointermove',
      'mousemove'
    ]) {
      mouseEvent(type, el);
    }
    return true;
  }

  /** Set an input's value in a way React/Vue controlled inputs notice. */
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  async function typeInto(el, text) {
    el.focus();
    setNativeValue(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    for (const ch of text) {
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true })
      );
      setNativeValue(el, el.value + ch);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(
        new KeyboardEvent('keyup', { key: ch, bubbles: true, cancelable: true })
      );
      await sleep(25);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        })
      );
    }
  }

  /* ================================================================== *
   * Login check (spec: Pre-flight)
   * ================================================================== */
  async function checkLogin() {
    await wait(10000);
    const url = window.location.href;
    if (/accounts\.shopee|\/login|captcha|verify/i.test(url)) {
      return { loggedIn: false, url, reason: 'auth-url' };
    }
    const text = (document.body && document.body.innerText) || '';
    if (/Business Insights|Export Data/i.test(text)) {
      return { loggedIn: true, url, reason: 'text' };
    }
    if (url.startsWith('https://seller.shopee.com.my') && !/login/i.test(url)) {
      return { loggedIn: true, url, reason: 'url' };
    }
    return { loggedIn: false, url, reason: 'unknown' };
  }

  /* ================================================================== *
   * Business Insights interactions (Exports 1-5)
   * ================================================================== */
  const PERIOD_RE =
    /^(Real[-\s]?Time|Today|Yesterday|Past 7 Days|Past 30 Days|By Day|By Week)$/i;

  async function openProductPerformanceTab() {
    report('Opening Product Performance…');
    const tab = await waitFor(
      () => queryText(/^Product Performance$/i)[0],
      { timeout: 15000 }
    );
    if (!tab) {
      throw new AppError(
        "Could not find the 'Product Performance' tab. Shopee's UI may have changed."
      );
    }
    fullClick(tab);
    await wait(5000); // spec: tab data load
  }

  async function selectPeriodBI(label) {
    report(`Selecting period "${label}"…`);

    const trigger = await waitFor(() => queryText(PERIOD_RE)[0], {
      timeout: 15000
    });

    if (trigger) {
      fullClick(trigger);
      await wait(1000);
      const exact = labelRe(label, true);
      const loose = labelRe(label, false);
      const option = await waitFor(
        () => {
          const hits = queryText(exact)
            .concat(queryText(loose))
            .filter(
              (el) =>
                el !== trigger && !el.contains(trigger) && !trigger.contains(el)
            );
          return hits[0] || null;
        },
        { timeout: 5000 }
      );
      if (option) {
        fullClick(option);
        await wait(2000); // spec: data reload
        return true;
      }
    }

    // Spec fallback: generic date/period/filter control.
    report(`Period "${label}": using fallback selector…`);
    const fallback = await waitFor(
      () => $$vis('[class*="date"], [class*="period"], [class*="filter"]')[0],
      { timeout: 5000 }
    );
    if (!fallback) {
      throw new AppError(
        `Could not find the period selector to choose "${label}". Shopee's UI may have changed.`
      );
    }
    fullClick(fallback);
    await sleep(500);
    const option = await waitFor(
      () => queryText(labelRe(label, false))[0],
      { timeout: 5000 }
    );
    if (!option) {
      throw new AppError(
        `Could not find the "${label}" option in the period menu. Shopee's UI may have changed.`
      );
    }
    fullClick(option);
    await wait(2000);
    return true;
  }

  /**
   * Open the BI date picker and hover one of its shortcuts ("By Day" /
   * "By Week") so the calendar panel renders.
   *
   * Deliberately does NOT go through selectPeriodBI — clicking the period
   * dropdown closes the calendar.
   */
  /**
   * The "Data Period" control, e.g. `Yesterday 03-08-2026 (GMT+08)` with a
   * calendar icon. Tried in order of specificity, because the class name is
   * the part most likely to change under us.
   */
  function findDateTrigger() {
    const byClass = $$vis('.bi-date-input')[0];
    if (byClass) return byClass;

    // "Data Period" label -> the clickable control beside it.
    const label = queryText(/^Data Period$/i)[0];
    if (label) {
      let node = label;
      for (let up = 0; up < 4 && node; up++) {
        node = node.parentElement;
        if (node && /\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2}/.test(node.innerText || '')) {
          return node;
        }
      }
    }

    // Last resort: the element showing the current period name.
    return queryText(PERIOD_RE)[0] || null;
  }

  async function openBiCalendar(shortcutRe, failMessage) {
    const input = await waitFor(() => findDateTrigger(), { timeout: 8000 });
    if (!input) throw new AppError(failMessage);
    fullClick(input);
    await wait(1000);

    const shortcut = await waitFor(
      () => {
        const scoped = $$vis('.bi-date-shortcuts li').filter((li) =>
          shortcutRe.test(squash(li.textContent))
        );
        if (scoped.length) return scoped[0];
        // The shortcut column is a plain list in the popup; match its text.
        const loose = queryText(shortcutRe).filter(
          (el) => squash(el.textContent).length < 20
        );
        return loose[0] || null;
      },
      { timeout: 5000 }
    );
    if (!shortcut) throw new AppError(failMessage);
    // The panel only appears on hover; a click would dismiss it.
    hover(shortcut);
    await wait(1000);

    const panel = await waitFor(() => $$vis('.eds-date-picker-panel')[0], {
      timeout: 5000
    });
    if (!panel) throw new AppError(failMessage);
    return panel;
  }

  /**
   * Step the calendar back to the target month and click the day cell.
   * Shopee uses div.eds-date-table__cell, NOT td, and ships TWO prev arrows:
   * [0] = year, [1] = month. Clicking [0] jumps a whole year.
   */
  async function pickCalendarDay(panel, params, failMessage) {
    for (let i = 0; i < (params.monthsBack || 0); i++) {
      const prevs = $$('.eds-picker-header__prev').filter(isVisible);
      const monthPrev = prevs[1];
      if (!monthPrev) throw new AppError(failMessage);
      fullClick(monthPrev);
      await wait(1000);
    }

    const datePanel = $$vis('.eds-date-picker-panel__date')[0] || panel;
    const target = String(params.targetDay);

    const cell = await waitFor(
      () => {
        const cells = $$('.eds-date-table__cell', datePanel).filter(isVisible);
        // Leading/trailing cells belong to the neighbouring months.
        const inMonth = cells.filter(
          (c) => !/prev|next|other|outside|disabled/i.test(c.className)
        );
        const pool = inMonth.length ? inMonth : cells;
        return pool.find((c) => (c.textContent || '').trim() === target) || null;
      },
      { timeout: 5000 }
    );
    if (!cell) throw new AppError(failMessage);

    fullClick(cell);
    await wait(1000);
    return true;
  }

  /**
   * Export 3: By Day.
   *
   * Uses the calendar, NOT a text input. Typing into the first visible
   * input[type=text] hits Shopee's "Search product" box, which filters the
   * table to nothing and exports an empty sheet.
   */
  async function selectSpecificDate(params) {
    report(`Selecting date ${params.targetDate}…`);
    const panel = await openBiCalendar(/^by\s*day$/i, ERR.DAY_FAILED);
    return pickCalendarDay(panel, params, ERR.DAY_FAILED);
  }

  /** Export 5: By Week — same calendar, "By Week" shortcut. */
  async function selectSpecificWeek(params) {
    report('Selecting last week in the calendar…');
    const panel = await openBiCalendar(/^by\s*week$/i, ERR.WEEK_FAILED);
    return pickCalendarDay(panel, params, ERR.WEEK_FAILED);
  }

  /* --- Latest Reports panel ------------------------------------------ *
   *
   * The panel lists PREVIOUS reports, each with its own Download link. So
   * "is the word Download on the page" is not a readiness test — it is true
   * the instant the panel opens, against a stale row. Everything below exists
   * to identify the row our own Export click created.
   */

  /** The container that holds the report rows, if we can find it. */
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  const FILE_EXT_RE = /\.(?:xlsx|xls|csv|zip)\b/i;
  /** A row's label ends with the extension, e.g. "…-04/08/2026.csv". */
  const NAME_END_RE = /\.(?:xlsx|xls|csv|zip)$/i;

  function countFiles(text) {
    const hits = String(text || '').match(/\.(?:xlsx|xls|csv|zip)\b/gi);
    return hits ? hits.length : 0;
  }

  /**
   * Turn a panel's DISPLAY name into the filename Shopee actually serves.
   *
   * The panel shows "Shop GMV MAX-Detail-Data-29/07/2026-04/08/2026.csv" but
   * the delivered file is "Shop+GMV+MAX-Detail-Data-29_07_2026-04_08_2026.csv":
   * slashes become underscores and spaces become plus signs.
   */
  function normalizeShopeeName(display) {
    return sanitizeFilename(
      String(display || '')
        .replace(/\//g, '_')
        .replace(/\s+/g, '+')
    );
  }

  function findReportsPanel() {
    const heads = queryText(/^Latest Reports$/i);
    for (const head of heads) {
      let node = head;
      for (let up = 0; up < 8 && node; up++) {
        node = node.parentElement;
        if (node && FILE_EXT_RE.test(node.innerText || '')) return node;
      }
    }
    return null;
  }

  /**
   * The Download control for one row.
   *
   * Must be an exact "Download" match. A row that has already been fetched
   * shows the STATUS TEXT "Downloaded" instead of a button, and the panel's
   * own notice reads "Here are the reports you have not downloaded" — a loose
   * /download/i test matches both and is why the old build clicked the wrong
   * row.
   */
  function findDownloadControl(root) {
    const candidates = $$('button, a, span, div', root).filter(
      (el) => isVisible(el) && /^download$/i.test(squash(el.textContent))
    );
    const innermost = candidates.filter(
      (el) => !candidates.some((o) => o !== el && el.contains(o))
    );
    return innermost[0] || null;
  }

  /**
   * Read the Latest Reports rows as {name, button}. Rows are anchored on the
   * filename, which is the only stable identity Shopee gives us — position is
   * not enough, because already-downloaded rows lose their button.
   */
  function readReportRows() {
    const panel = findReportsPanel();
    if (!panel) return [];

    const nameEls = $$('*', panel).filter((el) => {
      const text = squash(el.textContent);
      // The label IS the filename, so anchor on the extension at the end —
      // a substring match would truncate names containing "/" to "2026.csv".
      if (!text || text.length > 150 || !NAME_END_RE.test(text)) return false;
      // innermost element holding the filename
      return !Array.from(el.children).some((child) =>
        FILE_EXT_RE.test(squash(child.textContent))
      );
    });

    return nameEls.map((nameEl) => {
      const name = squash(nameEl.textContent);
      let row = nameEl;
      let button = null;
      for (let up = 0; up < 6; up++) {
        const parent = row.parentElement;
        if (!parent || parent === panel) break;
        // Stop at the row boundary. Climbing into the row LIST would happily
        // return the next row's Download button for a report that is still
        // generating — which is how the wrong file gets downloaded.
        if (countFiles(parent.innerText) > 1) break;
        row = parent;
        button = findDownloadControl(row);
        if (button) break;
      }
      return { name, row, button };
    });
  }

  function countNames(rows) {
    const counts = new Map();
    for (const r of rows) counts.set(r.name, (counts.get(r.name) || 0) + 1);
    return counts;
  }

  /** Rows present now that were not present before, newest first. */
  function newRows(before, after) {
    const had = countNames(before);
    const seen = new Map();
    const fresh = [];
    for (const row of after) {
      const n = (seen.get(row.name) || 0) + 1;
      seen.set(row.name, n);
      if (n > (had.get(row.name) || 0)) fresh.push(row);
    }
    return fresh;
  }

  // Shopee rejects a second export inside its cooldown window with a toast.
  const COOLDOWN_RE =
    /(please wait|try again|too frequent|too often|once (a|per) minute|1 minute|60 ?s|rate limit|slow down)/i;

  function cooldownToast() {
    const text = (document.body && document.body.innerText) || '';
    const hit = text.match(COOLDOWN_RE);
    return hit ? squash(hit[0]) : '';
  }

  async function clickExportBI() {
    const btn = await waitFor(() => $$vis('button.export')[0], {
      timeout: 15000
    });
    if (!btn) throw new AppError(ERR.NO_EXPORT_BUTTON);
    fullClick(btn);
    return true;
  }

  /**
   * Wait for a report row that did not exist before, and that offers a
   * Download button (i.e. has finished generating).
   */
  async function awaitNewReportRow(before, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    // If the panel was closed when we snapshotted, every row looks new. In
    // that case trust only the TOP row — Shopee lists newest first, and
    // "first row that has a button" would happily pick an older report while
    // ours is still generating.
    const haveBaseline = before.length > 0;
    let announced = '';

    while (Date.now() < deadline) {
      checkCancel();

      const toast = cooldownToast();
      if (toast) return { rateLimited: true, toast };

      const rows = readReportRows();
      if (rows.length) {
        const candidates = haveBaseline ? newRows(before, rows) : rows.slice(0, 1);
        const ready = candidates.find((r) => r.button);
        if (ready) {
          report(`${label}: ${ready.name} is ready.`);
          return { row: ready };
        }
        const pending = candidates[0];
        if (pending && pending.name !== announced) {
          announced = pending.name;
          report(`${label}: ${pending.name} is still generating…`);
        }
      }
      await wait(2000);
    }
    return {};
  }

  /* ================================================================== *
   * File capture
   * ================================================================== */
  /** Drop control characters without embedding any in this source file. */
  function stripControlChars(s) {
    let out = '';
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      if (code >= 32 && code !== 127) out += ch;
    }
    return out;
  }

  function sanitizeFilename(name) {
    return stripControlChars(String(name || ''))
      .split(/[\\/]/)
      .pop()
      // Windows-illegal characters. '+' and spaces are kept on purpose —
      // Shopee's own names contain them and must not change.
      .replace(/[<>:"|?*]/g, '')
      .replace(/^\.+/, '')
      .trim();
  }

  function extFromMime(mime, dataUrl) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('spreadsheetml') || m.includes('excel')) return 'xlsx';
    if (m.includes('csv')) return 'csv';
    // Fallback per spec: PK magic bytes => xlsx (zip container), else csv.
    try {
      const b64 = String(dataUrl || '').split(',')[1] || '';
      const head = atob(b64.slice(0, 8));
      if (head.startsWith('PK')) return 'xlsx';
    } catch (_) {
      /* ignore */
    }
    return 'csv';
  }

  function filenameFromDisposition(disposition) {
    if (!disposition) return '';
    // filename*=UTF-8''... wins over filename="..."
    const star = /filename\*\s*=\s*([^;]+)/i.exec(disposition);
    if (star) {
      let v = star[1].trim();
      const parts = v.split("''");
      v = parts.length > 1 ? parts[1] : v;
      try {
        // Decode %XX only. '+' is a literal in Shopee's GMV Max filenames.
        return decodeURIComponent(v.replace(/^"|"$/g, ''));
      } catch (_) {
        return v.replace(/^"|"$/g, '');
      }
    }
    const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(disposition);
    if (plain) {
      const v = (plain[2] != null ? plain[2] : plain[1]).trim();
      try {
        return decodeURIComponent(v);
      } catch (_) {
        return v;
      }
    }
    return '';
  }

  function blobFilename(blobCapture, fallbackBase) {
    // The blob carries no name; the anchor Shopee clicks does.
    const byUrl = captures.anchors
      .filter((a) => a.url === blobCapture.url && a.filename)
      .pop();
    if (byUrl) return sanitizeFilename(byUrl.filename);
    const anyAnchor = captures.anchors.filter((a) => a.filename).pop();
    if (anyAnchor) return sanitizeFilename(anyAnchor.filename);
    return `${fallbackBase}.${extFromMime(blobCapture.mime, blobCapture.dataUrl)}`;
  }

  async function saveDataUrl(dataUrl, filename) {
    const res = await bg({
      type: 'saveFile',
      dataUrl,
      filename: sanitizeFilename(filename)
    });
    if (!res || !res.ok) {
      throw new AppError(
        (res && res.error) || 'Chrome refused to save the downloaded file.'
      );
    }
    return res.filename;
  }

  // Shopee's direct_download endpoint answers with a placeholder name rather
  // than the report's own. Anything matching this is not a real filename.
  // Chrome appends " (2)" when uniquifying, so that variant is generic too.
  const GENERIC_NAME_RE =
    /^(download|attachment|file|export|report)(\s*\(\d+\))?\.(?:xlsx|xls|csv|zip)$/i;

  /** Fetch a Shopee URL with the user's session cookies and save the bytes. */
  async function saveFromUrl(rawUrl, fallbackBase, preferredName) {
    const url = rawUrl.startsWith('/')
      ? `https://seller.shopee.com.my${rawUrl}`
      : rawUrl;
    report('Fetching report file…');
    let res;
    try {
      res = await fetch(url, { credentials: 'include' });
    } catch (e) {
      throw new AppError(`Network error: ${e && e.message ? e.message : e}`);
    }
    if (!res.ok) {
      throw new AppError(
        `Network error: Shopee returned HTTP ${res.status} for the report file.`
      );
    }
    const blob = await res.blob();
    if (!blob || blob.size === 0) {
      throw new AppError(ERR.NO_BLOB);
    }
    const dataUrl = await blobToDataUrl(blob);
    // Name priority. Shopee's direct_download endpoint answers with a
    // placeholder Content-Disposition ("download.csv"), so a name we read off
    // the report list beats it, and the export's own fallback beats the
    // placeholder too. "download.csv" must never reach disk.
    const served = sanitizeFilename(
      filenameFromDisposition(res.headers.get('content-disposition'))
    );
    const fromUrl = sanitizeFilename(
      decodeURIComponent(url.split('?')[0].split('/').pop() || '')
    );

    let name = '';
    if (preferredName) name = preferredName;
    else if (served && !GENERIC_NAME_RE.test(served)) name = served;
    else if (/\.(csv|xlsx|xls|zip)$/i.test(fromUrl) && !GENERIC_NAME_RE.test(fromUrl)) {
      name = fromUrl;
    } else name = `${fallbackBase}.${extFromMime(blob.type, dataUrl)}`;

    return saveDataUrl(dataUrl, name);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new AppError(ERR.NO_BLOB));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Trigger a download and capture the file, whichever way Shopee delivers it.
   *
   *   1. Shopee's own browser download  -> the background rewrites its path
   *      into the dated folder (no duplicate file, original name preserved).
   *   2. get_download_url API response  -> fetch it with cookies.
   *   3. Intercepted blob               -> save its bytes ourselves.
   *
   * The interceptor is always live (document_start, MAIN world), so the blob
   * is captured whether or not we get here first.
   */
  async function triggerAndCapture(trigger, opts) {
    const o = opts || {};
    clearCaptures();
    await bg({ type: 'armDownload' });

    await trigger();
    await wait(o.settleMs == null ? 5000 : o.settleMs);

    const extraRounds = o.extraRounds == null ? 8 : o.extraRounds;
    for (let i = 0; i <= extraRounds; i++) {
      checkCancel();

      const watch = await bg({ type: 'checkDownload' });
      if (watch && watch.captured) {
        return { filename: watch.filename, via: 'browser' };
      }

      const api = captures.apis
        .filter((a) => a.json && a.json.data && a.json.data.download_url)
        .pop();
      if (api) {
        return {
          filename: await saveFromUrl(
            api.json.data.download_url,
            o.fallbackBase,
            o.preferredName
          ),
          via: 'api'
        };
      }

      const blob = captures.blobs[captures.blobs.length - 1];
      if (blob && blob.dataUrl) {
        const name = blobFilename(blob, o.fallbackBase) || o.preferredName;
        return { filename: await saveDataUrl(blob.dataUrl, name), via: 'blob' };
      }

      const link = captures.links[captures.links.length - 1];
      if (link && link.url) {
        return {
          filename: await saveFromUrl(link.url, o.fallbackBase, o.preferredName),
          via: 'link'
        };
      }

      if (i < extraRounds) {
        report(`Waiting for the file… ${(i + 1) * 2}s`);
        await wait(2000);
      }
    }

    throw new AppError(ERR.NO_BLOB);
  }

  /**
   * Export a BI report and download the row it created.
   *
   * Never clicks "the first Download in the panel" — the newest row may show
   * the status text "Downloaded" and have no button at all, in which case the
   * first button belongs to an older, unrelated report.
   */
  async function downloadBIReport(fallbackBase) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = readReportRows();
      report(
        attempt === 1
          ? 'Clicking Export Data…'
          : `Clicking Export Data (attempt ${attempt})…`
      );
      await clickExportBI();
      await wait(5000); // spec: report generation triggered

      const result = await collectBIReport(before, fallbackBase, true);
      if (result) return result;
      // rate-limited or nothing new appeared — try the whole cycle again
    }
    throw new AppError(ERR.NO_NEW_REPORT);
  }

  /**
   * Wait for the row created by an Export click and download it.
   *
   * `retryable` is set by Slow n Steady, which can click Export again; it makes
   * a rate-limit or a no-show return null instead of throwing. Fast n Furious
   * has already moved on from the trigger, so it wants the error.
   */
  async function collectBIReport(before, fallbackBase, retryable) {
    const outcome = await awaitNewReportRow(before, 300000, 'Latest Reports');

    if (outcome.rateLimited) {
      report(`Shopee is rate-limiting exports ("${outcome.toast}") — waiting 60s…`);
      await wait(60000);
      if (retryable) return null;
      throw new AppError(ERR.NO_NEW_REPORT);
    }
    if (!outcome.row) {
      if (retryable) return null;
      throw new AppError(ERR.NO_NEW_REPORT);
    }

    const expected = outcome.row.name;
    // Re-resolve the button: the panel re-renders while it generates.
    const target = await waitFor(
      () => {
        const row = readReportRows().find((r) => r.name === expected && r.button);
        return row ? row.button : null;
      },
      { timeout: 30000 }
    );
    if (!target) throw new AppError(ERR.DOWNLOAD_TIMEOUT);

    const wanted = normalizeShopeeName(expected);
    expectName(wanted);
    const result = await triggerAndCapture(async () => fullClick(target), {
      settleMs: 5000,
      preferredName: wanted,
      fallbackBase: wanted.replace(/\.[^.]+$/, '') || fallbackBase
    });

    // Shopee named the row; anything else means we grabbed the wrong file.
    if (result.filename && wanted && normalizeShopeeName(result.filename) !== wanted) {
      throw new AppError(
        `Downloaded "${result.filename}" but Shopee's new report was "${expected}". ${ERR.STALE_REPORT}`
      );
    }
    return result;
  }

  /* ================================================================== *
   * Shopee Ads (Exports 6-7)
   * ================================================================== */
  async function openAdsExportDropdown() {
    report('Opening the Export Data menu…');
    const btn = await waitFor(
      () =>
        $$vis('div.eds-dropdown.export button, div.export-button button')[0] ||
        null,
      { timeout: 15000 }
    );
    if (!btn) throw new AppError(ERR.NO_EXPORT_BUTTON);
    fullClick(btn);
    await wait(2000); // dropdown animation
    return btn;
  }

  async function clickAdsDropdownItem(matcher, humanLabel, trigger) {
    report(`Choosing "${humanLabel}"…`);

    const item = await waitFor(
      () => {
        const primary = $$vis('li.eds-dropdown-item').filter((li) =>
          matcher.test((li.textContent || '').trim())
        );
        if (primary.length) return primary[0];

        const fallback = $$vis(
          '[class*="dropdown-item"], [class*="menu-item"], [role="option"], [role="menuitem"], li'
        ).filter((el) => {
          if (el === trigger || el.contains(trigger)) return false;
          const text = (el.textContent || '').trim();
          return text && text.length < 120 && matcher.test(text);
        });
        // Innermost match wins, so we don't click a wrapping <ul>.
        const innermost = fallback.filter(
          (el) => !fallback.some((o) => o !== el && el.contains(o))
        );
        return innermost[0] || null;
      },
      { timeout: 10000 }
    );

    if (!item) {
      throw new AppError(
        `Could not find the "${humanLabel}" option in the Export menu. Shopee's UI may have changed.`
      );
    }
    fullClick(item);
    await wait(3000); // let the dropdown settle
    return true;
  }

  async function confirmModal() {
    report('Confirming the export…');
    const btn = await waitFor(
      () => {
        const buttons = $$vis('button').filter((b) =>
          /^confirm$/i.test((b.textContent || '').trim())
        );
        if (buttons.length) return buttons[0];
        const loose = $$vis('button').filter((b) =>
          /confirm/i.test((b.textContent || '').trim())
        );
        return loose[0] || null;
      },
      { timeout: 15000 }
    );
    if (!btn) throw new AppError(ERR.NO_CONFIRM);
    fullClick(btn);
    await wait(5000); // report generation starts
    return true;
  }

  function getCookie(name) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(
      document.cookie || ''
    );
    return match ? match[1] : '';
  }

  function apiUrl(path) {
    const spc = getCookie('SPC_CDS');
    const params = new URLSearchParams();
    if (spc) params.set('SPC_CDS', spc);
    params.set('SPC_CDS_VER', '2');
    return `https://seller.shopee.com.my${path}?${params.toString()}`;
  }

  function reportList(json) {
    if (!json) return [];
    const d = json.data;
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.list)) return d.list;
    if (d && Array.isArray(d.result)) return d.result;
    if (d && Array.isArray(d.data)) return d.data;
    if (Array.isArray(json.list)) return json.list;
    return [];
  }

  function isReady(entry) {
    const status = String(entry.status == null ? '' : entry.status).toLowerCase();
    if (status === 'success') return true;
    if (entry.download_url) return true;
    return false;
  }

  const NAME_KEYS = [
    'file_name', 'filename', 'fileName',
    'report_name', 'reportName', 'name', 'export_file_name'
  ];

  /** Shopee's field name for the report title is undocumented — try them all. */
  function entryName(entry) {
    for (const key of NAME_KEYS) {
      if (entry && entry[key]) return String(entry[key]);
    }
    return '';
  }

  /**
   * The GMV Max report is generated server-side, so poll the export-job list
   * until it reports success.
   *
   * Matching cannot depend on the entry carrying a name — the live API returns
   * entries whose name field we cannot rely on. Prefer a GMV-looking name when
   * one is there, otherwise take the newest ready job, which is the one the
   * Confirm click just created.
   */
  async function pollGmvMax(knownIds) {
    const listUrl = apiUrl('/api/pas/v1/report/export_job/list_homepage_result/');
    const seenBefore = knownIds instanceof Set ? knownIds : new Set();

    for (let i = 0; i < 120; i++) {
      // 120 x 5s = 10 minutes
      checkCancel();
      if (i % 4 === 0) {
        report(`Waiting for the GMV Max report… ${i * 5}s`);
      }

      let json = null;
      try {
        const res = await fetch(listUrl, { credentials: 'include' });
        if (res.ok) json = await res.json();
      } catch (_) {
        json = null; // transient — keep polling
      }

      if (json) {
        const ready = reportList(json).filter(isReady);

        // 1. an entry that names itself as GMV
        const named = ready.find((r) => /gmv/i.test(entryName(r)));
        if (named) {
          report('GMV Max report ready — fetching download link…');
          return named;
        }

        // 2. a job that did not exist before we clicked Confirm
        const fresh = ready.find((r) => {
          const id = r.export_id != null ? r.export_id : r.id;
          return id != null && !seenBefore.has(String(id));
        });
        if (fresh) {
          report('New export job finished — fetching download link…');
          return fresh;
        }
      }

      await wait(5000);
    }

    throw new AppError(ERR.NO_GMV);
  }

  /** Job ids present before we asked for a new export. */
  async function snapshotExportJobs() {
    const ids = new Set();
    try {
      const res = await fetch(
        apiUrl('/api/pas/v1/report/export_job/list_homepage_result/'),
        { credentials: 'include' }
      );
      if (res.ok) {
        for (const r of reportList(await res.json())) {
          const id = r.export_id != null ? r.export_id : r.id;
          if (id != null) ids.add(String(id));
        }
      }
    } catch (_) {
      /* best effort — matching falls back to the name */
    }
    return ids;
  }

  /**
   * The report's name, tried in the order we actually trust.
   *
   * The Latest Reports panel is first because it is the one place the name is
   * guaranteed to be shown; the list API's field name is not documented and
   * has already burned us once (an unset "file_name" left files called
   * download.csv).
   */
  function gmvReportName(before, entry) {
    const rows = readReportRows();
    const fresh = before && before.length ? newRows(before, rows) : rows;
    const panelRow = fresh.find((r) => /gmv/i.test(r.name));
    if (panelRow) return normalizeShopeeName(panelRow.name);

    const fromEntry = entryName(entry);
    return fromEntry ? normalizeShopeeName(fromEntry) : '';
  }

  async function downloadGmvMax(before, fallbackBase) {
    // Publish the name up front: Shopee may fire its own download while we are
    // still polling, and a name known late is a name known too late.
    const early = gmvReportName(before, null);
    if (early) expectName(early);

    const entry = await pollGmvMax(pendingJobIds);
    const exportId = entry.export_id != null ? entry.export_id : entry.id;

    let downloadUrl = entry.download_url || '';
    if (!downloadUrl) {
      const postUrl = apiUrl('/api/pas/v1/report/export_job/get_download_url/');
      let json;
      try {
        const res = await fetch(postUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ export_id: exportId })
        });
        if (!res.ok) {
          throw new AppError(
            `Network error: Shopee returned HTTP ${res.status} for the GMV Max download link.`
          );
        }
        json = await res.json();
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError(`Network error: ${e && e.message ? e.message : e}`);
      }
      downloadUrl = (json && json.data && json.data.download_url) || '';
    }

    if (!downloadUrl) throw new AppError(ERR.NO_GMV);

    const preferred = gmvReportName(before, entry);
    const base =
      preferred.replace(/\.[^.]+$/, '') ||
      fallbackBase ||
      'Shop+GMV+MAX-Detail-Data';
    if (preferred) {
      report(`GMV Max report: ${preferred}`);
      expectName(preferred);
    }
    return {
      filename: await saveFromUrl(downloadUrl, base, preferred),
      via: 'api'
    };
  }

  /**
   * Same panel, same rule as BI: download the row this export created, matched
   * by name. `before` is captured by the caller, prior to opening the dropdown.
   */
  async function downloadAdsOverall(before, fallbackBase) {
    const outcome = await awaitNewReportRow(before, 360000, 'Latest Reports');
    if (outcome.rateLimited) {
      throw new AppError(
        `Shopee is rate-limiting exports ("${outcome.toast}"). Wait a minute and re-run this export.`
      );
    }
    if (!outcome.row) throw new AppError(ERR.DOWNLOAD_TIMEOUT);

    const expected = outcome.row.name;
    const target = await waitFor(
      () => {
        const row = readReportRows().find((r) => r.name === expected && r.button);
        return row ? row.button : null;
      },
      { timeout: 30000 }
    );
    if (!target) throw new AppError(ERR.DOWNLOAD_TIMEOUT);

    const wanted = normalizeShopeeName(expected);
    expectName(wanted);
    const result = await triggerAndCapture(async () => fullClick(target), {
      settleMs: 5000,
      preferredName: wanted,
      fallbackBase: wanted.replace(/\.[^.]+$/, '') || fallbackBase
    });
    if (
      result.filename &&
      wanted &&
      normalizeShopeeName(result.filename) !== wanted
    ) {
      throw new AppError(
        `Downloaded "${result.filename}" but Shopee's new report was "${expected}". ${ERR.STALE_REPORT}`
      );
    }
    return result;
  }

  /* ================================================================== *
   * Export drivers
   * ================================================================== */

  /**
   * How long to let the SPA settle before touching it. 15s from a cold page
   * load; Fast n Furious preloads its tabs and has already waited, so it
   * passes a much shorter value.
   */
  function spaWait(params) {
    const ms = params && params.initialWaitMs;
    return typeof ms === 'number' && ms >= 0 ? ms : 15000;
  }
  /**
   * An export is three separable steps. Slow n Steady runs them back to back
   * in one tab. Fast n Furious runs each step across ALL tabs before moving
   * to the next, so that seven reports generate on Shopee's side at the same
   * time instead of one after another.
   *
   *   prepare  select the data period, wait for the table to load
   *   trigger  click Export Data (fast; the report then generates remotely)
   *   collect  wait for the finished row and download it
   *
   * `pending` carries the panel snapshot from trigger to collect, which is
   * safe because the tab never navigates between the two.
   */
  let pending = null;
  /** Export-job ids that existed before the GMV Max Confirm click. */
  let pendingJobIds = new Set();

  /** Phase 1 — get this tab showing the right data period. */
  async function prepareExport(exportDef, params) {
    report('Waiting for the page to render…');
    await wait(spaWait(params)); // spec: non-negotiable SPA wait

    if (exportDef.kind !== 'bi') {
      // The Ads exports have no period to choose — the dropdown item IS the
      // export, so there is nothing to prepare beyond the page being up.
      report('Ads page ready.');
      return { ok: true, prepared: true };
    }

    await openProductPerformanceTab();

    // Driven by the params, not by which report this is. Any row can need the
    // calendar now: on a pinned run Yesterday and Past 7 Days cannot use
    // Shopee's own buttons, because those are anchored to the real today.
    //
    // Both calendar flows deliberately skip selectPeriodBI — clicking the
    // period dropdown closes the picker.
    if (params.useCalendarWeek) {
      await selectSpecificWeek(params);
    } else if (params.useCalendarDate) {
      await selectSpecificDate(params);
    } else if (exportDef.key === 'realtime') {
      const active = await waitFor(() => queryText(/Real[-\s]?Time/i)[0], {
        timeout: 5000
      });
      if (!active) await selectPeriodBI('Real-Time');
    } else {
      await selectPeriodBI(exportDef.label);
    }

    await wait(2000); // let the table reload for the new period
    report('Data period set.');
    return { ok: true, prepared: true };
  }

  /** Phase 2 — ask Shopee to build the report. Deliberately does not wait. */
  async function triggerExport(exportDef, params) {
    // Snapshot the panel first, so the row this click creates can be told
    // apart from reports that were already listed.
    const before = readReportRows();

    if (exportDef.kind === 'bi') {
      report('Clicking Export Data…');
      await clickExportBI();
    } else {
      const trigger = await openAdsExportDropdown();
      if (exportDef.key === 'overall') {
        await clickAdsDropdownItem(/overall/i, 'Overall', trigger);
      } else {
        // Record the existing jobs first, so the one this click creates can be
        // recognised even if its entry carries no usable name.
        pendingJobIds = await snapshotExportJobs();
        await clickAdsDropdownItem(/gmv\s*max/i, 'GMV Max', trigger);
        await confirmModal();
      }
    }

    pending = { before, key: exportDef.key };
    await wait(3000); // let the request land before we switch away

    // Shopee can start its own download the moment the report is ready, which
    // may be before we come back to collect. Learn the name now if the panel
    // already shows the new row, so that download is not left as download.csv.
    const fresh = newRows(before, readReportRows())[0];
    if (fresh) expectName(normalizeShopeeName(fresh.name));

    report('Export requested — generating.');
    return { ok: true, triggered: true };
  }

  /** Phase 3 — collect the finished report. */
  async function collectExport(exportDef, params) {
    const before = pending && pending.key === exportDef.key ? pending.before : [];
    pending = null;

    if (exportDef.key === 'gmv_max') {
      return downloadGmvMax(before, params.fallbackBase);
    }
    if (exportDef.kind === 'ads') {
      return downloadAdsOverall(before, params.fallbackBase);
    }
    return collectBIReport(before, params.fallbackBase);
  }

  /* --- Slow n Steady: the three phases run together ------------------- */
  async function runBiExport(exportDef, params) {
    await prepareExport(exportDef, params);
    // downloadBIReport owns the Export click here: it retries the whole
    // trigger-and-wait cycle if Shopee pushes back.
    return downloadBIReport(params.fallbackBase);
  }

  async function runAdsExport(exportDef, params) {
    await prepareExport(exportDef, params);
    await triggerExport(exportDef, params);
    return collectExport(exportDef, params);
  }

  /* ================================================================== *
   * Message router
   * ================================================================== */
  async function handle(msg) {
    switch (msg.type) {
      case 'ping':
        return { ok: true, url: window.location.href };

      case 'checkLogin': {
        startHeartbeat();
        try {
          return { ok: true, ...(await checkLogin()) };
        } finally {
          stopHeartbeat();
        }
      }

      case 'runExport': {
        cancelled = false;
        startHeartbeat();
        try {
          const def = msg.export;
          const params = msg.params || {};
          const result =
            def.kind === 'ads'
              ? await runAdsExport(def, params)
              : await runBiExport(def, params);
          return { ok: true, filename: result.filename, via: result.via };
        } finally {
          stopHeartbeat();
        }
      }

      // Fast n Furious drives the three phases separately, across every tab.
      case 'prepareExport':
      case 'triggerExport':
      case 'collectExport': {
        cancelled = false;
        startHeartbeat();
        try {
          const def = msg.export;
          const params = msg.params || {};
          if (msg.type === 'prepareExport') return await prepareExport(def, params);
          if (msg.type === 'triggerExport') return await triggerExport(def, params);
          const result = await collectExport(def, params);
          return { ok: true, filename: result.filename, via: result.via };
        } finally {
          stopHeartbeat();
        }
      }

      default:
        return { ok: false, error: `Unknown message: ${msg.type}` };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    handle(msg).then(
      (result) => sendResponse(result),
      (err) => {
        stopHeartbeat();
        const friendly = err && err.friendly;
        sendResponse({
          ok: false,
          cancelled: err instanceof Cancelled,
          error: friendly
            ? err.message
            : `${(err && err.message) || String(err)}`
        });
      }
    );
    return true; // async response
  });
})();

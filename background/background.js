/**
 * Service worker: orchestrator.
 *
 * Owns tab navigation, the run state machine, and every write to disk.
 * It knows nothing about Shopee's DOM — that lives in content/content.js.
 *
 * MV3 note: this worker is evicted after ~30s idle. The content script pings
 * us every 10s while an export runs, and each message resets that timer, which
 * is what keeps a 10-minute GMV Max poll alive.
 */
'use strict';

const BI_URL = 'https://seller.shopee.com.my/datacenter/product/overview';
const ADS_URL = 'https://seller.shopee.com.my/portal/marketing/pas/index';
const LOGIN_URL = 'https://seller.shopee.com.my/datacenter/overview';
const ROOT_FOLDER = 'Shopee daily report';

const EXPORTS = [
  { id: 1, key: 'realtime', name: 'Real Time', label: 'Real-Time', kind: 'bi', url: BI_URL },
  { id: 2, key: 'yesterday', name: 'Yesterday', label: 'Yesterday', kind: 'bi', url: BI_URL },
  { id: 3, key: 'byday_3ago', name: 'By Day (3 days ago)', label: 'By Day', kind: 'bi', url: BI_URL },
  { id: 4, key: 'past7d', name: 'Past 7 Days', label: 'Past 7 Days', kind: 'bi', url: BI_URL },
  { id: 5, key: 'byweek_last', name: 'By Week (last week)', label: 'By Week', kind: 'bi', url: BI_URL },
  { id: 6, key: 'overall', name: 'Ads Overall', label: 'Overall', kind: 'ads', url: ADS_URL },
  { id: 7, key: 'gmv_max', name: 'Ads GMV MAX', label: 'GMV Max', kind: 'ads', url: ADS_URL }
];

const ERR = {
  NOT_LOGGED_IN: 'Please log in to Shopee Seller Center first, then click Download.',
  PAGE_TIMEOUT:
    'Shopee Seller Center took too long to load. Check your internet connection and try again.',
  TAB_GONE: 'The Shopee tab was closed. Start the download again.',
  CANCELLED: 'Cancelled.'
};

class AppError extends Error {
  constructor(message) {
    super(message);
    this.friendly = true;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ==================================================================== *
 * Run state
 * ==================================================================== */
const state = {
  running: false,
  cancel: false,
  mode: 'steady',
  tabId: null,
  tabIds: [],
  folder: null,
  startedAt: null,
  finishedAt: null,
  currentId: null,
  lastExportAt: 0,
  expectedName: '',
  pendingSavePath: '',
  lastDownloadId: null,
  error: '',
  results: {},
  // Download watcher, armed by the content script just before it clicks.
  watch: { armed: false, capturedId: null, capturedName: '' }
};

function blankResults(ids) {
  const out = {};
  for (const ex of EXPORTS) {
    out[ex.id] = {
      id: ex.id,
      name: ex.name,
      status: ids.includes(ex.id) ? 'pending' : 'skipped',
      detail: ids.includes(ex.id) ? 'Waiting…' : '',
      filename: '',
      error: ''
    };
  }
  return out;
}

function publicState() {
  return {
    running: state.running,
    cancel: state.cancel,
    mode: state.mode,
    folder: state.folder,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    currentId: state.currentId,
    error: state.error,
    results: state.results
  };
}

function persist() {
  chrome.storage.local.set({ runState: publicState() }).catch(() => {});
}

function setResult(id, patch) {
  const row = state.results[id];
  if (!row) return;
  Object.assign(row, patch);
  persist();
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

/* ==================================================================== *
 * Dates & paths
 * ==================================================================== */
function pad(n) {
  return String(n).padStart(2, '0');
}

/** "03082026-Monday" */
function dateFolder(d) {
  const day = d.toLocaleDateString('en-US', { weekday: 'long' });
  return `${pad(d.getDate())}${pad(d.getMonth() + 1)}${d.getFullYear()}-${day}`;
}

function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function basename(p) {
  return String(p || '').split(/[\\/]/).pop();
}

function fallbackBase(ex) {
  if (ex.kind === 'bi') return 'parentskudetail';
  if (ex.key === 'overall') return 'Shopee-Ads-Overall-Data';
  return 'Shop+GMV+MAX-Detail-Data';
}

/** Whole months from `target` up to `now` — how many times to click the
 *  calendar's month-back arrow. */
function monthsBetween(now, target) {
  return Math.max(
    0,
    now.getFullYear() * 12 +
      now.getMonth() -
      (target.getFullYear() * 12 + target.getMonth())
  );
}

function computeParams(ex) {
  const now = new Date();
  const params = { fallbackBase: fallbackBase(ex) };

  if (ex.key === 'byday_3ago') {
    // Boss's counting: "3 days ago" == today - 2.
    const target = new Date(now);
    target.setDate(now.getDate() - 2);
    params.targetDate = ymd(target);
    params.targetDay = target.getDate();
    params.monthsBack = monthsBetween(now, target);
  }

  if (ex.key === 'byweek_last') {
    const dow = now.getDay(); // 0 = Sunday
    const daysFromMonday = dow === 0 ? 6 : dow - 1;
    const currentMonday = new Date(now);
    currentMonday.setDate(now.getDate() - daysFromMonday);
    const target = new Date(currentMonday);
    target.setDate(currentMonday.getDate() - 14); // week before last
    params.targetDate = ymd(target);
    params.targetDay = target.getDate();
    params.monthsBack = monthsBetween(now, target);
  }

  return params;
}

/* ==================================================================== *
 * Downloads
 * ==================================================================== */

/**
 * Shopee's own download (blob: anchor click) would land in the default
 * Downloads folder under a name we did not choose. Redirect it into the dated
 * subfolder instead — this keeps Shopee's original filename AND avoids the
 * duplicate file we'd get by also saving the intercepted blob ourselves.
 *
 * Registered at top level so it survives service worker restarts.
 */
// Shopee's download endpoints redirect to its CDN, so the URL that reaches
// Chrome is often NOT seller.shopee.com.my. Matching only that host let files
// escape into the plain Downloads folder under Chrome's own name.
const SHOPEE_HOST_RE = /shopee|susercontent|shopeemobile/i;

// A name Chrome invented because the response carried no useful one.
const GENERIC_DOWNLOAD_RE =
  /^(download|attachment|file|export|report)(\s*\(\d+\))?\.(?:xlsx|xls|csv|zip)$/i;

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  try {
    if (!state.running || !state.folder) return; // leave unrelated downloads alone
    const url = item.url || '';

    // Our own saveFile download. The `filename` passed to downloads.download()
    // is only a SUGGESTION that any listener — ours or another extension's —
    // can override, and something on this machine was overriding it, dropping
    // the file into plain Downloads. Re-assert the path here.
    if (url.startsWith('data:')) {
      if (state.pendingSavePath) {
        suggest({ filename: state.pendingSavePath, conflictAction: 'overwrite' });
      }
      return;
    }

    const haystack = [item.url, item.finalUrl, item.referrer]
      .filter(Boolean)
      .join(' ');
    let name = basename(item.filename) || 'shopee-report';
    const placeholder = GENERIC_DOWNLOAD_RE.test(name);

    // Shopee redirects downloads to hosts with no recognisable branding, so a
    // host match alone is not enough. Outside those hosts, only step in for a
    // placeholder name while we are mid-collect — never for a download that
    // already has a real name of its own.
    if (!SHOPEE_HOST_RE.test(haystack) && !(placeholder && state.expectedName)) {
      return;
    }

    // "download (2).csv" tells us nothing; the content script knows what this
    // report is actually called.
    if (placeholder && state.expectedName) name = state.expectedName;

    state.watch.capturedId = item.id;
    state.watch.capturedName = name;
    suggest({
      filename: `${ROOT_FOLDER}/${state.folder}/${name}`,
      conflictAction: 'overwrite'
    });
  } catch (_) {
    /* fall through to Chrome's default filename */
  }
});

// Backstop: if another extension wins onDeterminingFilename, we still notice
// that a Shopee download happened and skip the blob fallback.
chrome.downloads.onCreated.addListener((item) => {
  try {
    if (!state.running || state.watch.capturedId != null) return;
    const url = item.url || '';
    if (url.startsWith('data:')) return;
    const haystack = [item.url, item.finalUrl, item.referrer].filter(Boolean).join(' ');
    if (!SHOPEE_HOST_RE.test(haystack)) return;
    state.watch.capturedId = item.id;
    state.watch.capturedName = basename(item.filename) || 'shopee-report';
  } catch (_) {
    /* ignore */
  }
});

async function verifyDownload(id, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 120000);
  for (;;) {
    let items = [];
    try {
      items = await chrome.downloads.search({ id });
    } catch (_) {
      items = [];
    }
    const item = items[0];
    if (item) {
      if (item.state === 'complete') {
        return { ok: true, filename: basename(item.filename) };
      }
      if (item.state === 'interrupted') {
        return {
          ok: false,
          error: `Chrome could not save the file (${item.error || 'interrupted'}).`
        };
      }
    }
    if (Date.now() > deadline) {
      return { ok: false, error: 'The file did not finish downloading in time.' };
    }
    await sleep(500);
  }
}

async function saveFile(dataUrl, filename) {
  if (!dataUrl || !dataUrl.startsWith('data:')) {
    return { ok: false, error: 'Nothing to save — the captured file was empty.' };
  }
  const name = basename(filename) || 'shopee-report';
  const path = `${ROOT_FOLDER}/${state.folder}/${name}`;

  let id;
  try {
    // Also published for our onDeterminingFilename listener to re-assert, in
    // case another extension overrides the filename we ask for here.
    state.pendingSavePath = path;
    id = await chrome.downloads.download({
      url: dataUrl,
      filename: path,
      conflictAction: 'overwrite',
      saveAs: false
    });
  } catch (e) {
    state.pendingSavePath = '';
    return {
      ok: false,
      error: `Chrome refused to save "${name}": ${e && e.message ? e.message : e}`
    };
  } finally {
    // Cleared after a beat: the event fires just after download() resolves.
    setTimeout(() => {
      state.pendingSavePath = '';
    }, 5000);
  }

  const verified = await verifyDownload(id, 120000);
  if (!verified.ok) return { ok: false, error: verified.error };

  // If Chrome saved it under a different name, something overrode us — say so
  // rather than reporting a tick against a file that is not where we said.
  if (verified.filename && verified.filename !== name) {
    return {
      ok: false,
      error:
        `Chrome saved the file as "${verified.filename}" instead of "${name}". ` +
        `Another extension may be overriding download filenames — check ` +
        `chrome://extensions for a download manager.`
    };
  }

  state.lastDownloadId = id; // so the popup can reveal the folder afterwards
  return { ok: true, filename: verified.filename || name, id };
}

/* ==================================================================== *
 * Tab handling
 * ==================================================================== */
async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (_) {
    return null;
  }
}

async function ensureTab() {
  if (state.tabId != null && (await getTab(state.tabId))) return state.tabId;
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  state.tabId = tab.id;
  trackTab(tab.id);
  return tab.id;
}

function trackTab(tabId) {
  if (tabId != null && !state.tabIds.includes(tabId)) state.tabIds.push(tabId);
}

async function closeTabs(ids) {
  for (const id of ids) {
    try {
      await chrome.tabs.remove(id);
    } catch (_) {
      /* already gone */
    }
  }
  state.tabIds = state.tabIds.filter((id) => !ids.includes(id));
  if (ids.includes(state.tabId)) state.tabId = null;
}

function stripQuery(u) {
  return String(u || '').split('#')[0].split('?')[0];
}

/** Wait for a tab to finish loading, and reject if it landed on a login page. */
async function awaitTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 90000);
  for (;;) {
    const tab = await getTab(tabId);
    if (!tab) throw new AppError(ERR.TAB_GONE);
    if (tab.status === 'complete') {
      if (/accounts\.shopee|\/login|captcha|verify/i.test(tab.url || '')) {
        throw new AppError(ERR.NOT_LOGGED_IN);
      }
      return tab;
    }
    if (Date.now() > deadline) throw new AppError(ERR.PAGE_TIMEOUT);
    await sleep(500);
  }
}

async function navigate(tabId, url, activate) {
  const current = await getTab(tabId);
  if (!current) throw new AppError(ERR.TAB_GONE);

  if (stripQuery(current.url) === stripQuery(url)) {
    await chrome.tabs.reload(tabId, { bypassCache: false });
  } else {
    await chrome.tabs.update(tabId, { url, active: activate !== false });
  }
  await sleep(500);
  return awaitTabLoad(tabId);
}

async function sendToContent(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg);
}

async function waitForContentScript(tabId) {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const res = await sendToContent(tabId, { type: 'ping' });
      if (res && res.ok) return res;
    } catch (_) {
      /* not injected yet */
    }
    if (Date.now() > deadline) break;
    await sleep(500);
  }

  // Recovery path: the tab predates this extension version, or the content
  // script was blocked. Inject both worlds by hand and try once more.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/interceptor.js'],
      world: 'MAIN'
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js'],
      world: 'ISOLATED'
    });
    const res = await sendToContent(tabId, { type: 'ping' });
    if (res && res.ok) return res;
  } catch (_) {
    /* fall through */
  }
  throw new AppError(ERR.PAGE_TIMEOUT);
}

/* ==================================================================== *
 * Orchestration
 * ==================================================================== */
async function checkLogin() {
  const tabId = await ensureTab();
  await navigate(tabId, LOGIN_URL);
  await waitForContentScript(tabId);
  const res = await sendToContent(tabId, { type: 'checkLogin' });
  if (!res || !res.ok || !res.loggedIn) throw new AppError(ERR.NOT_LOGGED_IN);
}

/**
 * Slow n Steady: navigate the one tab, then run all three phases of the
 * export in a single content-script call.
 */
async function runOne(ex) {
  state.currentId = ex.id;
  state.watch = { armed: false, capturedId: null, capturedName: '' };
  state.expectedName = ''; // never let one export's name land on another's file
  setResult(ex.id, { status: 'running', detail: 'Opening page…', error: '' });

  const tabId = await ensureTab();
  await navigate(tabId, ex.url);
  await waitForContentScript(tabId);
  setResult(ex.id, { detail: 'Waiting for Shopee to render…' });

  const res = await sendToContent(tabId, {
    type: 'runExport',
    export: ex,
    params: computeParams(ex)
  });

  if (!res) throw new AppError(ERR.TAB_GONE);
  if (res.cancelled) throw new AppError(ERR.CANCELLED);
  if (!res.ok) {
    throw new AppError(
      res.error ||
        `Unexpected error during Export #${ex.id}. Try downloading this report manually.`
    );
  }

  const name = await confirmDownload(res);
  assertNotStale(ex, name);
  setResult(ex.id, { status: 'done', filename: name, detail: name });
}

/**
 * Every BI report encodes its own date range in the filename, so two exports
 * in one run cannot legitimately produce the same name. If they do, Shopee
 * served us an older row instead of the report we just asked for — better to
 * say so than to record a silent, wrong success.
 */
function assertNotStale(ex, filename) {
  if (!filename) return;
  const clash = Object.values(state.results).find(
    (r) => r.id !== ex.id && r.status === 'done' && r.filename === filename
  );
  if (!clash) return;
  throw new AppError(
    `Shopee returned the same file as #${clash.id} ${clash.name} ` +
      `("${filename}") instead of a new one — it was probably still rate-limited. ` +
      `Wait a minute and re-run export #${ex.id}.`
  );
}

// Shopee refuses a second export inside roughly a minute of the last one and
// answers with a toast, not an error — which used to leave us downloading the
// previous report. Space the exports out instead of racing the limit.
// Slow n Steady keeps the conservative spacing. Fast n Furious relies on the
// observation that exports for DIFFERENT periods do not contend, and leaves
// only a token gap — the content script still detects a rate-limit toast and
// waits it out if Shopee disagrees.
const COOLDOWN_MS = { steady: 65000, furious: 3000 };

async function respectCooldown(next, mode) {
  const budget = COOLDOWN_MS[mode] || COOLDOWN_MS.steady;
  let remaining = budget - (Date.now() - (state.lastExportAt || 0));
  while (remaining > 0) {
    if (state.cancel) return;
    if (budget > 10000) {
      setResult(next.id, {
        detail: `Waiting out Shopee's export cooldown… ${Math.ceil(remaining / 1000)}s`
      });
    }
    await sleep(Math.min(2000, remaining));
    remaining = budget - (Date.now() - (state.lastExportAt || 0));
  }
}

/**
 * Fast n Furious.
 *
 * One tab per export, then every tab is walked through each phase before the
 * next phase begins:
 *
 *   load     all 7 pages fetch and render at the same time
 *   prepare  each tab gets its data period selected
 *   trigger  every Export button is clicked, back to back
 *   collect  the finished reports are downloaded
 *
 * Separating trigger from collect is the whole point: Shopee builds all seven
 * reports concurrently while we are still clicking, instead of us waiting out
 * each one before starting the next.
 *
 * Tabs are still driven one at a time within a phase — Chrome throttles timers
 * in background tabs, so the tab being touched has to be the visible one.
 */
async function preloadTabs(selected) {
  const tabs = [];
  for (const ex of selected) {
    const tab = await chrome.tabs.create({ url: ex.url, active: false });
    trackTab(tab.id);
    tabs.push({ ex, tabId: tab.id });
    setResult(ex.id, { status: 'running', detail: 'Loading page…' });
  }

  const settled = await Promise.all(
    tabs.map(async (t) => {
      try {
        await awaitTabLoad(t.tabId);
        await waitForContentScript(t.tabId);
        setResult(t.ex.id, { detail: 'Page loaded.' });
        return t;
      } catch (e) {
        setResult(t.ex.id, {
          status: 'error',
          detail: '',
          error: (e && e.message) || String(e)
        });
        return null;
      }
    })
  );

  // One shared SPA settle instead of 15s per export.
  for (const t of settled) {
    if (t) setResult(t.ex.id, { detail: 'Letting Shopee finish rendering…' });
  }
  await sleep(15000);

  return settled.filter(Boolean);
}

/** Run one phase across every remaining tab, dropping any that fail. */
async function runPhase(slots, phase, label) {
  const survivors = [];
  for (const slot of slots) {
    if (state.cancel) throw new AppError(ERR.CANCELLED);
    state.currentId = slot.ex.id;
    try {
      await chrome.tabs.update(slot.tabId, { active: true });
      await sleep(250);
      setResult(slot.ex.id, { detail: label });

      const params = computeParams(slot.ex);
      params.initialWaitMs = 2000; // preloadTabs already did the long settle

      const res = await sendToContent(slot.tabId, {
        type: phase,
        export: slot.ex,
        params
      });
      if (!res) throw new AppError(ERR.TAB_GONE);
      if (res.cancelled) throw new AppError(ERR.CANCELLED);
      if (!res.ok) throw new AppError(res.error || `${phase} failed.`);

      slot.lastResult = res;
      survivors.push(slot);
    } catch (e) {
      const message = (e && e.message) || String(e);
      if (message === ERR.CANCELLED || message === ERR.NOT_LOGGED_IN) throw e;
      setResult(slot.ex.id, { status: 'error', detail: '', error: message });
    }
  }
  return survivors;
}

async function runFurious(selected) {
  let slots = await preloadTabs(selected);
  if (state.cancel) throw new AppError(ERR.CANCELLED);

  slots = await runPhase(slots, 'prepareExport', 'Selecting the data period…');
  for (const slot of slots) {
    setResult(slot.ex.id, { detail: 'Ready — waiting for the others…' });
  }

  slots = await runPhase(slots, 'triggerExport', 'Requesting the export…');
  for (const slot of slots) {
    setResult(slot.ex.id, { detail: 'Generating on Shopee…' });
  }

  let done = 0;
  for (const slot of slots) {
    if (state.cancel) throw new AppError(ERR.CANCELLED);
    state.currentId = slot.ex.id;
    state.watch = { armed: false, capturedId: null, capturedName: '' };
  state.expectedName = ''; // never let one export's name land on another's file
    try {
      await chrome.tabs.update(slot.tabId, { active: true });
      await sleep(250);
      setResult(slot.ex.id, { detail: 'Downloading…' });

      const params = computeParams(slot.ex);
      params.initialWaitMs = 2000;

      const res = await sendToContent(slot.tabId, {
        type: 'collectExport',
        export: slot.ex,
        params
      });
      if (!res) throw new AppError(ERR.TAB_GONE);
      if (res.cancelled) throw new AppError(ERR.CANCELLED);
      if (!res.ok) throw new AppError(res.error || 'Download failed.');

      const name = await confirmDownload(res);
      assertNotStale(slot.ex, name);
      setResult(slot.ex.id, { status: 'done', filename: name, detail: name });
      done++;
      await closeTabs([slot.tabId]);
    } catch (e) {
      const message = (e && e.message) || String(e);
      if (message === ERR.CANCELLED || message === ERR.NOT_LOGGED_IN) throw e;
      setResult(slot.ex.id, { status: 'error', detail: '', error: message });
    }
  }
  return done;
}

/** A page-initiated download is only real once Chrome has finished writing. */
async function confirmDownload(res) {
  if (res.via === 'browser' && state.watch.capturedId != null) {
    const verified = await verifyDownload(state.watch.capturedId, 120000);
    if (!verified.ok) throw new AppError(verified.error);
    state.lastDownloadId = state.watch.capturedId;
    return verified.filename || res.filename;
  }
  return res.filename;
}

/**
 * Reveal the dated folder in the file manager.
 *
 * chrome.downloads.show() opens the folder with the file selected, which is
 * how we get to "Shopee daily report/<date>/" rather than plain Downloads.
 */
async function revealFolder(downloadId) {
  const candidates = [];
  if (downloadId != null) candidates.push(downloadId);
  if (state.lastDownloadId != null) candidates.push(state.lastDownloadId);
  const stored = await chrome.storage.local.get('lastRun');
  if (stored.lastRun && stored.lastRun.downloadId != null) {
    candidates.push(stored.lastRun.downloadId);
  }

  for (const id of candidates) {
    try {
      const [item] = await chrome.downloads.search({ id });
      // A file the user has since deleted or moved cannot be revealed.
      if (item && item.exists !== false && item.state === 'complete') {
        chrome.downloads.show(id);
        return { ok: true, revealed: 'file' };
      }
    } catch (_) {
      /* try the next candidate */
    }
  }

  chrome.downloads.showDefaultFolder();
  return { ok: true, revealed: 'downloads' };
}

async function runExports(ids, mode) {
  if (state.running) return { ok: false, error: 'A download run is already in progress.' };

  const selected = EXPORTS.filter((ex) => ids.includes(ex.id));
  if (!selected.length) return { ok: false, error: 'Nothing selected.' };

  state.running = true;
  state.cancel = false;
  state.mode = mode === 'furious' ? 'furious' : 'steady';
  state.error = '';
  state.startedAt = Date.now();
  state.finishedAt = null;
  state.folder = dateFolder(new Date());
  state.results = blankResults(ids);
  state.tabIds = [];
  state.tabId = null;
  persist();
  setBadge('…', '#ee4d2d');

  let done = 0;

  try {
    setResult(selected[0].id, { detail: 'Checking Shopee login…' });
    await checkLogin();

    if (state.mode === 'furious') {
      // Phase-by-phase across every tab — see runFurious().
      await closeTabs([state.tabId].filter((id) => id != null));
      done = await runFurious(selected);
    } else {
      // One tab, one export at a time, with the conservative cooldown.
      for (let i = 0; i < selected.length; i++) {
        if (state.cancel) throw new AppError(ERR.CANCELLED);
        const ex = selected[i];
        try {
          await runOne(ex);
          done++;
        } catch (e) {
          const message = e && e.message ? e.message : String(e);
          if (message === ERR.NOT_LOGGED_IN || message === ERR.CANCELLED) throw e;
          setResult(ex.id, { status: 'error', detail: '', error: message });
        }
        state.lastExportAt = Date.now();
        if (i < selected.length - 1) await respectCooldown(selected[i + 1], state.mode);
      }
    }
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    state.error = message;
    // Anything still queued never got its chance.
    for (const ex of selected) {
      const row = state.results[ex.id];
      if (row && (row.status === 'pending' || row.status === 'running')) {
        row.status = 'error';
        row.error = message;
        row.detail = '';
      }
    }
  }

  state.running = false;
  state.currentId = null;
  state.finishedAt = Date.now();
  persist();

  const total = selected.length;
  await chrome.storage.local.set({
    lastRun: {
      at: state.finishedAt,
      done,
      total,
      mode: state.mode,
      folder: state.folder,
      error: state.error,
      downloadId: state.lastDownloadId,
      results: state.results
    }
  });

  setBadge(
    done === total ? `${done}` : `${done}/${total}`,
    done === total ? '#2e7d32' : '#c62828'
  );

  // Leave tabs open when something failed so the user can look at them —
  // except on an explicit Stop, where 7 orphaned tabs are just a nuisance.
  if ((done === total && !state.error) || state.cancel) {
    await closeTabs(state.tabIds.slice());
  }

  return { ok: true, done, total };
}

/* ==================================================================== *
 * Update checking
 *
 * An unpacked extension cannot update itself the way a Web Store one does,
 * so this only ANSWERS the question "is there a newer version?". Applying it
 * happens on the options page, which can write to the extension folder once
 * the user has granted it, and then calls chrome.runtime.reload().
 * ==================================================================== */
const UPDATE_MANIFEST = 'update.json';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function currentVersion() {
  return chrome.runtime.getManifest().version;
}

/** "1.10.0" > "1.9.3" — numeric, segment by segment. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Built in, so nobody installing this has to configure anything. Overridable
// from the options page only if the repo ever moves.
const DEFAULT_UPDATE_SOURCE = {
  owner: 'anson81',
  repo: 'Shopee-CPM-Report-Downloader',
  branch: 'main'
};

async function getUpdateConfig() {
  const { updateSource } = await chrome.storage.local.get('updateSource');
  if (updateSource && updateSource.owner && updateSource.repo) return updateSource;
  return DEFAULT_UPDATE_SOURCE;
}

function rawUrl(cfg, file) {
  const branch = cfg.branch || 'main';
  // raw.githubusercontent caches for a few minutes; bust it.
  return (
    `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${branch}/` +
    `${file}?t=${Date.now()}`
  );
}

async function checkUpdate(force) {
  const cfg = await getUpdateConfig();
  const current = currentVersion();
  if (!cfg) return { ok: true, configured: false, current };

  const { updateCache } = await chrome.storage.local.get('updateCache');
  if (
    !force &&
    updateCache &&
    Date.now() - updateCache.at < CHECK_INTERVAL_MS &&
    updateCache.current === current
  ) {
    return { ...updateCache, ok: true, configured: true, cached: true };
  }

  let remote;
  try {
    const res = await fetch(rawUrl(cfg, UPDATE_MANIFEST), { cache: 'no-store' });
    if (!res.ok) {
      return {
        ok: false,
        configured: true,
        current,
        error:
          res.status === 404
            ? `No ${UPDATE_MANIFEST} found in ${cfg.owner}/${cfg.repo}.`
            : `GitHub returned HTTP ${res.status}.`
      };
    }
    remote = await res.json();
  } catch (e) {
    return {
      ok: false,
      configured: true,
      current,
      error: `Could not reach GitHub: ${(e && e.message) || e}`
    };
  }

  if (!remote || !remote.version) {
    return { ok: false, configured: true, current, error: `${UPDATE_MANIFEST} has no "version".` };
  }

  const result = {
    configured: true,
    current,
    latest: String(remote.version),
    hasUpdate: compareVersions(remote.version, current) > 0,
    notes: Array.isArray(remote.notes) ? remote.notes : [],
    files: Array.isArray(remote.files) ? remote.files : [],
    at: Date.now()
  };
  await chrome.storage.local.set({ updateCache: result });
  return { ...result, ok: true };
}

/* ==================================================================== *
 * Messaging
 * ==================================================================== */
async function handle(msg, sender) {
  switch (msg.type) {
    case 'getExports':
      return { ok: true, exports: EXPORTS.map((e) => ({ id: e.id, name: e.name })) };

    case 'checkUpdate':
      return checkUpdate(!!msg.force);

    case 'openOptions':
      chrome.runtime.openOptionsPage();
      return { ok: true };

    case 'openFolder':
      return revealFolder(msg.downloadId);

    case 'getState': {
      const stored = await chrome.storage.local.get('lastRun');
      if (!state.running) setBadge(''); // the user has seen the result
      return { ok: true, state: publicState(), lastRun: stored.lastRun || null };
    }

    case 'run':
      // Deliberately not awaited: the popup must not block for minutes, and it
      // may be closed at any moment. Progress lives in chrome.storage.
      runExports(
        msg.ids && msg.ids.length ? msg.ids : EXPORTS.map((e) => e.id),
        msg.mode
      ).catch((err) => {
        state.running = false;
        state.error = (err && err.message) || String(err);
        persist();
      });
      return { ok: true, started: true };

    case 'cancel':
      state.cancel = true;
      state.error = ERR.CANCELLED;
      persist();
      return { ok: true };

    case 'heartbeat':
      return { ok: true, cancel: state.cancel };

    case 'progress':
      if (state.currentId != null) setResult(state.currentId, { detail: msg.text });
      return { ok: true };

    case 'armDownload':
      state.watch = { armed: true, capturedId: null, capturedName: '' };
      return { ok: true };

    // The content script has read the report's real name off the page; use it
    // to rescue any download Chrome would otherwise call "download (2).csv".
    case 'expectName':
      state.expectedName = basename(msg.name || '') || '';
      return { ok: true };

    case 'checkDownload':
      return {
        ok: true,
        captured: state.watch.capturedId != null,
        filename: state.watch.capturedName
      };

    case 'saveFile':
      return saveFile(msg.dataUrl, msg.filename);

    default:
      return { ok: false, error: `Unknown message: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  handle(msg, sender).then(
    (res) => sendResponse(res),
    (err) => sendResponse({ ok: false, error: (err && err.message) || String(err) })
  );
  return true; // async response
});

chrome.runtime.onInstalled.addListener((details) => {
  setBadge('', '#ee4d2d');
  // Record what we just moved to, so the popup can say "Updated to v1.1.0".
  chrome.storage.local.set({
    installInfo: {
      version: currentVersion(),
      reason: details && details.reason,
      previous: details && details.previousVersion,
      at: Date.now()
    }
  });
  chrome.storage.local.remove('updateCache'); // force a fresh check
  // A run cannot survive an extension reload; clear any stale "running" flag.
  chrome.storage.local.get('runState').then((s) => {
    if (s.runState && s.runState.running) {
      chrome.storage.local.set({
        runState: Object.assign({}, s.runState, {
          running: false,
          error: 'The extension was reloaded before the run finished.'
        })
      });
    }
  });
});

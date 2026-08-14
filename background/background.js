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
const ORDER_URL = 'https://seller.shopee.com.my/portal/sale/order';
const LOGIN_URL = 'https://seller.shopee.com.my/datacenter/overview';
const ROOT_FOLDER = 'Shopee daily report';

const EXPORTS = [
  { id: 1, key: 'realtime', name: 'Real Time', label: 'Real-Time', kind: 'bi', url: BI_URL },
  { id: 2, key: 'yesterday', name: 'Yesterday', label: 'Yesterday', kind: 'bi', url: BI_URL },
  { id: 3, key: 'byday_3ago', name: 'By Day (3 days ago)', label: 'By Day', kind: 'bi', url: BI_URL },
  { id: 4, key: 'past7d', name: 'Past 7 Days', label: 'Past 7 Days', kind: 'bi', url: BI_URL },
  { id: 5, key: 'byweek_last', name: 'By Week (last week)', label: 'By Week', kind: 'bi', url: BI_URL },
  { id: 6, key: 'overall', name: 'Ads Overall', label: 'Overall', kind: 'ads', url: ADS_URL },
  { id: 7, key: 'gmv_max', name: 'Ads GMV MAX', label: 'GMV Max', kind: 'ads', url: ADS_URL },
  { id: 8, key: 'past30d', name: 'Past 30 Days', label: 'Past 30 Days', kind: 'bi', url: BI_URL },
  {
    id: 9,
    key: 'orders_30d',
    name: 'Orders (last 30 days)',
    label: 'Orders',
    kind: 'order',
    block: 'recent',
    url: ORDER_URL
  },
  {
    id: 10,
    key: 'orders_prev30d',
    name: 'Orders (previous 30 days)',
    label: 'Orders',
    kind: 'order',
    block: 'previous',
    url: ORDER_URL
  }
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
  mode: 'furious',
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
  runFolder: null, // one sub-folder per run, so repeat runs stay separate
  realtimeDate: '', // Real Time pinned to an earlier day, or '' for today
  error: '',
  results: {},
  // Step-by-step trace of the Orders exports, written into the run folder as
  // orders-log.txt. The popup can only show one line per report, and a run
  // that ends with a blank row leaves nothing at all to go on — a service
  // worker's console is gone by the time anyone thinks to look.
  orderLog: [],
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

/* -------------------------------------------------------------------- *
 * Run state that has to outlive the service worker
 *
 * MV3 shuts an idle worker down, and everything in `state` goes with it. The
 * download listeners then see running:false and wave the file through into
 * plain Downloads — which is exactly what was happening: the popup reported
 * the right folder name while the files landed loose in Downloads under
 * Chrome's own names.
 *
 * storage.session keeps this in memory across worker restarts without
 * touching disk, and Chrome clears it on exit.
 * -------------------------------------------------------------------- */
const RUN_KEYS = [
  'running',
  'folder',
  'runFolder',
  'expectedName',
  'pendingSavePath',
  'watch'
];

function persistRun() {
  const snap = {};
  for (const key of RUN_KEYS) snap[key] = state[key];
  return chrome.storage.session.set({ runtimeState: snap }).catch(() => {});
}

/**
 * Refills the run fields after a worker restart.
 *
 * A worker that is already running its own run always wins — this only fills
 * in what a restart wiped.
 */
async function hydrateRun() {
  if (state.running) return;
  try {
    const { runtimeState } = await chrome.storage.session.get('runtimeState');
    if (runtimeState && runtimeState.running) Object.assign(state, runtimeState);
  } catch (_) {
    /* nothing worth restoring */
  }
}

// Started at module evaluation so a woken worker begins catching up before any
// event arrives. `hydrated` flips once it has settled, which is what lets the
// filename listener answer synchronously from then on — see the listener for
// why that distinction decides whether the file lands in the right folder.
let hydrated = false;
const hydrating = hydrateRun().then(() => {
  hydrated = true;
});

/**
 * A run spends minutes waiting on Shopee, and Chrome stops an idle worker
 * after about 30 seconds. Any extension API call resets that timer, so a
 * heartbeat keeps the worker — and the download routing — alive for the whole
 * run. hydrateRun() is the safety net for when this is not enough.
 */
let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
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
/** "03082026-Monday" */
function dateFolder(d) {
  const day = d.toLocaleDateString('en-US', { weekday: 'long' });
  return `${pad(d.getDate())}${pad(d.getMonth() + 1)}${d.getFullYear()}-${day}`;
}

/**
 * "03082026-Monday-1338" — one sub-folder per run, so running twice in a day
 * keeps each set of files separate instead of overwriting.
 *
 * `day` names the folder (the day the reports are ABOUT) while `at` supplies
 * the time (when the run actually happened). Those differ when Real Time is
 * pinned: catching up on Tuesday's reports on Wednesday morning files them
 * under Tuesday, timed 0823.
 */
function runFolder(day, at) {
  return `${dateFolder(day)}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

/** The day a run's reports are about: the pinned date, else today. */
function reportDay(now, realtimeDate) {
  return parseYmd(realtimeDate) || now;
}

/** Where this run's files go, relative to Downloads. */
function targetDir() {
  return state.runFolder
    ? `${ROOT_FOLDER}/${state.folder}/${state.runFolder}`
    : `${ROOT_FOLDER}/${state.folder}`;
}

function basename(p) {
  return String(p || '').split(/[\\/]/).pop();
}

/**
 * A literal string, safe to drop into a regex.
 *
 * Report names are full of characters a regex reads as syntax — GMV Max's is
 * "Shop+GMV+MAX-Detail-Data-…", and an unescaped "+" there means "one or more
 * of the previous character", so the search would never match the file it was
 * looking for.
 */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fallbackBase(ex) {
  if (ex.kind === 'order') return 'Order.all';
  if (ex.kind === 'bi') return 'parentskudetail';
  if (ex.key === 'overall') return 'Shopee-Ads-Overall-Data';
  return 'Shop+GMV+MAX-Detail-Data';
}

/* -------------------------------------------------------------------- *
 * Which day each export covers
 *
 * Shown in the popup so it is obvious what a run will fetch, and used to
 * drive the calendar when Real Time is pinned to a chosen date.
 * -------------------------------------------------------------------- */
/* PURE-DATES-START */
/* Everything between these markers must stay pure: no `chrome`, no `state`,
 * no DOM. tools/test-dates.js slices this region out and runs it standalone,
 * because a bug in here produces files named for days they do not contain —
 * which looks perfectly fine until someone acts on the numbers. */

function pad(n) {
  return String(n).padStart(2, '0');
}

function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(d.getDate() + n);
  return out;
}

function shortDate(d) {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  // Reject anything that rolled over: "2026-13-45" is otherwise happily
  // turned into a real date, and we would click the wrong day in silence.
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }
  return d;
}

function mondayOf(d) {
  const dow = d.getDay(); // 0 = Sunday
  return addDays(d, -(dow === 0 ? 6 : dow - 1));
}

/**
 * The day (or range) each export covers.
 * `realtimeDate` pins export #1 to a chosen day instead of today.
 */
/**
 * What Past 7 Days covers.
 *
 * Normally the rolling week ending yesterday, straight from Shopee's own
 * button. On a pinned run it becomes the Mon–Sun week containing the day
 * before the pinned day — Shopee's calendar offers a single day or a whole
 * week, never a rolling seven days for a past date.
 *
 * Shared so exportDates() and computeParams() cannot drift apart: one says
 * what the popup shows, the other drives the page, and a disagreement between
 * them is a file labelled with dates it does not contain.
 */
function past7Span(now, base, pinned) {
  if (!pinned) return { from: addDays(now, -7), to: addDays(now, -1) };
  const monday = mondayOf(addDays(base, -1));
  return { from: monday, to: addDays(monday, 6) };
}

function exportDates(now, realtimeDate) {
  const pinned = parseYmd(realtimeDate);
  // A pinned date stands in for "today" for the WHOLE run, not just Real Time.
  // Pin 7 Aug and Yesterday means 6 Aug, By Day means 5 Aug, and so on — which
  // is what "catch up on that day" has to mean to be any use. Until 1.10.0 only
  // Real Time moved, so a pinned run mixed one chosen day with four counted
  // from the real today, and pinning yesterday collided with the Yesterday row.
  const base = pinned || now;
  const p7 = past7Span(now, base, pinned);
  // By Week takes the week immediately BEFORE whatever Past 7 Days covers.
  //
  // Counting a fixed two weeks back from "today" only worked while Past 7 Days
  // was a rolling window ending yesterday. On a pinned run it becomes a whole
  // week, and two-back then skips the week in between: pin 9 Aug and Past 7
  // Days takes 3–9 Aug while By Week jumped to 20–26 Jul, losing 27 Jul – 2 Aug
  // altogether. Anchoring to Past 7 Days keeps the two rows adjacent — no gap,
  // and no near-duplicate either, which is what the two-week step was avoiding.
  const weekStart = addDays(mondayOf(p7.from), -7);
  const blocks = orderBlocks(now, realtimeDate);

  return {
    1: { from: base, to: base, pinned: !!pinned },
    2: { from: addDays(base, -1), to: addDays(base, -1) },
    3: { from: addDays(base, -2), to: addDays(base, -2) },
    4: p7,
    5: { from: weekStart, to: addDays(weekStart, 6) },
    // Shopee picks the Ads range itself — do not claim a date we do not set.
    6: null,
    7: null,
    // Same reasoning for Past 30 Days: it is Shopee's own rolling button.
    8: null,
    9: blocks.recent,
    10: blocks.previous
  };
}

/**
 * The two 30-day windows the Orders exports cover.
 *
 * They end the day BEFORE the run, so a part-finished day is never exported,
 * and they sit back to back: no day counted twice, no gap between them.
 *
 * Shopee caps an order export at 60 days — confirmed on the live picker on
 * 11 Aug 2026, where selecting 12 Jun as the start disabled 11 Aug and left
 * 10 Aug as the last selectable end. Two 30-day blocks are exactly that cap,
 * so neither can be widened without splitting the export in two.
 */
function orderBlocks(now, realtimeDate) {
  const base = parseYmd(realtimeDate) || now;
  const recentTo = addDays(base, -1);
  const recentFrom = addDays(recentTo, -29);
  const previousTo = addDays(recentFrom, -1);
  const previousFrom = addDays(previousTo, -29);
  return {
    recent: { from: recentFrom, to: recentTo },
    previous: { from: previousFrom, to: previousTo }
  };
}

/**
 * Shopee's own name for an order export: Order.all.20260712_20260810.xlsx
 *
 * Knowing this before we ask is what makes collection safe. My Reports keeps
 * six months of exports, so "the newest row" is a guess; an exact filename is
 * not.
 */
function orderFilename(span) {
  const compact = (d) =>
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  return `Order.all.${compact(span.from)}_${compact(span.to)}.xlsx`;
}

/** How the export modal renders a range: "2026/07/12 – 2026/08/10". Read back
 *  after we set it, so a mis-clicked cell cannot export a range nobody asked
 *  for under a filename that looks plausible. */
function orderRangeText(span) {
  const slash = (d) =>
    `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return `${slash(span.from)} – ${slash(span.to)}`;
}

function dateLabel(span) {
  if (!span) return "Shopee's own range";
  const from = shortDate(span.from);
  const to = shortDate(span.to);
  return from === to ? from : `${from} – ${to}`;
}

/* PURE-DATES-END */

/**
 * Exports that cover exactly the same day as an earlier one.
 *
 * Pinning Real Time to yesterday makes #1 and #2 identical: same period, same
 * filename, so the second download simply overwrote the first and the run
 * quietly produced six files instead of seven. Returns { id: firstId }.
 */
function duplicateExports(ids, realtimeDate) {
  const spans = exportDates(new Date(), realtimeDate);
  const seen = new Map();
  const dupes = {};
  for (const id of ids) {
    const span = spans[id];
    if (!span) continue; // Ads: Shopee chooses the range, never a known clash
    const key = `${ymd(span.from)}_${ymd(span.to)}`;
    if (seen.has(key)) dupes[id] = seen.get(key);
    else seen.set(key, id);
  }
  return dupes;
}

async function getRealtimeDate() {
  const { realtimeDate } = await chrome.storage.local.get('realtimeDate');
  // A pinned date in the future (or today) is meaningless — treat as unset.
  const parsed = parseYmd(realtimeDate);
  if (!parsed) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parsed < today ? realtimeDate : '';
}

function computeParams(ex, realtimeDate) {
  const now = new Date();
  const pinned = parseYmd(realtimeDate);
  // Stands in for "today" for every row. See exportDates() for why.
  const base = pinned || now;
  const params = { fallbackBase: fallbackBase(ex) };

  /**
   * Point the calendar at one day.
   *
   * monthsBack is counted from the REAL today, never from `base`: it is the
   * number of times to press the calendar's prev-month arrow, and the picker
   * always opens on the real current month.
   */
  const pickDay = (target) => {
    params.useCalendarDate = true;
    params.targetDate = ymd(target);
    params.targetDay = target.getDate();
    params.monthsBack = monthsBetween(now, target);
  };

  /** Point the calendar at the Mon–Sun week containing `target`. */
  const pickWeek = (target) => {
    pickDay(target);
    params.useCalendarDate = false;
    params.useCalendarWeek = true;
  };

  // Real Time on a pinned run is fetched through the calendar rather than
  // Shopee's live "Real-Time" period, which only ever means right now.
  //
  // Except when the pinned day is yesterday. Shopee's By Day calendar greys out
  // today AND yesterday — the newest day it will hand over is two days back.
  // Read off the live picker on 11 Aug 2026: 11th and 10th disabled, 9th
  // selectable. That is why Shopee ships a separate "Yesterday" button at all,
  // and pressing it gets the same day the calendar refuses to give.
  if (ex.key === 'realtime' && pinned) {
    if (ymd(pinned) === ymd(addDays(now, -1))) params.presetLabel = 'Yesterday';
    else pickDay(base);
  }

  // Normally this clicks Shopee's own "Yesterday" button, which always means
  // the real yesterday. A pinned run has to walk the calendar instead.
  if (ex.key === 'yesterday' && pinned) pickDay(addDays(base, -1));

  // Boss's counting: "3 days ago" == today - 2.
  if (ex.key === 'byday_3ago') pickDay(addDays(base, -2));

  // Same as Yesterday: Shopee's "Past 7 Days" button is anchored to the real
  // today, so a pinned run takes the week containing the day before instead.
  const p7 = past7Span(now, base, pinned);
  if (ex.key === 'past7d' && pinned) pickWeek(p7.from);

  // The week immediately before Past 7 Days. See exportDates().
  if (ex.key === 'byweek_last') pickWeek(addDays(mondayOf(p7.from), -7));

  // Orders: which block this export covers, and the exact filename Shopee
  // will publish for it. See orderFilename() for why the name matters.
  if (ex.kind === 'order') {
    const span = orderBlocks(now, realtimeDate)[ex.block];
    params.orderFrom = span.from.getTime();
    params.orderTo = span.to.getTime();
    params.orderRangeText = orderRangeText(span);
    params.expectedName = orderFilename(span);
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

/**
 * Where this download belongs. Returns a suggestion for Chrome, or null to
 * leave the file alone. Pure and synchronous — it only reads state that is
 * already in memory.
 */
function decideDownloadPath(item) {
  try {
    if (!state.running || !state.folder) return null; // leave unrelated downloads alone
    const url = item.url || '';

    // Our own saveFile download. The `filename` passed to downloads.download()
    // is only a SUGGESTION that any listener — ours or another extension's —
    // can override, and something on this machine was overriding it, dropping
    // the file into plain Downloads. Re-assert the path here.
    if (url.startsWith('data:')) {
      return state.pendingSavePath
        ? { filename: state.pendingSavePath, conflictAction: 'overwrite' }
        : null;
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
      return null;
    }

    // "download (2).csv" tells us nothing; the content script knows what this
    // report is actually called.
    if (placeholder && state.expectedName) name = state.expectedName;

    state.watch.capturedId = item.id;
    state.watch.capturedName = name;
    persistRun();
    return {
      filename: `${targetDir()}/${name}`,
      conflictAction: 'overwrite'
    };
  } catch (_) {
    return null; // fall through to Chrome's default filename
  }
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // ANSWER SYNCHRONOUSLY WHENEVER POSSIBLE.
  //
  // v1.9.0 made this listener unconditionally async — await hydration, then
  // suggest. That looked correct and was not. The 10 Aug 19:28 run put every
  // file in plain Downloads even though the listener matched each one and
  // captured its download id: an answer that arrives after Chrome has settled
  // on a filename is the same as no answer at all.
  //
  // The SiteGiant twin hid this, because it passes `filename` straight to
  // downloads.download() and only uses its listener as a backstop. Shopee's
  // downloads are started by Shopee's own page, so this listener is the only
  // thing that can place them.
  //
  // On a worker that is already awake — which the keep-alive is there to
  // ensure during a run — hydration has long since settled and everything
  // needed is in memory, so this is decided before the listener returns.
  if (hydrated) {
    const choice = decideDownloadPath(item);
    if (choice) suggest(choice);
    else suggest();
    return;
  }

  // The only remaining case: a worker woken by this very event with nothing in
  // memory yet. Answering late is a gamble on Chrome still listening, but
  // declining outright loses the file for certain.
  hydrating
    .then(() => {
      const choice = decideDownloadPath(item);
      if (choice) suggest(choice);
      else suggest();
    })
    .catch(() => suggest());
  return true;
});

// Backstop: if another extension wins onDeterminingFilename, we still notice
// that a Shopee download happened and skip the blob fallback.
chrome.downloads.onCreated.addListener(async (item) => {
  try {
    await hydrating;
    if (!state.running || state.watch.capturedId != null) return;
    const url = item.url || '';
    if (url.startsWith('data:')) return;
    const haystack = [item.url, item.finalUrl, item.referrer].filter(Boolean).join(' ');
    if (!SHOPEE_HOST_RE.test(haystack)) return;
    state.watch.capturedId = item.id;
    state.watch.capturedName = basename(item.filename) || 'shopee-report';
    persistRun();
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
  const path = `${targetDir()}/${name}`;

  let id;
  try {
    // Also published for our onDeterminingFilename listener to re-assert, in
    // case another extension overrides the filename we ask for here.
    state.pendingSavePath = path;
    await persistRun();
    id = await chrome.downloads.download({
      url: dataUrl,
      filename: path,
      conflictAction: 'overwrite',
      saveAs: false
    });
  } catch (e) {
    state.pendingSavePath = '';
    persistRun();
    return {
      ok: false,
      error: `Chrome refused to save "${name}": ${e && e.message ? e.message : e}`
    };
  } finally {
    // Cleared after a beat: the event fires just after download() resolves.
    setTimeout(() => {
      state.pendingSavePath = '';
      persistRun();
    }, 5000);
  }

  const verified = await verifyDownload(id, 120000);
  if (!verified.ok) return { ok: false, error: verified.error };

  // If Chrome saved it under a different name, something overrode us — but ask
  // the disk before saying so.
  //
  // Ads reports produce TWO downloads: Shopee's page starts its own, which
  // Chrome names "download.csv", and we save the captured blob under the real
  // name. When the id verified here is Shopee's rather than ours, the names
  // differ and this reported a failure against a file that had in fact arrived
  // correctly — every GMV Max run came back 9/10 with the right file sitting in
  // the folder. Checked against Chrome's own download record on 14 Aug 2026:
  // it attributes "Shop+GMV+MAX-Detail-Data-….csv" to this extension, and no
  // "download.csv" exists anywhere.
  //
  // So a name mismatch is only a failure if OUR name never landed. Searching by
  // name rather than by id also survives the reverse case — our download being
  // the one that got overridden — because then nothing matches and we still say
  // so.
  if (verified.filename && verified.filename !== name) {
    let landed = [];
    try {
      landed = await chrome.downloads.search({
        // Anchored to the end: the stored path is absolute, and a bare name
        // would also match a same-named file in some other folder.
        filenameRegex: `${escapeRegex(name)}$`,
        exists: true,
        limit: 1
      });
    } catch (_) {
      landed = [];
    }

    if (!landed.length) {
      return {
        ok: false,
        error:
          `Chrome saved the file as "${verified.filename}" instead of "${name}". ` +
          `Another extension may be overriding download filenames — check ` +
          `chrome://extensions for a download manager.`
      };
    }

    return { ok: true, filename: name, id: landed[0].id };
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

/* -------------------------------------------------------------------- *
 * Run history
 *
 * Ported from the SiteGiant twin. There, it answers "have I already pulled
 * June?"; here the question is "did I already fetch today, and where did it
 * go?" — which matters because the reports land in a dated sub-folder per run
 * and a second run the same day makes another one.
 *
 * Records what was asked for and what came back, failures included. A run that
 * went wrong is exactly the one worth being able to look at again.
 * -------------------------------------------------------------------- */
const HISTORY_LIMIT = 40;

async function recordHistory(selected) {
  const entry = {
    at: Date.now(),
    folder: state.folder,
    runFolder: state.runFolder,
    covers: state.realtimeDate || null, // set when Real Time was pinned
    error: state.error || '',
    reports: selected.map((ex) => {
      const result = state.results[ex.id] || {};
      return {
        id: ex.id,
        name: ex.name,
        status: result.status || 'unknown',
        filename: result.filename || '',
        error: result.error || ''
      };
    })
  };

  try {
    const { history = [] } = await chrome.storage.local.get('history');
    history.unshift(entry);
    await chrome.storage.local.set({ history: history.slice(0, HISTORY_LIMIT) });
  } catch (_) {
    /* history is a convenience — never let it sink a finished run */
  }
}

/** How many Orders exports this run is actually doing. */
function selectedOrderCount() {
  return EXPORTS.filter(
    (e) =>
      e.kind === 'order' &&
      state.results[e.id] &&
      state.results[e.id].status !== 'skipped'
  ).length;
}

/** One line in orders-log.txt. */
function logOrder(message) {
  const now = new Date();
  const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  state.orderLog.push(`${stamp}  ${message}`);
}

/** Everything we know about a thrown value, including where it came from. */
function describeError(e) {
  if (!e) return 'undefined error';
  const message = e.message || String(e);
  const stack = e.stack ? ` | ${String(e.stack).split('\n').slice(0, 3).join(' <- ')}` : '';
  return `${e.name || 'Error'}: ${message}${stack}`;
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

  // Two exports can legitimately share a filename if they cover the same day —
  // which happens when Real Time is pinned to yesterday, matching export #2.
  const spans = exportDates(new Date(), state.realtimeDate);
  const a = spans[ex.id];
  const b = spans[clash.id];
  if (a && b && ymd(a.from) === ymd(b.from) && ymd(a.to) === ymd(b.to)) return;
  throw new AppError(
    `Shopee returned the same file as #${clash.id} ${clash.name} ` +
      `("${filename}") instead of a new one — it was probably still rate-limited. ` +
      `Wait a minute and re-run export #${ex.id}.`
  );
}

/**
 * Fast n Furious — the only way a run happens.
 *
 * One tab per export, then every tab is walked through each phase before the
 * next phase begins:
 *
 *   load     all 10 pages fetch and render at the same time
 *   prepare  each tab gets its data period selected
 *   trigger  every Export button is clicked, back to back
 *   collect  the finished reports are downloaded
 *
 * Separating trigger from collect is the whole point: Shopee builds all ten
 * reports concurrently while we are still clicking, instead of us waiting out
 * each one before starting the next. It matters most for the Orders exports,
 * which Shopee builds server-side over a minute or two — by the time we come
 * back for them, they are done.
 *
 * Shopee refuses a second export of the SAME kind too soon after the last and
 * answers with a toast rather than an error. Exports for different periods do
 * not contend, so the phases only pause between the two Orders requests; the
 * content script detects the toast and waits it out if Shopee disagrees.
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

      const params = computeParams(slot.ex, state.realtimeDate);
      params.initialWaitMs = 2000; // preloadTabs already did the long settle

      if (phase === 'triggerExport' && slot.ex.kind === 'order') {
        logOrder(
          `#${slot.ex.id} trigger: asking for ${params.orderRangeText} -> ${params.expectedName}`
        );
      }

      const res = await sendToContent(slot.tabId, {
        type: phase,
        export: slot.ex,
        params
      });
      if (!res) throw new AppError(ERR.TAB_GONE);
      if (res.cancelled) throw new AppError(ERR.CANCELLED);
      if (!res.ok) throw new AppError(res.error || `${phase} failed.`);

      if (phase === 'triggerExport' && slot.ex.kind === 'order') {
        if (res.rateLimited) {
          logOrder(`#${slot.ex.id} trigger: RATE LIMITED ("${res.toast}")`);
        } else {
          logOrder(
            `#${slot.ex.id} trigger: requested OK ` +
              `(${res.listedBefore} report(s) listed beforehand)`
          );
        }
        // Space the two Orders requests. Both hit the same page, and Shopee
        // turns down a repeat it thinks is too soon with a toast rather than
        // an error. 34s apart was seen working; this keeps a similar margin
        // without holding up the other reports, which are already triggered.
        if (selectedOrderCount() > 1) await sleep(15000);
      }

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
    persistRun();
    try {
      await chrome.tabs.update(slot.tabId, { active: true });
      await sleep(250);
      setResult(slot.ex.id, { detail: 'Downloading…' });

      const params = computeParams(slot.ex, state.realtimeDate);
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
      if (slot.ex.kind === 'order') {
        logOrder(
          `#${slot.ex.id} collect: saved as ${name} after ${res.looks || '?'} look(s)`
        );
      }
      setResult(slot.ex.id, { status: 'done', filename: name, detail: name });
      done++;
      await closeTabs([slot.tabId]);
    } catch (e) {
      const message = (e && e.message) || String(e);
      if (slot.ex.kind === 'order') {
        logOrder(`#${slot.ex.id} collect FAILED: ${describeError(e)}`);
      }
      if (message === ERR.CANCELLED || message === ERR.NOT_LOGGED_IN) throw e;
      setResult(slot.ex.id, { status: 'error', detail: '', error: message });
    }
  }
  return done;
}

/**
 * Did this file actually land in the run folder?
 *
 * Used when the download watcher captured nothing. Our onDeterminingFilename
 * listener is what places a page-started download into the dated folder, so
 * if it never fired, the file is not where we say it is — but it may still
 * exist somewhere, and Chrome's own record is the way to find out.
 */
async function findRunDownload(expected) {
  const folder = state.runFolder || state.folder;
  if (!folder) return null;

  // Loose comparison on purpose. Shopee displays a name with slashes in it
  // ("...-12/08/2026-...csv") that reaches disk with underscores, so an exact
  // match would call a perfectly good file missing.
  const loose = (s) => basename(s || '').replace(/[^a-z0-9]/gi, '').toLowerCase();

  try {
    const items = await chrome.downloads.search({
      limit: 40,
      orderBy: ['-startTime']
    });
    const wanted = loose(expected);
    const since = (state.startedAt || Date.now()) - 60000;
    const inFolder = items.filter((item) => {
      if (item.state !== 'complete' || item.exists === false) return false;
      if (new Date(item.startTime).getTime() < since) return false;
      return String(item.filename || '').includes(folder);
    });

    // Prefer the file we were expecting; otherwise take the newest thing this
    // run put in the folder. Landing under a name we did not predict is worth
    // reporting as a success — the file is there — and the run folder is
    // ours alone, so nothing else can be in it.
    return inFolder.find((item) => wanted && loose(item.filename) === wanted) ||
      inFolder[0] ||
      null;
  } catch (_) {
    return null;
  }
}

/**
 * A page-initiated download is only real once Chrome has finished writing.
 *
 * The no-capture case used to fall through to `return res.filename` — the name
 * the content script EXPECTED — so a report could be ticked for a file nobody
 * had seen arrive. Our onDeterminingFilename listener is what puts a
 * page-started download into the dated folder and what records the capture, so
 * no capture means no controlled placement, and that deserves a look rather
 * than a tick.
 */
async function confirmDownload(res) {
  if (res.via !== 'browser') return res.filename;

  if (state.watch.capturedId != null) {
    const verified = await verifyDownload(state.watch.capturedId, 120000);
    if (!verified.ok) throw new AppError(verified.error);
    state.lastDownloadId = state.watch.capturedId;
    return verified.filename || res.filename;
  }

  const landed = await findRunDownload(res.filename);
  if (landed) {
    state.lastDownloadId = landed.id;
    return basename(landed.filename) || res.filename;
  }

  throw new AppError(
    `Shopee started the download for "${res.filename || 'this report'}" but it ` +
      `never arrived in ${state.runFolder || state.folder}. Another extension ` +
      'may be intercepting downloads — check chrome://extensions for a download ' +
      'manager, then run this report again.'
  );
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
  state.realtimeDate = await getRealtimeDate();
  // Kept in the state so old popups and stored run records still read; there
  // is only one way to run now.
  state.mode = 'furious';
  state.error = '';
  state.startedAt = Date.now();
  state.finishedAt = null;
  const startedAt = new Date();
  // Named for the day the reports cover, timed by when the run happened.
  const day = reportDay(startedAt, state.realtimeDate);
  state.folder = dateFolder(day);
  state.runFolder = runFolder(day, startedAt);
  state.results = blankResults(ids);
  state.orderLog = [];
  state.tabIds = [];
  state.tabId = null;
  persist();
  persistRun();
  startKeepAlive();
  setBadge('…', '#ee4d2d');

  let done = 0;

  // An export covering the same day as an earlier one would download the same
  // report to the same filename and overwrite it. Mark it and skip it, rather
  // than spending minutes producing a file that cannot survive.
  const dupes = duplicateExports(
    selected.map((ex) => ex.id),
    state.realtimeDate
  );
  for (const [id, firstId] of Object.entries(dupes)) {
    const first = EXPORTS.find((e) => e.id === firstId);
    setResult(Number(id), {
      status: 'done',
      detail: `Same day as #${firstId} ${first ? first.name : ''} — one file`,
      filename: ''
    });
    done++;
  }
  const queue = selected.filter((ex) => !dupes[ex.id]);
  if (!queue.length) {
    state.running = false;
    persist();
    persistRun();
    stopKeepAlive();
    return { ok: true, done, total: selected.length };
  }

  try {
    setResult(queue[0].id, { detail: 'Checking Shopee login…' });
    await checkLogin();

    // One way to run: a tab per report, phase by phase across all of them.
    // See runFurious(). Orders are ordinary slots in it — they just collect
    // from a different page than they were requested on.
    await closeTabs([state.tabId].filter((id) => id != null));
    done += await runFurious(queue);

  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    if (state.orderLog.length) logOrder(`run ABORTED: ${describeError(e)}`);
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

  // Write the trace while the run folder is still the target — saveFile()
  // depends on state.running and state.folder, which are cleared just below.
  //
  // Only when something went wrong. A clean run should leave the folder
  // holding reports and nothing else; the trace exists to explain a failure,
  // not to be filed alongside the data every morning.
  const ordersFailed = EXPORTS.some(
    (e) =>
      e.kind === 'order' &&
      state.results[e.id] &&
      state.results[e.id].status === 'error'
  );
  if (state.orderLog.length && (ordersFailed || state.error)) {
    try {
      const text = state.orderLog.join('\r\n') + '\r\n';
      await saveFile(
        `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`,
        'orders-log.txt'
      );
    } catch (_) {
      /* a missing log must never sink a run that otherwise worked */
    }
  }

  state.running = false;
  state.currentId = null;
  state.finishedAt = Date.now();
  persist();
  persistRun();
  stopKeepAlive();

  await recordHistory(selected);

  const total = selected.length;
  await chrome.storage.local.set({
    lastRun: {
      at: state.finishedAt,
      done,
      total,
      mode: state.mode,
      folder: state.folder,
      runFolder: state.runFolder,
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
    case 'getExports': {
      const realtimeDate = await getRealtimeDate();
      const spans = exportDates(new Date(), realtimeDate);
      const dupes = duplicateExports(EXPORTS.map((e) => e.id), realtimeDate);
      return {
        ok: true,
        realtimeDate,
        folder: dateFolder(reportDay(new Date(), realtimeDate)),
        exports: EXPORTS.map((e) => ({
          id: e.id,
          name: e.name,
          date: dateLabel(spans[e.id]),
          pinned: !!(spans[e.id] && spans[e.id].pinned),
          duplicateOf: dupes[e.id] || null
        }))
      };
    }

    case 'getHistory': {
      const { history = [] } = await chrome.storage.local.get('history');
      return { ok: true, history };
    }

    case 'clearHistory':
      await chrome.storage.local.remove('history');
      return { ok: true };

    case 'setRealtimeDate': {
      const value = parseYmd(msg.date) ? msg.date : '';
      await chrome.storage.local.set({ realtimeDate: value });
      state.realtimeDate = await getRealtimeDate();
      return { ok: true, realtimeDate: state.realtimeDate };
    }

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
      // Awaited, not fired and forgotten: the click that triggers the download
      // comes immediately after this reply, and the filename listener may be
      // reading this back from a worker that restarted in between.
      await persistRun();
      return { ok: true };

    // The content script has read the report's real name off the page; use it
    // to rescue any download Chrome would otherwise call "download (2).csv".
    case 'expectName':
      state.expectedName = basename(msg.name || '') || '';
      await persistRun();
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

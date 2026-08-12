/**
 * Popup UI.
 *
 * Holds no run state of its own — the popup is closed for most of a run.
 * It reads chrome.storage.local and re-renders on every change the service
 * worker writes there.
 */
'use strict';

const ICONS = {
  pending: '⏳', // hourglass
  running: '⏳',
  done: '✓',
  error: '✗',
  skipped: '·'
};

const el = {
  runFurious: document.getElementById('run-furious'),
  cancel: document.getElementById('cancel'),
  picker: document.getElementById('picker'),
  rows: document.getElementById('rows'),
  banner: document.getElementById('banner'),
  lastRun: document.getElementById('last-run'),
  version: document.getElementById('version'),
  updateBar: document.getElementById('update-bar'),
  updateText: document.getElementById('update-text'),
  updateAction: document.getElementById('update-action'),
  openFolder: document.getElementById('open-folder'),
  realtimeDate: document.getElementById('realtime-date'),
  realtimeClear: document.getElementById('realtime-clear'),
  realtimeHint: document.getElementById('realtime-hint'),
  historyBox: document.getElementById('history-box'),
  historyCount: document.getElementById('history-count'),
  history: document.getElementById('history'),
  clearHistory: document.getElementById('clear-history')
};

let exportDefs = [];
// The folder a run would save into right now — named for the pinned date.
let targetFolder = '';

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    showBanner(`Extension error: ${e && e.message ? e.message : e}`);
    return null;
  }
}

function showBanner(text) {
  if (!text) {
    el.banner.hidden = true;
    el.banner.textContent = '';
    return;
  }
  el.banner.hidden = false;
  el.banner.textContent = text;
}

function buildPicker() {
  el.picker.innerHTML = '';
  for (const def of exportDefs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(def.id);
    button.title = def.name;
    button.addEventListener('click', () => start([def.id]));
    el.picker.appendChild(button);
  }
}

function buildRows(results) {
  el.rows.innerHTML = '';
  for (const def of exportDefs) {
    const row = results && results[def.id];
    const status = row ? row.status : 'pending';

    const li = document.createElement('li');
    li.className = `row ${status}`;

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = ICONS[status] || ICONS.pending;

    const body = document.createElement('div');
    body.className = 'body';

    const name = document.createElement('div');
    name.className = 'name';
    const title = document.createElement('span');
    title.textContent = `#${def.id} ${def.name}`;
    name.appendChild(title);
    if (def.date) {
      const when = document.createElement('span');
      when.className = `when${def.pinned ? ' pinned' : ''}`;
      when.textContent = def.date;
      name.appendChild(when);
    }

    const detail = document.createElement('div');
    detail.className = 'detail';
    if (row && row.status === 'error') detail.textContent = row.error;
    else if (row && row.status === 'done') detail.textContent = row.filename;
    else if (row) detail.textContent = row.detail || '';

    body.appendChild(name);
    if (detail.textContent) body.appendChild(detail);
    li.appendChild(icon);
    li.appendChild(body);
    el.rows.appendChild(li);
  }
}

function formatWhen(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

const RUN_LABEL = ['🏎 Fast n Furious', 'All tabs at once · ~6 min'];

function setButton(button, running) {
  const [title, sub] = RUN_LABEL;
  button.disabled = running;
  button.innerHTML = '';
  button.append(
    running ? 'Running…' : title,
    Object.assign(document.createElement('small'), {
      textContent: running ? 'in progress' : sub
    })
  );
}

/**
 * Past runs, newest first.
 *
 * The question this answers is "did I already fetch today, and where did it
 * go?" — worth being able to answer without digging through Downloads,
 * because each run makes its own dated sub-folder and running twice in a day
 * makes two.
 */
function renderHistory(history) {
  el.history.textContent = '';

  const today = new Date().toDateString();
  const todayRuns = history.filter((h) => new Date(h.at).toDateString() === today);
  el.historyCount.textContent = todayRuns.length
    ? `· ${todayRuns.length} today`
    : history.length
      ? `· ${history.length}`
      : '';

  if (!history.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing yet. Runs will appear here.';
    el.history.appendChild(li);
    return;
  }

  for (const run of history) {
    const li = document.createElement('li');

    const head = document.createElement('div');
    head.className = 'history-when';
    head.appendChild(
      Object.assign(document.createElement('span'), {
        textContent: formatWhen(run.at)
      })
    );

    const reports = run.reports || [];
    const ok = reports.filter((r) => r.status === 'done').length;
    const tag = document.createElement('span');
    tag.className = ok === reports.length ? 'tag' : 'tag bad';
    tag.textContent = `${ok}/${reports.length}`;
    head.appendChild(tag);
    li.appendChild(head);

    // The sub-folder is where the files actually are.
    const where = document.createElement('div');
    where.className = 'history-what';
    where.textContent = run.runFolder || run.folder || '';
    li.appendChild(where);

    if (run.covers) {
      const covers = document.createElement('div');
      covers.className = 'history-detail';
      covers.textContent = `Real Time pinned to ${run.covers}`;
      li.appendChild(covers);
    }

    // Failures stay in the open — they are the reason to look at this list at
    // all, and must not be hidden behind another click.
    for (const report of reports.filter((r) => r.status !== 'done')) {
      const detail = document.createElement('div');
      detail.className = 'history-detail error';
      detail.textContent = `#${report.id} ${report.name} — ${report.error || report.status}`;
      li.appendChild(detail);
    }

    // The files themselves, folded away. Ten of them per run would bury the
    // list otherwise, but "what did I actually get" is the whole question the
    // panel exists to answer, so they have to be here.
    const fetched = reports.filter((r) => r.status === 'done' && r.filename);
    if (fetched.length) {
      const box = document.createElement('details');
      box.className = 'history-files';

      const summary = document.createElement('summary');
      summary.textContent = `${fetched.length} file${fetched.length === 1 ? '' : 's'}`;
      box.appendChild(summary);

      for (const report of fetched) {
        const line = document.createElement('div');
        line.className = 'history-file';
        line.appendChild(
          Object.assign(document.createElement('span'), {
            className: 'history-file-what',
            textContent: `#${report.id} ${report.name}`
          })
        );
        line.appendChild(
          Object.assign(document.createElement('span'), {
            className: 'history-file-name',
            textContent: report.filename
          })
        );
        box.appendChild(line);
      }
      li.appendChild(box);
    }

    // A run that produced nothing at all should say so rather than look empty.
    if (!fetched.length && !reports.some((r) => r.status !== 'done')) {
      const none = document.createElement('div');
      none.className = 'history-detail';
      none.textContent = 'No files.';
      li.appendChild(none);
    }

    el.history.appendChild(li);
  }
}

async function loadHistory() {
  const res = await send({ type: 'getHistory' });
  if (res && res.ok) renderHistory(res.history || []);
}

function render(runState, lastRun) {
  const running = !!(runState && runState.running);

  setButton(el.runFurious, running);
  el.cancel.hidden = !running;
  for (const button of el.picker.querySelectorAll('button')) {
    button.disabled = running;
  }

  buildRows(runState && runState.results);

  if (runState && runState.error && !running) showBanner(runState.error);
  else showBanner('');

  if (lastRun) {
    const mark = lastRun.done === lastRun.total ? '✓' : '✗';
    // Show the run's own sub-folder — that is where the files actually are.
    const where = lastRun.runFolder || lastRun.folder;
    el.lastRun.textContent = `Last run: ${lastRun.done}/${lastRun.total} ${mark} (${formatWhen(
      lastRun.at
    )})${where ? ' → ' + where : ''}`;
  } else {
    el.lastRun.textContent = 'No runs yet.';
  }
}

async function refresh() {
  const res = await send({ type: 'getState' });
  if (!res || !res.ok) return;
  render(res.state, res.lastRun);
}

async function start(ids) {
  showBanner('');
  const res = await send({ type: 'run', ids });
  if (res && res.ok === false && res.error) showBanner(res.error);
  setTimeout(refresh, 200);
}

const allIds = () => exportDefs.map((d) => d.id);
el.runFurious.addEventListener('click', () => start(allIds()));
// Opens the file manager at the dated folder, via the last saved file.
el.openFolder.addEventListener('click', async () => {
  el.openFolder.disabled = true;
  const res = await send({ type: 'openFolder' });
  if (res && res.revealed === 'downloads') {
    showBanner('No downloaded file to jump to yet — opened your Downloads folder.');
  }
  setTimeout(() => {
    el.openFolder.disabled = false;
  }, 500);
});

el.cancel.addEventListener('click', async () => {
  el.cancel.disabled = true;
  await send({ type: 'cancel' });
  setTimeout(() => {
    el.cancel.disabled = false;
    refresh();
  }, 300);
});

// The service worker mirrors every state change into storage, so the popup
// stays live whether it was open the whole time or just reopened.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.runState || changes.lastRun) refresh();
  // A run just ended, so there is a new entry to show.
  if (changes.history) loadHistory();
});

el.clearHistory.addEventListener('click', async () => {
  await send({ type: 'clearHistory' });
  await loadHistory();
});

/* ------------------------------------------------------------------ *
 * Update banner. Installing happens on the options page — a file picker
 * cannot be opened from a popup without the popup closing.
 * ------------------------------------------------------------------ */
// What the button does right now: re-check, or go to the options page to
// install. There is always a button, so an up-to-date state can still be
// re-checked on demand rather than waiting for the cache to expire.
let updateAction = 'check';

function showUpdate(text, kind, actionLabel, action) {
  el.updateBar.hidden = false;
  el.updateBar.className = `update-bar${kind ? ' ' + kind : ''}`;
  el.updateText.textContent = text;
  el.updateAction.hidden = !actionLabel;
  el.updateAction.disabled = false;
  if (actionLabel) el.updateAction.textContent = actionLabel;
  if (action) updateAction = action;
}

function applyUpdateResult(res) {
  if (!res || !res.ok) {
    showUpdate((res && res.error) || 'Update check failed.', 'err', 'Settings', 'options');
    return;
  }
  if (!res.configured) {
    showUpdate('Update checking is not set up yet.', null, 'Set up', 'options');
    return;
  }
  if (res.hasUpdate) {
    showUpdate(`Update available: v${res.latest}`, null, 'Update', 'options');
  } else {
    showUpdate(`You are on the latest version (v${res.current}).`, 'ok', 'Check', 'check');
  }
}

async function checkUpdate(force) {
  el.version.textContent = `v${chrome.runtime.getManifest().version}`;
  applyUpdateResult(await send({ type: 'checkUpdate', force: !!force }));
}

el.updateAction.addEventListener('click', async () => {
  if (updateAction === 'options') {
    await send({ type: 'openOptions' });
    window.close();
    return;
  }
  el.updateAction.disabled = true;
  el.updateAction.textContent = 'Checking…';
  await checkUpdate(true); // force: ignore the cached answer
});

/* ------------------------------------------------------------------ *
 * Real Time date
 *
 * Normally Real Time means today, which is only partial until the day ends.
 * Pinning it to an earlier day fetches that whole day instead.
 * ------------------------------------------------------------------ */
function renderRealtime(value) {
  el.realtimeDate.value = value || '';
  el.realtimeClear.hidden = !value;

  // Warn BEFORE a run: two exports covering the same day produce the same
  // filename, so only one file can exist.
  const clash = exportDefs.find((d) => d.duplicateOf);
  const twin = clash && exportDefs.find((d) => d.id === clash.duplicateOf);

  el.realtimeHint.className = `realtime-hint${value ? ' pinned' : ''}`;
  if (clash && twin) {
    el.realtimeHint.textContent =
      `Same day as #${twin.id} ${twin.name} — #${clash.id} will be skipped, ` +
      `you get one file for both. Saving to ${targetFolder}.`;
  } else if (value) {
    el.realtimeHint.textContent = `Saving to ${targetFolder}, not today's folder.`;
  } else {
    el.realtimeHint.textContent =
      'Leave empty for today. Pick an earlier day if you missed last night.';
  }
}

async function loadExports() {
  const res = await send({ type: 'getExports' });
  exportDefs = (res && res.exports) || [];
  targetFolder = (res && res.folder) || '';
  // Cannot pin to today or later — there would be nothing extra to fetch.
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  el.realtimeDate.max = yesterday.toISOString().slice(0, 10);
  renderRealtime(res && res.realtimeDate);
  buildPicker();
}

async function setRealtimeDate(value) {
  const res = await send({ type: 'setRealtimeDate', date: value });
  renderRealtime(res && res.realtimeDate);
  await loadExports(); // date labels move with it
  await refresh();
}

el.realtimeDate.addEventListener('change', () =>
  setRealtimeDate(el.realtimeDate.value)
);
el.realtimeClear.addEventListener('click', () => setRealtimeDate(''));

(async function init() {
  await loadExports();
  await refresh();
  await loadHistory();
  checkUpdate(); // not awaited — never let a slow network hold up the UI
})();

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
  runSteady: document.getElementById('run-steady'),
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
  openFolder: document.getElementById('open-folder')
};

let exportDefs = [];

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
    // A single report has nothing to parallelise, so it always runs steady.
    button.addEventListener('click', () => start([def.id], 'steady'));
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
    name.textContent = `#${def.id} ${def.name}`;

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

const LABELS = {
  steady: ['🐌 Slow n Steady', 'One tab at a time · ~12 min'],
  furious: ['🏎 Fast n Furious', 'All tabs at once · ~4 min']
};

function setButton(button, mode, running, activeMode) {
  const [title, sub] = LABELS[mode];
  button.disabled = running;
  button.innerHTML = '';
  button.append(
    running && activeMode === mode ? 'Running…' : title,
    Object.assign(document.createElement('small'), {
      textContent: running && activeMode === mode ? 'in progress' : sub
    })
  );
}

function render(runState, lastRun) {
  const running = !!(runState && runState.running);
  const activeMode = (runState && runState.mode) || 'steady';

  setButton(el.runSteady, 'steady', running, activeMode);
  setButton(el.runFurious, 'furious', running, activeMode);
  el.cancel.hidden = !running;
  for (const button of el.picker.querySelectorAll('button')) {
    button.disabled = running;
  }

  buildRows(runState && runState.results);

  if (runState && runState.error && !running) showBanner(runState.error);
  else showBanner('');

  if (lastRun) {
    const mark = lastRun.done === lastRun.total ? '✓' : '✗';
    const how = lastRun.mode === 'furious' ? '🏎' : '🐌';
    el.lastRun.textContent = `Last run: ${how} ${lastRun.done}/${lastRun.total} ${mark} (${formatWhen(
      lastRun.at
    )})${lastRun.folder ? ' → ' + lastRun.folder : ''}`;
  } else {
    el.lastRun.textContent = 'No runs yet.';
  }
}

async function refresh() {
  const res = await send({ type: 'getState' });
  if (!res || !res.ok) return;
  render(res.state, res.lastRun);
}

async function start(ids, mode) {
  showBanner('');
  const res = await send({ type: 'run', ids, mode });
  if (res && res.ok === false && res.error) showBanner(res.error);
  setTimeout(refresh, 200);
}

const allIds = () => exportDefs.map((d) => d.id);
el.runSteady.addEventListener('click', () => start(allIds(), 'steady'));
el.runFurious.addEventListener('click', () => start(allIds(), 'furious'));
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
});

/* ------------------------------------------------------------------ *
 * Update banner. Installing happens on the options page — a file picker
 * cannot be opened from a popup without the popup closing.
 * ------------------------------------------------------------------ */
function showUpdate(text, kind, actionLabel) {
  el.updateBar.hidden = false;
  el.updateBar.className = `update-bar${kind ? ' ' + kind : ''}`;
  el.updateText.textContent = text;
  el.updateAction.hidden = !actionLabel;
  if (actionLabel) el.updateAction.textContent = actionLabel;
}

async function checkUpdate() {
  el.version.textContent = `v${chrome.runtime.getManifest().version}`;
  const res = await send({ type: 'checkUpdate' });
  if (!res || !res.ok) {
    showUpdate((res && res.error) || 'Update check failed.', 'err', 'Settings');
    return;
  }
  if (!res.configured) {
    showUpdate('Update checking is not set up yet.', null, 'Set up');
    return;
  }
  if (res.hasUpdate) {
    showUpdate(`Update available: v${res.latest}`, null, 'Update');
  } else {
    showUpdate(`You are on the latest version (v${res.current}).`, 'ok');
  }
}

el.updateAction.addEventListener('click', async () => {
  await send({ type: 'openOptions' });
  window.close();
});

(async function init() {
  const res = await send({ type: 'getExports' });
  exportDefs = (res && res.exports) || [];
  buildPicker();
  await refresh();
  checkUpdate(); // not awaited — never let a slow network hold up the UI
})();

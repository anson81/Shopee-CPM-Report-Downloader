/**
 * The Real Time pin must not outlive the run it was set for.
 *
 * Set on 23 Aug 2026 to catch up on the 22nd, it stayed pinned, and the next
 * run filed itself under 22082026-Saturday while the popup warned in small red
 * text that nobody read. A setting that silently changes tomorrow's behaviour
 * is a trap, not a feature.
 *
 * runExports() needs a whole browser to execute, so the clearing itself is
 * asserted against the source. Crude, and still better than shipping this
 * untested — which is how it got here.
 *
 * Run: node tools/test-realtime-pin.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = path.join(__dirname, '..', 'background', 'background.js');
const text = fs.readFileSync(SOURCE, 'utf8');

test('the run clears the pin when it finishes', () => {
  assert.match(
    text,
    /chrome\.storage\.local\.remove\('realtimeDate'\)/,
    'runExports() must clear realtimeDate when it ends'
  );
});

test('the pin is cleared before lastRun is recorded', () => {
  const clearAt = text.indexOf("remove('realtimeDate')");
  const lastRunAt = text.indexOf('lastRun: {');
  assert.ok(clearAt > -1, 'no clear found');
  assert.ok(lastRunAt > -1, 'no lastRun record found');
  // A popup reopened straight after a run reads both. If lastRun were written
  // first the two would disagree for as long as it took to clear.
  assert.ok(clearAt < lastRunAt, 'clear the pin before recording the run');
});

test('the in-memory copy is cleared too, not just storage', () => {
  // A worker that survives the run would otherwise keep the pin for the next
  // one, which is the same bug wearing a different hat.
  const idx = text.indexOf("remove('realtimeDate')");
  const after = text.slice(idx, idx + 200);
  assert.match(after, /state\.realtimeDate = ''/, 'state.realtimeDate must be cleared as well');
});

test('a pinned date of today or later is still treated as unset', () => {
  const start = text.indexOf('/* PURE-DATES-START */');
  const end = text.indexOf('/* PURE-DATES-END */');
  assert.ok(start > -1 && end > -1, 'PURE-DATES markers missing');
  const box = {};
  vm.createContext(box);
  vm.runInContext(text.slice(start, end), box);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;

  // getRealtimeDate()'s rule is `parsed < today`. Today itself must not pass.
  assert.ok(!(box.parseYmd(iso(today)) < today), 'today must not count as pinned');

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  assert.ok(!(box.parseYmd(iso(tomorrow)) < today), 'a future date must not count as pinned');

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  assert.ok(box.parseYmd(iso(yesterday)) < today, 'yesterday is a real pin');
});

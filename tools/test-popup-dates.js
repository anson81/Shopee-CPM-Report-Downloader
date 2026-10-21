/**
 * The Real Time date box must offer yesterday in the seller's own time.
 *
 * Its upper limit was `yesterday.toISOString()`, which is UTC. Malaysia is
 * UTC+8, so from midnight to 8am "yesterday" in UTC is still the day before
 * — on 21 Oct 2026 at 7:47am the box would not let you pick 20 Oct, which is
 * exactly the "missed last night" day it exists for.
 *
 * The popup needs a whole DOM to run, so this asserts against the source and
 * re-runs the limit's own expression with the clock set to that morning.
 *
 * Run: node tools/test-popup-dates.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SOURCE = path.join(__dirname, '..', 'popup', 'popup.js');
const text = fs.readFileSync(SOURCE, 'utf8');

test('the popup never turns a date into UTC', () => {
  assert.doesNotMatch(text, /toISOString|getUTC/, 'popup dates must be local');
});

test('at 7:47am MYT on 21 Oct, the latest day on offer is 20 Oct', () => {
  const fn = /function localYmd\([\s\S]*?\n\}/.exec(text);
  assert.ok(fn, 'popup.js should define localYmd(date)');
  // A child process, because TZ is only read when the process starts.
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      `${fn[0]}
       const yesterday = new Date('2026-10-20T23:47:00Z');
       yesterday.setDate(yesterday.getDate() - 1);
       console.log(localYmd(yesterday));`,
    ],
    { env: { ...process.env, TZ: 'Asia/Kuala_Lumpur' }, encoding: 'utf8' }
  ).trim();
  assert.strictEqual(out, '2026-10-20');
});

test('the date box limit uses localYmd', () => {
  assert.match(text, /realtimeDate\.max = localYmd\(yesterday\)/);
});

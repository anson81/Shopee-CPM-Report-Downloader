/**
 * Unit tests for the pure date maths in background/background.js.
 *
 * The service worker is a classic script with no exports, so this slices out
 * the region marked PURE-DATES and runs it standalone. Everything inside those
 * markers must stay free of `chrome`, `state`, and the DOM.
 *
 * Worth testing precisely because the failure is silent: a file named for days
 * it does not contain looks perfectly fine, and someone acts on the numbers.
 *
 * Run: node --test tools/test-dates.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPureDates() {
  const source = path.join(__dirname, '..', 'background', 'background.js');
  const text = fs.readFileSync(source, 'utf8');
  const start = text.indexOf('/* PURE-DATES-START */');
  const end = text.indexOf('/* PURE-DATES-END */');
  if (start === -1 || end === -1) {
    throw new Error('PURE-DATES markers not found in background/background.js');
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(text.slice(start, end), sandbox);
  return sandbox;
}

const D = loadPureDates();

/** A local date, so these tests do not drift with the machine's timezone. */
function on(y, m, d) {
  return new Date(y, m - 1, d);
}

const days = (span) => Math.round((span.to - span.from) / 86400000) + 1;

test('ymd formats a local date', () => {
  assert.equal(D.ymd(on(2026, 8, 11)), '2026-08-11');
  assert.equal(D.ymd(on(2026, 1, 5)), '2026-01-05');
});

test('parseYmd rejects impossible dates', () => {
  assert.equal(D.parseYmd('2026-13-45'), null);
  assert.equal(D.parseYmd('nonsense'), null);
  assert.equal(D.ymd(D.parseYmd('2026-08-11')), '2026-08-11');
});

test('addDays crosses a month boundary', () => {
  assert.equal(D.ymd(D.addDays(on(2026, 8, 1), -1)), '2026-07-31');
});

test('mondayOf treats Sunday as the end of the week', () => {
  assert.equal(D.ymd(D.mondayOf(on(2026, 8, 9))), '2026-08-03'); // a Sunday
  assert.equal(D.ymd(D.mondayOf(on(2026, 8, 10))), '2026-08-10'); // a Monday
});

test('monthsBetween counts calendar months and never goes negative', () => {
  assert.equal(D.monthsBetween(on(2026, 8, 11), on(2026, 6, 12)), 2);
  assert.equal(D.monthsBetween(on(2026, 8, 11), on(2026, 8, 1)), 0);
  assert.equal(D.monthsBetween(on(2026, 1, 5), on(2025, 11, 30)), 2);
  assert.equal(D.monthsBetween(on(2026, 8, 11), on(2026, 9, 1)), 0);
});

/* --- the seven original reports, unchanged ---------------------------- */

test('exportDates: an unpinned run counts back from today', () => {
  const spans = D.exportDates(on(2026, 8, 11), '');
  assert.equal(D.ymd(spans[1].from), '2026-08-11'); // Real Time
  assert.equal(D.ymd(spans[2].from), '2026-08-10'); // Yesterday
  assert.equal(D.ymd(spans[3].from), '2026-08-09'); // By Day
  assert.equal(D.ymd(spans[4].from), '2026-08-04'); // Past 7 Days
  assert.equal(D.ymd(spans[4].to), '2026-08-10');
  assert.equal(spans[6], null); // Ads: Shopee's own range
  assert.equal(spans[7], null);
});

test('exportDates: a pinned date moves the whole run', () => {
  const spans = D.exportDates(on(2026, 8, 11), '2026-08-07');
  assert.equal(D.ymd(spans[1].from), '2026-08-07');
  assert.equal(D.ymd(spans[2].from), '2026-08-06');
  assert.equal(D.ymd(spans[3].from), '2026-08-05');
});

test('exportDates: on a pinned run By Week sits immediately before Past 7 Days', () => {
  // Both are whole Mon–Sun weeks once pinned, so they butt up exactly.
  const spans = D.exportDates(on(2026, 8, 11), '2026-08-07');
  assert.equal(D.ymd(spans[4].from), '2026-08-03');
  assert.equal(D.ymd(spans[5].to), '2026-08-02');
  assert.equal(D.ymd(D.addDays(spans[5].to, 1)), D.ymd(spans[4].from));
});

test('exportDates: unpinned, By Week is a whole week ending before Past 7 Days', () => {
  // Unpinned, Past 7 Days is Shopee's own ROLLING week (Tue–Mon here) while By
  // Week is always Mon–Sun, so the two do not butt up exactly. They must still
  // never overlap — that is the property worth holding onto.
  const spans = D.exportDates(on(2026, 8, 11), '');
  assert.equal(D.ymd(spans[4].from), '2026-08-04');
  assert.equal(D.ymd(spans[5].from), '2026-07-27');
  assert.equal(D.ymd(spans[5].to), '2026-08-02');
  assert.ok(spans[5].to < spans[4].from, 'By Week must end before Past 7 Days starts');
});

/* --- the three new reports -------------------------------------------- */

test('exportDates: Past 30 Days claims no range of its own', () => {
  assert.equal(D.exportDates(on(2026, 8, 11), '')[8], null);
});

test('orderBlocks: two blocks ending the day before the run', () => {
  const b = D.orderBlocks(on(2026, 8, 11), '');
  assert.equal(D.ymd(b.recent.from), '2026-07-12');
  assert.equal(D.ymd(b.recent.to), '2026-08-10');
  assert.equal(D.ymd(b.previous.from), '2026-06-12');
  assert.equal(D.ymd(b.previous.to), '2026-07-11');
});

test('orderBlocks: each block is exactly 30 days, with no overlap or gap', () => {
  const b = D.orderBlocks(on(2026, 8, 11), '');
  assert.equal(days(b.recent), 30);
  assert.equal(days(b.previous), 30);
  assert.equal(D.ymd(D.addDays(b.previous.to, 1)), D.ymd(b.recent.from));
});

test('orderBlocks: together they are exactly Shopee 60-day cap', () => {
  const b = D.orderBlocks(on(2026, 8, 11), '');
  assert.equal(days({ from: b.previous.from, to: b.recent.to }), 60);
});

test('orderBlocks: a pinned date moves both blocks', () => {
  const b = D.orderBlocks(on(2026, 8, 11), '2026-08-01');
  assert.equal(D.ymd(b.recent.to), '2026-07-31');
  assert.equal(D.ymd(b.recent.from), '2026-07-02');
  assert.equal(D.ymd(b.previous.to), '2026-07-01');
  assert.equal(D.ymd(b.previous.from), '2026-06-02');
});

test('orderBlocks: crossing a year boundary', () => {
  const b = D.orderBlocks(on(2026, 1, 15), '');
  assert.equal(D.ymd(b.recent.from), '2025-12-16');
  assert.equal(D.ymd(b.recent.to), '2026-01-14');
  assert.equal(D.ymd(b.previous.from), '2025-11-16');
  assert.equal(D.ymd(b.previous.to), '2025-12-15');
});

test('exportDates carries the order blocks for the popup', () => {
  const spans = D.exportDates(on(2026, 8, 11), '');
  assert.equal(D.ymd(spans[9].from), '2026-07-12');
  assert.equal(D.ymd(spans[9].to), '2026-08-10');
  assert.equal(D.ymd(spans[10].from), '2026-06-12');
  assert.equal(D.ymd(spans[10].to), '2026-07-11');
});

test('orderFilename predicts the name Shopee will publish', () => {
  const b = D.orderBlocks(on(2026, 8, 11), '');
  assert.equal(D.orderFilename(b.recent), 'Order.all.20260712_20260810.xlsx');
  assert.equal(D.orderFilename(b.previous), 'Order.all.20260612_20260711.xlsx');
});

test('the two order files can never share a name', () => {
  const b = D.orderBlocks(on(2026, 8, 11), '');
  assert.notEqual(D.orderFilename(b.recent), D.orderFilename(b.previous));
});

test('orderRangeText matches what the modal displays', () => {
  const b = D.orderBlocks(on(2026, 8, 11), '');
  assert.equal(D.orderRangeText(b.recent), '2026/07/12 – 2026/08/10');
  assert.equal(D.orderRangeText(b.previous), '2026/06/12 – 2026/07/11');
});

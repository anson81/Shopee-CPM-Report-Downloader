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
  // Fri 7 Aug: the week containing it is not over, so Past 7 Days is the one
  // before. (Until 1.21.2 this asserted 3–9 Aug, two days past the pin.)
  const spans = D.exportDates(on(2026, 8, 11), '2026-08-07');
  assert.equal(D.ymd(spans[4].from), '2026-07-27');
  assert.equal(D.ymd(spans[4].to), '2026-08-02');
  assert.equal(D.ymd(spans[5].from), '2026-07-20');
  assert.equal(D.ymd(spans[5].to), '2026-07-26');
  assert.equal(D.ymd(D.addDays(spans[5].to, 1)), D.ymd(spans[4].from));
});

test('exportDates: pinned Tue 20 Oct 2026 takes 12–18 Oct, not the week still running', () => {
  // The real case. The old rule took the week containing Mon 19 Oct, asked
  // Shopee for 19–25 Oct, and got parentskudetail.20261019_20261020.xlsx.
  const spans = D.exportDates(on(2026, 10, 21), '2026-10-20');
  assert.equal(D.ymd(spans[4].from), '2026-10-12');
  assert.equal(D.ymd(spans[4].to), '2026-10-18');
  assert.equal(D.ymd(spans[5].from), '2026-10-05');
  assert.equal(D.ymd(spans[5].to), '2026-10-11');
});

test('exportDates: pinned Monday takes the week that ended the day before', () => {
  const spans = D.exportDates(on(2026, 10, 21), '2026-10-19');
  assert.equal(D.ymd(spans[4].from), '2026-10-12');
  assert.equal(D.ymd(spans[4].to), '2026-10-18');
});

test('exportDates: every pinned weekday gives whole weeks that end before the pin', () => {
  // Two full weeks of pins, Mon 5 Oct – Sun 18 Oct 2026, so every weekday is
  // seen in two different weeks and across the month-end-free middle.
  for (let d = 5; d <= 18; d++) {
    const pin = on(2026, 10, d);
    const spans = D.exportDates(on(2026, 10, 21), D.ymd(pin));
    const p7 = spans[4];
    const wk = spans[5];
    const label = `pin ${D.ymd(pin)}`;
    assert.equal(days(p7), 7, `${label}: Past 7 Days is seven days`);
    assert.equal(p7.from.getDay(), 1, `${label}: Past 7 Days starts on a Monday`);
    assert.ok(p7.to <= D.addDays(pin, -1), `${label}: Past 7 Days ends by the day before the pin`);
    // The newest complete week: the next one would reach the pin.
    assert.ok(D.addDays(p7.to, 7) >= pin, `${label}: Past 7 Days is the newest complete week`);
    assert.equal(days(wk), 7, `${label}: By Week is seven days`);
    assert.equal(D.ymd(D.addDays(wk.to, 1)), D.ymd(p7.from), `${label}: By Week butts up against Past 7 Days`);
  }
});

test('exportDates: a pinned week across a month and year boundary', () => {
  // Fri 1 Jan 2027: the last whole week is Mon 21 – Sun 27 Dec 2026.
  const spans = D.exportDates(on(2027, 1, 5), '2027-01-01');
  assert.equal(D.ymd(spans[4].from), '2026-12-21');
  assert.equal(D.ymd(spans[4].to), '2026-12-27');
  assert.equal(D.ymd(spans[5].from), '2026-12-14');
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

/* --- #11 By Month (last month) ---------------------------------------- */

test('lastMonthSpan is the whole calendar month before the base day', () => {
  const s = D.lastMonthSpan(on(2026, 10, 21));
  assert.equal(D.ymd(s.from), '2026-09-01');
  assert.equal(D.ymd(s.to), '2026-09-30');
});

test('lastMonthSpan gets every month length right', () => {
  assert.equal(D.ymd(D.lastMonthSpan(on(2026, 9, 1)).to), '2026-08-31'); // 31
  assert.equal(D.ymd(D.lastMonthSpan(on(2026, 3, 31)).to), '2026-02-28'); // 28
  assert.equal(D.ymd(D.lastMonthSpan(on(2028, 3, 15)).to), '2028-02-29'); // leap
  assert.equal(D.ymd(D.lastMonthSpan(on(2026, 5, 31)).to), '2026-04-30'); // 30, from a 31st
});

test('lastMonthSpan in January is December of the year before', () => {
  const s = D.lastMonthSpan(on(2027, 1, 3));
  assert.equal(D.ymd(s.from), '2026-12-01');
  assert.equal(D.ymd(s.to), '2026-12-31');
});

test('exportDates: By Month follows a pinned day, like every other row', () => {
  assert.equal(D.ymd(D.exportDates(on(2026, 10, 21), '')[11].from), '2026-09-01');
  // Pinned early in the same month: last month is still September.
  assert.equal(D.ymd(D.exportDates(on(2026, 10, 21), '2026-10-02')[11].to), '2026-09-30');
  // Pinned into September, last month is August.
  assert.equal(D.ymd(D.exportDates(on(2026, 10, 21), '2026-09-30')[11].from), '2026-08-01');
});

test('performanceFilename predicts the Product Performance name', () => {
  const s = D.lastMonthSpan(on(2026, 10, 21));
  assert.equal(D.performanceFilename(s), 'parentskudetail.20260901_20260930.xlsx');
});

test('yearsBetween counts year-arrow presses and never goes negative', () => {
  assert.equal(D.yearsBetween(on(2026, 10, 21), on(2026, 9, 1)), 0);
  assert.equal(D.yearsBetween(on(2027, 1, 3), on(2026, 12, 1)), 1);
  assert.equal(D.yearsBetween(on(2026, 1, 3), on(2027, 1, 1)), 0);
});

test('orderRangeText matches what the modal displays', () => {
  const b = D.orderBlocks(on(2026, 8, 11), '');
  assert.equal(D.orderRangeText(b.recent), '2026/07/12 – 2026/08/10');
  assert.equal(D.orderRangeText(b.previous), '2026/06/12 – 2026/07/11');
});

/**
 * The By Month picker's text matching, against what Shopee's calendar really
 * contains — copied from the P50's diagnostics on 21 Oct 2026, the first time
 * anyone saw that panel:
 *
 *   header  "October20262020 – 2029"   (month label, year, decade, run together)
 *   label   "2026"                     (.eds-picker-header__label)
 *   cells   "JanFebMar", "Jan", "Feb", "Mar", "AprMayJun", … "Nov(x)", "Dec(x)"
 *
 * v1.21.0 searched the header and read 2029. It also matched months on their
 * first three letters, which the row elements ("JulAugSep") satisfy too.
 *
 * The functions are lifted out of content/content.js by name, so this tests
 * the shipped code rather than a copy of it.
 *
 * Run: node tools/test-month-picker.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const text = fs.readFileSync(path.join(__dirname, '..', 'content', 'content.js'), 'utf8');

/** One top-level-in-the-IIFE function's source, by name. */
function lift(name) {
  const start = text.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`content.js has no function ${name}`);
  // Functions there are two-space indented; the closing brace is too.
  const end = text.indexOf('\n  }\n', start);
  return text.slice(start, end + 4);
}

function liftConst(name) {
  const start = text.indexOf(`const ${name} = [`);
  if (start === -1) throw new Error(`content.js has no const ${name}`);
  return text.slice(start, text.indexOf('];', start) + 2);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  [
    "const squash = (s) => String(s || '').replace(/\\s+/g, ' ').trim();",
    liftConst('MONTH_NAMES'),
    lift('pad2'),
    lift('namesMonth'),
    'this.namesMonth = namesMonth;'
  ].join('\n'),
  sandbox
);
const { namesMonth } = sandbox;

const CELLS = [
  'JanFebMar', 'Jan', 'Feb', 'Mar', 'AprMayJun', 'Apr', 'May', 'Jun',
  'JulAugSep', 'Jul', 'Aug', 'Sep', 'OctNovDec', 'Oct', 'Nov', 'Dec'
];

test('every month finds exactly its own cell, never a row', () => {
  for (let n = 1; n <= 12; n++) {
    const hits = CELLS.filter((c) => namesMonth(c, n));
    assert.deepStrictEqual(hits, [CELLS.filter((c) => c.length === 3)[n - 1]], `month ${n}`);
  }
});

test('long and numeric spellings still match', () => {
  assert.ok(namesMonth('September', 9));
  assert.ok(namesMonth('Sept', 9));
  assert.ok(namesMonth('9', 9));
  assert.ok(namesMonth('09', 9));
  assert.ok(namesMonth('9月', 9));
  assert.ok(!namesMonth('Se', 9));
  assert.ok(!namesMonth('JulAugSep', 9));
});

test('the year comes from an element whose whole text is a year', () => {
  // panelYear() keeps only texts that are exactly a year. Applied to what the
  // P50's header held, that is the label — not the decade, not the run-on.
  const seen = ['October20262020 – 2029', '', '2026', ''];
  const years = seen.filter((t) => /^20\d{2}$/.test(t));
  assert.deepStrictEqual(years, ['2026']);
  assert.match(lift('panelYear'), /\^20\\d\{2\}\$/, 'panelYear must use the whole-text rule');
});

test('the year arrow is looked for inside the calendar, not across the page', () => {
  const source = lift('selectSpecificMonth');
  assert.match(source, /\$\$\(\s*'\.eds-picker-header__prev[^']*',\s*currentMonthPanel\(opened\)\s*\)/);
});

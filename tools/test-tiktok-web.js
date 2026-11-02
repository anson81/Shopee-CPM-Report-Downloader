/**
 * Find a video's pure part. Run: node tools/test-tiktok-web.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'tiktok-web.js'), 'utf8'), sandbox);
const W = sandbox.SRD_TikTokWeb;

test('usernameOf takes @name, name or a profile link, and refuses anything else', () => {
  assert.strictEqual(W.usernameOf('@ecahzaaim88'), 'ecahzaaim88');
  assert.strictEqual(W.usernameOf(' qfm_official '), 'qfm_official');
  assert.strictEqual(W.usernameOf('https://www.tiktok.com/@mylora.fashion?lang=en'), 'mylora.fashion');
  assert.strictEqual(W.usernameOf('two words'), null);
  assert.strictEqual(W.usernameOf(''), null);
});

test('videoUrlOf keeps tiktok.com links only, without the query', () => {
  assert.strictEqual(W.videoUrlOf('https://www.tiktok.com/@a/video/123?is_from=x'), 'https://www.tiktok.com/@a/video/123');
  assert.strictEqual(W.videoUrlOf('https://vt.tiktok.com/ZSabc/'), 'https://vt.tiktok.com/ZSabc/');
  assert.strictEqual(W.videoUrlOf('https://evil.example.com/tiktok.com/x'), null);
  assert.strictEqual(W.videoUrlOf('http://www.tiktok.com/@a/video/1'), null);
});

test('problemOf explains each state that stops a read, and nothing for READY', () => {
  for (const s of ['VERIFY', 'LIMITED', 'WAIT', 'NOT_FOUND', 'NO_ADDRESS', 'NO_FILE', 'TOO_LARGE']) assert.ok(W.problemOf(s));
  assert.strictEqual(W.problemOf('READY'), null);
});

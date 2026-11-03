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

test("pageFindCreators takes TikTok's id from item_id, not Affiliate Center's video.id, and builds the link", async () => {
  const answer = {
    code: 0,
    creator_profile_list: [{
      handle: { value: 'ana' }, nickname: { value: 'Ana' }, follower_cnt: { value: 10 }, has_collaborated: { value: true },
      top_video_data: { value: [
        { item_id: '7699863396191128884', name: '#hoodie', play_cnt: 5, video: { id: 'v12044gd0000abc', post_url: 'https://p16-common-sign.tiktokcdn.com/cover.jpg', video_infos: [{ main_url: 'https://v16m-default.tiktokcdn.com/x', backup_url: 'https://v16m.byteicdn.com/x', url_expire: 1793700000 }] } },
        { name: 'no id', video: { id: 'v2', video_infos: [{ main_url: 'https://v16m-default.tiktokcdn.com/y', url_expire: 1793700000 }] } },
      ] },
    }],
  };
  sandbox.location = { search: '?shop_id=749', pathname: '/affiliate/creator' };
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.XMLHttpRequest = class {
    open() {}
    setRequestHeader() {}
    send() {
      this.responseText = JSON.stringify(answer);
      this.onload();
    }
  };
  const r = await W.pageFindCreators('ana');
  const [video, noId] = r.creators[0].videos;
  assert.strictEqual(video.id, '7699863396191128884');
  assert.strictEqual(video.url, 'https://www.tiktok.com/@ana/video/7699863396191128884');
  assert.strictEqual(video.hasFile, true);
  assert.strictEqual(noId.hasFile, false);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.links.map((l) => l.videoId))), ['7699863396191128884']);
});

test('pageFillCaption waits for the box and the file name, pastes over it, never types, and checks it took', async () => {
  const text = 'Lembut gila\n\n#ootd #baju';
  const commands = [];
  let takes = true;
  let pastes = 0;
  const box = {
    innerText: '',
    focus() {},
    dispatchEvent(e) {
      assert.strictEqual(e.type, 'paste');
      pastes++;
      if (takes) box.innerText = e.clipboardData.getData('text/plain');
    },
  };
  sandbox.__box = null;
  sandbox.document = {
    querySelector: (css) => (css === '.public-DraftEditor-content' ? sandbox.__box : null),
    execCommand: (cmd) => commands.push(cmd),
    dispatchEvent() {},
  };
  sandbox.setTimeout = setTimeout;
  sandbox.Event = class { constructor(type) { this.type = type; } };
  sandbox.DataTransfer = class {
    setData(_type, value) { this.value = value; }
    getData() { return this.value; }
  };
  sandbox.ClipboardEvent = class { constructor(type, init) { this.type = type; this.clipboardData = init.clipboardData; } };

  assert.strictEqual((await W.pageFillCaption(text)).state, 'WAIT');
  sandbox.__box = box;
  assert.strictEqual((await W.pageFillCaption(text)).state, 'WAIT');
  box.innerText = 'profitlens-g2';
  takes = false;
  assert.strictEqual((await W.pageFillCaption(text)).state, 'NOT_TAKEN');
  takes = true;
  assert.strictEqual((await W.pageFillCaption(text)).state, 'READY');
  assert.strictEqual(box.innerText, text);
  // Asked again it leaves the words alone, and typing past the editor is what crashed Studio.
  const before = pastes;
  assert.strictEqual((await W.pageFillCaption(text)).state, 'READY');
  assert.strictEqual(pastes, before);
  assert.ok(!commands.includes('insertText'));
});

test('problemOf explains each state that stops a read, and nothing for READY', () => {
  for (const s of ['VERIFY', 'LIMITED', 'WAIT', 'NOT_FOUND', 'NO_ADDRESS', 'NO_FILE', 'TOO_LARGE', 'NO_AFFILIATE']) assert.ok(W.problemOf(s));
  assert.strictEqual(W.problemOf('READY'), null);
});

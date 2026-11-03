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

test('pageFillCaption replaces the file name through the editor, picks each hashtag from the list, and never types', async () => {
  const text = 'Lembut gila\n\n#ootd #baju #tiadalist';
  const file = 'profitlens-g2.mp4';
  const commands = [];
  const selections = [];
  let takes = true;
  let list = [];
  const pick = (tag) => {
    const item = {
      innerText: `${tag}\n3.5M posts`,
      dispatchEvent(e) {
        // Picking swaps the typed word for TikTok's tag and adds the space.
        if (e.type === 'click') {
          box.innerText += ' ';
          list = [];
        }
      },
    };
    return item;
  };
  const block = { getKey: () => 'k', getLength: () => box.innerText.length };
  const editorState = {
    constructor: { forceSelection: (_state, selection) => selection },
    getCurrentContent: () => ({ getFirstBlock: () => block, getLastBlock: () => block }),
    getSelection: () => ({ merge: (range) => range }),
  };
  const box = {
    innerText: '',
    focus() {},
    dispatchEvent(e) {
      assert.strictEqual(e.type, 'paste');
      if (!takes) return;
      const pasted = e.clipboardData.getData('text/plain');
      const whole = selections[selections.length - 1].anchorOffset === 0;
      box.innerText = whole ? pasted : box.innerText + pasted;
      selections.push({ anchorOffset: box.innerText.length });
      if (pasted === '#ootd' || pasted === '#baju') list = [pick('#OOTD-other'), pick(pasted)];
    },
    __reactFiber$x: { memoizedProps: {}, return: { memoizedProps: { editorState, onChange: (range) => selections.push(range) }, return: null } },
  };
  sandbox.__box = null;
  sandbox.document = {
    querySelector: (css) => (css === '.public-DraftEditor-content' ? sandbox.__box : null),
    querySelectorAll: () => list,
    execCommand: (cmd) => commands.push(cmd),
  };
  sandbox.setTimeout = (fn) => setTimeout(fn, 0);
  sandbox.window = {};
  sandbox.MouseEvent = class { constructor(type) { this.type = type; } };
  sandbox.DataTransfer = class {
    setData(_type, value) { this.value = value; }
    getData() { return this.value; }
  };
  sandbox.ClipboardEvent = class { constructor(type, init) { this.type = type; this.clipboardData = init.clipboardData; } };

  assert.strictEqual((await W.pageFillCaption(text, file)).state, 'WAIT');
  sandbox.__box = box;
  assert.strictEqual((await W.pageFillCaption(text, file)).state, 'WAIT');
  // Something in the box, but not yet the file name.
  box.innerText = 'Share more';
  assert.strictEqual((await W.pageFillCaption(text, file)).state, 'WAIT');
  box.innerText = 'profitlens-g2';
  takes = false;
  assert.strictEqual((await W.pageFillCaption(text, file)).state, 'NOT_TAKEN');
  takes = true;
  assert.strictEqual((await W.pageFillCaption(text, file)).state, 'READY');
  assert.strictEqual(box.innerText.trim(), text);
  assert.strictEqual(selections[0].anchorOffset, 0);
  assert.ok(!commands.includes('insertText'));

  // Asked again it leaves the words alone.
  const moves = selections.length;
  assert.strictEqual((await W.pageFillCaption(text, file)).state, 'READY');
  assert.strictEqual(selections.length, moves);

  // The caption beside something else: reported, never a second copy.
  box.innerText = `profitlens-g2${text}`;
  assert.strictEqual((await W.pageFillCaption(text, file)).state, 'LEFTOVER');
  assert.strictEqual(selections.length, moves);

  // No file name after a while: it goes ahead.
  box.innerText = 'Share more';
  assert.strictEqual((await W.pageFillCaption(text, file, true)).state, 'READY');

  // An editor it cannot reach: nothing is pasted.
  box.innerText = 'profitlens-g2';
  box.__reactFiber$x = null;
  assert.strictEqual((await W.pageFillCaption(text, file)).state, 'NOT_TAKEN');
  assert.strictEqual(box.innerText, 'profitlens-g2');
});

test('pageSetSchedule refuses another time zone, sets date and time, reports a mismatch, and has no way to press Schedule', async () => {
  const at = { year: 2026, month: 12, day: 2, hour: 21, minute: 30 };
  const values = [{ innerText: '3 Nov 2026' }, { innerText: '14:00' }];
  let month = 'November 2026';
  let panel = false;
  let takes = true;
  const clicked = [];
  const button = (text, act) => ({ innerText: text, click() { clicked.push(text); act(); } });
  const radio = { checked: false, click() { radio.checked = true; } };
  const cell = (text, act) => ({ innerText: text, querySelector: () => button(text, act), firstElementChild: null });
  const items = (list, act) => ({ querySelectorAll: () => list.map((t) => button(t, () => act(t))) });
  let hour = '14';
  let minute = '00';
  sandbox.setTimeout = (fn) => setTimeout(fn, 0);
  let offset = -480;
  sandbox.Date = class extends Date { getTimezoneOffset() { return offset; } };
  sandbox.document = {
    querySelector: (css) => {
      if (css.includes('value="schedule"')) return radio;
      if (css === '.DatePicker__title') return { innerText: month };
      if (css === '.TimePicker__panel') return panel ? {} : null;
      return null;
    },
    querySelectorAll: (css) => {
      if (css === '.schedule-picker .Picker__trigger') return [button('date', () => {}), button('time', () => { panel = !panel; })];
      if (css === '.schedule-picker .Picker__value') return values;
      if (css === '.DatePicker__nav') return [button('back', () => {}), button('next', () => { month = 'December 2026'; })];
      if (css === '.DatePicker__dayCell') {
        // The end of the month before, then this month, then the next month's start.
        return ['30', '1', '2', '31', '1', '2'].map((d) => cell(d, () => { if (takes) values[0].innerText = `${d} Dec 2026`; }));
      }
      if (css === '.TimePicker__column') {
        return [items(['20', '21'], (t) => { hour = t; values[1].innerText = `${hour}:${minute}`; }), items(['00', '30'], (t) => { minute = t; values[1].innerText = `${hour}:${minute}`; })];
      }
      return [];
    },
  };
  offset = 0;
  assert.strictEqual((await W.pageSetSchedule(at)).state, 'BAD_ZONE');
  offset = -480;
  assert.strictEqual((await W.pageSetSchedule(at)).state, 'READY');
  assert.ok(radio.checked);
  assert.strictEqual(values[0].innerText, '2 Dec 2026');
  assert.strictEqual(values[1].innerText, '21:30');
  assert.ok(!clicked.includes('Schedule') && !clicked.includes('Post'));

  values[0].innerText = '3 Nov 2026';
  month = 'November 2026';
  takes = false;
  assert.strictEqual((await W.pageSetSchedule(at)).state, 'NOT_SET');
});

test('pageAddProduct finds the product by id and adds it, and cancels when TikTok has no such product', async () => {
  let chip = null;
  let stage = 0;
  let found = true;
  const clicked = [];
  const press = (name, act) => ({ innerText: name, click() { clicked.push(name); act(); } });
  const input = { dispatchEvent() {} };
  const row = { innerText: 'Layla 1738 RM23.99', querySelector: () => ({ click() { clicked.push('radio'); } }) };
  sandbox.setTimeout = (fn) => setTimeout(fn, 0);
  sandbox.HTMLInputElement = class { set value(_v) {} get value() { return ''; } };
  sandbox.KeyboardEvent = class { constructor(type) { this.type = type; } };
  sandbox.Event = class { constructor(type) { this.type = type; } };
  sandbox.document = {
    querySelector: (css) => {
      if (css === '.anchor-tag-label') return chip;
      if (css === '.anchor-tag-container button') return press('+ Add', () => { stage = 1; });
      if (css.startsWith('input[placeholder')) return stage === 2 ? input : null;
      return null;
    },
    querySelectorAll: (css) => {
      if (css === '.common-modal-footer button') {
        if (stage === 1) return [press('Cancel', () => {}), press('Next', () => { stage = 2; })];
        if (stage === 2) return [press('Cancel', () => { stage = 0; }), press('Next', () => { stage = 3; })];
        if (stage === 3) return [press('Cancel', () => {}), press('Add', () => { chip = {}; stage = 0; })];
        return [];
      }
      if (css === 'tr.product-tb-row') return stage === 2 && found ? [row] : [];
      return [];
    },
  };
  assert.strictEqual((await W.pageAddProduct('1738')).state, 'READY');
  assert.deepStrictEqual(clicked, ['+ Add', 'Next', 'radio', 'Next', 'Add']);
  assert.strictEqual((await W.pageAddProduct('1738')).state, 'READY');
  assert.strictEqual(clicked.length, 5);

  chip = null;
  stage = 0;
  found = false;
  clicked.length = 0;
  assert.strictEqual((await W.pageAddProduct('999')).state, 'NOT_FOUND');
  assert.deepStrictEqual(clicked, ['+ Add', 'Next', 'Cancel']);
});

test('pageSetAiLabel opens Show more, switches it on, and leaves a popup for the seller', async () => {
  let open = false;
  let popup = false;
  const input = { checked: false, click() { input.checked = true; } };
  const label = { children: [], textContent: 'AI-generated content', querySelector: () => input, parentElement: null };
  const more = { children: [], innerText: 'Show more', click() { open = true; } };
  sandbox.setTimeout = (fn) => setTimeout(fn, 0);
  sandbox.document = {
    querySelector: () => (popup ? {} : null),
    querySelectorAll: (css) => (css === 'span,div' ? (open ? [label] : []) : [more]),
  };
  assert.strictEqual((await W.pageSetAiLabel()).state, 'READY');
  assert.ok(open && input.checked);
  assert.strictEqual((await W.pageSetAiLabel()).state, 'READY');
  input.checked = false;
  popup = true;
  assert.strictEqual((await W.pageSetAiLabel()).state, 'POPUP');
});

test('pageReadVideoCover reads the cover and caption, and reports a check, a missing video and a slow page', async () => {
  const data = (detail) => ({ textContent: JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': detail } }) });
  let el = null;
  let captcha = false;
  let title = 'TikTok';
  sandbox.document = {
    querySelector: () => (captcha ? {} : null),
    getElementById: () => el,
    get title() { return title; },
  };
  const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
  let fetched = 0;
  sandbox.fetch = async () => { fetched++; return { ok: true, arrayBuffer: async () => bytes.buffer }; };
  sandbox.btoa = (s) => Buffer.from(s, 'latin1').toString('base64');

  assert.strictEqual((await W.pageReadVideoCover(1000)).state, 'WAIT');
  title = 'www.tiktok.com';
  assert.strictEqual((await W.pageReadVideoCover(1000)).state, 'LIMITED');
  captcha = true;
  assert.strictEqual((await W.pageReadVideoCover(1000)).state, 'VERIFY');
  captcha = false;
  el = data({ statusCode: 10204 });
  assert.strictEqual((await W.pageReadVideoCover(1000)).state, 'NOT_FOUND');
  el = data({ itemInfo: { itemStruct: { desc: 'x', video: {} } } });
  assert.strictEqual((await W.pageReadVideoCover(1000)).state, 'NO_FILE');
  assert.strictEqual(fetched, 0);
  el = data({ itemInfo: { itemStruct: { desc: 'Baju cantik', author: { uniqueId: 'mellurr' }, video: { cover: 'https://p16.tiktokcdn.com/c.jpg' } } } });
  const r = await W.pageReadVideoCover(1000);
  assert.strictEqual(r.state, 'READY');
  assert.strictEqual(r.title, 'Baju cantik');
  assert.strictEqual(r.username, 'mellurr');
  assert.strictEqual(r.base64, Buffer.from(bytes).toString('base64'));
  assert.strictEqual((await W.pageReadVideoCover(2)).state, 'TOO_LARGE');
});

test('problemOf explains each state that stops a read, and nothing for READY', () => {
  for (const s of ['VERIFY', 'LIMITED', 'WAIT', 'NOT_FOUND', 'NO_ADDRESS', 'NO_FILE', 'TOO_LARGE', 'NO_AFFILIATE']) assert.ok(W.problemOf(s));
  assert.strictEqual(W.problemOf('READY'), null);
});

/**
 * Does a report that finished downloading actually reach the run folder?
 *
 * The folder this extension asks for is only ever a SUGGESTION. Chrome asks
 * every extension holding the downloads permission where a file should go and
 * gives the last word to the most recently installed one that answers, so
 * "the download completed" and "the download completed where we put it" are
 * two different facts — and only the first was ever checked.
 *
 * The onCreated backstop marks a download captured the moment a Shopee download
 * starts, whether or not our folder was applied, and confirmDownload() read
 * that as proof and ticked the report. The 20 Aug 2026 run reported 9/10 with
 * every file sitting loose in Downloads under Shopee's own names, which is
 * exactly what that looks like from the outside.
 *
 * Run:  node tools/test-placement.js
 */
'use strict';

const { bootWorker, settle, reporter } = require('./boot-worker.js');

const report = reporter('Placement — a finished download is not a placed download');
const check = report.check;

const RUN = { folder: '2026-08-18', runFolder: 'run-1' };
const IN_FOLDER =
  'C:\\Users\\seller\\Downloads\\Shopee daily report\\2026-08-18\\run-1\\report.xlsx';
const LOOSE = 'C:\\Users\\seller\\Downloads\\report.xlsx';

/**
 * A worker mid-run, with one page-started download already captured.
 *
 * `landedAt` is where Chrome says that download ended up; `rescue` is what the
 * content script answers when asked to save its own copy.
 */
function midRun({ landedAt, rescue, captured = true } = {}) {
  const sent = [];

  const boot = bootWorker({
    downloads: {
      download: () => Promise.resolve(9),
      search: ({ id }) =>
        Promise.resolve([
          {
            id: id ?? 7,
            state: 'complete',
            exists: true,
            startTime: new Date().toISOString(),
            filename: landedAt,
          },
        ]),
    },
    tabs: {
      sendMessage: (tabId, msg) => {
        sent.push({ tabId, msg });
        return Promise.resolve(rescue);
      },
    },
  });

  const state = boot.evaluate('state');
  state.running = true;
  state.folder = RUN.folder;
  state.runFolder = RUN.runFolder;
  state.startedAt = Date.now();
  state.watch = {
    armed: true,
    capturedId: captured ? 7 : null,
    capturedName: 'report.xlsx',
  };

  return { ...boot, state, sent };
}

const browserResult = { via: 'browser', filename: 'report.xlsx' };
const ctx = { tabId: 3, params: { fallbackBase: 'report' } };

async function main() {
  // 1. The happy path must stay happy: a file in the run folder is simply done,
  //    with no second copy fetched and no second export asked of Shopee.
  {
    const { evaluate, sent } = midRun({ landedAt: IN_FOLDER });
    await settle(20);
    const out = await evaluate('confirmDownload')(browserResult, ctx);

    check(
      'a file inside the run folder is accepted as it stands',
      out.name === 'report.xlsx' && !out.strayPath && sent.length === 0,
      sent.length
        ? `asked the page for a second copy (${sent[0].msg.type}) when the first was already in place`
        : `got ${JSON.stringify(out)}`
    );
  }

  // 2. THE REGRESSION. Chrome completed the download in plain Downloads, which
  //    used to tick the report green.
  {
    const { evaluate, sent } = midRun({
      landedAt: LOOSE,
      rescue: { ok: true, filename: 'report.xlsx', via: 'blob' },
    });
    await settle(20);
    const out = await evaluate('confirmDownload')(browserResult, ctx);

    check(
      'a file left loose in Downloads is fetched again into the folder',
      out.name === 'report.xlsx' &&
        out.strayPath === LOOSE &&
        sent.length === 1 &&
        sent[0].msg.type === 'rescueExport',
      sent.length === 0
        ? 'no second copy was fetched — the report would tick green with the file in plain Downloads'
        : `sent ${sent[0].msg.type}, got ${JSON.stringify(out)}`
    );
  }

  // 3. The stray keeps Shopee's own name, and that name is the best one to save
  //    our copy under — better than anything we could reconstruct.
  {
    const { evaluate, sent } = midRun({
      landedAt: 'C:\\Users\\seller\\Downloads\\parentskudetail.20260819_20260819.xlsx',
      rescue: { ok: true, filename: 'parentskudetail.20260819_20260819.xlsx', via: 'blob' },
    });
    await settle(20);
    await evaluate('confirmDownload')(
      { via: 'browser', filename: 'parentskudetail.20260819_20260819.xlsx' },
      ctx
    );

    const asked = sent[0] && sent[0].msg.params;
    check(
      "the rescue is told the stray's own name to save under",
      asked && asked.preferredName === 'parentskudetail.20260819_20260819.xlsx',
      asked ? `asked for ${JSON.stringify(asked.preferredName)}` : 'nothing was sent'
    );
  }

  // 4. Nothing left to fetch. Failing is the honest answer — the file is not
  //    where the run says it is, and pretending otherwise is what this whole
  //    harness exists to stop.
  {
    const { evaluate } = midRun({
      landedAt: LOOSE,
      rescue: { ok: false, error: 'nothing captured' },
    });
    await settle(20);

    let message = '';
    try {
      await evaluate('confirmDownload')(browserResult, ctx);
    } catch (err) {
      message = (err && err.message) || String(err);
    }

    check(
      'a stray that cannot be fetched again fails, and says where the file went',
      message.includes(LOOSE) && message.includes('run-1'),
      message || 'no error thrown — the report would be ticked for a file that is not there'
    );
  }

  // 5. A folder name is a folder, not a substring. "run-1" must not be
  //    satisfied by a sibling directory called "run-1-old".
  {
    const { evaluate, sent } = midRun({
      landedAt: 'C:\\Users\\seller\\Downloads\\Shopee daily report\\2026-08-18\\run-1-old\\report.xlsx',
      rescue: { ok: true, filename: 'report.xlsx', via: 'blob' },
    });
    await settle(20);
    const out = await evaluate('confirmDownload')(browserResult, ctx);

    check(
      'a folder whose name merely contains the run folder does not count',
      sent.length === 1 && out.strayPath.includes('run-1-old'),
      sent.length ? `got ${JSON.stringify(out)}` : 'accepted a file in the wrong folder'
    );
  }

  // 6. Our OWN download — the copy we write with the path attached — is not
  //    exempt. If that one is overridden too, the run must say so rather than
  //    report a file it cannot find.
  {
    const { evaluate } = midRun({ landedAt: LOOSE });
    await settle(20);
    const out = await evaluate('saveFile')(
      'data:application/vnd.ms-excel;base64,AAAA',
      'report.xlsx'
    );

    check(
      'a file we saved ourselves is failed when it lands outside the folder',
      out.ok === false && String(out.error).includes(LOOSE),
      out.ok ? 'reported success for a file in plain Downloads' : out.error
    );
  }

  // 7. …and still succeeds when it lands where it was told to.
  {
    const { evaluate } = midRun({ landedAt: IN_FOLDER });
    await settle(20);
    const out = await evaluate('saveFile')(
      'data:application/vnd.ms-excel;base64,AAAA',
      'report.xlsx'
    );

    check(
      'a file we saved ourselves into the folder still succeeds',
      out.ok === true && out.filename === 'report.xlsx',
      JSON.stringify(out)
    );
  }

  // 8. Nothing captured at all: the pre-existing search-the-folder path, which
  //    must keep working and must keep refusing files outside the folder.
  {
    const { evaluate } = midRun({ landedAt: LOOSE, captured: false });
    await settle(20);

    let message = '';
    try {
      await evaluate('confirmDownload')(browserResult, ctx);
    } catch (err) {
      message = (err && err.message) || String(err);
    }

    check(
      'no capture and nothing in the folder is still a failure',
      message.includes('never arrived') && message.includes('Shopee daily report/2026-08-18/run-1'),
      message || 'no error thrown'
    );
  }

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

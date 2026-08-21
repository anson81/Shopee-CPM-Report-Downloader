/**
 * Does this extension keep its hands off other extensions' downloads?
 *
 * Chrome's onDeterminingFilename is browser-wide: every extension holding the
 * downloads permission is asked about every download, with no notion of which
 * site it came from. Answering — even with a blank suggest() — counts as an
 * opinion, and Chrome hands the final say to the most recently installed
 * extension that answered. So a blank answer about someone else's file wipes
 * that file's name and folder, and it lands in plain Downloads as
 * "download.zip", "download (1).zip", and so on.
 *
 * That is what broke the SiteGiant twin. The v1.14.5 fix covered the warm
 * worker but not the cold one, which is the case that matters: this worker is
 * asleep precisely while the other extension is running.
 *
 * Run:  node tools/test-filename-listener.js
 */
'use strict';

const { bootWorker, ask, settle, reporter, OWN_ID, TWIN_ID } = require('./boot-worker.js');

const report = reporter('onDeterminingFilename — hands off other extensions');
const check = report.check;

const twinDownload = {
  id: 41,
  // The twin saves its zip from an in-memory data: URL, which carries no name
  // of its own. That is why Chrome's fallback name is "download.zip".
  url: 'data:application/zip;base64,UEsDBAoAAAAAAA==',
  finalUrl: 'data:application/zip;base64,UEsDBAoAAAAAAA==',
  filename: 'download.zip',
  byExtensionId: TWIN_ID,
  byExtensionName: 'SiteGiant Downloader',
};

async function main() {

  // 1. Cold worker, twin's download. THE REGRESSION: this worker is asleep
  //    exactly when the twin is running, so this is the everyday case, not an
  //    edge case.
  {
    const { listener } = bootWorker({ sessionDelayMs: 250 });
    const { returned, calls } = ask(listener, twinDownload);
    await settle(600); // long enough for any late answer to arrive
    check(
      'cold worker says nothing about the twin\'s download',
      calls.length === 0 && returned !== true,
      calls.length
        ? `answered ${JSON.stringify(calls[0])} — a blank answer still counts, and wipes the twin's name`
        : returned === true
          ? 'returned true, which commits Chrome to waiting for an answer'
          : ''
    );
  }

  // 2. Warm worker, twin's download, no run of our own in progress.
  {
    const { listener } = bootWorker({ sessionDelayMs: 0 });
    await settle(20);
    const { returned, calls } = ask(listener, twinDownload);
    await settle(100);
    check(
      'warm worker says nothing about the twin\'s download',
      calls.length === 0 && returned !== true,
      calls.length ? `answered ${JSON.stringify(calls[0])}` : ''
    );
  }

  // 3. Warm worker, twin's download, WHILE we are mid-run. The tempting shape
  //    of this bug: our own run makes us feel entitled to answer.
  {
    const { listener } = bootWorker({
      sessionDelayMs: 0,
      session: {
        runtimeState: {
          running: true,
          folder: '2026-08-18',
          runFolder: 'run-1',
          expectedName: '',
          pendingSavePath: 'Shopee daily report/2026-08-18/run-1/ours.xlsx',
          watch: { armed: false, capturedId: null, capturedName: '' },
        },
      },
    });
    await settle(20);
    const { returned, calls } = ask(listener, twinDownload);
    await settle(100);
    check(
      'mid-run, still says nothing about the twin\'s download',
      calls.length === 0 && returned !== true,
      calls.length ? `answered ${JSON.stringify(calls[0])} — that is the twin's file, not ours` : ''
    );
  }

  // 4. Our own page-started download must still be placed. The guard is
  //    worthless if it silences us about our own files.
  {
    const { listener } = bootWorker({
      sessionDelayMs: 0,
      session: {
        runtimeState: {
          running: true,
          folder: '2026-08-18',
          runFolder: 'run-1',
          expectedName: '',
          pendingSavePath: '',
          watch: { armed: false, capturedId: null, capturedName: '' },
        },
      },
    });
    await settle(20);
    const { calls } = ask(listener, {
      id: 7,
      url: 'https://seller.shopee.com.my/api/v3/export/report.xlsx',
      finalUrl: 'https://seller.shopee.com.my/api/v3/export/report.xlsx',
      filename: 'report.xlsx',
      // Started by Shopee's own page, so Chrome reports no extension at all.
      byExtensionId: undefined,
    });
    await settle(100);
    const named = calls[0] && calls[0].filename;
    check(
      'our own Shopee download still gets its folder and name',
      named === 'Shopee daily report/2026-08-18/run-1/report.xlsx',
      named ? `got ${named}` : 'no suggestion made — the file would land loose in Downloads'
    );
  }

  // 5. Our own data: save (the zip/xlsx we hold in memory) must still be
  //    placed. This one carries OUR extension id, which the guard must allow.
  {
    const ourPath = 'Shopee daily report/2026-08-18/run-1/ours.xlsx';
    const { listener } = bootWorker({
      sessionDelayMs: 0,
      session: {
        runtimeState: {
          running: true,
          folder: '2026-08-18',
          runFolder: 'run-1',
          expectedName: '',
          pendingSavePath: ourPath,
          watch: { armed: false, capturedId: null, capturedName: '' },
        },
      },
    });
    await settle(20);
    const { calls } = ask(listener, {
      id: 8,
      url: 'data:application/vnd.ms-excel;base64,AAAA',
      finalUrl: 'data:application/vnd.ms-excel;base64,AAAA',
      filename: 'download.xlsx',
      byExtensionId: OWN_ID,
    });
    await settle(100);
    const named = calls[0] && calls[0].filename;
    check(
      'our own saved file still gets its folder and name',
      named === ourPath,
      named ? `got ${named}` : 'no suggestion made — our own file would land loose in Downloads'
    );
  }

  // 6. Abstaining is not the same as not looking.
  //
  //    The listener sees the id of every extension that starts a download, and
  //    that id is the fact the August 2026 hunt lacked. Recording it must not
  //    change the abstention, so both are asserted on the same run: nothing
  //    said, and the sighting kept.
  {
    const { listener, evaluate } = bootWorker({ sessionDelayMs: 0 });
    await settle(20);

    const { returned, calls } = ask(listener, twinDownload);
    ask(listener, twinDownload);
    await settle(100);

    check(
      'recording a sighting does not make us answer',
      calls.length === 0 && returned !== true,
      calls.length ? `answered ${JSON.stringify(calls[0])}` : ''
    );

    const seen = evaluate('Array.from(otherDownloaders.values())');
    const twin = seen.find((s) => s.id === TWIN_ID);

    check(
      'the twin is recorded by id',
      !!twin,
      seen.length ? JSON.stringify(seen) : 'nothing recorded — a diagnostics report would say "none seen"'
    );

    check(
      'repeat downloads are counted, not duplicated',
      seen.length === 1 && twin && twin.count === 2,
      JSON.stringify(seen)
    );
  }

  // 7. Our own downloads are ours; recording them as interference would point
  //    the next investigation straight at ourselves.
  {
    const { listener, evaluate } = bootWorker({ sessionDelayMs: 0 });
    await settle(20);
    ask(listener, {
      id: 88,
      url: 'data:application/vnd.ms-excel;base64,AAAA',
      finalUrl: 'data:application/vnd.ms-excel;base64,AAAA',
      filename: 'download.xlsx',
      byExtensionId: OWN_ID,
    });
    await settle(100);
    check(
      'our own download is not recorded as another extension',
      evaluate('otherDownloaders.size') === 0,
      JSON.stringify(evaluate('Array.from(otherDownloaders.values())'))
    );
  }

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

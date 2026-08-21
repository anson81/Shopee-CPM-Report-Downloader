# Shopee CPM Report Downloader — working notes

Chrome MV3 extension. Downloads the 7 daily Shopee Seller Centre reports into
dated folders. Plain JavaScript, no build step, no dependencies.

## The rule that has broken twice

`chrome.downloads.onDeterminingFilename` is **browser-wide**. Chrome asks every
extension holding the `downloads` permission about every download in the
browser — it does not scope the question by site. "We only deal with Shopee" is
not something Chrome knows; it is something this listener has to enforce for
itself, on the first line.

**`suggest()` with no arguments is not silence.** Chrome's docs: a listener may
call it "in order to allow the download to use `downloadItem.filename`" — which
is Chrome's own guess from the URL. Answering blank about a sibling's download
throws away the path that sibling asked for and requests Chrome's guess instead:
`download.zip`, then `download (1).zip`, loose in Downloads with no folder.

Only a plain `return`, without touching `suggest()`, is a true abstention.

So:

- **First line of the listener:**
  `if (item.byExtensionId && item.byExtensionId !== chrome.runtime.id) return;`
  Note the shape. Our own saves carry our id; **downloads started by Shopee's own
  page carry no id at all**, and those must fall through — this listener is the
  only thing that can place them. `byExtensionId` arrives with the event, so
  this is correct even on a worker woken by that very download.
- **Answer synchronously whenever possible.** An answer that arrives after
  Chrome has settled on a filename is the same as no answer. The 10 Aug 2026 run
  put every file in plain Downloads while the listener matched each one — it had
  awaited hydration first. The keep-alive exists so the worker is awake during a
  run and everything needed is already in memory.
- The one branch that may still `return true` is a worker woken by this very
  event with nothing in memory. It is a gamble, deliberately taken, and the top
  guard means it can only ever cost a Shopee page download — never a sibling's.

Sibling extensions on the same machine — SiteGiant Downloader, Shopee Review
Media Extractor — obey the same rule from their side. Through August 2026 these
two silenced each other, each release making one of them the most recently
installed and therefore the winner, which is why the same code failed on one PC
and not another. Never explain that away as the machine.

`tools/test-filename-listener.js` boots `background.js` against a stub `chrome`
and fires the listener; a delayed `storage.session.get` reproduces a cold
worker. Run it before and after touching this code.

## Do not trust the download id alone

Ads reports produce **two** downloads: Shopee's page starts its own, which Chrome
names `download.csv`, and this extension saves the captured blob under the real
name. Verifying whichever id happened to be held reported a good run as 9/10.
Since v1.15.0 the check looks on disk for where the file actually landed, and
fetches it again if it is not there. `tools/test-placement.js` covers this.

## Releasing

There is no Chrome Web Store here. Every machine installs this extension by
hand from the GitHub branch and updates itself from that same branch:
`checkUpdate()` fetches `update.json`, compares its `version` against the
running manifest, and if it is higher the Options page downloads every path in
`update.json`'s `files` list and writes them into the extension folder.

Three things follow, and all three have been got wrong:

1. **Bump `manifest.json` AND `update.json` together.** `checkUpdate()` reads
   only `update.json`. Leave it behind and no machine is ever offered the fix —
   silently. Nothing errors; the old code just keeps running.
2. **Add every new shipped file to `update.json`'s `files`.** The installer
   downloads exactly that list. A file left out is never delivered, so machines
   end up running new code beside old.
3. **Push.** The updater reads `raw.githubusercontent.com` on the branch. A
   commit sitting on one PC does not exist as far as every other PC is
   concerned. A finished fix once sat unpushed for three days while machines
   ran the bug it fixed.

Write a plain-English line into `update.json`'s `notes` — it is what the user
sees in the update prompt. Describe what they will notice, not what changed in
the code.

## Tests

    node tools/test-<name>.js

Every one of them runs in CI on every push (`.github/workflows/tests.yml`), and
each was written after a bug that had already shipped. Run them before pushing
anyway — CI tells you after the fact, and the machines poll this branch.

If you are about to change how downloads are named or where files land, run the
filename tests first, and again after. That is the code with the worst history
in this repo.

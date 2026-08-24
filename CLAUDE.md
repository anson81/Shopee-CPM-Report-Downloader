# Shopee CPM Report Downloader — working notes

Chrome MV3 extension. Downloads the 7 daily Shopee Seller Centre reports into
dated folders. Plain JavaScript, no build step, no dependencies.

## There is no filename listener, and there must not be one

Reports are written straight into a folder the seller picks, through a
`FileSystemDirectoryHandle` held by `offscreen/offscreen.js`. Chrome's download
machinery is not involved, so no other extension is consulted about the name.

**Do not add `chrome.downloads.onDeterminingFilename` back.** There was one for
months and it is the code with the worst history in this repo. It lost anyway.
On 23 Aug 2026 it answered Chrome synchronously, on a warm worker, with the
correct path — its own log records `placed at Shopee daily report/…` for five
consecutive reports — and Chrome filed every one of them in plain Downloads
under a name of its own. The retry lost too: `downloads.download()` was called
with the full path attached and produced `download (4).csv`.

That listener is browser-wide, and Chrome gives the final word to the most
recently installed extension that answers. The winner therefore changes
whenever anything else on the machine updates itself, which is why the same
code failed on one PC and not another, and why each fix appeared to work for a
week. Through August 2026 this extension and the SiteGiant twin silenced each
other in turn. Never explain that away as the machine.

The listener also cost other tools their downloads: its last log before removal
caught it answering late on two zips belonging to a neighbouring extension.

What is left is `downloads.onCreated`, and it only watches. A Shopee download
appearing during a run is a **stray** — Chrome's own copy of a report we are
also saving properly. It is reported and never deleted: removing a seller's
files is not this extension's business, and a wrong deletion cannot be undone.

`onCreated` also still feeds `noteOtherDownloader()`, so the diagnostics can go
on saying which other extensions are starting downloads. That is a fact worth
keeping — it is the one the August 2026 filename hunt lacked.

## No fallback to the Downloads folder

If no folder is chosen, or its permission has lapsed, `runExports()` refuses to
start and says so. It does not fall back.

That is deliberate and it was Anson's call. A fallback would restore the exact
failure this replaced — a file landing quietly somewhere he did not ask for —
and it would do it on the days things are already going wrong, which are the
days he is least likely to notice. A run that refuses is recoverable in one
click; a file in the wrong place is not noticed for a week.

The consequence: `via: 'browser'` is now a **failure**. It means the content
script never got the bytes and Chrome took the file instead. Say so; never tick
a report green because a file exists somewhere.

## The Real Time pin lasts one run

Pinning Real Time to an earlier day files the whole run under that day. The pin
is cleared when the run ends, whatever the outcome.

It used to persist. Set on 23 Aug 2026 to catch up on Saturday, it was still
set on Sunday, and Sunday's run went into Saturday's folder while the popup
warned in small red text that nobody read.

## When someone reports a problem

**Ask for the diagnostics paste before guessing.** Options -> Copy diagnostics
puts it on their clipboard; they paste it into the chat. It is one click and it
ends most of the guessing this project has done historically.

It carries the version, the browser, whether a folder is set, the last few runs
with every per-report error, and - on the two extensions that have a filename
listener - the ids of any other extensions that have been handling downloads.
That last section is why this exists: it is the fact the August 2026 filename
hunt lacked, and the hunt took a fortnight and blamed two innocent parties.

Read it carefully, in particular:

- **"none seen" and "not collected" are different claims.** The first is
  evidence that nothing else touched a download on that machine. The second
  means nobody looked - the Review Media Extractor registers no listener, by
  design, so it always reports the second. Treating one as the other sends you
  looking in the wrong place.
- **The home directory name is masked to `<you>`; the folders below it are
  not.** That is deliberate. The structure is where the answer usually is.
- **Nothing is sent anywhere.** The transport is the user's clipboard, and the
  page shows them the text before they copy it. Do not quietly turn this into
  an upload: these reports carry shop names and order counts, and that decision
  is Anson's to make, not one to arrive at by default.

`lib/diagnostics.js` is shared across all three extensions and is pure - it
takes its clock as an argument - so `tools/test-diagnostics.js` can check the
whole report without a browser. That test also checks the button is really
wired: a button that does nothing looks fine and fails silently, on a page
someone only opens when they are already in trouble.

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

If you are about to change where files land, run `tools/test-folder-writer.js`
first and again after. `tools/test-filename-listener.js`, `tools/test-placement.js`
and `tools/boot-worker.js` were deleted in v1.19.0 along with the code they
covered — a test left passing against nothing is worse than no test.

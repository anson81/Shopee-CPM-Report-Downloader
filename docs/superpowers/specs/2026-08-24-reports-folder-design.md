# Write reports into a folder the seller chooses

Design, 24 Aug 2026.

## The problem

On 23 Aug 2026 a run on the Linux machine put all ten reports in plain
`~/Downloads` under Chrome's own names — `download (12).xlsx`,
`download (5).csv`, `download (1).txt`. The same machine had run 10/10 into the
right folder the day before.

The extension's own decision log settles what happened. For reports 6 to 10 it
answered Chrome synchronously, on a warm worker, with the exact right path:

    placed at Shopee daily report/22082026-Saturday/22082026-Saturday-1418/Order.all.20260723_20260821.xlsx

Every one of those files landed in `~/Downloads` anyway. The rescue lost too:
`downloads.download()` was called with the full path attached and Chrome
produced `download (4).csv`.

So this is not the extension failing to ask. It asked correctly and was
overruled. `chrome.downloads.onDeterminingFilename` is browser-wide and Chrome
settles ties by install recency — the last extension installed whose listener
passes a suggestion wins. That contest cannot be won reliably, because the
winner changes whenever any unrelated extension updates itself.

v1.18.0 is not implicated. Every line it changed only adds a check for "is the
folder known?", and the log proves the folder was known.

The SiteGiant twin reached this same conclusion in August 2026 and stopped
entering the contest. `sitegiant-downloader/offscreen/offscreen.js` states it
directly: a file written through a `FileSystemDirectoryHandle` never touches
Chrome's download naming, and no other extension is consulted.

This extension has never had that option. Its diagnostics say so: *"Reports
folder chosen: not offered by this extension."*

## What we are building

The seller picks a folder once per machine. The extension writes report files
into it directly. Chrome's download machinery is not involved.

Two consequences, both requested:

1. Files appear in a chosen folder rather than Downloads.
2. Shopee's original filename is what lands, because nothing else is asked.

## Decisions

Settled with Anson on 24 Aug 2026:

| Question | Decision |
|---|---|
| Folder root | Chosen by the user per machine, via the system picker. Never hard-coded. |
| Layout inside it | `<chosen>/Shopee daily report/23082026-Sunday-1418/` — one level, date and time together. |
| No folder chosen, or permission lapsed | Refuse to start the run. No falling back to Downloads. |
| A single report's bytes cannot be captured | That report fails, named, with a reason. The other nine still complete. |
| Pinned Real Time date | Clears itself after one run. |

The day-folder level (`22082026-Saturday/22082026-Saturday-1418/`) is dropped.
Run folders go straight under `Shopee daily report`.

## Architecture

### New: `offscreen/offscreen.js` + `offscreen/offscreen.html`

Holds the directory handle and writes bytes. Ported from the SiteGiant twin,
which has been doing this job in production.

The File System Access API needs a document, and an MV3 service worker is not
one — that is the whole reason this file exists.

Contract, by message:

    { target: 'offscreen-writer', segments: string[], filename: string, base64: string }
      -> { ok: true, path }
      -> { ok: false, reason: 'no-folder' | 'permission' | 'error', error? }

`segments` are folder names walked and created under the chosen root. Empty
segments are dropped: `getDirectoryHandle('')` throws.

`writable.close()` is what commits the file. Skipping it on a failed write
leaves a zero-byte file that looks like a success.

### Storage

IndexedDB `shopee-dl-updater`, store `handles`, key **`outputFolder`**.

Deliberately not `extensionFolder`, the key the self-updater already uses. The
two are different grants and must be revocable independently.

### `background/background.js`

- `ensureOffscreen()` — `getContexts()` first, because `createDocument()` throws
  when one already exists and there is no get-or-create.
- `saveToChosenFolder(base64, filename)` — returns the written path, or a reason.
- `saveFile()` routes through it. The `downloads.download()` branch is removed,
  not kept as a fallback.
- `runExports()` checks the folder before starting. Missing or lapsed → returns
  an error naming Settings, and no tab is opened.
- **`chrome.downloads.onDeterminingFilename` is no longer registered.** With
  files written directly it has no job, and the log shows it actively harming a
  neighbour — it answered late on two `cpm-generator` zips on 23 Aug. An
  extension that cannot place its own files should not be arbitrating anyone
  else's.
- `chrome.downloads.onCreated` stays, downgraded to reporting only: it notices a
  stray copy Chrome wrote and records it against the report.

`ROOT_FOLDER` stays `Shopee daily report`. `targetDir()` becomes
`folderSegments()` returning `[ROOT_FOLDER, runFolder]`.

### Getting the bytes

The interceptor already captures three routes, and they are tried in order:

1. `URL.createObjectURL` — the report's bytes directly.
2. An `<a download>` click — carries Shopee's original filename.
3. `get_download_url` / `direct_download` API responses — a URL fetched with
   cookies from the content script.

`triggerAndCapture()` currently returns `via: 'browser'` the moment Chrome's own
download is seen, and never looks at the captures. That order inverts: captured
bytes are now what we want, and a browser download is only a signal that the
report is ready.

A report with none of the three fails with `ERR.NO_BLOB`, named in the popup.

### Strays

Where Shopee's page starts its own download, Chrome may still write a copy to
Downloads before we write ours. The seller gets the correct file in their folder
plus a stray.

Nothing is auto-deleted. Deleting a seller's files is not this extension's
business, and a wrong deletion is unrecoverable. The run reports which reports
left a stray. If it proves to be an everyday occurrence, a cleanup button the
seller presses themselves is a separate change.

### `options/options.js` + `options.html`

A **Reports folder** section, above Updates:

- *Choose folder…* → `showDirectoryPicker({ mode: 'readwrite' })`, stored at
  `outputFolder`.
- Shows the chosen folder's name, or "None chosen — reports cannot be saved".
- *Forget it* → deletes the key.
- Re-grants a lapsed permission. `requestPermission()` needs a user gesture, so
  the Options page is the only place it can happen; the offscreen writer can
  only ever check.

### `popup/popup.js` + `popup.html`

- A **Settings** button, opening the Options page.
- When no folder is chosen: a banner saying so, and the run buttons disabled.
  A run that cannot save must not start.

### `lib/diagnostics.js`

No change to the library. The background now reports a real `folder.chosen`
instead of `null`, so the line stops reading "not offered by this extension".

### The pinned date

`runExports()` clears `realtimeDate` from storage once the run finishes,
whatever the outcome. `getRealtimeDate()` keeps its guard against a date that is
today or later.

## Error handling

| Situation | Behaviour |
|---|---|
| No folder chosen | Run refuses to start. Popup points at Settings. |
| Permission lapsed | Same, with wording that says re-grant rather than choose. |
| Offscreen document fails to open | Run refuses to start, reason recorded. |
| One report yields no bytes | That report errors, named. The run continues. |
| Write throws mid-file | `close()` still runs; the report errors with the message. |
| Chrome wrote a stray | Recorded against the report. Nothing deleted. |

## Testing

`node tools/test-<name>.js`, all five existing suites must still pass, and CI
runs every one on every push.

New — `tools/test-folder-writer.js`:

- segments become nested folders, created in order
- empty segments dropped rather than passed to `getDirectoryHandle('')`
- missing handle → `no-folder`, and nothing written
- `queryPermission` not granted → `permission`, and nothing written
- the filename written is exactly the filename asked for, untouched
- `close()` is called even when `write()` throws

New — `tools/test-realtime-pin.js`:

- a pinned date is cleared once the run finishes
- cleared on a failed run too
- a date of today or later is still treated as unset

`tools/test-release-consistency.js` already fails a release whose
`update.json` omits a shipped file. The two new `offscreen/` files must be
added to the `files` list or no machine ever receives them.

Removing the filename listener makes `tools/test-filename-listener.js` obsolete.
It is deleted with the code it covers, not left passing against nothing.

## Releasing

`manifest.json` → 1.19.0, `update.json` → 1.19.0, both together. Add
`offscreen/offscreen.html` and `offscreen/offscreen.js` to `files`. Write the
`notes` in plain English: what the seller will notice, not what changed in the
code. Then push — the machines poll the branch, and an unpushed fix does not
exist as far as they are concerned.

`manifest.json` gains the `offscreen` permission. `downloads` stays: the run
still reads Chrome's download record to notice strays.

## Out of scope

- Deleting stray files.
- Any change to which reports are fetched, or their date ranges.
- The `download.txt` orders log keeps its current rule — written only when the
  Orders reports failed — and now goes into the chosen folder like everything
  else.

## Risk

The one that could sink this: a report whose bytes none of the three capture
routes see. Today's fallback hides that, because Chrome downloads it anyway.
With the fallback gone, such a report fails outright.

This is worth accepting rather than designing around. A named failure is
recoverable; a file silently landing somewhere else is what this whole change
exists to end. The first real run tells us whether any report has the problem,
and the answer is per-report and visible.

# Shopee Report Downloader

Manifest V3 Chrome extension. Downloads the 7 daily reports from Shopee Seller
Center Malaysia into `Downloads/Shopee daily report/DDMMYYYY-DayOfWeek/`,
keeping Shopee's original filenames.

On-demand only — no scheduling, no renaming.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Pin the extension so the icon is visible.

Requires Chrome 111+ (the blob interceptor needs `world: "MAIN"` content
scripts).

## Use

1. Log in to `seller.shopee.com.my` in the same Chrome profile.
2. Click the extension icon.
3. Pick a mode, or a single numbered button for one report.

| Mode | How it works | Roughly |
|------|--------------|---------|
| 🐌 **Slow n Steady** | One tab, one export at a time, 65s between each | ~12 min |
| 🏎 **Fast n Furious** | Opens all 7 pages at once so their loads overlap, then exports tab by tab with a 3s gap | ~4 min |

Both produce identical files. Steady is the conservative path: if Shopee ever
does start rate-limiting, it is the one that will ride it out. Furious relies
on the observation that exports for *different* periods do not contend — verified
by hand, not documented by Shopee, so keep Steady as the fallback.

Only the page **loading** is parallel in Furious mode. Each tab is still
brought to the front and driven one at a time, because Chrome throttles timers
in background tabs and Shopee's SPA will not keep up otherwise.

Tabs are closed as each export finishes. On failure they are left open so you
can see where Shopee stopped cooperating.

Individual numbered buttons always use the Steady path — a single report has
nothing to parallelise.

**Keep the window visible while it runs.** Chrome throttles timers in minimised
or fully occluded windows, and Shopee's SPA will not finish rendering.

A full run takes roughly 5–12 minutes. The popup can be closed; progress lives
in the service worker and is mirrored to `chrome.storage.local`, so reopening
the popup shows the current state. The toolbar badge shows the final count.

## The 7 exports

| # | Report | Page | Notes |
|---|--------|------|-------|
| 1 | Real Time | Business Insights → Product Performance | default period |
| 2 | Yesterday | same | period select |
| 3 | By Day (3 days ago) | same | date = today − 2 |
| 4 | Past 7 Days | same | period select |
| 5 | By Week (last week) | same | calendar hover flow |
| 6 | Ads Overall | Shopee Ads → Product Ads | Latest Reports → Download |
| 7 | Ads GMV MAX | same | confirm modal → API polling |

## How files are captured

Shopee delivers reports three different ways, so the extension tries three, in
order, per export:

1. **Shopee's own browser download.** `downloads.onDeterminingFilename`
   redirects it into the dated subfolder. Shopee picks the filename; we only
   prepend the folder. This is the common path and produces exactly one file.
2. **`get_download_url` API.** The response is fetched with the session
   cookies and saved. Used by Ads GMV MAX, which has no download panel at all.
3. **Intercepted blob.** `URL.createObjectURL` is hooked in the page's own
   JavaScript context (`content/interceptor.js`, MAIN world, `document_start`)
   and the bytes are saved via a data URL. The original filename comes from the
   `download` attribute of the anchor Shopee clicks.

Whichever fires first wins, so a report is never saved twice. Files are written
with `conflictAction: "overwrite"` — re-running on the same day replaces that
day's file instead of creating `… (1).xlsx`, which would break the "never
rename" rule.

## Updates

The popup shows the running version and whether a newer one exists. Chrome only
auto-updates Web Store extensions, so this one checks a GitHub repo instead and
installs the update itself once you have granted it access to its own folder.

**One-time setup**

1. Create a **public** GitHub repo and push the contents of this folder to it.
2. Right-click the extension icon → **Options**.
3. Under *Update source*, enter the repo owner, name and branch, then **Save**.
4. Under *Extension folder*, click **Choose the extension folder…** and pick
   this folder — the one you selected with *Load unpacked*. Chrome asks for
   write permission once.

**Publishing a new version**

```powershell
.\tools\make-release.ps1 -Version 1.2.0 -Notes "What changed","And this"
git add -A; git commit -m "v1.2.0"; git push
```

`make-release.ps1` bumps `manifest.json` and regenerates `update.json` from
what is actually on disk, so the file list cannot drift out of sync.

**Installing**: the popup shows *Update available: v1.2.0* → **Update** opens
the options page → **Download & install update**. Every file is fetched and
validated before anything is written (a half-written folder will not load), then
`chrome.runtime.reload()` restarts the extension on the new version.

If you would rather not grant folder access, replace the files by hand and use
the same page to confirm the version afterwards.

## Layout

```
manifest.json
update.json                version + file list the updater reads
background/background.js   orchestration, navigation, disk writes, update check
content/interceptor.js     MAIN world: blob / anchor / API interception
content/content.js         ISOLATED world: all Shopee DOM interaction
popup/                     toolbar UI
options/                   update install + folder grant + update source
tools/                     make-release.ps1, inspect-shopee.js
icons/
```

The background worker knows nothing about Shopee's DOM; the content script
knows nothing about files. One export equals one page load equals one message.

## Notes for future maintenance

- **Timings are deliberate.** The 15s post-load wait, 5s tab wait and 2s period
  wait were measured against the real site. Shortening them is the first thing
  that will break.
- **By Day and By Week both go through the calendar**, never the period
  dropdown (that closes the picker) and never a text input. Typing a date into
  the first visible `input[type=text]` hits Shopee's **Search product** box,
  which filters the table to nothing and exports an empty sheet. Both open
  `.bi-date-input`, hover their shortcut, click `.eds-picker-header__prev`
  index **1** (index 0 is the year arrow), and click a
  `div.eds-date-table__cell` — Shopee does not use `<td>`.
- **The Latest Reports panel lists OLD reports.** "Is the word Download on the
  page" is true the moment the panel opens, against a stale row. After clicking
  Export the extension waits for a *new* row (a processing entry, or a change
  in the panel's text) before downloading, and scopes the Download click to the
  panel so it takes the newest entry.
- **Panel labels are not filenames.** A row reads
  `Shop GMV MAX-Detail-Data-29/07/2026-04/08/2026.csv` but the delivered file
  is `Shop+GMV+MAX-Detail-Data-29_07_2026-04_08_2026.csv` — slashes become
  underscores, spaces become plus signs. `normalizeShopeeName()` does that
  conversion; compare names only in normalised form.
- **GMV Max's `direct_download` endpoint returns a placeholder**
  `Content-Disposition` of `download.csv`. The real name comes from the list
  API's `file_name`, so that is preferred whenever the served name matches
  `GENERIC_NAME_RE`.
- **The export cooldown is narrower than it looks.** Shopee shows a "wait a
  minute" toast when the SAME report is re-exported quickly, but exports for
  different periods do not appear to contend — seven fired within a minute all
  succeeded. `COOLDOWN_MS` therefore holds two budgets: 65s for Steady, 3s for
  Furious. The toast is still detected and waited out either way, and as a last
  backstop a run fails an export if it produces a filename an earlier export
  already saved — that can only mean an older report was served.
- **Selectors are Shopee's, not ours.** `button.export` (BI) versus
  `div.eds-dropdown.export button` (Ads); `span:has-text("Download")` (BI)
  versus `button:has-text("Download")` (Ads). If Shopee reskins, these are what
  to re-check first. Text matching is done by an approximation of Playwright's
  `text=` engine in `queryText()`.
- **MV3 service worker lifetime.** The worker dies after ~30s idle, which would
  kill a 10-minute GMV Max poll. The content script pings every 10s while an
  export runs; each message resets the idle timer. Do not remove the heartbeat.

## Testing status

Verified locally:

- All date arithmetic (folder name, "3 days ago" = today − 2, the By Week
  Monday − 14 target, and the month-arrow count) against fixed clocks including
  Sunday, month boundaries and new year.
- Full 7-export control flow against a mock DOM: tab and period clicks, the By
  Week hover/arrow/cell sequence, the Ads dropdown and confirm modal, GMV Max
  API polling, blob capture and filename preservation.

Not verified: the real `seller.shopee.com.my` selectors and timings — that
needs a logged-in session. Work through the checklist in the build spec on the
live site before trusting an unattended run.

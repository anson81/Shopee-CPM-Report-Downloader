# 📥 Shopee Report Downloader

A Chrome extension that downloads all **10 daily reports** from Shopee Seller
Centre Malaysia with one click, instead of clicking through the site ten
times.

Files keep Shopee's own names and are sorted into dated folders:

```
Downloads/
  Shopee daily report/
    05082026-Wednesday/
      05082026-Wednesday-0823/      ← one folder per run
        parentskudetail.20260804_20260804.xlsx
        Shopee-Ads-Overall-Data-30_07_2026-05_08_2026.csv
        Order.all.20260706_20260804.xlsx
        Order.all.20260606_20260705.xlsx
        ...
```

---

## Install

**1. Download**

[⬇ Download the extension](https://github.com/anson81/Shopee-CPM-Report-Downloader/archive/refs/heads/main.zip)

**2. Unzip it, and keep the folder somewhere safe**

Documents is a good spot. **Not** Downloads — Chrome reads from this folder
every time you use the extension, so it must not be deleted or moved later.

**3. Add it to Chrome**

1. Type `chrome://extensions` in the address bar
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** (top left)
4. Choose the folder you unzipped

The orange icon appears in your toolbar. Pin it if you like.

> Chrome may show a popup saying *"Disable developer mode extensions"* when it
> starts. That is normal for extensions installed this way — just close it.

---

## Using it

1. Log in to [Shopee Seller Centre](https://seller.shopee.com.my) as you normally would
2. Click the orange icon
3. Click 🏎 **Fast n Furious** — about 6 minutes
4. **Leave the window open and don't touch it** while it runs
5. When it finishes, click **Open folder** to see your files

It opens one tab per report, asks Shopee for all ten at once, and collects them
as they finish. You can also click a single number (1–10) to fetch just that
one report.

**The two Orders reports take longer to arrive.** Shopee does not hand those
over on the spot — it builds them on its own servers and lists them under
**Export History** on the same page a minute or two later. Every report is
asked for first and collected afterwards, so that wait overlaps with the other
eight. If the last stretch of a run looks idle, that is what it is doing.

If one of them ever fails, the run folder will also hold a small
**`orders-log.txt`** recording what it did step by step, so the problem can be
explained rather than guessed at. A run where everything worked leaves no such
file.

### What you've already fetched

The popup keeps a list of past runs — when each one happened, which folder it
saved into, every file it brought back, and anything that failed. It answers
"did I already run this morning, what did I get, and where did it go?" without
digging through Downloads, which matters because every run makes its own dated
sub-folder.

Click **10 files** under a run to see the reports it fetched and their
filenames.

The last 40 runs are kept. **Clear this list** empties it; it never touches the
files themselves.

### Choosing an earlier day

The best time to grab **Real Time** is late at night, when the day's data is
complete. If you miss that, set **Real Time covers** to an earlier date and the
extension fetches that whole day instead.

The whole run is then filed under that day's folder, not today's.

### The 10 reports

| # | Report | Covers |
|---|--------|--------|
| 1 | Real Time | today, or the date you picked |
| 2 | Yesterday | yesterday |
| 3 | By Day | 3 days ago |
| 4 | Past 7 Days | the last 7 days |
| 5 | By Week | last week |
| 6 | Ads Overall | Shopee's own range |
| 7 | Ads GMV MAX | Shopee's own range |
| 8 | Past 30 Days | the last 30 days |
| 9 | Orders (last 30 days) | the 30 days ending yesterday |
| 10 | Orders (previous 30 days) | the 30 days before that |

Each row in the popup shows the exact date it will fetch.

Reports 9 and 10 are two back-to-back blocks: no day appears in both, and
together they cover 60 days — which is exactly as far back as Shopee allows a
single order export to reach.

---

## Updates

The extension checks for updates by itself. When one is available the popup
says so — click **Update** and it installs itself.

The first time you update, Chrome asks you to pick the extension folder. That
is a one-off, and it is the only way a browser will let an extension write to
its own folder.

You can also press **Check** in the popup at any time.

---

## If something goes wrong

| Problem | What to do |
|---------|-----------|
| "Please log in to Shopee Seller Center first" | Log in to Seller Centre in the same Chrome, then run again |
| A report shows a red error | Run just that number again. Shopee's page is sometimes slow |
| Nothing downloads | Make sure the Chrome window stayed open and visible during the run |
| The extension disappeared | The folder was moved or deleted. Unzip it again and re-add it |
| "Chrome saved … instead of Shopee daily report/…" | Another extension is deciding where downloads go. See below |

### Files landing loose in Downloads

Chrome asks **every** extension that can see downloads where a file should go,
and the last word goes to whichever one was installed most recently. So the
folder this extension asks for is a request, not a decision — a download
manager, a "save to folder" helper, even a screen recorder can overrule it, and
the reports then land in plain Downloads with Shopee's names on them.

When that happens the extension notices and fetches its own copy into the run
folder, so you still get the folder. It also says so on the report line — *"a
stray copy was left in Downloads"* — because you will find a second copy of
that file sitting there, and a silent tick would make that look like a fault.

To stop it happening at all, open `chrome://extensions` and turn off anything
that manages downloads.

Each person gets **their own shop's** reports, from whichever Shopee account
they are logged into. Nothing is shared, and no data is sent anywhere except
between your browser and Shopee.

---

## Requirements

- Google Chrome 111 or newer
- A Shopee Seller Centre account (Malaysia)

---

<details>
<summary><b>How it works</b> — for anyone maintaining the code</summary>

### Layout

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
knows nothing about files.

### Modes

**Slow n Steady** navigates one tab through each export in turn, with a 65s
gap. **Fast n Furious** runs four phases across all tabs — load, set the data
period, fire every export, then collect — so Shopee builds all seven reports
concurrently instead of one after another.

Only page loading is parallel. Each tab is still brought to the front to be
driven, because Chrome throttles timers in background tabs and Shopee's SPA
cannot keep up otherwise.

### Things that will bite you

- **Timings are deliberate.** The 15s post-load wait was measured against the
  real site. Shortening it is the first thing that will break.
- **By Day and By Week go through the calendar**, never the period dropdown
  (which closes the picker) and never a text input — typing a date into the
  first visible `input[type=text]` hits Shopee's *Search product* box and
  exports an empty sheet.
- **The Latest Reports panel lists OLD reports.** "Is the word Download on the
  page" is true the moment the panel opens. Reports are matched by filename,
  and the newest row may show the status text "Downloaded" with no button at
  all — so "first Download button" picks the wrong row.
- **Panel labels are not filenames.** A row reads
  `Shop GMV MAX-Detail-Data-29/07/2026-04/08/2026.csv` but the file arrives as
  `Shop+GMV+MAX-Detail-Data-29_07_2026-04_08_2026.csv`. See
  `normalizeShopeeName()`.
- **GMV Max's download endpoint returns a placeholder name** (`download.csv`)
  and its API entries carry no usable name field, so the panel row is the only
  reliable source. The job is matched by id, not by name.
- **`downloads.download({filename})` is only a suggestion.** Another extension
  listening on `onDeterminingFilename` can override it, which is how files
  ended up loose in Downloads. Our own saves re-assert their path through the
  same listener.
- **Shopee redirects downloads to CDN hosts** that do not look like
  `shopee.com.my`, so host matching alone misses them.
- **MV3 service worker lifetime.** The worker dies after ~30s idle, which would
  kill a 10-minute GMV Max poll. The content script pings every 10s; each
  message resets the timer. Do not remove the heartbeat.

### Releasing

```powershell
.\tools\make-release.ps1 -Version 1.8.1 -Notes "What changed"
git add -A; git commit -m "v1.8.1"; git push
```

It rewrites the version in `manifest.json` as text (never a JSON round-trip,
which collapses single-element arrays) and regenerates `update.json` from the
files actually on disk.

### Testing

`tools/inspect-shopee.js` pasted into DevTools on the Product Performance page
dumps the selectors and wording the extension depends on — useful when Shopee
changes its UI.

</details>

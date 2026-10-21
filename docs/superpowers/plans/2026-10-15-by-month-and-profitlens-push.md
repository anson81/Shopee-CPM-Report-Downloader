# By Month report + push to ProfitLens — plan

Spec: `C:\Projects\profitlens\docs\superpowers\specs\2026-10-15-campaign-planner-design.md`,
Part 1 "CPM downloader". Release as **v1.21.0**.

## Goal

ProfitLens's Campaign Planner compares "Past 30 Days" with the last full calendar month. This
extension already fetches the first; it has to fetch the second, and hand every Product
Performance file (`parentskudetail.*.xlsx`) to ProfitLens after a run.

## 1. Report 11 — By Month (last month)

- `EXPORTS` gets `{ id: 11, key: 'bymonth_last', name: 'By Month (last month)', label: 'By Month', kind: 'bi', url: BI_URL }`.
- Pure date helper inside `PURE-DATES`: `lastMonthSpan(base)` → first..last day of the month
  before `base`. `base` is the pinned day when Real Time is pinned, else today — same rule as
  every other row. `exportDates()[11]` returns it, so the popup row reads "1 Sep – 30 Sep" and
  `duplicateExports()` keeps working.
- `computeParams()` sets `useCalendarMonth`, `targetYear`, `targetMonth` (1–12), `yearsBack`
  (how many times to press the year-back arrow — the picker opens on the current year), and
  `expectedName = parentskudetail.YYYYMMDD_YYYYMMDD.xlsx`.
- `content.js`: `selectSpecificMonth(params)` — `openBiCalendar(/^by\s*month$/i, …)`, step the
  year arrow back `yearsBack` times, click the month cell for `targetMonth`. Wired into
  `prepareExport()` beside the week/day branches.
- After collect, the worker compares the saved filename with `expectedName`; a mismatch is an
  error ("Shopee gave us August, not September") rather than a green tick on the wrong month.
- **Unverified:** I have not seen Shopee's By Month panel. The month-cell selector is written
  defensively (class contains `month`, matched by `Jan`…`Dec` / `1月` text) and the filename
  check above catches a wrong click. **First live run is the real test** — or I extend
  `tools/inspect-shopee.js` to dump the month panel and you paste its output once.

## 2. Push to ProfitLens

Copied from the SiteGiant downloader, not reinvented:

- `content/profitlens.js` — same file, own guard flag; uploads to `/api/import/product-performance`
  with the field `file`, borrows the session via `/api/auth/refresh`, stores no credential.
  One fix over the SiteGiant copy: ProfitLens's error envelope is `{ error: "message" }` (a
  string), and SiteGiant reads `error.message`, so it shows "HTTP 400" instead of the reason.
- `manifest.json`: host permissions + content script for `https://profitlens.my/*`,
  `http://localhost/*`, `http://127.0.0.1/*`.
- Background: `ensureProfitLensTab(origin)` and `pushToProfitLens()` as in SiteGiant.
- **Where the bytes come from:** read back from the run folder through the offscreen writer
  (new `op: 'read'`), not held in worker memory. Same path for the end-of-run push and for the
  Push button — which may be pressed after Chrome has restarted the worker.
- **When:** after all reports are collected, in order, for rows that are `done`, `kind: 'bi'`,
  and whose filename starts `parentskudetail.` (reports 1–5, 8, 11). Ads and Orders never.
- **A failed push never fails the run.** The row stays ✓ (the file is saved) and gets a second
  line: `ProfitLens: 312 new · 0 updated · 0 unchanged` or
  `ProfitLens: Not logged in to ProfitLens — the file is saved, log in and press Push` with a
  **Push** button that retries that one file.
- Settings (Options page, new "ProfitLens" section): address (default `https://profitlens.my`)
  and "Send Product Performance files to ProfitLens" on/off (default **on**).
- Diagnostics gain two lines: ProfitLens origin, push on/off. History records each push result.

## 3. Tests (`tools/test-*.js`, run in CI)

- `test-dates.js` + new cases: `lastMonthSpan` across Jan→Dec of the previous year, 31/30/28/29-day
  months, pinned base; expected filename; `yearsBack`.
- `test-profitlens-push.js` (new): which results get pushed (only `parentskudetail` BI rows that
  succeeded), the result-line wording, and `content/profitlens.js`'s error parsing — string
  envelope, object envelope, no JSON — loaded in a `vm` sandbox with a stubbed `fetch`.
- `test-release-consistency.js` already fails if `content/profitlens.js` is missing from
  `update.json` `files`.

## 4. Release

`manifest.json` and `update.json` → 1.21.0, `content/profitlens.js` added to `files`, notes in
plain English. **Committed locally, not pushed** until you say go.

## Not doing

- No Downloads fallback, no filename listener — untouched.
- No Shopee template export (Plan 3).
- SiteGiant's `readError` bug — noted as a follow-up for that repo, not fixed here.

# Three more reports: two Orders exports and Product Performance (Past 30 Days)

Date: 2026-08-11
Status: approved, not yet implemented
Target version: 1.11.0 (minor — new behaviour)

## Goal

Add three exports to the current seven, so one run collects ten files:

| id | key | What |
|----|-----|------|
| 8 | `past30d` | Data Center → Product Performance → **Past 30 Days** |
| 9 | `orders_30d` | My Orders → All → Export, most recent 30-day block |
| 10 | `orders_prev30d` | My Orders → All → Export, the 30 days before that |

All three join the normal run. Slow n Steady and Fast n Furious both produce all ten.

## Findings from the live page (verified 2026-08-11, logged in as qfmwholesales)

These were confirmed by driving the real Seller Centre, not inferred.

1. **`/portal/sale/order` opens on the "All" tab already.** No click needed, but we click
   it anyway to be safe if Shopee restores a previous filter.
2. **Export opens a modal titled "Export All Orders"** with a single `Date Range` field,
   pre-filled with the last 31 days ending today (`2026/07/12 – 2026/08/11` on 11 Aug).
3. **The date field is not typeable.** It is a `div`, not an `input` — the only real inputs
   on the page are the shop search and the order-ID box. The range must be set by clicking
   calendar cells.
4. **The picker is the same EDS component the extension already drives.** Classes:
   `.eds-daterange-picker-panel`, two `.eds-date-picker-panel__date` bodies (left month and
   right month), `.eds-date-table__cell`, and `.eds-picker-header__prev` / `__next` arrows.
   `content.js` already clicks `.eds-date-table__cell` for the By Week calendar.
5. **Cells carry no date attribute.** Only their day number as text, exactly like the By Week
   calendar. Month identity comes from the panel header.
6. **Shopee caps the range at 60 days.** Verified: with a start of 12 Jun selected, 11 Aug
   became `disabled` — the latest selectable end was 10 Aug, i.e. 60 days inclusive. Both of
   our 30-day blocks fit comfortably. Future dates past today are always disabled.
7. **An uncommitted range reverts.** Closing the modal after picking only a start date leaves
   the field on its default. There is no half-applied state to clean up.
8. **The export is asynchronous.** Clicking Export queues a job. The file is *not* downloaded
   there and then.
9. **Files are collected from My Reports**: `/portal/settings/shop/reports/order`, chip tabs
   `Order Export | Shipping Document | Seller Balance Report | Income Report |
   Marketing Center Report | Business Insights Reports`, with `Order Export` active by
   default. Table columns: Report Type, Request Time, Request Account, Report name, Action.
   Retention is 6 months.
10. **The filename encodes the range**: `Order.all.YYYYMMDD_YYYYMMDD.xlsx`
    (e.g. `Order.all.20260711_20260810.xlsx`). This is the key that makes the whole design
    safe — we know the exact filename before we ask for it.
11. **Download is a `<button>`, not a link** (`.eds-button--link`, no `href`). The file
    arrives through JS, which the existing MAIN-world interceptor already captures.
12. There is also a **"Latest Reports"** tray on the Orders page listing undownloaded
    reports. We do not use it — My Reports is a stable URL with the filenames visible.

## Date arithmetic

`pin` = the run's date, or the date chosen in the popup's "Real Time covers" field when set.
The two blocks end on the day **before** the pin, so a part-finished day is never exported,
and they do not overlap.

```
end1   = pin - 1 day
start1 = end1 - 29 days
end2   = start1 - 1 day
start2 = end2 - 29 days
```

Worked example, pin = 2026-08-11:

| Block | Range | Expected filename |
|-------|-------|-------------------|
| 9 `orders_30d` | 12 Jul – 10 Aug 2026 | `Order.all.20260712_20260810.xlsx` |
| 10 `orders_prev30d` | 12 Jun – 11 Jul 2026 | `Order.all.20260612_20260711.xlsx` |

Each block is exactly 30 days. Together they cover 60 consecutive days with no day counted
twice and no gap.

## Architecture

No new files. `background/background.js` keeps orchestration, `content/content.js` keeps all
DOM knowledge, matching the split the extension already has. The order flow adds roughly 200
lines to `content.js` as one clearly marked section, and reuses its existing helpers
(`waitFor`, `fullClick`, `queryText`, `$$vis`, the capture bus).

Splitting `content.js` was considered and rejected for now: it would mean moving shared
helpers out of a file that is tested against a live seller account, risking the seven reports
that currently work. Worth revisiting separately.

### New export kind: `order`

`EXPORTS` gains three entries. Reports 9 and 10 carry `kind: 'order'` plus a `block` field
(`'recent'` or `'previous'`) that the date maths reads. Report 8 is `kind: 'bi'` with
`label: 'Past 30 Days'` — no new code at all, because `PERIOD_RE` in `content.js` already
matches `Past 30 Days` and the Product Performance tab is already opened by the BI flow.

### Two phases, deliberately separated

**Queue** (on `/portal/sale/order`)

1. Wait for the page, confirm logged in.
2. Click the **All** tab.
3. Click **Export** → wait for the "Export All Orders" modal.
4. Open the date field, drive the calendar to `start`, click it, drive to `end`, click it.
   Month navigation uses `.eds-picker-header__prev`; the target month is identified from the
   panel header text, never from a fixed number of clicks.
5. Verify the field reads the expected `YYYY/MM/DD – YYYY/MM/DD` before continuing. If it
   does not, fail with a clear message rather than exporting the wrong range.
6. Click **Export** in the modal. Record the expected filename.

**Collect** (on `/portal/settings/shop/reports/order`)

1. Ensure the **Order Export** chip is active.
2. Poll the table for a row whose Report name equals the expected filename, reloading the
   page between polls. Reuse the GMV Max polling pattern: it already keeps the MV3 worker
   alive by pinging the background every 10s.
3. Click that row's **Download** button, arm the download watcher, and save the file into the
   run's dated folder under Shopee's own name — same as every other report.

Because the expected filename is exact, a stale report from an earlier run can never be
mistaken for this one. This is the same guard the extension already applies elsewhere.

### Ordering within a run

Both modes queue reports 9 and 10 **first**, then run reports 1–8, then collect 9 and 10 at
the end. Shopee generates the files server-side while the other eight download, so the wait
costs close to nothing in practice.

The two order exports are queued one after the other, not simultaneously, in case Shopee
rate-limits back-to-back requests from one account.

## Error handling

| Situation | Behaviour |
|-----------|-----------|
| Not logged in | Existing `NOT_LOGGED_IN` message |
| Export button or modal missing | `Could not find the Export button on the Orders page. Shopee's UI may have changed.` |
| Calendar will not reach the target month | Fail with the range that was wanted, do not export a wrong range |
| Date field does not read back as expected | Abort this export, leave the other nine alone |
| Requested range exceeds 60 days | Guard before clicking; cannot happen with 30-day blocks but is checked |
| Report never appears in My Reports | Time out after 10 minutes with `Orders report was not ready after 10 minutes. Try again later.` |
| Shopee rate-limits the second export | Retry once after a pause, then report it |
| Download button click yields no file | Existing `NO_BLOB` handling |

A failure in any one of the ten marks only that report failed. The run continues.

## Out of scope

- Ranges other than the two 30-day blocks, and any user-facing date controls beyond the
  existing "Real Time covers" pin.
- The `toship` order export, and the other My Reports tabs (Income, Seller Balance, etc.).
- Backfilling more than 60 days, which would need one export per 60-day window.
- Splitting `content.js`.

## Verification

Tested by running the extension against the live seller account:

1. Both modes produce ten files in one dated run folder.
2. The two order filenames carry the expected date ranges for the run day.
3. Setting "Real Time covers" to an earlier day shifts both order blocks accordingly.
4. A second run the same day produces a separate run folder without clobbering the first.
5. The seven original reports are unchanged.

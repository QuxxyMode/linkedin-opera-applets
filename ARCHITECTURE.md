# Architecture notes

Implementation details end users don't need day-to-day, but useful if you're
reading the code or extending it. Not included in `dist/LinkedIn-Opera-Applets.zip`
(the release build for non-technical users) - see the `FILES` allowlist in
`build_release.py`.

## How job cards are recognized (LinkedIn)

LinkedIn renders the jobs list two different ways depending on which experience your account is bucketed into, and this extension handles both:

1. **"AI" layout** - each row is a `div[role="button"][componentkey^="job-card-component-ref-<jobId>"]` with no `<a href>` at all; title/company are read as plain text. The expanded detail pane uses `div[data-testid="lazy-column"][data-component-type="LazyColumn"]` (the same attribute also marks the wrapper around the *entire* list, which is explicitly excluded).
2. **Classic/standard layout** - each row is an `<li data-occludable-job-id="<jobId>">` wrapping a real `a[href*="/jobs/view/"]` title link; company is a plain-text subtitle, location is right there in the row. The detail pane is `.jobs-details__main-content`, and a green "Applied X ago" banner (`.artdeco-inline-feedback--success`) confirms Easy Apply completions instantly, rather than the AI layout's separate "Did you finish applying?" confirmation step.

Both paths feed a shared "known info about this job ID" map and apply hiding to the matching row, whichever layout LinkedIn happened to render.

Workplace type (Remote/Hybrid/On-site) is read either as a standalone pill with exact matching text, or as a `(Remote)`-style suffix on the location text in the classic row - see `detectWorkplaceType()` in `src/content.js`.

## How statuses are determined

Applied/Viewed status is detected several independent ways:

1. **By text** - a `<p>` (or, in the classic layout, a dedicated `<li>`/success banner) whose text starts with "Applied" (this also matches "Applied on company site", "Applied X ago", etc.), "Viewed", or "Application submitted".
2. **By confirming an external application ("Yes")** - clicking the external "Apply" link opens the employer's site in a new tab, and LinkedIn shows a "Did you finish applying?" panel with Yes/No buttons (the job sits under "In progress" until confirmed). The extension binds to that "Yes" link and only counts the application at the moment it's clicked.
3. **By the Apply button disappearing (Easy Apply fallback)** - if a job's Apply/Easy Apply button was visible a moment ago and is now gone, with no confirmation panel and no "Applied" text yet, that's also counted as applied. This covers Easy Apply, which LinkedIn confirms immediately with no intermediate question.

A status detected passively - an already-applied job just scrolling into view, not a transition witnessed this session - is not recorded to Excel unless the page confirms it happened *today* (a relative time like "now" / "4h" / "44 minutes ago", as opposed to "3 days ago"). This avoids backdating an old application under today's date just because its row happened to render.

LinkedIn changes its markup periodically - if detection or hiding stops working, check the current job card structure in DevTools and adjust the selectors in `src/content.js`.

## Data storage

Settings, daily counters, and dedup bookkeeping (which jobs have already been recorded) live in the extension's own `chrome.storage.local` - nothing is sent anywhere except to the local server on `127.0.0.1`. The extension does not keep the full application history in memory; only applications not yet confirmed written to disk are queued there (`pendingRecords`).

## Excel file: append/patch instead of rebuild

The extension writes into a single workbook (default name `Applications log.xlsx`, next to the extension) that's both the log the extension appends to (date, company, vacancy, link, source, and - if picked - CV version) and the one you annotate by hand (response, interview, offer, notes, ...). Unlike rebuilding the whole workbook on every write, `server/save-server.js` reads the existing `.xlsx` (if any) and appends new rows / patches specific cells into it, so anything edited by hand survives. It can read files that Excel/LibreOffice has resaved (`sharedStrings.xml`, DEFLATE compression), not just files this server wrote itself. If the file doesn't exist yet, it's bootstrapped from `server/tracker-template.xlsx` - a blank copy with the same sheets/styles/data-validation dropdowns, no personal data.

Two extra sheets are maintained the same way, found by name (not a hardcoded sheet number, since sheet order shifts once Excel/LibreOffice resaves the file):
- **"Hidden Companies"** - mirrors the popup's per-company hide list; rebuilt wholesale on every change rather than patched, since nothing on it is meant to be hand-edited.
- **"List CVs"** - one CV per row, any text (e.g. `CV1 – Senior BI Developer`); the content script's CV picker shows that full text but only stores the leading `CV<n>` token, since that's what the "Статистика" sheet's `COUNTIFS` formulas match against.

The port can be changed if `17845` is taken by something else - update `PORT` in `server/save-server.js` and `LOCAL_SERVER_BASE` in `src/background.js` to match.

## Recording applications on other job sites

`src/genericContent.js` runs on every page that isn't LinkedIn or Indeed. There's no per-site teaching step and nothing about *how to find elements* is ever persisted — each application is recorded on the spot:

1. A floating button (`showRecordButton` setting, default on) starts the flow.
2. Left-click the job title on the page, then left-click the company name - each click is captured (`preventDefault`/`stopPropagation`) so it doesn't navigate away, and the picked element's own text is used verbatim. `titleUrl` is always `location.href` (the page you're recording *from*, not a link inside the picked element).
3. If `cvPickerEnabled` is on, a CV dropdown appears (same `cvList` cache as the LinkedIn/Indeed pickers); a "Save" click sends the same `JOB_SEEN` message shape every other site sends, with `source` set to the hostname's registrable label (`siteKeyFromHostname()` - same idea as identifying "LinkedIn"/"Indeed" by name).

Hiding/badging an already-applied job again on a later visit to a list page has no taught selector to re-find it by either, so it falls back to a plain text match: every known `{ source, title, company, date }` is looked up against a one-time index of small "leaf" elements' own text built fresh on each scan (`buildTextIndex()` in `src/genericContent.js`) - if a title text matches and the same card (found via the same repeating-sibling `findCardRoot()` heuristic as before) also contains the company text, that card gets hidden/badged with the date shown right in the badge. This trades some precision (a generic exact-text match instead of a taught selector) for never breaking when a site redesigns.

That "known applications" list is two sources merged (`getKnownApplications()`):
- `recordedJobs` (capped at 500, in `chrome.storage.local`) - jobs recorded on *this* browser, added the instant you save one, so it's reflected immediately without waiting on a sync.
- `appliedIndex` - the tracker workbook's actual title/company/source/date for every row, synced from the local server every couple minutes (`GET /applied-index`, cached by `src/background.js`) - catches applications recorded on another device, or typed into the spreadsheet by hand, that this browser's own memory wouldn't know about. This is also what lets the floating button itself recognize "you're looking at a job you already applied to" (`findKnownApplicationOnPage()`) and turn green with the date, even on a detail page with no list of cards to match against.

## Adding another job site

The server is already site-agnostic - `/append`, `/missing-links`, and `/backfill-link` just take whatever `source` string a message carries and never hardcode "LinkedIn" or "Indeed". Supporting a new site means:

1. A new content script (mirror `src/indeedContent.js`) that scrapes the site and sends `JOB_SEEN`/`JOB_INFO_UPDATE`/`LINK_BACKFILL` messages with its own `source` value - `src/background.js` needs no changes, it already treats `source` generically.
2. A `host_permissions` entry + `content_scripts` block for it in `manifest.json`.
3. One optional addition in `server/save-server.js`: a new branch in `extractJobIdFromUrl()` for that site's job-URL pattern, so `/patch` (filling in company/location on an already-written row) can find rows by ID the same way it does for LinkedIn/Indeed. Without this, everything else (recording applications, missing-link backfill) still works - only that one after-the-fact patch path needs it.

## Project structure

```
manifest.json                 - extension manifest (Manifest V3)
src/content.js                 - scans LinkedIn pages, hides/shows job cards, CV picker
src/content.css                - CSS: hiding, badges, hide-company button, CV picker
src/indeedContent.js           - Indeed: "Mark as Applied" button, AA badge, hide toggle, CV picker
src/indeedContent.css          - styling for the Indeed button/badge/CV picker
src/genericContent.js          - any other job site: floating "Record application" button + pick flow
src/genericContent.css         - styling for the floating button/toolbar/hover highlight
src/background.js              - service worker: counters, storage, talks to the local server
src/zip.js                     - minimal ZIP writer (no third-party dependencies)
src/popup.html/.js/.css        - popup: toggles, counters, "Open spreadsheet"
server/save-server.js          - local companion process: appends/patches the tracker workbook (cross-platform)
server/tracker-template.xlsx   - blank workbook (no personal data) used to bootstrap a fresh tracker file
server/start-server.bat        - double-click launcher for the server (Windows)
server/start-server.command    - double-click launcher for the server (macOS); also works via `sh` on Linux
build_release.py               - builds dist/LinkedIn-Opera-Applets.zip (explicit file allowlist)
```

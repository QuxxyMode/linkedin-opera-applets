# LinkedIn: Hide Applied/Viewed Jobs

*[Русская версия](README.ru.md)*

A browser extension (Opera, Chrome, Edge, Brave, or any other Chromium-based browser - Windows, macOS, and Linux are all supported) for job search on **LinkedIn**, **Indeed**, and any other job site:

- Hides/shows job cards marked **Applied** and **Viewed** on LinkedIn (toggles in the popup, applied instantly).
- Can also hide jobs by workplace type - **Remote**, **Hybrid**, **On-site** (LinkedIn only).
- Adds a small **"AA"** (Already Applied) badge before the title of any job already marked Applied, so it stands out even with hiding turned off.
- On Indeed - which has no built-in "applied" tracking - adds a **"Mark as Applied"** button, plus the same "AA" badge once a job is marked.
- On LinkedIn and Indeed, a **CV picker** appears near the Apply/Mark-as-Applied button - pick which CV you're sending before applying, and it's recorded into the "Версия CV" column alongside that application. The list comes from the "List CVs" sheet in the workbook - add a row there for each CV you want to choose from. Turn this off in the popup ("Record which CV was sent") if you don't want to bother with it.
- **Any other job site**: a floating **"Record application"** button (togglable in the popup) - click it, then click the job title and the company name on the page, pick a CV if you want, and it's recorded. No setup, nothing taught in advance. If you're looking at a job you've already applied to (checked against the actual spreadsheet, not just this browser's memory), the button turns green and shows the date, and a badge with that same date appears right next to the job title if you see it again in a list.
- **Hide by company**: a small eye icon next to each job lets you hide every listing from a company you're not interested in (toggle in the popup to show/hide them).
- Counts how many jobs were marked Applied/Viewed **today** and shows the counters in the popup.
- Logs every application straight into one Excel workbook (see below) - no downloads, no popups from the browser.
- If an old row in that spreadsheet is missing a link (e.g. typed in by hand), the extension recognizes the job by its title/company while you browse and fills the link in automatically.

## Quick start

1. Install [Node.js](https://nodejs.org/) (any current version) - needed for the local server that writes the Excel file.
2. Load the extension: open `opera://extensions` (or `chrome://extensions`, `edge://extensions`) → enable **Developer mode** → **Load unpacked** → select this folder.
3. Start the local server: double-click `server/start-server.bat` (Windows) or `server/start-server.command` (macOS/Linux). Leave that window open.
4. Browse LinkedIn or Indeed as usual. Every application gets logged automatically into **`Трекер откликов - AB тест.xlsx`**, created next to the extension the first time it's needed - already set up with drop-downs and a stats sheet, no setup required.

Details on each step below.

## Installing the extension

1. Open your browser's extensions page: `opera://extensions`, `chrome://extensions`, or `edge://extensions`.
2. Turn on **Developer mode** (toggle, usually top-right).
3. Click **Load unpacked** and select this folder (`LinkedIn Opera Applets`).
4. Open LinkedIn → Jobs, or Indeed's job search - the popup icon is available on both.

Identical on Windows, macOS, and Linux.

## The local server (required for the Excel log)

Browser extensions can't write files to disk directly, so a small local companion process handles that part.

1. Install [Node.js](https://nodejs.org/) (any current version).
2. Start the server:
   - **Windows**: double-click `server/start-server.bat`.
   - **macOS**: double-click `server/start-server.command`. The first time, macOS may block it ("unidentified developer") - right-click the file → **Open** → **Open** again in the dialog.
   - **Linux**: run `sh server/start-server.command`, or `node server/save-server.js`.
   - **Any OS, from a terminal**: `node server/save-server.js`.

   You should see a message ending in `listening on http://127.0.0.1:17845`. Leave that window open while you use the extension.
3. New applications are appended straight into **`Трекер откликов - AB тест.xlsx`**, next to the extension itself. If that file doesn't exist yet, the server creates it automatically from a bundled template on the first application, complete with the "Отклики" sheet (drop-downs for CV version and Yes/No fields included), a "List CVs" sheet (three example rows - rename/replace them with your own CVs), and a formula-driven "Статистика" sheet - nothing to set up by hand.
4. The extension fills in **date, company, vacancy, link, source, and (if you picked one) CV version** - the rest of the columns (response, response date, interview, second stage, offer, notes) are yours to fill in by hand as you follow up on each application. The extension never touches or overwrites those columns.

**Launching it automatically at login** (optional):
- **Windows**: put a shortcut to `start-server.bat` in your Startup folder (`Win+R` → `shell:startup`).
- **macOS**: System Settings → General → Login Items → add `start-server.command`.
- **Linux**: add it to your desktop environment's autostart apps, or start it manually each session.

If the server isn't running when you apply to a job, nothing is lost - it's queued and written automatically once the server is available again.

### Backups

Every 30 minutes, the server backs up `Трекер откликов - AB тест.xlsx` to `Трекер откликов - AB тест.backup.xlsx` (same folder). Before doing so, it compares the two: if a row exists in the backup but not in the live file (e.g. it got overwritten or corrupted by something else), that row is automatically re-appended before the backup is refreshed. This is a single rolling backup, not a dated history — if you need to go back further than the last cycle, use your own backup tool for that.

### Opening the spreadsheet

The popup's **"Open spreadsheet"** button opens the file directly (or its folder, if that's not possible).

## Browser compatibility

Built and tested on **Chromium-based browsers** - Opera, Chrome, Edge, Brave, Vivaldi, and any other browser built on Chromium. It uses the standard `chrome.*` extension APIs and Manifest V3, nothing Opera-specific, so it should behave identically across all of them.

**Firefox is not currently supported.** Firefox's Manifest V3 implementation differs enough (background script model, permanent-install signing requirements) that this would need real changes and testing before it could be recommended there.

## Privacy

Nothing is sent anywhere except to the local server running on your own machine (`127.0.0.1`). No external servers, no tracking.

## Support

If you got this extension for free and it's saved you some time, feel free to leave a tip - any amount you're comfortable with. Completely optional, no strings attached.

**[donationalerts.com/r/quxxy_mod](https://www.donationalerts.com/r/quxxy_mod)**

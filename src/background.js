// Local companion service (see server/save-server.js) that appends new
// applications straight into applied_jobs.xlsx over plain HTTP. Unlike the
// old model, this extension no longer holds the full application history —
// only a small queue of records it hasn't managed to append yet
// (`pendingRecords`), cleared out as soon as each one lands on disk. That
// keeps chrome.storage.local from growing without bound over months of job
// hunting, and — since the server only ever appends/patches instead of
// rebuilding the whole workbook — anything edited by hand directly in the
// spreadsheet survives.
const LOCAL_SERVER_BASE = 'http://127.0.0.1:17845';
const LOCAL_SERVER_TOKEN = 'lext-9f3c7a2b1e4d6f80';

// Internal bucketing key (daily counters, seenJobs) — kept as sortable ISO
// yyyy-MM-dd regardless of display preference; only the "Date" column
// written to Excel uses the dd.MM.yyyy format below.
function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDisplayDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const [, y, mo, d] = m;
  return `${d}.${mo}.${y}`;
}

async function postJson(pathName, body) {
  return fetch(`${LOCAL_SERVER_BASE}${pathName}`, {
    method: 'POST',
    headers: {
      'X-Lext-Token': LOCAL_SERVER_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function getJson(pathName) {
  return fetch(`${LOCAL_SERVER_BASE}${pathName}`, {
    method: 'GET',
    headers: { 'X-Lext-Token': LOCAL_SERVER_TOKEN },
  });
}

// Old rows can have a title/company with no hyperlink at all — recorded
// before the row's own href was available, or by the earlier full-rebuild
// code. Content scripts compare what they see on the page against this
// cached list (kept small — just text, no URLs) to recognize such a job
// and supply the missing link, without needing a network round trip per
// job card scanned.
async function refreshMissingLinks() {
  try {
    const res = await getJson('/missing-links');
    if (!res.ok) return;
    const missingLinks = await res.json();
    await chrome.storage.local.set({ missingLinks });
  } catch (e) {
    // Server not running — leave whatever was cached before, it'll refresh
    // next time the alarm fires or the server comes back.
  }
}

// Cache of the "List CVs" sheet (label = full text you wrote there, code =
// the leading "CV<n>" token that actually gets stored in the "Версия CV"
// column) — content scripts read this to populate their CV picker next to
// the Apply button, without a network round trip per job page.
async function refreshCvList() {
  try {
    const res = await getJson('/cv-list');
    if (!res.ok) return;
    const cvList = await res.json();
    await chrome.storage.local.set({ cvList });
  } catch (e) {
    // Server not running — leave whatever was cached before.
  }
}

// Mirrors the "Hide this company" list onto a second sheet in the
// spreadsheet, purely so it's visible somewhere outside the popup — the
// server always rebuilds that sheet wholesale from the full list rather
// than trying to preserve hand edits on it (unlike the main sheet), so
// don't type notes into that tab expecting them to survive.
async function syncHiddenCompanies() {
  const { hiddenCompanies } = await chrome.storage.local.get({ hiddenCompanies: [] });
  if (!hiddenCompanies.length) return;
  try {
    await postJson('/hidden-companies', { companies: hiddenCompanies });
  } catch (e) {
    // Server not running — retried on the next alarm tick along with
    // everything else.
  }
}
// ponytail: resyncs the whole list every 2 min regardless of whether it
// already succeeded — fine while the list stays small; add a dirty flag if
// this ever needs to skip no-op ticks.

// Sends everything still queued to the local server to be appended. Leaves
// the queue untouched on any failure (server not running, file locked,
// network hiccup) — it'll be retried on the next application or the
// periodic alarm below.
async function flushPending() {
  const { pendingRecords } = await chrome.storage.local.get({ pendingRecords: [] });
  if (!pendingRecords.length) return;

  try {
    const res = await postJson('/append', { records: pendingRecords });
    if (!res.ok) throw new Error(`append responded ${res.status}`);
    await chrome.storage.local.set({ pendingRecords: [] });
  } catch (e) {
    // Local server not running, or the file is locked open in Excel —
    // that's expected some of the time, not an error worth surfacing loudly.
  }
}

// Best-effort: fill in company/location on a row that's already made it to
// disk (found by the job id embedded in its title hyperlink — see
// save-server.js). A 404 just means there's nothing to patch yet (e.g. it's
// still sitting in pendingRecords), which handleJobInfoUpdate checks first.
async function tryPatch(jobId, source, fields) {
  try {
    await postJson('/patch', { jobId, source, ...fields });
  } catch (e) {
    // Server unreachable — patches aren't queued for retry, only new rows are.
  }
}

async function handleJobSeen(msg) {
  const { jobId, status, title, titleUrl, company, companyUrl, location, source, cvVersion } = msg;
  // Older LinkedIn-only messages predate the `source` field — treat those
  // as LinkedIn rather than requiring a migration.
  const src = source || 'LinkedIn';
  if (!jobId || (status !== 'applied' && status !== 'viewed')) return;

  const store = await chrome.storage.local.get({ seenJobs: {}, dailyCounts: {}, pendingRecords: [] });
  const today = todayKey();
  const todayDisplay = formatDisplayDate(today);

  // A job can get reposted and re-opened for a fresh application, so the
  // "applied" dedup key is scoped to today rather than blocking the jobId
  // forever — a genuinely new application on a later day gets its own row.
  // "viewed" has no such concern and stays a one-time-ever key.
  const key = status === 'applied' ? `${src}:${jobId}:applied:${todayDisplay}` : `${src}:${jobId}:${status}`;
  if (store.seenJobs[key]) return;
  store.seenJobs[key] = { date: today };

  store.dailyCounts[today] = store.dailyCounts[today] || { applied: 0, viewed: 0 };
  store.dailyCounts[today][status] = (store.dailyCounts[today][status] || 0) + 1;

  if (status === 'applied') {
    store.pendingRecords.push({ date: todayDisplay, jobId, source: src, title, titleUrl, company, companyUrl, location, cvVersion });
  }

  await chrome.storage.local.set({
    seenJobs: store.seenJobs,
    dailyCounts: store.dailyCounts,
    pendingRecords: store.pendingRecords,
  });

  // Awaited rather than fire-and-forget: an MV3 service worker can be torn
  // down the instant its current event finishes, so anything not awaited
  // here isn't guaranteed to ever run.
  if (status === 'applied') await flushPending();
}

// The compact job-list row has no company link (or location) at all — only
// the expanded detail view does. If a job gets reported Applied before that
// detail view was ever scanned, the row goes out with those fields blank.
// This fills them in once better data becomes available: while the record
// is still queued, patch it in place; once it's already on disk, ask the
// local server to locate and patch that row instead.
async function handleJobInfoUpdate(msg) {
  const { jobId, company, companyUrl, location, source } = msg;
  const src = source || 'LinkedIn';
  if (!jobId || (!company && !companyUrl && !location)) return;

  const { pendingRecords } = await chrome.storage.local.get({ pendingRecords: [] });
  const rec = [...pendingRecords].reverse().find((r) => r.jobId === jobId && r.source === src);

  if (rec) {
    let changed = false;
    if (company && company !== rec.company) {
      rec.company = company;
      changed = true;
    }
    if (companyUrl && companyUrl !== rec.companyUrl) {
      rec.companyUrl = companyUrl;
      changed = true;
    }
    if (location && location !== rec.location) {
      rec.location = location;
      changed = true;
    }
    if (changed) {
      await chrome.storage.local.set({ pendingRecords });
      await flushPending();
    }
    return;
  }

  await tryPatch(jobId, src, { company, companyUrl, location });
}

// A content script recognized one of the entries from `missingLinks` (exact
// title/company text match) while browsing and is supplying the URL(s)/
// location that row was missing. Refresh the cached list afterwards so this
// job stops showing up as "missing" on subsequent scans.
async function handleLinkBackfill(msg) {
  const { title, titleUrl, company, companyUrl, location, source } = msg;
  if (!title || (!titleUrl && !companyUrl && !location)) return;
  try {
    const res = await postJson('/backfill-link', { title, titleUrl, company, companyUrl, location, source: source || 'LinkedIn' });
    if (res.ok) await refreshMissingLinks();
  } catch (e) {
    // Server unreachable — this job will still show as missing next time
    // the list refreshes, so nothing lost by not retrying here.
  }
}

// Popup's "Open spreadsheet" button — the extension itself has no
// filesystem access, so this just asks the local server (which does) to
// launch the file in its default app, or the containing folder if that's
// not possible.
async function openFile() {
  const res = await postJson('/open', {});
  if (!res.ok) throw new Error(`open responded ${res.status}`);
}

// Serialize message handling so concurrent JOB_SEEN messages (e.g. many
// cards detected on initial page load) can't race on the read-modify-write
// of chrome.storage.local.
let queue = Promise.resolve();
function enqueue(task) {
  const result = queue.then(task);
  queue = result.catch((e) => console.error('LinkedIn Opera Applets: task failed', e));
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'JOB_SEEN') {
    enqueue(() => handleJobSeen(message))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (message?.type === 'JOB_INFO_UPDATE') {
    enqueue(() => handleJobInfoUpdate(message))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (message?.type === 'OPEN_FILE') {
    openFile()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (message?.type === 'LINK_BACKFILL') {
    enqueue(() => handleLinkBackfill(message))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});

// Retries anything still queued even without new application activity —
// e.g. the local server was down and has since been started, or the file
// was open in Excel and has since been closed. Piggybacks a refresh of the
// missing-links cache on the same cadence.
const FLUSH_ALARM = 'lext-flush-pending';
chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) {
    enqueue(flushPending);
    enqueue(refreshMissingLinks);
    enqueue(syncHiddenCompanies);
    enqueue(refreshCvList);
  }
});

// Push the list to the spreadsheet right away too, rather than waiting up
// to 2 minutes for the alarm.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.hiddenCompanies) enqueue(syncHiddenCompanies);
});
enqueue(refreshMissingLinks);
enqueue(refreshCvList);

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.get({ hideApplied: false, hideViewed: false });
  // Migrating off the old "hold full history, rebuild the whole file every
  // time" model: that history already made it to disk under the old
  // full-rebuild writes, so there's nothing to carry forward — keeping it
  // around would just burn storage quota for no reason.
  await chrome.storage.local.remove('appliedRecords');
});

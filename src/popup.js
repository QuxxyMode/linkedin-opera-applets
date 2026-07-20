function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Same heuristic as genericContent.js — kept in sync manually (this file
// has no import step to share it from).
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.br', 'com.au', 'co.jp', 'co.in', 'co.nz', 'co.za',
  'com.mx', 'com.sg', 'com.tr', 'com.ar',
]);
function siteKeyFromHostname(hostname) {
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length <= 2) return parts[0] || hostname;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) return parts[parts.length - 3] || parts[0];
  return parts[parts.length - 2];
}

async function setupLearnSection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  let hostname;
  try {
    hostname = new URL(tab.url).hostname;
  } catch (e) {
    return;
  }
  if (!hostname || /(^|\.)linkedin\.com$/.test(hostname) || /(^|\.)indeed\.com$/.test(hostname)) return;

  const siteKey = siteKeyFromHostname(hostname);
  const { learnedSites } = await chrome.storage.local.get({ learnedSites: {} });
  const taught = !!learnedSites[siteKey];

  const section = document.getElementById('learnSection');
  section.hidden = false;
  document.getElementById('learnSiteName').textContent = siteKey;
  document.getElementById('learnBtn').textContent = taught ? `Re-teach ${siteKey}` : `Learn ${siteKey}`;
  document.getElementById('forgetBtn').hidden = !taught;

  document.getElementById('learnBtn').addEventListener('click', () => {
    chrome.tabs.sendMessage(tab.id, { type: 'START_LEARN' });
    window.close();
  });
  document.getElementById('forgetBtn').addEventListener('click', async () => {
    const { learnedSites: current } = await chrome.storage.local.get({ learnedSites: {} });
    delete current[siteKey];
    await chrome.storage.local.set({ learnedSites: current });
    window.close();
  });
}

const TOGGLE_IDS = ['hideApplied', 'hideViewed', 'hideRemote', 'hideHybrid', 'hideOnsite', 'hideUninterestedCompanies'];

async function refresh() {
  const defaults = { dailyCounts: {}, pendingRecords: [] };
  for (const id of TOGGLE_IDS) defaults[id] = false;
  const { dailyCounts, pendingRecords, ...toggles } = await chrome.storage.local.get(defaults);

  for (const id of TOGGLE_IDS) {
    document.getElementById(id).checked = toggles[id];
  }

  const today = dailyCounts[todayKey()] || { applied: 0, viewed: 0 };
  document.getElementById('appliedToday').textContent = today.applied || 0;
  document.getElementById('viewedToday').textContent = today.viewed || 0;

  document.getElementById('pendingHint').hidden = pendingRecords.length === 0;
  document.getElementById('pendingCount').textContent = pendingRecords.length;
}

for (const id of TOGGLE_IDS) {
  document.getElementById(id).addEventListener('change', (e) => {
    chrome.storage.local.set({ [id]: e.target.checked });
  });
}

document.getElementById('openFile').addEventListener('click', () => {
  document.getElementById('openFileError').hidden = true;
  chrome.runtime.sendMessage({ type: 'OPEN_FILE' }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      document.getElementById('openFileError').hidden = false;
    }
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') refresh();
});

refresh();
setupLearnSection();

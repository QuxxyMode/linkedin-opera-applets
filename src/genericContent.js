(function () {
  // Two-part TLDs where the registrable label is one level further up than
  // usual (portal.example.co.uk -> "example", not "co"). Not exhaustive —
  // ponytail: add more here if a site's recorded name comes out wrong; a
  // full public-suffix-list dependency is overkill for a personal tool.
  const MULTI_PART_TLDS = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
    'com.br', 'com.au', 'co.jp', 'co.in', 'co.nz', 'co.za',
    'com.mx', 'com.sg', 'com.tr', 'com.ar',
  ]);

  // "portal.gupy.io" -> "gupy" — same idea as how this extension already
  // identifies "LinkedIn"/"Indeed" by name rather than full hostname.
  function siteKeyFromHostname(hostname) {
    const parts = hostname.split('.').filter(Boolean);
    if (parts.length <= 2) return parts[0] || hostname;
    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_PART_TLDS.has(lastTwo)) return parts[parts.length - 3] || parts[0];
    return parts[parts.length - 2];
  }

  const SITE_KEY = siteKeyFromHostname(location.hostname);
  const STATUS_APPLIED = 'applied';

  function normalizeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function firstLink(el) {
    return el.tagName === 'A' ? el : el.querySelector('a');
  }

  function jobIdFor(title, company) {
    return `${normalizeText(title)}::${normalizeText(company)}`;
  }

  function addOption(select, label, value) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }

  // ---------------------------------------------------------------------
  // Settings: shared hideApplied (from the popup's main toggles), plus two
  // generic-site-only ones — whether the floating record button shows up
  // at all, and whether the CV picker step is offered.
  // ---------------------------------------------------------------------

  let settings = { hideApplied: false, showRecordButton: true, cvPickerEnabled: true };

  function shouldHideCard(card) {
    return card.dataset.lextStatus === STATUS_APPLIED && settings.hideApplied;
  }

  function applyVisibility(card) {
    card.classList.toggle('lext-hidden', shouldHideCard(card));
  }

  function markApplied(card, date) {
    if (card.dataset.lextAaBadge === '1') return;
    card.dataset.lextAaBadge = '1';
    const badge = document.createElement('span');
    badge.className = 'lext-aa-badge';
    badge.textContent = date ? `AA · ${date}` : 'AA';
    badge.title = date ? `Already Applied — ${date}` : 'Already Applied';
    card.insertBefore(badge, card.firstChild);
  }

  function todayDisplay() {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}.${d.getFullYear()}`;
  }

  // No reliable "you already applied" page state to read back on an
  // arbitrary site, so applied jobs are tracked locally by the same
  // title+company key used to send JOB_SEEN.
  const APPLIED_STORAGE_KEY = `genericApplied_${SITE_KEY}`;
  let appliedIds = new Set();

  // Every job recorded via the picker on *this* browser, kept so a later
  // visit to a list page on the same site can spot it again and hide/badge
  // it immediately — see markRecordedJobsOnPage() below. Global across all
  // generic sites (each entry carries its own `source`), capped so it
  // can't grow forever.
  const RECORDED_JOBS_KEY = 'recordedJobs';
  const MAX_RECORDED_JOBS = 500;
  let recordedJobs = [];

  // The real tracker workbook's title/company/source/date, synced from the
  // local server every couple minutes (src/background.js) — catches
  // applications recorded from another browser/device, or typed in by
  // hand, that `recordedJobs` alone (this browser's own memory) wouldn't
  // know about. `recordedJobs` still matters on top of this for the
  // seconds/minutes right after recording, before the next sync lands.
  let appliedIndex = [];

  function getKnownApplications() {
    const mine = recordedJobs.filter((j) => j.source === SITE_KEY);
    const synced = appliedIndex.filter((j) => j.source === SITE_KEY);
    return mine.concat(synced);
  }

  // ---------------------------------------------------------------------
  // Finding the repeating "card" ancestor for a matched title: walk up
  // until a level is found where a sibling shares the exact same
  // tag+className — i.e. this element is one of a repeated list.
  // ponytail: assumes cards share an identical className; good enough for
  // the same reason it was good enough for the old taught-selector scan.
  // ---------------------------------------------------------------------

  function findCardRoot(el) {
    let node = el;
    while (node && node.parentElement && node.parentElement !== document.body) {
      const parent = node.parentElement;
      const shapeSiblings = Array.from(parent.children).filter(
        (sib) => sib !== node && sib.tagName === node.tagName && sib.className === node.className
      );
      if (shapeSiblings.length >= 1) return node;
      node = parent;
    }
    return el.parentElement || el;
  }

  // No taught selector to re-find a recorded job's title element by, so
  // instead this builds a one-time index of "normalized own text -> small
  // elements with that text" for the whole page, then looks up each
  // recorded title in it. Cheaper than testing every recorded job against
  // every element individually. Skips elements with more than a couple of
  // element children so it only ever matches small, label-like leaves —
  // never a whole card/container (which would always "contain" the text
  // too, but isn't what we want the card-root walk to start from).
  function buildTextIndex() {
    const index = new Map();
    const candidates = document.querySelectorAll('a, span, div, h1, h2, h3, h4, h5, p, li, button, td, strong, b, label');
    for (const el of candidates) {
      if (el.children.length > 2) continue;
      const text = normalizeText(el.textContent);
      if (!text || text.length > 200) continue;
      if (!index.has(text)) index.set(text, []);
      index.get(text).push(el);
    }
    return index;
  }

  function markRecordedJobsOnPage() {
    const known = getKnownApplications();
    if (!known.length) return;
    const index = buildTextIndex();
    for (const job of known) {
      const titleEls = index.get(normalizeText(job.title));
      if (!titleEls) continue;
      for (const titleEl of titleEls) {
        const card = findCardRoot(titleEl);
        if (card.dataset.lextStatus === STATUS_APPLIED) continue;
        if (job.company && !normalizeText(card.textContent).includes(normalizeText(job.company))) continue;
        card.dataset.lextStatus = STATUS_APPLIED;
        markApplied(card, job.date);
        applyVisibility(card);
      }
    }
  }

  // Whether the current page itself (not necessarily a list of cards) is
  // about a job already recorded — e.g. you've come back to a detail page
  // you applied from before. A plain whole-page text check rather than the
  // card-matching above, since a lone detail page usually isn't shaped
  // like a repeating list item findCardRoot() could bound sensibly.
  function findKnownApplicationOnPage() {
    const known = getKnownApplications();
    if (!known.length) return null;
    const pageText = normalizeText(document.body.textContent);
    for (const job of known) {
      const title = normalizeText(job.title);
      if (title.length < 3 || !pageText.includes(title)) continue;
      if (job.company && !pageText.includes(normalizeText(job.company))) continue;
      return job;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Recording flow: click the floating button, click the job title, click
  // the company name, optionally pick a CV, save. Each step is a plain
  // left-click pick — no menu, no teaching, nothing persisted about *how*
  // to find these elements again, just the text of *this* application.
  // ---------------------------------------------------------------------

  let recordStep = null; // null | 'title' | 'company' | 'confirm'
  let hoveredEl = null;
  let toolbarEl = null;
  let fabEl = null;
  let pickedTitleEl = null;
  let pickedTitle = '';
  let pickedCompany = '';
  let pickedCompanyUrl = '';

  function clearHighlight() {
    if (hoveredEl) hoveredEl.classList.remove('lext-record-hover');
    hoveredEl = null;
  }

  function onMouseOver(e) {
    if (recordStep !== 'title' && recordStep !== 'company') return;
    if (toolbarEl && toolbarEl.contains(e.target)) return;
    clearHighlight();
    hoveredEl = e.target;
    hoveredEl.classList.add('lext-record-hover');
  }

  function onClick(e) {
    if (!recordStep) return;
    if (toolbarEl && toolbarEl.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();

    if (recordStep === 'title') {
      pickedTitleEl = e.target;
      pickedTitle = e.target.textContent.replace(/\s+/g, ' ').trim();
      if (!pickedTitle) return;
      clearHighlight();
      recordStep = 'company';
      renderToolbar();
    } else if (recordStep === 'company') {
      pickedCompany = e.target.textContent.replace(/\s+/g, ' ').trim();
      if (!pickedCompany) return;
      const link = firstLink(e.target);
      pickedCompanyUrl = link ? link.href.split('?')[0] : '';
      clearHighlight();
      recordStep = 'confirm';
      renderToolbar();
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && recordStep) cancelRecording();
  }

  function cancelRecording() {
    recordStep = null;
    clearHighlight();
    toolbarEl?.remove();
    toolbarEl = null;
    pickedTitleEl = null;
    pickedTitle = '';
    pickedCompany = '';
    pickedCompanyUrl = '';
  }

  function saveRecording(cvVersion) {
    const jobId = jobIdFor(pickedTitle, pickedCompany);
    const titleUrl = location.href.split('?')[0];

    chrome.runtime.sendMessage(
      {
        type: 'JOB_SEEN',
        jobId,
        status: STATUS_APPLIED,
        source: SITE_KEY,
        title: pickedTitle,
        titleUrl,
        company: pickedCompany,
        companyUrl: pickedCompanyUrl,
        cvVersion,
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn(`LinkedIn Opera Applets (${SITE_KEY}): sendMessage failed`, chrome.runtime.lastError.message);
        }
      }
    );

    appliedIds.add(jobId);
    chrome.storage.local.set({ [APPLIED_STORAGE_KEY]: Array.from(appliedIds) });

    recordedJobs.push({ source: SITE_KEY, title: pickedTitle, company: pickedCompany, date: todayDisplay() });
    if (recordedJobs.length > MAX_RECORDED_JOBS) recordedJobs = recordedJobs.slice(-MAX_RECORDED_JOBS);
    chrome.storage.local.set({ [RECORDED_JOBS_KEY]: recordedJobs });

    if (pickedTitleEl) {
      const card = findCardRoot(pickedTitleEl);
      card.dataset.lextStatus = STATUS_APPLIED;
      markApplied(card);
      applyVisibility(card);
    }

    cancelRecording();
  }

  function renderToolbar() {
    toolbarEl?.remove();
    toolbarEl = document.createElement('div');
    toolbarEl.className = 'lext-record-toolbar';

    if (recordStep === 'title') {
      const label = document.createElement('span');
      label.textContent = 'Click the job title on the page';
      toolbarEl.appendChild(label);
    } else if (recordStep === 'company') {
      const label = document.createElement('span');
      label.textContent = `"${pickedTitle}" — now click the company name`;
      toolbarEl.appendChild(label);
    } else if (recordStep === 'confirm') {
      const summary = document.createElement('span');
      summary.className = 'lext-record-summary';
      summary.textContent = `${pickedTitle} — ${pickedCompany}`;
      toolbarEl.appendChild(summary);

      let cvSelect = null;
      if (settings.cvPickerEnabled) {
        cvSelect = document.createElement('select');
        cvSelect.className = 'lext-cv-picker';
        addOption(cvSelect, 'CV: not selected', '');
        chrome.storage.local.get({ cvList: [] }, ({ cvList }) => {
          for (const { label, code } of cvList) addOption(cvSelect, label, code);
        });
        toolbarEl.appendChild(cvSelect);
      }

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        saveRecording(cvSelect ? cvSelect.value : undefined);
      });
      toolbarEl.appendChild(saveBtn);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancelRecording();
    });
    toolbarEl.appendChild(cancelBtn);

    document.body.appendChild(toolbarEl);
  }

  function startRecording() {
    if (recordStep) return;
    recordStep = 'title';
    renderToolbar();
  }

  function ensureFab() {
    if (!settings.showRecordButton) {
      fabEl?.remove();
      fabEl = null;
      return;
    }
    if (!fabEl) {
      fabEl = document.createElement('button');
      fabEl.type = 'button';
      fabEl.className = 'lext-record-fab';
      fabEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startRecording();
      });
      document.body.appendChild(fabEl);
    }

    // Reflect whether this page is about a job already in the tracker —
    // doesn't block re-recording (a reposted job is a legitimate reason
    // to record it again), just surfaces the date so you don't have to
    // wonder or go check the spreadsheet.
    if (recordStep) return; // don't relabel the button mid-flow
    const known = findKnownApplicationOnPage();
    fabEl.classList.toggle('lext-record-fab-done', !!known);
    if (known) {
      fabEl.textContent = '✓ Already applied';
      fabEl.title = `Applied${known.date ? ' on ' + known.date : ''} to "${known.title}"${known.company ? ' at ' + known.company : ''}. Click to record again.`;
    } else {
      fabEl.textContent = '📌 Record application';
      fabEl.title = '';
    }
  }

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);

  // ---------------------------------------------------------------------

  function reapplyVisibility() {
    document.querySelectorAll('[data-lext-status]').forEach(applyVisibility);
  }

  function scanAll() {
    markRecordedJobsOnPage();
    ensureFab();
  }

  let scanDebounce = null;
  function scheduleScan() {
    clearTimeout(scanDebounce);
    scanDebounce = setTimeout(scanAll, 700);
  }

  chrome.storage.local.get(
    {
      hideApplied: false,
      showRecordButton: true,
      cvPickerEnabled: true,
      [APPLIED_STORAGE_KEY]: [],
      [RECORDED_JOBS_KEY]: [],
      appliedIndex: [],
    },
    (res) => {
      settings = {
        hideApplied: res.hideApplied,
        showRecordButton: res.showRecordButton,
        cvPickerEnabled: res.cvPickerEnabled,
      };
      appliedIds = new Set(res[APPLIED_STORAGE_KEY]);
      recordedJobs = res[RECORDED_JOBS_KEY] || [];
      appliedIndex = res.appliedIndex || [];
      scanAll();
    }
  );

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scanAll, 8000);

  const SETTINGS_KEYS = ['hideApplied', 'showRecordButton', 'cvPickerEnabled'];
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let relevant = false;
    for (const key of SETTINGS_KEYS) {
      if (changes[key]) {
        settings[key] = changes[key].newValue;
        relevant = true;
      }
    }
    if (relevant) {
      reapplyVisibility();
      ensureFab();
    }
    if (changes[RECORDED_JOBS_KEY]) {
      recordedJobs = changes[RECORDED_JOBS_KEY].newValue || [];
      scanAll();
    }
    if (changes.appliedIndex) {
      appliedIndex = changes.appliedIndex.newValue || [];
      scanAll();
    }
  });
})();

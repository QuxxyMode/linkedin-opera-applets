(function () {
  const SOURCE = 'Indeed';
  const STORAGE_KEY = 'indeedAppliedJobIds';

  // Indeed has no "you applied to this" state of its own to read back — our
  // own button click is the only source of truth, tracked locally so the
  // button/badges stay correct across reloads and across the list + detail
  // views (which render the same job independently).
  let appliedIds = new Set();

  // Shared with content.js's LinkedIn side — one "hide already-applied
  // jobs" toggle in the popup covers both sites.
  let settings = { hideApplied: false };

  function extractJobId() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('vjk') || params.get('jk');
    if (fromUrl) return fromUrl;
    // The "Indeed Apply" widget (when present) carries the job key directly
    // as a data attribute — more reliable than hunting through hrefs, since
    // this button sometimes has no navigable href at all (it's a JS widget).
    const applyWidget = document.querySelector('[data-indeed-apply-jk]');
    if (applyWidget) return applyWidget.getAttribute('data-indeed-apply-jk');
    // Last resort: any nearby link/attribute carrying "jk=<id>".
    const el = document.querySelector('[href*="jk="]');
    if (el) {
      const m = (el.getAttribute('href') || '').match(/[?&]jk=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    return null;
  }

  // The title renders as `<span>Title<span>- job post</span></span>` — clone
  // and strip the nested span so the suffix (locale-dependent: "- job post",
  // "- oferta de empleo", etc.) doesn't end up in the recorded title.
  function extractTitle() {
    const h2 = document.querySelector('h2[data-testid="jobsearch-JobInfoHeader-title"]');
    if (!h2) return '';
    const span = h2.querySelector('span');
    if (!span) return h2.textContent.replace(/\s+/g, ' ').trim();
    const clone = span.cloneNode(true);
    clone.querySelectorAll('span').forEach((s) => s.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  function extractCompany() {
    const el = document.querySelector('[data-testid="inlineHeader-companyName"] a');
    if (!el) return { company: '', companyUrl: '' };
    return {
      company: el.textContent.replace(/\s+/g, ' ').trim(),
      companyUrl: el.href ? el.href.split('?')[0] : '',
    };
  }

  function extractLocation() {
    const el = document.querySelector('[data-testid="inlineHeader-companyLocation"]');
    if (!el) return '';
    return el.textContent.replace(/\s+/g, ' ').replace(/•/g, ' · ').trim();
  }

  function buildTitleUrl(jobId) {
    return `https://${location.hostname}/viewjob?jk=${encodeURIComponent(jobId)}`;
  }

  function addOption(select, label, value) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }

  // Which CV was picked in the dropdown next to "Mark as Applied", read at
  // click time — no need to persist it, the button click and the message
  // it sends happen in the same tick.
  let selectedCvByJobId = new Map();

  function sendApplied(jobId) {
    const { company, companyUrl } = extractCompany();
    const info = {
      title: extractTitle(),
      titleUrl: buildTitleUrl(jobId),
      company,
      companyUrl,
      location: extractLocation(),
    };
    chrome.runtime.sendMessage(
      { type: 'JOB_SEEN', jobId, status: 'applied', source: SOURCE, cvVersion: selectedCvByJobId.get(jobId), ...info },
      () => {
        if (chrome.runtime.lastError) {
          console.warn('LinkedIn Opera Applets (Indeed): sendMessage failed', chrome.runtime.lastError.message);
        }
      }
    );
  }

  // Mirrors content.js's picker: a <select> populated from the "List CVs"
  // sheet (cached in storage by background.js), dropped next to the
  // "Mark as Applied" button so you can tag which CV you're sending before
  // clicking it.
  function ensureCvPicker(container, btn, jobId) {
    let picker = container.querySelector('.lext-cv-picker');
    if (!picker) {
      picker = document.createElement('select');
      picker.className = 'lext-cv-picker';
      picker.addEventListener('change', () => {
        const id = picker.dataset.lextJobId;
        if (picker.value) selectedCvByJobId.set(id, picker.value);
        else selectedCvByJobId.delete(id);
      });
      btn.insertAdjacentElement('afterend', picker);
    }

    if (!picker.options.length) {
      chrome.storage.local.get({ cvList: [] }, ({ cvList }) => {
        if (!cvList.length || picker.options.length) return;
        addOption(picker, 'CV: not selected', '');
        for (const { label, code } of cvList) addOption(picker, label, code);
        picker.value = selectedCvByJobId.get(picker.dataset.lextJobId) || '';
      });
    }

    if (picker.dataset.lextJobId !== jobId) {
      picker.dataset.lextJobId = jobId;
      picker.value = selectedCvByJobId.get(jobId) || '';
    }
  }

  function persistApplied(jobId) {
    appliedIds.add(jobId);
    chrome.storage.local.set({ [STORAGE_KEY]: Array.from(appliedIds) });
  }

  function setButtonAppliedState(btn) {
    btn.textContent = '✓ Applied';
    btn.disabled = true;
    btn.classList.add('lext-indeed-applied-done');
  }

  // Indeed's own buttons in this row use content-hashed classes that can
  // change on any deploy, so rather than hardcoding a pixel height, just
  // copy whatever height a real neighboring button is actually rendered
  // at — stays correct even if Indeed changes its own sizing.
  function matchSiblingButtonHeight(container, btn) {
    const sibling = Array.from(container.querySelectorAll('button, a')).find(
      (el) => el !== btn && !el.classList.contains('lext-indeed-applied-btn')
    );
    if (!sibling) return;
    const h = getComputedStyle(sibling).height;
    if (h && h !== '0px') btn.style.height = h;
  }

  // Right beside Indeed's own Apply/Save/Not-interested row — there's no
  // native "mark as applied" affordance on Indeed, so this button is the
  // entire recording mechanism for this site. Indeed renders this row with
  // different inner wrappers depending on the job (plain link vs. the
  // "Indeed Apply" widget, sometimes wrapped in content-hashed div classes
  // with no stable id), but the outer `#jobsearch-ViewJobButtons-container`
  // has held steady across all variants seen so far.
  function ensureAppliedButton() {
    const container = document.querySelector('#jobsearch-ViewJobButtons-container');
    if (!container) return;
    const jobId = extractJobId();
    if (!jobId) return;

    let btn = container.querySelector('.lext-indeed-applied-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lext-indeed-applied-btn';
      btn.textContent = 'Mark as Applied';
      container.appendChild(btn);
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        sendApplied(jobId);
        persistApplied(jobId);
        setButtonAppliedState(btn);
        markRowApplied(jobId);
      });
    }

    matchSiblingButtonHeight(container, btn);
    ensureCvPicker(container, btn, jobId);

    if (appliedIds.has(jobId) && !btn.disabled) {
      setButtonAppliedState(btn);
    }
  }

  // The card itself — `.cardOutline` — is what needs to collapse when
  // hiding; the `<li>` wrapper is the fallback for any layout variant that
  // doesn't use that class.
  function findCard(anchor) {
    return anchor.closest('.cardOutline') || anchor.closest('li');
  }

  function applyCardVisibility(card) {
    card.classList.toggle('lext-hidden', settings.hideApplied);
  }

  // The search-results title anchor carries `data-jk="<id>"` regardless of
  // sponsored/organic rendering — a much more stable hook than Indeed's
  // content-hashed CSS classes.
  function markRowApplied(jobId) {
    document.querySelectorAll('a[data-jk]').forEach((anchor) => {
      if (anchor.getAttribute('data-jk') !== jobId) return;

      if (anchor.parentNode && !anchor.parentNode.querySelector('.lext-aa-badge')) {
        const badge = document.createElement('span');
        badge.className = 'lext-aa-badge';
        badge.textContent = 'AA';
        badge.title = 'Already Applied';
        anchor.parentNode.insertBefore(badge, anchor);
      }

      const card = findCard(anchor);
      if (card) {
        card.dataset.lextApplied = '1';
        applyCardVisibility(card);
      }
    });
  }

  function reapplyVisibility() {
    document.querySelectorAll('[data-lext-applied="1"]').forEach(applyCardVisibility);
  }

  function scanList() {
    if (!appliedIds.size) return;
    document.querySelectorAll('a[data-jk]').forEach((anchor) => {
      const jobId = anchor.getAttribute('data-jk');
      if (jobId && appliedIds.has(jobId)) markRowApplied(jobId);
    });
  }

  function scanAll() {
    ensureAppliedButton();
    scanList();
  }

  let scanDebounce = null;
  function scheduleScan() {
    clearTimeout(scanDebounce);
    scanDebounce = setTimeout(scanAll, 500);
  }

  chrome.storage.local.get({ [STORAGE_KEY]: [], hideApplied: false }, (res) => {
    appliedIds = new Set(res[STORAGE_KEY]);
    settings.hideApplied = res.hideApplied;
    scanAll();
  });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Safety net for Indeed's client-side navigation between list/detail
  // views, which doesn't always trigger a mutation the observer catches.
  setInterval(scanAll, 8000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.hideApplied) return;
    settings.hideApplied = changes.hideApplied.newValue;
    reapplyVisibility();
  });
})();

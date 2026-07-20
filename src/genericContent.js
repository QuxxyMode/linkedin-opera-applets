(function () {
  // Two-part TLDs where the registrable label is one level further up than
  // usual (portal.example.co.uk -> "example", not "co"). Not exhaustive —
  // ponytail: add more here if a taught site's name comes out wrong; a full
  // public-suffix-list dependency is overkill for a personal tool.
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
  const STATUS_VIEWED = 'viewed';
  const WORKPLACE_TYPES = ['Remote', 'Hybrid', 'On-site'];

  function normalizeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // ---------------------------------------------------------------------
  // Element picker ("Learn" mode) — teaches titleSelector/companySelector/
  // workModel/applyAnchorSelector for this site, saved under SITE_KEY.
  // ---------------------------------------------------------------------

  // Filters out hashed/generated class names (content-hashed classes are
  // common on modern sites, LinkedIn's own markup being the extreme case —
  // see content.js) so the built selector has a fighting chance of still
  // matching after the site's next deploy.
  function isStableClass(cls) {
    if (/^_/.test(cls)) return false;
    if (/^[a-z0-9]{6,12}$/i.test(cls)) return false;
    return true;
  }

  function buildSelector(el) {
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const stableClasses = Array.from(el.classList).filter(isStableClass);
    if (stableClasses.length) {
      return `${el.tagName.toLowerCase()}.${stableClasses.map((c) => CSS.escape(c)).join('.')}`;
    }
    return el.tagName.toLowerCase();
  }

  // ponytail: a plain CSS selector, no nth-child disambiguation — good
  // enough while the built-in flash-highlight preview lets you catch a bad
  // (too broad/too narrow) pick immediately; add positional matching if a
  // site's selector keeps grabbing the wrong elements.
  function flashMatches(selector) {
    let matches;
    try {
      matches = document.querySelectorAll(selector);
    } catch (e) {
      return;
    }
    matches.forEach((el) => {
      el.classList.add('lext-learn-flash');
      setTimeout(() => el.classList.remove('lext-learn-flash'), 1200);
    });
  }

  function saveConfig(patch) {
    chrome.storage.local.get({ learnedSites: {} }, ({ learnedSites }) => {
      const existing = learnedSites[SITE_KEY] || {};
      learnedSites[SITE_KEY] = { ...existing, ...patch };
      chrome.storage.local.set({ learnedSites });
    });
  }

  let pickerActive = false;
  let hoveredEl = null;
  let menuEl = null;
  let toolbarEl = null;

  function clearHighlight() {
    if (hoveredEl) hoveredEl.classList.remove('lext-learn-hover');
    hoveredEl = null;
  }

  function removeMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }

  function makeMenu(x, y) {
    const menu = document.createElement('div');
    menu.className = 'lext-learn-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    document.body.appendChild(menu);
    return menu;
  }

  function addMenuItem(menu, label, onClick) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
    });
    menu.appendChild(item);
    return item;
  }

  function showWorkModelSubmenu(x, y, el, selector) {
    removeMenu();
    menuEl = makeMenu(x, y);
    WORKPLACE_TYPES.forEach((label) => {
      addMenuItem(menuEl, label, () => {
        const text = el.textContent.replace(/\s+/g, ' ').trim();
        chrome.storage.local.get({ learnedSites: {} }, ({ learnedSites }) => {
          const existing = learnedSites[SITE_KEY] || {};
          const workModel = existing.workModel || { selector, map: {} };
          workModel.selector = selector;
          workModel.map = { ...workModel.map, [text]: label };
          learnedSites[SITE_KEY] = { ...existing, workModel };
          chrome.storage.local.set({ learnedSites });
        });
        flashMatches(selector);
        removeMenu();
      });
    });
  }

  function showRoleMenu(x, y, el) {
    removeMenu();
    const selector = buildSelector(el);
    menuEl = makeMenu(x, y);

    addMenuItem(menuEl, 'Position', () => {
      saveConfig({ titleSelector: selector });
      flashMatches(selector);
      removeMenu();
    });
    addMenuItem(menuEl, 'Company', () => {
      saveConfig({ companySelector: selector });
      flashMatches(selector);
      removeMenu();
    });
    addMenuItem(menuEl, 'Work Model', () => showWorkModelSubmenu(x, y, el, selector));
  }

  function onMouseOver(e) {
    if (!pickerActive || menuEl) return;
    clearHighlight();
    hoveredEl = e.target;
    hoveredEl.classList.add('lext-learn-hover');
  }

  // Left-click still needs neutralizing while picking (so it doesn't
  // navigate/submit the underlying page), but no longer opens the role
  // menu itself — that's on right-click below, so the browser's own
  // context menu never gets a chance to steal the gesture. Left-click
  // outside an open menu still dismisses it, matching normal dropdown UX.
  function onClick(e) {
    if (!pickerActive) return;
    if (menuEl && menuEl.contains(e.target)) return;
    if (toolbarEl && toolbarEl.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (menuEl) removeMenu();
  }

  function onContextMenu(e) {
    if (!pickerActive) return;
    if (menuEl && menuEl.contains(e.target)) return;
    if (toolbarEl && toolbarEl.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (menuEl) {
      removeMenu();
      return;
    }
    showRoleMenu(e.clientX + window.scrollX, e.clientY + window.scrollY, e.target);
  }

  function stopPicker() {
    pickerActive = false;
    clearHighlight();
    removeMenu();
    document.body.classList.remove('lext-learn-active');
    toolbarEl?.remove();
    toolbarEl = null;
  }

  function startPicker() {
    if (pickerActive) return;
    pickerActive = true;
    document.body.classList.add('lext-learn-active');
    toolbarEl = document.createElement('div');
    toolbarEl.className = 'lext-learn-toolbar';
    const label = document.createElement('span');
    label.textContent = `Learning ${SITE_KEY}: right-click a job title, company, or work model.`;
    toolbarEl.appendChild(label);
    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.textContent = 'Done';
    doneBtn.addEventListener('click', stopPicker);
    toolbarEl.appendChild(doneBtn);
    document.body.appendChild(toolbarEl);
  }

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('contextmenu', onContextMenu, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'START_LEARN') startPicker();
  });

  // ---------------------------------------------------------------------
  // Runtime: apply a previously taught config on every subsequent visit.
  // ---------------------------------------------------------------------

  // Finds the repeating "card" ancestor for a title match: walk up until a
  // level is found where a sibling shares the exact same tag+className —
  // i.e. this element is one of a repeated list. ponytail: assumes cards
  // share an identical className; a site handing out per-item unique
  // classes would defeat this (teach an explicit card selector if that
  // ever comes up).
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

  function firstLink(el) {
    return el.tagName === 'A' ? el : el.querySelector('a');
  }

  function extractInfo(config, titleEl, scope) {
    const titleLink = firstLink(titleEl);
    const title = titleEl.textContent.replace(/\s+/g, ' ').trim() || document.title;
    const titleUrl = (titleLink ? titleLink.href : location.href).split('?')[0];

    let company = '';
    let companyUrl = '';
    if (config.companySelector) {
      const companyEl = scope.querySelector(config.companySelector) || document.querySelector(config.companySelector);
      if (companyEl) {
        company = companyEl.textContent.replace(/\s+/g, ' ').trim();
        const companyLink = firstLink(companyEl);
        companyUrl = companyLink ? companyLink.href.split('?')[0] : '';
      }
    }

    return { title, titleUrl, company, companyUrl };
  }

  function jobIdFor(title, company) {
    return `${normalizeText(title)}::${normalizeText(company)}`;
  }

  function detectWorkModel(config, scope) {
    if (!config.workModel || !config.workModel.selector) return null;
    const el = scope.querySelector(config.workModel.selector);
    if (!el) return null;
    const raw = el.textContent.replace(/\s+/g, ' ').trim();
    return (config.workModel.map && config.workModel.map[raw]) || null;
  }

  let settings = {
    hideApplied: false,
    hideViewed: false,
    hideRemote: false,
    hideHybrid: false,
    hideOnsite: false,
  };

  function shouldHideCard(card) {
    const status = card.dataset.lextStatus;
    if (status === STATUS_APPLIED && settings.hideApplied) return true;
    if (status === STATUS_VIEWED && settings.hideViewed) return true;
    const workplace = card.dataset.lextWorkplace;
    if (workplace === 'Remote' && settings.hideRemote) return true;
    if (workplace === 'Hybrid' && settings.hideHybrid) return true;
    if (workplace === 'On-site' && settings.hideOnsite) return true;
    return false;
  }

  function applyVisibility(card) {
    card.classList.toggle('lext-hidden', shouldHideCard(card));
  }

  function markApplied(card) {
    if (card.dataset.lextAaBadge === '1') return;
    card.dataset.lextAaBadge = '1';
    const badge = document.createElement('span');
    badge.className = 'lext-aa-badge';
    badge.textContent = 'AA';
    badge.title = 'Already Applied';
    card.insertBefore(badge, card.firstChild);
  }

  // Same reasoning as Indeed: no reliable "you already applied" page state
  // to read back on an arbitrary site, so applied jobs are tracked locally
  // by the same title+company key used to send JOB_SEEN.
  const APPLIED_STORAGE_KEY = `genericApplied_${SITE_KEY}`;
  let appliedIds = new Set();

  function sendJobSeen(status, config, titleEl, scope) {
    const info = extractInfo(config, titleEl, scope);
    if (!info.title) return;
    const jobId = jobIdFor(info.title, info.company);
    chrome.runtime.sendMessage(
      { type: 'JOB_SEEN', jobId, status, source: SITE_KEY, ...info },
      () => {
        if (chrome.runtime.lastError) {
          console.warn(`LinkedIn Opera Applets (${SITE_KEY}): sendMessage failed`, chrome.runtime.lastError.message);
        }
      }
    );
    return jobId;
  }

  // Same button under every taught title match — works identically on a
  // list (many matches) and a detail page (one match), so there's no need
  // to separately teach where the site's own Apply button lives.
  function ensureAppliedButton(card, titleEl, jobId) {
    if (titleEl.dataset.lextAppliedBtn === '1') return;
    titleEl.dataset.lextAppliedBtn = '1';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lext-generic-applied-btn';
    if (appliedIds.has(jobId)) {
      btn.textContent = '✓ Applied';
      btn.disabled = true;
    } else {
      btn.textContent = 'Applied';
    }
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      if (!currentConfig) return;
      sendJobSeen(STATUS_APPLIED, currentConfig, titleEl, card);
      appliedIds.add(jobId);
      chrome.storage.local.set({ [APPLIED_STORAGE_KEY]: Array.from(appliedIds) });
      btn.textContent = '✓ Applied';
      btn.disabled = true;
      card.dataset.lextStatus = STATUS_APPLIED;
      markApplied(card);
    });

    const parent = titleEl.parentNode;
    if (!parent) return;
    if (titleEl.nextSibling) parent.insertBefore(btn, titleEl.nextSibling);
    else parent.appendChild(btn);
  }

  // Config keeps growing as teaching happens step by step (Position, then
  // Company, then Work Model...), each save re-triggering a scan. Reading
  // `currentConfig` fresh at click time — rather than closing over
  // whatever config existed when this listener was first bound — means an
  // early bind (e.g. right after just Position was taught) doesn't
  // permanently miss fields taught a moment later; the lextViewedBound
  // guard below only stops re-*binding*, not re-reading config.
  let currentConfig = null;
  const viewedSent = new Set();
  function bindViewedClick(titleEl) {
    if (titleEl.dataset.lextViewedBound === '1') return;
    titleEl.dataset.lextViewedBound = '1';
    titleEl.addEventListener('click', () => {
      if (!currentConfig) return;
      const scope = findCardRoot(titleEl);
      const info = extractInfo(currentConfig, titleEl, scope);
      const jobId = jobIdFor(info.title, info.company);
      if (viewedSent.has(jobId)) return;
      viewedSent.add(jobId);
      sendJobSeen(STATUS_VIEWED, currentConfig, titleEl, scope);
    });
  }

  function scanList(config) {
    if (!config.titleSelector) return;
    currentConfig = config;
    let titleEls;
    try {
      titleEls = document.querySelectorAll(config.titleSelector);
    } catch (e) {
      return;
    }
    titleEls.forEach((titleEl) => {
      const card = findCardRoot(titleEl);
      bindViewedClick(titleEl);

      const workModel = detectWorkModel(config, card);
      if (workModel) card.dataset.lextWorkplace = workModel;

      const info = extractInfo(config, titleEl, card);
      const jobId = jobIdFor(info.title, info.company);
      if (appliedIds.has(jobId)) {
        card.dataset.lextStatus = STATUS_APPLIED;
        markApplied(card);
      }
      ensureAppliedButton(card, titleEl, jobId);
      applyVisibility(card);
    });
  }

  function scanAll() {
    chrome.storage.local.get({ learnedSites: {} }, ({ learnedSites }) => {
      const config = learnedSites[SITE_KEY];
      if (!config) return;
      scanList(config);
    });
  }

  function reapplyVisibility() {
    document.querySelectorAll('[data-lext-status], [data-lext-workplace]').forEach(applyVisibility);
  }

  let scanDebounce = null;
  function scheduleScan() {
    clearTimeout(scanDebounce);
    scanDebounce = setTimeout(scanAll, 700);
  }

  chrome.storage.local.get(
    { ...settings, [APPLIED_STORAGE_KEY]: [] },
    (res) => {
      settings = {
        hideApplied: res.hideApplied,
        hideViewed: res.hideViewed,
        hideRemote: res.hideRemote,
        hideHybrid: res.hideHybrid,
        hideOnsite: res.hideOnsite,
      };
      appliedIds = new Set(res[APPLIED_STORAGE_KEY]);
      scanAll();
    }
  );

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scanAll, 8000);

  const SETTINGS_KEYS = ['hideApplied', 'hideViewed', 'hideRemote', 'hideHybrid', 'hideOnsite'];
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let relevant = false;
    for (const key of SETTINGS_KEYS) {
      if (changes[key]) {
        settings[key] = changes[key].newValue;
        relevant = true;
      }
    }
    if (relevant) reapplyVisibility();
    if (changes.learnedSites) scanAll();
  });
})();

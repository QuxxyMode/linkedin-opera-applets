(function () {
  const STATUS_APPLIED = 'applied';
  const STATUS_VIEWED = 'viewed';

  let settings = {
    hideApplied: false,
    hideViewed: false,
    hideRemote: false,
    hideHybrid: false,
    hideOnsite: false,
    hideUninterestedCompanies: false,
    hiddenCompanies: [],
    cvPickerEnabled: true,
  };
  const WORKPLACE_TYPES = ['Remote', 'Hybrid', 'On-site'];

  // LinkedIn renders the jobs list two different ways depending on which
  // experience the account/experiment bucket is on:
  //  - "AI" layout: a div carrying role="button" plus
  //    componentkey="job-card-component-ref-<jobId>" (no <a href> at all —
  //    title/company are plain text, the whole row is a JS-driven "button").
  //  - Classic/standard layout: an <li data-occludable-job-id="<jobId>"
  //    class="scaffold-layout__list-item"> wrapping a real <a href="/jobs/view/...">
  //    title link — an actual card, not a JS button.
  // Both need to be scanned/hidden the same way, so this selector (and every
  // helper below that reads job id/status/info from a "row") matches either.
  const ROW_SELECTOR =
    '[role="button"][componentkey^="job-card-component-ref-"], li.scaffold-layout__list-item[data-occludable-job-id]';

  // A richer, per-job "expanded" rendering (About the job, Application
  // status, Apply button, Did you finish applying? confirmation, etc.)
  // also uses data-testid="lazy-column"/data-component-type="LazyColumn" in
  // the AI layout — but so does the single wrapper around the *entire*
  // results list (componentkey="SearchResultsMainContent"), which must
  // never be treated as one giant "job card". The classic layout's detail
  // pane has its own container, `.jobs-details__main-content`, with no such
  // ambiguity (it only ever wraps one job).
  const DETAIL_SELECTOR =
    'div[data-testid="lazy-column"][data-component-type="LazyColumn"], .jobs-details__main-content';
  const LIST_CONTAINER_KEY = 'SearchResultsMainContent';

  // Best-known title/company info per job ID, merged in from whichever
  // source (row text or detail hrefs) has seen it, since neither source is
  // guaranteed to have everything on its own.
  const jobInfo = new Map();

  // `${jobId}:${status}` combos already reported to the background this
  // page load, to avoid re-sending on every rescan (background also dedups
  // persistently, this just cuts down on chatter).
  const sentKeys = new Set();

  // Fallback signal for Easy Apply: if the button was present in the
  // detail view a moment ago and is now gone (with no pending-confirmation
  // panel taking its place), LinkedIn flipped the job to Applied outright.
  const seenApplyButtonJobIds = new Set();

  // Reflects list membership only, independent of the hideUninterestedCompanies
  // master toggle — the button manages *membership*, so its label shouldn't
  // flip depending on whether hiding happens to be switched on right now.
  function isCompanyInHiddenList(card) {
    if (!card.dataset.lextCompany) return false;
    const norm = normalizeText(card.dataset.lextCompany);
    return settings.hiddenCompanies.some((c) => normalizeText(c) === norm);
  }

  function shouldHideCard(card) {
    const status = card.dataset.lextStatus;
    if (status === STATUS_APPLIED && settings.hideApplied) return true;
    if (status === STATUS_VIEWED && settings.hideViewed) return true;
    const workplace = card.dataset.lextWorkplace;
    if (workplace === 'Remote' && settings.hideRemote) return true;
    if (workplace === 'Hybrid' && settings.hideHybrid) return true;
    if (workplace === 'On-site' && settings.hideOnsite) return true;
    if (settings.hideUninterestedCompanies && isCompanyInHiddenList(card)) return true;
    return false;
  }

  // Same eye icon either way — greyed out (via CSS) when the company is on
  // the hidden list, full color when it isn't.
  function updateHideCompanyButton(card) {
    const btn = card.querySelector('.lext-hide-company-btn');
    if (!btn) return;
    const hidden = isCompanyInHiddenList(card);
    btn.classList.toggle('lext-company-hidden', hidden);
    btn.title = hidden ? 'Show jobs from this company again' : 'Hide all jobs from this company';
    btn.setAttribute('aria-label', btn.title);
  }

  function applyVisibility(card) {
    card.classList.toggle('lext-hidden', shouldHideCard(card));
    updateHideCompanyButton(card);
  }

  // Workplace type shows up two different ways depending on layout/view:
  // a standalone "Remote"/"Hybrid"/"On-site" pill (both layouts' detail
  // pane, matched by browser exact text against child buttons/links/spans),
  // or a "(Remote)" suffix tacked onto the location text (classic list row,
  // e.g. "United Kingdom (Remote)"). LinkedIn-only — Indeed folds this into
  // freely-worded, localized location text ("Teletrabajo", "Trabajo
  // híbrido in Madrid", "Remote in London...") that isn't safe to pattern-match.
  function detectWorkplaceType(card) {
    for (const el of card.querySelectorAll('span, li, p')) {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      const m = /\((Remote|Hybrid|On-site)\)\s*$/.exec(text);
      if (m) return m[1];
    }
    for (const el of card.querySelectorAll('span, button, a')) {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (WORKPLACE_TYPES.includes(text)) return text;
    }
    return null;
  }

  // Detects workplace type on `card` (a row or a detail pane) and applies
  // it — along with any resulting visibility change — to the actual list
  // row for `jobId`, since that's the element that needs to collapse.
  //
  // Only the detail-pane case caches "checked, found nothing" (on `card`
  // itself, not the row): a detail pane can hold a huge "About the job"
  // block, and running two full querySelectorAll('span,...') passes over it
  // on every rescan (MutationObserver fires constantly while it renders)
  // was heavy enough to make the page janky. A row is small and cheap, so
  // it just keeps retrying every scan until found — needed on pages like
  // /jobs/collections/recommended, which lazily render hundreds of rows:
  // caching "not found" after a scan that landed before the location text
  // was even in the DOM yet would otherwise mean it's never found at all.
  function applyWorkplaceType(card, jobId) {
    const row = findRowById(jobId) || card;
    const isDetailPane = card !== row;
    const alreadyCheckedDetail = isDetailPane && card.dataset.lextWorkplaceChecked === '1';
    if (!row.dataset.lextWorkplace && !alreadyCheckedDetail) {
      const workplace = detectWorkplaceType(card);
      if (workplace) row.dataset.lextWorkplace = workplace;
      if (isDetailPane) card.dataset.lextWorkplaceChecked = '1';
    }
    applyVisibility(row);
  }

  function detectStatus(text) {
    const t = text.replace(/\s+/g, ' ').trim();
    if (/^Applied\b/i.test(t)) return STATUS_APPLIED;
    if (/^Viewed\b/i.test(t)) return STATUS_VIEWED;
    // "Application status: Application submitted" block in the job detail
    // pane — another authoritative signal that the application went through.
    if (/^Application submitted\b/i.test(t)) return STATUS_APPLIED;
    return null;
  }

  function findStatusInCard(card) {
    // Classic list rows carry the Applied/Viewed text in a dedicated <li>,
    // not a <p> — check it first since it's an unambiguous, purpose-built hook.
    const classicStatusEl = card.querySelector('.job-card-container__footer-job-state');
    if (classicStatusEl) {
      const status = detectStatus(classicStatusEl.textContent);
      if (status) return status;
    }
    // Classic detail pane: a green "Applied X ago" success banner appears
    // the instant an Easy Apply completes (and stays there on later
    // visits) — same purpose as the AI layout's "Applied on company site" line.
    const classicAppliedEl = card.querySelector('.artdeco-inline-feedback--success .artdeco-inline-feedback__message');
    if (classicAppliedEl) {
      const status = detectStatus(classicAppliedEl.textContent);
      if (status) return status;
    }
    for (const p of card.querySelectorAll('p')) {
      const status = detectStatus(p.textContent);
      if (status) return status;
    }
    return null;
  }

  function absoluteUrl(href) {
    try {
      return new URL(href, location.href).href.split('?')[0];
    } catch (e) {
      return href;
    }
  }

  function pickLinkWithText(links) {
    return links.find((a) => a.textContent.trim().length > 0) || links[0] || null;
  }

  // LinkedIn sometimes renders a "Verified job" title as two sibling
  // <span> children carrying essentially the same text twice (a plain
  // accessible copy plus a visual copy) — plain .textContent picks up
  // both and duplicates the string. Which sibling actually holds the text
  // and which is left blank is inconsistent, so just take whichever child
  // has the longest own text rather than assuming a fixed position;
  // plain, single-text-node elements (the common case) fall back to the
  // full text untouched.
  function primaryText(el) {
    const full = el.textContent.trim().replace(/\s+/g, ' ');
    if (el.children.length === 0) return full;

    let best = '';
    for (const child of el.children) {
      const t = child.textContent.trim().replace(/\s+/g, ' ');
      if (t.length > best.length) best = t;
    }
    return best || full;
  }

  function extractHrefBasedInfo(card) {
    const companyLinks = Array.from(card.querySelectorAll('a[href*="/company/"]'));
    const companyLink = pickLinkWithText(companyLinks);

    // The company block sometimes contains a nested <a> (logo + name) inside
    // an outer <a> with the same href. The job title link is a separate,
    // later anchor that sits outside that company block entirely.
    const titleLinks = Array.from(card.querySelectorAll('a[href*="/jobs/view/"]')).filter(
      (a) => !a.closest('a[href*="/company/"]')
    );
    const titleLink = pickLinkWithText(titleLinks);

    if (!titleLink && !companyLink) return null;

    // Classic list rows never link the company (plain subtitle text) — pull
    // it from there instead. Same rows *do* carry location right in the
    // list (unlike the AI layout, where it only shows up in the expanded
    // detail pane), so grab it opportunistically here too.
    const classicCompanyEl = !companyLink ? card.querySelector('.artdeco-entity-lockup__subtitle') : null;
    const classicLocationEl = card.querySelector('.artdeco-entity-lockup__caption');

    return {
      title: titleLink ? primaryText(titleLink) : '',
      titleUrl: titleLink ? absoluteUrl(titleLink.href) : '',
      company: companyLink
        ? primaryText(companyLink)
        : classicCompanyEl
        ? classicCompanyEl.textContent.replace(/\s+/g, ' ').trim()
        : '',
      companyUrl: companyLink ? absoluteUrl(companyLink.href) : '',
      location: classicLocationEl ? classicLocationEl.textContent.replace(/\s+/g, ' ').trim() : '',
    };
  }

  // The compact list row has no company href (or location) at all — only
  // the expanded detail view does. If a job gets reported as Applied before
  // that detail view was ever scanned — including in an *earlier* page
  // load/session, since this job may already be Applied from a previous
  // visit — the Excel row can go out with an empty company link/location.
  // Rather than only patching it up within the same session (which misses
  // the cross-session case), just always tell the background about newly
  // discovered fields for a job ID; it already knows how to no-op if
  // there's no matching Applied record to patch.
  const lastNotifiedInfo = new Map();

  // Old Excel rows can have a title/company with no hyperlink at all
  // (recorded before a link was ever available, or by an earlier version of
  // this extension) — background.js keeps a small cache of those (text
  // only, no URLs) in storage; this matches whatever we're currently
  // looking at against it and supplies the missing URL(s) when it's an
  // exact match.
  let missingLinks = [];
  const sentBackfillKeys = new Set();

  function normalizeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function checkLinkBackfill(info) {
    if (!missingLinks.length || !info.title) return;
    const wantTitle = normalizeText(info.title);
    const wantCompany = normalizeText(info.company);

    for (const entry of missingLinks) {
      if ((entry.source || 'LinkedIn') !== 'LinkedIn') continue;
      if (normalizeText(entry.title) !== wantTitle) continue;
      if (entry.company && wantCompany && normalizeText(entry.company) !== wantCompany) continue;

      const canFillTitle = entry.missingTitleUrl && info.titleUrl;
      const canFillCompany = entry.missingCompanyUrl && info.companyUrl;
      const canFillLocation = entry.missingLocation && info.location;
      if (!canFillTitle && !canFillCompany && !canFillLocation) continue;

      const key = `${wantTitle}::${wantCompany}`;
      if (sentBackfillKeys.has(key)) continue;
      sentBackfillKeys.add(key);

      chrome.runtime.sendMessage(
        {
          type: 'LINK_BACKFILL',
          source: 'LinkedIn',
          title: info.title,
          titleUrl: canFillTitle ? info.titleUrl : undefined,
          company: info.company,
          companyUrl: canFillCompany ? info.companyUrl : undefined,
          location: canFillLocation ? info.location : undefined,
        },
        () => {
          if (chrome.runtime.lastError) {
            console.warn('Apply Tracker: link backfill failed', chrome.runtime.lastError.message);
            sentBackfillKeys.delete(key);
          }
        }
      );
    }
  }

  chrome.storage.local.get({ missingLinks: [] }, (res) => {
    missingLinks = res.missingLinks;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.missingLinks) {
      missingLinks = changes.missingLinks.newValue || [];
      sentBackfillKeys.clear();
    }
  });

  function rememberJobInfo(jobId, info) {
    if (!jobId || !info) return;
    const existing = jobInfo.get(jobId) || {};
    // Merge rather than overwrite — don't let a later, worse-quality read
    // (e.g. no hrefs available) clobber good data seen earlier.
    const merged = {
      title: info.title || existing.title || '',
      titleUrl: info.titleUrl || existing.titleUrl || '',
      company: info.company || existing.company || '',
      companyUrl: info.companyUrl || existing.companyUrl || '',
      location: info.location || existing.location || '',
    };
    jobInfo.set(jobId, merged);

    checkLinkBackfill(merged);

    const prevNotified = lastNotifiedInfo.get(jobId) || {};
    if (prevNotified.companyUrl === merged.companyUrl && prevNotified.location === merged.location) return;
    if (!merged.companyUrl && !merged.location) return;
    lastNotifiedInfo.set(jobId, { companyUrl: merged.companyUrl, location: merged.location });

    chrome.runtime.sendMessage({ type: 'JOB_INFO_UPDATE', jobId, source: 'LinkedIn', ...merged }, () => {
      if (chrome.runtime.lastError) {
        console.warn('Apply Tracker: info update failed', chrome.runtime.lastError.message);
      }
    });
  }

  function findRowById(jobId) {
    return (
      document.querySelector(`[role="button"][componentkey="job-card-component-ref-${jobId}"]`) ||
      document.querySelector(`li.scaffold-layout__list-item[data-occludable-job-id="${jobId}"]`)
    );
  }

  // Visual "AA" (Already Applied) tag inserted right before the job title,
  // so an already-applied job stands out in the list at a glance even when
  // "Hide Applied jobs" is off. Independent of whether the job actually
  // gets recorded into Excel (see the `record` option below).
  function findTitleElement(card) {
    const titleLinks = Array.from(card.querySelectorAll('a[href*="/jobs/view/"]')).filter(
      (a) => !a.closest('a[href*="/company/"]')
    );
    const titleLink = pickLinkWithText(titleLinks);
    if (titleLink) return titleLink;
    const paragraphs = Array.from(card.querySelectorAll('p')).filter((p) => !detectStatus(p.textContent));
    return paragraphs[0] || null;
  }

  // LinkedIn's own "Dismiss job" (X) button — both layouts label it this
  // way. Used as the anchor for our own eye icon so it sits right next to
  // it, matching its size, instead of floating near the title.
  function findDismissButton(card) {
    for (const btn of card.querySelectorAll('button')) {
      if (/dismiss/i.test(btn.getAttribute('aria-label') || '')) return btn;
    }
    return null;
  }

  function markAlreadyApplied(card) {
    const titleEl = findTitleElement(card);
    if (!titleEl || !titleEl.parentNode || titleEl.dataset.lextAaBadge === '1') return;
    titleEl.dataset.lextAaBadge = '1';
    const badge = document.createElement('span');
    badge.className = 'lext-aa-badge';
    badge.textContent = 'AA';
    badge.title = 'Already Applied';
    titleEl.parentNode.insertBefore(badge, titleEl);
  }

  // "Hide Company"/"Show Company" toggle (eye icon), placed immediately to
  // the left of LinkedIn's own "Dismiss job" (X) button so it reads as part
  // of the same row of card actions — falls back to next to the title if
  // no dismiss button exists on this layout. Clicking it adds/removes the
  // company (as seen on this row) from the persisted hiddenCompanies list;
  // shouldHideCard() picks up the change via storage.onChanged like every
  // other hide setting, and updateHideCompanyButton() relabels every button
  // for that company. stopPropagation is required: the AI layout's whole
  // row is itself a role="button" that navigates to the job on click.
  // blur() matters too — .lext-hidden:focus-within stays expanded, so
  // without it the row whose button was just clicked would appear to not
  // hide at all while its own button keeps focus.
  function ensureHideCompanyButton(card) {
    if (card.dataset.lextHideCompanyBtn === '1') return;
    const dismissBtn = findDismissButton(card);
    const titleEl = dismissBtn ? null : findTitleElement(card);
    const anchor = dismissBtn || titleEl;
    if (!anchor || !anchor.parentNode) return;
    card.dataset.lextHideCompanyBtn = '1';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lext-hide-company-btn';
    btn.textContent = '👁️';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.blur();
      const company = card.dataset.lextCompany;
      if (!company) return;
      const norm = normalizeText(company);
      chrome.storage.local.get({ hiddenCompanies: [] }, ({ hiddenCompanies }) => {
        const idx = hiddenCompanies.findIndex((c) => normalizeText(c) === norm);
        const next = idx === -1 ? [...hiddenCompanies, company] : hiddenCompanies.filter((_, i) => i !== idx);
        chrome.storage.local.set({ hiddenCompanies: next });
      });
    });
    if (dismissBtn) {
      dismissBtn.parentNode.insertBefore(btn, dismissBtn);
    } else {
      titleEl.parentNode.insertBefore(btn, titleEl.nextSibling);
    }
    updateHideCompanyButton(card);
  }

  // `record: false` still updates the row's visual state (hiding, "AA"
  // badge) but skips sending JOB_SEEN — used when we can't be confident the
  // application actually happened today (see isAppliedToday below), so we
  // don't backfill an old application into Excel under today's date.
  function reportStatus(jobId, status, options = {}) {
    const { record = true } = options;
    if (!jobId) return;

    const row = findRowById(jobId);
    if (row) {
      row.dataset.lextStatus = status;
      applyVisibility(row);
      if (status === STATUS_APPLIED) markAlreadyApplied(row);
    }

    if (!record) return;

    const key = `${jobId}:${status}`;
    if (sentKeys.has(key)) return;

    const info = jobInfo.get(jobId);
    if (!info || (!info.title && !info.company)) return; // retry once extraction succeeds

    sentKeys.add(key);
    chrome.runtime.sendMessage({ type: 'JOB_SEEN', jobId, status, source: 'LinkedIn', cvVersion: selectedCvByJobId.get(jobId), ...info }, () => {
      if (chrome.runtime.lastError) {
        console.warn('Apply Tracker: sendMessage failed', chrome.runtime.lastError.message);
        sentKeys.delete(key);
      }
    });
  }

  // --- Compact list row: AI layout (role="button" + componentkey) or
  // classic layout (<li data-occludable-job-id>) ---

  function extractRowJobId(card) {
    const occludableId = card.getAttribute('data-occludable-job-id');
    if (occludableId) return occludableId;
    const m = (card.getAttribute('componentkey') || '').match(/^job-card-component-ref-(\d+)$/);
    return m ? m[1] : null;
  }

  function extractRowTitleAndCompany(card, jobId) {
    const hrefInfo = extractHrefBasedInfo(card);
    if (hrefInfo) return hrefInfo;

    // No <a href> at all in the compact row — read the first two
    // non-status paragraphs positionally (title, then company) and
    // construct a canonical job URL from the known ID.
    const paragraphs = Array.from(card.querySelectorAll('p')).filter((p) => !detectStatus(p.textContent));
    const title = paragraphs[0] ? primaryText(paragraphs[0]) : '';
    const company = paragraphs[1] ? primaryText(paragraphs[1]) : '';

    return {
      title,
      titleUrl: `https://www.linkedin.com/jobs/view/${jobId}/`,
      company,
      companyUrl: '',
    };
  }

  function scanRow(card) {
    const jobId = extractRowJobId(card);
    if (!jobId) return;

    // Guard against a recycled DOM node carrying a stale mark from a
    // previously rendered, different job.
    if (card.dataset.lextRowJobId !== jobId) {
      delete card.dataset.lextStatus;
      delete card.dataset.lextInfoDone;
      delete card.dataset.lextWorkplace;
      delete card.dataset.lextWorkplaceChecked;
      delete card.dataset.lextCompany;
      delete card.dataset.lextHideCompanyBtn;
      card.dataset.lextRowJobId = jobId;
    }

    // Workplace-type hiding is independent of Applied/Viewed status, and
    // most rows have neither, so this can't wait behind the status
    // early-return below.
    applyWorkplaceType(card, jobId);

    // Extracted once per row (lextInfoDone-gated) regardless of
    // Applied/Viewed status — the "Hide this company" button needs to
    // exist on every row, not just ones with a status to report. Still
    // only runs once per row: cheap for a handful of visible rows, unlike
    // the every-700ms-rescan cost this guard was originally added to avoid.
    if (card.dataset.lextInfoDone !== '1') {
      const info = extractRowTitleAndCompany(card, jobId);
      rememberJobInfo(jobId, info);
      if (info && info.title) card.dataset.lextInfoDone = '1';
      if (info && info.company) {
        card.dataset.lextCompany = info.company;
        ensureHideCompanyButton(card);
      }
    }

    // Applied is terminal for this row *as long as it still reads Applied*
    // — skipping the (re)detection work below is what keeps a virtualized
    // list cheap to rescan on every scroll. But a reposted job can reopen
    // for a fresh application, so if the row no longer shows Applied text,
    // clear the mark (and the send-dedup key) so a new application on the
    // same jobId gets picked up instead of being silently swallowed.
    if (card.dataset.lextStatus === STATUS_APPLIED) {
      if (findStatusInCard(card) === STATUS_APPLIED) return;
      delete card.dataset.lextStatus;
      sentKeys.delete(`${jobId}:${STATUS_APPLIED}`);
      applyVisibility(card); // no longer Applied — undo any status-based hiding
      card.querySelector('.lext-aa-badge')?.remove();
      const titleEl = findTitleElement(card);
      if (titleEl) delete titleEl.dataset.lextAaBadge;
    }

    // (title/company extraction already happened above, unconditionally)
    const status = findStatusInCard(card);
    if (!status) return;

    // The compact row carries no timing info at all, so an "Applied" row
    // encountered here could be from today or from months ago — don't log
    // it to Excel from this signal alone (still tag/hide it visually).
    // scanDetail can confirm same-day recency once its detail pane is open;
    // the direct "Yes"-click confirmation path records immediately either way.
    reportStatus(jobId, status, { record: status !== STATUS_APPLIED });
  }

  // --- Expanded/detail rendering (About the job, Apply button, confirmations) ---

  function extractDetailJobId(card) {
    const idEl = card.querySelector('[data-job-id], [data-occludable-job-id]');
    if (idEl) {
      return idEl.getAttribute('data-job-id') || idEl.getAttribute('data-occludable-job-id');
    }
    const link = card.querySelector('a[href*="/jobs/view/"]');
    if (link) {
      const m = link.href.match(/\/jobs\/view\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  // Best-effort "was this actually applied today" check for a passively
  // detected Applied status (a job encountered already-applied while
  // browsing, not a transition we witnessed this session) — we always
  // stamp Excel rows with today's date, so we don't want to backfill a job
  // applied last week just because it scrolled into view. The "Application
  // status" block renders "Applied on company site" (or similar) followed
  // by a sibling paragraph with a relative time: "now" / "23m" / "4h" for
  // same-day, switching to day/week/month/year units afterwards.
  function isAppliedToday(card) {
    // Classic detail pane: the time is embedded in the same string —
    // "Applied 4 seconds ago" / "Applied 3 days ago" — rather than a
    // separate sibling element.
    const classicAppliedEl = card.querySelector('.artdeco-inline-feedback--success .artdeco-inline-feedback__message');
    if (classicAppliedEl) {
      const text = classicAppliedEl.textContent.replace(/\s+/g, ' ').trim();
      const m = /^Applied\s+(?:just\s+now|(\d+)\s*([a-z]+))/i.exec(text);
      if (m) return !m[1] || /^(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.test(m[2]);
      return false; // "Applied" text present but time format unrecognized — be conservative
    }
    for (const p of card.querySelectorAll('p')) {
      const text = p.textContent.replace(/\s+/g, ' ').trim();
      if (detectStatus(text) !== STATUS_APPLIED) continue;
      const timeP = p.nextElementSibling;
      if (!timeP || timeP.tagName !== 'P') continue;
      const timeText = timeP.textContent.replace(/\s+/g, ' ').trim();
      if (/^now$/i.test(timeText)) return true;
      const m = /^(\d+)\s*([a-z]+)/i.exec(timeText);
      if (!m) return false; // unrecognized format — be conservative
      return /^(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.test(m[2]);
    }
    return false; // no "Applied ... <relative time>" pair found — be conservative
  }

  // The location line in the expanded detail pane looks like
  // "Ghent, Flemish Region, Belgium · 5 days ago · 16 people clicked apply"
  // — a plain paragraph with segments joined by a middle dot ("·"). Class
  // names on this site are content-hashed and unstable across deploys, so
  // rather than matching a specific class, just grab the paragraph that
  // contains a middle dot and take the segment before the first one,
  // skipping segments that are themselves a status/relative-time/promo
  // line (e.g. "Promoted by hirer · ...").
  function extractDetailLocation(card) {
    // Classic detail pane: "Switzerland · 44 minutes ago · 3 applicants" (plus
    // a further "Promoted by hirer · ..." line nested inside the same
    // container) all live in one dedicated element — the first "·"-segment
    // is reliably the location regardless of what follows.
    const classicEl = card.querySelector('.job-details-jobs-unified-top-card__tertiary-description-container');
    if (classicEl) {
      const text = classicEl.textContent.replace(/\s+/g, ' ').trim();
      const firstPart = text.split('·')[0].trim();
      if (firstPart) return firstPart;
    }
    for (const p of card.querySelectorAll('p')) {
      const text = p.textContent.replace(/\s+/g, ' ').trim();
      if (!text.includes('·') || detectStatus(text)) continue;
      const firstPart = text.split('·')[0].trim();
      if (!firstPart || /^\d/.test(firstPart) || /^(promoted|reposted)\b/i.test(firstPart)) continue;
      return firstPart;
    }
    return '';
  }

  function findApplyButton(card) {
    // The external "Apply" action is an <a> (opens the employer's site in
    // a new tab), not a <button> — Easy Apply is a real <button>.
    const candidates = card.querySelectorAll('button, [role="button"], a');
    for (const el of candidates) {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (/^(easy apply|apply)$/i.test(text)) return el;
      const label = (el.getAttribute('aria-label') || '').trim();
      if (/^(easy apply|apply)\b/i.test(label)) return el;
    }
    return null;
  }

  function addOption(select, label, value) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }

  // Which CV you picked for a given job, kept in memory only (page
  // lifetime, not persisted) — set from the picker's change handler below,
  // read back in reportStatus() once the application actually lands.
  const selectedCvByJobId = new Map();

  // A <select> dropped right under LinkedIn's own Apply/Easy Apply button,
  // so you can tag which CV you're about to send *before* clicking it.
  // Population is async (cvList lives in storage, refreshed from the
  // "List CVs" sheet every couple minutes), so this is safe to call on
  // every scan — it no-ops once already populated for the current job.
  function ensureCvPicker(applyButton, jobId) {
    if (!settings.cvPickerEnabled) return;
    // The Apply button's own wrapper div is sized to fit just that one
    // pill-shaped button (fixed height) — a block element dropped inside
    // it gets silently clipped out of view instead of pushing the wrapper
    // taller. Anchor to the row holding *all* the action buttons (Apply,
    // Save, ...) instead, so the picker lands in the card's normal
    // document flow below them, with real space to render in.
    const buttonWrapper = applyButton.parentElement || applyButton;
    const row = buttonWrapper.parentElement || buttonWrapper;
    let picker = row.parentNode && row.parentNode.querySelector(':scope > .lext-cv-picker');
    if (!picker) {
      picker = document.createElement('select');
      picker.className = 'lext-cv-picker';
      picker.addEventListener('click', (e) => e.stopPropagation());
      picker.addEventListener('change', () => {
        const id = picker.dataset.lextJobId;
        if (picker.value) selectedCvByJobId.set(id, picker.value);
        else selectedCvByJobId.delete(id);
      });
    }
    // Re-assert position on every scan, not just at creation — LinkedIn's
    // React re-renders these buttons on its own schedule and doesn't know
    // about this extra sibling, so a one-time insertAdjacentElement can
    // get silently reshuffled to the wrong spot later.
    if (picker.previousElementSibling !== row) {
      row.insertAdjacentElement('afterend', picker);
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

  // After clicking the external "Apply" button, LinkedIn doesn't mark the
  // job as Applied yet — it shows a "Did you finish applying?" panel (the
  // job sits under "In progress" in the tracker) and only counts it once
  // the user confirms with "Yes". That confirmation panel renders inside
  // the same expanded card, so we can bind directly to its "Yes" link.
  function hasPendingConfirmation(card) {
    for (const p of card.querySelectorAll('p')) {
      if (/^Did you finish applying\?/i.test(p.textContent.replace(/\s+/g, ' ').trim())) {
        return true;
      }
    }
    return false;
  }

  function findYesConfirmLink(card) {
    for (const el of card.querySelectorAll('a, button, [role="button"]')) {
      if (/^yes$/i.test(el.textContent.replace(/\s+/g, ' ').trim())) return el;
    }
    return null;
  }

  function bindYesConfirmation(card, jobId) {
    const yesLink = findYesConfirmLink(card);
    if (!yesLink || yesLink.dataset.lextYesBound === '1') return;
    yesLink.dataset.lextYesBound = '1';
    yesLink.addEventListener('click', () => {
      seenApplyButtonJobIds.delete(jobId);
      reportStatus(jobId, STATUS_APPLIED);
    });
  }

  function scanDetail(card) {
    if (card.getAttribute('componentkey') === LIST_CONTAINER_KEY) return; // the whole list, not a job

    const jobId = extractDetailJobId(card);
    if (!jobId) return;

    if (card.dataset.lextDetailJobId !== jobId) {
      delete card.dataset.lextDetailStatus;
      delete card.dataset.lextWorkplaceChecked;
      card.dataset.lextDetailJobId = jobId;
    }

    applyWorkplaceType(card, jobId);

    // Applied is terminal for this detail view *as long as it still reads
    // Applied* — see the matching comment in scanRow for why a reposted job
    // needs this to be reversible rather than a one-way gate.
    if (card.dataset.lextDetailStatus === STATUS_APPLIED) {
      if (findStatusInCard(card) === STATUS_APPLIED) return;
      delete card.dataset.lextDetailStatus;
      sentKeys.delete(`${jobId}:${STATUS_APPLIED}`);
    }

    // Keep retrying while companyUrl/location are still missing — the
    // row-list path has neither, so the detail view is often the only
    // place they can ever come from.
    const knownInfo = jobInfo.get(jobId);
    if (!knownInfo?.companyUrl) {
      rememberJobInfo(jobId, extractHrefBasedInfo(card));
    }
    if (!knownInfo?.location) {
      const location = extractDetailLocation(card);
      if (location) rememberJobInfo(jobId, { location });
    }

    const textStatus = findStatusInCard(card);
    const pending = hasPendingConfirmation(card);

    if (pending) {
      // Waiting on the user to click "Yes" — do not count this as applied
      // yet, just make sure the click is being listened for.
      bindYesConfirmation(card, jobId);
    }

    const applyButton = findApplyButton(card);
    const buttonPresent = !!applyButton;
    if (buttonPresent) {
      seenApplyButtonJobIds.add(jobId);
      ensureCvPicker(applyButton, jobId);
    }

    let status = textStatus;
    // True only for a status pulled straight from static "Applied" text on
    // this scan — i.e. we're not the ones who witnessed it happen (that
    // path goes through the seenApplyButtonJobIds branch below, or the
    // direct "Yes"-click handler, both of which are same-session and
    // therefore inherently "today").
    let passivelyDetectedApplied = status === STATUS_APPLIED;
    if (!status && !buttonPresent && !pending && seenApplyButtonJobIds.has(jobId)) {
      seenApplyButtonJobIds.delete(jobId);
      status = STATUS_APPLIED;
      passivelyDetectedApplied = false;
    }

    if (status) {
      card.dataset.lextDetailStatus = status;
      const record = !passivelyDetectedApplied || isAppliedToday(card);
      reportStatus(jobId, status, { record });
    }
  }

  function scanAll() {
    document.querySelectorAll(ROW_SELECTOR).forEach(scanRow);
    document.querySelectorAll(DETAIL_SELECTOR).forEach(scanDetail);
  }

  function reapplyVisibility() {
    document.querySelectorAll('[data-lext-status], [data-lext-workplace], [data-lext-company]').forEach(applyVisibility);
  }

  let scanDebounce = null;
  function scheduleScan() {
    clearTimeout(scanDebounce);
    scanDebounce = setTimeout(scanAll, 700);
  }

  chrome.storage.local.get(settings, (res) => {
    settings = res;
    scanAll();
  });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Safety net for LinkedIn's client-side routing / virtualized re-renders.
  // Cheap now that resolved rows/cards short-circuit immediately, but still
  // kept infrequent since it runs regardless of any actual DOM activity.
  setInterval(scanAll, 8000);

  const SETTINGS_KEYS = [
    'hideApplied',
    'hideViewed',
    'hideRemote',
    'hideHybrid',
    'hideOnsite',
    'hideUninterestedCompanies',
    'hiddenCompanies',
    'cvPickerEnabled',
  ];
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
    if (changes.cvPickerEnabled && !changes.cvPickerEnabled.newValue) {
      document.querySelectorAll('.lext-cv-picker').forEach((el) => el.remove());
    }
  });
})();

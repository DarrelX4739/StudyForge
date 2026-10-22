/**
 * StudyForge — interface
 *
 * Hash routes:
 *   #/                 dashboard (classes + study kits)
 *   #/kit/<id>                   a study kit: add PDFs / pasted text, see resources
 *   #/kit/<id>/documents        study documents
 *   #/kit/<id>/questions        practice questions
 *   #/kit/<id>/flashcards       flashcard deck
 *   #/kit/<id>/exam             timed practice exam
 *   #/resource/<id>             one resource: study document
 *
 * Rendering is a full rebuild of #view on store changes; user drafts in
 * textareas are captured and restored around it so typing is never lost.
 */
(function (StudyForge) {
  "use strict";

  const store = StudyForge.store;
  const md = StudyForge.md;
  const jobs = StudyForge.jobs;
  const esc = md.escapeHtml;

  const KIT_TABS = ["resources", "documents", "questions", "flashcards", "exam"];

  const STATUS_LABEL = {
    queued: "Queued",
    processing: "Processing",
    ready: "Ready",
    error: "Failed",
  };

  let els = {};
  let route = { name: "dashboard", id: null };
  let filterClassId = null;
  let query = "";
  let editingDocId = null;
  let docViewId = null;
  // Set by the browser when the app is installable; consumed by Settings.
  let installPrompt = null;

  // Set when the dashboard asks to jump into a due-card review.
  let pendingDueReview = null;

  // Read-aloud state for the study guide (uses the browser's own voices).
  let speechState = { speaking: false, resourceId: null };

  // Reading comfort: text size (remembered) and a distraction-free mode.
  const DOC_SIZES = [0.88, 0.96, 1.06, 1.18];
  function readDocSize() {
    const stored = Number(localStorage.getItem("studyforge.docsize"));
    return DOC_SIZES.includes(stored) ? stored : 0.96;
  }
  function setDocSize(size) {
    const clamped = Math.min(Math.max(size, DOC_SIZES[0]), DOC_SIZES[DOC_SIZES.length - 1]);
    try {
      localStorage.setItem("studyforge.docsize", String(clamped));
    } catch (error) {
      /* private mode */
    }
    const body = els.view.querySelector("[data-doc-body]");
    if (body) body.style.fontSize = `${clamped}rem`;
  }

  // Quiz run. One question at a time: the answer is locked and marked the
  // moment "Next" is pressed, and everything is saved when the quiz is
  // submitted at the end.
  let quizState = {
    kitId: null,
    status: "idle", // idle | running | finished
    index: 0,
    phase: "answering", // answering | marking | marked
    answers: {}, // index -> { choice } | { text }
    results: {}, // index -> { correct, score, feedback, markedBy, expected, given }
    startedAt: 0,
    questionStartedAt: 0,
    attempt: null,
  };
  // Flashcard deck position, kept per kit while the tab is open.
  let flashState = {
    kitId: null,
    index: 0,
    flipped: false,
    order: null,
    known: {},
    again: {},
    shuffled: false,
    typing: false,
    typed: "",
    typedVerdict: null,
    finished: false,
    lastScheduled: null,
  };
  // Which classes / kits are open in the sidebar tree.
  const sidebarOpen = { classes: new Set(), kits: new Set() };
  let lastSidebarRoute = "";
  // Timed exam session. Lives in memory only: reloading the page abandons a run.
  let examState = { kitId: null, status: "idle", answers: {}, startedAt: 0, endsAt: 0, secondsUsed: 0 };
  let renderQueued = false;
  // Where the reader was in each study guide, so coming back lands in the same place.
  const docScroll = {};
  let pendingReprocessId = null;
  let lastQuizKey = null;
  // Cached model catalogue for the Settings selector (per page load).
  const modelCache = { models: [], loadedAt: 0 };

  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------ *
   * Inline icons (stroke, currentColor) — no external dependency.
   * ------------------------------------------------------------------ */

  const ICONS = {
    home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-5H9v5H5a1 1 0 0 1-1-1Z"/>',
    kits: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9h16M9 5v14"/>',
    folder: '<path d="M4 7a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    cards: '<rect x="4" y="6" width="12" height="14" rx="2"/><path d="M9 3h9a2 2 0 0 1 2 2v11"/>',
    book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v14H6.5A1.5 1.5 0 0 0 5 19.5Z"/><path d="M5 19.5A1.5 1.5 0 0 1 6.5 18H19v3H6.5A1.5 1.5 0 0 1 5 19.5Z"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    download: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 19h14"/>',
    upload: '<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M5 19h14"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z"/>',
    moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
    arrowLeft: '<path d="M15 5l-7 7 7 7"/>',
    arrowRight: '<path d="M9 5l7 7-7 7"/>',
    quiz: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.2-1 .8-1 1.4v.3"/><path d="M12 16.8h.01"/>',
    flame: '<path d="M12 3c3.4 3.4 5 5.9 5 8.6A5 5 0 0 1 7 11.8C7 9 8.7 6.5 12 3Z"/><path d="M12 20a2.4 2.4 0 0 1-2.4-2.4c0-1.4 1-2.4 2.4-4 1.4 1.6 2.4 2.6 2.4 4A2.4 2.4 0 0 1 12 20Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
  };

  function icon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
      ICONS[name] || ""
    }</svg>`;
  }

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function relativeTime(iso) {
    if (!iso) return "never";
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "unknown";
    const diff = Math.round((then - Date.now()) / 1000);
    const units = [
      ["year", 31536000],
      ["month", 2592000],
      ["week", 604800],
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
    ];
    for (const [unit, seconds] of units) {
      if (Math.abs(diff) >= seconds) {
        const value = Math.round(diff / seconds);
        const formatted = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(value, unit);
        return formatted;
      }
    }
    return "just now";
  }

  const plural = (count, singular, pluralForm = singular + "s") =>
    `${count} ${count === 1 ? singular : pluralForm}`;

  function firstLine(text, fallback = "Pasted text") {
    const line = String(text).split("\n").map((part) => part.trim()).find(Boolean);
    if (!line) return fallback;
    return line.length > 70 ? line.slice(0, 67).trimEnd() + "…" : line;
  }

  function fileTitle(name) {
    return name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim() || name;
  }

  function navigate(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, "");
    const parts = hash.split("/").filter(Boolean);
    if (parts[0] === "kit" && parts[1]) {
      const tab = KIT_TABS.includes(parts[2]) ? parts[2] : "resources";
      route = { name: "kit", id: parts[1], tab };
    } else if (parts[0] === "resource" && parts[1]) {
      route = { name: "resource", id: parts[1] };
    } else {
      route = { name: "dashboard", id: null };
    }
  }

  function resetDeck(kitId) {
    flashState = {
      kitId,
      index: 0,
      flipped: false,
      order: null,
      known: {},
      again: {},
      shuffled: false,
      showList: false,
      reviewMode: false,
      dueOnly: false,
      hardMode: false,
      hardList: null,
      typing: false,
      typed: "",
      typedVerdict: null,
      finished: false,
      lastScheduled: null,
    };
  }

  function resetExam(kitId) {
    examState = { kitId, status: "idle", answers: {}, startedAt: 0, endsAt: 0, secondsUsed: 0 };
  }

  function resetQuiz(kitId) {
    quizState = {
      kitId,
      status: "idle",
      index: 0,
      phase: "answering",
      answers: {},
      results: {},
      startedAt: 0,
      attempt: null,
    };
  }

  /* An unfinished quiz is kept on this device so a reload or an accidental
     tab close never throws away answers. Only the run in progress is stored. */
  const QUIZ_DRAFT_KEY = "studyforge.quizdraft.v1";

  function saveQuizDraft() {
    if (quizState.status !== "running" || !quizState.kitId) return;
    if (quizState.phase === "marking") return;
    try {
      localStorage.setItem(
        QUIZ_DRAFT_KEY,
        JSON.stringify({
          kitId: quizState.kitId,
          index: quizState.index,
          phase: quizState.phase,
          answers: quizState.answers,
          results: quizState.results,
          startedAt: quizState.startedAt,
          items: quizState.items,
          retry: quizState.retry,
          savedAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      /* Private mode or a full quota — the quiz still works, it just cannot resume. */
    }
  }

  function readQuizDraft(kitId) {
    try {
      const raw = localStorage.getItem(QUIZ_DRAFT_KEY);
      if (!raw) return null;
      const draft = JSON.parse(raw);
      if (!draft || draft.kitId !== kitId || !draft.answers) return null;
      return draft;
    } catch (error) {
      return null;
    }
  }

  function clearQuizDraft() {
    try {
      localStorage.removeItem(QUIZ_DRAFT_KEY);
    } catch (error) {
      /* ignore */
    }
  }

  function resumeQuiz(draft) {
    quizState = {
      kitId: draft.kitId,
      status: "running",
      index: Math.max(0, Number(draft.index) || 0),
      phase: draft.phase === "marked" ? "marked" : "answering",
      answers: draft.answers || {},
      results: draft.results || {},
      startedAt: draft.startedAt || Date.now(),
      questionStartedAt: Date.now(),
      attempt: null,
      items: Array.isArray(draft.items) ? draft.items : null,
      retry: Boolean(draft.retry),
    };
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast("Picked up where you left off.");
  }

  /* The timed exam is kept the same way, because losing a paper to a reload is
     a horrible way to learn that a clock was running. */
  const EXAM_KEY = "studyforge.exam.v1";

  function saveExamDraft() {
    if (examState.status !== "running" || !examState.kitId) return;
    try {
      localStorage.setItem(
        EXAM_KEY,
        JSON.stringify({
          kitId: examState.kitId,
          answers: examState.answers,
          startedAt: examState.startedAt,
          endsAt: examState.endsAt,
        }),
      );
    } catch (error) {
      /* storage is optional here */
    }
  }

  function readExamDraft(kitId) {
    try {
      const raw = localStorage.getItem(EXAM_KEY);
      if (!raw) return null;
      const draft = JSON.parse(raw);
      if (!draft || draft.kitId !== kitId) return null;
      return draft;
    } catch (error) {
      return null;
    }
  }

  function clearExamDraft() {
    try {
      localStorage.removeItem(EXAM_KEY);
    } catch (error) {
      /* ignore */
    }
  }

  /** Deck order: natural, or a stable shuffle stored in flashState.order. */
  function deckOrder(kit) {
    const total = kit.flashcards ? kit.flashcards.items.length : 0;
    if (!total) return [];
    if (flashState.hardMode) {
      const hardest = flashState.hardList && flashState.hardList.length ? flashState.hardList : hardestCards(kit);
      if (hardest.length) return hardest;
      flashState.hardMode = false;
    }
    if (flashState.reviewMode) {
      const now = Date.now();
      const ratings = (kit.flashcards && kit.flashcards.ratings) || {};
      const inMode = kit.flashcards.items
        .map((card, index) => ({ card, index }))
        .filter(({ card }) => {
          const rating = ratings[cardKey(card)];
          if (flashState.dueOnly) return !rating || new Date(rating.dueAt).getTime() <= now;
          return rating && rating.state === "again";
        })
        .map(({ index }) => index);
      if (inMode.length) return inMode;
      flashState.reviewMode = false;
      flashState.dueOnly = false;
    }
    if (!flashState.order || flashState.order.length !== total) {
      flashState.order = Array.from({ length: total }, (_, index) => index);
    }
    return flashState.order;
  }

  function formatClock(seconds) {
    const safe = Math.max(0, Math.ceil(seconds));
    const minutes = Math.floor(safe / 60);
    const rest = safe % 60;
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function examSecondsLeft() {
    if (examState.status !== "running") return 0;
    return Math.max(0, Math.ceil((examState.endsAt - Date.now()) / 1000));
  }

  /**
   * StudyForge always has a working engine: the on-device one. This used to
   * demand an API key; now it only exists so call sites stay readable.
   */
  function requireKey() {
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function captureDrafts() {
    const drafts = {};
    let focusKey = null;
    for (const el of els.view.querySelectorAll("[data-draft]")) {
      drafts[el.dataset.draft] = el.value;
      if (document.activeElement === el) focusKey = el.dataset.draft;
    }
    return { drafts, focusKey };
  }

  function restoreDrafts(snapshot) {
    if (!snapshot) return;
    for (const [key, value] of Object.entries(snapshot.drafts)) {
      const el = els.view.querySelector(`[data-draft="${key}"]`);
      if (el) el.value = value;
    }
    if (snapshot.focusKey) {
      const el = els.view.querySelector(`[data-draft="${snapshot.focusKey}"]`);
      if (el) {
        el.focus();
        el.setSelectionRange?.(el.value.length, el.value.length);
      }
    }
  }

  function render() {
    parseRoute();
    // Focus mode only makes sense while reading a guide.
    if (document.body.classList.contains("doc-focus") && !(route.name === "kit" && route.tab === "documents")) {
      document.body.classList.remove("doc-focus");
    }
    const snapshot = captureDrafts();
    els.view.innerHTML = "";

    if (route.name === "kit") {
      const kit = store.getKit(route.id);
      if (kit && route.id !== lastQuizKey) {
        // Fresh kit: reset in-page interactions so answers and the document
        // picker do not leak between kits.
        lastQuizKey = route.id;
        resetQuiz(route.id);
        docViewId = null;
        resetDeck(route.id);
        if (examState.kitId !== route.id) resetExam(route.id);
      }
      if (kit && pendingDueReview === kit.id && route.tab === "flashcards") {
        pendingDueReview = null;
        flashState.reviewMode = true;
        flashState.dueOnly = true;
        flashState.index = 0;
        flashState.flipped = false;
      }
      els.view.appendChild(
        kit ? renderKit(kit, route.tab) : renderMissing("That study kit no longer exists."),
      );
    } else if (route.name === "resource") {
      const resource = store.getResource(route.id);
      els.view.appendChild(resource ? renderResource(resource) : renderMissing("That resource no longer exists."));
    } else {
      els.view.appendChild(renderDashboard());
    }

    restoreDrafts(snapshot);
    restoreDocScroll();
    renderSidebar();
    renderStorage();
    renderProviderBadge();
  }

  /** Guides remember the reader's place per document. */
  function restoreDocScroll() {
    if (route.name !== "kit" || route.tab !== "documents") return;
    const panel = els.view.querySelector("[data-doc-body]");
    if (!panel) return;
    const key = `${route.id}:${docViewId || "first"}`;
    const saved = docScroll[key];
    if (!saved || saved < 40) return;
    try {
      window.scrollTo(0, saved);
    } catch (error) {
      /* fine in tests */
    }
  }

  function renderMissing(message) {
    const wrap = document.createElement("div");
    wrap.className = "page";
    wrap.innerHTML = `
      <div class="empty">
        <h2>Not found</h2>
        <p class="muted">${esc(message)}</p>
        <a class="btn primary" href="#/">Back to dashboard</a>
      </div>`;
    return wrap;
  }

  function navRow({ action, id = "", label, iconName, count, active, cls = "" }) {
    return `<button class="nav-item ${active ? "active" : ""} ${cls}" data-action="${action}" data-id="${esc(
      id,
    )}" title="${esc(label)}">
      <span class="nav-icon">${icon(iconName)}</span>
      <span class="nav-text">${esc(label)}</span>
      ${count === undefined || count === null ? "" : `<span class="count">${count}</span>`}
    </button>`;
  }

  /** The four study modes inside every kit, in the order the sidebar shows them. */
  const KIT_SECTIONS = [
    { tab: "documents", label: "Study guide", iconName: "book" },
    { tab: "flashcards", label: "Flashcards", iconName: "cards" },
    { tab: "questions", label: "Quiz", iconName: "quiz" },
    { tab: "exam", label: "Practice test", iconName: "clock" },
  ];

  function kitNav(kit, state) {
    const open = sidebarOpen.kits.has(kit.id);
    const onKit = route.name === "kit" && route.id === kit.id;
    const counts = {
      documents: store.resourcesInKit(kit.id).filter((resource) => resource.document).length,
      flashcards: kit.flashcards ? kit.flashcards.items.length : 0,
      questions: kit.quiz ? kit.quiz.items.length : 0,
      exam: kit.exam ? kit.exam.items.length : 0,
    };
    return `
      <button class="nav-item nav-kit ${open ? "open" : ""} ${onKit ? "current" : ""}"
        data-action="toggle-kit" data-id="${esc(kit.id)}"
        aria-expanded="${open}" title="${esc(kit.name)}">
        <span class="nav-caret">${icon("chevron")}</span>
        <span class="nav-icon">${icon("kits")}</span>
        <span class="nav-text">${esc(kit.name)}</span>
        <span class="count">${plural(counts.questions + counts.flashcards, "item")}</span>
      </button>
      ${
        open
          ? `<div class="nav-children nav-sections">
              ${KIT_SECTIONS.map((section) => {
                const active = onKit && route.tab === section.tab;
                return `<a class="nav-leaf ${active ? "active" : ""}" href="#/kit/${esc(kit.id)}/${section.tab}">
                  <span class="nav-icon">${icon(section.iconName)}</span>
                  <span class="nav-text">${esc(section.label)}</span>
                  <span class="count">${counts[section.tab]}</span>
                </a>`;
              }).join("")}
            </div>`
          : ""
      }`;
  }

  function classNav(cls, kits) {
    const open = sidebarOpen.classes.has(cls.id);
    return `
      <div class="nav-tree ${open ? "open" : ""}">
        <button class="nav-item nav-class" data-action="toggle-class" data-id="${esc(cls.id)}"
          aria-expanded="${open}" title="${esc(cls.name)}">
          <span class="nav-caret">${icon("chevron")}</span>
          <span class="nav-icon">${icon("folder")}</span>
          <span class="nav-text">${esc(cls.name)}</span>
          <span class="count">${kits.length}</span>
        </button>
        ${
          open
            ? `<div class="nav-children">
                ${
                  kits.length
                    ? kits.map((kit) => kitNav(kit, cls)).join("")
                    : `<p class="nav-empty">No kits yet</p>`
                }
                <button class="nav-item nav-add" data-action="new-kit-in-class" data-id="${esc(cls.id)}" title="New kit in ${esc(cls.name)}">
                  <span class="nav-icon">${icon("plus")}</span>
                  <span class="nav-text">New kit</span>
                </button>
              </div>`
            : ""
        }
      </div>`;
  }

  function renderSidebar() {
    const state = store.get();
    const totalKits = state.kits.length;
    const onDashboard = route.name === "dashboard";

    // When the page changes, reveal the kit being viewed and its class. Only
    // on a route change, so the user can still collapse them afterwards.
    const routeKey = `${route.name}:${route.id || ""}:${route.tab || ""}`;
    if (routeKey !== lastSidebarRoute) {
      lastSidebarRoute = routeKey;
      if (route.name === "kit") {
        const kit = store.getKit(route.id);
        if (kit) {
          sidebarOpen.kits.add(kit.id);
          if (kit.classId) sidebarOpen.classes.add(kit.classId);
        }
      }
    }

    const uncategorised = state.kits.filter((kit) => !kit.classId);

    els.nav.innerHTML = `
      <div class="nav-group">
        <div class="nav-label">Overview</div>
        ${navRow({
          action: "filter-class",
          label: "Dashboard",
          iconName: "home",
          count: totalKits,
          active: onDashboard && !filterClassId,
        })}
      </div>
      <div class="nav-group">
        <div class="nav-label-row">
          <span class="nav-label">Classes</span>
          <button class="icon-btn tiny" data-action="new-class" title="New class" aria-label="New class">
            ${icon("plus")}
          </button>
        </div>
        ${
          state.classes.length
            ? state.classes
                .map((cls) => classNav(cls, state.kits.filter((kit) => kit.classId === cls.id)))
                .join("")
            : `<p class="nav-empty">No classes yet — create one to group your kits.</p>`
        }
        ${
          uncategorised.length
            ? `<div class="nav-tree open">
                <div class="nav-subhead">Uncategorised</div>
                <div class="nav-children">${uncategorised.map((kit) => kitNav(kit, null)).join("")}</div>
              </div>`
            : ""
        }
        <button class="nav-item nav-add" data-action="new-class" title="New class">
          <span class="nav-icon">${icon("plus")}</span>
          <span class="nav-text">New class</span>
        </button>
      </div>
      <div class="nav-group">
        <div class="nav-label">Data</div>
        <button class="nav-item" data-action="show-shortcuts" title="Keyboard shortcuts">
          <span class="nav-icon">${icon("keyboard")}</span>
          <span class="nav-text">Shortcuts</span>
        </button>
        <button class="nav-item" data-action="export-backup" title="Export a backup">
          <span class="nav-icon">${icon("download")}</span>
          <span class="nav-text">Export backup</span>
        </button>
        <button class="nav-item" data-action="import-backup" title="Import a backup">
          <span class="nav-icon">${icon("upload")}</span>
          <span class="nav-text">Import backup</span>
        </button>
      </div>`;

    const summary = document.getElementById("user-meta-line");
    if (summary) {
      summary.textContent = `${plural(totalKits, "kit")} · ${plural(state.resources.length, "resource")}`;
    }
  }

  /**
   * Topbar chip: which engine will write the next study guide.
   * Local is a first-class state here, not an error.
   */
  function renderProviderBadge() {
    const slot = $("provider-slot");
    if (!slot) return;
    const info = StudyForge.ai.providerInfo();
    const enabled = StudyForge.ai.isAiEnabled();
    const local = info.kind === "local";
    const label = local ? "On-device engine" : enabled ? info.label : `${info.label} — key needed`;
    slot.innerHTML = `
      <button class="engine-chip ${local ? "local" : enabled ? "ai" : "offline"}" data-action="open-settings"
        title="${esc(local ? "Generation runs in this browser — no key needed" : `${esc(info.label)} is connected`)}">
        <span class="engine-dot"></span>
        <span class="engine-label">${esc(label)}</span>
      </button>`;
  }

  function renderStorage() {
    const bytes = store.storageBytes();
    const limit = 5 * 1024 * 1024;
    const percent = Math.min(100, Math.round((bytes / limit) * 100));
    const error = store.getStorageError();
    els.storage.innerHTML = `
      <div class="storage-row"><span>Local storage</span><strong>${(bytes / 1024).toFixed(0)} KB</strong></div>
      <div class="meter"><span style="width:${percent}%"></span></div>
      ${error ? '<p class="tiny danger">Storage is full — export a backup and delete old resources.</p>' : ""}`;
  }

  /* ------------------------------------------------------------------ *
   * Sample kit
   * ------------------------------------------------------------------ */

  const DEMO_TEXT = `Photosynthesis is the process by which green plants convert light energy into chemical energy stored in glucose.

Chlorophyll: the green pigment inside chloroplasts that absorbs light energy.

- Mitochondria — the organelles where aerobic respiration releases energy from glucose.
- Osmosis — the movement of water across a semi-permeable membrane from a low solute concentration to a high one.

Carbon dioxide and water are the raw materials of photosynthesis, and oxygen is released as a by-product. The light-dependent reactions happen in the thylakoid membranes, while the Calvin cycle fixes carbon in the stroma.

Cellular respiration is the process that releases energy from glucose in the mitochondria. Respiration produces ATP, which powers most cellular work, and it happens in three stages: glycolysis, the Krebs cycle and the electron transport chain.

Enzymes are proteins that speed up chemical reactions by lowering activation energy. Enzyme activity is affected by temperature and pH, and each enzyme has an optimum where its rate is highest.

Diffusion is the net movement of particles from a region of high concentration to a region of low concentration. Osmosis is a special case of diffusion that only involves water.

Active transport is the movement of substances against a concentration gradient, and it requires energy in the form of ATP.`;

  /** One-click starter kit so the first run is never an empty page. */
  function createDemoKit() {
    if (!StudyForge.local.hasUsableText(DEMO_TEXT)) return null;
    let cls = store.get().classes.find((item) => item.name === "Biology");
    if (!cls) cls = store.addClass("Biology");
    const kit = store.addKit({ name: "Cells & Transport", classId: cls.id, subject: "Sample kit" });
    const resource = store.addResource({ kitId: kit.id, name: "Sample notes", type: "text" });
    store.setResourceDocument(resource.id, StudyForge.local.buildStudyDocument({
      name: "Cells & Transport",
      subject: "Sample kit",
      text: DEMO_TEXT,
    }));
    store.updateResource(resource.id, { status: "ready", statusMessage: "Sample notes ready." });
    // Build the set straight from the document — instant, no job queue noise.
    try {
      const questions = StudyForge.local.buildQuestions({ text: DEMO_TEXT, count: 8 });
      store.setKitQuiz(kit.id, {
        generatedAt: new Date().toISOString(),
        items: questions,
        sourceCount: 1,
        sourceNames: ["Sample notes"],
        coverage: [{ id: resource.id, name: "Sample notes", requested: 8, produced: questions.length }],
        failures: [],
        engine: "local",
      });
      const cards = StudyForge.local.buildFlashcards({ text: DEMO_TEXT, count: 12, style: "vocab" }).map((card) => ({
        ...card,
        source: "Sample notes",
      }));
      store.setKitFlashcards(kit.id, {
        generatedAt: new Date().toISOString(),
        items: cards,
        style: "vocab",
        engine: "local",
        sourceCount: 1,
        sourceNames: ["Sample notes"],
        coverage: [{ id: resource.id, name: "Sample notes", requested: 12, produced: cards.length }],
        failures: [],
      });
    } catch (error) {
      console.warn("[StudyForge] Sample kit partially built:", error);
    }
    return { kit, cls };
  }

  /* ------------------------------ dashboard ------------------------ */

  function renderDashboard() {
    const state = store.get();
    const page = document.createElement("div");
    page.className = "page";

    const matches = (kit) => {
      if (!query) return true;
      const needle = query.toLowerCase();
      if (kit.name.toLowerCase().includes(needle)) return true;
      if (kit.subject.toLowerCase().includes(needle)) return true;
      // Also match card prompts/answers and quiz questions, so search finds the
      // topic rather than only the kit that happens to hold it.
      const cards = (kit.flashcards && kit.flashcards.items) || [];
      if (cards.some((card) => `${card.front} ${card.back}`.toLowerCase().includes(needle))) return true;
      const questions = (kit.quiz && kit.quiz.items) || [];
      if (questions.some((item) => String(item.question || "").toLowerCase().includes(needle))) return true;
      return state.resources.some(
        (resource) =>
          resource.kitId === kit.id &&
          (resource.name.toLowerCase().includes(needle) ||
            // Search inside generated guides too, not just titles.
            (resource.document && resource.document.toLowerCase().includes(needle))),
      );
    };

    const visibleKits = state.kits.filter(matches);
    const classes = filterClassId ? state.classes.filter((cls) => cls.id === filterClassId) : state.classes;
    const uncategorised = visibleKits.filter((kit) => !kit.classId);

    const quizCount = state.kits.filter((kit) => kit.quiz).length;
    const cardCount = state.kits.reduce(
      (total, kit) => total + (kit.flashcards ? kit.flashcards.items.length : 0),
      0,
    );
    const attempts = state.kits.reduce(
      (total, kit) => total + (kit.quiz && kit.quiz.attempts ? kit.quiz.attempts.length : 0),
      0,
    );
    const secondsStudied = state.kits.reduce(
      (total, kit) =>
        total + ((kit.quiz && kit.quiz.attempts) || []).reduce((sum, attempt) => sum + (attempt.secondsUsed || 0), 0),
      0,
    );
    const best = state.kits.reduce((top, kit) => {
      const bestAttempt = ((kit.quiz && kit.quiz.attempts) || []).reduce(
        (value, attempt) => Math.max(value, attempt.percent),
        0,
      );
      return Math.max(top, bestAttempt);
    }, 0);

    page.innerHTML = `
      <header class="page-head">
        <div class="page-title">
          <p class="eyebrow">${filterClassId ? "Class" : "Study library"}</p>
          <h1>${esc(filterClassId ? (store.getClass(filterClassId) || {}).name || "Study kits" : "Study kits")}</h1>
        </div>
        <div class="row tight">
          <button class="btn" data-action="new-class">New class</button>
          <button class="btn primary" data-action="new-kit">New study kit</button>
        </div>
      </header>
      <p class="page-sub">Turn your PDFs and notes into study guides, flashcards, quizzes and practice tests — every attempt is saved so you can watch yourself improve.</p>
      ${state.kits.length === 0 ? renderEmptyDashboard() : ""}
      ${
        state.kits.length && query && !visibleKits.length
          ? `<div class="empty">
              <h3>No matches for “${esc(query)}”</h3>
              <p class="muted">Search looks at kit names, subjects, resource names and study-guide text.</p>
              <button class="btn" data-action="clear-search">Clear search</button>
            </div>`
          : ""
      }
      ${renderStreakStrip(state)}
      ${renderBackupNudge(state)}
      ${renderDuePanel(state)}
      ${renderWeekStrip(state)}
      ${renderExamCountdowns(state)}
      ${renderContinueCard(state)}
      ${
        state.kits.length
          ? `<div class="stat-strip">
              <div class="stat"><span class="stat-value">${state.kits.length}</span><span class="stat-label">Study kits</span></div>
              <div class="stat"><span class="stat-value">${cardCount}</span><span class="stat-label">Flashcards</span></div>
              <div class="stat"><span class="stat-value">${attempts}</span><span class="stat-label">Quiz attempts</span></div>
              <div class="stat"><span class="stat-value">${formatMinutes(secondsStudied)}</span><span class="stat-label">Time in quizzes</span></div>
              <div class="stat accent"><span class="stat-value">${attempts ? `${best}%` : "—"}</span><span class="stat-label">Best quiz score</span></div>
            </div>`
          : ""
      }
      <div class="stack">
        ${classes
          .map((cls) => {
            const kits = visibleKits.filter((kit) => kit.classId === cls.id);
            if (!kits.length && query) return "";
            return `
              <section class="class-group">
                <header class="class-head">
                  <div class="row tight">
                    <h2>${esc(cls.name)}</h2>
                    <span class="count">${state.kits.filter((kit) => kit.classId === cls.id).length}</span>
                  </div>
                  <div class="row tight">
                    <button class="btn ghost small" data-action="rename-class" data-id="${esc(cls.id)}">Rename</button>
                    <button class="btn ghost small" data-action="delete-class" data-id="${esc(cls.id)}">Delete</button>
                  </div>
                </header>
                ${
                  kits.length
                    ? `<div class="grid">${kits.map(renderKitCard).join("")}</div>`
                    : `<p class="muted small">No kits in this class yet.</p>`
                }
              </section>`;
          })
          .join("")}
        ${
          uncategorised.length
            ? `<section class="class-group">
                <header class="class-head"><div class="row tight"><h2>Uncategorised</h2><span class="count">${uncategorised.length}</span></div></header>
                <div class="grid">${uncategorised.map(renderKitCard).join("")}</div>
              </section>`
            : ""
        }
        ${
          state.kits.length && !visibleKits.length
            ? `<div class="empty"><h2>No matches</h2><p class="muted">Nothing matches “${esc(query)}”.</p></div>`
            : ""
        }
      </div>`;
    return page;
  }

  /** Total cards waiting for review across the library, with a one-click start. */
  function dueAcrossKits(state) {
    const now = Date.now();
    let total = 0;
    let best = null;
    for (const kit of state.kits) {
      const deck = kit.flashcards;
      if (!deck || !deck.items.length) continue;
      const ratings = deck.ratings || {};
      let due = 0;
      for (const card of deck.items) {
        const rating = ratings[cardKey(card)];
        if (!rating || new Date(rating.dueAt).getTime() <= now) due += 1;
      }
      if (due > 0) {
        total += due;
        if (!best || due > best.due) best = { kit, due };
      }
    }
    return { total, best };
  }

  function renderDuePanel(state) {
    if (!state.kits.length || query || filterClassId) return "";
    const { total, best } = dueAcrossKits(state);
    if (!total || !best) return "";
    const upcoming = state.kits.reduce(
      (sum, kit) => sum + (kit.flashcards ? (store.deckSchedule(kit.id).later || 0) : 0),
      0,
    );
    return `
      <section class="due-panel">
        <div class="due-copy">
          <span class="due-figure">${total}</span>
          <div>
            <strong>${total === 1 ? "card is" : "cards are"} due for review</strong>
            <p class="muted tiny">Most come from ${esc(best.kit.name)}.${
              upcoming ? ` ${upcoming} more come back within a week.` : ""
            } A few minutes now keeps everything fresh.</p>
          </div>
        </div>
        <button class="btn primary small" data-action="review-all-due" data-id="${esc(best.kit.id)}">Review now</button>
      </section>`;
  }

  /**
   * How the next seven days of revision look: one chip per day with the number
   * of cards coming back, today highlighted.
   */
  function renderWeekStrip(state) {
    if (!state.kits.length || query || filterClassId) return "";
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const buckets = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const date = new Date(start.getTime() + offset * 86400000);
      buckets.push({
        date,
        key: store.dayKey(date),
        label: offset === 0 ? "Today" : date.toLocaleDateString(undefined, { weekday: "short" }),
        count: 0,
      });
    }
    for (const kit of state.kits) {
      const deck = kit.flashcards;
      if (!deck) continue;
      const ratings = deck.ratings || {};
      for (const card of deck.items) {
        const rating = ratings[cardKey(card)];
        if (!rating) {
          buckets[0].count += 1;
          continue;
        }
        const key = store.dayKey(new Date(rating.dueAt));
        const bucket = buckets.find((entry) => entry.key === key);
        if (bucket) bucket.count += 1;
      }
    }
    const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    if (!total) return "";
    return `
      <section class="week-strip" aria-label="Revision coming up this week">
        <span class="week-label">Next 7 days</span>
        ${buckets
          .map(
            (bucket, index) => `
              <span class="week-day ${bucket.count ? "has" : ""} ${index === 0 ? "today" : ""}">
                <span class="week-day-name">${esc(bucket.label)}</span>
                <span class="week-day-count">${bucket.count || "—"}</span>
              </span>`,
          )
          .join("")}
      </section>`;
  }

  /** "4m" / "1h 20m" / "—" for the dashboard stats. */
  function formatMinutes(seconds) {
    if (!seconds) return "—";
    const minutes = Math.round(seconds / 60);
    if (minutes < 1) return "<1m";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  /** Monday-based week with the days that already have activity on them. */
  function weekProgress(goal) {
    const activity = store.get().activity || {};
    const todayKey = store.dayKey();
    const now = new Date();
    const mondayOffset = (now.getDay() + 6) % 7; // Monday = 0
    const days = [];
    let done = 0;
    for (let index = 0; index < 7; index += 1) {
      const date = new Date(now.getTime() + (index - mondayOffset) * 86400000);
      const key = store.dayKey(date);
      const entry = activity[key] || {};
      const studied = Object.values(entry).some((value) => Number(value) > 0);
      if (studied) done += 1;
      days.push({
        key,
        label: date.toLocaleDateString(undefined, { weekday: "long" }),
        done: studied,
        today: key === todayKey,
        future: key > todayKey,
      });
    }
    // Days still to come this week count towards the goal, past ones do not.
    const remaining = days.filter((day) => day.future).length;
    return { done, days, goal, remaining, onTrack: done + remaining >= goal };
  }

  /**
   * Everything lives in this browser, so a backup is the only thing between the
   * learner and a cleared cache. Nudge quietly after two weeks.
   */
  function renderBackupNudge(state) {
    if (!state.kits.length) return "";
    const last = state.settings && state.settings.lastBackupAt;
    const days = last ? (Date.now() - new Date(last).getTime()) / 86400000 : Infinity;
    if (days < 14) return "";
    return `
      <div class="notice subtle backup-nudge">
        <span>${last ? "Your last backup was a while ago." : "You have not backed up this library yet."}
          Everything is stored in this browser only.</span>
        <button class="btn small" data-action="export-backup">Download backup</button>
      </div>`;
  }

  /** Upcoming exam dates across the library, soonest first. */
  function renderExamCountdowns(state) {
    if (query) return "";
    const upcoming = state.kits
      .map((kit) => ({ kit, when: examCountdown(kit) }))
      .filter((entry) => entry.when && !entry.when.past)
      .sort((a, b) => a.when.days - b.when.days)
      .slice(0, 3);
    if (!upcoming.length) return "";
    return `
      <div class="exam-strip">
        ${upcoming
          .map(
            ({ kit, when }) => `
          <a class="exam-strip-item" href="#/kit/${esc(kit.id)}/flashcards">
            <span class="exam-strip-days">${when.days === 0 ? "Today" : `${when.days}d`}</span>
            <span class="exam-strip-main">
              <strong>${esc(kit.name)}</strong>
              <span class="muted tiny">${esc(when.label)}${
                when.perDay ? ` · ${when.perDay} cards a day` : ""
              }</span>
            </span>
          </a>`,
          )
          .join("")}
      </div>`;
  }

  /** Streak + a two-week heat strip, so momentum is visible at a glance. */
  function renderStreakStrip(state) {
    if (!state.kits.length || query) return "";
    const streak = store.streakInfo();
    const days = store.activityDays(14);
    const hasAny = days.some((day) => day.total > 0);
    if (!streak.current && !hasAny) {
      return `
        <section class="streak-strip quiet">
          <span class="streak-flame">🔥</span>
          <div class="streak-copy">
            <strong>Start a streak today</strong>
            <span class="muted tiny">Rate a flashcard or finish a quiz and your streak begins.</span>
          </div>
        </section>`;
    }
    const goal = store.getSettings().weeklyGoal || 5;
    const week = weekProgress(goal);
    return `
      <section class="streak-strip">
        <span class="streak-flame">${streak.days ? "🔥" : "🌱"}</span>
        <div class="streak-copy">
          <strong>${streak.current} day${streak.current === 1 ? "" : "s"} in a row</strong>
          <span class="muted tiny">${
            streak.days
              ? "Today counts. Keep it going."
              : "Study today to keep the streak alive."
          }${streak.best > streak.current ? ` · best ${streak.best}` : ""}</span>
        </div>
        <div class="week-goal" title="${week.done} of ${goal} days studied this week">
          <span class="week-goal-days">${week.days
            .map(
              (day) =>
                `<span class="goal-dot ${day.done ? "done" : ""} ${day.today ? "today" : ""}" title="${esc(day.label)}${
                  day.done ? " · studied" : ""
                }"></span>`,
            )
            .join("")}</span>
          <span class="muted tiny">${week.done}/${goal} days this week</span>
        </div>
        <div class="heat-strip" role="img" aria-label="Study activity over the last 14 days">
          ${days
            .map(
              (day) =>
                `<span class="heat-cell level-${day.level}" title="${esc(day.date)} · ${
                  day.total ? `${day.total} actions` : "no activity"
                }"></span>`,
            )
            .join("")}
        </div>
      </section>`;
  }

  /** One-click way back into whatever was studied most recently. */
  function renderContinueCard(state) {
    if (!state.kits.length || query || filterClassId) return "";
    const recent = [...state.kits].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    if (!recent) return "";
    const hasQuiz = Boolean(recent.quiz);
    const hasCards = Boolean(recent.flashcards);
    const hasGuide = store.resourcesInKit(recent.id).some((resource) => resource.document);
    if (!hasQuiz && !hasCards && !hasGuide) return "";
    const attempt = recent.quiz && recent.quiz.attempts && recent.quiz.attempts[0];
    return `
      <section class="continue-card">
        <div class="continue-main">
          <span class="pill accent">Pick up where you left off</span>
          <h3>${esc(recent.name)}</h3>
          <p class="muted tiny">
            Updated ${esc(relativeTime(recent.updatedAt))}${
              attempt ? ` · last quiz ${attempt.percent}%` : ""
            }${recent.subject ? ` · ${esc(recent.subject)}` : ""}
          </p>
        </div>
        <div class="row tight">
          ${hasGuide ? `<a class="btn small" href="#/kit/${esc(recent.id)}/documents">Study guide</a>` : ""}
          ${hasCards ? `<a class="btn small" href="#/kit/${esc(recent.id)}/flashcards">Flashcards</a>` : ""}
          ${hasQuiz ? `<a class="btn small primary" href="#/kit/${esc(recent.id)}/questions">Quiz</a>` : ""}
        </div>
      </section>`;
  }

  function renderEmptyDashboard() {
    return `
      <div class="empty hero">
        <h2>Create your first study kit</h2>
        <p class="muted">A study kit holds resources — PDFs or pasted text. StudyForge forges each one into a study guide, then writes flashcards, a quiz and a practice test from it. Quiz attempts are saved so you can track your progress.</p>
        <div class="row center">
          <button class="btn primary" data-action="new-kit">New study kit</button>
          <button class="btn" data-action="new-class">New class</button>
          <button class="btn" data-action="load-demo">Try a sample kit</button>
        </div>
        <p class="tiny muted">The sample kit builds a guide, a flashcard deck and an 8-question quiz on the spot — no key, no setup.</p>
      </div>`;
  }

  function renderKitCard(kit) {
    const resources = store.resourcesInKit(kit.id);
    const ready = resources.filter((resource) => resource.status === "ready").length;
    const cls = kit.classId ? store.getClass(kit.classId) : null;
    const counts = [];
    if (kit.quiz) counts.push(plural(kit.quiz.items.length, "question"));
    const quizAttempts = (kit.quiz && kit.quiz.attempts) || [];
    const bestAttempt = quizAttempts.reduce((top, attempt) => Math.max(top, attempt.percent), 0);
    if (kit.flashcards) counts.push(plural(kit.flashcards.items.length, "card"));
    if (kit.exam) counts.push(`${kit.exam.items.length}-question exam`);

    const status = ready
      ? `${plural(ready, "resource")} ready`
      : resources.length
        ? "No study documents yet"
        : "No resources yet";
    const generated = counts.length ? counts.join(" · ") : "";

    return `
      <article class="card kit-card">
        <div class="kit-figure">${resources.length}</div>
        <div class="kit-body">
          <h3><a href="#/kit/${esc(kit.id)}">${esc(kit.name)}</a></h3>
          <p class="kit-meta">${esc(kit.subject || status)}</p>
          ${kit.subject ? `<p class="kit-sub">${esc(status)}</p>` : ""}
          <p class="kit-sub">${generated ? `${esc(generated)} · ` : ""}updated ${esc(relativeTime(kit.updatedAt))}</p>
          ${quizAttempts.length ? `<p class="kit-sub"><span class="pill accent tiny-pill">Best quiz ${bestAttempt}%</span></p>` : ""}
          ${cls ? `<div class="kit-tag"><span class="chip">${esc(cls.name)}</span></div>` : ""}
        </div>
        <div class="kit-actions">
          <button class="btn primary small" data-action="open-kit" data-id="${esc(kit.id)}">Open</button>
          <button class="btn small" data-action="rename-kit" data-id="${esc(kit.id)}">Rename</button>
          <button class="btn small" data-action="move-kit" data-id="${esc(kit.id)}">Move</button>
          <button class="btn small" data-action="delete-kit" data-id="${esc(kit.id)}">Delete</button>
        </div>
      </article>`;
  }

  /* -------------------------------- kit ---------------------------- */

  function kitTabs(kit, resources, activeTab) {
    const withDocs = resources.filter((resource) => resource.document);
    const tabs = [
      { id: "resources", label: "Resources", count: resources.length, href: `#/kit/${kit.id}` },
      { id: "documents", label: "Study guide", count: withDocs.length, href: `#/kit/${kit.id}/documents` },
      {
        id: "questions",
        label: "Quiz",
        count: kit.quiz ? kit.quiz.items.length : 0,
        href: `#/kit/${kit.id}/questions`,
      },
      {
        id: "flashcards",
        label: "Flashcards",
        count: kit.flashcards ? kit.flashcards.items.length : 0,
        due: kit.flashcards ? store.deckSchedule(kit.id).due : 0,
        href: `#/kit/${kit.id}/flashcards`,
      },
      {
        id: "exam",
        label: "Practice test",
        count: kit.exam ? kit.exam.items.length : 0,
        href: `#/kit/${kit.id}/exam`,
      },
    ];
    return `<nav class="tabs" role="tablist" aria-label="Study kit sections">${tabs
      .map(
        (tab) => `<a role="tab" aria-selected="${tab.id === activeTab}" class="tab ${
          tab.id === activeTab ? "active" : ""
        }" href="${tab.href}">${esc(tab.label)}<span class="count">${tab.count}</span>${
          tab.due ? `<span class="tab-due" title="${tab.due} card(s) to revise">${tab.due}</span>` : ""
        }</a>`,
      )
      .join("")}</nav>`;
  }

  function renderKit(kit, tab = "resources") {
    const resources = store.resourcesInKit(kit.id);
    const cls = kit.classId ? store.getClass(kit.classId) : null;
    const page = document.createElement("div");
    page.className = "page";

    page.innerHTML = `
      <nav class="crumbs"><a href="#/">Dashboard</a><span>/</span>${cls ? `<a href="#/">${esc(cls.name)}</a><span>/</span>` : ""}<span>${esc(kit.name)}</span></nav>
      <header class="page-head">
        <div class="page-title">
          <p class="eyebrow">${esc(kit.subject || "Study kit")}</p>
          <h1>${esc(kit.name)}</h1>
          <button class="exam-chip ${examCountdown(kit) ? "set" : ""}" data-action="set-exam-date" data-id="${esc(kit.id)}">
            ${examCountdown(kit) ? esc(examCountdown(kit).label) : "Set an exam date"}
          </button>
        </div>
        <div class="row tight">
          <button class="btn primary" data-action="study-now" data-id="${esc(kit.id)}">Study now</button>
          <button class="btn" data-action="edit-kit" data-id="${esc(kit.id)}">Edit details</button>
          <button class="btn" data-action="delete-kit" data-id="${esc(kit.id)}">Delete kit</button>
        </div>
      </header>
      ${kitTabs(kit, resources, tab)}
      ${renderKitNotes(kit)}
      ${
        tab === "documents"
          ? renderKitDocuments(kit, resources)
          : tab === "questions"
            ? renderKitQuestions(kit, resources)
            : tab === "flashcards"
              ? renderKitFlashcards(kit, resources)
              : tab === "exam"
                ? renderKitExam(kit, resources)
                : renderKitResources(kit, resources)
      }`;
    return page;
  }

  /** A scratch pad that belongs to the kit, not to any one resource. */
  function renderKitNotes(kit) {
    const notes = kit.notes || "";
    const words = notes.trim() ? notes.trim().split(/\s+/).length : 0;
    return `
      <details class="kit-notes" ${notes ? "open" : ""}>
        <summary>
          My notes
          <span class="count" data-notes-count>${words ? `${plural(words, "word")}` : "empty"}</span>
        </summary>
        <textarea data-kit-notes data-id="${esc(kit.id)}" rows="6"
          placeholder="What did your teacher stress? What keeps slipping? Anything you want next to this kit."
        >${esc(notes)}</textarea>
        <div class="row tight">
          <button class="btn small" data-action="save-notes" data-id="${esc(kit.id)}">Save notes</button>
          <span class="muted tiny" data-notes-status>${notes ? "Saved in this browser." : "Saved automatically when you leave the box."}</span>
        </div>
      </details>`;
  }

  function renderKitResources(kit, resources) {
    const settings = store.getSettings();
    return `
      <div class="kit-layout">
        <section class="panel">
          <h2>Add resources</h2>
          <div class="dropzone" data-dropzone>
            <p><strong>Drop PDFs here</strong></p>
            <p class="muted small">or</p>
            <button class="btn primary" data-action="pick-pdf">Choose PDF files</button>
            <p class="muted tiny">The text layer is read first; OCR is only used on pages that are missing text.</p>
          </div>

          <div class="divider"><span>or paste text</span></div>

          <div class="field">
            <label for="paste-title">Title (optional)</label>
            <input id="paste-title" data-draft="paste-title" type="text" placeholder="e.g. Lecture 4 — Photosynthesis">
          </div>
          <div class="field">
            <label for="paste-text">Text to turn into a study document</label>
            <textarea id="paste-text" data-draft="paste-text" rows="7" placeholder="Paste notes, an article, a transcript…"></textarea>
          </div>
          <div class="row">
            <button class="btn" data-action="add-text">Add pasted text</button>
          </div>
          <p class="muted tiny">Generating with ${esc(StudyForge.ai.providerLabel())}. ${esc(settings.ocrLanguage)} OCR · ${settings.ocrScale}× render. <button class="link-btn" data-action="open-settings">Change engine</button></p>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h2>Resources</h2>
            <span class="count">${resources.length}</span>
          </div>
          ${
            resources.length
              ? `<div class="res-list">${resources.map(renderResourceRow).join("")}</div>`
              : `<p class="muted small">No resources yet. Add a PDF or pasted text to get started.</p>`
          }
        </section>
      </div>`;
  }

  function renderKitDocuments(kit, resources) {
    const withDocs = resources.filter((resource) => resource.document);
    if (!withDocs.length) {
      return `
        <section class="panel">
          <div class="empty">
            <h3>No study documents yet</h3>
            <p class="muted">Every processed resource gets its own study document. Add a PDF or pasted text, or check a resource that failed.</p>
            <a class="btn primary" href="#/kit/${esc(kit.id)}">Add a resource</a>
          </div>
        </section>`;
    }

    const selected = withDocs.find((resource) => resource.id === docViewId) || withDocs[0];
    const headings = (selected.document.match(/^#{1,3}\s+(.+)$/gm) || [])
      .map((line) => line.replace(/^#+\s+/, "").trim())
      .filter(Boolean)
      .slice(0, 14);
    return `
      <div class="doc-layout">
        <section class="panel doc-side">
          <div class="panel-head"><h2>Documents</h2><span class="count">${withDocs.length}</span></div>
          <div class="doc-list">
            ${withDocs
              .map(
                (resource) => `
              <button class="doc-item ${resource.id === selected.id ? "active" : ""}" data-action="select-doc" data-id="${esc(resource.id)}">
                <span class="res-icon ${resource.type}">${resource.type === "pdf" ? "PDF" : "TXT"}</span>
                <span class="doc-item-main">
                  <span class="doc-item-name">${esc(resource.name)}</span>
                  <span class="muted tiny">${(resource.document.length / 1000).toFixed(1)}k chars · ${esc(relativeTime(resource.documentUpdatedAt))}</span>
                </span>
              </button>`,
              )
              .join("")}
          </div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>${esc(selected.name)}</h2>
            <div class="doc-head-actions">
            <div class="row tight">
              <a class="btn small" href="#/resource/${esc(selected.id)}">Open resource</a>
              <button class="btn small" data-action="listen-doc" data-id="${esc(selected.id)}">${
                speechState.speaking && speechState.resourceId === selected.id ? "Stop reading" : "Listen"
              }</button>
              <button class="btn small" data-action="print-doc" data-id="${esc(selected.id)}">Print</button>
              <button class="btn small" data-action="copy-doc" data-id="${esc(selected.id)}">Copy</button>
              <button class="btn small" data-action="download-doc" data-id="${esc(selected.id)}">Download .md</button>
            </div>
            <div class="row tight doc-read-controls">
              <span class="doc-find-wrap">
                <input type="search" data-doc-find placeholder="Find in guide…" aria-label="Find in the study guide" autocomplete="off" spellcheck="false">
                <span class="doc-find-count" data-doc-find-count></span>
              </span>
              <span class="muted tiny">Text</span>
              <button class="icon-btn small" data-action="doc-smaller" title="Smaller text" aria-label="Smaller text">A−</button>
              <button class="icon-btn small" data-action="doc-bigger" title="Bigger text" aria-label="Bigger text">A+</button>
              <button class="btn small ghost" data-action="doc-focus" title="Hide everything but the guide">Focus</button>
            </div>
            </div>
          </div>
          ${
            headings.length > 1
              ? `<nav class="doc-toc" aria-label="On this page">
                  <span class="doc-toc-label">On this page</span>
                  ${headings
                    .map(
                      (heading, index) =>
                        `<a href="#doc-${index}" data-action="toc-jump" data-index="${index}">${esc(heading)}</a>`,
                    )
                    .join("")}
                </nav>`
              : ""
          }
          <article class="md" data-doc-body style="font-size:${readDocSize()}rem">${md.render(selected.document)}</article>
        </section>
      </div>`;
  }

  function renderKitQuestions(kit, resources) {
    const withDocs = resources.filter((resource) => resource.document);
    if (!withDocs.length) {
      return `
        <section class="panel">
          <div class="empty">
            <h3>No study documents yet</h3>
            <p class="muted">Questions are written from every study document in this kit, so at least one resource needs a document first.</p>
            <a class="btn primary" href="#/kit/${esc(kit.id)}">Add a resource</a>
          </div>
        </section>`;
    }

    const quiz = kit.quiz;
    // A run gets the page to itself: no regeneration controls while answering.
    if (quiz && quizState.status === "running" && quizState.kitId === kit.id) {
      return `
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>Quiz</h2>
              <p class="muted tiny">${esc(kit.name)} — answers lock as you mark them.</p>
            </div>
          </div>
          ${renderKitQuiz(kit)}
        </section>`;
    }
    const sources = quiz && quiz.sourceNames && quiz.sourceNames.length ? quiz.sourceNames : withDocs.map((r) => r.name);
    const missing = withDocs.length - (quiz && quiz.sourceCount ? quiz.sourceCount : 0);
    const coverage = (quiz && quiz.coverage && quiz.coverage.length ? quiz.coverage : null) || [];
    const uncovered = coverage.filter((entry) => entry.produced === 0);

    return `
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Quiz</h2>
            <p class="muted tiny">Written from all ${plural(withDocs.length, "study document")} in this kit: ${esc(
              sources.join(", "),
            )}.</p>
          </div>
          <div class="row tight">
            <button class="btn small ${quiz ? "" : "primary"}" data-action="make-quiz" data-id="${esc(kit.id)}">${
              quiz ? "New questions" : "Generate questions"
            }</button>
            ${
              quiz
                ? `<button class="btn small" data-action="print-quiz" data-id="${esc(kit.id)}">Print</button>
                 <button class="btn small" data-action="download-quiz" data-id="${esc(kit.id)}">Download .md</button>`
                : ""
            }
          </div>
        </div>
        ${
          quiz && coverage.length
            ? `<div class="coverage" aria-label="Questions per resource">${coverage
                .map(
                  (entry) =>
                    `<span class="coverage-item ${entry.produced ? "ok" : "empty"}" title="${esc(
                      entry.produced
                        ? `${entry.produced} of ${entry.requested} requested question(s)`
                        : "No questions were produced for this resource",
                    )}">${esc(entry.name)}<span>${entry.produced}</span></span>`,
                )
                .join("")}</div>`
            : ""
        }
        ${quiz && missing > 0 ? `<div class="notice subtle">${plural(missing, "newer document")} not covered yet — regenerate to include them.</div>` : ""}
        ${
          quiz && uncovered.length
            ? `<div class="notice subtle">No questions for ${esc(uncovered.map((entry) => entry.name).join(", "))} — regenerate, or check that its document has enough content to question.</div>`
            : ""
        }
        ${
          quiz && quiz.failures && quiz.failures.length
            ? `<div class="notice error-soft"><strong>Some resources failed.</strong> ${esc(
                quiz.failures.map((failure) => `${failure.name}: ${failure.message}`).join(" · "),
              )}</div>`
            : ""
        }
        ${quiz && quiz.truncated ? `<div class="notice subtle">The combined documents were long, so a proportional slice of each resource was used.</div>` : ""}
        ${renderQuizInsights(kit)}
        ${renderKitQuiz(kit)}
      </section>`;
  }

  /* ------------------------- progress analytics --------------------- */

  /**
   * Everything the saved attempts can tell us: score trend, accuracy by
   * question type, pace, and the questions that keep catching you out.
   */
  function quizAnalytics(kit) {
    const attempts = (kit.quiz && kit.quiz.attempts) || [];
    if (!attempts.length) return null;
    const oldestFirst = attempts.slice().reverse();
    const percents = oldestFirst.map((attempt) => attempt.percent);
    const latest = percents[percents.length - 1];
    const previous = percents.length > 1 ? percents[percents.length - 2] : null;
    return {
      count: attempts.length,
      percents,
      latest,
      previous,
      delta: previous === null ? null : latest - previous,
      best: Math.max(...percents),
      average: Math.round(percents.reduce((sum, value) => sum + value, 0) / percents.length),
      byType: attempts.reduce(
        (acc, attempt) => {
          for (const answer of attempt.answers) {
            const type = answer.type === "short" ? "short" : "mcq";
            acc[type].total += 1;
            if (answer.correct) acc[type].correct += 1;
          }
          return acc;
        },
        { mcq: { correct: 0, total: 0 }, short: { correct: 0, total: 0 } },
      ),
      pace: (() => {
        const timed = attempts.flatMap((attempt) => attempt.answers.filter((answer) => answer.seconds > 0));
        if (!timed.length) return null;
        return Math.round(timed.reduce((sum, answer) => sum + answer.seconds, 0) / timed.length);
      })(),
      trouble: (() => {
        const seen = new Map();
        for (const attempt of attempts) {
          for (const answer of attempt.answers) {
            const key = String(answer.question || "").toLowerCase().trim();
            if (!key) continue;
            const entry = seen.get(key) || { question: answer.question, correct: 0, total: 0, seconds: 0, timed: 0 };
            entry.total += 1;
            if (answer.correct) entry.correct += 1;
            if (answer.seconds) {
              entry.seconds += answer.seconds;
              entry.timed += 1;
            }
            seen.set(key, entry);
          }
        }
        return [...seen.values()]
          .filter((entry) => entry.correct < entry.total)
          .sort((a, b) => a.correct / a.total - b.correct / b.total || b.total - a.total)
          .slice(0, 5);
      })(),
    };
  }

  /** Tiny SVG line chart of recent scores, newest on the right. */
  function scoreSparkline(percents) {
    if (percents.length < 2) return "";
    const width = 220;
    const height = 46;
    const step = width / (percents.length - 1);
    const points = percents.map((value, index) => [index * step, height - (value / 100) * (height - 6) - 3]);
    const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const area = `0,${height} ${line} ${width},${height}`;
    return `
      <svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="Score trend over ${percents.length} attempts" preserveAspectRatio="none">
        <polygon points="${area}" class="spark-area"></polygon>
        <polyline points="${line}" class="spark-line"></polyline>
        ${points
          .map(
            ([x, y], index) =>
              `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${index === points.length - 1 ? 3 : 2}" class="spark-dot"></circle>`,
          )
          .join("")}
      </svg>`;
  }

  function renderQuizInsights(kit) {
    const stats = quizAnalytics(kit);
    if (!stats) return "";
    const typeRow = (label, data) => {
      if (!data.total) return "";
      const percent = Math.round((data.correct / data.total) * 100);
      return `
        <div class="insight-row">
          <span>${esc(label)}</span>
          <span class="insight-bar"><span style="width:${percent}%"></span></span>
          <span class="muted tiny">${percent}% · ${data.correct}/${data.total}</span>
        </div>`;
    };
    return `
      <section class="panel insights">
        <div class="panel-head">
          <div>
            <h2>Your progress</h2>
            <p class="muted tiny">Built from every saved attempt in this kit.</p>
          </div>
          <button class="btn small ghost" data-action="download-results">Download results</button>
          ${
            stats.delta === null
              ? ""
              : `<span class="pill ${stats.delta >= 0 ? "good" : "bad"}">${stats.delta >= 0 ? "▲" : "▼"} ${Math.abs(
                  stats.delta,
                )} pts vs last</span>`
          }
        </div>
        <div class="insight-grid">
          <div class="insight-stat"><span class="insight-figure">${stats.best}%</span><span class="muted tiny">Best</span></div>
          <div class="insight-stat"><span class="insight-figure">${stats.average}%</span><span class="muted tiny">Average</span></div>
          <div class="insight-stat"><span class="insight-figure">${stats.count}</span><span class="muted tiny">Attempt${stats.count === 1 ? "" : "s"}</span></div>
          <div class="insight-stat"><span class="insight-figure">${stats.pace ? `${stats.pace}s` : "—"}</span><span class="muted tiny">Per question</span></div>
        </div>
        ${scoreSparkline(stats.percents)}
        <div class="insight-breakdown">
          ${typeRow("Multiple choice", stats.byType.mcq)}
          ${typeRow("Short answer", stats.byType.short)}
        </div>
        ${
          stats.trouble.length
            ? `<div class="trouble">
                <h3>Trouble spots</h3>
                <p class="muted tiny">Asked more than once and not yet mastered.</p>
                <ul class="trouble-list">
                  ${stats.trouble
                    .map(
                      (entry) => `
                        <li>
                          <span class="trouble-q">${esc(entry.question)}</span>
                          <span class="trouble-score">${entry.correct}/${entry.total}</span>
                        </li>`,
                    )
                    .join("")}
                </ul>
                <button class="btn small" data-action="practise-weak">Practise trouble spots</button>
              </div>`
            : ""
        }
      </section>`;
  }

  /* -------------------------------- quiz --------------------------- */

  function renderKitQuiz(kit) {
    const quiz = kit.quiz;
    if (!quiz) {
      return `<p class="muted small">No questions yet. Generate a set and it is saved with this study kit.</p>`;
    }
    if (quizState.kitId !== kit.id) resetQuiz(kit.id);
    if (quizState.status === "running") return renderQuizRunner(kit);
    if (quizState.status === "finished") return renderQuizResult(kit);
    return renderQuizIntro(kit);
  }

  /** Every saved run for this kit, newest first. */
  function renderAttempts(kit) {
    const attempts = (kit.quiz && kit.quiz.attempts) || [];
    const best = attempts.reduce(
      (top, attempt) => (attempt.percent > (top ? top.percent : -1) ? attempt : top),
      null,
    );

    return `
      <section class="panel attempts-panel">
        <div class="panel-head">
          <div>
            <h2>Past attempts</h2>
            <p class="muted tiny">Saved in this browser — every submitted quiz run is kept here.</p>
          </div>
          ${best ? `<span class="pill accent">Best ${best.percent}%</span>` : ""}
        </div>
        ${
          attempts.length
            ? `<ol class="attempt-list">${attempts
                .map(
                  (attempt) => `
                    <li class="attempt-row">
                      <span class="attempt-score ${attempt.percent >= 70 ? "good" : attempt.percent >= 50 ? "mid" : "low"}">${attempt.percent}%</span>
                      <span class="attempt-main">
                        <strong>${attempt.correct}/${attempt.total} correct</strong>
                        <span class="muted tiny">${esc(new Date(attempt.takenAt).toLocaleString())}${
                          attempt.secondsUsed ? ` · ${formatClock(attempt.secondsUsed)}` : ""
                        }</span>
                      </span>
                      <span class="attempt-bar"><span style="width:${attempt.percent}%"></span></span>
                      <button class="btn ghost small" data-action="review-attempt" data-id="${esc(attempt.id)}">Review</button>
                      <button class="icon-btn danger" title="Delete this attempt" data-action="delete-quiz-attempt"
                        data-id="${esc(attempt.id)}">×</button>
                    </li>`,
                )
                .join("")}</ol>`
            : `<p class="muted small">No attempts yet — finish a quiz and your score lands here.</p>`
        }
      </section>`;
  }

  function renderQuizIntro(kit) {
    const quiz = kit.quiz;
    const attempts = quiz.attempts || [];
    const best = attempts.reduce((top, attempt) => Math.max(top, attempt.percent), 0);
    const shortCount = quiz.items.filter((item) => item.type === "short").length;
    const choiceCount = quiz.items.length - shortCount;
    const draft = readQuizDraft(kit.id);

    return `
      <div class="quiz-hero">
        <div class="quiz-hero-text">
          <p class="eyebrow">Ready when you are</p>
          <h3>${plural(quiz.items.length, "question")}, one at a time</h3>
          <p class="muted small">
            Answer a question, press <strong>Mark &amp; next</strong>, and it is marked on the spot and locked.
            Finish every question to submit the quiz and see your result.
          </p>
          <div class="quiz-facts">
            <span class="pill">${plural(choiceCount, "multiple choice question")}</span>
            ${shortCount ? `<span class="pill">${plural(shortCount, "short answer")} · marked ${aiMarkLabel()}</span>` : ""}
            ${attempts.length ? `<span class="pill accent">Best ${best}%</span>` : `<span class="pill">No attempts yet</span>`}
          </div>
        </div>
        <button class="btn primary lg" data-action="start-quiz">${draft ? "Start over" : "Start quiz"}</button>
      </div>
      ${draft ? renderQuizDraftBanner(draft, quiz) : ""}
      ${renderAttempts(kit)}`;
  }

  function renderQuizDraftBanner(draft, quiz) {
    const total = Array.isArray(draft.items) && draft.items.length ? draft.items.length : quiz.items.length;
    const answered = Object.keys(draft.results || {}).length;
    const position = Math.min(total, (Number(draft.index) || 0) + 1);
    return `
      <div class="quiz-draft" role="status">
        <div class="quiz-draft-text">
          <strong>You have a quiz in progress</strong>
          <span class="muted small">${answered} of ${total} marked · you were on question ${position}</span>
        </div>
        <div class="quiz-draft-actions">
          <button class="btn small primary" data-action="resume-quiz">Resume</button>
          <button class="btn small ghost" data-action="discard-draft">Discard</button>
        </div>
      </div>`;
  }

  /** Where short answers get marked — the wording should match the engine. */
  function aiMarkLabel() {
    return StudyForge.ai.isAiEnabled() ? "by AI" : "on this device";
  }

  /** The questions in play: a full set, or the missed-only retry subset. */
  function activeQuizItems(kit) {
    if (quizState.items && quizState.items.length) return quizState.items;
    return (kit.quiz && kit.quiz.items) || [];
  }

  function renderQuizDots(items) {
    return `<div class="quiz-dots" aria-hidden="true">${items
      .map((_, index) => {
        const result = quizState.results[index];
        const current = index === quizState.index && quizState.status === "running";
        const status = result ? (result.correct ? "ok" : "bad") : "";
        return `<span class="quiz-dot ${status}${current ? " current" : ""}"></span>`;
      })
      .join("")}</div>`;
  }

  function renderMcqOptions(item, answer, result, locked) {
    const chosen = answer && Number.isInteger(answer.choice) ? answer.choice : undefined;
    return `<div class="options options-quiz">${item.options
      .map((option, optionIndex) => {
        const letter = String.fromCharCode(65 + optionIndex);
        if (!locked) {
          return `<button class="option ${chosen === optionIndex ? "selected" : ""}"
            data-action="quiz-choose" data-opt="${optionIndex}">
            <span class="opt-letter">${letter}</span>
            <span>${esc(option)}</span>
          </button>`;
        }
        let cls = "option static";
        if (optionIndex === item.answerIndex) cls += " correct";
        else if (optionIndex === chosen) cls += " wrong";
        return `<div class="${cls}">
          <span class="opt-letter">${letter}</span>
          <span>${esc(option)}</span>
          ${optionIndex === item.answerIndex ? '<span class="opt-flag">Correct</span>' : ""}
          ${optionIndex === chosen && optionIndex !== item.answerIndex ? '<span class="opt-flag wrong">Your answer</span>' : ""}
        </div>`;
      })
      .join("")}</div>`;
  }

  function renderShortAnswer(item, answer, result, locked) {
    const text = answer && typeof answer.text === "string" ? answer.text : "";
    // The draft key is per question so a typed answer never carries over to the
    // next short-answer question.
    return `
      <div class="short-wrap">
        <label class="label" for="quiz-answer">Your answer</label>
        <textarea id="quiz-answer" class="short-input" rows="5" data-quiz-input data-draft="quiz-short-${quizState.index}"
          placeholder="Write your answer in your own words…" ${locked ? "disabled" : ""}>${esc(text)}</textarea>
        <p class="hint">Marked by AI against the model answer. Different wording, synonyms and extra correct detail are accepted.</p>
      </div>`;
  }

  function renderQuizFeedback(item, result) {
    const percent = Math.round((result.score || 0) * 100);
    const marker = result.markedBy === "ai" ? "marked by AI" : result.markedBy === "offline" ? "marked offline" : "marked automatically";
    return `
      <div class="quiz-feedback ${result.correct ? "ok" : "bad"}" role="status" aria-live="polite">
        <div class="feedback-head">
          <span class="feedback-icon">${result.correct ? "✓" : "→"}</span>
          <strong>${result.correct ? "Correct" : "Not quite"}</strong>
          ${item.type === "short" ? `<span class="pill tiny-pill">${percent}% · ${esc(marker)}</span>` : ""}
        </div>
        ${item.type === "short" && result.feedback ? `<p class="feedback-note">${esc(result.feedback)}</p>` : ""}
        ${
          item.type === "short" || !result.correct
            ? `<p class="feedback-answer"><strong>Model answer:</strong> ${esc(item.answer)}</p>`
            : ""
        }
        ${item.explanation ? `<p class="explanation">${esc(item.explanation)}</p>` : ""}
      </div>`;
  }

  function renderQuizRunner(kit) {
    const items = activeQuizItems(kit);
    const index = Math.min(quizState.index, items.length - 1);
    const item = items[index];
    const answer = quizState.answers[index];
    const result = quizState.results[index];
    const marked = quizState.phase === "marked" && Boolean(result);
    const marking = quizState.phase === "marking";
    const markedCount = Object.keys(quizState.results).length;
    const correctSoFar = Object.values(quizState.results).filter((entry) => entry.correct).length;
    const isLast = index === items.length - 1;
    const hasAnswer =
      item.type === "mcq"
        ? Boolean(answer && Number.isInteger(answer.choice))
        : Boolean(answer && answer.text && answer.text.trim());

    const label = marking
      ? "Marking…"
      : marked
        ? isLast
          ? "See result"
          : "Next question"
        : isLast
          ? "Finish & mark"
          : "Mark & next";

    return `
      <div class="quiz-shell">
        <header class="quiz-top">
          <div class="quiz-progress-wrap">
            <div class="quiz-progress-text">
              <strong>Question ${index + 1}</strong><span class="muted">of ${items.length}</span>
              <span class="quiz-score-chip">${correctSoFar} correct</span>
            </div>
            ${renderQuizDots(items)}
          </div>
          <button class="btn ghost small" data-action="quit-quiz">Exit quiz</button>
        </header>

        <article class="quiz-card ${marked ? (result.correct ? "is-correct" : "is-wrong") : ""}">
          <div class="quiz-q-head">
            <span class="q-badge">${item.type === "mcq" ? "Multiple choice" : "Short answer"}</span>
            ${marked ? `<span class="badge ${result.correct ? "ready" : "error"}">${result.correct ? "Correct" : "Not quite"}</span>` : ""}
          </div>
          <h2 class="quiz-q-text">${esc(item.question)}</h2>
          ${item.type === "mcq" ? renderMcqOptions(item, answer, result, marked || marking) : renderShortAnswer(item, answer, result, marked || marking)}
          ${marked ? renderQuizFeedback(item, result) : ""}
        </article>

        <footer class="quiz-foot">
          <span class="muted tiny">${
            marked
              ? "Locked in — answers cannot be changed."
              : `${markedCount} of ${items.length} marked · press 1–4 to choose, Enter to continue`
          }</span>
          <button class="btn primary" data-action="quiz-next" ${marking || (!marked && !hasAnswer) ? "disabled" : ""}>
            ${marking ? '<span class="spinner"></span>' : ""}${label}
          </button>
        </footer>
      </div>`;
  }

  function gradeLabel(percent) {
    if (percent >= 85) return "Outstanding";
    if (percent >= 70) return "Solid work";
    if (percent >= 50) return "Getting there";
    return "Needs another pass";
  }

  function renderQuizResult(kit) {
    const quiz = kit.quiz;
    const attempt = quizState.attempt;
    if (!attempt) return renderQuizIntro(kit);
    const percent = attempt.percent;
    const shortCount = attempt.answers.filter((entry) => entry.type === "short").length;

    return `
      <div class="result-hero">
        <div class="score-ring" style="--score:${percent}">
          <span class="score-ring-value">${percent}<small>%</small></span>
        </div>
        <div class="result-hero-text">
          <p class="eyebrow">Quiz submitted</p>
          <h3>${esc(gradeLabel(percent))}</h3>
          <p class="muted small">
            ${attempt.correct} of ${attempt.total} correct${
              attempt.secondsUsed ? ` · ${formatClock(attempt.secondsUsed)}` : ""
            }${shortCount ? ` · ${plural(shortCount, "short answer")} marked ${aiMarkLabel()}` : ""}
          </p>
          ${(() => {
            const attempts = (quiz.attempts || []).filter((entry) => entry.id !== attempt.id);
            const previous = attempts[0];
            if (!previous) return "";
            const delta = percent - previous.percent;
            return `<p class="result-delta ${delta >= 0 ? "up" : "down"}">${
              delta === 0
                ? "Same score as last time."
                : `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)} points ${delta > 0 ? "better" : "lower"} than last time (${previous.percent}%).`
            }</p>`;
          })()}
          ${(() => {
            const timed = (attempt.answers || []).filter((entry) => entry.seconds > 0);
            if (!timed.length) return "";
            const average = Math.round(timed.reduce((sum, entry) => sum + entry.seconds, 0) / timed.length);
            const slowest = timed.slice().sort((a, b) => b.seconds - a.seconds)[0];
            return `<p class="muted tiny">Average ${average}s per question${
              slowest ? ` · slowest was ${slowest.seconds}s` : ""
            }.</p>`;
          })()}
          <div class="result-split">
            ${["mcq", "short"]
              .map((type) => {
                const rows = attempt.answers.filter((entry) => (entry.type === "short" ? "short" : "mcq") === type);
                if (!rows.length) return "";
                const right = rows.filter((entry) => entry.correct).length;
                return `<span class="split-pill">${type === "mcq" ? "Multiple choice" : "Short answer"} ${right}/${
                  rows.length
                }</span>`;
              })
              .join("")}
          </div>
          <div class="row tight">
            <button class="btn primary" data-action="practise-missed" ${attempt.correct === attempt.total ? "disabled" : ""}>Practise missed</button>
            ${
              store.deckSchedule(kit.id).due
                ? `<button class="btn" data-action="review-all-due" data-id="${esc(kit.id)}">Revise ${store.deckSchedule(kit.id).due} card${
                    store.deckSchedule(kit.id).due === 1 ? "" : "s"
                  }</button>`
                : ""
            }
            <button class="btn" data-action="retry-quiz">Try again</button>
            <button class="btn ghost" data-action="quiz-back">Back to overview</button>
          </div>
        </div>
      </div>

      <h3 class="review-head">Question review</h3>
      <ol class="quiz review-list">
        ${attempt.answers
          .map((entry, index) => {
            const item = (quizState.attemptItems || quiz.items)[index] || {};
            return `
              <li class="review-item ${entry.correct ? "q-correct" : "q-wrong"}">
                <div class="review-item-head">
                  <span class="q-number">${index + 1}</span>
                  <span class="badge ${entry.correct ? "ready" : "error"}">${entry.correct ? "Correct" : "Incorrect"}</span>
                  ${entry.type === "short" ? `<span class="pill tiny-pill">${Math.round(entry.score * 100)}% · ${esc(entry.markedBy === "ai" ? "AI marked" : "offline marked")}</span>` : ""}
                </div>
                <p class="q-text">${esc(entry.question || item.question || "")}</p>
                <p class="answer-line"><span class="muted">Your answer:</span> ${esc(entry.given || "—")}</p>
                ${entry.correct ? "" : `<p class="answer-line"><span class="muted">Model answer:</span> ${esc(entry.expected)}</p>`}
                ${entry.feedback ? `<p class="explanation">${esc(entry.feedback)}</p>` : item.explanation ? `<p class="explanation">${esc(item.explanation)}</p>` : ""}
              </li>`;
          })
          .join("")}
      </ol>
      ${renderAttempts(kit)}`;
  }

  /* ----------------------------- flashcards ------------------------ */

  function coverageChips(coverage) {
    if (!coverage || !coverage.length) return "";
    return `<div class="coverage" aria-label="Cards or questions per resource">${coverage
      .map(
        (entry) =>
          `<span class="coverage-item ${entry.produced ? "ok" : "empty"}" title="${esc(
            entry.produced
              ? `${entry.produced} of ${entry.requested} requested`
              : "Nothing was produced for this resource",
          )}">${esc(entry.name)}<span>${entry.produced}</span></span>`,
      )
      .join("")}</div>`;
  }

  function sourceFailures(set) {
    return set && set.failures && set.failures.length
      ? `<div class="notice error-soft"><strong>Some resources failed.</strong> ${esc(
          set.failures.map((failure) => `${failure.name}: ${failure.message}`).join(" · "),
        )}</div>`
      : "";
  }

  function renderKitFlashcards(kit, resources) {
    const withDocs = resources.filter((resource) => resource.document);
    const cards = kit.flashcards;

    return `
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Flashcards</h2>
            <p class="muted tiny">${
              cards ? `${cards.style === "question" ? "Exam-style question cards" : "Vocabulary & concept cards"} · ` : ""
            }drawn from all ${plural(withDocs.length, "study document")} in this kit.</p>
          </div>
          <div class="row tight">
            <button class="btn small ${cards ? "" : "primary"}" data-action="make-flashcards" data-id="${esc(kit.id)}">${
              cards ? "Regenerate" : "Generate flashcards"
            }</button>
            ${
              cards
                ? `<button class="btn small" data-action="print-deck" data-id="${esc(kit.id)}">Print deck</button>
                   <button class="btn small" data-action="download-flashcards" data-id="${esc(kit.id)}">Download .md</button>`
                : ""
            }
          </div>
        </div>
        ${
          !withDocs.length
            ? `<div class="notice subtle">Process at least one resource first — cards are written from the study documents in this kit.</div>`
            : ""
        }
        ${cards ? coverageChips(cards.coverage) : ""}
        ${cards ? sourceFailures(cards) : ""}
        ${cards ? renderDeck(kit) : renderDeckEmpty(withDocs.length)}
      </section>`;
  }

  /** Words that carry no meaning for a typed-answer check. */
  const TYPING_STOPWORDS = new Set(
    "a an the of to and or in on at for with from by is are was were be been being that this these those it its as into than then so such".split(
      " ",
    ),
  );

  /** Loose comparison so a typed answer only has to mean the same thing. */
  function compareTyped(expected, given) {
    const clean = (text) =>
      String(text || "")
        .toLowerCase()
        .replace(/[’']/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const want = clean(expected);
    const got = clean(given);
    if (!got) return { verdict: "empty", ratio: 0 };
    if (want === got) return { verdict: "correct", ratio: 1 };
    if (want.length < 24 && (want.includes(got) || got.includes(want))) {
      return { verdict: got.length >= want.length * 0.6 ? "correct" : "close", ratio: 0.9 };
    }
    const wantWords = want.split(" ").filter((word) => word.length > 2 && !TYPING_STOPWORDS.has(word));
    if (!wantWords.length) return { verdict: want === got ? "correct" : "close", ratio: 0.5 };
    const givenSet = new Set(got.split(" "));
    const hits = wantWords.filter((word) => givenSet.has(word)).length;
    const ratio = hits / wantWords.length;
    return { verdict: ratio >= 0.6 ? "correct" : ratio >= 0.3 ? "close" : "wrong", ratio };
  }

  function typingStage(card, frontLabel, backLabel) {
    const verdict = flashState.typedVerdict;
    const message = verdict
      ? verdict.verdict === "correct"
        ? "That matches — nice recall."
        : verdict.verdict === "close"
          ? "Close. Compare with the card and rate yourself honestly."
          : "Not quite. Read the answer, then rate it honestly."
      : "";
    return `
      <div class="fc-stage">
        <div class="fc-typing">
          <span class="fc-side">${frontLabel}</span>
          <p class="fc-text">${esc(card.front)}</p>
          <label class="sr-only" for="card-typed">Your answer</label>
          <textarea id="card-typed" class="type-input" data-card-typed rows="3"
            placeholder="Type the ${backLabel.toLowerCase()} from memory…">${esc(flashState.typed)}</textarea>
          <div class="row tight">
            <button class="btn primary small" data-action="card-check-typed">Check</button>
            <button class="btn small ghost" data-action="toggle-typing">Back to flipping</button>
          </div>
          ${
            verdict
              ? `<div class="typed-verdict ${verdict.verdict}">
                   <p>${esc(message)}</p>
                   <p class="typed-answer"><span class="fc-side">${backLabel}</span> ${esc(card.back)}</p>
                 </div>`
              : ""
          }
        </div>
      </div>`;
  }

  function renderDeckEmpty(documentCount) {
    if (!documentCount) return "";
    return `<p class="muted small">No flashcards yet. Generate a deck and it will be saved with this study kit.</p>`;
  }

  /**
   * Days until the kit's exam, with a pace hint: how many cards a day it takes
   * to have seen every card twice before the paper.
   */
  function examCountdown(kit) {
    if (!kit.examDate) return null;
    const target = new Date(`${kit.examDate}T23:59:59`);
    const days = Math.ceil((target.getTime() - Date.now()) / 86400000);
    if (!Number.isFinite(days)) return null;
    if (days < 0) return { days, label: `Exam was ${plural(Math.abs(days), "day")} ago`, past: true };
    const label =
      days === 0 ? "Exam today" : days === 1 ? "Exam tomorrow" : `Exam in ${days} days`;
    const total = kit.flashcards ? kit.flashcards.items.length : 0;
    const perDay = days > 0 && total ? Math.ceil((total * 2) / days) : 0;
    return { days, label, past: false, perDay, total };
  }

  /** "in 3 days", "in 2 hours", "due now" — for review scheduling text. */
  function dueLabel(dueAt) {
    const ms = new Date(dueAt).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return "due now";
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
    const days = Math.round(hours / 24);
    return `in ${days} day${days === 1 ? "" : "s"}`;
  }

  /** Stable progress key for a card: its prompt text, so regeneration keeps it. */
  function cardKey(card) {
    return String(card.front || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  /**
   * The cards this learner keeps getting wrong: most lapses first, then the
   * lowest ease factor, then anything still "learning".
   */
  function hardestCards(kit) {
    const ratings = (kit.flashcards && kit.flashcards.ratings) || {};
    return kit.flashcards.items
      .map((card, index) => ({ card, index, rating: ratings[cardKey(card)] }))
      .filter((entry) => entry.rating && (entry.rating.lapses > 0 || entry.rating.state === "again"))
      .sort(
        (a, b) =>
          (b.rating.lapses || 0) - (a.rating.lapses || 0) ||
          (a.rating.ease || 2.5) - (b.rating.ease || 2.5),
      )
      .slice(0, 10)
      .map((entry) => entry.index);
  }

  /** Progress for the current deck, derived from the saved ratings. */
  function deckProgress(kit) {
    const ratings = (kit.flashcards && kit.flashcards.ratings) || {};
    const now = Date.now();
    let known = 0;
    let again = 0;
    let due = 0;
    let unseen = 0;
    for (const card of kit.flashcards.items) {
      const rating = ratings[cardKey(card)];
      if (!rating) {
        unseen += 1;
        due += 1;
        continue;
      }
      if (rating.state === "known") known += 1;
      else again += 1;
      if (new Date(rating.dueAt).getTime() <= now) due += 1;
    }
    return { known, again, due, unseen };
  }

  function renderDeck(kit) {
    const items = kit.flashcards.items;
    const order = deckOrder(kit);
    const position = Math.min(flashState.index, order.length - 1);
    const card = items[order[position]];
    if (!card) return "";

    const vocab = kit.flashcards.style !== "question";
    const frontLabel = vocab ? "Term" : "Question";
    const backLabel = vocab ? "Definition" : "Answer";
    const progress = deckProgress(kit);
    const schedule = store.deckSchedule(kit.id);
    const knownCount = progress.known;
    const againCount = progress.again;
    const percent = Math.round((position / order.length) * 100);

    if (flashState.finished) return renderDeckSummary(kit, progress);

    return `
      <div class="deck">
        <div class="deck-bar">
          <span class="muted tiny">Card ${position + 1} of ${order.length}${
            flashState.reviewMode ? " · review" : flashState.shuffled ? " · shuffled" : ""
          }</span>
          <span class="muted tiny">${knownCount} known${againCount ? ` · ${againCount} to review` : ""}${
            progress.due ? ` · ${progress.due} due` : ""
          }</span>
        </div>
        <div class="deck-meter"><span style="width:${percent}%"></span></div>
        <p class="deck-plan">
          ${
            progress.due
              ? `<strong>${progress.due}</strong> card${progress.due === 1 ? "" : "s"} to revise now`
              : `<strong>All caught up</strong> — nothing due`
          }${schedule.later ? ` · ${schedule.later} more in the next week` : ""}${
            schedule.nextDueAt ? ` · next ${dueLabel(schedule.nextDueAt)}` : ""
          }${
            examCountdown(kit) && !examCountdown(kit).past && examCountdown(kit).perDay
              ? ` · ${examCountdown(kit).perDay} a day clears the deck twice before the exam`
              : ""
          }
        </p>

        ${
          flashState.typing
            ? typingStage(card, frontLabel, backLabel)
            : `<div class="fc-stage">
          <button class="flashcard ${flashState.flipped ? "is-flipped" : ""}" data-action="flip-card"
            aria-label="Flashcard — click to flip" aria-pressed="${flashState.flipped}">
            <span class="fc-inner">
              <span class="fc-face fc-front">
                <span class="fc-side">${frontLabel}</span>
                <span class="fc-text">${esc(card.front)}</span>
                <span class="fc-hint">Click or press Space to flip</span>
              </span>
              <span class="fc-face fc-back">
                <span class="fc-side">${backLabel}</span>
                <span class="fc-text">${esc(card.back)}</span>
                <span class="fc-hint">Click or press Space to flip back</span>
              </span>
            </span>
          </button>
        </div>`
        }

        ${card.source ? `<p class="muted tiny center">From ${esc(card.source)}</p>` : ""}

        <div class="fc-controls">
          <button class="icon-btn" data-action="prev-card" title="Previous card" aria-label="Previous card"
            ${position === 0 ? "disabled" : ""}>${icon("arrowLeft")}</button>
          ${
            flashState.typing
              ? ""
              : `<button class="btn small primary fc-flip-btn" data-action="flip-card">
            <span data-flip-label>${flashState.flipped ? "Show prompt" : "Show answer"}</span>
          </button>`
          }
          <button class="icon-btn" data-action="next-card" title="Next card" aria-label="Next card"
            ${position >= order.length - 1 ? "disabled" : ""}>${icon("arrowRight")}</button>
        </div>

        <div class="row center tight">
          <button class="btn small again" data-action="card-again">Still learning</button>
          <button class="btn small known" data-action="card-known">Got it</button>
        </div>
        ${
          flashState.lastScheduled
            ? `<p class="fc-scheduled">“${esc(flashState.lastScheduled.front)}” comes back ${esc(
                dueLabel(flashState.lastScheduled.dueAt),
              )}.</p>`
            : ""
        }

        <div class="row center tight deck-tools">
          ${
            progress.due
              ? `<button class="btn small" data-action="review-due">Review ${progress.due} due</button>`
              : ""
          }
          ${
            againCount
              ? `<button class="btn small ghost" data-action="review-again">Still learning (${againCount})</button>`
              : ""
          }
          ${
            hardestCards(kit).length
              ? `<button class="btn small ghost" data-action="review-hardest">Hardest (${hardestCards(kit).length})</button>`
              : ""
          }
          <button class="btn small ghost" data-action="toggle-typing">${
            flashState.typing ? "Flip mode" : "Type answers"
          }</button>
          <button class="btn small ghost" data-action="shuffle-cards">Shuffle</button>
          <button class="btn small ghost" data-action="deck-list">${
            flashState.showList ? "Back to card" : "Browse all"
          }</button>
          <details class="deck-more">
            <summary class="btn small ghost">Edit deck</summary>
            <div class="deck-more-body">
              <button class="btn small ghost" data-action="add-card">Add card</button>
              <button class="btn small ghost" data-action="import-cards">Paste cards</button>
              <button class="btn small ghost" data-action="edit-card">Edit card</button>
              <button class="btn small ghost" data-action="restart-cards">Restart</button>
              ${
                knownCount || againCount
                  ? `<button class="btn small ghost" data-action="reset-progress">Reset progress</button>`
                  : ""
              }
            </div>
          </details>
        </div>
        ${flashState.showList ? renderDeckList(items) : ""}
      </div>`;
  }

  /** The end of a deck: what was learned, and where to go next. */
  function renderDeckSummary(kit, progress) {
    const schedule = store.deckSchedule(kit.id);
    const total = kit.flashcards.items.length;
    const known = progress.known;
    const again = progress.again;
    const percent = total ? Math.round((known / total) * 100) : 0;
    return `
      <div class="deck-summary">
        <p class="eyebrow">Deck finished</p>
        <h3>${percent >= 80 ? "Strong run." : percent >= 50 ? "Good progress." : "Keep going — this is normal."}</h3>
        <div class="summary-figures">
          <div><span class="summary-figure">${known}</span><span class="muted tiny">known</span></div>
          <div><span class="summary-figure">${again}</span><span class="muted tiny">still learning</span></div>
          <div><span class="summary-figure">${schedule.due}</span><span class="muted tiny">due now</span></div>
        </div>
        <div class="summary-bar"><span style="width:${percent}%"></span></div>
        <p class="muted small">${
          schedule.nextDueAt
            ? `The next card comes back ${esc(dueLabel(schedule.nextDueAt))}.`
            : "Everything is scheduled for later."
        }</p>
        <div class="row center tight">
          ${again ? `<button class="btn primary small" data-action="review-again">Review ${again} still learning</button>` : ""}
          <button class="btn small" data-action="restart-cards">Go through again</button>
          <a class="btn small ghost" href="#/kit/${esc(kit.id)}/questions">Take the quiz</a>
        </div>
      </div>`;
  }

  function renderDeckList(items) {
    return `<ol class="deck-list">${items
      .map((card) => `<li><p><strong>${esc(card.front)}</strong></p><p class="muted small">${esc(card.back)}</p></li>`)
      .join("")}</ol>`;
  }

  /* --------------------------- practice exam ----------------------- */

  function renderKitExam(kit, resources) {
    const withDocs = resources.filter((resource) => resource.document);
    const exam = kit.exam;

    if (!exam) {
      return `
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>Practice test</h2>
              <p class="muted tiny">A timed, multiple-choice paper written from all ${plural(
                withDocs.length,
                "study document",
              )} in this kit.</p>
            </div>
            <button class="btn small primary" data-action="make-exam" data-id="${esc(kit.id)}">Build exam</button>
          </div>
          ${
            withDocs.length
              ? `<p class="muted small">No exam yet. Build one, then start the clock — questions are marked automatically when you submit or when time runs out.</p>`
              : `<div class="notice subtle">Process at least one resource first — the exam is written from the study documents in this kit.</div>`
          }
        </section>`;
    }

    if (examState.status === "running") return renderExamRunning(kit);
    if (examState.status === "finished") return renderExamResult(kit);

    return renderExamIntro(kit);
  }

  function renderExamIntro(kit) {
    const exam = kit.exam;
    const attempt = exam.lastAttempt;
    return `
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Practice test</h2>
            <p class="muted tiny">Written from all ${plural(exam.sourceCount || exam.sourceNames.length, "study document")} in this kit.</p>
          </div>
          <div class="row tight">
            <button class="btn small primary" data-action="start-exam" data-id="${esc(kit.id)}">Start exam</button>
            <button class="btn small" data-action="download-exam" data-id="${esc(kit.id)}">Download .md</button>
            <button class="btn small" data-action="make-exam" data-id="${esc(kit.id)}">New exam</button>
          </div>
        </div>
        ${coverageChips(exam.coverage)}
        ${sourceFailures(exam)}
        <div class="exam-brief">
          <div><span class="exam-figure">${exam.items.length}</span><span class="muted tiny">questions</span></div>
          <div><span class="exam-figure">${exam.durationMinutes}</span><span class="muted tiny">minutes</span></div>
          <div><span class="exam-figure">${Math.round((exam.durationMinutes * 60) / exam.items.length)}</span><span class="muted tiny">seconds / question</span></div>
          <div><span class="exam-figure">${attempt ? `${attempt.correct}/${attempt.total}` : "—"}</span><span class="muted tiny">last score</span></div>
        </div>
        ${(() => {
          const sittings = exam.attempts || [];
          if (sittings.length < 2) return "";
          const percents = sittings.map((entry) => entry.percent);
          const best = Math.max(...percents);
          const average = Math.round(percents.reduce((sum, value) => sum + value, 0) / percents.length);
          return `<p class="muted tiny">Across ${plural(sittings.length, "sitting")}: best ${best}% · average ${average}%.</p>`;
        })()}
        ${renderExamDraftBanner(kit)}
        <div class="notice subtle">
          The clock keeps running if you leave this tab, and the exam submits itself when time is up.
          Your answers are saved as you go, so a reload will not lose the paper.
          Only multiple-choice questions are used so the paper can be marked automatically.
        </div>
      </section>
      ${renderExamAttempts(kit)}`;
  }

  function renderExamDraftBanner(kit) {
    const draft = readExamDraft(kit.id);
    if (!draft) return "";
    const left = Math.max(0, Math.round((draft.endsAt - Date.now()) / 1000));
    const answered = Object.keys(draft.answers || {}).length;
    return `
      <div class="quiz-draft" role="status">
        <div class="quiz-draft-text">
          <strong>${left ? "You have an exam in progress" : "An unfinished exam ran out of time"}</strong>
          <span class="muted small">${
            left
              ? `${formatClock(left)} left · ${answered} of ${kit.exam.items.length} answered`
              : `${answered} of ${kit.exam.items.length} answered — resuming submits it straight away`
          }</span>
        </div>
        <div class="quiz-draft-actions">
          <button class="btn small primary" data-action="resume-exam">Resume</button>
          <button class="btn small ghost" data-action="discard-exam">Discard</button>
        </div>
      </div>`;
  }

  /** Saved exam sittings, each of which can be reviewed question by question. */
  function renderExamAttempts(kit) {
    const attempts = (kit.exam && kit.exam.attempts) || [];
    if (!attempts.length) return "";
    return `
      <section class="panel attempts-panel">
        <div class="panel-head">
          <div>
            <h2>Past exam sittings</h2>
            <p class="muted tiny">Every submitted practice test is kept here.</p>
          </div>
        </div>
        <ol class="attempt-list">
          ${attempts
            .map(
              (attempt) => `
                <li class="attempt-row">
                  <span class="attempt-score ${attempt.percent >= 70 ? "good" : attempt.percent >= 50 ? "mid" : "low"}">${attempt.percent}%</span>
                  <span class="attempt-main">
                    <strong>${attempt.correct}/${attempt.total} correct</strong>
                    <span class="muted tiny">${esc(new Date(attempt.takenAt).toLocaleString())}${
                      attempt.secondsUsed ? ` · ${formatClock(attempt.secondsUsed)}` : ""
                    }</span>
                  </span>
                  <span class="attempt-bar"><span style="width:${attempt.percent}%"></span></span>
                  <button class="btn ghost small" data-action="review-exam-attempt" data-id="${esc(attempt.id)}">Review</button>
                </li>`,
            )
            .join("")}
        </ol>
      </section>`;
  }

  function renderExamRunning(kit) {
    const exam = kit.exam;
    const answers = examState.answers;
    const answered = Object.keys(answers).length;
    const left = examSecondsLeft();

    return `
      <section class="panel">
        <div class="exam-bar">
          <div class="exam-timer">
            <span id="exam-clock" class="exam-clock ${left <= 60 ? "warn" : ""}">${formatClock(left)}</span>
            <span class="muted tiny">remaining</span>
          </div>
          <span class="muted tiny" id="exam-answered">${answered}/${exam.items.length} answered</span>
          <button class="btn small primary" data-action="submit-exam">Submit exam</button>
        </div>
        <div class="exam-palette" role="group" aria-label="Jump to a question">
          ${exam.items
            .map(
              (_, index) =>
                `<button class="palette-dot ${answers[index] !== undefined ? "done" : ""}" data-action="exam-jump" data-q="${index}"
                  aria-label="Question ${index + 1}${answers[index] !== undefined ? " (answered)" : ""}">${index + 1}</button>`,
            )
            .join("")}
        </div>
        <ol class="quiz exam-questions">
          ${exam.items
            .map(
              (item, index) => `
            <li class="q">
              <p class="q-text"><span class="q-number">${index + 1}</span>${esc(item.question)}</p>
              <div class="options">
                ${item.options
                  .map(
                    (option, optionIndex) => `<button class="option ${
                      answers[index] === optionIndex ? "selected" : ""
                    }" data-action="exam-answer" data-q="${index}" data-opt="${optionIndex}">
                      <span class="opt-letter">${String.fromCharCode(65 + optionIndex)}</span>
                      <span>${esc(option)}</span>
                    </button>`,
                  )
                  .join("")}
              </div>
            </li>`,
            )
            .join("")}
        </ol>
        <div class="row center">
          <button class="btn primary" data-action="submit-exam">Submit exam</button>
        </div>
      </section>`;
  }

  function renderExamResult(kit) {
    const exam = kit.exam;
    const result = examState.result || { correct: 0, total: exam.items.length, secondsUsed: 0 };
    const percent = result.total ? Math.round((result.correct / result.total) * 100) : 0;
    const grade =
      percent >= 85 ? "Excellent" : percent >= 70 ? "Solid pass" : percent >= 50 ? "Getting there" : "Needs work";

    return `
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Exam result</h2>
            <p class="muted tiny">${result.timedOut ? "Time ran out — the paper was submitted automatically." : "Submitted."}</p>
          </div>
          <div class="row tight">
            <button class="btn small" data-action="exam-overview">Past sittings</button>
            <button class="btn small" data-action="retake-exam">Retake</button>
            <button class="btn small" data-action="make-exam" data-id="${esc(kit.id)}">New exam</button>
          </div>
        </div>
        <div class="result-card">
          <span class="result-score">${result.correct}<span class="muted">/${result.total}</span></span>
          <span class="result-percent">${percent}%</span>
          <span class="badge ${percent >= 70 ? "ready" : "error"}">${esc(grade)}</span>
          <span class="muted tiny">in ${formatClock(result.secondsUsed)} of ${exam.durationMinutes}:00</span>
        </div>
        <div class="result-meter"><span style="width:${percent}%"></span></div>
        <h3 class="review-head">Review</h3>
        <ol class="quiz">
          ${exam.items
            .map((item, index) => {
              const chosen = examState.answers[index];
              const correct = chosen === item.answerIndex;
              return `
              <li class="q ${correct ? "q-correct" : "q-wrong"}">
                <p class="q-text"><span class="q-number">${index + 1}</span>${esc(item.question)}</p>
                <div class="options">
                  ${item.options
                    .map((option, optionIndex) => {
                      let cls = "option static";
                      if (optionIndex === item.answerIndex) cls += " correct";
                      else if (optionIndex === chosen) cls += " wrong";
                      return `<span class="${cls}">
                        <span class="opt-letter">${String.fromCharCode(65 + optionIndex)}</span>
                        <span>${esc(option)}</span>
                      </span>`;
                    })
                    .join("")}
                </div>
                <p class="muted tiny">${
                  chosen === undefined ? "Not answered." : correct ? "Correct." : "Incorrect — see the highlighted answer."
                }</p>
                ${item.explanation ? `<p class="explanation">${esc(item.explanation)}</p>` : ""}
              </li>`;
            })
            .join("")}
        </ol>
      </section>`;
  }

  function renderResourceRow(resource) {
    const pages = resource.pages || {};
    const meta = [];
    if (resource.type === "pdf" && pages.total) {
      meta.push(`${pages.total} page(s)`);
      if (pages.ocrPages && pages.ocrPages.length) meta.push(`${pages.ocrPages.length} OCR'd`);
    }
    if (resource.document) meta.push(`${(resource.document.length / 1000).toFixed(1)}k chars`);

    return `
      <article class="res-row">
        <span class="res-icon ${resource.type}">${resource.type === "pdf" ? "PDF" : "TXT"}</span>
        <div class="res-main">
          <a class="res-name" href="#/resource/${esc(resource.id)}">${esc(resource.name)}</a>
          <p class="muted tiny">
            ${esc(resource.statusMessage || meta.join(" · ") || "Waiting to process")}
          </p>
        </div>
        <span class="badge ${esc(resource.status)}">${esc(STATUS_LABEL[resource.status] || resource.status)}</span>
        <button class="icon-btn danger" title="Delete" data-action="delete-resource" data-id="${esc(resource.id)}">×</button>
      </article>`;
  }

  /* ------------------------------ resource ------------------------- */

  function renderResource(resource) {
    const kit = store.getKit(resource.kitId);
    const pages = resource.pages || {};
    const processing = resource.status === "processing";
    const editing = editingDocId === resource.id;
    const page = document.createElement("div");
    page.className = "page";

    page.innerHTML = `
      <nav class="crumbs"><a href="#/">Dashboard</a><span>/</span><a href="#/kit/${esc(resource.kitId)}">${esc(kit ? kit.name : "Kit")}</a><span>/</span><span>${esc(resource.name)}</span></nav>
      <header class="page-head">
        <div class="page-title">
          <p class="eyebrow">Resource</p>
          <h1>${esc(resource.name)}</h1>
          <p class="muted">
            <span class="badge ${esc(resource.status)}">${esc(STATUS_LABEL[resource.status] || resource.status)}</span>
            ${resource.type === "pdf" ? ` · PDF${pages.total ? ` · ${pages.total} page(s)` : ""}` : " · pasted text"}
            ${pages.ocrPages && pages.ocrPages.length ? ` · OCR pages ${pages.ocrPages.join(", ")}` : ""}
            ${resource.document ? ` · updated ${esc(relativeTime(resource.documentUpdatedAt))}` : ""}
          </p>
        </div>
        <div class="row">
          <a class="btn" href="#/kit/${esc(resource.kitId)}/questions">Quiz</a>
          <a class="btn" href="#/kit/${esc(resource.kitId)}/flashcards">Flashcards</a>
          <a class="btn" href="#/kit/${esc(resource.kitId)}/exam">Practice test</a>
          ${resource.type === "pdf" && !processing ? `<button class="btn" data-action="rerun-resource" data-id="${esc(resource.id)}">Re-run extraction</button>` : ""}
          <button class="btn danger" data-action="delete-resource" data-id="${esc(resource.id)}">Delete</button>
        </div>
      </header>

      ${resource.error ? `<div class="notice error"><strong>Processing failed.</strong> ${esc(resource.error)}</div>` : ""}
      ${processing ? `<div class="notice"><strong>Working…</strong> ${esc(resource.statusMessage || "Processing this resource.")}</div>` : ""}
      ${pages.gapNotes ? `<div class="notice subtle"><strong>Gap check:</strong> ${esc(pages.gapNotes)}</div>` : ""}

      <section class="panel">
        <div class="panel-head">
          <h2>Study document</h2>
          <div class="row tight">
            ${
              resource.document
                ? editing
                  ? `<button class="btn primary small" data-action="save-doc" data-id="${esc(resource.id)}">Save</button>
                     <button class="btn small" data-action="cancel-doc">Cancel</button>`
                  : `<button class="btn small" data-action="edit-doc" data-id="${esc(resource.id)}">Edit</button>
                     <button class="btn small" data-action="copy-doc" data-id="${esc(resource.id)}">Copy</button>
                     <button class="btn small" data-action="download-doc" data-id="${esc(resource.id)}">Download .md</button>`
                : ""
            }
          </div>
        </div>
        ${
          resource.document
            ? editing
              ? `<textarea class="doc-editor" data-draft="doc-${esc(resource.id)}" data-doc-id="${esc(resource.id)}" rows="24">${esc(resource.document)}</textarea>`
              : `<article class="md">${md.render(resource.document)}</article>`
            : `<div class="empty">
                 <h3>No document yet</h3>
                 <p class="muted">${processing ? "This resource is being processed." : "Processing did not finish. Re-run extraction to build the study document."}</p>
               </div>`
        }
      </section>`;

    return page;
  }

  /* ------------------------------------------------------------------ *
   * Job bar
   * ------------------------------------------------------------------ */

  function renderJobBar() {
    const job = jobs.getCurrent();
    const queued = jobs.getQueue();

    if (!job) {
      els.jobBar.hidden = true;
      els.jobBar.innerHTML = "";
      return;
    }

    els.jobBar.hidden = false;
    const percent = Math.max(2, Math.min(100, Math.round(job.progress || 0)));
    els.jobBar.innerHTML = `
      <div class="job-info">
        <div class="job-title">${esc(job.label || "Processing")}${queued.length ? ` <span class="muted tiny">(+${queued.length} queued)</span>` : ""}</div>
        <div class="job-step">${esc(job.step || "Starting…")}</div>
      </div>
      <div class="meter"><span style="width:${percent}%"></span></div>
      <button class="btn small" data-job-action="cancel">Cancel</button>`;

    els.jobBar.querySelector("[data-job-action='cancel']").addEventListener("click", () => jobs.cancelCurrent());
  }

  /* ------------------------------------------------------------------ *
   * Toasts and modals
   * ------------------------------------------------------------------ */

  function toast(message, type = "info", action = null) {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    const label = document.createElement("span");
    label.textContent = message;
    node.appendChild(label);
    const lifetime = action ? 9000 : 4200;
    let timer = null;
    const dismiss = () => {
      if (timer) clearTimeout(timer);
      node.classList.add("leaving");
      setTimeout(() => node.remove(), 250);
    };
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "toast-action";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        dismiss();
        action.onClick();
      });
      node.appendChild(button);
    }
    els.toasts.appendChild(node);
    timer = setTimeout(dismiss, lifetime);
  }

  /**
   * Deleting is the one destructive action here, so give it a real undo: the
   * whole state is snapshotted first and put back by the toast button.
   */
  function undoableDelete(apply, description) {
    const snapshot = JSON.parse(store.exportData());
    apply();
    toast(description, "success", {
      label: "Undo",
      onClick: () => {
        store.restore(snapshot);
        render();
        toast("Restored.", "info");
      },
    });
  }

  /** Where focus was before the dialog opened, so it can be put back. */
  let modalReturnFocus = null;

  function closeModal() {
    els.modalRoot.innerHTML = "";
    els.modalRoot.hidden = true;
    if (modalReturnFocus && document.contains(modalReturnFocus)) {
      try {
        modalReturnFocus.focus({ preventScroll: true });
      } catch (error) {
        /* the element may be gone */
      }
    }
    modalReturnFocus = null;
  }

  /** Keep Tab inside an open dialog. */
  function trapModalFocus(event) {
    if (els.modalRoot.hidden || event.key !== "Tab") return;
    const focusable = [
      ...els.modalRoot.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * @param {{title:string, body:string, confirmLabel?:string, danger?:boolean, wide?:boolean,
   *          onConfirm?:Function, onMount?:Function}} options
   */
  function openModal(options) {
    modalReturnFocus = document.activeElement;
    els.modalRoot.hidden = false;
    els.modalRoot.innerHTML = `
      <div class="modal-backdrop" data-close></div>
      <div class="modal ${options.wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(options.title)}">
        <header class="modal-head">
          <h2>${esc(options.title)}</h2>
          <button class="icon-btn" data-close title="Close">×</button>
        </header>
        <div class="modal-body">${options.body}</div>
        <footer class="modal-foot">
          <button class="btn" data-close>Cancel</button>
          <button class="btn ${options.danger ? "danger-solid" : "primary"}" data-confirm>${esc(options.confirmLabel || "Save")}</button>
        </footer>
      </div>`;

    els.modalRoot.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeModal));
    const confirm = els.modalRoot.querySelector("[data-confirm]");
    confirm.addEventListener("click", async () => {
      const result = options.onConfirm ? await options.onConfirm(els.modalRoot) : true;
      if (result !== false) closeModal();
    });
    if (options.onMount) options.onMount(els.modalRoot);
    const firstField = els.modalRoot.querySelector("input, textarea, select");
    const dialog = els.modalRoot.querySelector(".modal");
    setTimeout(() => {
      if (firstField) firstField.focus();
      else if (dialog) {
        dialog.setAttribute("tabindex", "-1");
        dialog.focus();
      }
    }, 30);
  }

  function confirmDialog(title, message, confirmLabel = "Delete") {
    openModal({
      title,
      body: `<p>${esc(message)}</p>`,
      confirmLabel,
      danger: true,
      onConfirm: () => true,
    });
  }

  /* ------------------------------------------------------------------ *
   * Modals: classes, kits, settings
   * ------------------------------------------------------------------ */

  function classOptions(selected) {
    return [
      `<option value="">No class (uncategorised)</option>`,
      ...store.get().classes.map(
        (cls) => `<option value="${esc(cls.id)}" ${cls.id === selected ? "selected" : ""}>${esc(cls.name)}</option>`,
      ),
    ].join("");
  }

  function openNewKit(prefillClassId = null) {
    const classId = prefillClassId || (filterClassId ? filterClassId : "");
    openModal({
      title: "New study kit",
      confirmLabel: "Create",
      body: `
        <div class="field"><label for="kit-name">Name</label>
          <input id="kit-name" type="text" placeholder="e.g. Biology — Cells & Transport"></div>
        <div class="field"><label for="kit-subject">Subject / focus (optional)</label>
          <input id="kit-subject" type="text" placeholder="e.g. Year 11 Biology, Unit 2"></div>
        <div class="field"><label for="kit-class">Class</label>
          <select id="kit-class">${classOptions(classId)}</select></div>`,
      onConfirm: (root) => {
        const name = root.querySelector("#kit-name").value.trim();
        if (!name) return false;
        const kit = store.addKit({
          name,
          subject: root.querySelector("#kit-subject").value,
          classId: root.querySelector("#kit-class").value || null,
        });
        toast("Study kit created.", "success");
        navigate(`#/kit/${kit.id}`);
      },
    });
  }

  function openEditKit(id) {
    const kit = store.getKit(id);
    if (!kit) return;
    openModal({
      title: "Edit study kit",
      confirmLabel: "Save",
      body: `
        <div class="field"><label for="kit-name">Name</label>
          <input id="kit-name" type="text" value="${esc(kit.name)}"></div>
        <div class="field"><label for="kit-subject">Subject / focus</label>
          <input id="kit-subject" type="text" value="${esc(kit.subject)}"></div>
        <div class="field"><label for="kit-class">Class</label>
          <select id="kit-class">${classOptions(kit.classId)}</select></div>`,
      onConfirm: (root) => {
        const name = root.querySelector("#kit-name").value.trim();
        if (!name) return false;
        store.updateKit(id, {
          name,
          subject: root.querySelector("#kit-subject").value,
          classId: root.querySelector("#kit-class").value || null,
        });
        toast("Study kit updated.", "success");
      },
    });
  }

  function openRenameKit(id) {
    const kit = store.getKit(id);
    if (!kit) return;
    openModal({
      title: "Rename study kit",
      confirmLabel: "Rename",
      body: `<div class="field"><label for="kit-name">Name</label>
        <input id="kit-name" type="text" value="${esc(kit.name)}"></div>`,
      onConfirm: (root) => {
        const name = root.querySelector("#kit-name").value.trim();
        if (!name) return false;
        store.updateKit(id, { name });
        toast("Study kit renamed.", "success");
      },
    });
  }

  function openMoveKit(id) {
    const kit = store.getKit(id);
    if (!kit) return;
    openModal({
      title: "Move to class",
      confirmLabel: "Move",
      body: `<div class="field"><label for="kit-class">Class</label>
        <select id="kit-class">${classOptions(kit.classId)}</select></div>`,
      onConfirm: (root) => {
        store.updateKit(id, { classId: root.querySelector("#kit-class").value || null });
        toast("Study kit moved.", "success");
      },
    });
  }

  function openNewClass() {
    openModal({
      title: "New class",
      confirmLabel: "Create",
      body: `<div class="field"><label for="class-name">Class name</label>
        <input id="class-name" type="text" placeholder="e.g. Year 11 Biology"></div>`,
      onConfirm: (root) => {
        const name = root.querySelector("#class-name").value.trim();
        if (!name) return false;
        const cls = store.addClass(name);
        filterClassId = cls.id;
        toast("Class created.", "success");
      },
    });
  }

  function openRenameClass(id) {
    const cls = store.getClass(id);
    if (!cls) return;
    openModal({
      title: "Rename class",
      confirmLabel: "Rename",
      body: `<div class="field"><label for="class-name">Class name</label>
        <input id="class-name" type="text" value="${esc(cls.name)}"></div>`,
      onConfirm: (root) => {
        const name = root.querySelector("#class-name").value.trim();
        if (!name) return false;
        store.renameClass(id, name);
        toast("Class renamed.", "success");
      },
    });
  }

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  const CUSTOM_MODEL = "__custom__";

  const PROVIDER_ORDER = ["local", "gemini", "openrouter", "nvidia", "custom"];

  function providerCard(id, draft) {
    const info = StudyForge.ai.providers()[id];
    const active = draft.provider === id;
    const badge = id === "local" ? "No key" : info.needsKey && !draft.keys[id] ? "Key needed" : "Ready";
    const ready = id === "local" || (info.needsKey ? Boolean(draft.keys[id]) : Boolean(draft.baseUrl));
    return `
      <button type="button" class="provider-card ${active ? "active" : ""}" data-provider="${id}">
        <span class="provider-top">
          <strong>${esc(info.label)}</strong>
          <span class="provider-badge ${ready ? "ok" : "warn"}">${esc(badge)}</span>
        </span>
        <span class="provider-blurb">${esc(info.blurb)}</span>
      </button>`;
  }

  function modelChoices(draft) {
    const info = StudyForge.ai.providers()[draft.provider];
    const saved = draft.models[draft.provider] || "";
    const ids = new Set([info.model, saved, ...(draft.catalogue[draft.provider] || [])].filter(Boolean));
    return [...ids];
  }

  /** The provider-specific half of the settings form. */
  function providerPanel(draft) {
    const info = StudyForge.ai.providers()[draft.provider];
    if (info.kind === "local") {
      return `
        <div class="notice subtle">
          <strong>Nothing to set up.</strong> Study guides, flashcards, quizzes and practice tests are generated in
          this tab from your notes. No key, no network, no cost. Connect an AI provider below for richer rewrites.
        </div>`;
    }

    const key = draft.keys[draft.provider] || "";
    const choices = modelChoices(draft);
    const currentModel = draft.models[draft.provider] || info.model || "";

    return `
      <div class="field">
        <label for="set-key">${esc(info.keyLabel)}</label>
        <input id="set-key" type="password" autocomplete="off" spellcheck="false"
          value="${esc(key)}" placeholder="${esc(info.keyPlaceholder || "")}">
        <span class="hint">
          Stored in this browser only. ${
            info.keyUrl
              ? `<a href="${esc(info.keyUrl)}" target="_blank" rel="noopener">Get a key →</a>`
              : ""
          }
        </span>
      </div>
      ${
        draft.provider === "custom"
          ? `<div class="field">
              <label for="set-base">Endpoint base URL</label>
              <input id="set-base" type="text" spellcheck="false" value="${esc(draft.baseUrl)}"
                placeholder="https://my-relay.example.workers.dev/v1">
              <span class="hint">Any OpenAI-compatible base URL. Requests go to <code>/chat/completions</code> and <code>/models</code>.</span>
            </div>`
          : ""
      }
      <div class="field">
        <label for="set-model">Model</label>
        <select id="set-model">
          ${choices
            .map(
              (id) =>
                `<option value="${esc(id)}" ${id === currentModel ? "selected" : ""}>${esc(id)}${
                  id === info.model ? " (recommended)" : ""
                }</option>`,
            )
            .join("")}
          <option value="${CUSTOM_MODEL}" ${choices.includes(currentModel) ? "" : "selected"}>Custom model id…</option>
        </select>
        <input id="set-model-custom" type="text" placeholder="model-id" hidden value="${
          choices.includes(currentModel) ? "" : esc(currentModel)
        }">
        <div class="row tight" style="margin-top:6px">
          <button type="button" class="btn small" id="set-models-refresh">Load models</button>
          <button type="button" class="btn small" id="set-test">Test connection</button>
          <span class="hint" id="set-provider-status"></span>
        </div>
      </div>`;
  }

  function settingsDraftFromStore() {
    const settings = store.getSettings();
    return {
      provider: settings.provider || "local",
      keys: {
        gemini: settings.providerKeys.gemini || "",
        openrouter: settings.providerKeys.openrouter || "",
        nvidia: settings.providerKeys.nvidia || "",
        custom: settings.providerKeys.custom || "",
      },
      baseUrl: settings.baseUrl || "",
      models: { ...(settings.modelByProvider || {}) },
      catalogue: {},
      ocrLanguage: settings.ocrLanguage,
      ocrScale: settings.ocrScale,
      flashcardStyle: settings.flashcardStyle,
      weeklyGoal: settings.weeklyGoal || 5,
      savedModel: settings.model,
    };
  }

  /** Read back a saved attempt: your answer next to the model answer. */
  /* --------------------------- find in guide ------------------------ */

  let docFind = { timer: 0, matches: [], index: 0 };

  function scheduleDocFind(value) {
    clearTimeout(docFind.timer);
    docFind.timer = setTimeout(() => applyDocFind(String(value || "").trim()), 150);
  }

  function updateDocFindCounter() {
    const counter = els.view.querySelector("[data-doc-find-count]");
    if (!counter) return;
    counter.textContent = docFind.matches.length
      ? `${docFind.index + 1}/${docFind.matches.length}`
      : "";
  }

  /** Undo any highlighting, leaving the rendered guide exactly as it was. */
  function clearDocFind() {
    const body = els.view.querySelector("[data-doc-body]");
    if (body) {
      body.querySelectorAll("mark.doc-hit").forEach((mark) => {
        mark.replaceWith(document.createTextNode(mark.textContent));
      });
      body.normalize();
    }
    docFind.matches = [];
    docFind.index = 0;
    updateDocFindCounter();
  }

  /** Highlight every occurrence of the query inside the guide and jump to the first. */
  function applyDocFind(query) {
    const body = els.view.querySelector("[data-doc-body]");
    if (!body) return;
    clearDocFind();
    if (query.length < 2) return;
    const needle = query.toLowerCase();
    const walker = document.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */, null);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!node.nodeValue.trim() || !parent) continue;
      if (/^(SCRIPT|STYLE|MARK)$/.test(parent.tagName)) continue;
      if (node.nodeValue.toLowerCase().includes(needle)) nodes.push(node);
    }
    for (const node of nodes) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      const fragment = document.createDocumentFragment();
      let start = 0;
      let at = lower.indexOf(needle, start);
      while (at !== -1) {
        if (at > start) fragment.appendChild(document.createTextNode(text.slice(start, at)));
        const mark = document.createElement("mark");
        mark.className = "doc-hit";
        mark.textContent = text.slice(at, at + needle.length);
        fragment.appendChild(mark);
        start = at + needle.length;
        at = lower.indexOf(needle, start);
      }
      if (start < text.length) fragment.appendChild(document.createTextNode(text.slice(start)));
      node.replaceWith(fragment);
    }
    docFind.matches = [...body.querySelectorAll("mark.doc-hit")];
    docFind.index = 0;
    focusDocMatch();
  }

  function focusDocMatch() {
    docFind.matches.forEach((mark, index) => mark.classList.toggle("current", index === docFind.index));
    const current = docFind.matches[docFind.index];
    if (current) current.scrollIntoView({ block: "center", behavior: "smooth" });
    updateDocFindCounter();
  }

  function stepDocFind(direction) {
    if (!docFind.matches.length) return;
    const length = docFind.matches.length;
    docFind.index = (docFind.index + direction + length) % length;
    focusDocMatch();
  }

  /* --------------------------- read aloud --------------------------- */

  /**
   * Read the study guide with the browser's built-in speech synthesis. Works
   * offline, needs no key, and reads in sentence-sized chunks so stopping is
   * immediate.
   */
  function startSpeech(resource) {
    if (!("speechSynthesis" in window) || typeof window.SpeechSynthesisUtterance !== "function") {
      toast("This browser cannot read text aloud.", "error");
      return;
    }
    stopSpeech();
    const chunks = String(resource.document || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^#{1,6}\s*/gm, "")
      .replace(/[*_`>#-]/g, " ")
      .replace(/\|/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 1);
    if (!chunks.length) return;

    speechState = { speaking: true, resourceId: resource.id };
    render();
    toast("Reading the study guide aloud. Press Stop reading to finish.", "info");

    let index = 0;
    const speakNext = () => {
      if (!speechState.speaking) return;
      if (index >= chunks.length) {
        stopSpeech();
        return;
      }
      const utterance = new window.SpeechSynthesisUtterance(chunks[index]);
      utterance.rate = 1;
      utterance.onend = () => {
        index += 1;
        speakNext();
      };
      utterance.onerror = () => stopSpeech();
      window.speechSynthesis.speak(utterance);
    };
    speakNext();
  }

  function stopSpeech() {
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch (error) {
        /* nothing to cancel */
      }
    }
    if (!speechState.speaking) return;
    speechState = { speaking: false, resourceId: null };
    if (route.name === "kit") render();
  }

  function openAttemptReview(attempt) {
    const rows = (attempt.answers || [])
      .map(
        (entry, index) => `
          <li class="review-row ${entry.correct ? "ok" : "bad"}">
            <div class="review-head">
              <span class="review-index">${index + 1}</span>
              <span class="review-q">${esc(entry.question)}${
                entry.seconds ? ` <span class="muted tiny">· ${entry.seconds}s</span>` : ""
              }</span>
              <span class="badge ${entry.correct ? "ready" : "error"}">${entry.correct ? "Correct" : "Review"}</span>
            </div>
            <p class="review-line"><span class="review-key">Your answer</span><span>${esc(entry.given || "— not answered —")}</span></p>
            ${!entry.correct ? `<p class="review-line"><span class="review-key">Model answer</span><span>${esc(entry.expected || "")}</span></p>` : ""}
            ${entry.feedback ? `<p class="review-line muted"><span class="review-key">Feedback</span><span>${esc(entry.feedback)}</span></p>` : ""}
          </li>`,
      )
      .join("");
    openModal({
      title: `Attempt review — ${attempt.percent}%`,
      wide: true,
      confirmLabel: "Close",
      body: `
        <p class="muted small">${attempt.correct} of ${attempt.total} correct · ${esc(
          new Date(attempt.takenAt).toLocaleString(),
        )}${attempt.secondsUsed ? ` · took ${formatClock(attempt.secondsUsed)}` : ""}</p>
        <ol class="review-list">${rows || '<li class="muted">This attempt has no saved answers.</li>'}</ol>`,
      onConfirm: () => true,
    });
  }

  function openShortcuts() {
    openModal({
      title: "Keyboard shortcuts",
      confirmLabel: "Got it",
      body: `
        <div class="shortcut-list">
          ${[
            ["⌘K / Ctrl-K", "Search kits, resources and guide text"],
            ["1 – 4", "Pick a quiz option"],
            ["Enter", "Mark & next, or flip a card"],
            ["Space", "Flip a flashcard"],
            ["← / →", "Previous / next card"],
            ["1 / K · 2 / A", "Got it · show again"],
            ["Enter", "Jump to the next find match in a guide"],
            ["?", "This list"],
            ["Esc", "Close a dialog"],
          ]
            .map(
              ([keys, meaning]) =>
                `<div class="shortcut-row"><kbd>${esc(keys)}</kbd><span>${esc(meaning)}</span></div>`,
            )
            .join("")}
        </div>`,
      onConfirm: () => true,
    });
  }

  function openSettings(note) {
    const draft = settingsDraftFromStore();
    if (!draft.models[draft.provider] && draft.provider === "nvidia") draft.models.nvidia = draft.savedModel;

    openModal({
      title: "Settings",
      confirmLabel: "Save settings",
      wide: true,
      body: `
        ${note ? `<div class="notice">${esc(note)}</div>` : ""}
        <p class="label" style="margin-bottom:8px">Where should StudyForge generate from?</p>
        <div class="provider-grid" id="provider-grid">
          ${PROVIDER_ORDER.map((id) => providerCard(id, draft)).join("")}
        </div>
        <div id="provider-panel">${providerPanel(draft)}</div>

        <details class="settings-more">
          <summary>Documents, OCR and defaults</summary>
          <div class="field-row">
            <div class="field"><label for="set-lang">OCR language</label>
              <select id="set-lang">
                ${[
                  ["eng", "English"],
                  ["jpn", "Japanese"],
                  ["eng+jpn", "English + Japanese"],
                  ["chi_sim", "Chinese (Simplified)"],
                  ["fra", "French"],
                  ["deu", "German"],
                  ["spa", "Spanish"],
                ]
                  .map(
                    ([value, label]) =>
                      `<option value="${value}" ${draft.ocrLanguage === value ? "selected" : ""}>${label}</option>`,
                  )
                  .join("")}
              </select>
            </div>
            <div class="field"><label for="set-scale">OCR render quality</label>
              <select id="set-scale">
                ${[1, 1.5, 2, 2.5, 3]
                  .map(
                    (value) =>
                      `<option value="${value}" ${Number(draft.ocrScale) === value ? "selected" : ""}>${value}×</option>`,
                  )
                  .join("")}
              </select>
            </div>
          </div>
          <div class="field">
            <label for="set-goal">Weekly study goal</label>
            <select id="set-goal">
              ${[2, 3, 4, 5, 6, 7]
                .map(
                  (value) =>
                    `<option value="${value}" ${Number(draft.weeklyGoal) === value ? "selected" : ""}>${value} days a week</option>`,
                )
                .join("")}
            </select>
            <span class="hint">Shown as a week tracker on the dashboard.</span>
          </div>
          <div class="field">
            <label for="set-cards">Default flashcard style</label>
            <select id="set-cards">
              <option value="vocab" ${draft.flashcardStyle === "vocab" ? "selected" : ""}>Vocabulary &amp; concepts — term on the front</option>
              <option value="question" ${draft.flashcardStyle === "question" ? "selected" : ""}>Exam-style questions — question on the front</option>
            </select>
          </div>
          <div class="notice subtle">
            <strong>Build:</strong> ${esc((globalThis.STUDYFORGE_CONFIG || {}).version || "unknown")}<br>
            <strong>Engine:</strong> ${esc(StudyForge.ai.providerLabel())}<br>
            <strong>Storage:</strong> ${(store.storageBytes() / 1024).toFixed(0)} KB used in this browser.
            Uploaded files and their raw text are never stored.
          </div>
          <div class="notice subtle">
            <strong>Install &amp; offline</strong>
            <p class="tiny">StudyForge works offline once it has been opened here. Install it to get an app icon and a full-screen window.</p>
            <button class="btn small" data-install-app ${installPrompt ? "" : 'hidden title="Use your browser menu → Install app"'}>Install app</button>
            <span class="tiny muted" id="install-status">${installPrompt ? "Ready to install." : "Not installable here yet — use your browser's Install option."}</span>
          </div>
          <div class="notice error-soft">
            <strong>Danger zone</strong>
            <p class="tiny">Delete every class, study kit, resource, guide and attempt from this browser.</p>
            <button class="btn small danger-solid" data-clear-all>Delete all data</button>
          </div>
        </details>`,
      onMount: (root) => {
        const panel = root.querySelector("#provider-panel");
        const grid = root.querySelector("#provider-grid");
        const statusEl = () => root.querySelector("#set-provider-status");

        // Keep what has been typed when the panel is re-rendered.
        const capture = () => {
          const key = root.querySelector("#set-key");
          if (key) draft.keys[draft.provider] = key.value.trim();
          const base = root.querySelector("#set-base");
          if (base) draft.baseUrl = base.value.trim();
          const model = readModelField(root);
          if (model) draft.models[draft.provider] = model;
        };

        const repaintPanel = () => {
          panel.innerHTML = providerPanel(draft);
          syncCustomInput(root);
          wirePanel();
        };

        const wirePanel = () => {
          const key = root.querySelector("#set-key");
          if (key) {
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "btn small";
            toggle.textContent = "Show";
            toggle.style.marginTop = "6px";
            toggle.addEventListener("click", () => {
              const show = key.type === "password";
              key.type = show ? "text" : "password";
              toggle.textContent = show ? "Hide" : "Show";
            });
            key.insertAdjacentElement("afterend", toggle);
            key.addEventListener("input", () => {
              draft.keys[draft.provider] = key.value.trim();
            });
          }
          const base = root.querySelector("#set-base");
          if (base) base.addEventListener("input", () => (draft.baseUrl = base.value.trim()));

          const modelSelect = root.querySelector("#set-model");
          if (modelSelect) {
            modelSelect.addEventListener("change", () => {
              syncCustomInput(root);
              const input = root.querySelector("#set-model-custom");
              if (input && modelSelect.value === CUSTOM_MODEL) input.focus();
              else draft.models[draft.provider] = modelSelect.value;
            });
            syncCustomInput(root);
          }

          const refresh = root.querySelector("#set-models-refresh");
          if (refresh) refresh.addEventListener("click", () => loadModels(root, draft, { statusEl, button: refresh }));
          const test = root.querySelector("#set-test");
          if (test) test.addEventListener("click", () => testConnection(root, draft, { statusEl, button: test }));
        };

        const wireGrid = () => {
          grid.querySelectorAll("[data-provider]").forEach((button) => {
            button.addEventListener("click", () => {
              if (draft.provider === button.dataset.provider) return;
              capture();
              draft.provider = button.dataset.provider;
              grid.innerHTML = PROVIDER_ORDER.map((id) => providerCard(id, draft)).join("");
              repaintPanel();
              wireGrid();
            });
          });
        };

        wirePanel();
        wireGrid();

        root.querySelector("[data-clear-all]").addEventListener("click", () => {
          closeModal();
          openModal({
            title: "Delete all data?",
            body: `<p>This removes every class, kit, resource, guide, saved attempt and setting stored in this browser. Export a backup first if you need one.</p>`,
            confirmLabel: "Delete everything",
            danger: true,
            onConfirm: () => {
              try {
                localStorage.removeItem(store.STORAGE_KEY);
              } catch (error) {
                /* ignore */
              }
              filterClassId = null;
              editingDocId = null;
              lastQuizKey = null;
              docViewId = null;
              location.hash = "#/";
              store.load();
              renderProviderBadge();
              toast("All local data deleted.", "success");
            },
          });
        });
      },
      onConfirm: (root) => {
        const info = StudyForge.ai.providers()[draft.provider];
        const key = root.querySelector("#set-key");
        if (key) draft.keys[draft.provider] = key.value.trim();
        const base = root.querySelector("#set-base");
        if (base) draft.baseUrl = base.value.trim();
        const model = readModelField(root);
        if (model) draft.models[draft.provider] = model;

        if (info.kind !== "local" && info.needsKey && !draft.keys[draft.provider]) {
          toast(`Paste your ${info.keyLabel} to use ${info.label}.`, "error");
          return false;
        }
        if (draft.provider === "custom" && !draft.baseUrl) {
          toast("Add the endpoint base URL for your custom provider.", "error");
          return false;
        }

        store.setSettings({
          provider: draft.provider,
          providerKeys: draft.keys,
          baseUrl: draft.baseUrl,
          apiKey: draft.keys[draft.provider] || "",
          model: draft.models[draft.provider] || StudyForge.ai.providers()[draft.provider].model || store.getSettings().model,
          modelByProvider: draft.models,
          ocrLanguage: root.querySelector("#set-lang").value,
          ocrScale: Number(root.querySelector("#set-scale").value),
          flashcardStyle: root.querySelector("#set-cards").value,
          weeklyGoal: Number(root.querySelector("#set-goal").value),
        });
        renderProviderBadge();
        toast(
          draft.provider === "local" ? "Using the on-device engine." : `${info.label} connected.`,
          "success",
        );
      },
    });
  }

  /** Rebuild the model <select> after loading a catalogue. */
  function fillModelChoices(root, draft) {
    const select = root.querySelector("#set-model");
    if (!select) return;
    const current = draft.models[draft.provider] || StudyForge.ai.providers()[draft.provider].model || "";
    const choices = modelChoices(draft);
    select.innerHTML =
      choices
        .map(
          (id) =>
            `<option value="${esc(id)}" ${id === current ? "selected" : ""}>${esc(id)}${
              id === StudyForge.ai.providers()[draft.provider].model ? " (recommended)" : ""
            }</option>`,
        )
        .join("") +
      `<option value="${CUSTOM_MODEL}" ${choices.includes(current) ? "" : "selected"}>Custom model id…</option>`;
    syncCustomInput(root);
  }

  function syncCustomInput(root) {
    const select = root.querySelector("#set-model");
    const input = root.querySelector("#set-model-custom");
    if (!select || !input) return;
    input.hidden = select.value !== CUSTOM_MODEL;
  }

  function readModelField(root) {
    const select = root.querySelector("#set-model");
    const input = root.querySelector("#set-model-custom");
    if (!select) return "";
    if (select.value === CUSTOM_MODEL) return input ? input.value.trim() : "";
    return select.value;
  }

  async function loadModels(root, draft, { statusEl, button }) {
    const info = StudyForge.ai.providers()[draft.provider];
    if (button) button.disabled = true;
    const status = statusEl();
    if (status) status.textContent = `Loading models from ${info.label}…`;
    try {
      const { models } = await StudyForge.ai.listModels({
        apiKey: draft.keys[draft.provider],
        baseUrl: draft.baseUrl,
      });
      draft.catalogue[draft.provider] = models.map((model) => model.id);
      fillModelChoices(root, draft);
      if (status) {
        status.textContent = models.length
          ? `${models.length} model(s) available.`
          : "No models were returned — type a model id instead.";
      }
    } catch (error) {
      if (status) status.textContent = StudyForge.ai.describeError(error);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function testConnection(root, draft, { statusEl, button }) {
    const info = StudyForge.ai.providers()[draft.provider];
    const status = statusEl();
    if (!info || info.kind === "local") {
      if (status) status.textContent = "The on-device engine needs no connection.";
      return;
    }
    const key = draft.keys[draft.provider];
    if (info.needsKey && !key) {
      if (status) status.textContent = "Add a key first.";
      return;
    }
    if (button) button.disabled = true;
    if (status) status.textContent = `Asking ${info.label} for a quick reply…`;
    try {
      const { content } = await StudyForge.ai.chat({
        apiKey: key,
        baseUrl: draft.baseUrl,
        model: draft.models[draft.provider] || "",
        prompt: "Reply with exactly: OK",
        maxTokens: 16,
        temperature: 0,
      });
      if (status) status.textContent = `Connected ✓ (${content.slice(0, 40)})`;
      toast(`${info.label} is working.`, "success");
    } catch (error) {
      if (status) status.textContent = StudyForge.ai.describeError(error);
      toast(StudyForge.ai.describeError(error), "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Flashcard deck actions
   * ------------------------------------------------------------------ */

  function moveCard(step) {
    const kit = store.getKit(route.id);
    if (!kit) return;
    const order = deckOrder(kit);
    if (!order.length) return;
    const next = Math.min(order.length - 1, Math.max(0, flashState.index + step));
    flashState.index = next;
    flashState.flipped = false;
    flashState.typed = "";
    flashState.typedVerdict = null;
    flashState.finished = false;
    render();
  }

  function markCard(kind) {
    const kit = store.getKit(route.id);
    if (!kit) return;
    const order = deckOrder(kit);
    if (!order.length) return;
    const cardIndex = order[flashState.index];
    const card = kit.flashcards.items[cardIndex];
    if (card) {
      const rating = store.rateCard(kit.id, cardKey(card), kind === "known" ? "known" : "again");
      if (rating) flashState.lastScheduled = { front: card.front, dueAt: rating.dueAt };
    }
    if (kind === "known") {
      flashState.known[cardIndex] = true;
      delete flashState.again[cardIndex];
    } else {
      flashState.again[cardIndex] = true;
      delete flashState.known[cardIndex];
    }
    flashState.typed = "";
    flashState.typedVerdict = null;
    if (flashState.index < order.length - 1) {
      flashState.index += 1;
      flashState.flipped = false;
      render();
    } else {
      flashState.flipped = false;
      flashState.finished = true;
      render();
    }
  }

  function shuffleDeck() {
    const kit = store.getKit(route.id);
    if (!kit) return;
    const order = deckOrder(kit).slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    flashState.order = order;
    flashState.index = 0;
    flashState.flipped = false;
    flashState.finished = false;
    flashState.typed = "";
    flashState.typedVerdict = null;
    flashState.shuffled = true;
    flashState.reviewMode = false;
    flashState.dueOnly = false;
    flashState.hardMode = false;
    flashState.hardList = null;
    render();
    toast("Deck shuffled.", "success");
  }

  function flashcardsToMarkdown(kit) {
    const set = kit.flashcards;
    const styleLabel = set.style === "question" ? "exam-style questions" : "vocabulary & concepts";
    const lines = [`# ${kit.name} — flashcards (${styleLabel})`, ""];
    if (set.sourceNames && set.sourceNames.length) lines.push(`Sources: ${set.sourceNames.join(", ")}`, "");
    set.items.forEach((card, index) => {
      lines.push(`**${index + 1}. ${card.front}**`, "", card.back, "");
    });
    return lines.join("\n");
  }

  /**
   * Flip the visible card by toggling a class on the live element instead of
   * rebuilding the view — that is what lets the 3D flip animate.
   */
  function flipCard() {
    const card = els.view.querySelector(".flashcard");
    flashState.flipped = !flashState.flipped;
    if (!card) {
      render();
      return;
    }
    card.classList.toggle("is-flipped", flashState.flipped);
    card.setAttribute("aria-pressed", String(flashState.flipped));
    const label = card.parentElement.parentElement.querySelector("[data-flip-label]");
    if (label) label.textContent = flashState.flipped ? "Show prompt" : "Show answer";
  }

  /* ------------------------------------------------------------------ *
   * Quiz run
   * ------------------------------------------------------------------ */

  function startQuiz(kitId) {
    const kit = store.getKit(kitId || quizState.kitId);
    if (!kit || !kit.quiz || !kit.quiz.items.length) {
      toast("Generate a quiz first.", "error");
      return;
    }
    clearQuizDraft();
    quizState = {
      kitId: kit.id,
      status: "running",
      index: 0,
      phase: "answering",
      answers: {},
      results: {},
      startedAt: Date.now(),
      questionStartedAt: Date.now(),
      attempt: null,
      items: null,
      retry: false,
    };
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** The current answer, read from state (and the live textarea for short answers). */
  function currentAnswer(item, index) {
    if (item.type !== "short") return quizState.answers[index] || null;
    const field = els.view.querySelector("[data-quiz-input]");
    if (field) quizState.answers[index] = { text: field.value };
    return quizState.answers[index] || null;
  }

  function hasUsableAnswer(item, answer) {
    if (!answer) return false;
    if (item.type === "mcq") return Number.isInteger(answer.choice);
    return typeof answer.text === "string" && answer.text.trim().length > 0;
  }

  /**
   * The single "Next" button. Before marking it locks and marks the answer;
   * after marking it moves on (or submits on the last question).
   */
  async function quizNext() {
    if (quizState.status !== "running" || quizState.phase === "marking") return;
    const kit = store.getKit(quizState.kitId);
    if (!kit || !kit.quiz) return;
    const items = activeQuizItems(kit);
    const index = Math.min(quizState.index, items.length - 1);
    const item = items[index];

    if (quizState.phase === "marked") {
      if (index >= items.length - 1) {
        finishQuiz();
      } else {
        quizState.index = index + 1;
        quizState.phase = "answering";
        quizState.questionStartedAt = Date.now();
        saveQuizDraft();
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      return;
    }

    const answer = currentAnswer(item, index);
    if (!hasUsableAnswer(item, answer)) {
      toast(item.type === "mcq" ? "Choose an option first." : "Write an answer first.", "error");
      return;
    }

    quizState.phase = "marking";
    render();

    let result;
    if (item.type === "mcq") {
      const correct = answer.choice === item.answerIndex;
      result = {
        correct,
        score: correct ? 1 : 0,
        feedback: "",
        markedBy: "auto",
        expected: item.options[item.answerIndex] || item.answer,
        given: item.options[answer.choice] || "",
      };
    } else {
      const grade = await StudyForge.ai.gradeShortAnswer({
        apiKey: store.getApiKey(),
        question: item.question,
        answer: item.answer,
        response: answer.text,
      });
      result = { ...grade, expected: item.answer, given: answer.text };
    }

    // The user may have left the quiz while the AI was marking.
    if (quizState.kitId !== kit.id || quizState.status !== "running") return;
    // At least a second: instant answers are still a data point for pace.
    result.seconds = Math.max(
      1,
      Math.min(3600, Math.round((Date.now() - (quizState.questionStartedAt || Date.now())) / 1000)),
    );
    quizState.results[index] = result;
    quizState.phase = "marked";
    saveQuizDraft();
    render();
  }

  function finishQuiz() {
    const kit = store.getKit(quizState.kitId);
    if (!kit || !kit.quiz) return;
    const items = activeQuizItems(kit);
    quizState.attemptItems = items;
    const answers = items.map((item, index) => {
      const result = quizState.results[index] || {};
      const given = quizState.answers[index] || {};
      return {
        type: item.type,
        question: item.question,
        given:
          item.type === "mcq"
            ? given.choice !== undefined && item.options[given.choice] !== undefined
              ? item.options[given.choice]
              : ""
            : given.text || "",
        expected: result.expected || item.answer || item.options[item.answerIndex] || "",
        correct: result.correct === true,
        score: Number.isFinite(result.score) ? result.score : 0,
        feedback: result.feedback || "",
        markedBy: result.markedBy || "auto",
        seconds: Number.isFinite(result.seconds) ? result.seconds : 0,
      };
    });
    const correct = answers.filter((entry) => entry.correct).length;
    const attempt = {
      id: `att_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      takenAt: new Date().toISOString(),
      correct,
      total: items.length,
      secondsUsed: Math.max(0, Math.round((Date.now() - quizState.startedAt) / 1000)),
      answers,
    };

    store.addKitQuizAttempt(kit.id, attempt);
    clearQuizDraft();
    quizState.status = "finished";
    quizState.phase = "marked";
    quizState.attempt = attempt;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast(
      `Quiz submitted — ${correct}/${items.length} correct.`,
      correct / Math.max(1, items.length) >= 0.5 ? "success" : "info",
    );
  }

  /* ------------------------------------------------------------------ *
   * Timed exam
   * ------------------------------------------------------------------ */

  function startExam(kit) {
    if (!kit.exam || !kit.exam.items.length) {
      toast("Build an exam first.", "error");
      return;
    }
    examState = {
      kitId: kit.id,
      status: "running",
      answers: {},
      startedAt: Date.now(),
      endsAt: Date.now() + kit.exam.durationMinutes * 60 * 1000,
      secondsUsed: 0,
      result: null,
    };
    saveExamDraft();
    render();
    toast(`Exam started — ${kit.exam.durationMinutes} minutes on the clock.`);
  }

  function submitExam(reason = "manual") {
    if (examState.status !== "running") return;
    clearExamDraft();
    const kit = store.getKit(examState.kitId);
    if (!kit || !kit.exam) {
      resetExam(examState.kitId);
      render();
      return;
    }

    const items = kit.exam.items;
    let correct = 0;
    items.forEach((item, index) => {
      if (examState.answers[index] === item.answerIndex) correct += 1;
    });

    const limit = kit.exam.durationMinutes * 60;
    const secondsUsed = Math.min(limit, Math.max(0, Math.round((Date.now() - examState.startedAt) / 1000)));

    examState.status = "finished";
    examState.secondsUsed = secondsUsed;
    examState.result = { correct, total: items.length, secondsUsed, timedOut: reason === "timeout" };

    store.setKitExamAttempt(kit.id, {
      correct,
      total: items.length,
      takenAt: new Date().toISOString(),
      secondsUsed,
      answers: items.map((item, index) => ({
        question: item.question,
        given: item.options[examState.answers[index]] || "",
        expected: item.options[item.answerIndex] || item.answer,
        correct: examState.answers[index] === item.answerIndex,
      })),
    });

    render();
    toast(
      reason === "timeout"
        ? `Time is up — scored ${correct}/${items.length}.`
        : `Exam submitted — ${correct}/${items.length}.`,
      correct / Math.max(1, items.length) >= 0.5 ? "success" : "info",
    );
  }

  /** One ticker for the whole page: updates the clock and enforces the limit. */
  function startExamTicker() {
    setInterval(() => {
      if (examState.status !== "running") return;
      const left = examSecondsLeft();
      const clock = document.getElementById("exam-clock");
      if (clock) {
        clock.textContent = formatClock(left);
        clock.classList.toggle("warn", left <= 60);
      }
      if (left <= 0) submitExam("timeout");
    }, 1000);
  }

  function openFlashcardOptions(kitId) {
    const kit = store.getKit(kitId);
    if (!kit) return;
    const withDocs = store.resourcesInKit(kit.id).filter((resource) => resource.document);
    // The saved preference wins; a deck's own style is the fallback.
    const defaultStyle =
      store.getSettings().flashcardStyle || (kit.flashcards && kit.flashcards.style) || "vocab";

    openModal({
      title: "Generate flashcards",
      confirmLabel: "Generate",
      body: `
        <div class="notice subtle">
          Cards are written from <strong>all ${plural(withDocs.length, "study document")}</strong> in
          “${esc(kit.name)}”. Each resource is asked for its own share, so the deck covers the whole kit.
        </div>
        <div class="field-row">
          <div class="field"><label for="cards-count">How many cards</label>
            <select id="cards-count">
              ${[10, 20, 30, 40].map((n) => `<option value="${n}" ${n === 20 ? "selected" : ""}>${n}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label for="cards-style">Card style</label>
            <select id="cards-style">
              <option value="vocab" ${defaultStyle === "vocab" ? "selected" : ""}>Vocabulary &amp; concepts</option>
              <option value="question" ${defaultStyle === "question" ? "selected" : ""}>Exam-style questions</option>
            </select>
          </div>
        </div>
        <div class="notice subtle" id="cards-style-hint"></div>`,
      onMount: (root) => {
        const select = root.querySelector("#cards-style");
        const hint = root.querySelector("#cards-style-hint");
        const render = () => {
          hint.innerHTML =
            select.value === "question"
              ? "<strong>Question cards:</strong> the front is an exam-style question, the back is the model answer."
              : "<strong>Vocabulary cards:</strong> the front is a term or concept, the back is its definition.";
        };
        select.addEventListener("change", render);
        render();
      },
      onConfirm: (root) => {
        if (!withDocs.length) {
          toast("Add a resource with a study document first.", "error");
          return false;
        }
        if (!requireKey()) return false;
        const count = Number(root.querySelector("#cards-count").value);
        const style = root.querySelector("#cards-style").value === "question" ? "question" : "vocab";
        resetDeck(kit.id);
        jobs.makeFlashcards(kit, count, style);
        toast(style === "question" ? "Generating question cards…" : "Generating vocabulary cards…");
      },
    });
  }

  function openExamOptions(kitId) {
    const kit = store.getKit(kitId);
    if (!kit) return;
    const withDocs = store.resourcesInKit(kit.id).filter((resource) => resource.document);

    openModal({
      title: "Build a practice test",
      confirmLabel: "Build exam",
      body: `
        <div class="notice subtle">
          A timed, multiple-choice paper from <strong>all ${plural(withDocs.length, "study document")}</strong> in
          “${esc(kit.name)}”. Questions are marked automatically, so short answers are not used.
        </div>
        <div class="field-row">
          <div class="field"><label for="exam-count">Questions</label>
            <select id="exam-count">
              ${[10, 15, 20, 25, 30]
                .map((n) => `<option value="${n}" ${n === 20 ? "selected" : ""}>${n}</option>`)
                .join("")}
            </select>
          </div>
          <div class="field"><label for="exam-time">Time limit</label>
            <select id="exam-time">
              <option value="">Auto (about 1¼ min per question)</option>
              ${[10, 15, 20, 30, 45, 60, 90]
                .map((n) => `<option value="${n}">${n} minutes</option>`)
                .join("")}
            </select>
          </div>
        </div>`,
      onConfirm: (root) => {
        if (!withDocs.length) {
          toast("Add a resource with a study document first.", "error");
          return false;
        }
        if (!requireKey()) return false;
        const count = Number(root.querySelector("#exam-count").value);
        const minutes = Number(root.querySelector("#exam-time").value) || null;
        resetExam(kit.id);
        jobs.makeExam(kit, count, minutes);
        toast("Building the exam…");
      },
    });
  }

  function openQuizOptions(kitId) {
    const kit = store.getKit(kitId);
    if (!kit) return;
    const withDocs = store.resourcesInKit(kit.id).filter((resource) => resource.document);

    openModal({
      title: "Generate quiz questions",
      confirmLabel: "Generate",
      body: `
        <div class="notice subtle">
          Questions are spread across <strong>all ${plural(withDocs.length, "study document")}</strong> in
          “${esc(kit.name)}”. Each resource is asked for its own share, so every one of them is covered
          rather than the model focusing on a single document.
          <br><br>Questions are shown one at a time; short answers are marked by AI as you go.
        </div>
        <div class="field-row">
          <div class="field"><label for="quiz-count">How many questions</label>
            <select id="quiz-count">
              ${[5, 10, 15, 20, 25].map((n) => `<option value="${n}" ${n === 10 ? "selected" : ""}>${n}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label for="quiz-level">Difficulty</label>
            <select id="quiz-level">
              <option value="">Balanced</option>
              <option value="foundational">Foundational recall</option>
              <option value="exam">Exam-style, applied</option>
            </select>
          </div>
        </div>`,
      onConfirm: (root) => {
        if (!withDocs.length) {
          toast("Add a resource with a study document first.", "error");
          return false;
        }
        if (!requireKey()) return false;
        const count = Number(root.querySelector("#quiz-count").value);
        const difficulty = root.querySelector("#quiz-level").value;
        resetQuiz(kit.id);
        clearQuizDraft();
        jobs.makeQuiz(kit, count, difficulty);
        toast("Generating quiz questions…");
      },
    });
  }

  /* ------------------------------------------------------------------ *
   * Resource actions
   * ------------------------------------------------------------------ */

  function addPdfFiles(files) {
    const kit = store.getKit(route.id);
    if (!kit) return;
    if (!requireKey()) return;
    const pdfs = Array.from(files).filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
    if (!pdfs.length) {
      toast("Those files are not PDFs.", "error");
      return;
    }
    for (const file of pdfs) {
      const resource = store.addResource({ kitId: kit.id, name: fileTitle(file.name), type: "pdf" });
      if (resource) jobs.uploadPdf(resource, file);
    }
    toast(`${pdfs.length} PDF(s) queued for processing.`);
  }

  function addPastedText() {
    const kit = store.getKit(route.id);
    if (!kit) return;
    const textarea = els.view.querySelector('[data-draft="paste-text"]');
    const titleInput = els.view.querySelector('[data-draft="paste-title"]');
    const text = textarea ? textarea.value.trim() : "";
    if (!text) {
      toast("Paste some text first.", "error");
      return;
    }
    if (!requireKey()) return;
    const name = (titleInput && titleInput.value.trim()) || firstLine(text);
    const resource = store.addResource({ kitId: kit.id, name, type: "text" });
    if (!resource) return;
    jobs.uploadText(resource, text);
    if (textarea) textarea.value = "";
    if (titleInput) titleInput.value = "";
    toast("Pasted text queued for processing.");
  }

  /**
   * With the on-device engine, a fresh study document is enough to build the
   * rest of the kit: cards and a quiz appear without another click. Never does
   * this with an AI provider — that would spend someone's quota unasked.
   */
  function autoForgeAfterDocument(current, previous) {
    if (!previous || current === previous) return;
    const finished = jobs.getLast();
    if (!finished || finished.status !== "done" || finished.autoForged) return;
    if (finished.kind !== "text" && finished.kind !== "pdf") return;
    if (StudyForge.ai.providerId() !== "local") return;
    if (!finished.kitId) return;
    const kit = store.getKit(finished.kitId);
    if (!kit) return;
    const documents = store.resourcesInKit(kit.id).filter((resource) => resource.document);
    if (!documents.length) return;
    finished.autoForged = true;
    if (!kit.flashcards) {
      jobs.makeFlashcards(kit, 20, store.getSettings().flashcardStyle || "vocab");
    }
    if (!kit.quiz) {
      jobs.makeQuiz(kit, 10, "");
    }
  }

  function download(filename, content, type = "text/plain;charset=utf-8") {
    const anchor = document.createElement("a");
    anchor.download = filename;
    let url = "";
    try {
      url = URL.createObjectURL(new Blob([content], { type }));
      anchor.href = url;
    } catch (error) {
      // Very old browsers, or a locked-down webview: fall back to a data URL.
      try {
        anchor.href = `data:${type};base64,${btoa(unescape(encodeURIComponent(content)))}`;
      } catch (inner) {
        toast("This browser blocked the download.", "error");
        return false;
      }
    }
    anchor.click();
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  function safeFileName(name, extension) {
    const base = String(name).replace(/[\\/:*?"<>|]+/g, " ").trim() || "studyforge";
    return `${base}.${extension}`;
  }

  async function copyText(text, label = "Copied") {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} to clipboard.`, "success");
    } catch (error) {
      toast("Clipboard was blocked by the browser.", "error");
    }
  }

  /**
   * Print a clean sheet (deck, paper, answer key) instead of whatever is on
   * screen. The sheet lives outside the app shell so print styles can show it
   * alone, and it is removed again afterwards.
   */
  function printSheet(title, html) {
    if (typeof window.print !== "function") {
      toast("This browser cannot print.", "error");
      return;
    }
    const existing = document.getElementById("print-sheet");
    if (existing) existing.remove();
    const sheet = document.createElement("div");
    sheet.id = "print-sheet";
    sheet.innerHTML = `<h1>${esc(title)}</h1>${html}`;
    document.body.appendChild(sheet);
    document.body.classList.add("print-sheet");
    const cleanup = () => {
      const node = document.getElementById("print-sheet");
      if (node) node.remove();
      document.body.classList.remove("print-sheet");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    setTimeout(() => {
      window.print();
      setTimeout(cleanup, 1500);
    }, 40);
  }

  /**
   * Turn pasted text into cards. One card per line, prompt and answer split on
   * the first `|`, tab, `=` or padded hyphen so common formats just work.
   */
  function parseCardLines(raw) {
    const cards = [];
    String(raw || "")
      .split(/\r?\n/)
      .forEach((line) => {
        const text = line.trim();
        if (!text) return;
        const match = text.match(/^(.*?)\s*(?:\||\t|=|\s-\s|–|—)\s*(.+)$/);
        if (!match) return;
        const front = match[1].trim().replace(/^[-*\d.\s]+/, "").trim();
        const back = match[2].trim();
        if (front && back) cards.push({ front, back });
      });
    return cards;
  }

  function printDeck(kit) {
    const cards = (kit.flashcards && kit.flashcards.items) || [];
    if (!cards.length) return;
    const rows = cards
      .map(
        (card, index) =>
          `<tr><td class="num">${index + 1}</td><td class="front">${esc(card.front)}</td><td class="back">${esc(
            card.back,
          )}</td></tr>`,
      )
      .join("");
    printSheet(
      `${kit.name} — flashcards`,
      `<p class="sheet-note">${cards.length} cards. Fold or cover the right column to test yourself.</p>
       <table class="sheet-table"><thead><tr><th>#</th><th>Prompt</th><th>Answer</th></tr></thead><tbody>${rows}</tbody></table>`,
    );
  }

  function printQuiz(kit) {
    const items = (kit.quiz && kit.quiz.items) || [];
    if (!items.length) return;
    const questions = items
      .map(
        (item, index) => `
          <div class="sheet-q">
            <p><strong>${index + 1}.</strong> ${esc(item.question)}</p>
            ${
              item.type === "mcq"
                ? `<ol class="sheet-options" type="A">${item.options.map((option) => `<li>${esc(option)}</li>`).join("")}</ol>`
                : `<div class="sheet-lines"></div>`
            }
          </div>`,
      )
      .join("");
    const key = items
      .map(
        (item, index) =>
          `<li><strong>${index + 1}.</strong> ${
            item.type === "mcq"
              ? `${String.fromCharCode(65 + item.answerIndex)} — ${esc(item.options[item.answerIndex])}`
              : esc(item.answer)
          }</li>`,
      )
      .join("");
    printSheet(
      `${kit.name} — quiz`,
      `${questions}<h2 class="sheet-page-break">Answer key</h2><ol class="sheet-key">${key}</ol>`,
    );
  }

  /** A plain report of every attempt, for keeping notes outside the app. */
  function resultsToMarkdown(kit) {
    const attempts = (kit.quiz && kit.quiz.attempts) || [];
    const stats = quizAnalytics(kit);
    const lines = [`# ${kit.name} — quiz results`, ""];
    if (stats) {
      lines.push(
        `- Attempts: ${stats.count}`,
        `- Best: ${stats.best}%`,
        `- Average: ${stats.average}%`,
        `- Multiple choice: ${stats.byType.mcq.correct}/${stats.byType.mcq.total}`,
        `- Short answer: ${stats.byType.short.correct}/${stats.byType.short.total}`,
        "",
      );
    }
    attempts.forEach((attempt, index) => {
      lines.push(
        `## Attempt ${attempts.length - index} — ${attempt.percent}%`,
        `${attempt.correct}/${attempt.total} correct · ${new Date(attempt.takenAt).toLocaleString()}${
          attempt.secondsUsed ? ` · ${formatClock(attempt.secondsUsed)}` : ""
        }`,
        "",
      );
      for (const answer of attempt.answers) {
        lines.push(
          `- ${answer.correct ? "✓" : "✗"} ${answer.question}${answer.seconds ? ` (${answer.seconds}s)` : ""}`,
          `  - Your answer: ${answer.given || "—"}`,
        );
        if (!answer.correct) lines.push(`  - Model answer: ${answer.expected}`);
      }
      lines.push("");
    });
    lines.push("Generated by StudyForge.");
    return lines.join("\n");
  }

  /** The paper with a separate answer key, so it can be printed and sat on paper. */
  function examToMarkdown(kit) {
    const exam = kit.exam;
    const lines = [`# ${kit.name} — practice test`, "", `${exam.items.length} questions · ${exam.durationMinutes} minutes`, ""];
    exam.items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.question}`);
      item.options.forEach((option, optionIndex) => {
        lines.push(`   ${String.fromCharCode(65 + optionIndex)}. ${option}`);
      });
      lines.push("");
    });
    lines.push("---", "", "## Answer key", "");
    exam.items.forEach((item, index) => {
      lines.push(`${index + 1}. ${String.fromCharCode(65 + item.answerIndex)} — ${item.options[item.answerIndex]}`);
    });
    lines.push("", "Generated by StudyForge.");
    return lines.join("\n");
  }

  function quizToMarkdown(kit) {
    const quiz = kit.quiz;
    const lines = [`# ${kit.name} — practice questions`, ""];
    if (quiz.sourceNames && quiz.sourceNames.length) {
      lines.push(`Sources: ${quiz.sourceNames.join(", ")}`, "");
    }
    quiz.items.forEach((item, index) => {
      lines.push(`**${index + 1}. ${item.question}**`);
      if (item.type === "mcq") {
        item.options.forEach((option, optionIndex) => {
          const marker = optionIndex === item.answerIndex ? "**" : "";
          lines.push(`- ${String.fromCharCode(65 + optionIndex)}. ${marker}${option}${marker}`);
        });
      } else {
        lines.push(`- Answer: ${item.answer}`);
      }
      if (item.explanation) lines.push(`- Why: ${item.explanation}`);
      lines.push("");
    });
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ *
   * Delegated events
   * ------------------------------------------------------------------ */

  function onClick(event) {
    const actionEl = event.target.closest("[data-action], [data-job-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const id = actionEl.dataset.id;
    if (!action) return;
    event.preventDefault();

    switch (action) {
      case "filter-class":
        document.body.classList.remove("nav-open");
        filterClassId = id || null;
        if (route.name !== "dashboard") navigate("#/");
        else render();
        break;
      case "toggle-class":
        if (sidebarOpen.classes.has(id)) sidebarOpen.classes.delete(id);
        else sidebarOpen.classes.add(id);
        renderSidebar();
        break;
      case "toggle-kit":
        if (sidebarOpen.kits.has(id)) sidebarOpen.kits.delete(id);
        else sidebarOpen.kits.add(id);
        renderSidebar();
        break;
      case "new-kit-in-class":
        sidebarOpen.classes.add(id);
        openNewKit(id);
        break;
      case "new-kit":
        openNewKit();
        break;
      case "open-settings":
        openSettings();
        break;
      case "load-demo": {
        const demo = createDemoKit();
        if (demo) {
          toast("Sample kit ready — open the Quiz or Flashcards tab.", "success");
          navigate(`#/kit/${demo.kit.id}`);
        }
        break;
      }
      case "open-kit":
        navigate(`#/kit/${id}`);
        break;
      case "export-backup":
        store.setSettings({ lastBackupAt: new Date().toISOString() });
        download(
          `studyforge-backup-${new Date().toISOString().slice(0, 10)}.json`,
          store.exportData(),
          "application/json",
        );
        toast("Backup exported.", "success");
        render();
        break;
      case "import-backup":
        $("import-file").click();
        break;
      case "new-class":
        openNewClass();
        break;
      case "rename-kit":
        openRenameKit(id);
        break;
      case "move-kit":
        openMoveKit(id);
        break;
      case "set-exam-date": {
        const kit = store.getKit(id);
        if (!kit) break;
        const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        openModal({
          title: "Exam date",
          confirmLabel: "Save date",
          body: `
            <div class="field">
              <label for="exam-date">When is the exam?</label>
              <input id="exam-date" type="date" value="${esc(kit.examDate || tomorrow)}">
              <span class="hint">Optional. StudyForge counts down and works out how many cards a day
                gets you through the deck twice before then.</span>
            </div>
            ${kit.examDate ? `<p class="muted tiny">Clear the field to remove the date.</p>` : ""}`,
          onConfirm: (root) => {
            const value = root.querySelector("#exam-date").value;
            store.updateKit(kit.id, { examDate: value || "" });
            render();
            toast(value ? "Exam date saved." : "Exam date removed.");
          },
        });
        break;
      }
      case "edit-kit":
        openEditKit(id);
        break;
      case "rename-class":
        openRenameClass(id);
        break;
      case "delete-kit": {
        const kit = store.getKit(id);
        if (!kit) break;
        openModal({
          title: "Delete study kit",
          body: `<p>Delete <strong>${esc(kit.name)}</strong> and its ${plural(store.resourcesInKit(id).length, "resource")}? This cannot be undone.</p>`,
          confirmLabel: "Delete kit",
          danger: true,
          onConfirm: () => {
            undoableDelete(() => store.deleteKit(id), "Study kit deleted.");
            if (route.name === "kit" && route.id === id) navigate("#/");
          },
        });
        break;
      }
      case "delete-class": {
        const cls = store.getClass(id);
        if (!cls) break;
        openModal({
          title: "Delete class",
          body: `<p>Delete the class <strong>${esc(cls.name)}</strong>? Its study kits are kept and become uncategorised.</p>`,
          confirmLabel: "Delete class",
          danger: true,
          onConfirm: () => {
            undoableDelete(() => store.deleteClass(id), "Class deleted.");
            if (filterClassId === id) filterClassId = null;
          },
        });
        break;
      }
      case "pick-pdf":
        pendingReprocessId = null;
        els.fileInput.multiple = true;
        els.fileInput.click();
        break;
      case "add-text":
        addPastedText();
        break;
      case "delete-resource": {
        const resource = store.getResource(id);
        if (!resource) break;
        openModal({
          title: "Delete resource",
          body: `<p>Delete <strong>${esc(resource.name)}</strong>, its study document and its questions?</p>`,
          confirmLabel: "Delete resource",
          danger: true,
          onConfirm: () => {
            store.deleteResource(id);
            if (route.name === "resource" && route.id === id) navigate(`#/kit/${resource.kitId}`);
            toast("Resource deleted.", "success");
          },
        });
        break;
      }
      case "rerun-resource": {
        const resource = store.getResource(id);
        if (!resource) break;
        const file = jobs.getSessionFile(id);
        if (file) {
          jobs.uploadPdf(resource, file);
          toast("Re-running extraction…");
        } else {
          pendingReprocessId = id;
          els.fileInput.multiple = false;
          toast("Select the same PDF again to re-run extraction.");
          els.fileInput.click();
        }
        break;
      }
      case "edit-doc":
        editingDocId = id;
        render();
        break;
      case "cancel-doc":
        editingDocId = null;
        render();
        break;
      case "save-doc": {
        const textarea = els.view.querySelector(`[data-doc-id="${id}"]`);
        if (!textarea) break;
        store.setResourceDocument(id, textarea.value);
        editingDocId = null;
        toast("Document saved.", "success");
        break;
      }
      case "save-notes": {
        saveKitNotes(id);
        break;
      }
      case "clear-search": {
        query = "";
        if (els.search) els.search.value = "";
        render();
        break;
      }
      case "install-app": {
        if (!installPrompt) {
          toast("Use your browser menu → Install app.", "info");
          break;
        }
        const prompt = installPrompt;
        installPrompt = null;
        prompt.prompt();
        Promise.resolve(prompt.userChoice).then((choice) =>
          toast(
            choice && choice.outcome === "accepted" ? "StudyForge installed." : "Install dismissed.",
            "info",
          ),
        );
        break;
      }
      case "listen-doc": {
        const resource = store.getResource(id);
        if (!resource || !resource.document) break;
        if (speechState.speaking) {
          stopSpeech();
          break;
        }
        startSpeech(resource);
        break;
      }
      case "doc-bigger":
        setDocSize(readDocSize() + 0.1);
        break;
      case "doc-smaller":
        setDocSize(readDocSize() - 0.1);
        break;
      case "doc-focus": {
        document.body.classList.toggle("doc-focus");
        if (document.body.classList.contains("doc-focus")) {
          toast("Focus mode — press Esc to bring the app back.", "info");
        }
        break;
      }
      case "print-doc": {
        els.view.classList.add("printing");
        setTimeout(() => {
          window.print();
          els.view.classList.remove("printing");
        }, 60);
        break;
      }
      case "show-shortcuts":
        openShortcuts();
        break;
      case "copy-doc": {
        const resource = store.getResource(id);
        if (resource) copyText(resource.document, "Document copied");
        break;
      }
      case "download-doc": {
        const resource = store.getResource(id);
        if (resource) download(safeFileName(resource.name, "md"), resource.document, "text/markdown;charset=utf-8");
        break;
      }
      case "make-quiz": {
        const kit = store.getKit(id);
        if (kit) openQuizOptions(kit.id);
        break;
      }
      case "make-flashcards": {
        const kit = store.getKit(id);
        if (kit) openFlashcardOptions(kit.id);
        break;
      }
      case "download-flashcards": {
        const kit = store.getKit(id);
        if (kit && kit.flashcards) {
          download(
            safeFileName(kit.name + " flashcards", "md"),
            flashcardsToMarkdown(kit),
            "text/markdown;charset=utf-8",
          );
        }
        break;
      }
      case "flip-card":
        flipCard();
        break;
      case "next-card":
        moveCard(1);
        break;
      case "prev-card":
        moveCard(-1);
        break;
      case "card-known":
        markCard("known");
        break;
      case "card-again":
        markCard("again");
        break;
      case "add-card": {
        const kit = store.getKit(route.id);
        if (!kit) break;
        openModal({
          title: "Add a card",
          confirmLabel: "Add card",
          body: `
            <div class="field"><label for="new-front">Prompt</label>
              <input id="new-front" type="text" placeholder="What should you be asked?"></div>
            <div class="field"><label for="new-back">Answer</label>
              <textarea id="new-back" rows="4" placeholder="What should you remember?"></textarea></div>
            <p class="hint">Handy for the one fact your teacher keeps repeating.</p>`,
          onConfirm: (root) => {
            const front = root.querySelector("#new-front").value.trim();
            const back = root.querySelector("#new-back").value.trim();
            if (!front || !back) {
              toast("A card needs both a prompt and an answer.", "error");
              return false;
            }
            const current = kit.flashcards || { items: [] };
            store.setKitFlashcards(kit.id, { ...current, items: [...(current.items || []), { front, back }] });
            toast("Card added.", "success");
          },
        });
        break;
      }
      case "import-cards": {
        const kit = store.getKit(route.id);
        if (!kit) break;
        openModal({
          title: "Paste cards",
          confirmLabel: "Add cards",
          body: `
            <div class="field">
              <label for="paste-cards">One card per line</label>
              <textarea id="paste-cards" rows="8"
                placeholder="Osmosis | Water moving across a membrane\nMitochondria - Where respiration happens"></textarea>
              <span class="hint">Separate the prompt from the answer with <code>|</code>, a tab, <code>=</code> or <code> - </code>.
                Everything after that becomes the answer.</span>
            </div>
            <div class="field">
              <label class="check"><input type="checkbox" id="paste-replace"> Replace the cards already in this deck</label>
            </div>`,
          onConfirm: (root) => {
            const raw = root.querySelector("#paste-cards").value;
            const replace = root.querySelector("#paste-replace").checked;
            const parsed = parseCardLines(raw);
            if (!parsed.length) {
              toast("No cards found — put one prompt and answer on each line.", "error");
              return false;
            }
            const current = kit.flashcards || { items: [] };
            const items = replace ? parsed : [...(current.items || []), ...parsed];
            store.setKitFlashcards(kit.id, { ...current, items });
            toast(`${parsed.length} card${parsed.length === 1 ? "" : "s"} added.`, "success");
          },
        });
        break;
      }
      case "edit-card": {
        const kit = store.getKit(route.id);
        if (!kit || !kit.flashcards) break;
        const order = deckOrder(kit);
        const index = order[Math.min(flashState.index, order.length - 1)];
        const card = kit.flashcards.items[index];
        if (!card) break;
        openModal({
          title: "Edit this card",
          confirmLabel: "Save card",
          body: `
            <div class="field"><label for="edit-front">Prompt</label>
              <input id="edit-front" type="text" value="${esc(card.front)}"></div>
            <div class="field"><label for="edit-back">Answer</label>
              <textarea id="edit-back" rows="4">${esc(card.back)}</textarea></div>
            <p class="hint">Fixing a card keeps your review progress for it.</p>`,
          onConfirm: (root) => {
            const front = root.querySelector("#edit-front").value.trim();
            const back = root.querySelector("#edit-back").value.trim();
            if (!front || !back) {
              toast("A card needs both a prompt and an answer.", "error");
              return false;
            }
            const items = kit.flashcards.items.map((item, itemIndex) =>
              itemIndex === index ? { ...item, front, back } : item,
            );
            // Ratings are keyed by the prompt, so carry the schedule across when
            // the prompt itself is corrected.
            const ratings = { ...(kit.flashcards.ratings || {}) };
            const oldKey = cardKey(card);
            const newKey = cardKey({ front });
            if (oldKey !== newKey && ratings[oldKey]) {
              ratings[newKey] = ratings[oldKey];
              delete ratings[oldKey];
            }
            store.setKitFlashcards(kit.id, { ...kit.flashcards, items, ratings });
            toast("Card updated.", "success");
          },
        });
        break;
      }
      case "reset-progress": {
        const kit = store.getKit(route.id);
        if (!kit) break;
        openModal({
          title: "Reset card progress?",
          body: `<p>This clears which cards you marked “Got it” or “Still learning”. The deck itself stays.</p>`,
          confirmLabel: "Reset progress",
          danger: true,
          onConfirm: () => {
            store.resetCardRatings(kit.id);
            resetDeck(kit.id);
            render();
            toast("Card progress reset.", "success");
          },
        });
        break;
      }
      case "study-now": {
        const kit = id ? store.getKit(id) : null;
        if (!kit) break;
        const due = kit.flashcards ? dueAcrossKits({ kits: [kit] }) : { total: 0 };
        if (due.total) {
          pendingDueReview = kit.id;
          window.location.hash = `#/kit/${kit.id}/flashcards`;
          break;
        }
        if (kit.quiz) {
          window.location.hash = `#/kit/${kit.id}/questions`;
          break;
        }
        window.location.hash = `#/kit/${kit.id}`;
        toast("Add a resource first — then everything else follows.", "info");
        break;
      }
      case "review-all-due": {
        const kitId = id;
        if (!kitId) break;
        pendingDueReview = kitId;
        window.location.hash = `#/kit/${kitId}/flashcards`;
        if (route.name === "kit" && route.id === kitId && route.tab === "flashcards") {
          // Same hash: the listener will not fire, so render directly.
          pendingDueReview = null;
          flashState.reviewMode = true;
          flashState.dueOnly = true;
          flashState.index = 0;
          flashState.flipped = false;
          render();
        }
        break;
      }
      case "review-hardest": {
        const kit = store.getKit(route.id);
        const hardest = kit ? hardestCards(kit) : [];
        if (!hardest.length) {
          toast("No tricky cards yet — rate a few first.", "info");
          break;
        }
        flashState.reviewMode = false;
        flashState.dueOnly = false;
        flashState.hardMode = true;
        flashState.hardList = hardest;
        flashState.index = 0;
        flashState.flipped = false;
        flashState.showList = false;
        render();
        toast(`Practising your ${plural(hardest.length, "trickiest card")}.`, "info");
        break;
      }
      case "review-due": {
        flashState.reviewMode = true;
        flashState.index = 0;
        flashState.flipped = false;
        flashState.showList = false;
        flashState.dueOnly = true;
        render();
        toast("Reviewing the cards that are due.");
        break;
      }
      case "review-again": {
        flashState.reviewMode = true;
        flashState.index = 0;
        flashState.flipped = false;
        flashState.finished = false;
        flashState.typed = "";
        flashState.typedVerdict = null;
        flashState.showList = false;
        render();
        toast("Reviewing the cards you are still learning.");
        break;
      }
      case "toggle-typing": {
        flashState.typing = !flashState.typing;
        flashState.finished = false;
        flashState.typed = "";
        flashState.typedVerdict = null;
        flashState.flipped = false;
        render();
        toast(flashState.typing ? "Type the answer, then check it." : "Back to flipping cards.");
        break;
      }
      case "card-check-typed": {
        const kit = store.getKit(route.id);
        const field = els.view.querySelector("[data-card-typed]");
        if (!kit || !field) break;
        const order = deckOrder(kit);
        const card = kit.flashcards.items[order[flashState.index]];
        if (!card) break;
        flashState.typed = field.value;
        flashState.typedVerdict = compareTyped(card.back, field.value);
        render();
        const next = els.view.querySelector("[data-card-typed]");
        if (next) next.focus();
        break;
      }
      case "shuffle-cards":
        shuffleDeck();
        break;
      case "restart-cards": {
        const kit = store.getKit(route.id);
        if (kit) {
          resetDeck(kit.id);
          render();
        }
        break;
      }
      case "deck-list":
        flashState.showList = !flashState.showList;
        render();
        break;
      case "make-exam": {
        const kit = store.getKit(id);
        if (kit) openExamOptions(kit.id);
        break;
      }
      case "start-exam": {
        const kit = store.getKit(route.id);
        if (kit) startExam(kit);
        break;
      }
      case "exam-overview": {
        examState.status = "idle";
        examState.result = null;
        render();
        break;
      }
      case "retake-exam": {
        const kit = store.getKit(route.id);
        if (!kit || !kit.exam) break;
        openModal({
          title: "Retake this exam?",
          body: `<p>The same ${plural(kit.exam.items.length, "question")} with a fresh ${kit.exam.durationMinutes}-minute clock. Your previous score is replaced.</p>`,
          confirmLabel: "Start again",
          onConfirm: () => {
            resetExam(kit.id);
            startExam(kit);
          },
        });
        break;
      }
      case "exam-jump": {
        const index = Number(actionEl.dataset.q);
        const items = els.view.querySelectorAll(".exam-questions .q");
        const target = items[index];
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      }
      case "exam-answer": {
        if (examState.status !== "running") break;
        examState.answers[Number(actionEl.dataset.q)] = Number(actionEl.dataset.opt);
        saveExamDraft();
        render();
        break;
      }
      case "resume-exam": {
        const kit = store.getKit(route.id) || store.getKit(examState.kitId);
        const draft = kit && readExamDraft(kit.id);
        if (!kit || !draft) {
          toast("That exam could not be restored.", "error");
          break;
        }
        examState = {
          kitId: kit.id,
          status: "running",
          answers: draft.answers || {},
          startedAt: draft.startedAt || Date.now(),
          endsAt: draft.endsAt || Date.now(),
          secondsUsed: 0,
          result: null,
        };
        render();
        if (Date.now() >= examState.endsAt) submitExam("timeout");
        break;
      }
      case "discard-exam": {
        clearExamDraft();
        render();
        toast("Unfinished exam discarded.");
        break;
      }
      case "submit-exam": {
        if (examState.status !== "running") break;
        const kit = store.getKit(examState.kitId);
        const unanswered = kit ? kit.exam.items.length - Object.keys(examState.answers).length : 0;
        if (unanswered > 0) {
          openModal({
            title: "Submit the exam?",
            body: `<p>${plural(unanswered, "question")} still unanswered. Unanswered questions are marked incorrect.</p>`,
            confirmLabel: "Submit",
            onConfirm: () => submitExam("manual"),
          });
        } else {
          submitExam("manual");
        }
        break;
      }
      case "print-quiz": {
        const kit = store.getKit(id);
        if (kit) printQuiz(kit);
        break;
      }
      case "print-deck": {
        const kit = store.getKit(id);
        if (kit) printDeck(kit);
        break;
      }
      case "download-results": {
        const kit = store.getKit(route.id);
        if (kit) {
          download(safeFileName(kit.name + " results", "md"), resultsToMarkdown(kit), "text/markdown;charset=utf-8");
        }
        break;
      }
      case "download-exam": {
        const kit = store.getKit(id);
        if (kit && kit.exam) {
          download(safeFileName(kit.name + " practice test", "md"), examToMarkdown(kit), "text/markdown;charset=utf-8");
        }
        break;
      }
      case "download-quiz": {
        const kit = store.getKit(id);
        if (kit && kit.quiz) {
          download(safeFileName(kit.name + " questions", "md"), quizToMarkdown(kit), "text/markdown;charset=utf-8");
        }
        break;
      }
      case "select-doc":
        docViewId = id;
        // A different document starts at the top, not where the last one ended.
        delete docScroll[`${route.id}:${id}`];
        render();
        try {
          window.scrollTo(0, 0);
        } catch (error) {
          /* fine */
        }
        break;
      case "toc-jump": {
        const body = els.view.querySelector("[data-doc-body]");
        const index = Number(actionEl.dataset.index);
        const target = body ? body.querySelectorAll("h1, h2, h3")[index] : null;
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      }
      case "practise-weak": {
        const kit = store.getKit(route.id);
        if (!kit || !kit.quiz) break;
        const stats = quizAnalytics(kit);
        const wording = new Set((stats ? stats.trouble : []).map((entry) => String(entry.question).toLowerCase().trim()));
        const items = kit.quiz.items.filter((item) => wording.has(String(item.question).toLowerCase().trim()));
        if (!items.length) {
          toast("No trouble spots to practise yet.", "info");
          break;
        }
        quizState = {
          kitId: kit.id,
          status: "running",
          index: 0,
          phase: "answering",
          answers: {},
          results: {},
          startedAt: Date.now(),
          questionStartedAt: Date.now(),
          attempt: null,
          items,
          retry: true,
        };
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
        toast(`Practising ${plural(items.length, "trouble spot")}.`, "info");
        break;
      }
      case "practise-missed": {
        const kit = store.getKit(quizState.kitId || route.id);
        const attempt = quizState.attempt;
        if (!kit || !attempt) break;
        const missed = attempt.answers
          .map((answer, index) => ({ answer, item: kit.quiz.items[index] }))
          .filter((entry) => !entry.answer.correct && entry.item);
        if (!missed.length) {
          toast("Nothing to redo — every question was correct.", "success");
          break;
        }
        quizState = {
          kitId: kit.id,
          status: "running",
          index: 0,
          phase: "answering",
          answers: {},
          results: {},
          startedAt: Date.now(),
          questionStartedAt: Date.now(),
          attempt: null,
          items: missed.map((entry) => entry.item),
          retry: true,
        };
        render();
        toast(`${plural(missed.length, "question")} to retry.`);
        break;
      }
      case "start-quiz":
      case "retry-quiz": {
        startQuiz(id || quizState.kitId);
        break;
      }
      case "quiz-choose": {
        if (quizState.status !== "running" || quizState.phase !== "answering") break;
        quizState.answers[quizState.index] = { choice: Number(actionEl.dataset.opt) };
        saveQuizDraft();
        render();
        break;
      }
      case "quiz-next":
        quizNext();
        break;
      case "resume-quiz": {
        const draft = readQuizDraft(id || quizState.kitId || route.id);
        if (!draft) {
          toast("That quiz could not be restored.", "error");
          break;
        }
        resumeQuiz(draft);
        break;
      }
      case "discard-draft": {
        clearQuizDraft();
        toast("Unfinished quiz discarded.");
        render();
        break;
      }
      case "quit-quiz": {
        openModal({
          title: "Leave this quiz?",
          body: `<p>Your answers are kept on this device, so you can resume this run later from the quiz page.</p>`,
          confirmLabel: "Leave quiz",
          cancelLabel: "Keep going",
          onConfirm: () => {
            saveQuizDraft();
            resetQuiz(quizState.kitId);
            render();
          },
        });
        break;
      }
      case "quiz-back":
        resetQuiz(quizState.kitId);
        render();
        break;
      case "review-exam-attempt": {
        const kit = route.name === "kit" ? store.getKit(route.id) : null;
        const attempt =
          kit && kit.exam && (kit.exam.attempts || []).find((item) => item.id === id);
        if (!attempt) break;
        openAttemptReview(attempt);
        break;
      }
      case "review-attempt": {
        const kitId = quizState.kitId || (route.name === "kit" ? route.id : null);
        const kit = kitId ? store.getKit(kitId) : null;
        const attempt = kit && kit.quiz && (kit.quiz.attempts || []).find((item) => item.id === id);
        if (!attempt) break;
        openAttemptReview(attempt);
        break;
      }
      case "delete-quiz-attempt": {
        const kitId = quizState.kitId || (route.name === "kit" ? route.id : null);
        if (kitId) {
          undoableDelete(() => store.deleteKitQuizAttempt(kitId, id), "Attempt deleted.");
          render();
        }
        break;
      }
      default:
        break;
    }
  }

  /** Keep short-answer text in state as it is typed, and gate the Next button. */
  /** Persist the kit scratch pad and refresh its word count. */
  // One timer per kit: switching kits mid-edit must not drop the first one's text.
  const notesTimers = new Map();
  function notesAutosave(kitId, value) {
    if (!kitId) return;
    const existing = notesTimers.get(kitId);
    if (existing) clearTimeout(existing);
    notesTimers.set(
      kitId,
      setTimeout(() => {
        notesTimers.delete(kitId);
        store.updateKit(kitId, { notes: value });
        const status = els.view.querySelector("[data-notes-status]");
        if (status) status.textContent = "Saved automatically.";
      }, 900),
    );
  }

  function saveKitNotes(kitId) {
    const box = els.view.querySelector("[data-kit-notes]");
    if (!box || !kitId) return;
    store.updateKit(kitId, { notes: box.value });
    const count = els.view.querySelector("[data-notes-count]");
    const words = box.value.trim() ? box.value.trim().split(/\s+/).length : 0;
    if (count) count.textContent = words ? `${words} word${words === 1 ? "" : "s"}` : "empty";
    const status = els.view.querySelector("[data-notes-status]");
    if (status) status.textContent = "Saved.";
    toast("Notes saved.", "success");
  }

  function onInput(event) {
    const notes = event.target.closest("[data-kit-notes]");
    if (notes) {
      const count = els.view.querySelector("[data-notes-count]");
      const words = notes.value.trim() ? notes.value.trim().split(/\s+/).length : 0;
      if (count) count.textContent = words ? `${words} word${words === 1 ? "" : "s"}` : "empty";
      const status = els.view.querySelector("[data-notes-status]");
      if (status) status.textContent = "Unsaved…";
      // Autosave: nobody should lose a thought because they forgot a button.
      notesAutosave(notes.dataset.id, notes.value);
      return;
    }
    const find = event.target.closest("[data-doc-find]");
    if (find) {
      scheduleDocFind(find.value);
      return;
    }
    const field = event.target.closest("[data-quiz-input]");
    if (!field || quizState.status !== "running") return;
    quizState.answers[quizState.index] = { text: field.value };
    saveQuizDraft();
    const next = els.view.querySelector('[data-action="quiz-next"]');
    if (next) next.disabled = !field.value.trim();
  }

  function onDrop(event) {
    const zone = event.target.closest("[data-dropzone]");
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove("dragging");
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) addPdfFiles(files);
  }

  function onDragOver(event) {
    const zone = event.target.closest("[data-dropzone]");
    if (!zone) return;
    event.preventDefault();
    zone.classList.add("dragging");
  }

  function onDragLeave(event) {
    const zone = event.target.closest("[data-dropzone]");
    if (zone) zone.classList.remove("dragging");
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  function init() {
    els = {
      view: $("view"),
      nav: $("nav-classes"),
      storage: $("storage-meter"),
      jobBar: $("job-bar"),
      toasts: $("toasts"),
      modalRoot: $("modal-root"),
      search: $("search"),
      fileInput: $("pdf-file-input"),
      sidebar: $("sidebar"),
    };

    els.view.addEventListener("click", onClick);
    els.view.addEventListener("input", onInput);
    els.view.addEventListener("dragover", onDragOver);
    els.view.addEventListener("dragleave", onDragLeave);
    els.view.addEventListener("drop", onDrop);
    els.nav.addEventListener("click", onClick);
    // The engine chip lives in the topbar, outside the view and nav containers.
    const providerSlot = $("provider-slot");
    if (providerSlot) providerSlot.addEventListener("click", onClick);

    els.search.addEventListener("input", () => {
      query = els.search.value.trim();
      scheduleRender();
    });

    els.fileInput.addEventListener("change", () => {
      const files = Array.from(els.fileInput.files || []);
      els.fileInput.value = "";
      if (!files.length) return;
      if (pendingReprocessId) {
        const resource = store.getResource(pendingReprocessId);
        pendingReprocessId = null;
        els.fileInput.multiple = true;
        if (resource && requireKey()) jobs.uploadPdf(resource, files[0]);
        return;
      }
      addPdfFiles(files);
    });

    $("btn-new-kit").addEventListener("click", () => openNewKit());
    $("btn-settings").addEventListener("click", () => openSettings());
    $("btn-export").addEventListener("click", () => {
      store.setSettings({ lastBackupAt: new Date().toISOString() });
      download(`studyforge-backup-${new Date().toISOString().slice(0, 10)}.json`, store.exportData(), "application/json");
      toast("Backup exported.", "success");
      render();
    });
    $("btn-import").addEventListener("click", () => $("import-file").click());
    $("import-file").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        const added = store.importData(text);
        toast(`Imported ${plural(added.kits, "kit")} and ${plural(added.resources, "resource")}.`, "success");
      } catch (error) {
        toast(error.message || "Could not import that file.", "error");
      }
    });

    $("btn-menu").addEventListener("click", () => {
      document.body.classList.toggle("nav-open");
    });

    /* Theme: light by default, dark on demand; remembered per browser. */
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      installPrompt = event;
    });
    window.addEventListener("appinstalled", () => {
      installPrompt = null;
      toast("StudyForge is installed. Find it with your other apps.", "success");
    });
    window.addEventListener("offline", () => toast("You are offline — StudyForge keeps working on device.", "info"));
    window.addEventListener("online", () => toast("Back online.", "success"));

    const themeButton = $("btn-theme");
    const applyTheme = (theme) => {
      document.documentElement.dataset.theme = theme;
      themeButton.innerHTML = theme === "dark" ? icon("sun") : icon("moon");
      themeButton.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", theme === "dark" ? "#0f1011" : "#ffffff");
    };
    applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    themeButton.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        localStorage.setItem("studyforge.theme", next);
      } catch (error) {
        /* private mode */
      }
    });

    /* Sidebar: collapse to an icon rail on wide screens. */
    const collapseButton = $("btn-collapse");
    const syncCollapse = () => {
      const collapsed = document.body.classList.contains("nav-collapsed");
      collapseButton.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
      collapseButton.setAttribute("aria-label", collapseButton.title);
      collapseButton.setAttribute("aria-expanded", String(!collapsed));
    };
    syncCollapse();
    collapseButton.addEventListener("click", () => {
      document.body.classList.toggle("nav-collapsed");
      try {
        localStorage.setItem("studyforge.nav", document.body.classList.contains("nav-collapsed") ? "collapsed" : "open");
      } catch (error) {
        /* private mode */
      }
      syncCollapse();
    });

    window.addEventListener("hashchange", () => {
      document.body.classList.remove("nav-open");
      render();
    });
    let storageWarned = false;
    store.subscribe((state, storageError) => {
      // Running out of localStorage must never fail silently.
      if (storageError && !storageWarned) {
        storageWarned = true;
        toast(
          "This browser's storage is full, so changes may not be saved. Export a backup and delete old kits.",
          "error",
        );
      }
      if (!storageError) storageWarned = false;
      scheduleRender();
    });

    let lastSeenJob = null;
    jobs.subscribe((current) => {
      renderJobBar();
      autoForgeAfterDocument(current, lastSeenJob);
      if (lastSeenJob && current !== lastSeenJob) {
        const finished = jobs.getLast();
        if (finished) {
          if (finished.status === "done") {
            toast(
              finished.kind === "quiz"
                ? "Quiz questions ready."
                : finished.kind === "flashcards"
                  ? "Flashcards ready."
                  : finished.kind === "exam"
                    ? "Practice test ready."
                    : "Study document ready.",
              "success",
            );
          } else if (finished.status === "error") {
            toast(finished.error || "Processing failed.", "error");
          } else if (finished.status === "cancelled") {
            toast("Job cancelled.", "info");
          }
        }
        scheduleRender();
      }
      lastSeenJob = current;
    });

    // Remember how far down a guide the reader is (cheap, throttled by rAF).
    let scrollTick = 0;
    window.addEventListener(
      "scroll",
      () => {
        if (scrollTick) return;
        scrollTick = requestAnimationFrame(() => {
          scrollTick = 0;
          if (route.name !== "kit" || route.tab !== "documents") return;
          docScroll[`${route.id}:${docViewId || "first"}`] = window.scrollY || 0;
        });
      },
      { passive: true },
    );

    document.addEventListener("click", (event) => {
      if (!event.target.closest || !event.target.closest("[data-skip-link]")) return;
      event.preventDefault();
      els.view.focus();
    });

    document.addEventListener("keydown", (event) => {
      // Flashcard deck: Space flips, arrows walk the deck — unless the user is
      // typing somewhere or a dialog is open.
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
      // Typing mode: Enter checks the answer instead of flipping.
      if (
        event.target.matches &&
        event.target.matches("[data-card-typed]") &&
        event.key === "Enter" &&
        !event.shiftKey
      ) {
        event.preventDefault();
        const check = els.view.querySelector('[data-action="card-check-typed"]');
        if (check) check.click();
        return;
      }
      if (
        route.name === "kit" &&
        route.tab === "flashcards" &&
        !typing &&
        !event.metaKey &&
        !event.ctrlKey &&
        els.modalRoot.hidden
      ) {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          flipCard();
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          moveCard(1);
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          moveCard(-1);
          return;
        }
        // Rate straight from the keyboard once the answer is showing.
        if (flashState.flipped && /^(1|k)$/i.test(event.key)) {
          const known = els.view.querySelector('[data-action="card-known"]');
          if (known) {
            event.preventDefault();
            known.click();
          }
          return;
        }
        if (flashState.flipped && /^(2|a)$/i.test(event.key)) {
          const again = els.view.querySelector('[data-action="card-again"]');
          if (again) {
            event.preventDefault();
            again.click();
          }
          return;
        }
      }
      // Quiz: number keys choose an option, Enter marks and advances.
      if (
        route.name === "kit" &&
        route.tab === "questions" &&
        quizState.status === "running" &&
        !typing &&
        els.modalRoot.hidden
      ) {
        if (/^[1-9]$/.test(event.key)) {
          const options = els.view.querySelectorAll('[data-action="quiz-choose"]');
          const index = Number(event.key) - 1;
          if (options[index]) {
            event.preventDefault();
            options[index].click();
          }
          return;
        }
        if (event.key === "Enter") {
          const next = els.view.querySelector('[data-action="quiz-next"]');
          if (next && !next.disabled) {
            event.preventDefault();
            next.click();
          }
          return;
        }
      }
      if (event.target && event.target.matches && event.target.matches("[data-doc-find]")) {
        if (event.key === "Enter") {
          event.preventDefault();
          stepDocFind(event.shiftKey ? -1 : 1);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.target.value = "";
          clearDocFind();
          return;
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        els.search.focus();
        els.search.select();
      }
      if (event.key === "?" && !typing && els.modalRoot.hidden) {
        event.preventDefault();
        openShortcuts();
        return;
      }
      if (event.key === "Escape") {
        document.body.classList.remove("nav-open");
        if (document.body.classList.contains("doc-focus")) document.body.classList.remove("doc-focus");
      }
      if (route.name !== "kit" || route.tab !== "documents") stopSpeech();
    });

    els.modalRoot.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeModal();
      trapModalFocus(event);
      if (event.key === "Enter" && event.target.tagName === "INPUT") {
        const confirm = els.modalRoot.querySelector("[data-confirm]");
        if (confirm) confirm.click();
      }
    });

    startExamTicker();

    store.load();
    render();
    renderJobBar();
  }

  StudyForge.ui = {
    init,
    render,
    toast,
    openSettings,
    navigate,
    isEditingDoc: () => Boolean(editingDocId),
  };
})((window.StudyForge = window.StudyForge || {}));

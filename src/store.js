/**
 * StudyForge — data store
 *
 * Everything the app owns lives in localStorage under one key:
 *   classes  -> groups of study kits
 *   kits     -> study kits inside a class (or uncategorised)
 *   resources-> a PDF or pasted text inside a kit, plus its generated document
 *               and practice questions
 *   settings -> NVIDIA NIM API key
 *
 * Raw uploaded files and their extracted source text are never persisted: only
 * the generated document, questions and metadata are written to storage.
 */
(function (StudyForge) {
  "use strict";

  const STORAGE_KEY = "studyforge.study.v1";
  // The app was previously called Symus Study; keep reading its key so an
  // existing library survives the rebrand.
  const LEGACY_STORAGE_KEY = "symus.study.v1";
  const VERSION = 1;
  // How many finished quiz attempts are kept per study kit.
  const MAX_QUIZ_ATTEMPTS = 50;

  const listeners = new Set();
  let state = null;
  let storageError = null;

  const uid = (prefix) =>
    `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const now = () => new Date().toISOString();

  // How flashcards are written: a vocabulary/concept deck (term -> definition)
  // or an exam-style question deck (question -> answer).
  const FLASHCARD_STYLES = ["vocab", "question"];
  const DEFAULT_FLASHCARD_STYLE = "vocab";

  // Where generation happens. "local" needs no key and no network; the others
  // are optional upgrades. Keep in sync with PROVIDERS in src/ai.js.
  const PROVIDERS = ["local", "gemini", "openrouter", "nvidia", "custom"];
  const DEFAULT_PROVIDER = "local";

  function blankState() {
    return {
      version: VERSION,
      classes: [],
      kits: [],
      resources: [],
      // Daily activity for the streak. { "2026-10-22": { cards: 3, quizzes: 1 } }
      activity: {},
      settings: {
        provider: DEFAULT_PROVIDER,
        // One key per provider, so switching back and forth never loses one.
        providerKeys: { gemini: "", openrouter: "", nvidia: "", custom: "" },
        apiKey: "",
        baseUrl: "",
        model: DEFAULT_MODEL,
        modelByProvider: {},
        ocrLanguage: "eng",
        ocrScale: 2,
        flashcardStyle: DEFAULT_FLASHCARD_STYLE,
        // How many days a week the learner aims to study (used on the dashboard).
        weeklyGoal: 5,
      },
    };
  }

  const OCR_LANGUAGES = ["eng", "jpn", "eng+jpn", "chi_sim", "fra", "deu", "spa"];
  const DEFAULT_MODEL =
    (globalThis.STUDYFORGE_CONFIG && globalThis.STUDYFORGE_CONFIG.model) || "nvidia/nemotron-3.5-lightning-30b-a3b";
  const clampScale = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(3, Math.max(1, number)) : 2;
  };

  const str = (value, fallback = "") => (typeof value === "string" ? value : fallback);
  const arr = (value) => (Array.isArray(value) ? value : []);

  /** Coerce stored JSON into the expected shape; tolerates older or partial data. */
  function normalise(raw) {
    const next = blankState();
    if (!raw || typeof raw !== "object") return next;

    next.classes = arr(raw.classes)
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: str(item.id) || uid("cls"),
        name: str(item.name, "Untitled class"),
        createdAt: str(item.createdAt, now()),
      }));

    // Daily activity, used for the streak and the heat strip.
    if (raw.activity && typeof raw.activity === "object") {
      for (const [key, entry] of Object.entries(raw.activity)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !entry || typeof entry !== "object") continue;
        const clean = {};
        for (const [kind, value] of Object.entries(entry)) {
          if (Number.isFinite(value) && value > 0) clean[kind] = Math.round(value);
        }
        if (Object.keys(clean).length) next.activity[key] = clean;
      }
    }

    const classIds = new Set(next.classes.map((c) => c.id));
    next.kits = arr(raw.kits)
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: str(item.id) || uid("kit"),
        name: str(item.name, "Untitled kit"),
        classId: classIds.has(item.classId) ? item.classId : null,
        subject: str(item.subject),
        // Free-form notes the learner keeps alongside the kit.
        notes: str(item.notes).slice(0, 20000),
        createdAt: str(item.createdAt, now()),
        updatedAt: str(item.updatedAt, now()),
        quiz: normaliseQuiz(item.quiz),
        flashcards: normaliseFlashcards(item.flashcards),
        exam: normaliseExam(item.exam),
      }));

    const kitIds = new Set(next.kits.map((k) => k.id));
    next.resources = arr(raw.resources)
      .filter((item) => item && typeof item === "object" && kitIds.has(item.kitId))
      .map((item) => ({
        id: str(item.id) || uid("res"),
        kitId: item.kitId,
        name: str(item.name, "Untitled resource"),
        type: item.type === "text" ? "text" : "pdf",
        status: ["queued", "processing", "ready", "error"].includes(item.status)
          ? item.status
          : "queued",
        statusMessage: str(item.statusMessage),
        error: str(item.error),
        createdAt: str(item.createdAt, now()),
        updatedAt: str(item.updatedAt, now()),
        pages: normalisePages(item.pages),
        document: str(item.document),
        documentUpdatedAt: str(item.documentUpdatedAt),
      }));

    // Migration: practice questions used to belong to a single resource. Move a
    // surviving set up to its study kit instead of dropping it.
    for (const kit of next.kits) {
      if (kit.quiz) continue;
      const legacy = arr(raw.resources)
        .filter((item) => item && item.kitId === kit.id && item.quiz)
        .sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)))[0];
      if (legacy) kit.quiz = normaliseQuiz(legacy.quiz);
    }

    const settings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
    const rawKeys = settings.providerKeys && typeof settings.providerKeys === "object" ? settings.providerKeys : {};
    const providerKeys = {
      gemini: str(rawKeys.gemini),
      openrouter: str(rawKeys.openrouter),
      nvidia: str(rawKeys.nvidia),
      custom: str(rawKeys.custom),
    };
    // Older saves kept a single key, which was always an NVIDIA key.
    const legacyKey = str(settings.apiKey);
    if (!providerKeys.nvidia && legacyKey) providerKeys.nvidia = legacyKey;

    next.settings = {
      // Existing installs with a key keep using NVIDIA; new installs start local.
      provider: PROVIDERS.includes(settings.provider)
        ? settings.provider
        : legacyKey || providerKeys.nvidia
          ? "nvidia"
          : DEFAULT_PROVIDER,
      providerKeys,
      apiKey: providerKeys.nvidia || legacyKey,
      baseUrl: str(settings.baseUrl),
      modelByProvider:
        settings.modelByProvider && typeof settings.modelByProvider === "object"
          ? { ...settings.modelByProvider }
          : {},
      model: str(settings.model).trim() || DEFAULT_MODEL,
      ocrLanguage: OCR_LANGUAGES.includes(settings.ocrLanguage) ? settings.ocrLanguage : "eng",
      ocrScale: clampScale(settings.ocrScale),
      flashcardStyle: FLASHCARD_STYLES.includes(settings.flashcardStyle)
        ? settings.flashcardStyle
        : DEFAULT_FLASHCARD_STYLE,
      weeklyGoal: (() => {
        const goal = Math.round(Number(settings.weeklyGoal));
        return Number.isFinite(goal) ? Math.min(7, Math.max(1, goal)) : 5;
      })(),
    };
    return next;
  }

  function normalisePages(raw) {
    const pages = raw && typeof raw === "object" ? raw : {};
    return {
      total: Number.isFinite(pages.total) ? pages.total : 0,
      textPages: Number.isFinite(pages.textPages) ? pages.textPages : 0,
      ocrPages: arr(pages.ocrPages).filter(Number.isFinite),
      pendingOcr: arr(pages.pendingOcr).filter(Number.isFinite),
      gapNotes: str(pages.gapNotes),
      analysedAt: str(pages.analysedAt),
    };
  }

  function normaliseCoverage(raw) {
    return arr(raw)
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        id: str(entry.id),
        name: str(entry.name),
        requested: Number.isFinite(entry.requested) ? entry.requested : 0,
        produced: Number.isFinite(entry.produced) ? entry.produced : 0,
      }));
  }

  function normaliseFailures(raw) {
    return arr(raw)
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({ name: str(entry.name), message: str(entry.message) }));
  }

  function normaliseSources(raw) {
    return arr(raw).filter((name) => typeof name === "string");
  }

  /** One question: used by practice questions and by the timed exam. */
  function normaliseQuestion(item) {
    return {
      type: item.type === "mcq" ? "mcq" : "short",
      question: str(item.question),
      options: arr(item.options).map((option) => str(option)),
      answerIndex: Number.isInteger(item.answerIndex) ? item.answerIndex : 0,
      answer: str(item.answer),
      explanation: str(item.explanation),
    };
  }

  /** One card's saved progress: when it is next worth reviewing. */
  function normaliseRating(raw) {
    if (!raw || typeof raw !== "object") return null;
    const state = raw.state === "known" ? "known" : raw.state === "again" ? "again" : "";
    if (!state) return null;
    const interval = Number(raw.interval);
    const ease = Number(raw.ease);
    return {
      state,
      reps: Number.isFinite(raw.reps) ? Math.max(0, raw.reps) : 0,
      // Days until the next review (0 means "come back in minutes").
      interval: Number.isFinite(interval) ? Math.max(0, Math.min(365, interval)) : 0,
      // Per-card difficulty multiplier, like SM-2's ease factor.
      ease: Number.isFinite(ease) ? Math.max(1.3, Math.min(3.2, ease)) : 2.5,
      lapses: Number.isFinite(raw.lapses) ? Math.max(0, raw.lapses) : 0,
      at: str(raw.at, now()),
      dueAt: str(raw.dueAt, now()),
    };
  }

  function normaliseRatings(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [key, value] of Object.entries(raw)) {
      const rating = normaliseRating(value);
      if (rating) out[key] = rating;
    }
    return out;
  }

  function normaliseFlashcards(raw) {
    if (!raw || typeof raw !== "object") return null;
    const items = arr(raw.items)
      .filter((card) => card && typeof card === "object" && str(card.front) && str(card.back))
      .map((card) => ({
        front: str(card.front),
        back: str(card.back),
        // Which resource the card came from, for the deck's source label.
        source: str(card.source),
      }));
    if (!items.length) return null;
    return {
      generatedAt: str(raw.generatedAt),
      items,
      // Which style of deck this is, so the player can label the card face and
      // a regeneration can default to the same style.
      style: FLASHCARD_STYLES.includes(raw.style) ? raw.style : DEFAULT_FLASHCARD_STYLE,
      engine: raw.engine === "local" ? "local" : "ai",
      // Card progress, keyed by the card's prompt so it survives regeneration.
      ratings: normaliseRatings(raw.ratings),
      sourceCount: Number.isFinite(raw.sourceCount) ? raw.sourceCount : 0,
      sourceNames: normaliseSources(raw.sourceNames),
      coverage: normaliseCoverage(raw.coverage),
      failures: normaliseFailures(raw.failures),
    };
  }

  function normaliseExamAttempt(raw) {
    if (!raw || typeof raw !== "object") return null;
    const total = Number.isFinite(raw.total) ? raw.total : 0;
    const correct = Number.isFinite(raw.correct) ? raw.correct : 0;
    return {
      id: str(raw.id) || uid("att"),
      correct,
      total,
      percent: Number.isFinite(raw.percent) ? raw.percent : Math.round((correct / Math.max(1, total)) * 100),
      takenAt: str(raw.takenAt, now()),
      secondsUsed: Number.isFinite(raw.secondsUsed) ? raw.secondsUsed : 0,
      answers: arr(raw.answers)
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          type: "mcq",
          question: str(item.question),
          given: str(item.given),
          expected: str(item.expected),
          correct: item.correct === true,
          score: item.correct === true ? 1 : 0,
          feedback: "",
          markedBy: "auto",
        })),
    };
  }

  function normaliseExam(raw) {
    if (!raw || typeof raw !== "object") return null;
    const items = arr(raw.items)
      .filter((item) => item && typeof item === "object" && str(item.question))
      .map(normaliseQuestion);
    if (!items.length) return null;
    const minutes = Number(raw.durationMinutes);
    // Exams are multiple choice so they can be marked automatically; a paper
    // with no usable choice questions is not an exam.
    const choices = items.filter((item) => item.type === "mcq" && item.options.length >= 2);
    if (!choices.length) return null;
    return {
      generatedAt: str(raw.generatedAt),
      items: choices,
      durationMinutes: Number.isFinite(minutes) ? Math.min(180, Math.max(1, Math.round(minutes))) : 15,
      engine: raw.engine === "local" ? "local" : "ai",
      // Card progress, keyed by the card's prompt so it survives regeneration.
      ratings: normaliseRatings(raw.ratings),
      sourceCount: Number.isFinite(raw.sourceCount) ? raw.sourceCount : 0,
      sourceNames: normaliseSources(raw.sourceNames),
      coverage: normaliseCoverage(raw.coverage),
      failures: normaliseFailures(raw.failures),
      lastAttempt: normaliseExamAttempt(raw.lastAttempt),
      attempts: arr(raw.attempts).map(normaliseExamAttempt).filter(Boolean).slice(0, MAX_QUIZ_ATTEMPTS),
    };
  }

  /** One answered question inside a saved quiz attempt. */
  function normaliseQuizAnswer(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      type: raw.type === "short" ? "short" : "mcq",
      question: str(raw.question),
      given: str(raw.given),
      expected: str(raw.expected),
      correct: raw.correct === true,
      score: Number.isFinite(raw.score) ? Math.max(0, Math.min(1, raw.score)) : 0,
      feedback: str(raw.feedback),
      markedBy: raw.markedBy === "ai" ? "ai" : raw.markedBy === "offline" ? "offline" : "auto",
      // How long this question took, when it was recorded.
      seconds: Number.isFinite(raw.seconds) ? Math.max(0, Math.min(3600, raw.seconds)) : 0,
    };
  }

  /** A finished quiz run, kept so progress can be compared over time. */
  function normaliseQuizAttempt(raw) {
    if (!raw || typeof raw !== "object") return null;
    const answers = arr(raw.answers).map(normaliseQuizAnswer).filter(Boolean);
    const total = Number.isFinite(raw.total) ? raw.total : answers.length;
    if (!total) return null;
    const correct = Number.isFinite(raw.correct)
      ? raw.correct
      : answers.filter((answer) => answer.correct).length;
    return {
      id: str(raw.id) || uid("att"),
      takenAt: str(raw.takenAt, now()),
      correct,
      total,
      percent: Math.round((correct / Math.max(1, total)) * 100),
      secondsUsed: Number.isFinite(raw.secondsUsed) ? raw.secondsUsed : 0,
      answers,
    };
  }

  function normaliseQuiz(raw) {
    if (!raw || typeof raw !== "object") return null;
    const items = arr(raw.items)
      .filter((item) => item && typeof item === "object" && str(item.question))
      .map(normaliseQuestion);
    if (!items.length) return null;
    return {
      generatedAt: str(raw.generatedAt),
      items,
      // Which resources the set was written from, so the UI can warn when a
      // newer document is not covered yet.
      sourceCount: Number.isFinite(raw.sourceCount) ? raw.sourceCount : 0,
      sourceNames: normaliseSources(raw.sourceNames),
      // Per-resource quota and output, so coverage is visible in the UI.
      coverage: normaliseCoverage(raw.coverage),
      failures: normaliseFailures(raw.failures),
      truncated: raw.truncated === true,
      // "local" when the on-device engine wrote the set, "ai" otherwise.
      engine: raw.engine === "local" ? "local" : "ai",
      // Newest first, so the history list needs no extra sorting.
      attempts: arr(raw.attempts)
        .map(normaliseQuizAttempt)
        .filter(Boolean)
        .sort((a, b) => str(b.takenAt).localeCompare(str(a.takenAt)))
        .slice(0, MAX_QUIZ_ATTEMPTS),
    };
  }

  /* ------------------------------------------------------------------ *
   * Persistence
   * ------------------------------------------------------------------ */

  function readStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn("[StudyForge] Could not read saved data; starting fresh.", error);
      return null;
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if (storageError) {
        storageError = null;
        emit();
      }
      return true;
    } catch (error) {
      storageError = error;
      console.warn("[StudyForge] Could not save to localStorage:", error);
      emit();
      return false;
    }
  }

  function emit() {
    for (const listener of listeners) {
      try {
        listener(state, storageError);
      } catch (error) {
        console.error("[StudyForge] Store listener failed:", error);
      }
    }
  }

  function commit() {
    persist();
    emit();
  }

  /* ------------------------------------------------------------------ *
   * Lookups
   * ------------------------------------------------------------------ */

  const get = () => state;
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const getClass = (id) => state.classes.find((item) => item.id === id) || null;
  const getKit = (id) => state.kits.find((item) => item.id === id) || null;
  const getResource = (id) => state.resources.find((item) => item.id === id) || null;
  const kitsInClass = (classId) =>
    state.kits.filter((kit) => (classId ? kit.classId === classId : true));
  const resourcesInKit = (kitId) =>
    state.resources
      .filter((resource) => resource.kitId === kitId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  /* ------------------------------------------------------------------ *
   * Mutations
   * ------------------------------------------------------------------ */

  function addClass(name) {
    const cls = { id: uid("cls"), name: str(name).trim() || "New class", createdAt: now() };
    state.classes.push(cls);
    commit();
    return cls;
  }

  function renameClass(id, name) {
    const cls = getClass(id);
    if (!cls || !str(name).trim()) return false;
    cls.name = name.trim();
    commit();
    return true;
  }

  function deleteClass(id) {
    const index = state.classes.findIndex((item) => item.id === id);
    if (index < 0) return false;
    state.classes.splice(index, 1);
    for (const kit of state.kits) {
      if (kit.classId === id) {
        kit.classId = null;
        kit.updatedAt = now();
      }
    }
    commit();
    return true;
  }

  function addKit({ name, classId = null, subject = "" } = {}) {
    const kit = {
      id: uid("kit"),
      name: str(name).trim() || "New study kit",
      classId: classId && getClass(classId) ? classId : null,
      subject: str(subject).trim(),
      createdAt: now(),
      updatedAt: now(),
      quiz: null,
    };
    state.kits.push(kit);
    commit();
    return kit;
  }

  function updateKit(id, patch = {}) {
    const kit = getKit(id);
    if (!kit) return null;
    if (typeof patch.name === "string" && patch.name.trim()) kit.name = patch.name.trim();
    if ("classId" in patch) kit.classId = patch.classId && getClass(patch.classId) ? patch.classId : null;
    if (typeof patch.subject === "string") kit.subject = patch.subject.trim();
    if (typeof patch.notes === "string") kit.notes = patch.notes.slice(0, 20000);
    kit.updatedAt = now();
    commit();
    return kit;
  }

  function deleteKit(id) {
    const index = state.kits.findIndex((item) => item.id === id);
    if (index < 0) return false;
    state.kits.splice(index, 1);
    state.resources = state.resources.filter((resource) => resource.kitId !== id);
    commit();
    return true;
  }

  function dayKey(date = new Date()) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  /** Count a study action against today, so the streak and heatmap stay real. */
  function recordActivity(kind = "study", amount = 1) {
    if (!state.activity || typeof state.activity !== "object") state.activity = {};
    const key = dayKey();
    const today = state.activity[key] || { cards: 0, quizzes: 0, guides: 0 };
    if (Object.prototype.hasOwnProperty.call(today, kind)) today[kind] += amount;
    else today[kind] = amount;
    state.activity[key] = today;
    // Keep a year of history at most.
    const keys = Object.keys(state.activity).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - 400))) delete state.activity[old];
    return today;
  }

  /**
   * Current streak = consecutive days with any activity, counting back from
   * today (or yesterday, so the streak does not vanish before you study).
   */
  function streakInfo() {
    const activity = state.activity || {};
    const studied = (key) => {
      const entry = activity[key];
      if (!entry) return false;
      return Object.values(entry).some((value) => Number(value) > 0);
    };
    const today = new Date();
    let cursor = new Date(today.getTime());
    if (!studied(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
    let current = 0;
    while (studied(dayKey(cursor))) {
      current += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    const dates = Object.keys(activity).filter(studied).sort();
    let best = 0;
    let run = 0;
    let previous = null;
    for (const date of dates) {
      if (previous) {
        const gap = Math.round((new Date(date) - new Date(previous)) / 86400000);
        run = gap === 1 ? run + 1 : 1;
      } else {
        run = 1;
      }
      best = Math.max(best, run);
      previous = date;
    }
    return { current, best: Math.max(best, current), days: studied(dayKey(today)), dates };
  }

  /** The last `count` days, oldest first, for the activity heat strip. */
  function activityDays(count = 14) {
    const out = [];
    const activity = state.activity || {};
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      const key = dayKey(date);
      const entry = activity[key] || {};
      const total = Object.values(entry).reduce((sum, value) => sum + (Number(value) || 0), 0);
      out.push({ date: key, total, level: total === 0 ? 0 : total < 4 ? 1 : total < 10 ? 2 : 3 });
    }
    return out;
  }

  /**
   * How the deck's reviews are spread out: what is due now, what is coming in
   * the next week, and when the next card lands.
   */
  function deckSchedule(kitId) {
    const kit = getKit(kitId);
    const deck = kit && kit.flashcards;
    if (!deck) return { total: 0, due: 0, later: 0, nextDueAt: null, nextInterval: 0, learning: 0 };
    const nowMs = Date.now();
    const week = nowMs + 7 * 24 * 60 * 60 * 1000;
    let due = 0;
    let later = 0;
    let learning = 0;
    let nextDueAt = null;
    let nextInterval = 0;
    const ratings = deck.ratings || {};
    for (const card of deck.items) {
      const rating = ratings[String(card.front || "").toLowerCase().replace(/\s+/g, " ").trim()];
      if (!rating) {
        due += 1;
        continue;
      }
      const time = new Date(rating.dueAt).getTime();
      if (rating.state === "again" || time <= nowMs) due += 1;
      else if (time <= week) later += 1;
      if (rating.state === "again") learning += 1;
      if (time > nowMs && (!nextDueAt || time < nextDueAt)) {
        nextDueAt = time;
        nextInterval = rating.interval || 0;
      }
    }
    return {
      total: deck.items.length,
      due,
      later,
      learning,
      nextDueAt: nextDueAt ? new Date(nextDueAt).toISOString() : null,
      nextInterval,
    };
  }

  function touchKit(kitId) {
    const kit = getKit(kitId);
    if (kit) kit.updatedAt = now();
  }

  function addResource({ kitId, name, type = "pdf" } = {}) {
    if (!getKit(kitId)) return null;
    const resource = {
      id: uid("res"),
      kitId,
      name: str(name).trim() || "Untitled resource",
      type: type === "text" ? "text" : "pdf",
      status: "queued",
      statusMessage: "",
      error: "",
      createdAt: now(),
      updatedAt: now(),
      pages: normalisePages(null),
      document: "",
      documentUpdatedAt: "",
    };
    state.resources.push(resource);
    touchKit(kitId);
    commit();
    return resource;
  }

  function updateResource(id, patch = {}) {
    const resource = getResource(id);
    if (!resource) return null;
    for (const [key, value] of Object.entries(patch)) {
      if (key === "pages") resource.pages = normalisePages(value);
      else if (key === "id" || key === "kitId" || key === "createdAt") continue;
      else resource[key] = value;
    }
    resource.updatedAt = now();
    touchKit(resource.kitId);
    commit();
    return resource;
  }

  function setResourceDocument(id, markdown) {
    const resource = getResource(id);
    if (!resource) return null;
    resource.document = str(markdown);
    resource.documentUpdatedAt = now();
    resource.updatedAt = now();
    touchKit(resource.kitId);
    if (resource.document) recordActivity("guides");
    commit();
    return resource;
  }

  function setKitQuiz(kitId, quiz) {
    const kit = getKit(kitId);
    if (!kit) return null;
    // Past attempts belong to the kit, not to one question set: keep the
    // history when the questions are regenerated.
    const previousAttempts = kit.quiz ? arr(kit.quiz.attempts) : [];
    kit.quiz = normaliseQuiz(quiz);
    if (kit.quiz && previousAttempts.length) {
      kit.quiz.attempts = arr(kit.quiz.attempts).length
        ? kit.quiz.attempts
        : previousAttempts.slice(0, MAX_QUIZ_ATTEMPTS);
    }
    kit.updatedAt = now();
    commit();
    return kit;
  }

  function setKitFlashcards(kitId, flashcards) {
    const kit = getKit(kitId);
    if (!kit) return null;
    kit.flashcards = normaliseFlashcards(flashcards);
    kit.updatedAt = now();
    touchKit(kitId);
    commit();
    return kit.flashcards;
  }

  /**
   * Append a finished quiz attempt to the kit's history.
   * Runs are kept newest-first and capped, so the history cannot grow forever.
   */
  function addKitQuizAttempt(kitId, attempt) {
    const kit = getKit(kitId);
    const next = normaliseQuizAttempt(attempt);
    if (!kit || !kit.quiz || !next) return null;
    kit.quiz.attempts = [next, ...arr(kit.quiz.attempts)].slice(0, MAX_QUIZ_ATTEMPTS);
    kit.updatedAt = now();
    touchKit(kitId);
    recordActivity("quizzes");
    commit();
    return next;
  }

  function deleteKitQuizAttempt(kitId, attemptId) {
    const kit = getKit(kitId);
    if (!kit || !kit.quiz) return false;
    const before = arr(kit.quiz.attempts).length;
    kit.quiz.attempts = arr(kit.quiz.attempts).filter((attempt) => attempt.id !== attemptId);
    if (kit.quiz.attempts.length === before) return false;
    touchKit(kitId);
    commit();
    return true;
  }

  /**
   * Record how a card went and schedule the next review.
   * "Got it" spaces reviews out (3 days, then further apart, capped at 30);
   * "Still learning" brings it back in ten minutes.
   */
  /**
   * Record how a card went and schedule the next review with a light SM-2:
   * each success multiplies the interval by the card's ease factor, a lapse
   * resets it to ten minutes and makes the card a little harder.
   */
  function rateCard(kitId, cardKey, state) {
    const kit = getKit(kitId);
    if (!kit || !kit.flashcards || !cardKey) return null;
    const key = String(cardKey).toLowerCase().trim();
    const previous = kit.flashcards.ratings[key] || { reps: 0, interval: 0, ease: 2.5, lapses: 0 };
    const previousEase = Number.isFinite(previous.ease) ? previous.ease : 2.5;
    const previousInterval = Number.isFinite(previous.interval) ? previous.interval : 0;
    const learning = state === "known";
    const ease = learning
      ? Math.min(3.2, previousEase + 0.06)
      : Math.max(1.3, previousEase - 0.22);
    const interval = learning
      ? Math.min(60, Math.max(1, Math.round((previousInterval || 1) * ease)))
      : 0;
    const reps = learning ? Math.min(20, (previous.reps || 0) + 1) : 0;
    const lapses = learning ? previous.lapses || 0 : Math.min(20, (previous.lapses || 0) + 1);
    const dueInMs = interval > 0 ? interval * 24 * 60 * 60 * 1000 : 10 * 60 * 1000;
    const rating = {
      state: learning ? "known" : "again",
      reps,
      interval,
      ease,
      lapses,
      at: now(),
      dueAt: new Date(Date.now() + dueInMs).toISOString(),
    };
    kit.flashcards.ratings[key] = rating;
    touchKit(kitId);
    recordActivity("cards");
    commit();
    return rating;
  }

  function resetCardRatings(kitId) {
    const kit = getKit(kitId);
    if (!kit || !kit.flashcards) return false;
    kit.flashcards.ratings = {};
    touchKit(kitId);
    commit();
    return true;
  }

  function setKitExam(kitId, exam) {
    const kit = getKit(kitId);
    if (!kit) return null;
    kit.exam = normaliseExam(exam);
    kit.updatedAt = now();
    touchKit(kitId);
    commit();
    return kit.exam;
  }

  /** Record a finished exam attempt so the tab can show recent performance. */
  function setKitExamAttempt(kitId, attempt) {
    const kit = getKit(kitId);
    const next = normaliseExamAttempt(attempt);
    if (!kit || !kit.exam || !next) return null;
    kit.exam.lastAttempt = next;
    kit.exam.attempts = [next, ...arr(kit.exam.attempts)].slice(0, MAX_QUIZ_ATTEMPTS);
    kit.exam.attempts = kit.exam.attempts.map((attempt) =>
      attempt.id === next.id ? next : attempt,
    );
    kit.updatedAt = now();
    touchKit(kitId);
    recordActivity("exams");
    commit();
    return next;
  }

  function deleteResource(id) {
    const index = state.resources.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [removed] = state.resources.splice(index, 1);
    touchKit(removed.kitId);
    commit();
    return true;
  }

  function setApiKey(key) {
    state.settings.apiKey = str(key).trim();
    commit();
    return state.settings.apiKey;
  }

  function setSettings(patch = {}) {
    if (patch.providerKeys && typeof patch.providerKeys === "object") {
      for (const id of ["gemini", "openrouter", "nvidia", "custom"]) {
        if (id in patch.providerKeys) state.settings.providerKeys[id] = str(patch.providerKeys[id]).trim();
      }
    }
    // Provider first: a patch that sets both should store the key on the new
    // provider, not on the old one.
    if ("provider" in patch) {
      state.settings.provider = PROVIDERS.includes(patch.provider) ? patch.provider : DEFAULT_PROVIDER;
      if (state.settings.provider !== "local") {
        state.settings.apiKey = state.settings.providerKeys[state.settings.provider] || "";
      }
    }
    if ("apiKey" in patch) {
      state.settings.apiKey = str(patch.apiKey).trim();
      const provider = state.settings.provider;
      if (provider && provider !== "local") state.settings.providerKeys[provider] = state.settings.apiKey;
    }
    if ("baseUrl" in patch) state.settings.baseUrl = str(patch.baseUrl).trim();
    if ("modelByProvider" in patch && patch.modelByProvider && typeof patch.modelByProvider === "object") {
      state.settings.modelByProvider = { ...patch.modelByProvider };
    }
    if ("model" in patch) state.settings.model = str(patch.model).trim() || DEFAULT_MODEL;
    if ("ocrLanguage" in patch) {
      state.settings.ocrLanguage = OCR_LANGUAGES.includes(patch.ocrLanguage) ? patch.ocrLanguage : "eng";
    }
    if ("ocrScale" in patch) state.settings.ocrScale = clampScale(patch.ocrScale);
    if ("weeklyGoal" in patch) {
      const goal = Math.round(Number(patch.weeklyGoal));
      state.settings.weeklyGoal = Number.isFinite(goal) ? Math.min(7, Math.max(1, goal)) : 5;
    }
    if ("flashcardStyle" in patch) {
      state.settings.flashcardStyle = FLASHCARD_STYLES.includes(patch.flashcardStyle)
        ? patch.flashcardStyle
        : DEFAULT_FLASHCARD_STYLE;
    }
    commit();
    return state.settings;
  }

  const getSettings = () => ({ ...state.settings });
  const getApiKey = () => state.settings.apiKey || "";
  const getProvider = () => state.settings.provider || DEFAULT_PROVIDER;
  /**
   * The key for a provider — the active one by default, or any by id.
   * Falls back to the legacy single apiKey for older saved data.
   */
  const getProviderKey = (providerId) => {
    const provider = providerId || state.settings.provider || DEFAULT_PROVIDER;
    if (provider === "local") return "";
    return (state.settings.providerKeys && state.settings.providerKeys[provider]) || state.settings.apiKey || "";
  };

  /* ------------------------------------------------------------------ *
   * Backup / restore / storage stats
   * ------------------------------------------------------------------ */

  function exportData() {
    return JSON.stringify({ app: "studyforge", exportedAt: now(), data: state }, null, 2);
  }

  /**
   * Replace everything with a snapshot taken moments earlier. Only used by the
   * undo button on a delete, so it stays deliberately blunt.
   */
  function restore(snapshot) {
    const data = snapshot && snapshot.data ? snapshot.data : snapshot;
    if (!data || typeof data !== "object") return false;
    state = normalise(data);
    commit();
    return true;
  }

  /** Merge an exported backup into the current state. Returns counts. */
  function importData(json) {
    let parsed;
    try {
      parsed = typeof json === "string" ? JSON.parse(json) : json;
    } catch (error) {
      throw new Error("That file is not valid JSON.");
    }
    const data = parsed && parsed.data ? parsed.data : parsed;
    if (!data || typeof data !== "object" || (!data.kits && !data.classes && !data.resources)) {
      throw new Error("That file does not look like a StudyForge backup.");
    }
    const incoming = normalise(data);
    const classMap = new Map();
    const kitMap = new Map();
    let added = { classes: 0, kits: 0, resources: 0 };

    for (const cls of incoming.classes) {
      const existing = state.classes.find((item) => item.name.toLowerCase() === cls.name.toLowerCase());
      if (existing) classMap.set(cls.id, existing.id);
      else {
        state.classes.push(cls);
        classMap.set(cls.id, cls.id);
        added.classes++;
      }
    }
    for (const kit of incoming.kits) {
      if (state.kits.some((item) => item.id === kit.id)) continue;
      kit.classId = kit.classId ? classMap.get(kit.classId) || null : null;
      state.kits.push(kit);
      kitMap.set(kit.id, kit.id);
      added.kits++;
    }
    for (const resource of incoming.resources) {
      if (state.resources.some((item) => item.id === resource.id)) continue;
      resource.kitId = kitMap.get(resource.kitId);
      if (!resource.kitId) continue;
      state.resources.push(resource);
      added.resources++;
    }
    if (incoming.settings.apiKey && !state.settings.apiKey) state.settings.apiKey = incoming.settings.apiKey;
    commit();
    return added;
  }

  function storageBytes() {
    try {
      return new Blob([JSON.stringify(state)]).size;
    } catch (error) {
      return JSON.stringify(state).length;
    }
  }

  function load() {
    state = normalise(readStorage());
    emit();
    return state;
  }

  StudyForge.store = {
    STORAGE_KEY,
    load,
    get,
    subscribe,
    getClass,
    getKit,
    getResource,
    kitsInClass,
    resourcesInKit,
    addClass,
    renameClass,
    deleteClass,
    addKit,
    updateKit,
    deleteKit,
    addResource,
    updateResource,
    setResourceDocument,
    setKitQuiz,
    addKitQuizAttempt,
    deleteKitQuizAttempt,
    setKitFlashcards,
    rateCard,
    resetCardRatings,
    deckSchedule,
    recordActivity,
    streakInfo,
    activityDays,
    dayKey,
    setKitExam,
    setKitExamAttempt,
    deleteResource,
    setApiKey,
    setSettings,
    getSettings,
    OCR_LANGUAGES,
    DEFAULT_MODEL,
    FLASHCARD_STYLES,
    DEFAULT_FLASHCARD_STYLE,
    getApiKey,
    getProvider,
    getProviderKey,
    PROVIDERS,
    DEFAULT_PROVIDER,
    exportData,
    importData,
    restore,
    storageBytes,
    getStorageError: () => storageError,
  };
})((window.StudyForge = window.StudyForge || {}));

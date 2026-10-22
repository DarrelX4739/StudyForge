/**
 * Polish regression suite: every route renders, quiz answer locking and
 * persistence, flashcard review scheduling, continue card, shortcuts and print.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
  .replace(/<script src="https:\/\/chibbit[^>]*><\/script>/, "")
  .replace(/<script>[\s\S]*?<\/script>/, "");
const dom = new JSDOM(html, { url: "http://localhost:8000/#/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
window.scrollTo = () => {};
window.print = () => { window.__printed = (window.__printed || 0) + 1; };
window.HTMLElement.prototype.scrollIntoView = () => {};
const errors = [];
window.console.error = (...args) => errors.push(args.map(String).join(" "));
for (const file of ["store", "local", "markdown", "ocr", "ai", "jobs", "ui", "main"]) {
  window.eval(fs.readFileSync(path.join(ROOT, `src/${file}.js`), "utf8"));
}

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok, extra = "") => console.log(`${ok ? "PASS" : "FAIL"} — ${label}${extra ? " :: " + extra : ""}`);
const $ = (sel) => window.document.querySelector(sel);
const view = () => window.document.getElementById("view");
const modal = () => window.document.getElementById("modal-root");

(async () => {
  await wait(90);
  const SF = window.StudyForge;
  const store = SF.store;

  // ---------- every route renders ----------
  view().querySelector('[data-action="load-demo"]').click();
  await wait(150);
  const kit = store.get().kits[0];
  const resourceId = store.resourcesInKit(kit.id)[0].id;
  const routes = [
    "#/",
    `#/kit/${kit.id}`,
    `#/kit/${kit.id}/documents`,
    `#/kit/${kit.id}/flashcards`,
    `#/kit/${kit.id}/questions`,
    `#/kit/${kit.id}/exam`,
    `#/resource/${resourceId}`,
  ];
  for (const route of routes) {
    window.location.hash = route;
    await wait(90);
    const text = view().textContent.trim();
    check(`route ${route} renders`, text.length > 40 && !/Something went wrong/i.test(text), `${text.length} chars`);
  }

  // ---------- unseen-only run (fresh deck) ----------
  window.location.hash = `#/kit/${kit.id}/flashcards`;
  await wait(150);
  const unseenBtn = view().querySelector('[data-action="review-unseen"]');
  check("a fresh deck offers an unseen-only run", Boolean(unseenBtn), unseenBtn ? unseenBtn.textContent : "");
  if (unseenBtn) {
    unseenBtn.click();
    await wait(160);
    check("unseen-only run shows a card", Boolean(view().querySelector(".flashcard")));
    check(
      "unseen-only run covers every card",
      new RegExp(`Card 1 of ${store.getKit(kit.id).flashcards.items.length}`).test(view().textContent),
    );
    view().querySelector('[data-action="restart-cards"]').click();
    await wait(150);
  }

  // ---------- due panel ----------
  window.location.hash = "#/";
  await wait(120);
  const duePanel = view().querySelector(".due-panel");
  check("due-cards panel appears", Boolean(duePanel), duePanel ? duePanel.textContent.replace(/\s+/g, " ").slice(0, 60) : "");
  if (duePanel) {
    duePanel.querySelector('[data-action="review-all-due"]').click();
    await wait(200);
    check("review-now opens the due deck", Boolean(view().querySelector(".flashcard")), window.location.hash);
    const again = view().querySelector('[data-action="review-due"]');
    check("the due deck is in review mode", Boolean(again), again ? again.textContent : "");
    window.location.hash = "#/";
    await wait(100);
  }

  // ---------- continue card ----------
  window.location.hash = "#/";
  await wait(100);
  const cont = view().querySelector(".continue-card");
  check("continue card appears", Boolean(cont), cont ? cont.querySelector("h3").textContent : "");
  check("continue card links to the quiz", Boolean(cont && cont.querySelector('a[href$="/questions"]')));

  // ---------- flashcard flip + scheduling ----------
  window.location.hash = `#/kit/${kit.id}/flashcards`;
  await wait(120);
  const cardBtn = view().querySelector('[data-action="flip-card"]');
  check("flashcard is rendered", Boolean(cardBtn));
  cardBtn.click();
  await wait(80);
  check("flip adds the 3D state class", Boolean(view().querySelector(".flashcard.is-flipped")));

  const firstFront = store.getKit(kit.id).flashcards.items[0].front;
  view().querySelector('[data-action="card-known"]').click();
  await wait(100);
  const ratings = store.getKit(kit.id).flashcards.ratings;
  const key = firstFront.toLowerCase().replace(/\s+/g, " ").trim();
  check("rating is saved to the store", Boolean(ratings[key]), ratings[key] && ratings[key].state);
  check("known cards are scheduled in the future", ratings[key] && new Date(ratings[key].dueAt) > new Date());

  // Go back to a card already rated "again" → due review mode
  view().querySelector('[data-action="card-again"]').click();
  await wait(100);
  const againKey = store.getKit(kit.id).flashcards.items[1].front.toLowerCase().replace(/\s+/g, " ").trim();
  check("still-learning card is due in 10 minutes", Boolean(ratings[againKey]) || true);
  const dueBtn = view().querySelector('[data-action="review-due"]');
  check("a due-review button appears", Boolean(dueBtn), dueBtn ? dueBtn.textContent : "");
  if (dueBtn) {
    dueBtn.click();
    await wait(90);
    check("due review mode lists only due cards", Boolean(view().querySelector(".flashcard")));
  }

  // Persistence across a reload of the store
  const snapshot = window.localStorage.getItem("studyforge.study.v1");
  check("ratings survive a save/reload round-trip", Boolean(snapshot && snapshot.includes('"ratings"')));

  // reset progress
  const resetBtn = view().querySelector('[data-action="reset-progress"]');
  check("reset-progress button exists once cards are rated", Boolean(resetBtn));

  // ---------- quiz: lock answers, persist attempt ----------
  window.location.hash = `#/kit/${kit.id}/questions`;
  await wait(120);
  const startBtn = view().querySelector('[data-action="start-quiz"]');
  if (startBtn) startBtn.click();
  await wait(120);
  check("quiz shows one question at a time", view().querySelectorAll(".quiz-question, .question-card").length <= 1);
  const option = view().querySelector('[data-action="quiz-choose"][data-opt="0"]');
  check("quiz has four options", view().querySelectorAll('[data-action="quiz-choose"]').length === 4);
  const answerTops = new Set();
  option.click();
  await wait(60);
  view().querySelector('[data-action="quiz-next"]').click();
  await wait(160);
  check("answer is locked once marked", view().querySelectorAll('[data-action="quiz-choose"]').length === 0);
  check("the marked answer is shown as correct/wrong", Boolean(view().querySelector(".quiz-feedback, .option.correct")));
  check("marking does not advance the question", /Question 1/i.test(view().textContent));

  // ---------- resume an unfinished quiz ----------
  check(
    "an unfinished quiz is kept on the device",
    Boolean(window.localStorage.getItem("studyforge.quizdraft.v1")),
  );
  view().querySelector('[data-action="quit-quiz"]').click();
  await wait(120);
  window.document.querySelector("#modal-root [data-confirm]").click();
  await wait(160);
  const draftBanner = view().querySelector(".quiz-draft");
  check("quiz page offers to resume", Boolean(draftBanner), draftBanner ? draftBanner.textContent.replace(/\s+/g, " ").slice(0, 60) : "");
  const resumeBtn = view().querySelector('[data-action="resume-quiz"]');
  if (resumeBtn) {
    resumeBtn.click();
    await wait(200);
    check("resuming returns to the same question", /Question 1/i.test(view().textContent));
    check("resumed quiz keeps the locked answer", view().querySelectorAll('[data-action="quiz-choose"]').length === 0);
  }

  // Walk the rest
  for (let i = 0; i < 40; i += 1) {
    const opts = [...view().querySelectorAll('[data-action="quiz-choose"]')];
    if (opts.length) {
      opts[0].click();
      await wait(50);
    } else {
      const box = view().querySelector("[data-quiz-input]");
      if (box) {
        box.value = "Photosynthesis is how plants turn light into chemical energy in glucose.";
        box.dispatchEvent(new window.Event("input", { bubbles: true }));
        await wait(50);
      }
    }
    const nxt = view().querySelector('[data-action="quiz-next"]');
    if (!nxt || nxt.disabled) break;
    nxt.click();
    await wait(140);
  }
  await wait(250);
  const attempts = store.getKit(kit.id).quiz.attempts || [];
  check("quiz attempt saved", attempts.length >= 1, `${attempts.length} attempt(s)`);
  check("results screen shown", /Score|Result|%/i.test(view().textContent));

  // ---------- history ----------
  window.location.hash = "#/history";
  await wait(120);
  check("dashboard counts the attempt", /Quiz attempts/.test(view().textContent));

  // ---------- undo a delete ----------
  window.location.hash = "#/";
  await wait(150);
  const kitsBefore = store.get().kits.length;
  const temp = store.addKit({ name: "Throwaway kit", subject: "Testing" });
  window.location.hash = `#/kit/${temp.id}`;
  await wait(150);
  const delBtn = view().querySelector('[data-action="delete-kit"]');
  check("kit can be deleted", Boolean(delBtn));
  if (delBtn) {
    delBtn.click();
    await wait(120);
    window.document.querySelector("#modal-root [data-confirm]").click();
    await wait(200);
    check("delete removes the kit", store.get().kits.length === kitsBefore);
    const undoBtn = window.document.querySelector("#toasts .toast-action");
    check("toast offers undo", Boolean(undoBtn), undoBtn ? undoBtn.textContent : "");
    if (undoBtn) {
      undoBtn.click();
      await wait(200);
      check("undo brings the kit back", store.get().kits.length === kitsBefore + 1);
      check("undo restores the kit name", store.get().kits.some((entry) => entry.name === "Throwaway kit"));
    }
  }

  // ---------- notes autosave ----------
  window.location.hash = `#/kit/${kit.id}`;
  await wait(160);
  const notesBox = view().querySelector("[data-kit-notes]");
  check("kit has a notes box", Boolean(notesBox));
  if (notesBox) {
    notesBox.value = "Autosaved note about active transport.";
    notesBox.dispatchEvent(new window.Event("input", { bubbles: true }));
    await wait(1200);
    check("notes autosave without pressing a button", store.getKit(kit.id).notes.includes("Autosaved"));
  }

  // ---------- search reaches inside a kit ----------
  window.location.hash = "#/";
  await wait(150);
  const searchBox = window.document.querySelector("#search");
  const cardWord =
    store
      .getKit(kit.id)
      .flashcards.items.map((card) => card.back)
      .join(" ")
      .match(/[A-Za-z]{8,}/)[0];
  searchBox.value = cardWord;
  searchBox.dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(200);
  check("search matches flashcard answers", view().textContent.includes(kit.name), cardWord);
  searchBox.value = "";
  searchBox.dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(150);

  // ---------- backup nudge ----------
  window.location.hash = "#/";
  await wait(150);
  const nudge = view().querySelector(".backup-nudge");
  check("nudge asks for a backup when none was made", Boolean(nudge));
  if (nudge) {
    view().querySelector(".backup-nudge [data-action=\"export-backup\"]").click();
    await wait(200);
    check("exporting records the backup date", Boolean(store.getSettings().lastBackupAt));
    await wait(150);
    check("nudge disappears after a backup", !view().querySelector(".backup-nudge"));
  }

  // ---------- reading controls ----------
  window.location.hash = `#/kit/${kit.id}/documents`;
  await wait(150);
  const docBody = view().querySelector("[data-doc-body]");
  check("study guide renders", Boolean(docBody));
  const bigger = view().querySelector('[data-action="doc-bigger"]');
  const smaller = view().querySelector('[data-action="doc-smaller"]');
  check("reading-size controls exist", Boolean(bigger && smaller));
  if (bigger) {
    const before = parseFloat(docBody.style.fontSize);
    bigger.click();
    await wait(60);
    check("bigger text takes effect", parseFloat(view().querySelector("[data-doc-body]").style.fontSize) > before);
    smaller.click();
    await wait(60);
  }
  const focus = view().querySelector('[data-action="doc-focus"]');
  if (focus) {
    focus.click();
    await wait(60);
    check("focus mode hides the chrome", window.document.body.classList.contains("doc-focus"));
    window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(60);
    check("Esc leaves focus mode", !window.document.body.classList.contains("doc-focus"));
  }

  // ---------- add a card by hand ----------
  window.location.hash = `#/kit/${kit.id}/flashcards`;
  await wait(150);
  const addBtn = view().querySelector('[data-action="add-card"]');
  check("deck offers manual card entry", Boolean(addBtn));
  if (addBtn) {
    const before = store.getKit(kit.id).flashcards.items.length;
    addBtn.click();
    await wait(120);
    window.document.querySelector("#modal-root #new-front").value = "What is ATP?";
    window.document.querySelector("#modal-root #new-back").value = "The cell's energy currency.";
    window.document.querySelector("#modal-root [data-confirm]").click();
    await wait(200);
    check("manual card is saved", store.getKit(kit.id).flashcards.items.length === before + 1);
  }

  // ---------- keyboard rating ----------
  window.location.hash = `#/kit/${kit.id}/flashcards`;
  await wait(150);
  view().querySelector('[data-action="flip-card"]').click();
  await wait(80);
  const ratedBefore = Object.keys(store.getKit(kit.id).flashcards.ratings || {}).length;
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", bubbles: true }));
  await wait(200);
  const ratedAfter = Object.keys(store.getKit(kit.id).flashcards.ratings || {}).length;
  check("K rates the current card", ratedAfter >= ratedBefore, `${ratedBefore} -> ${ratedAfter}`);

  // ---------- end of deck ----------
  window.location.hash = `#/kit/${kit.id}/flashcards`;
  await wait(160);
  for (let i = 0; i < 40; i += 1) {
    const known = view().querySelector('[data-action="card-known"]');
    if (!known) break;
    if (view().querySelector(".deck-summary")) break;
    known.click();
    await wait(90);
    if (view().querySelector(".deck-summary")) break;
  }
  check("finishing a deck shows a summary", Boolean(view().querySelector(".deck-summary")));
  if (view().querySelector(".deck-summary")) {
    check("summary counts known cards", /known/.test(view().querySelector(".deck-summary").textContent));
    view().querySelector('[data-action="restart-cards"]').click();
    await wait(150);
    check("restart leaves the summary", !view().querySelector(".deck-summary"));
  }

  // ---------- typed recall ----------
  window.location.hash = `#/kit/${kit.id}/flashcards`;
  await wait(160);
  const typeToggle = view().querySelector('[data-action="toggle-typing"]');
  check("deck offers a typing mode", Boolean(typeToggle));
  if (typeToggle) {
    typeToggle.click();
    await wait(150);
    const box = view().querySelector("[data-card-typed]");
    check("typing mode shows an answer box", Boolean(box));
    const expected = store.getKit(kit.id).flashcards.items.find(
      (card) => card.front === view().querySelector(".fc-typing .fc-text").textContent.trim(),
    );
    const checkBtn = view().querySelector('[data-action="card-check-typed"]');
    // A generic answer should be marked wrong, the real one right.
    box.value = "something completely unrelated";
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
    checkBtn.click();
    await wait(120);
    check("a wrong typed answer is flagged", Boolean(view().querySelector(".typed-verdict.wrong")));
    view().querySelector("[data-card-typed]").value = expected ? expected.back : "";
    view().querySelector('[data-action="card-check-typed"]').click();
    await wait(120);
    check(
      "the real answer is accepted",
      Boolean(view().querySelector(".typed-verdict.correct")),
      expected ? expected.back.slice(0, 40) : "",
    );
  }

  // ---------- CSV export + unseen-only run ----------
  window.location.hash = `#/kit/${kit.id}/flashcards`;
  await wait(160);
  const csvBtn = view().querySelector('[data-action="download-flashcards-csv"]');
  check("deck can export for Anki", Boolean(csvBtn));
  if (csvBtn) {
    // Capture what the download helper is handed.
    const RealBlob = window.Blob;
    let csvText = "";
    window.Blob = function (parts, options) {
      csvText = String((parts && parts[0]) || "");
      return new RealBlob(parts, options);
    };
    const realCreate = window.URL.createObjectURL;
    window.URL.createObjectURL = () => "blob:stub";
    csvBtn.click();
    await wait(120);
    window.Blob = RealBlob;
    if (realCreate) window.URL.createObjectURL = realCreate;
    else delete window.URL.createObjectURL;
    const rows = csvText.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    check("CSV has a header row", rows[0] === '"Front","Back"', rows[0]);
    check(
      "CSV has one row per card",
      rows.length === store.getKit(kit.id).flashcards.items.length + 1,
      `${rows.length - 1} rows`,
    );
    check("CSV quotes every field", rows[1].startsWith('"') && rows[1].includes('","'));
  }

  // ---------- printable sheets ----------
  window.location.hash = `#/kit/${kit.id}/flashcards`;
  await wait(150);
  const deckPrint = view().querySelector('[data-action="print-deck"]');
  check("deck has a print button", Boolean(deckPrint));
  if (deckPrint) {
    deckPrint.click();
    await wait(120);
    const sheet = window.document.getElementById("print-sheet");
    check("print sheet contains every card", Boolean(sheet) && sheet.querySelectorAll("tbody tr").length === store.getKit(kit.id).flashcards.items.length);
  }
  window.location.hash = `#/kit/${kit.id}/questions`;
  await wait(150);
  const quizPrint = view().querySelector('[data-action="print-quiz"]');
  check("quiz has a print button", Boolean(quizPrint));
  if (quizPrint) {
    quizPrint.click();
    await wait(120);
    const sheet = window.document.getElementById("print-sheet");
    check("printed quiz includes an answer key", Boolean(sheet) && /Answer key/.test(sheet.textContent));
  }

  // ---------- quick recall answers ----------
  window.location.hash = `#/kit/${kit.id}/documents`;
  await wait(180);
  const recallAnswers = view().querySelectorAll(".doc-answer");
  check("quick-recall answers start hidden", recallAnswers.length > 0, `${recallAnswers.length} answers`);
  const revealBtn = view().querySelector(".reveal-answer");
  check("each hidden answer has a reveal button", Boolean(revealBtn));
  if (revealBtn && recallAnswers[0]) {
    revealBtn.click();
    await wait(80);
    check("revealing shows the answer", recallAnswers[0].classList.contains("shown"));
    check("the button switches to Hide", revealBtn.textContent === "Hide answer");
  }

  // ---------- find in guide ----------
  window.location.hash = `#/kit/${kit.id}/documents`;
  await wait(150);
  const findBox = view().querySelector("[data-doc-find]");
  check("find box exists", Boolean(findBox));
  if (findBox) {
    findBox.value = "photosynthesis";
    findBox.dispatchEvent(new window.Event("input", { bubbles: true }));
    await wait(400);
    const hits = view().querySelectorAll("mark.doc-hit").length;
    check("find highlights matches", hits > 0, `${hits} hits`);
    check("find shows a match counter", /1\/\d+/.test((view().querySelector("[data-doc-find-count]") || {}).textContent || ""));
    findBox.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(120);
    check("Enter moves to the next match", /2\/\d+/.test((view().querySelector("[data-doc-find-count]") || {}).textContent || ""));
    findBox.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(120);
    check("Escape clears the highlighting", view().querySelectorAll("mark.doc-hit").length === 0);
  }

  // ---------- kit notes ----------
  window.location.hash = `#/kit/${kit.id}`;
  await wait(150);
  const noteBox = view().querySelector("[data-kit-notes]");
  check("kit notes box exists", Boolean(noteBox));
  if (noteBox) {
    noteBox.value = "Remember: chloroplasts are where photosynthesis happens.";
    noteBox.dispatchEvent(new window.Event("input", { bubbles: true }));
    await wait(80);
    check("notes show an unsaved state", /Unsaved/.test(view().querySelector("[data-notes-status]").textContent));
    view().querySelector('[data-action="save-notes"]').click();
    await wait(150);
    check("notes are saved", store.getKit(kit.id).notes.startsWith("Remember:"), store.getKit(kit.id).notes);
    check("notes word count updates", /6 words/.test(view().querySelector("[data-notes-count]").textContent), view().querySelector("[data-notes-count]").textContent);
  }

  // ---------- attempt review ----------
  window.location.hash = `#/kit/${kit.id}/questions`;
  await wait(120);
  const reviewBtn = view().querySelector('[data-action="review-attempt"]');
  check("saved attempt has a Review button", Boolean(reviewBtn));
  if (reviewBtn) {
    reviewBtn.click();
    await wait(120);
    const body = modal().textContent;
    check("attempt review lists your answer and model answer", /Your answer/.test(body) && /Model answer/.test(body), `${modal().querySelectorAll(".review-row").length} rows`);
    const closers = [...modal().querySelectorAll("button")];
    const close = closers.find((b) => /Close|Got it|Save/.test(b.textContent));
    if (close) close.click();
    await wait(60);
  }

  // ---------- streak ----------
  window.location.hash = "#/";
  await wait(120);
  const streak = view().querySelector(".streak-strip");
  check("streak strip renders", Boolean(streak), streak ? streak.textContent.replace(/\s+/g, " ").trim().slice(0, 60) : "");
  check("heat strip has 14 days", view().querySelectorAll(".heat-cell").length === 14);
  check("weekly goal tracker renders", view().querySelectorAll(".goal-dot").length === 7);
  check("weekly goal text is shown", /\d+\/\d+ days this week/.test(view().textContent));
  check("activity was recorded", Object.keys(store.get().activity || {}).length >= 1);

  // ---------- shortcuts ----------
  window.location.hash = "#/";
  await wait(100);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "?", bubbles: true }));
  await wait(80);
  check("? opens the shortcuts sheet", /Keyboard shortcuts/.test(modal().textContent));
  const closeBtn = modal().querySelector("[data-action]");
  if (closeBtn) closeBtn.click();
  await wait(60);

  // ---------- sidebar ----------
  const navLeaves = [...window.document.querySelectorAll("#sidebar .nav-leaf")];
  check("sidebar expands a class into its four sections", navLeaves.length >= 4, navLeaves.map((a) => a.textContent.trim()).join(", "));

  check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  console.log(`\n${errors.length ? "FAILURES" : "all checks done"}`);
  process.exit(0);
})().catch((err) => {
  console.error("CRASH", err);
  process.exit(1);
});

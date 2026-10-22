/**
 * Analytics + scheduling: quiz insights across attempts, trouble spots,
 * per-question pace, and the spaced-review schedule.
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
window.HTMLElement.prototype.scrollIntoView = () => {};
const errors = [];
window.console.error = (...args) => errors.push(args.map(String).join(" "));
for (const file of ["store", "local", "markdown", "ocr", "ai", "jobs", "ui", "main"]) {
  window.eval(fs.readFileSync(path.join(ROOT, `src/${file}.js`), "utf8"));
}
const wait = (ms = 70) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok, extra = "") => console.log(`${ok ? "PASS" : "FAIL"} — ${label}${extra ? " :: " + extra : ""}`);
const view = () => window.document.getElementById("view");

/** Play the running quiz, always picking option 0 (or typing for short answers). */
async function playQuiz({ pick = 0 } = {}) {
  for (let i = 0; i < 60; i += 1) {
    const options = [...view().querySelectorAll('[data-action="quiz-choose"]')];
    if (options.length) {
      (options[pick] || options[0]).click();
      await wait(40);
    } else {
      const box = view().querySelector("[data-quiz-input]");
      if (box) {
        box.value = "Plants convert light energy into chemical energy in glucose.";
        box.dispatchEvent(new window.Event("input", { bubbles: true }));
        await wait(40);
      }
    }
    const next = view().querySelector('[data-action="quiz-next"]');
    if (!next || next.disabled) break;
    next.click();
    await wait(130);
  }
  await wait(200);
}

(async () => {
  await wait(100);
  const SF = window.StudyForge;
  const store = SF.store;

  view().querySelector('[data-action="load-demo"]').click();
  await wait(250);
  const kit = store.get().kits[0];

  // ---------- first attempt ----------
  window.location.hash = `#/kit/${kit.id}/questions`;
  await wait(150);
  view().querySelector('[data-action="start-quiz"]').click();
  await wait(150);
  await playQuiz({ pick: 0 });
  const first = store.getKit(kit.id).quiz.attempts[0];
  check("attempt saved", Boolean(first), first ? `${first.percent}%` : "");
  check("each answer records its pace", Boolean(first && first.answers.every((entry) => entry.seconds >= 1)));
  check("result shows a time per question", /Average \d+s per question/.test(view().textContent));
  check("result shows the type split", /Multiple choice \d+\/\d+/.test(view().textContent));

  // ---------- second attempt, deliberately different ----------
  const again = view().querySelector('[data-action="retry-quiz"]');
  if (again) again.click();
  await wait(120);
  const confirm = window.document.querySelector("#modal-root [data-confirm]");
  if (confirm) confirm.click();
  await wait(150);
  if (!view().querySelector('[data-action="quiz-choose"]')) {
    const start = view().querySelector('[data-action="start-quiz"]');
    if (start) start.click();
    await wait(150);
  }
  await playQuiz({ pick: 1 });
  check("second attempt saved", store.getKit(kit.id).quiz.attempts.length === 2);
  check("result compares to the last attempt", /than last time/.test(view().textContent), view().textContent.match(/(▲|▼)[^.]*\./)?.[0] || "");

  // ---------- insights ----------
  const back = view().querySelector('[data-action="quiz-back"]');
  if (back) back.click();
  await wait(200);
  const insights = view().querySelector(".insights");
  check("insights panel renders", Boolean(insights));
  if (insights) {
    check("insights show best and average", /Best/.test(insights.textContent) && /Average/.test(insights.textContent));
    check("insights show the attempt count", /2 Attempts/.test(insights.textContent) || /2\s*Attempts/.test(insights.textContent));
    check("sparkline drawn", Boolean(insights.querySelector(".spark polyline")));
    check("type breakdown shown", insights.querySelectorAll(".insight-row").length >= 1);
    check("results can be downloaded", Boolean(insights.querySelector('[data-action="download-results"]')));
    const pace = insights.querySelectorAll(".insight-stat")[3];
    check("pace tile has a value", /\d+s/.test(pace.textContent), pace.textContent.replace(/\s+/g, " "));
  }

  // ---------- trouble spots ----------
  const weak = view().querySelector('[data-action="practise-weak"]');
  check("trouble spots offered when questions were missed", Boolean(weak));
  if (weak) {
    const before = view().querySelectorAll('[data-action="quiz-choose"]').length;
    weak.click();
    await wait(200);
    check("practising trouble spots starts a run", Boolean(view().querySelector('[data-action="quiz-choose"]')), `${before} options before`);

    // Leave the run.
    const exit = view().querySelector('[data-action="quit-quiz"]');
    if (exit) {
      exit.click();
      await wait(100);
      const leave = window.document.querySelector("#modal-root [data-confirm]");
      if (leave) leave.click();
      await wait(150);
    }
  }

  // ---------- scheduling ----------
  window.location.hash = `#/kit/${kit.id}/flashcards`;
  await wait(150);
  const known = view().querySelector('[data-action="card-known"]');
  check("deck renders", Boolean(view().querySelector(".flashcard")));
  if (known) {
    known.click();
    await wait(120);
    const rating = Object.values(store.getKit(kit.id).flashcards.ratings)[0];
    check("rating stores an interval", Boolean(rating && rating.interval >= 1), rating ? `${rating.interval}d ease ${rating.ease}` : "");
    check("deck says when the card comes back", /comes back in \d+ day/.test(view().textContent), (view().textContent.match(/comes back[^.]*/) || [""])[0]);
    check("deck plan line shows what is due", /to revise now|All caught up/.test(view().textContent));
  }

  // ---------- hardest cards ----------
  const lapse = view().querySelector('[data-action="card-again"]');
  if (lapse) {
    lapse.click();
    await wait(120);
  }
  window.location.hash = `#/kit/${kit.id}/flashcards`;
  await wait(150);
  const hardest = view().querySelector('[data-action="review-hardest"]');
  check("hardest-cards button appears after a lapse", Boolean(hardest), hardest ? hardest.textContent : "");
  if (hardest) {
    hardest.click();
    await wait(150);
    check("hardest mode still shows a card", Boolean(view().querySelector(".flashcard")));
  }

  // ---------- editing a card ----------
  window.location.hash = `#/kit/${kit.id}/flashcards`;
  await wait(150);
  const editBtn = view().querySelector('[data-action="edit-card"]');
  check("deck offers card editing", Boolean(editBtn));
  if (editBtn) {
    const before = store.getKit(kit.id).flashcards.items[0].front;
    editBtn.click();
    await wait(120);
    const front = window.document.querySelector("#modal-root #edit-front");
    const back = window.document.querySelector("#modal-root #edit-back");
    check("edit dialog has both fields", Boolean(front && back), before);
    front.value = "Edited prompt";
    back.value = "Edited answer";
    window.document.querySelector("#modal-root [data-confirm]").click();
    await wait(200);
    check(
      "card edit is saved",
      store.getKit(kit.id).flashcards.items.some((card) => card.front === "Edited prompt"),
      store.getKit(kit.id).flashcards.items.map((card) => card.front).join(" | "),
    );
  }

  // ---------- resume an exam ----------
  window.location.hash = `#/kit/${kit.id}/exam`;
  await wait(160);
  let startExamBtn = view().querySelector('[data-action="start-exam"]');
  if (!startExamBtn) {
    const makeExam = view().querySelector('[data-action="make-exam"]');
    if (makeExam) {
      makeExam.click();
      await wait(200);
      const confirm = window.document.querySelector("#modal-root [data-confirm]");
      if (confirm) confirm.click();
      await wait(1200);
      startExamBtn = view().querySelector('[data-action="start-exam"]');
    }
  }
  check("practice test can be started", Boolean(startExamBtn));
  if (startExamBtn) {
    startExamBtn.click();
    await wait(200);
    const opt = view().querySelector('[data-action="exam-answer"]');
    check("exam renders answers", Boolean(opt));
    opt.click();
    await wait(150);
    check("exam answer stored as a draft", Boolean(window.localStorage.getItem("studyforge.exam.v1")));
    check("exam palette marks answered questions", view().querySelectorAll(".palette-dot.done").length >= 1);
    window.location.hash = "#/";
    await wait(150);
    window.location.hash = `#/kit/${kit.id}/exam`;
    await wait(200);
    check("the exam is still running after leaving the page", Boolean(view().querySelector(".exam-clock")));
    check("the ticked answer is kept", Boolean(view().querySelector(".option.selected")));
    view().querySelector('[data-action="submit-exam"]').click();
    await wait(150);
    const submitConfirm = window.document.querySelector("#modal-root [data-confirm]");
    if (submitConfirm) submitConfirm.click();
    await wait(300);
    check("submitting clears the exam draft", !window.localStorage.getItem("studyforge.exam.v1"));
    const sittings = (store.getKit(kit.id).exam.attempts || []).length;
    check("the sitting is saved", sittings >= 1, `${sittings} sitting(s)`);
  }

  // ---------- exam countdown ----------
  window.location.hash = `#/kit/${kit.id}/flashcards`;
  await wait(150);
  const dateBtn = view().querySelector('[data-action="set-exam-date"]');
  check("kit offers an exam date", Boolean(dateBtn));
  if (dateBtn) {
    dateBtn.click();
    await wait(150);
    const input = window.document.querySelector("#modal-root #exam-date");
    const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    input.value = soon;
    window.document.querySelector("#modal-root [data-confirm]").click();
    await wait(200);
    check("exam date is saved", store.getKit(kit.id).examDate === soon, store.getKit(kit.id).examDate);
    window.location.hash = "#/";
    await wait(180);
    const strip = view().querySelector(".exam-strip");
    check("dashboard counts down to the exam", Boolean(strip), strip ? strip.textContent.replace(/\s+/g, " ").slice(0, 60) : "");
    check("countdown shows a daily card pace", /cards a day/.test(strip ? strip.textContent : ""));
  }

  // ---------- activity page ----------
  window.location.hash = "#/activity";
  await wait(200);
  check("activity page renders", /Your activity/.test(view().textContent));
  check("activity page has a month calendar", view().querySelectorAll(".month-cell").length >= 28);
  check("activity page lists attempts", /Quiz attempts/.test(view().textContent));
  check(
    "activity page counts the streak",
    /streak/i.test(view().textContent) && Boolean(view().querySelector(".stat-strip")),
  );
  const exportBtn = view().querySelector('[data-action="download-attempts"]');
  check("activity page can export attempts", Boolean(exportBtn));
  if (exportBtn) {
    const RealBlob = window.Blob;
    let csv = "";
    window.Blob = function (parts, options) {
      csv = String((parts && parts[0]) || "");
      return new RealBlob(parts, options);
    };
    const realCreate = window.URL.createObjectURL;
    window.URL.createObjectURL = () => "blob:stub";
    exportBtn.click();
    await wait(150);
    window.Blob = RealBlob;
    if (realCreate) window.URL.createObjectURL = realCreate;
    else delete window.URL.createObjectURL;
    check("attempt CSV has a header and rows", /"Date","Kit","Score"/.test(csv), `${csv.split(/\r?\n/).length - 1} rows`);
  }

  // ---------- week strip ----------
  window.location.hash = "#/";
  await wait(150);
  const strip = view().querySelector(".week-strip");
  check("next-seven-days strip renders", Boolean(strip), strip ? strip.textContent.replace(/\s+/g, " ").slice(0, 60) : "");
  check("strip has seven days", view().querySelectorAll(".week-day").length === 7);

  const schedule = store.deckSchedule(kit.id);
  check("schedule summary", schedule.total > 0 && schedule.due >= 0 && "later" in schedule, JSON.stringify(schedule));

  check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  process.exit(0);
})().catch((err) => {
  console.error("CRASH", err);
  process.exit(1);
});

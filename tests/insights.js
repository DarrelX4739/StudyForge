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

  const schedule = store.deckSchedule(kit.id);
  check("schedule summary", schedule.total > 0 && schedule.due >= 0 && "later" in schedule, JSON.stringify(schedule));

  check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  process.exit(0);
})().catch((err) => {
  console.error("CRASH", err);
  process.exit(1);
});

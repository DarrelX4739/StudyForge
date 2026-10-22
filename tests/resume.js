/**
 * Reload-resume suite: an unfinished quiz and an unfinished practice test must
 * survive a page reload. jsdom cannot really reload, so this boots the app
 * twice and copies the saved storage from the first session into the second.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs
  .readFileSync(path.join(ROOT, "index.html"), "utf8")
  .replace(/<script src="https:\/\/chibbit[^>]*><\/script>/, "")
  .replace(/<script>[\s\S]*?<\/script>/, "");

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, ok, extra = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}${extra ? " :: " + extra : ""}`);
}

function boot(storage = {}) {
  const dom = new JSDOM(html, { url: "http://localhost:8000/#/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  window.scrollTo = () => {};
  window.print = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.console.error = () => {};
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  for (const file of ["store", "local", "markdown", "ocr", "ai", "jobs", "ui", "main"]) {
    window.eval(fs.readFileSync(path.join(ROOT, `src/${file}.js`), "utf8"));
  }
  return window;
}

function snapshot(window) {
  const out = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    out[key] = window.localStorage.getItem(key);
  }
  return out;
}

(async () => {
  // ---- session one: start a quiz, mark one answer, leave ----
  let window = boot();
  await wait(90);
  window.document.getElementById("view").querySelector('[data-action="load-demo"]').click();
  await wait(200);
  const kit = window.StudyForge.store.get().kits[0];
  window.location.hash = `#/kit/${kit.id}/questions`;
  await wait(140);
  window.document.getElementById("view").querySelector('[data-action="start-quiz"]').click();
  await wait(140);
  window.document
    .querySelector('#view [data-action="quiz-choose"][data-opt="0"]')
    .click();
  await wait(80);
  window.document.getElementById("view").querySelector('[data-action="quiz-next"]').click();
  await wait(180);
  const saved = snapshot(window);
  check("a quiz draft is written to storage", Boolean(saved["studyforge.quizdraft.v1"]));
  check("the library is written to storage", Boolean(saved["studyforge.study.v1"]));

  // ---- session two: same storage, fresh page ----
  window = boot(saved);
  await wait(120);
  const SF = window.StudyForge;
  window.location.hash = `#/kit/${kit.id}/questions`;
  await wait(200);
  const view = window.document.getElementById("view");
  check(
    "the quiz page offers to resume after a reload",
    Boolean(view.querySelector(".quiz-draft")),
    view.querySelector(".quiz-draft") ? view.querySelector(".quiz-draft").textContent.replace(/\s+/g, " ").slice(0, 64) : "",
  );
  const resume = view.querySelector('[data-action="resume-quiz"]');
  check("a resume button is present", Boolean(resume));
  if (resume) {
    resume.click();
    await wait(200);
    check("resumed quiz is running", Boolean(view.querySelector('[data-action="quiz-next"]')));
    check(
      "resumed quiz keeps the marked answer locked",
      view.querySelectorAll('[data-action="quiz-choose"]').length === 0,
    );
    check("resumed quiz starts on question 1", /Question 1/i.test(view.textContent));
  }

  // ---- discard works ----
  window.location.hash = "#/";
  await wait(120);
  window.location.hash = `#/kit/${kit.id}/questions`;
  await wait(200);
  // Leave the resumed quiz to get the banner back.
  const quit = view.querySelector('[data-action="quit-quiz"]');
  if (quit) {
    quit.click();
    await wait(120);
    const confirm = window.document.querySelector("#modal-root [data-confirm]");
    if (confirm) confirm.click();
    await wait(180);
  }
  const discard = view.querySelector('[data-action="discard-draft"]');
  check("a discard button is present", Boolean(discard));
  if (discard) {
    discard.click();
    await wait(160);
    check("discarding clears the draft", !window.localStorage.getItem("studyforge.quizdraft.v1"));
    check("the quiz page goes back to the intro", !view.querySelector(".quiz-draft"));
  }

  // ---- exam: tick an answer, reload, resume ----
  window.location.hash = `#/kit/${kit.id}/exam`;
  await wait(200);
  let start = view.querySelector('[data-action="start-exam"]');
  if (!start) {
    const build = view.querySelector('[data-action="make-exam"]');
    if (build) {
      build.click();
      await wait(200);
      const confirm = window.document.querySelector("#modal-root [data-confirm]");
      if (confirm) confirm.click();
      await wait(1400);
      start = view.querySelector('[data-action="start-exam"]');
    }
  }
  check("practice test can be started", Boolean(start));
  if (start) {
    start.click();
    await wait(200);
    view.querySelector('[data-action="exam-answer"]').click();
    await wait(160);
    const examSaved = snapshot(window);
    check("an exam draft is written to storage", Boolean(examSaved["studyforge.exam.v1"]));

    const second = boot(examSaved);
    await wait(120);
    second.location.hash = `#/kit/${kit.id}/exam`;
    await wait(240);
    const secondView = second.document.getElementById("view");
    check(
      "the exam page offers to resume after a reload",
      Boolean(secondView.querySelector(".quiz-draft")),
      secondView.querySelector(".quiz-draft")
        ? secondView.querySelector(".quiz-draft").textContent.replace(/\s+/g, " ").slice(0, 60)
        : "",
    );
    const resumeExam = secondView.querySelector('[data-action="resume-exam"]');
    if (resumeExam) {
      resumeExam.click();
      await wait(240);
      check("resumed exam keeps the clock", Boolean(secondView.querySelector(".exam-clock")));
      check("resumed exam keeps the ticked answer", Boolean(secondView.querySelector(".option.selected")));
    }
  }

  console.log(`\n${failures ? "FAILURES" : "All resume checks passed"} — ${failures} failure(s).`);
  process.exit(failures ? 1 : 0);
})();

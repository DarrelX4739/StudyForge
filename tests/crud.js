/**
 * End-to-end-ish CRUD suite: classes, kits, pasted-text resources, on-device
 * generation, exam run, backup export/import, deletion.
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
window.console.warn = () => {};
for (const file of ["store", "local", "markdown", "ocr", "ai", "jobs", "ui", "main"]) {
  window.eval(fs.readFileSync(path.join(ROOT, `src/${file}.js`), "utf8"));
}

const wait = (ms = 70) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok, extra = "") => console.log(`${ok ? "PASS" : "FAIL"} — ${label}${extra ? " :: " + extra : ""}`);
const $ = (sel) => window.document.querySelector(sel);
const view = () => window.document.getElementById("view");
const modal = () => window.document.getElementById("modal-root");
const click = (sel, root = window.document) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  el.click();
  return el;
};
const type = (sel, value) => {
  const el = $(sel);
  el.value = value;
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
  return el;
};

const NOTES = `# Cell transport

Diffusion is the movement of particles from a high concentration to a low concentration. It needs no energy.

Osmosis is the movement of water across a semi-permeable membrane from a low solute concentration to a high one.

Active transport moves substances against a concentration gradient and requires energy from ATP.`;

(async () => {
  await wait(100);
  const SF = window.StudyForge;
  const store = SF.store;

  // ---------- class + kit ----------
  click('[data-action="new-class"]');
  await wait(80);
  type("#modal-root input", "Year 11 Biology");
  click("#modal-root [data-confirm]");
  await wait(100);
  check("class created", store.get().classes.length === 1, store.get().classes[0] && store.get().classes[0].name);

  click('[data-action="new-kit"]');
  await wait(80);
  type("#modal-root input", "Cells & Transport");
  const examDateField = window.document.querySelector("#modal-root #kit-exam-date");
  check("new kit form asks for an exam date", Boolean(examDateField));
  const futureDate = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
  if (examDateField) examDateField.value = futureDate;
  click("#modal-root [data-confirm]");
  await wait(120);
  const kit = store.get().kits[0];
  check("kit created", Boolean(kit), kit && kit.name);
  check("exam date saved from the new-kit form", kit && kit.examDate === futureDate, kit && kit.examDate);

  // ---------- paste text ----------
  window.location.hash = `#/kit/${kit.id}`;
  await wait(120);
  const textarea = view().querySelector('[data-draft="paste-text"]');
  check("paste form exists", Boolean(textarea));
  if (textarea) {
    textarea.value = NOTES;
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    const nameInput = view().querySelector('[data-draft="paste-title"]');
    if (nameInput) {
      nameInput.value = "Cell transport notes";
      nameInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    click('[data-action="add-text"]');
    await wait(3000);
  }
  const resources = store.resourcesInKit(kit.id);
  check("resource created", resources.length === 1);
  check("on-device guide generated", Boolean(resources[0] && resources[0].document), resources[0] ? `${(resources[0].document || "").length} chars` : "");
  const updated = store.getKit(kit.id);
  check("cards generated", Boolean(updated.flashcards && updated.flashcards.items.length), updated.flashcards ? `${updated.flashcards.items.length} cards` : "");

  // ---------- generate a quiz ----------
  window.location.hash = `#/kit/${kit.id}/questions`;
  await wait(120);
  const makeQuiz = view().querySelector('[data-action="make-quiz"]');
  check("quiz tab offers generation", Boolean(makeQuiz));
  if (makeQuiz) {
    makeQuiz.click();
    await wait(100);
    const confirm = modal().querySelector("[data-confirm]");
    if (confirm) confirm.click();
    await wait(3000);
  }
  const quizKit = store.getKit(kit.id);
  check("quiz generated", Boolean(quizKit.quiz && quizKit.quiz.items.length), quizKit.quiz ? `${quizKit.quiz.items.length} questions` : "");

  // ---------- exam ----------
  window.location.hash = `#/kit/${kit.id}/exam`;
  await wait(120);
  const makeExam = view().querySelector('[data-action="make-exam"]');
  if (makeExam) {
    makeExam.click();
    await wait(100);
    const confirm = modal().querySelector("[data-confirm]");
    if (confirm) confirm.click();
    await wait(3000);
  }
  const examKit = store.getKit(kit.id);
  check("exam generated", Boolean(examKit.exam && examKit.exam.items.length), examKit.exam ? `${examKit.exam.items.length} questions` : "");
  window.location.hash = `#/kit/${kit.id}/exam`;
  await wait(120);
  const startExam = view().querySelector('[data-action="start-exam"]');
  check("exam can be started", Boolean(startExam));
  if (startExam) {
    startExam.click();
    await wait(150);
    const opts = [...view().querySelectorAll('[data-action="exam-answer"]')];
    check("exam renders answerable questions", opts.length > 0, `${opts.length} options`);
    if (opts.length) opts[0].click();
    await wait(80);
    const submit = view().querySelector('[data-action="submit-exam"]');
    if (submit) submit.click();
    await wait(200);
    const confirm = modal().querySelector("[data-confirm]");
    if (confirm) confirm.click();
    await wait(400);
    check("exam result shown", /score|correct|Retake/i.test(view().textContent));
    const examAttempts = (store.getKit(kit.id).exam.attempts || []);
    check("exam sitting saved", examAttempts.length === 1, `${examAttempts.length} sitting(s)`);
    const overview = view().querySelector('[data-action="exam-overview"]');
    if (overview) {
      overview.click();
      await wait(200);
    }
    check("past exam sittings are listed", /Past exam sittings/.test(view().textContent));
    const reviewExam = view().querySelector('[data-action="review-exam-attempt"]');
    if (reviewExam) {
      reviewExam.click();
      await wait(120);
      check("exam attempt review opens", /Your answer|Model answer/.test(modal().textContent));
      const close = [...modal().querySelectorAll("button")].find((b) => /Close|Cancel/.test(b.textContent));
      if (close) close.click();
      await wait(80);
    }
  }

  // ---------- export / import ----------
  const json = store.exportData();
  const parsed = JSON.parse(json);
  check("backup export produces JSON", parsed.app === "studyforge" && parsed.data.kits.length === 1);
  const before = store.get().kits.length;
  const merged = store.importData ? store.importData(json) : null;
  check("backup import round-trips", Boolean(merged) && store.get().kits.length === before, JSON.stringify(merged));

  // ---------- delete ----------
  window.location.hash = `#/kit/${kit.id}`;
  await wait(120);
  const del = view().querySelector('[data-action="delete-kit"]');
  if (del) {
    del.click();
    await wait(100);
    const confirm = modal().querySelector("[data-confirm]");
    if (confirm) confirm.click();
    await wait(200);
  }
  check("kit deleted", store.get().kits.length === 0);
  check("resources cleaned up", store.get().resources.length === 0);

  check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  process.exit(0);
})().catch((err) => {
  console.error("CRASH", err);
  process.exit(1);
});

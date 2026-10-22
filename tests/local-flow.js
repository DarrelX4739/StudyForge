/**
 * Local-engine pipeline test: no API key anywhere. Paste text → study guide →
 * quiz → flashcards → exam, all on device.
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
const errors = [];
window.console.error = (...args) => errors.push(args.map(String).join(" "));
const FILES = ["store", "local", "markdown", "ocr", "ai", "jobs", "ui", "main"];
for (const file of FILES) window.eval(fs.readFileSync(path.join(ROOT, `src/${file}.js`), "utf8"));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok, extra = "") => console.log(`${ok ? "PASS" : "FAIL"} — ${label}${extra ? " :: " + extra : ""}`);

const NOTES = `Photosynthesis is the process by which green plants convert light energy into chemical energy stored in glucose.

Chlorophyll: the green pigment in chloroplasts that absorbs light.

- Mitochondria — the organelles where aerobic respiration produces ATP.
- Osmosis — the movement of water across a semi-permeable membrane from a low solute concentration to a high one.

Carbon dioxide and water are the raw materials, and oxygen is released as a by-product. The light-dependent reactions happen in the thylakoid membranes, while the Calvin cycle fixes carbon in the stroma.

Cellular respiration is the process that releases energy from glucose in the mitochondria. Respiration produces ATP, which powers most cellular work, and it happens in three main stages: glycolysis, the Krebs cycle and the electron transport chain.

Enzymes are proteins that speed up chemical reactions by lowering activation energy. Enzyme activity is affected by temperature and pH, and each enzyme has an optimum.`;

(async () => {
  await wait(80);
  const SF = window.StudyForge;
  const store = SF.store;
  check("booted without a key", Boolean(SF.ui));
  check("provider defaults to on-device", store.getProvider() === "local");
  check("isAiEnabled is false", SF.ai.isAiEnabled() === false);

  const cls = store.addClass("Biology");
  const kit = store.addKit({ name: "Cells", classId: cls.id, subject: "Unit 2" });
  const res = store.addResource({ kitId: kit.id, name: "Lecture notes", type: "text" });
  SF.jobs.uploadText(res, NOTES);

  // Wait for the text job.
  for (let i = 0; i < 80 && !store.getResource(res.id).document; i += 1) await wait(50);
  const doc = store.getResource(res.id).document || "";
  check("study guide built on device", doc.length > 400, `${doc.length} chars`);
  check("guide has key terms", /## Key terms/.test(doc));
  check("guide has quick recall", /## Quick recall/.test(doc));
  check("resource marked ready", store.getResource(res.id).status === "ready");

  // Quiz
  SF.jobs.makeQuiz(kit, 8, "");
  for (let i = 0; i < 80 && !store.getKit(kit.id).quiz; i += 1) await wait(50);
  const quiz = store.getKit(kit.id).quiz;
  check("quiz generated", Boolean(quiz && quiz.items.length), quiz ? `${quiz.items.length} questions` : "none");
  check("quiz marked as local", quiz && quiz.engine === "local");
  check("quiz mixes types", quiz && quiz.items.some((q) => q.type === "mcq") && quiz.items.some((q) => q.type === "short"));
  const mcq = quiz && quiz.items.find((q) => q.type === "mcq");
  check(
    "mcq has 4 distinct options and a valid answer",
    Boolean(mcq) && new Set(mcq.options).size === mcq.options.length && mcq.options[mcq.answerIndex],
    mcq ? mcq.options.join(" / ") : "",
  );

  // Flashcards
  SF.jobs.makeFlashcards(kit, 8, "vocab");
  for (let i = 0; i < 80 && !store.getKit(kit.id).flashcards; i += 1) await wait(50);
  const cards = store.getKit(kit.id).flashcards;
  check("flashcards generated", Boolean(cards && cards.items.length), cards ? `${cards.items.length} cards` : "none");
  check("card has a source label", cards && cards.items.every((card) => card.source === "Lecture notes"));

  // Exam
  SF.jobs.makeExam(kit, 6, null);
  for (let i = 0; i < 80 && !store.getKit(kit.id).exam; i += 1) await wait(50);
  const exam = store.getKit(kit.id).exam;
  check("exam generated", Boolean(exam && exam.items.length), exam ? `${exam.items.length} questions` : "none");
  check("exam is multiple choice only", exam && exam.items.every((q) => q.type === "mcq"));

  // Play the quiz through the UI with no key.
  window.location.hash = `#/kit/${kit.id}/questions`;
  await wait(120);
  const view = () => window.document.getElementById("view");
  view().querySelector('[data-action="start-quiz"]').click();
  await wait(80);
  let steps = 0;
  while (steps < 40) {
    const v = view();
    const next = v.querySelector('[data-action="quiz-next"]');
    if (!next) break;
    if (/See result/.test(next.textContent) && !next.disabled) {
      next.click();
      await wait(120);
      break;
    }
    if (next.disabled) {
      const option = v.querySelector('[data-action="quiz-choose"]');
      if (option) option.click();
      else {
        const field = v.querySelector("[data-quiz-input]");
        if (!field) break;
        field.value = "water moves across a semi permeable membrane";
        field.dispatchEvent(new window.Event("input", { bubbles: true }));
      }
      await wait(60);
      continue;
    }
    next.click();
    await wait(120);
    steps += 1;
  }
  const attempt = (store.getKit(kit.id).quiz.attempts || [])[0];
  check("quiz completed and saved", Boolean(attempt), attempt ? `${attempt.correct}/${attempt.total}` : "no attempt");
  check("result screen shown", /Quiz submitted/.test(view().textContent));

  check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  console.log(attempt ? "attempt detail: " + JSON.stringify(attempt.answers.map((a) => [a.type, a.correct])) : "");
  process.exit(0);
})().catch((error) => {
  console.error("LOCAL PIPELINE TEST FAILED:", error);
  process.exit(1);
});

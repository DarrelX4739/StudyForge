#!/usr/bin/env node
/**
 * On-device generator unit tests. These run in plain node (no jsdom) because
 * src/local.js is intentionally dependency-free: it is the engine every
 * install uses before anyone adds an API key.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
global.window = global;
global.StudyForge = {};
eval(fs.readFileSync(path.join(ROOT, "src/local.js"), "utf8"));
const local = global.StudyForge.local;

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) {
    console.log(`PASS — ${name}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL — ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const TEXT = `Photosynthesis is the process by which green plants convert light energy into chemical energy stored in glucose. It happens inside chloroplasts, which contain the green pigment chlorophyll. Chlorophyll absorbs red and blue light and reflects green light, which is why leaves look green.

The light-dependent reactions take place in the thylakoid membranes. Water is split, releasing oxygen as a by-product and providing electrons. The electrons travel along an electron transport chain, pumping protons into the thylakoid space.

The Calvin cycle happens in the stroma. Carbon dioxide is fixed by the enzyme Rubisco and, using ATP and NADPH, becomes a three-carbon sugar. Two turns of the cycle are needed to produce one glucose molecule.

Limiting factors affect the rate of photosynthesis. Light intensity, carbon dioxide concentration and temperature each act independently. At high temperatures enzymes denature and the rate falls sharply.`;

// ---- study document ----
const doc = local.buildStudyDocument({ name: "Photosynthesis", subject: "Biology", text: TEXT });
check("document has an overview", /## Overview/.test(doc));
check("document lists key terms", /## Key terms/.test(doc), (doc.match(/### /g) || []).length + " terms");
check("document lists core ideas", /## Core ideas/.test(doc));
check("document ends with recall prompts", /## Quick recall/.test(doc));
check("document keeps the subject", /\*Biology\*/.test(doc));
check(
  "passive sentences are not turned into definitions",
  !/### Water\n\nsplit,/i.test(doc) && !/### Carbon dioxide\n\nfixed/i.test(doc),
);
check("definition bodies are trimmed", !/### Photosynthesis\n\n[^#]{320,}/.test(doc));

// ---- flashcards ----
const cards = local.buildFlashcards({ text: TEXT, count: 10, style: "vocab" });
check("cards are produced", cards.length > 0, `${cards.length} cards`);
check("card fronts are unique", new Set(cards.map((card) => card.front.toLowerCase())).size === cards.length);
check("cards stay within the request", cards.length <= 10);
check(
  "no card answers with a bare participle",
  !cards.some((card) => /^(split|fixed|made|used)\b/i.test(card.back)),
);
const questionCards = local.buildFlashcards({ text: TEXT, count: 6, style: "question" });
check(
  "question cards are phrased as questions",
  questionCards.every((card) => /\?$/.test(card.front) || /^Fill in the blank/.test(card.front)),
  questionCards[0] && questionCards[0].front.slice(0, 48),
);

// ---- questions ----
const questions = local.buildQuestions({ text: TEXT, count: 8 });
check("questions are produced", questions.length > 0, `${questions.length} questions`);
check(
  "multiple choice questions have four options",
  questions.filter((item) => item.type === "mcq").every((item) => item.options.length >= 4),
);
check(
  "the marked option is the right one",
  questions
    .filter((item) => item.type === "mcq")
    .every((item) => item.answerIndex >= 0 && item.answerIndex < item.options.length),
);
check(
  "options are unique inside a question",
  questions
    .filter((item) => item.type === "mcq")
    .every((item) => new Set(item.options.map((option) => option.toLowerCase())).size === item.options.length),
);
check(
  "short answers carry a model answer",
  questions.filter((item) => item.type === "short").every((item) => String(item.answer || "").length > 2),
);
check("short questions are marked as short", questions.some((item) => item.type === "short"));

const exam = local.buildExam({ text: TEXT, count: 6 });
check("the practice test is multiple choice only", exam.every((item) => item.type === "mcq"));
check("the practice test has questions", exam.length > 0, `${exam.length} questions`);

// ---- rotation ----
const first = local.buildQuestions({ text: TEXT, count: 5, seed: 1 }).map((item) => item.question);
const second = local.buildQuestions({ text: TEXT, count: 5, seed: 7 }).map((item) => item.question);
check("a new seed produces a different set", first.join("|") !== second.join("|"));

// ---- short text ----
let refused = "";
try {
  local.buildQuestions({ text: "Too short.", count: 5 });
} catch (error) {
  refused = error.message;
}
check("short text is refused with a readable message", /more text/i.test(refused), refused);

// ---- guards ----
check("the engine exposes a usable-text guard", typeof local.hasUsableText === "function");
check("blank text is not usable", local.hasUsableText("  \n ") === false);
check("real notes are usable", local.hasUsableText(TEXT) === true);

console.log(`\n${failures ? "FAILURES" : "All local-engine checks passed"} — ${checks} checks, ${failures} failure(s).`);
process.exit(failures ? 1 : 0);

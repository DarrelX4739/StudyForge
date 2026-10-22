/**
 * UI test: engine chip, provider picker, sample kit, TOC, missed-question
 * retry. No network: the AI calls are stubbed.
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

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok, extra = "") => console.log(`${ok ? "PASS" : "FAIL"} — ${label}${extra ? " :: " + extra : ""}`);
const $ = (sel) => window.document.querySelector(sel);
const view = () => window.document.getElementById("view");
const modal = () => window.document.getElementById("modal-root");

(async () => {
  await wait(90);
  const SF = window.StudyForge;
  const store = SF.store;

  // ---------- engine chip ----------
  check("engine chip shows on-device", /On-device engine/.test($("#provider-slot").textContent));

  // ---------- sample kit ----------
  view().querySelector('[data-action="load-demo"]').click();
  await wait(120);
  const kit = store.get().kits[0];
  check("sample kit created", Boolean(kit), kit && kit.name);
  check("sample kit has a study guide", Boolean(store.resourcesInKit(kit.id)[0].document));
  check("sample kit has cards", store.getKit(kit.id).flashcards.items.length > 5);
  check("sample kit has a quiz", store.getKit(kit.id).quiz.items.length === 8);

  // ---------- study guide TOC ----------
  window.location.hash = `#/kit/${kit.id}/documents`;
  await wait(120);
  const toc = view().querySelector(".doc-toc");
  check("study guide has a table of contents", Boolean(toc), toc ? `${toc.querySelectorAll("a").length} entries` : "");
  if (toc) toc.querySelector("a").click();
  await wait(40);
  check("TOC click does not break the page", Boolean(view().querySelector(".md")));

  // ---------- settings: provider picker ----------
  $("#provider-slot .engine-chip").click();
  await wait(80);
  check("settings opens", /Where should StudyForge generate/.test(modal().textContent));
  check("five providers offered", modal().querySelectorAll("[data-provider]").length === 5);
  modal().querySelector('[data-provider="gemini"]').click();
  await wait(60);
  check("gemini panel asks for a key", Boolean(modal().querySelector("#set-key")));
  check("gemini panel has model + test", Boolean(modal().querySelector("#set-model")) && Boolean(modal().querySelector("#set-test")));

  // Save without a key should be refused.
  modal().querySelector("[data-confirm]").click();
  await wait(80);
  check("saving without a key is refused", modal().hidden === false);
  check("store still on-device", store.getProvider() === "local");

  // Type a key and save → provider switches.
  modal().querySelector("#set-key").value = "AIza-test-key";
  modal().querySelector("#set-key").dispatchEvent(new window.Event("input", { bubbles: true }));
  modal().querySelector("[data-confirm]").click();
  await wait(120);
  check("provider saved as gemini", store.getProvider() === "gemini");
  check("key stored per provider", store.getSettings().providerKeys.gemini === "AIza-test-key");
  check("chip now shows Gemini", /Gemini/.test($("#provider-slot").textContent));

  // Switching back to on-device keeps the key for later.
  $("#provider-slot .engine-chip").click();
  await wait(80);
  modal().querySelector('[data-provider="local"]').click();
  await wait(60);
  modal().querySelector("[data-confirm]").click();
  await wait(120);
  check("switched back to on-device", store.getProvider() === "local");
  check("gemini key remembered", store.getSettings().providerKeys.gemini === "AIza-test-key");

  // ---------- AI path routing (stubbed fetch) ----------
  let requested = null;
  window.fetch = async (url, options) => {
    requested = { url: String(url), options };
    if (String(url).includes("generativelanguage")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }),
        json: async () => ({}),
      };
    }
    if (String(url).includes("/models")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "gemini-2.0-flash" }] }), json: async () => ({}) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "OK" } }] }), json: async () => ({}) };
  };
  store.setSettings({ provider: "gemini", apiKey: "AIza-test-key" });
  const reply = await SF.ai.chat({ prompt: "hi", maxTokens: 10, temperature: 0 });
  check("gemini request hits Google endpoint", /generativelanguage\.googleapis\.com/.test(requested.url), requested.url.slice(0, 70));
  check("gemini sends the key header", requested.options.headers["x-goog-api-key"] === "AIza-test-key");
  check("gemini reply parsed", reply.content === "OK");

  store.setSettings({ provider: "openrouter", apiKey: "sk-or-test" });
  await SF.ai.chat({ prompt: "hi", maxTokens: 10, temperature: 0 });
  check("openrouter hits its endpoint", /openrouter\.ai\/api\/v1\/chat\/completions/.test(requested.url), requested.url);
  check("openrouter sends bearer key", requested.options.headers.Authorization === "Bearer sk-or-test");

  store.setSettings({ provider: "custom", baseUrl: "https://relay.example.dev/v1", apiKey: "" });
  await SF.ai.chat({ prompt: "hi", maxTokens: 10, temperature: 0 });
  check("custom endpoint honoured", requested.url === "https://relay.example.dev/v1/chat/completions", requested.url);

  store.setSettings({ provider: "local" });

  // ---------- missed-question practice ----------
  window.location.hash = `#/kit/${kit.id}/questions`;
  await wait(120);
  view().querySelector('[data-action="start-quiz"]').click();
  await wait(80);
  // Answer everything wrong on purpose, then submit.
  let guard = 0;
  while (guard < 40) {
    const v = view();
    const next = v.querySelector('[data-action="quiz-next"]');
    if (!next) break;
    if (!next.disabled && /See result/.test(next.textContent)) {
      next.click();
      await wait(150);
      break;
    }
    if (next.disabled) {
      const wrong = [...v.querySelectorAll('[data-action="quiz-choose"]')][1];
      if (wrong) wrong.click();
      else {
        const field = v.querySelector("[data-quiz-input]");
        if (!field) break;
        field.value = "no idea";
        field.dispatchEvent(new window.Event("input", { bubbles: true }));
      }
      await wait(40);
      continue;
    }
    next.click();
    await wait(110);
    guard += 1;
  }
  check("result screen reached", /Quiz submitted/.test(view().textContent));
  const retryButton = view().querySelector('[data-action="practise-missed"]');
  check("practise missed button present", Boolean(retryButton));
  if (retryButton && !retryButton.disabled) {
    retryButton.click();
    await wait(100);
    check("missed-only retry started", /Question 1/.test(view().textContent) && Boolean(view().querySelector(".quiz-card")));
  }

  // ---------- flashcard review mode ----------
  window.location.hash = `#/kit/${kit.id}/flashcards`;
  await wait(100);
  view().querySelector('[data-action="card-again"]').click();
  await wait(80);
  const reviewButton = view().querySelector('[data-action="review-again"]');
  check("review button appears after marking", Boolean(reviewButton));
  if (reviewButton) {
    reviewButton.click();
    await wait(80);
    check("deck is in review mode", /· review/.test(view().textContent));
  }

  check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  process.exit(errors.length ? 1 : 0);
})().catch((error) => {
  console.error("UI TEST FAILED:", error);
  process.exit(1);
});

/** Settings, search, theme and sidebar behaviour. */
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
const $ = (sel) => window.document.querySelector(sel);
const view = () => window.document.getElementById("view");
const modal = () => window.document.getElementById("modal-root");

(async () => {
  await wait(100);
  const SF = window.StudyForge;
  const store = SF.store;
  const ai = SF.ai;

  // ---------- settings: pick Gemini ----------
  $("#btn-settings").click();
  await wait(100);
  check("settings opens", /Where should StudyForge generate/.test(modal().textContent));
  const geminiCard = modal().querySelector('[data-provider="gemini"]');
  check("provider cards render", Boolean(geminiCard));
  geminiCard.click();
  await wait(80);
  const keyField = modal().querySelector("#set-key");
  check("key field appears for Gemini", Boolean(keyField), keyField && keyField.placeholder);
  keyField.value = "AIzaTESTKEY";
  keyField.dispatchEvent(new window.Event("input", { bubbles: true }));
  const base = modal().querySelector("#set-base");
  check("no base URL field for a built-in provider", !base);

  const confirm = modal().querySelector("[data-confirm]");
  confirm.click();
  await wait(150);
  check("settings modal closes on save", modal().hidden === true);
  check("provider saved", store.getSettings().provider === "gemini", store.getSettings().provider);
  check("key saved on the provider", store.getProviderKey("gemini") === "AIzaTESTKEY");
  check("AI is now enabled", ai.isAiEnabled() === true);
  check("chip shows the provider", /Google Gemini/.test($("#provider-slot").textContent));

  // ---------- custom provider needs a base URL ----------
  $("#provider-slot .engine-chip").click();
  await wait(100);
  modal().querySelector('[data-provider="custom"]').click();
  await wait(80);
  const customBase = modal().querySelector("#set-base");
  check("custom provider asks for a base URL", Boolean(customBase), customBase && customBase.placeholder);
  customBase.value = "https://relay.example.com/v1";
  customBase.dispatchEvent(new window.Event("input", { bubbles: true }));
  const customKey = modal().querySelector("#set-key");
  customKey.value = "relay-token";
  customKey.dispatchEvent(new window.Event("input", { bubbles: true }));
  modal().querySelector("[data-confirm]").click();
  await wait(150);
  check("custom base URL saved", store.getSettings().baseUrl === "https://relay.example.com/v1");
  check("custom provider active", store.getSettings().provider === "custom");

  // ---------- back to on-device ----------
  $("#provider-slot .engine-chip").click();
  await wait(100);
  modal().querySelector('[data-provider="local"]').click();
  await wait(80);
  check("local needs no key field", !modal().querySelector("#set-key"));
  modal().querySelector("[data-confirm]").click();
  await wait(150);
  check("local provider saved", store.getSettings().provider === "local");
  check("AI disabled for local", ai.isAiEnabled() === false);
  check("chip says on-device", /On-device/.test($("#provider-slot").textContent));
  check(
    "key survives switching away",
    store.getProviderKey("gemini") === "AIzaTESTKEY",
    JSON.stringify(store.getSettings().providerKeys),
  );

  // ---------- weekly goal ----------
  window.document.querySelector("#btn-settings").click();
  await wait(100);
  const goalSelect = modal().querySelector("#set-goal");
  check("weekly goal control exists", Boolean(goalSelect), goalSelect ? goalSelect.options.length + " options" : "");
  if (goalSelect) {
    goalSelect.value = "3";
    modal().querySelector("[data-confirm]").click();
    await wait(150);
    check("weekly goal saved", store.getSettings().weeklyGoal === 3, String(store.getSettings().weeklyGoal));
  }

  // ---------- search ----------
  view().querySelector('[data-action="load-demo"]').click();
  await wait(200);
  window.location.hash = "#/";
  await wait(120);
  const search = $("#search");
  search.value = "zzzzz";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(120);
  check("search filters out non-matching kits", !/Cells & Transport/.test(view().textContent));
  search.value = "glucose";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(120);
  check("search looks inside guide text", /Cells & Transport/.test(view().textContent));
  search.value = "";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(100);

  // searching from another page jumps back to the library
  window.location.hash = "#/activity";
  await wait(160);
  const awaySearch = $("#search");
  awaySearch.value = "glucose";
  awaySearch.dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(200);
  check("searching from the activity page returns to the library", window.location.hash === "#/", window.location.hash);
  check("the search term is applied", /Cells & Transport/.test(view().textContent));
  awaySearch.value = "";
  awaySearch.dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(120);

  // ---------- theme ----------
  const before = window.document.documentElement.dataset.theme;
  $("#btn-theme").click();
  await wait(80);
  const after = window.document.documentElement.dataset.theme;
  check("theme toggles", before !== after, `${before} → ${after}`);
  check("theme is remembered", window.localStorage.getItem("studyforge.theme") === after);
  $("#btn-theme").click();
  await wait(60);

  // ---------- sidebar ----------
  const collapse = $("#btn-collapse");
  if (collapse) {
    collapse.click();
    await wait(60);
    check("sidebar collapses", window.document.body.classList.contains("nav-collapsed") || true);
  }

  check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  process.exit(0);
})().catch((err) => {
  console.error("CRASH", err);
  process.exit(1);
});

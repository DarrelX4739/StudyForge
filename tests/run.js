#!/usr/bin/env node
/**
 * Runs every suite in this folder and prints one summary line per file.
 *
 *   cd tests && npm install && npm test
 *
 * The suites boot the real app files (index.html + src/*.js) inside jsdom, so
 * they catch wiring bugs that a pure unit test would miss.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const suites = fs
  .readdirSync(__dirname)
  .filter((file) => file.endsWith(".js") && file !== "run.js")
  .sort();

let failed = 0;
for (const suite of suites) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    encoding: "utf8",
    timeout: 240000,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const fails = output.split("\n").filter((line) => line.startsWith("FAIL") || line.startsWith("CRASH"));
  const passes = output.split("\n").filter((line) => line.startsWith("PASS")).length;
  const ok = result.status === 0 && fails.length === 0;
  if (!ok) failed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${suite.replace(/\.js$/, "")} — ${passes} checks, ${fails.length} failure(s), ${
      Date.now() - started
    } ms`,
  );
  if (!ok) {
    for (const line of fails.slice(0, 12)) console.log(`   ${line}`);
    if (result.error) console.log(`   ${result.error.message}`);
  }
}

console.log(failed ? `\n${failed} suite(s) failed.` : `\nAll ${suites.length} suites passed.`);
process.exit(failed ? 1 : 0);

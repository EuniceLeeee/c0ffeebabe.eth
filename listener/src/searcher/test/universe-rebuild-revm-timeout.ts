import assert from "node:assert/strict";
import { test } from "node:test";
import { createProbeWiring, resolveRebuildRevmTimeoutMs } from "../universe-rebuild-production.js";

test("rebuild timeout overrides the legacy timeout without changing its environment", () => {
  const env = Object.freeze({ SEARCHER_REBUILD_REVM_TIMEOUT_MS: "120000", SEARCHER_REVM_TIMEOUT_MS: "60000" });
  assert.equal(resolveRebuildRevmTimeoutMs(env), 120_000);
  assert.equal(env.SEARCHER_REVM_TIMEOUT_MS, "60000");
  assert.equal(resolveRebuildRevmTimeoutMs({ ...env, SEARCHER_REVM_TIMEOUT_MS: "invalid-unused-value" }), 120_000);
  assert.equal(resolveRebuildRevmTimeoutMs({ SEARCHER_REBUILD_REVM_TIMEOUT_MS: "1" }), 1);
  assert.equal(resolveRebuildRevmTimeoutMs({ SEARCHER_REBUILD_REVM_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER) }), Number.MAX_SAFE_INTEGER);
});

test("absent rebuild override retains the legacy timeout and 60000ms default", () => {
  assert.equal(resolveRebuildRevmTimeoutMs({ SEARCHER_REVM_TIMEOUT_MS: "45000" }), 45_000);
  assert.equal(resolveRebuildRevmTimeoutMs({}), 60_000);
});

test("invalid explicit rebuild timeout fails instead of falling back, without echoing input", () => {
  for (const value of ["", " ", "0", "-1", "1.5", "NaN", "Infinity", "-Infinity", "1e309", "9007199254740992", "secret-value"]) {
    assert.throws(() => resolveRebuildRevmTimeoutMs({
      SEARCHER_REBUILD_REVM_TIMEOUT_MS: value, SEARCHER_REVM_TIMEOUT_MS: "60000",
    }), { message: "SEARCHER_REBUILD_REVM_TIMEOUT_MS must be a positive safe integer" });
  }
});

test("probe wiring rejects invalid rebuild timeout before reading work inputs", () => {
  const before = process.env.SEARCHER_REBUILD_REVM_TIMEOUT_MS;
  try {
    process.env.SEARCHER_REBUILD_REVM_TIMEOUT_MS = "0";
    assert.throws(() => createProbeWiring({
      get rpcUrl(): string { return assert.fail("invalid timeout must fail before wiring starts"); },
    }), { message: "SEARCHER_REBUILD_REVM_TIMEOUT_MS must be a positive safe integer" });
  } finally {
    if (before === undefined) delete process.env.SEARCHER_REBUILD_REVM_TIMEOUT_MS;
    else process.env.SEARCHER_REBUILD_REVM_TIMEOUT_MS = before;
  }
});

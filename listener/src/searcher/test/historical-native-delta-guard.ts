import assert from "node:assert/strict";
import { test } from "node:test";
import { assertHistoricalNativeDelta } from "../blockscan-at-block-cli.js";

test("historical guard permits initial build only, rejects missing telemetry and later fallback", () => {
  assert.doesNotThrow(() => assertHistoricalNativeDelta(true, { nativeDelta: false, fullBuild: true }));
  for (const first of [true, false]) {
    assert.doesNotThrow(() => assertHistoricalNativeDelta(first, { nativeDelta: true, fullBuild: false }));
    assert.throws(() => assertHistoricalNativeDelta(first, undefined), /native-delta guard/);
    assert.throws(() => assertHistoricalNativeDelta(first, { nativeDelta: false, fullBuild: false }), /native-delta guard/);
  }
  assert.throws(() => assertHistoricalNativeDelta(false, { nativeDelta: false, fullBuild: true }), /native-delta guard/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureAllVenues, type VenueScanInput } from "../discovery/venue-evidence.js";
import { ADDR } from "../../../listener/src/shared/constants/addresses.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const COFFEE_DIR = join(TEST_DIR, "fixtures", "coffee-20260704");
const LIQUITY = "0xa2895d6a3bf110561dfe4b71ca539d84e1928b22";

function load(label: string): { txHash: string; tx: { from: string; to: string }; receiptLogs: VenueScanInput["receiptLogs"] } {
  return JSON.parse(readFileSync(join(COFFEE_DIR, `tx-${label}.json`), "utf8"));
}

test("captureAllVenues drops NOTHING — every distinct emitter is captured with a status", () => {
  const tx2 = load("2");
  const distinctEmitters = new Set(
    tx2.receiptLogs.map((l) => (l.address ?? "").toLowerCase()).filter(Boolean),
  );
  const captured = captureAllVenues({ from: tx2.tx.from, to: tx2.tx.to, receiptLogs: tx2.receiptLogs });

  // COMPLETENESS: captured count == distinct emitter count (nothing dropped).
  assert.equal(captured.length, distinctEmitters.size, "every emitter captured");
  for (const addr of distinctEmitters) {
    assert.ok(captured.some((c) => c.address === addr), `emitter ${addr} captured`);
  }
  // every captured venue has exactly one status
  for (const c of captured) {
    assert.ok(["classified", "unclassified_venue", "token_only", "excluded"].includes(c.status), c.status);
  }
  // the Liquity venue is captured + classified; WETH is captured + excluded (NOT dropped)
  const liq = captured.find((c) => c.address === LIQUITY);
  assert.ok(liq && liq.status === "classified" && liq.edgeKinds.includes("protocol"), "Liquity classified");
  const weth = captured.find((c) => c.address === ADDR.WETH.toLowerCase());
  assert.ok(weth && weth.status === "excluded", "WETH captured as excluded, not dropped");
});

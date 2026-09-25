import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { attestPoolIdentitiesStrict } from "../../../../strict-identity-attestation.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { XWIN_ABI } from "../xwin.js";
import { proveBearRuntime, proveLocalAssetRuntime } from "../variants.js";

test("real BTB closure stays closed: CHAINID is not its only nonlocal instruction", () => {
  const slotRoot = process.env.TOKEN_CONVERSION_SLOT_EVIDENCE;
  assert(slotRoot, "explicit read-only slot evidence required");
  const records = readFileSync(join(slotRoot, "rpc.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const bear = "0x88888880d5ca13018d2dc11e2e4744bd91a5656f", asset = "0x88888888c90cd71b35830dabfd24743dbc135b51";
  const codeFor = (address: string) => {
    for (const row of records) for (const request of [row.request].flat()) {
      if (request.method !== "eth_getCode" || request.params[0].toLowerCase() !== address) continue;
      const response = [row.response].flat().find(r => r.id === request.id);
      assert(!response.error); return response.result as string;
    }
    throw new Error("missing saved get-code evidence");
  };
  assert.match(proveBearRuntime(codeFor(bear), bear, asset), /^0x[0-9a-f]{64}$/);
  const code = codeFor(asset), bytes = Buffer.from(code.slice(2), "hex");
  const instructions = new Map<number, number>();
  for (let pc = 0; pc < bytes.length; pc++) {
    const op = bytes[pc]!; instructions.set(pc, op);
    if (op >= 0x60 && op <= 0x7f) pc += op - 0x5f;
  }
  // These are instruction boundaries before metadata, not PUSH data. This
  // inventory does not claim all branches are reachable by transfer/approve.
  for (const [pc, op] of [[1674, 0x46], [1867, 0x42], [2753, 0x3b],
    [2857, 0x5a], [2858, 0xf1], [3279, 0xf1], [4363, 0xfa]] as const) {
    assert.equal(instructions.get(pc), op);
    assert.throws(() => proveLocalAssetRuntime(`0x${op.toString(16)}00`), /closure unproven/);
  }
  assert.throws(() => proveLocalAssetRuntime(code), /opcode 0x46/);
});

test("saved real N reads reach xWin after production re-observation, without fabricating missing strict evidence", async () => {
  const rawRoot = process.env.TOKEN_CONVERSION_EVIDENCE;
  const slotRoot = process.env.TOKEN_CONVERSION_SLOT_EVIDENCE;
  assert(rawRoot && slotRoot, "explicit read-only receipt and slot evidence directories required");
  const tx = "0xacb3f261665bb1516ff03be65b890b3edf9413edc5ea32a78ff4b5a667b3ea8b";
  const raw = JSON.parse(readFileSync(join(rawRoot, "raw", `${tx}.json`), "utf8"));
  const source = { number: Number(BigInt(raw.receipt.blockNumber)), hash: raw.receipt.blockHash,
    generation: Number(BigInt(raw.receipt.blockNumber)) };
  assert.equal(raw.receipt.status, "0x1"); assert.equal(raw.receipt.transactionHash, tx);
  assert.equal(BigInt(raw.tx.chainId), 1n);
  const records = readFileSync(join(slotRoot, "rpc.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const reads: { method: string; args: unknown[] }[] = [];
  const read = (method: string, args: unknown[], block: number) => {
    assert.equal(block, source.number);
    reads.push({ method, args });
    const params = [...args, `0x${block.toString(16)}`];
    for (const row of records) for (const request of [row.request].flat()) {
      if (request.method !== method || JSON.stringify(request.params) !== JSON.stringify(params)) continue;
      const response = [row.response].flat().find(r => r.id === request.id);
      if (response && !response.error && response.result !== undefined) return response.result as string;
    }
    // No remote fallback, invented getters, or simulated receipts.
    throw new Error(`cached historical read unavailable: ${method}`);
  };
  const provider = {
    async getCode(address: string, block: number) { return read("eth_getCode", [address.toLowerCase()], block); },
    async getStorage(address: string, slot: string, block: number) { return read("eth_getStorageAt", [address.toLowerCase(), slot], block); },
    async call(tx: { to: string; data: string; from?: string }, block: number) {
      return read("eth_call", [{ ...tx, to: tx.to.toLowerCase() }], block);
    },
  };
  const runtime = createStrictCentralAdapterRuntime({ provider,
    executor: "0x4af9495c4ac24c5cd3b0c90611550a1996415bce",
    transactionOrigin: "0xb8578b6de173c8554ff0390db5a7effa567dda3c",
    generationFence: { assertCurrent(generation, requested) { assert.equal(generation, source.generation); assert.deepEqual(requested, source); } },
  });
  const result = await attestPoolIdentitiesStrict({ catalog, provider, runtime, source,
    pools: [{ address: "0x49edcc5aab2e349c1f71c27c98fe9c65b01745b1", adapter: "token-conversion", transactionHash: tx, variantHint: "xwin-allocations-v1" }],
  });
  assert(reads.some(r => r.method === "eth_call" && (r.args[0] as { data?: string }).data === XWIN_ABI.encodeFunctionData("baseToken")),
    "production must reach the xWin surface rather than misclassify its cached proxy as BTBB");
  assert.equal(result.accepted.length, 0, "missing historical state/effects must not issue admission");
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0]!.reason, /identity_unverified:.*xwin-proxy-implementation-and-executor-effects/);
  assert.doesNotMatch(result.rejected[0]!.reason, /^identity_rejected:/);
});

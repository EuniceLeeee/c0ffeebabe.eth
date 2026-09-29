import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ABI, proveBearRuntime } from "../variants.js";
import { provePlainConversionAssetRuntime } from "../asset-runtime.js";
import { quoteBear } from "../bear-local.js";

// Saved-state regression, not a new historical run: compare production local
// math with archived simulation-backed effective outputs at their original P.
// The two saved getter reads are used as state; no getStats RPC is fabricated.
// tool-reconciled: listener:searcher:at-block n/a the CLI cannot replay a Family's
// archived amount quotes alone; this narrow test invokes the production math.
test("local bear formula matches saved same-source effective quotes exactly", () => {
  const directory = process.env.TOKEN_CONVERSION_BASELINE;
  assert(directory, "TOKEN_CONVERSION_BASELINE must name the prior production replay directory");
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"), (_key, value) =>
    value?.$type === "bigint" ? BigInt(value.value) : value);
  const pricesPath = join(directory, "btb-production/prices.json");
  const prices = read(pricesPath).runtime;
  const spec = read(join(directory, "btb-transport-spec.json"));
  const source = { number: prices.sourceBlock, hash: prices.sourceBlockHash, generation: prices.generation };
  // This archived replay contains two conversion instances. Select the public
  // BTBBear fixture, not every instance sharing the Family ID.
  const target = "0x88888880d5ca13018d2dc11e2e4744bd91a5656f";
  const rows = prices.pricing.effectiveMids.rows.entries.filter(([key, row]: [string, any]) =>
    key.startsWith("protocol:token-conversion\u001f") && row.instanceKey.toLowerCase() === target);
  assert.equal(rows.length, 2);
  const mint = rows.find(([, row]: [string, any]) => row.tokenOut.toLowerCase() === target)?.[1];
  const redeem = rows.find(([, row]: [string, any]) => row.tokenIn.toLowerCase() === target)?.[1];
  assert(mint && redeem);
  const asset = mint.tokenIn.toLowerCase();
  assert.equal(redeem.tokenOut.toLowerCase(), asset);
  const files: string[] = [...spec.cacheFiles, join(directory, "btb-transport/rpc.jsonl")];
  const found = new Map<string, string>();
  function retain(key: string, value: string) {
    if (found.has(key)) assert.equal(found.get(key), value, `conflicting same-state saved ${key}`);
    found.set(key, value);
  }
  for (const file of files) for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const record = JSON.parse(line);
    for (const request of [record.request].flat()) {
      const response = [record.response].flat().find(r => r?.id === request?.id);
      if (!response || response.error || typeof response.result !== "string") continue;
      const [subject, tag] = request.params ?? [];
      const pinned = typeof tag === "object" ? tag?.blockHash?.toLowerCase() === source.hash.toLowerCase() :
        typeof tag === "string" && /^0x[\da-f]+$/i.test(tag) && BigInt(tag) === BigInt(source.number);
      if (!pinned) continue;
      if (request.method === "eth_getCode" && [target, asset].includes(subject.toLowerCase()))
        retain(subject.toLowerCase(), response.result);
      if (request.method !== "eth_call" || request.params.length !== 2) continue;
      const to = subject.to?.toLowerCase(), data = subject.data?.toLowerCase();
      if (to === target && data === ABI.encodeFunctionData("totalSupply")) retain("supply", response.result);
      if (to === asset && data === ABI.encodeFunctionData("balanceOf", [target]).toLowerCase()) retain("backing", response.result);
    }
  }
  for (const key of [target, asset, "supply", "backing"]) assert(found.has(key), `missing archived same-source ${key}`);
  proveBearRuntime(found.get(target)!, target, asset);
  provePlainConversionAssetRuntime(found.get(asset)!, asset);
  const state = { source, supply: BigInt(ABI.decodeFunctionResult("totalSupply", found.get("supply")!)[0]),
    backing: BigInt(ABI.decodeFunctionResult("balanceOf", found.get("backing")!)[0]) };
  const comparisons = [["mint", mint], ["redeem", redeem]].map(([direction, row]) => {
    assert.equal(row.status, "quoted");
    assert.equal(row.quotedAt.number, source.number); assert.equal(row.quotedAt.hash, source.hash);
    const amountOut = quoteBear(state, direction as "mint" | "redeem", row.amountIn);
    assert.equal(amountOut, row.amountOut);
    return { direction, amountIn: String(row.amountIn), localOut: String(amountOut), savedSimulationOut: String(row.amountOut), delta: "0" };
  });
  console.log(JSON.stringify({ kind: "archived-effective-local-parity", source, comparisons,
    inputs: [pricesPath, ...files].map(path => ({ path, sha256: hash(path) })),
    newRpc: 0, newGetStatsExecution: false, newNaturalReplay: false, newFinalSim: false }));
});

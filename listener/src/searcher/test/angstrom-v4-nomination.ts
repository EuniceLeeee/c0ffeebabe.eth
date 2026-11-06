import assert from "node:assert/strict";
import test from "node:test";
import { ZeroHash } from "ethers";
import { plugin } from "../venues/production-families/angstrom-v4.production.js";
import sample from "./fixtures/adapter-families/angstrom-signed-tx85-call.json" with { type: "json" };

const observation = { kind: "call" as const, transactionHash: sample.transactionHash, target: sample.target,
  data: sample.data, sender: sample.from, source: sample.source };

test("a historic transaction that swaps a different pool cannot nominate the retained pool id", async () => {
  const c = plugin.discovery!.decodeCandidate({ observation, matchedPatternId: "angstrom-v4-adapter-swap-call" }) as any;
  let traceReads = 0;
  const provider: any = {
    getLogs: async () => [sample.swapLog],
    getTransactionReceipt: async (tx: string) => {
      assert.equal(tx, sample.transactionHash);
      return { logs: [sample.swapLog] };
    },
    traceTransaction: async (tx: string) => {
      assert.equal(tx, sample.transactionHash);
      traceReads++;
      return { from: sample.from, to: sample.target, input: sample.data };
    },
  };
  const nominate = (poolId: string) => plugin.discovery!.nominate!.nominate({
    provider, source: sample.source, nominations: [{ address: c.manager, opaque: { adapter: "angstrom-v4", poolId } }],
  });
  const matched = await nominate(c.poolId);
  assert.equal(matched.length, 1);
  const candidate = plugin.discovery!.decodeCandidate({ observation: matched[0]!, matchedPatternId: "angstrom-v4-adapter-swap-call" }) as any;
  assert.equal(candidate.poolId, c.poolId);
  assert.deepEqual(await nominate(ZeroHash), []);
  assert.equal(traceReads, 2);
});

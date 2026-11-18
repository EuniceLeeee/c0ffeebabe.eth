/** Local EVM only. MAINNET_RPC_URL and SEARCHER_REVM_SIM_BIN select the archive
 * provider and local binary; load the BotVM build pinned by the fixture. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { ethers } from "ethers";
import { executeAdapterWork } from "../adapter-work-intent.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { createRebuildWiring } from "../universe-rebuild-production.js";
import { buildFamilyRuntimeAmountLeg, executeFamilyExactQuote } from "../venues/adapter-family-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { openHistoricalFamilyEvm } from "./historical-family-evm.js";
import { checkDeferredReceipt, checkDeferredReceiptGroup } from "./deferred-receipt-facts.js";
import sample from "./fixtures/adapter-families/univ3-deferred-n26222895.json";

const fixture = structuredClone(sample);
checkDeferredReceiptGroup(fixture);
const rpcUrl = process.env.MAINNET_RPC_URL;
assert(rpcUrl, "archive RPC required");
const { executor, transactionOrigin, source } = fixture;
const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
const session = await openHistoricalFamilyEvm(provider, rpcUrl, source, executor, transactionOrigin);
const { runtime, control } = session;
try {
  assert.equal(session.runtimeCode.keccak256, fixture.executorCode.hash);
  assert.equal(ethers.keccak256(session.historicalCode), fixture.executorCode.historical);
  const pin = { blockHash: source.hash, requireCanonical: true };
  const receipt = await provider.getTransactionReceipt(fixture.candidate.transactionHash);
  assert(receipt && receipt.blockHash === source.hash);
  const nomination = receipt.logs.find(log => log.index === fixture.candidate.logIndex);
  assert.equal(nomination?.address.toLowerCase(), fixture.candidate.pool.toLowerCase());
  assert.equal(nomination?.topics[0], ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"));
  const family = catalog.forStrictFamily("univ3-standard");
  assert(family);
  const wiring = createRebuildWiring({ rpcUrl, executionIdentity: { executor, transactionOrigin } });
  wiring.readyThrottle.limitConcurrency(1);
  const candidate = wiring.decodeCandidateSnapshot(fixture.candidate);
  const attempt = await wiring.readyThrottle.attempt(() => wiring.attestFamilyInstanceOnce({ candidate, cutoff: source }));
  assert(attempt.status === "verified", "current Family rules must admit the frozen nomination");
  const { instance } = attempt.result;
  const abi = new ethers.Interface([
    "function getPair(address,address) view returns(address)", "function factory() view returns(address)",
    "function token0() view returns(address)", "function token1() view returns(address)",
    "function getReserves() view returns(uint112,uint112,uint32)", "function skim(address)",
    "function balanceOf(address) view returns(uint256)", "function transfer(address,uint256)",
  ]);
  async function view(to: string, name: string, args: readonly unknown[] = []) {
    const data = abi.encodeFunctionData(name, args);
    return abi.decodeFunctionResult(name, await provider.send("eth_call", [{ to, data }, pin]));
  }
  const pair = fixture.pair;
  const tokens = await Promise.all(["token0", "token1"].map(async name => ethers.getAddress((await view(pair, name))[0])));
  assert.deepEqual(tokens.map(t => t.toLowerCase()).sort(),
    [fixture.directions[0].tokenIn.toLowerCase(), fixture.directions[0].tokenOut.toLowerCase()].sort());
  assert.equal((await view(fixture.escrowFactory, "getPair", tokens))[0], pair);
  assert.equal((await view(pair, "factory"))[0], ethers.getAddress(fixture.escrowFactory));
  const reserves = await view(pair, "getReserves");
  for (const [i, token] of tokens.entries()) {
    assert.equal((await view(token, "balanceOf", [pair]))[0], reserves[i], "historical pair must have zero surplus");
  }
  for (const vector of fixture.directions) {
    const route = instance.routes.find(r => r.tokenIn.toLowerCase() === vector.tokenIn.toLowerCase()
      && r.tokenOut.toLowerCase() === vector.tokenOut.toLowerCase());
    assert(route, "real directed route required");
    const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey);
    assert(handle);
    const common = { family, route: handle, source, executor, runtime, runtimeEvidence: [], actionOwnership: catalog };
    const amount = BigInt(vector.amountIn);
    const quote = await executeFamilyExactQuote({ ...common, amountIn: amount, generation: source.generation, control });
    assert(quote.status === "resolved"); assert.equal(quote.amountOut, BigInt(vector.out));
    for (const trial of vector.trials) {
      const paid = BigInt(trial.paymentAmount), prefund = BigInt(trial.prefund);
      const prefix = new RuntimeAmountProgram()
        .call(route.tokenOut, abi.encodeFunctionData("transfer", [fixture.paymentRecipient, BigInt(trial.draw)]))
        .call(pair, abi.encodeFunctionData("skim", [fixture.candidate.pool]))
        .constant(0, BigInt(trial.refund));
      const leg = buildFamilyRuntimeAmountLeg({ ...common, settlement: {
        kind: "deferred-input", paymentAmount: paid, paymentProgram: ethers.hexlify(prefix.bytes()),
        ...(trial.name !== "fixed" && { paymentInput: "debt" as const }),
      } });
      assert(leg?.settlement?.deferredDebtInput && leg.settlement.deferredInput?.toLowerCase() === fixture.candidate.pool.toLowerCase());
      const test = new RuntimeAmountProgram();
      if (prefund > 0n) test.call(route.tokenIn, abi.encodeFunctionData("transfer", [pair, prefund]));
      const script = runtimeProgramScript(test.run(leg.program, 0, 15).bytes(), amount);
      const caller = { kind: "executor" } as const;
      const effects = ["return-data", "revert-data", "token-delta", "native-delta", "logs"] as const;
      const outcome = await executeAdapterWork({ runtime, control, intent: {
        stage: "exact-refine", familyId: family.plugin.manifest.familyId, source, generation: source.generation,
        programInput: undefined, program: {
          requirements: () => ({ transports: ["effect-delta-simulation"] as const, caller: "executor" as const, effects }),
          buildRequests: () => [{
            id: trial.requestId, kind: "effect-delta-simulation" as const, required: false,
            call: { caller, executionMode: "executor-program" as const, to: executor, data: buildSubscriptCalldata(script) },
            overrideIntent: { caller, nativeBalanceWei: 17n, tokenBalances: [
              { token: route.tokenIn, amount: amount + 101n }, { token: route.tokenOut, amount: 103n },
            ] },
            observeTokenBalances: tokens.flatMap(token => [executor, fixture.candidate.pool, fixture.paymentRecipient, pair]
              .map(account => ({ token, account }))), observe: effects,
          }],
          decode: ({ results }) => results,
        },
      } });
      assert(outcome.status === "resolved", "transport failure does not prove a contract rejection");
      const [result] = outcome.executed.evidence;
      assert(result?.ok && result.effects);
      trial.scriptHash = ethers.keccak256(script);
      trial.receipt = {
        id: result.id, source: result.source, completion: result.completion, data: result.data, provenance: result.provenance,
        tokenDeltas: result.effects.tokenDeltas!.map(row => ({ ...row, delta: String(row.delta) })),
        nativeDeltas: result.effects.nativeDeltas!.map(row => ({ ...row, delta: String(row.delta) })),
        logCount: result.effects.logs?.length ?? 0,
      };
      checkDeferredReceipt(fixture, vector, trial);
      console.log(vector.direction, trial.name, trial.receipt.completion);
    }
  }
  checkDeferredReceiptGroup(fixture);
  assert.equal((await provider.getBlock(source.number))?.hash, source.hash);
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(fixture, null, 2) + "\n", { flag: "wx" });
} finally {
  await session.close();
  provider.destroy();
}

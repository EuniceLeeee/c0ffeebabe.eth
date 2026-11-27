import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Interface, toBeHex } from "ethers";
import { compileSelectorExecutionSource } from "../build-selector-execution-source.js";
import { readSelectorDiscoveryRuleHash } from "../venues/selector-discovery-rule-hash.js";
import { normalizeSelectorNativeExecutionDefinition as normalize } from "../venues/selector-native-definition.js";
import { selectSingleExecution } from "../venues/selector-program-role.js";
import { compileSqlExecutionParamPlan } from "../venues/selector-native-execution-param-plan.js";
import { compileSqlTrialLegs } from "../venues/selector-native-sql-trial.js";
import { readSelectorSourceIdentity, issueDirectSelectorSourceIdentity, assertSelectorSourceIdentity } from "../venues/selector-source-identity.js";
import { inspectRuntime } from "./runtime-program-testkit.js";

const H = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const addr = (n: number) => toBeHex(n, 20);
const coin0 = addr(21), coin1 = addr(22), pool = addr(23), executor = addr(24), origin = addr(25);
const source = { number: 26500000, generation: 26500000, hash: toBeHex(26500000, 32) };

const BATCH2 = [
  { tag: "3df02124", received: false, hasReceiver: false, coinFn: "coins" },
  { tag: "5b41b908", received: false, hasReceiver: false, coinFn: "coins" },
  { tag: "7e3db030", received: true, hasReceiver: false, coinFn: "coins" },
  { tag: "afb43012", received: true, hasReceiver: true, coinFn: "coins" },
  { tag: "767691e7", received: true, hasReceiver: true, coinFn: "coins" },
  { tag: "a6417ed6", received: false, hasReceiver: false, coinFn: "underlying_coins" },
  { tag: "44ee1986", received: false, hasReceiver: true, coinFn: "underlying_coins" },
  { tag: "65b2489b", received: false, hasReceiver: false, coinFn: "underlying_coins" },
  { tag: "e2ad025a", received: false, hasReceiver: true, coinFn: "underlying_coins" },
] as const;

for (const spec of BATCH2) {
  test(`curve family 0x${spec.tag} compiles, binds 0-RPC & RPC ${spec.coinFn}(0/1), and executes both directions cleanly`, async () => {
    const dirUrl = new URL(`../venues/selector-native/selector-${spec.tag}-family/`, import.meta.url);
    const execSrc = JSON.parse(readFileSync(new URL("execution.source.json", dirUrl), "utf8"));
    const idSrc = JSON.parse(readFileSync(new URL("identity.source.json", dirUrl), "utf8"));
    const generated = JSON.parse(readFileSync(new URL(`selector-${spec.tag}.json`, dirUrl), "utf8"));
    const ruleHash = await readSelectorDiscoveryRuleHash(dirUrl, new URL("../../../../scripts/", import.meta.url));
    const compiled = compileSelectorExecutionSource(execSrc, ruleHash, idSrc);
    assert.deepEqual(generated, compiled);

    const def = normalize(compiled);
    const single = selectSingleExecution(def);
    assert.equal(def.programs.filter(p => p.type === "independentIdentity").length, 2);

    const abi = new Interface([
      execSrc.signature,
      "function coins(uint256) view returns (address)",
      "function underlying_coins(uint256) view returns (address)",
      "function balanceOf(address) view returns (uint256)",
      "function transfer(address, uint256) returns (bool)",
      "function approve(address, uint256) returns (bool)",
      "function allowance(address, address) view returns (uint256)",
    ]);

    for (const reverse of [false, true]) {
      const tokenIn = reverse ? coin1 : coin0;
      const tokenOut = reverse ? coin0 : coin1;
      const edge = {
        chainId: 1 as const,
        selector: `0x${spec.tag}`,
        poolAddress: pool,
        tokenIn,
        tokenOut,
      };

      const direct = issueDirectSelectorSourceIdentity({ definition: def, edge, source });
      assert.equal(direct.matches.length, 1, direct.issues.join("; "));
      assertSelectorSourceIdentity(direct.matches[0]!, { definition: def, edge, source, programKey: single.programKey });

      const rpcId = await readSelectorSourceIdentity({
        definition: def,
        edge,
        source,
        readRequests: async requests => requests.map(r => {
          assert.equal(r.kind, "eth-call");
          if (r.kind !== "eth-call") throw Error("unexpected");
          const tx = abi.parseTransaction({ data: r.data })!;
          assert.equal(tx.name, spec.coinFn);
          const idx = Number(tx.args[0]);
          return {
            id: r.id,
            ok: true as const,
            source,
            completion: "returned" as const,
            data: abi.encodeFunctionResult(spec.coinFn, [idx === 0 ? coin0 : coin1]),
            provenance: { kind: "local-fixture" as const, fingerprint: toBeHex(1, 32) },
          };
        }),
      });
      assert.equal(rpcId.matches.length, 1);
      assert.equal(rpcId.matches[0]!.direction, reverse ? "coin1-to-coin0" : "coin0-to-coin1");

      const recipes = compileSqlExecutionParamPlan(def).recipes.map(({ index, requirements }) => ({
        index,
        observed: [],
        missing: requirements.filter(r => !r.sources.some(s => ["runtime", "edge", "fixed"].includes(s.kind))).map(r => r.key),
      }));
      const trial = compileSqlTrialLegs({
        source,
        definition: def,
        executor,
        transactionOrigin: origin,
        edge: {
          ...edge,
          executionParamEvidence: {
            consensus: "uniform",
            definitionSha256: H(def),
            txHash: toBeHex(888, 32),
            callPath: "",
            innerSwapPath: null,
            recipes,
          },
        },
      });
      assert.equal(trial.legs.length, 1, trial.issues.join("; "));

      // Verify actual BotVM execution in both directions
      const amountIn = 1000n, amountOut = 995n;
      let walletIn = 5000n, walletOut = 0n, poolIn = 100_000n, allowance = 0n, swapped = 0;
      inspectRuntime(trial.legs[0]!.leg.program, amountIn, {
        nativeBalance: () => 0n,
        call(c) {
          const tx = abi.parseTransaction({ data: c.data })!;
          if (tx.name === "coins" || tx.name === "underlying_coins") {
            assert.equal(tx.name, spec.coinFn);
            return abi.encodeFunctionResult(spec.coinFn, [Number(tx.args[0]) === 0 ? coin0 : coin1]);
          }
          if (tx.name === "balanceOf") {
            const who = tx.args[0].toLowerCase();
            if (who === pool) return toBeHex(poolIn, 32);
            return toBeHex(c.target.toLowerCase() === tokenIn ? walletIn : walletOut, 32);
          }
          if (tx.name === "approve") {
            allowance = BigInt(tx.args[1]);
            return toBeHex(1, 32);
          }
          if (tx.name === "allowance") return toBeHex(allowance, 32);
          if (tx.name === "transfer") {
            walletIn -= BigInt(tx.args[1]);
            poolIn += BigInt(tx.args[1]);
            return toBeHex(1, 32);
          }
          assert(tx.name === "exchange" || tx.name === "exchange_received" || tx.name === "exchange_underlying");
          assert.equal(BigInt(tx.args[0]), reverse ? 1n : 0n);
          assert.equal(BigInt(tx.args[1]), reverse ? 0n : 1n);
          assert.equal(BigInt(tx.args[2]), amountIn);
          if (!spec.received) {
            assert(allowance >= amountIn);
            allowance -= amountIn;
            walletIn -= amountIn;
          }
          if (spec.hasReceiver) {
            assert.equal(tx.args[4].toLowerCase(), executor);
          }
          walletOut += amountOut;
          swapped++;
          return toBeHex(amountOut, 32);
        },
      });
      assert.equal(swapped, 1);
      assert.equal(allowance, 0n);
      assert.equal(walletOut, amountOut);
    }
  });
}

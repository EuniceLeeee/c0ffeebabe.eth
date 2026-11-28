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
const coin0 = addr(21), coin1 = addr(22), coin2 = addr(26), pool = addr(23), executor = addr(24), origin = addr(25), router = addr(27);
const source = { number: 26500000, generation: 26500000, hash: toBeHex(26500000, 32) };

const BATCH2 = [
  { tag: "3df02124", received: false, hasReceiver: false, coinFn: "coins", tri: false },
  { tag: "5b41b908", received: false, hasReceiver: false, coinFn: "coins", tri: true },
  { tag: "7e3db030", received: true, hasReceiver: false, coinFn: "coins", tri: false },
  { tag: "afb43012", received: true, hasReceiver: true, coinFn: "coins", tri: false },
  { tag: "767691e7", received: true, hasReceiver: true, coinFn: "coins", tri: true },
  { tag: "a6417ed6", received: false, hasReceiver: false, coinFn: "underlying_coins", tri: false },
  { tag: "44ee1986", received: false, hasReceiver: true, coinFn: "underlying_coins", tri: false },
  { tag: "65b2489b", received: false, hasReceiver: false, coinFn: "coins", tri: true },
  { tag: "e2ad025a", received: false, hasReceiver: true, coinFn: "coins", tri: true },
] as const;

for (const spec of BATCH2) {
  test(`curve family 0x${spec.tag} compiles, binds 0-RPC & RPC ${spec.coinFn}, and executes 2-coin & 3-coin directions cleanly`, async () => {
    const dirUrl = new URL(`../venues/selector-native/selector-${spec.tag}-family/`, import.meta.url);
    const execSrc = JSON.parse(readFileSync(new URL("execution.source.json", dirUrl), "utf8"));
    const idSrc = JSON.parse(readFileSync(new URL("identity.source.json", dirUrl), "utf8"));
    const generated = JSON.parse(readFileSync(new URL(`selector-${spec.tag}.json`, dirUrl), "utf8"));
    const ruleHash = await readSelectorDiscoveryRuleHash(dirUrl, new URL("../../../../scripts/", import.meta.url));
    const compiled = compileSelectorExecutionSource(execSrc, ruleHash, idSrc);
    assert.deepEqual(generated, compiled);

    const def = normalize(compiled);
    const single = selectSingleExecution(def);
    assert.equal(def.programs.filter(p => p.type === "independentIdentity").length, spec.tri ? 6 : 2);

    const abi = new Interface([
      execSrc.signature,
      "function coins(uint256) view returns (address)",
      "function underlying_coins(uint256) view returns (address)",
      "function balanceOf(address) view returns (uint256)",
      "function transfer(address, uint256) returns (bool)",
      "function approve(address, uint256) returns (bool)",
      "function allowance(address, address) view returns (uint256)",
    ]);

    const poolCases = spec.tri
      ? [
          { coins: [coin0, coin1] as const, pairs: [[0, 1], [1, 0]] as const },
          { coins: [coin0, coin1, coin2] as const, pairs: [[0, 1], [1, 0], [0, 2], [2, 0], [1, 2], [2, 1]] as const },
        ]
      : [
          { coins: [coin0, coin1] as const, pairs: [[0, 1], [1, 0]] as const },
        ];

    for (const poolCase of poolCases) {
      for (const [idxIn, idxOut] of poolCase.pairs) {
        const tokenIn = poolCase.coins[idxIn]!;
        const tokenOut = poolCase.coins[idxOut]!;
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
            if (idx >= poolCase.coins.length) {
              return {
                id: r.id,
                ok: true as const,
                source,
                completion: "reverted-as-declared" as const,
                data: "0x",
                provenance: { kind: "local-fixture" as const, fingerprint: toBeHex(1, 32) },
              };
            }
            return {
              id: r.id,
              ok: true as const,
              source,
              completion: "returned" as const,
              data: abi.encodeFunctionResult(spec.coinFn, [poolCase.coins[idx]!]),
              provenance: { kind: "local-fixture" as const, fingerprint: toBeHex(1, 32) },
            };
          }),
        });
        assert.equal(rpcId.matches.length, 1, rpcId.issues.join("; "));
        assert.equal(rpcId.matches[0]!.direction, `coin${idxIn}-to-coin${idxOut}`);

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

        const amountIn = 1000n, amountOut = 995n;
        let walletIn = 5000n, walletOut = 0n, poolIn = 100_000n, allowance = 0n, swapped = 0;
        inspectRuntime(trial.legs[0]!.leg.program, amountIn, {
          nativeBalance: () => 0n,
          call(c) {
            const tx = abi.parseTransaction({ data: c.data })!;
            if (tx.name === "coins" || tx.name === "underlying_coins") {
              assert.equal(tx.name, spec.coinFn);
              const qIdx = Number(tx.args[0]);
              assert(qIdx === 0 || qIdx === 1, "runtime must never read coins(2) so 2-coin pools cannot revert");
              return abi.encodeFunctionResult(spec.coinFn, [poolCase.coins[qIdx]!]);
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
            assert.equal(BigInt(tx.args[0]), BigInt(idxIn));
            assert.equal(BigInt(tx.args[1]), BigInt(idxOut));
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
    }
  });
}

test("curve crypto 0x5b41b908/0x65b2489b/0x767691e7/0xe2ad025a discover both v1 (4-word) and NG (6-word) TokenExchange events including coin2", async () => {
  const { discoverFamilyEventEdges } = await import(new URL("../../../../scripts/selector-family-event-discovery.mjs", import.meta.url).href);
  const eventAbi = new Interface([
    "function transfer(address,uint256) returns (bool)",
    "function transferFrom(address,address,uint256) returns (bool)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "event TokenExchange(address indexed buyer, uint256 sold_id, uint256 tokens_sold, uint256 bought_id, uint256 tokens_bought)",
    "event TokenExchange(address indexed buyer, uint256 sold_id, uint256 tokens_sold, uint256 bought_id, uint256 tokens_bought, uint256 fee, uint256 packed_price_scale)",
  ]);

  const cryptoTags = [
    { tag: "5b41b908", sig: "function exchange(uint256, uint256, uint256, uint256)", args: [0, 2, 1234n, 1n], prepaid: false },
    { tag: "65b2489b", sig: "function exchange_underlying(uint256, uint256, uint256, uint256)", args: [2, 1, 1234n, 1n], prepaid: false },
    { tag: "767691e7", sig: "function exchange_received(uint256, uint256, uint256, uint256, address)", args: [1, 2, 0n, 1n, executor], prepaid: true },
    { tag: "e2ad025a", sig: "function exchange_underlying(uint256, uint256, uint256, uint256, address)", args: [0, 2, 1234n, 1n, executor], prepaid: false },
  ] as const;

  for (const item of cryptoTags) {
    const dirUrl = new URL(`../venues/selector-native/selector-${item.tag}-family/`, import.meta.url);
    const rule = JSON.parse(readFileSync(new URL("edge-discovery.json", dirUrl), "utf8"));
    const mod = await import(new URL("discover.mjs", dirUrl).href);
    const sel = `0x${item.tag}`;
    const callAbi = new Interface([item.sig]);
    const callData = callAbi.encodeFunctionData(callAbi.fragments[0] as any, item.args);

    for (const isNg of [false, true]) {
      const evFrag = eventAbi.getEvent(
        isNg
          ? "TokenExchange(address,uint256,uint256,uint256,uint256,uint256,uint256)"
          : "TokenExchange(address,uint256,uint256,uint256,uint256)"
      )!;
      const evEncoded = eventAbi.encodeEventLog(
        evFrag,
        isNg ? [router, 0n, 1234n, 2n, 5678n, 3n, 99n] : [router, 0n, 1234n, 2n, 5678n]
      );
      const trIn = eventAbi.encodeEventLog(eventAbi.getEvent("Transfer")!, [router, pool, 1234n]);
      const trOut = eventAbi.encodeEventLog(eventAbi.getEvent("Transfer")!, [pool, executor, 5678n]);

      const frames = item.prepaid
        ? [
            { path: "", ok: true, kind: "call", sender: origin, target: router, input: "0x12345678", value: "0", output: null },
            { path: "0", ok: true, kind: "call", sender: router, target: coin0, input: eventAbi.encodeFunctionData("transfer", [pool, 1234n]), value: "0", output: null },
            { path: "1", ok: true, kind: "call", sender: router, target: pool, input: callData, value: "0", output: null },
            { path: "1,0", ok: true, kind: "call", sender: pool, target: coin2, input: eventAbi.encodeFunctionData("transfer", [executor, 5678n]), value: "0", output: null },
          ]
        : [
            { path: "", ok: true, kind: "call", sender: origin, target: router, input: "0x12345678", value: "0", output: null },
            { path: "0", ok: true, kind: "call", sender: router, target: pool, input: callData, value: "0", output: null },
            { path: "0,0", ok: true, kind: "call", sender: pool, target: coin0, input: eventAbi.encodeFunctionData("transferFrom", [router, pool, 1234n]), value: "0", output: null },
            { path: "0,1", ok: true, kind: "call", sender: pool, target: coin2, input: eventAbi.encodeFunctionData("transfer", [executor, 5678n]), value: "0", output: null },
          ];
      const logs = [
        { idx: 10, emitter: coin0, topics: trIn.topics, data: trIn.data },
        { idx: 11, emitter: coin2, topics: trOut.topics, data: trOut.data },
        { idx: 12, emitter: pool, topics: evEncoded.topics, data: evEncoded.data },
      ];
      // Verify single-rule witness/discovery mode has both v1 and NG topics registered!
      const edges = discoverFamilyEventEdges(frames, logs, { [sel]: rule }, { [sel]: mod.discover });
      assert.equal(edges.length, 1, `expected 1 discovered edge for ${sel} isNg=${isNg}`);
      assert.equal(edges[0]!.tokenIn, coin0);
      assert.equal(edges[0]!.tokenOut, coin2);
      assert.equal(edges[0]!.amountPayerInRaw, "1234");
      assert.equal(edges[0]!.amountReceivedOutRaw, "5678");
    }
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Interface, MaxUint256, toBeHex } from "ethers";
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
const coin0 = addr(31), coin1 = addr(32), coin2 = addr(33), pool = addr(34), executor = addr(35), origin = addr(36);
const source = { number: 26500000, generation: 26500000, hash: toBeHex(26500000, 32) };

function loadCompiled(tag: string) {
  return (async () => {
    const dirUrl = new URL(`../venues/selector-native/selector-${tag}-family/`, import.meta.url);
    const execSrc = JSON.parse(readFileSync(new URL("execution.source.json", dirUrl), "utf8"));
    const idSrc = JSON.parse(readFileSync(new URL("identity.source.json", dirUrl), "utf8"));
    const generated = JSON.parse(readFileSync(new URL(`selector-${tag}.json`, dirUrl), "utf8"));
    const ruleHash = await readSelectorDiscoveryRuleHash(dirUrl, new URL("../../../../scripts/", import.meta.url));
    const compiled = compileSelectorExecutionSource(execSrc, ruleHash, idSrc);
    assert.deepEqual(generated, compiled);
    const def = normalize(compiled);
    const single = selectSingleExecution(def);
    return { execSrc, idSrc, def, single };
  })();
}

function buildTrialLeg(def: ReturnType<typeof normalize>, edge: {
  chainId: 1;
  selector: string;
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
}) {
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
        txHash: toBeHex(999, 32),
        callPath: "",
        innerSwapPath: null,
        recipes,
      },
    },
  });
  assert.equal(trial.legs.length, 1, trial.issues.join("; "));
  return trial.legs[0]!;
}

test("0x8201aa3f Balancer V1 swapExactAmountIn compiles, verifies getFinalTokens(), and executes cleanly", async () => {
  const { execSrc, def, single } = await loadCompiled("8201aa3f");
  assert.equal(def.programs.filter(p => p.type === "independentIdentity").length, 1);

  const abi = new Interface([
    execSrc.signature,
    "function getFinalTokens() view returns (address[])",
    "function balanceOf(address) view returns (uint256)",
    "function approve(address, uint256) returns (bool)",
    "function allowance(address, address) view returns (uint256)",
  ]);

  const edge = { chainId: 1 as const, selector: "0x8201aa3f", poolAddress: pool, tokenIn: coin0, tokenOut: coin2 };
  const direct = issueDirectSelectorSourceIdentity({ definition: def, edge, source });
  assert.equal(direct.matches.length, 1);
  assertSelectorSourceIdentity(direct.matches[0]!, { definition: def, edge, source, programKey: single.programKey });

  const rpcId = await readSelectorSourceIdentity({
    definition: def,
    edge,
    source,
    readRequests: async requests => requests.map(r => {
      assert.equal(r.kind, "eth-call");
      if (r.kind !== "eth-call") throw Error("unexpected");
      const tx = abi.parseTransaction({ data: r.data })!;
      assert.equal(tx.name, "getFinalTokens");
      return {
        id: r.id,
        ok: true as const,
        source,
        completion: "returned" as const,
        data: abi.encodeFunctionResult("getFinalTokens", [[coin0, coin1, coin2]]),
        provenance: { kind: "local-fixture" as const, fingerprint: toBeHex(1, 32) },
      };
    }),
  });
  assert.equal(rpcId.matches.length, 1);

  const leg = buildTrialLeg(def, edge);
  const amountIn = 1000n, amountOut = 2500n;
  let walletIn = 5000n, walletOut = 0n, allowance = 0n, swapped = 0;
  inspectRuntime(leg.leg.program, amountIn, {
    nativeBalance: () => 0n,
    call(c) {
      const tx = abi.parseTransaction({ data: c.data })!;
      if (tx.name === "balanceOf") return toBeHex(c.target.toLowerCase() === coin0 ? walletIn : walletOut, 32);
      if (tx.name === "approve") { allowance = BigInt(tx.args[1]); return toBeHex(1, 32); }
      if (tx.name === "allowance") return toBeHex(allowance, 32);
      assert.equal(tx.name, "swapExactAmountIn");
      assert.equal(tx.args[0].toLowerCase(), coin0);
      assert.equal(BigInt(tx.args[1]), amountIn);
      assert.equal(tx.args[2].toLowerCase(), coin2);
      assert.equal(BigInt(tx.args[4]), MaxUint256);
      assert(allowance >= amountIn);
      allowance -= amountIn;
      walletIn -= amountIn;
      walletOut += amountOut;
      swapped++;
      return toBeHex(amountOut, 32);
    },
  });
  assert.equal(swapped, 1);
  assert.equal(allowance, 0n);
  assert.equal(walletOut, amountOut);
});

test("0x1a4d01d2 Curve remove_liquidity_one_coin compiles, verifies LP->coins(0/1), and executes both coins cleanly", async () => {
  const { execSrc, def, single } = await loadCompiled("1a4d01d2");
  assert.equal(def.programs.filter(p => p.type === "independentIdentity").length, 2);

  const abi = new Interface([
    execSrc.signature,
    "function coins(uint256) view returns (address)",
    "function balanceOf(address) view returns (uint256)",
  ]);

  for (const idx of [0, 1] as const) {
    const tokenOut = idx === 0 ? coin0 : coin1;
    const edge = { chainId: 1 as const, selector: "0x1a4d01d2", poolAddress: pool, tokenIn: pool, tokenOut };
    const direct = issueDirectSelectorSourceIdentity({ definition: def, edge, source });
    assert.equal(direct.matches.length, 1);
    assertSelectorSourceIdentity(direct.matches[0]!, { definition: def, edge, source, programKey: single.programKey });

    const rpcId = await readSelectorSourceIdentity({
      definition: def,
      edge,
      source,
      readRequests: async requests => requests.map(r => {
        assert.equal(r.kind, "eth-call");
        if (r.kind !== "eth-call") throw Error("unexpected");
        const tx = abi.parseTransaction({ data: r.data })!;
        assert.equal(tx.name, "coins");
        return {
          id: r.id,
          ok: true as const,
          source,
          completion: "returned" as const,
          data: abi.encodeFunctionResult("coins", [Number(tx.args[0]) === 0 ? coin0 : coin1]),
          provenance: { kind: "local-fixture" as const, fingerprint: toBeHex(1, 32) },
        };
      }),
    });
    assert.equal(rpcId.matches.length, 1);
    assert.equal(rpcId.matches[0]!.direction, idx === 0 ? "redeem-coin0" : "redeem-coin1");

    const leg = buildTrialLeg(def, edge);
    const amountIn = 1000n, amountOut = 1012n;
    let lpBal = 4000n, coinBal = 0n, redeemed = 0;
    inspectRuntime(leg.leg.program, amountIn, {
      nativeBalance: () => 0n,
      call(c) {
        const tx = abi.parseTransaction({ data: c.data })!;
        if (tx.name === "coins") return abi.encodeFunctionResult("coins", [Number(tx.args[0]) === 0 ? coin0 : coin1]);
        if (tx.name === "balanceOf") return toBeHex(c.target.toLowerCase() === pool ? lpBal : coinBal, 32);
        assert.equal(tx.name, "remove_liquidity_one_coin");
        assert.equal(BigInt(tx.args[0]), amountIn);
        assert.equal(BigInt(tx.args[1]), BigInt(idx));
        lpBal -= amountIn;
        coinBal += amountOut;
        redeemed++;
        return toBeHex(amountOut, 32);
      },
    });
    assert.equal(redeemed, 1);
    assert.equal(coinBal, amountOut);
  }
});

test("0xb72df5de Curve NG add_liquidity(uint256[],uint256) compiles, verifies coins(0/1)->LP, and executes both coins cleanly", async () => {
  const { execSrc, def, single } = await loadCompiled("b72df5de");
  assert.equal(def.programs.filter(p => p.type === "independentIdentity").length, 2);

  const abi = new Interface([
    execSrc.signature,
    "function coins(uint256) view returns (address)",
    "function balanceOf(address) view returns (uint256)",
    "function approve(address, uint256) returns (bool)",
    "function allowance(address, address) view returns (uint256)",
  ]);

  for (const idx of [0, 1] as const) {
    const tokenIn = idx === 0 ? coin0 : coin1;
    const edge = { chainId: 1 as const, selector: "0xb72df5de", poolAddress: pool, tokenIn, tokenOut: pool };
    const direct = issueDirectSelectorSourceIdentity({ definition: def, edge, source });
    assert.equal(direct.matches.length, 1);
    assertSelectorSourceIdentity(direct.matches[0]!, { definition: def, edge, source, programKey: single.programKey });

    const rpcId = await readSelectorSourceIdentity({
      definition: def,
      edge,
      source,
      readRequests: async requests => requests.map(r => {
        assert.equal(r.kind, "eth-call");
        if (r.kind !== "eth-call") throw Error("unexpected");
        const tx = abi.parseTransaction({ data: r.data })!;
        assert.equal(tx.name, "coins");
        return {
          id: r.id,
          ok: true as const,
          source,
          completion: "returned" as const,
          data: abi.encodeFunctionResult("coins", [Number(tx.args[0]) === 0 ? coin0 : coin1]),
          provenance: { kind: "local-fixture" as const, fingerprint: toBeHex(1, 32) },
        };
      }),
    });
    assert.equal(rpcId.matches.length, 1);
    assert.equal(rpcId.matches[0]!.direction, idx === 0 ? "mint-from-coin0" : "mint-from-coin1");

    const leg = buildTrialLeg(def, edge);
    const amountIn = 1000n, lpOut = 998n;
    let coinBal = 4000n, lpBal = 0n, allowance = 0n, deposited = 0;
    inspectRuntime(leg.leg.program, amountIn, {
      nativeBalance: () => 0n,
      call(c) {
        const tx = abi.parseTransaction({ data: c.data })!;
        if (tx.name === "coins") return abi.encodeFunctionResult("coins", [Number(tx.args[0]) === 0 ? coin0 : coin1]);
        if (tx.name === "balanceOf") return toBeHex(c.target.toLowerCase() === tokenIn ? coinBal : lpBal, 32);
        if (tx.name === "approve") { allowance = BigInt(tx.args[1]); return toBeHex(1, 32); }
        if (tx.name === "allowance") return toBeHex(allowance, 32);
        assert.equal(tx.name, "add_liquidity");
        const amounts = tx.args[0].map((v: bigint) => BigInt(v));
        assert.deepEqual(amounts, idx === 0 ? [amountIn, 0n] : [0n, amountIn]);
        assert(allowance >= amountIn);
        allowance -= amountIn;
        coinBal -= amountIn;
        lpBal += lpOut;
        deposited++;
        return toBeHex(lpOut, 32);
      },
    });
    assert.equal(deposited, 1);
    assert.equal(allowance, 0n);
    assert.equal(lpBal, lpOut);
  }
});

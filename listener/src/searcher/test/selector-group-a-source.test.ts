import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, FunctionFragment, ZeroAddress } from "ethers";
import { GENERATED_PRODUCTION_FAMILY_ENTRIES } from "../generated/production-family-entries.generated.js";
import { selectorSourceGraphNomination } from "../venues/selector-source-graph.js";
import {
  createSelectorIdentityRequestReader,
  issueDirectSelectorSourceIdentity,
  readSelectorSourceIdentity,
} from "../venues/selector-source-identity.js";
import { compileSqlTrialLegs } from "../venues/selector-native-sql-trial.js";
import type { SqlLiveEdgeCoordinates } from "../venues/selector-native-sql-live-binding.js";

const SOURCE = Object.freeze({
  number: 26378389,
  hash: "0x62b23cae3b410e09f24910f072a94e2a65b68917a91168dda8648e0d5375c618",
  generation: 1,
});
const EXECUTOR = "0x1111111111111111111111111111111111111111";
const ORIGIN = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const TOK_A = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TOK_B = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const BAL_VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8";
const BAL_POOL_ID = "0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000014";
const GOLDX = "0x355c665e101b9da58704a8fddb5feef210ef20c0";
const PAXG = "0x45804880de22913dafe09f4980848ece6ecbaf78";

const GROUP_A_SELECTORS = [
  "0xba087652", "0xb460af94", "0xfea53be1", "0x26599850", "0xd01d073a",
  "0x40c10f19", "0xa0712d68", "0xf5720c4a", "0x2b2dfd2c", "0x6145d1b7",
  "0x5e5144eb", "0xdf791e50", "0x2e1a7d4d", "0xbd6015b4", "0xdd93f59a",
  "0xe331d039", "0x2668dfaa", "0xa6220b66", "0xa6e81533", "0x59a87bc1",
  "0xd04c6983", "0x95e3c50b", "0xad65d76d", "0xf39b5b9b", "0x86b01724",
  "0xd0137d8d", "0x52bbbe29",
] as const;

function defOf(selector: string) {
  const hit = GENERATED_PRODUCTION_FAMILY_ENTRIES.find(
    e => e.module.selectorFamilyModule.definition.selector === selector,
  );
  assert(hit, `missing production family entry for ${selector}`);
  return hit.module.selectorFamilyModule.definition;
}

function sampleEdgesFor(selector: string): SqlLiveEdgeCoordinates[] {
  if (selector === "0x52bbbe29") {
    return [{
      chainId: 1,
      selector,
      poolAddress: BAL_VAULT,
      poolId: BAL_POOL_ID,
      poolNamespace: "contract-pool-id",
      tokenIn: TOK_A,
      tokenInId: null,
      tokenOut: TOK_B,
      tokenOutId: null,
    }];
  }
  if (selector === "0x40c10f19") {
    return [{
      chainId: 1, selector, poolAddress: GOLDX, poolId: null, poolNamespace: null,
      tokenIn: PAXG, tokenInId: null, tokenOut: GOLDX, tokenOutId: null,
    }];
  }
  if (["0xba087652", "0xb460af94", "0xfea53be1", "0x6145d1b7", "0x2e1a7d4d"].includes(selector)) {
    return [{
      chainId: 1, selector, poolAddress: POOL, poolId: null, poolNamespace: null,
      tokenIn: POOL, tokenInId: null, tokenOut: TOK_A, tokenOutId: null,
    }];
  }
  if (["0x26599850", "0xd01d073a", "0x2b2dfd2c"].includes(selector)) {
    return [{
      chainId: 1, selector, poolAddress: POOL, poolId: null, poolNamespace: null,
      tokenIn: TOK_A, tokenInId: null, tokenOut: POOL, tokenOutId: null,
    }];
  }
  if (["0x95e3c50b", "0x86b01724"].includes(selector)) {
    return [{
      chainId: 1, selector, poolAddress: POOL, poolId: null, poolNamespace: null,
      tokenIn: TOK_A, tokenInId: null, tokenOut: ZeroAddress, tokenOutId: null,
    }];
  }
  if (["0xad65d76d", "0xf39b5b9b", "0xd0137d8d"].includes(selector)) {
    return [{
      chainId: 1, selector, poolAddress: POOL, poolId: null, poolNamespace: null,
      tokenIn: ZeroAddress, tokenInId: null, tokenOut: TOK_A, tokenOutId: null,
    }];
  }
  if (["0x2668dfaa", "0xa6220b66", "0xa6e81533"].includes(selector)) {
    return [
      {
        chainId: 1, selector, poolAddress: POOL, poolId: null, poolNamespace: null,
        tokenIn: TOK_A, tokenInId: null, tokenOut: TOK_B, tokenOutId: null,
      },
      {
        chainId: 1, selector, poolAddress: POOL, poolId: null, poolNamespace: null,
        tokenIn: ZeroAddress, tokenInId: null, tokenOut: TOK_A, tokenOutId: null,
      },
      {
        chainId: 1, selector, poolAddress: POOL, poolId: null, poolNamespace: null,
        tokenIn: TOK_A, tokenInId: null, tokenOut: ZeroAddress, tokenOutId: null,
      },
    ];
  }
  return [{
    chainId: 1, selector, poolAddress: POOL, poolId: null, poolNamespace: null,
    tokenIn: TOK_A, tokenInId: null, tokenOut: TOK_B, tokenOutId: null,
  }];
}

test("all 27 Group A selectors pass graph nomination, 0-RPC direct identity, and SQL trial compilation", () => {
  for (const selector of GROUP_A_SELECTORS) {
    const definition = defOf(selector);
    assert(definition.directState, `${selector} missing directState`);
    for (const edge of sampleEdgesFor(selector)) {
      const graph = selectorSourceGraphNomination(definition, edge);
      const expectedIn = edge.tokenIn === ZeroAddress ? WETH : edge.tokenIn;
      const expectedOut = edge.tokenOut === ZeroAddress ? WETH : edge.tokenOut;
      assert.equal(graph.tokenIn, expectedIn, `${selector} graph tokenIn`);
      assert.equal(graph.tokenOut, expectedOut, `${selector} graph tokenOut`);

      const direct = issueDirectSelectorSourceIdentity({ definition, edge, source: SOURCE });
      assert.deepEqual(direct.issues, [], `${selector} direct identity issues: ${direct.issues.join("; ")}`);
      assert.equal(direct.matches.length, 1, `${selector} expected 1 direct identity match`);

      const trial = compileSqlTrialLegs({
        definition,
        edge,
        source: SOURCE,
        executor: EXECUTOR,
        transactionOrigin: ORIGIN,
        sourceIdentity: direct.matches[0],
      });
      assert.equal(trial.complete, true, `${selector} trial incomplete: ${trial.issues.join("; ")}`);
      assert.equal(trial.legs.length, 1, `${selector} expected 1 trial leg`);
      assert.equal(trial.legs[0]!.tokenIn, expectedIn, `${selector} trial tokenIn`);
      assert.equal(trial.legs[0]!.tokenOut, expectedOut, `${selector} trial tokenOut`);
    }
  }
});

test("readSelectorSourceIdentity confirms storageSlot, tupleField, tokenList(bytes32), checks, and stETH options", async () => {
  const coder = AbiCoder.defaultAbiCoder();

  // 1. Ella storageSlot + $native (0x86b01724)
  {
    const definition = defOf("0x86b01724");
    const edge: SqlLiveEdgeCoordinates = {
      chainId: 1, selector: "0x86b01724", poolAddress: POOL, poolId: null, poolNamespace: null,
      tokenIn: TOK_A, tokenInId: null, tokenOut: ZeroAddress, tokenOutId: null,
    };
    const readRequests = createSelectorIdentityRequestReader({
      source: SOURCE,
      read: async () => { throw new Error("unexpected eth_call"); },
      readCode: async () => "0x6000",
      readStorage: async (_addr, slot) => {
        assert.equal(slot, "0x0000000000000000000000000000000000000000000000000000000000000001");
        return "0x000000000000000000000000" + TOK_A.slice(2);
      },
    });
    const res = await readSelectorSourceIdentity({ definition, edge, source: SOURCE, readRequests });
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0]!.direction, "sell-token");
  }

  // 2. Fluid DEX constantsView() tupleField + nativeSentinel (0x2668dfaa)
  {
    const definition = defOf("0x2668dfaa");
    const frag = FunctionFragment.from("function constantsView() view returns ((uint256 dexId,address liquidity,address factory,(address shift,address admin,address colOperations,address debtOperations,address perfectOperationsAndSwapOut) implementations,address deployerContract,address token0,address token1,bytes32 supplyToken0Slot,bytes32 borrowToken0Slot,bytes32 supplyToken1Slot,bytes32 borrowToken1Slot,bytes32 exchangePriceToken0Slot,bytes32 exchangePriceToken1Slot,uint256 oracleMapping))");
    const encoded = coder.encode(frag.outputs, [{
      dexId: 1n,
      liquidity: POOL,
      factory: POOL,
      implementations: { shift: POOL, admin: POOL, colOperations: POOL, debtOperations: POOL, perfectOperationsAndSwapOut: POOL },
      deployerContract: POOL,
      token0: TOK_A,
      token1: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      supplyToken0Slot: "0x" + "00".repeat(32),
      borrowToken0Slot: "0x" + "00".repeat(32),
      supplyToken1Slot: "0x" + "00".repeat(32),
      borrowToken1Slot: "0x" + "00".repeat(32),
      exchangePriceToken0Slot: "0x" + "00".repeat(32),
      exchangePriceToken1Slot: "0x" + "00".repeat(32),
      oracleMapping: 0n,
    }]);
    const edge: SqlLiveEdgeCoordinates = {
      chainId: 1, selector: "0x2668dfaa", poolAddress: POOL, poolId: null, poolNamespace: null,
      tokenIn: ZeroAddress, tokenInId: null, tokenOut: TOK_A, tokenOutId: null,
    };
    const readRequests = createSelectorIdentityRequestReader({
      source: SOURCE,
      read: async (_to, data) => {
        assert.equal(data.slice(0, 10), frag.selector);
        return encoded;
      },
      readCode: async () => "0x6000",
    });
    const res = await readSelectorSourceIdentity({ definition, edge, source: SOURCE, readRequests });
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0]!.direction, "swap1-to-0");
  }

  // 3. Balancer V2 getPoolTokens(bytes32) (0x52bbbe29)
  {
    const definition = defOf("0x52bbbe29");
    const frag = FunctionFragment.from("function getPoolTokens(bytes32) view returns (address[], uint256[], uint256)");
    const encoded = coder.encode(frag.outputs, [[TOK_A, TOK_B], [100n, 200n], 1n]);
    const edge: SqlLiveEdgeCoordinates = {
      chainId: 1, selector: "0x52bbbe29", poolAddress: BAL_VAULT, poolId: BAL_POOL_ID, poolNamespace: "contract-pool-id",
      tokenIn: TOK_A, tokenInId: null, tokenOut: TOK_B, tokenOutId: null,
    };
    const readRequests = createSelectorIdentityRequestReader({
      source: SOURCE,
      read: async (_to, data) => {
        assert.equal(data.slice(0, 10), frag.selector);
        return encoded;
      },
      readCode: async () => "0x6000",
    });
    const res = await readSelectorSourceIdentity({ definition, edge, source: SOURCE, readRequests });
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0]!.direction, "vault-swap");
  }

  // 4. wstETH stETH() option on 0xde0e9a3e & 0xea598cb0
  for (const [selector, expectedDir, tokenIn, tokenOut] of [
    ["0xde0e9a3e", "unwrap-wsteth", POOL, TOK_A] as const,
    ["0xea598cb0", "wrap-wsteth", TOK_A, POOL] as const,
  ]) {
    const definition = defOf(selector);
    const stEthSel = FunctionFragment.from("function stETH() view returns (address)").selector;
    const edge: SqlLiveEdgeCoordinates = {
      chainId: 1, selector, poolAddress: POOL, poolId: null, poolNamespace: null,
      tokenIn, tokenInId: null, tokenOut, tokenOutId: null,
    };
    const readRequests = createSelectorIdentityRequestReader({
      source: SOURCE,
      read: async (_to, data) => {
        if (data.slice(0, 10) === stEthSel) return coder.encode(["address"], [TOK_A]);
        const err: any = new Error("execution reverted");
        err.code = 3;
        err.data = "0x";
        throw err;
      },
      readCode: async () => "0x6000",
    });
    const res = await readSelectorSourceIdentity({ definition, edge, source: SOURCE, readRequests });
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0]!.direction, expectedDir);
  }
});

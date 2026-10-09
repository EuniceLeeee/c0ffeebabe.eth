import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  declareRequestProgram,
  type AdapterRequest,
  type AdapterRequestResult,
} from "../../../adapter-request-program.js";
import { plugin } from
  "../../../production-families/yieldbasis-lt.production.js";
import { LT_INTERFACE } from "../abi.js";
import type { YieldBasisLtCandidate, YieldBasisLtIdentity } from
  "../types.js";

/**
 * Pinned-block source. Block 26030452 (hash pinned from the archive RPC) is the
 * block of the representative transaction
 * 0x00b9193066729d840d402ddf91c27076de83cfec3fc7e7f7811a9e7ec4efa443 on
 * yb-WETH, the first of the three production instances.
 */
export const SOURCE = {
  number: 26030452,
  hash: "0xdd4b0d73421b87ba77a02486ff246b9137609a74aaef41bd221b58573e9238de",
  generation: 1,
};

/**
 * A landed redemption of the SUPPORTED direction, from the second sample
 * transaction
 * 0x022a9ff85219675bcf0a0a2b17c76ac72b98d5e2c4177bc104edff56e706ee77 at block
 * 26003536 (hash
 * 0xf913fc4aaaeca0fd9fcd871c1a2b0159e1ecc3679724fff679a061ca7bedeaad):
 * yb-WETH burned 41886001261762273 shares and emitted
 * Withdraw(assets=42107000017438537). Both sides are 18-decimal single-asset
 * numbers, which is exactly the shape this family routes.
 */
export const LANDED_REDEEM_SHARES = 41886001261762273n;
export const LANDED_REDEEM_ASSETS = 42107000017438537n;

/** yb-WETH — the LT sentinel of the representative transaction. */
export const LT = "0x2b9c9f3bdceb5d8e36a4704f08a78fca53343cea";
export const ASSET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const STABLECOIN = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E";
export const CRYPTOPOOL = "0x656341Ef90b622c6634e0573772FfB7f3669b9f3";
export const AMM = "0x5f8D24F33Cc5a1D5D1bf012261E6A2214C92233c";
export const AGG = "0x18672b1b0c623a30089A280Ed9256379fb0E4E62";
export const STAKER = "0xd829456FD63Ada7DE0657714A3A7A26DE403E3D8";
export const ADMIN = "0x370a449FeBb9411c95bf897021377fe0B7D100c0";
export const EXECUTOR = "0x1000000000000000000000000000000000000005";
export const FOREIGN = "0x1000000000000000000000000000000000000009";

/** Values read at block 26030452 (archive RPC; see the family report). */
export const TOTAL_SUPPLY = 10584456024458933077769n;
export const LIVE_SUPPLY_TOKENS = 10584456024458933077768n;
export const STAKED_TOKENS = 6021125066961848667231n;
export const LIQUIDITY_ADMIN = 0n;
export const LIQUIDITY_TOTAL = 10647422043286270404549n;
export const LIQUIDITY_IDEAL_STAKED = 6111957690146714960171n;
export const LIQUIDITY_STAKED = 6056944222282818791979n;
export const POOL_SHARE_SUPPLY = 544562448629747596315311n;
export const POOL_ASSET_BALANCE = 10875535147883479804674n;
export const ASSET_DECIMALS_VALUE = 18n;
export const SHARE_DECIMALS_VALUE = 18n;
/** preview_withdraw(1e18) == 1005642419965475619 wei WETH at that block. */
export const PREVIEW_PER_SHARE = 1005642419965475619n;
export const PROBE_SHARES = 10n ** 18n;

export const CANDIDATE: YieldBasisLtCandidate = {
  candidateKind: "yieldbasis-lt",
  lt: LT,
};

export const word = (n: bigint | string) => ethers.toBeHex(n, 32);

export function result(
  id: string,
  data: string,
  source = SOURCE,
): AdapterRequestResult {
  return {
    id,
    data,
    source,
    ok: true,
    completion: "returned",
    provenance: { kind: "synthetic-yieldbasis-lt-contract", fingerprint: "fixture" },
  };
}

export interface AnswerOptions {
  /** Synthetic deposit fixtures are opt-in; old withdrawal tests keep their scope. */
  readonly deposit?: boolean;
  readonly programReverts?: boolean;
  readonly ammLtContract?: string;
  readonly ammCollateral?: string;
  readonly ammStablecoin?: string;
  readonly poolCoin0?: string;
  readonly poolCoin1?: string;
  readonly killed?: boolean;
  readonly currentStaker?: string;
  readonly probeReplies?: boolean;
  readonly previewReplies?: boolean;
  readonly previewAmountFor?: (amountIn: bigint) => bigint;
  readonly liveSupply?: bigint;
  readonly liquidityTotal?: bigint;
  readonly poolAssetBalance?: bigint;
  readonly assetDecimals?: bigint;
}

export function answerFor(
  options: AnswerOptions = {},
): (request: AdapterRequest) => AdapterRequestResult {
  const killed = options.killed ?? false;
  const probe = options.probeReplies ?? true;
  const previewReplies = options.previewReplies ?? true;
  const liveSupply = options.liveSupply ?? LIVE_SUPPLY_TOKENS;
  const liquidityTotal = options.liquidityTotal ?? LIQUIDITY_TOTAL;
  const poolAssetBalance = options.poolAssetBalance ?? POOL_ASSET_BALANCE;
  const preview = options.previewAmountFor ??
    ((amountIn: bigint) => (amountIn * PREVIEW_PER_SHARE) / 10n ** 18n);
  return (request: AdapterRequest): AdapterRequestResult => {
    if (request.id === "active-deposit" || request.id === "active-deposit-program" || request.id === "deposit-receipt") {
      assert(request.kind === "effect-delta-simulation");
      if (!options.deposit || (request.call.executionMode === "executor-program" && options.programReverts))
        return { ...result(request.id, "0x"), completion: "reverted-as-declared",
          effects: { tokenDeltas: [], nativeDeltas: [], logs: [] } };
      const assets = request.overrideIntent.tokenBalances![0]!.amount, shares = assets * 2n;
      const event = LT_INTERFACE.encodeEventLog(LT_INTERFACE.getEvent("Deposit")!, [EXECUTOR, EXECUTOR, assets, shares]);
      return { ...result(request.id, request.call.executionMode === "executor-program" ? "0x"
        : LT_INTERFACE.encodeFunctionResult("deposit(uint256,uint256,uint256)", [shares])),
        effects: { tokenDeltas: [{ token: ASSET, account: EXECUTOR, delta: -assets },
          { token: LT, account: EXECUTOR, delta: shares }, { token: STABLECOIN, account: EXECUTOR, delta: 0n }],
          nativeDeltas: [{ account: EXECUTOR, before: 0n, after: 0n, delta: 0n }], logs: [{ address: LT, ...event }] } };
    }
    if (request.id === "active-preview-withdraw" && !probe) {
      return { id: request.id, ok: false, failure: "rpc", source: SOURCE } as
        unknown as AdapterRequestResult;
    }
    if (request.id === "quote-preview-withdraw") {
      if (!previewReplies) {
        return { id: request.id, ok: false, failure: "rpc", source: SOURCE } as
          unknown as AdapterRequestResult;
      }
      const amountIn = BigInt(
        LT_INTERFACE.decodeFunctionData("preview_withdraw", request.data)[0],
      );
      return result(request.id, word(preview(amountIn)));
    }
    const values: Record<string, string> = {
      "lt-code": "0x60016000f3",
      "lt-asset-token": word(ASSET),
      "lt-stablecoin": word(STABLECOIN),
      "lt-cryptopool": word(CRYPTOPOOL),
      "lt-amm": word(AMM),
      "lt-agg": word(AGG),
      "lt-staker": word(STAKER),
      "lt-admin": word(ADMIN),
      "lt-decimals": word(SHARE_DECIMALS_VALUE),
      "lt-total-supply": word(TOTAL_SUPPLY),
      "lt-liquidity": LT_INTERFACE.encodeFunctionResult("liquidity", [
        LIQUIDITY_ADMIN,
        liquidityTotal,
        LIQUIDITY_IDEAL_STAKED,
        LIQUIDITY_STAKED,
      ]),
      "lt-updated-balances": LT_INTERFACE.encodeFunctionResult(
        "updated_balances",
        [liveSupply, STAKED_TOKENS],
      ),
      "lt-is-killed": word(killed ? 1n : 0n),
      "binding-amm-lt": word(options.ammLtContract ?? LT),
      "binding-amm-collateral": word(options.ammCollateral ?? CRYPTOPOOL),
      "binding-amm-stablecoin": word(options.ammStablecoin ?? STABLECOIN),
      "binding-pool-coin-0": word(options.poolCoin0 ?? STABLECOIN),
      "binding-pool-coin-1": word(options.poolCoin1 ?? ASSET),
      "binding-pool-decimals": word(18n),
      "binding-pool-share-supply": word(POOL_SHARE_SUPPLY),
      "binding-asset-decimals": word(options.assetDecimals ?? ASSET_DECIMALS_VALUE),
      "active-is-killed": word(killed ? 1n : 0n),
      "active-amm-is-killed": word(killed ? 1n : 0n),
      "active-preview-withdraw": word(preview(PROBE_SHARES)),
      "binding-deposit-balance-0": word(poolAssetBalance * 3000n),
      "binding-deposit-balance-1": word(poolAssetBalance),
      "quote-is-killed": word(killed ? 1n : 0n),
      "quote-staker": word(options.currentStaker ?? STAKER),
      "quote-live-supply": LT_INTERFACE.encodeFunctionResult(
        "updated_balances",
        [liveSupply, STAKED_TOKENS],
      ),
      "quote-liquidity": LT_INTERFACE.encodeFunctionResult("liquidity", [
        LIQUIDITY_ADMIN,
        liquidityTotal,
        LIQUIDITY_IDEAL_STAKED,
        LIQUIDITY_STAKED,
      ]),
      "quote-pool-asset-balance": word(poolAssetBalance),
      "static-share-decimals": word(SHARE_DECIMALS_VALUE),
      "static-asset-decimals": word(options.assetDecimals ?? ASSET_DECIMALS_VALUE),
      "current:deposit": word(PREVIEW_PER_SHARE),
    };
    if (request.id === "current:withdraw") {
      return result(request.id, word(preview(PROBE_SHARES)));
    }
    assert(request.id in values, `unexpected fixture request ${request.id}`);
    return result(request.id, values[request.id]!);
  };
}

export const SAMPLE_SHARES = 10n ** 18n;

/** Walks the identity variant to a verified identity using fixture answers. */
export function identityWith(
  reply: (request: AdapterRequest) => AdapterRequestResult = answerFor(),
  candidate: YieldBasisLtCandidate = CANDIDATE,
): YieldBasisLtIdentity {
  const variant = plugin.identity.variants[0]!;
  let evidence: unknown;
  for (let step = 0; step < 6; step++) {
    const input = { candidate, evidence, step };
    const decision = variant.decide(input as never);
    if (decision.status === "verified") {
      return decision.identity as YieldBasisLtIdentity;
    }
    assert.equal(
      decision.status,
      "continue",
      `identity stopped early: ${JSON.stringify(decision)}`,
    );
    const declared = declareRequestProgram({
      requirements: variant.requirements,
      buildRequests: variant.buildRequests,
      decode: () => undefined,
    }, input as never);
    evidence = variant.decode({
      step: input as never,
      results: declared.requests.map(reply),
    } as never);
  }
  throw new Error("yield basis LT identity did not converge");
}

export function decisionWith(
  reply: (request: AdapterRequest) => AdapterRequestResult,
) {
  const variant = plugin.identity.variants[0]!;
  let evidence: unknown;
  for (let step = 0; step < 6; step++) {
    const input = { candidate: CANDIDATE, evidence, step };
    const decision = variant.decide(input as never);
    if (decision.status !== "continue") return decision;
    const declared = declareRequestProgram({
      requirements: variant.requirements,
      buildRequests: variant.buildRequests,
      decode: () => undefined,
    }, input as never);
    evidence = variant.decode({
      step: input as never,
      results: declared.requests.map(reply),
    } as never);
  }
  throw new Error("yield basis LT identity did not converge");
}

export function descriptor(
  reply: (request: AdapterRequest) => AdapterRequestResult = answerFor(),
) {
  const identity = identityWith(reply);
  return plugin.instance.finalizeDescriptor({
    identity,
    draft: plugin.instance.compileDraft(identity),
    sharedBindings: [],
  });
}

import {
  blockScanMulticallIface,
  encodeMulticall,
  type MulticallItem,
} from "../blockscan-state-shared.js";
import { DODO_V2_POOL_INTERFACE } from "../dodo-v2-abi.js";
import {
  checkedDodoInput,
  quoteDodoPmmExactInput,
  type DodoPmmState,
} from "../dodo-pmm-math.js";
import { canonicalAddress, decodeFirstWord } from "./codec.js";
import type {
  DodoBoundedProbePlan,
  DodoInputPosition,
  DodoProbeCandidate,
  DodoProbeQuote,
  DodoProvablyUnavailable,
} from "./types.js";

export function applyDodoTransferToInput(
  position: DodoInputPosition,
  transferAmount: bigint,
  pool: string,
): bigint {
  if (transferAmount <= position.deficit) {
    throw new Error(`dodo-v2 transfer does not clear input deficit for pool ${pool}`);
  }
  return checkedDodoInput(
    position.surplus,
    transferAmount - position.deficit,
    pool,
  );
}

export function selectDodoProbeInput(input: {
  readonly oneToken: bigint;
  readonly currentInput: bigint;
  readonly inputDeficit?: bigint;
  readonly reserve: bigint;
  readonly pmm: DodoPmmState;
  readonly sellBase: boolean;
  readonly pool: string;
  readonly lpFeeRate?: bigint;
  readonly mtFeeRate?: bigint;
}): bigint | DodoBoundedProbePlan | DodoProvablyUnavailable {
  const {
    oneToken,
    currentInput,
    inputDeficit = 0n,
    reserve,
    pmm,
    sellBase,
    pool,
    lpFeeRate = 0n,
    mtFeeRate = 0n,
  } = input;
  if (currentInput < 0n || inputDeficit < 0n) {
    throw new Error(`dodo-v2 pool ${pool} returned a negative input position`);
  }
  if (currentInput > 0n && inputDeficit > 0n) {
    throw new Error(`dodo-v2 pool ${pool} returned both input surplus and deficit`);
  }
  const unavailable = outputDomainUnavailable(pmm, sellBase, pool);
  if (unavailable !== null) return unavailable;
  if (reserve <= 0n) {
    return buildBoundedProbePlan(
      input,
      `dodo-v2 pool ${pool} has no behavior-safe input reserve at the pinned source`,
    );
  }
  const targetIssue = activeMathTargetIssue(pmm, sellBase, pool);
  if (targetIssue !== null) return buildBoundedProbePlan(input, targetIssue);

  const liquidityProbe = reserve >= 100n ? reserve / 100n : 1n;
  const precisionFloor = reserve / 1_000_000n > 0n
    ? reserve / 1_000_000n
    : 1n;
  const desiredProbe = oneToken > precisionFloor ? oneToken : precisionFloor;
  let effectiveProbe = liquidityProbe < desiredProbe
    ? liquidityProbe
    : desiredProbe;
  const crossingCap = zeroTargetCrossingCap(pmm, sellBase);
  if (crossingCap !== null) {
    if (crossingCap <= 0n || currentInput >= crossingCap) {
      return buildBoundedProbePlan(
        input,
        `dodo-v2 pool ${pool} has no positive input before its zero-target branch`,
      );
    }
    const remaining = crossingCap - currentInput;
    const branchProbe = remaining > 1n ? remaining / 2n : remaining;
    if (branchProbe < effectiveProbe) effectiveProbe = branchProbe;
  }
  if (effectiveProbe <= 0n) {
    return buildBoundedProbePlan(
      input,
      `dodo-v2 pool ${pool} selected no positive behavior-safe probe`,
    );
  }
  const transferAmount = checkedDodoInput(inputDeficit, effectiveProbe, pool);
  const effectiveInput = checkedDodoInput(currentInput, effectiveProbe, pool);
  try {
    const local = quoteDodoPmmExactInput({
      state: pmm,
      sellBase,
      payAmount: effectiveInput,
      lpFeeRate,
      mtFeeRate,
    });
    if (local.status === "quote" && local.amountOut > 0n) {
      return transferAmount;
    }
    return buildBoundedProbePlan(
      input,
      local.status === "needs-onchain-quote"
        ? `dodo-v2 pool ${pool} requires ${local.reason} bytecode proof`
        : `dodo-v2 pool ${pool} representative quote rounded to zero`,
    );
  } catch (error) {
    return buildBoundedProbePlan(
      input,
      `dodo-v2 pool ${pool} representative quote was outside local PMM domain: ` +
        errorMessage(error),
    );
  }
}

export function buildBoundedProbeCall(input: {
  readonly pool: string;
  readonly sellBase: boolean;
  readonly plan: DodoBoundedProbePlan;
  readonly quoteActor: string;
}): string {
  return encodeMulticall(boundedProbeItems(input));
}

export function decodeBoundedProbeResult(input: {
  readonly data: string;
  readonly pool: string;
  readonly sellBase: boolean;
  readonly plan: DodoBoundedProbePlan;
  readonly quoteActor: string;
}): DodoProbeQuote | null {
  const items = boundedProbeItems(input);
  const decoded = blockScanMulticallIface.decodeFunctionResult(
    "aggregate3",
    input.data,
  )[0] as readonly { readonly success: boolean; readonly returnData: string }[];
  if (decoded.length !== input.plan.candidates.length) {
    throw new Error(
      `dodo-v2 bounded probe ${input.pool} returned ` +
        `${decoded.length}/${input.plan.candidates.length} results`,
    );
  }
  for (let index = 0; index < decoded.length; index++) {
    const result = decoded[index];
    if (!result.success) continue;
    const amountOut = decodeFirstWord(
      String(result.returnData),
      `${items[index].label} ${input.pool}`,
    );
    if (amountOut <= 0n) continue;
    return Object.freeze({
      ...input.plan.candidates[index],
      amountOut,
    });
  }
  return null;
}

function buildBoundedProbePlan(
  input: {
    readonly oneToken: bigint;
    readonly currentInput: bigint;
    readonly inputDeficit?: bigint;
    readonly reserve: bigint;
    readonly pmm: DodoPmmState;
    readonly sellBase: boolean;
    readonly pool: string;
  },
  reason: string,
): DodoBoundedProbePlan {
  const inputDeficit = input.inputDeficit ?? 0n;
  const inputTarget = input.sellBase ? input.pmm.B0 : input.pmm.Q0;
  const scale = input.reserve > inputTarget ? input.reserve : inputTarget;
  const precisionFloor = scale / 1_000_000n > 0n ? scale / 1_000_000n : 1n;
  const desiredProbe = input.oneToken > precisionFloor
    ? input.oneToken
    : precisionFloor;
  const liquidityProbe = scale >= 100n ? scale / 100n : 1n;
  const representative = liquidityProbe < desiredProbe
    ? liquidityProbe
    : desiredProbe;
  const crossing = crossingInput(input.pmm, input.sellBase);
  const crossingIncrement = crossing !== null && crossing > input.currentInput
    ? crossing - input.currentInput
    : 0n;
  const candidates: DodoProbeCandidate[] = [];
  const seenEffective = new Set<string>();
  const addIncrement = (increment: bigint): void => {
    if (increment <= 0n || candidates.length >= 8) return;
    try {
      const transferAmount = checkedDodoInput(inputDeficit, increment, input.pool);
      const effectiveInput = checkedDodoInput(
        input.currentInput,
        increment,
        input.pool,
      );
      const key = effectiveInput.toString();
      if (seenEffective.has(key)) return;
      seenEffective.add(key);
      candidates.push(Object.freeze({ transferAmount, effectiveInput }));
    } catch {
      // Overflowing probes are not executable candidates.
    }
  };
  addIncrement(representative);
  addIncrement(crossingIncrement);
  addIncrement(crossingIncrement > 0n ? crossingIncrement + precisionFloor : 0n);
  addIncrement(precisionFloor);
  addIncrement(scale >= 100n ? scale / 100n : 1n);
  addIncrement(scale > 0n && input.oneToken > scale ? scale : input.oneToken);
  addIncrement(scale);
  addIncrement(1n);
  if (candidates.length === 0) {
    throw new Error(`dodo-v2 pool ${input.pool} has no bounded uint256 probe candidate`);
  }
  return Object.freeze({
    kind: "bounded-onchain-probe" as const,
    reason,
    candidates: Object.freeze(candidates),
  });
}

function boundedProbeItems(input: {
  readonly pool: string;
  readonly sellBase: boolean;
  readonly plan: DodoBoundedProbePlan;
  readonly quoteActor: string;
}): readonly MulticallItem[] {
  const pool = canonicalAddress(input.pool);
  const actor = canonicalAddress(input.quoteActor);
  const queryFunction = input.sellBase ? "querySellBase" : "querySellQuote";
  return Object.freeze(input.plan.candidates.map((candidate, index) => ({
    label: `probe-${index}:amount=${candidate.effectiveInput}`,
    target: pool,
    callData: DODO_V2_POOL_INTERFACE.encodeFunctionData(queryFunction, [
      actor,
      candidate.effectiveInput,
    ]),
    allowFailure: true,
  })));
}

function outputDomainUnavailable(
  pmm: DodoPmmState,
  sellBase: boolean,
  pool: string,
): DodoProvablyUnavailable | null {
  const outputReserve = sellBase ? pmm.Q : pmm.B;
  const outputTarget = sellBase ? pmm.Q0 : pmm.B0;
  if (outputReserve !== 0n || outputTarget !== 0n) return null;
  return Object.freeze({
    kind: "provably-unavailable" as const,
    reason:
      `dodo-v2 pool ${pool} has zero current and target output liquidity ` +
      `for ${sellBase ? "sell-base" : "sell-quote"}`,
  });
}

function activeMathTargetIssue(
  pmm: DodoPmmState,
  sellBase: boolean,
  pool: string,
): string | null {
  const activeTarget = sellBase
    ? (pmm.R === 1 ? pmm.B0 : pmm.Q0)
    : (pmm.R === 2 ? pmm.Q0 : pmm.B0);
  return activeTarget > 0n
    ? null
    : `dodo-v2 pool ${pool} has a zero active PMM target at the pinned source`;
}

function crossingInput(pmm: DodoPmmState, sellBase: boolean): bigint | null {
  if (sellBase && pmm.R === 1) return pmm.B0 > pmm.B ? pmm.B0 - pmm.B : 0n;
  if (!sellBase && pmm.R === 2) return pmm.Q0 > pmm.Q ? pmm.Q0 - pmm.Q : 0n;
  return null;
}

function zeroTargetCrossingCap(
  pmm: DodoPmmState,
  sellBase: boolean,
): bigint | null {
  if (sellBase && pmm.R === 1 && pmm.Q0 === 0n) {
    return pmm.B0 > pmm.B ? pmm.B0 - pmm.B : 0n;
  }
  if (!sellBase && pmm.R === 2 && pmm.B0 === 0n) {
    return pmm.Q0 > pmm.Q ? pmm.Q0 - pmm.Q : 0n;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { ethers } from "ethers";
import type {
  AdapterRequest,
  AdapterRequestResult,
  CallerRef,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import { MELLOW_QUEUE_INTERFACE } from "./abi.js";
import type {
  MellowQueueDescriptor,
  MellowQueueRoute,
} from "./types.js";

export const MELLOW_DEPOSIT_ADAPTER = "mellow-deposit" as const;
export const MELLOW_REDEEM_ADAPTER = "mellow-redeem" as const;

/**
 * Historical executor that deposited through this queue at N=26183616:
 * USDT allowance is max and `isDepositorWhitelisted(executor, [])` is true.
 * It is registered as a verified actor; the family never grants it routing
 * authority, only the ability to run the active behavior proof.
 */
export const MELLOW_QUEUE_PROBE_ACTOR = ethers.getAddress(
  "0xE08D97e151473A848C3d9CA3f323Cb720472D015",
);
export const MELLOW_QUEUE_PROBE_ACTOR_EVIDENCE_ID =
  "mellow-queue-probe-actor";

export function mellowQueueStaticProjection(descriptor: MellowQueueDescriptor) {
  return {
    queue: lowerAddress(descriptor.queue),
    vault: lowerAddress(descriptor.vault),
    asset: lowerAddress(descriptor.asset),
    share: lowerAddress(descriptor.share),
    oracle: lowerAddress(descriptor.oracle),
    feeManager: lowerAddress(descriptor.feeManager),
    kind: descriptor.kind,
    selector: descriptor.kind === "deposit"
      ? MELLOW_QUEUE_INTERFACE.getFunction("deposit")!.selector.toLowerCase()
      : MELLOW_QUEUE_INTERFACE.getFunction("redeem")!.selector.toLowerCase(),
    penaltyD6: descriptor.penaltyD6.toString(),
    maxAge: descriptor.maxAge,
  };
}

export function assertMellowQueueInvocation(
  descriptor: MellowQueueDescriptor,
  route: MellowQueueRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.queue,
    route,
    bindingFingerprint: hashCanonical(mellowQueueStaticProjection(descriptor)),
  });
  const deposit = descriptor.kind === "deposit";
  if (
    route.adapterId !== (deposit ? MELLOW_DEPOSIT_ADAPTER : MELLOW_REDEEM_ADAPTER) ||
    route.direction !== (deposit ? "deposit-to-share" : "redeem-to-asset") ||
    !sameAddress(route.tokenIn, deposit ? descriptor.asset : descriptor.share) ||
    !sameAddress(route.tokenOut, deposit ? descriptor.share : descriptor.asset)
  ) {
    throw new Error("mellow queue route is incompatible with its descriptor");
  }
}

function probeCaller(): CallerRef {
  return Object.freeze({
    kind: "verified-actor" as const,
    evidenceId: MELLOW_QUEUE_PROBE_ACTOR_EVIDENCE_ID,
  });
}

export function mellowDepositSimulation(input: {
  readonly id: string;
  readonly descriptor: MellowQueueDescriptor;
  readonly amountIn: bigint;
  readonly receiver: string;
}): AdapterRequest {
  const caller = probeCaller();
  const receiver = canonicalAddress(input.receiver);
  return Object.freeze({
    id: input.id,
    kind: "effect-delta-simulation" as const,
    call: Object.freeze({
      caller,
      executionMode: "impersonated-call-frame" as const,
      to: canonicalAddress(input.descriptor.queue),
      data: MELLOW_QUEUE_INTERFACE.encodeFunctionData("deposit", [
        input.amountIn,
        receiver,
        [],
      ]),
    }),
    overrideIntent: Object.freeze({
      caller,
      tokenBalances: Object.freeze([Object.freeze({
        token: canonicalAddress(input.descriptor.asset),
        amount: input.amountIn,
      })]),
    }),
    observeTokenBalances: Object.freeze([
      Object.freeze({ token: canonicalAddress(input.descriptor.asset), account: caller }),
      Object.freeze({ token: canonicalAddress(input.descriptor.share), account: caller }),
    ]),
    observeTotalSupplies: Object.freeze([canonicalAddress(input.descriptor.share)]),
    observe: Object.freeze([
      "return-data" as const,
      "token-delta" as const,
      "total-supply-delta" as const,
      "logs" as const,
    ]),
  });
}

export function mellowRedeemSimulation(input: {
  readonly id: string;
  readonly descriptor: MellowQueueDescriptor;
  readonly sharesIn: bigint;
  readonly receiver: string;
}): AdapterRequest {
  const caller = probeCaller();
  const receiver = canonicalAddress(input.receiver);
  return Object.freeze({
    id: input.id,
    kind: "effect-delta-simulation" as const,
    call: Object.freeze({
      caller,
      executionMode: "impersonated-call-frame" as const,
      to: canonicalAddress(input.descriptor.queue),
      data: MELLOW_QUEUE_INTERFACE.encodeFunctionData("redeem", [
        input.sharesIn,
        receiver,
      ]),
    }),
    overrideIntent: Object.freeze({
      caller,
      tokenBalances: Object.freeze([Object.freeze({
        token: canonicalAddress(input.descriptor.share),
        amount: input.sharesIn,
      })]),
    }),
    observeTokenBalances: Object.freeze([
      Object.freeze({ token: canonicalAddress(input.descriptor.share), account: caller }),
      Object.freeze({ token: canonicalAddress(input.descriptor.asset), account: caller }),
    ]),
    observeTotalSupplies: Object.freeze([canonicalAddress(input.descriptor.share)]),
    observe: Object.freeze([
      "return-data" as const,
      "token-delta" as const,
      "total-supply-delta" as const,
      "logs" as const,
    ]),
  });
}

function delta(
  result: Extract<AdapterRequestResult, { readonly ok: true }>,
  list: readonly { readonly token: string; readonly account?: string; readonly delta: bigint }[] | undefined,
  token: string,
  account: string,
): bigint {
  const rows = (list ?? []).filter((item) =>
    sameAddress(item.token, token) &&
    (item.account === undefined || sameAddress(item.account, account))
  );
  return rows.reduce((sum, item) => sum + item.delta, 0n);
}

export function validateMellowDeposit(input: {
  readonly result: Extract<AdapterRequestResult, { readonly ok: true }>;
  readonly descriptor: MellowQueueDescriptor;
  readonly amountIn: bigint;
}): { readonly shares: bigint } {
  if (input.result.completion !== "returned") {
    throw new Error("mellow deposit simulation did not return");
  }
  const assetDelta = delta(
    input.result,
    input.result.effects?.tokenDeltas,
    input.descriptor.asset,
    MELLOW_QUEUE_PROBE_ACTOR,
  );
  const shareDelta = delta(
    input.result,
    input.result.effects?.tokenDeltas,
    input.descriptor.share,
    MELLOW_QUEUE_PROBE_ACTOR,
  );
  if (assetDelta !== -input.amountIn || shareDelta <= 0n) {
    throw new Error("mellow deposit effects are not exact");
  }
  return Object.freeze({ shares: shareDelta });
}

export function validateMellowRedeem(input: {
  readonly result: Extract<AdapterRequestResult, { readonly ok: true }>;
  readonly descriptor: MellowQueueDescriptor;
  readonly sharesIn: bigint;
}): { readonly assets: bigint } {
  if (input.result.completion !== "returned") {
    throw new Error("mellow redeem simulation did not return");
  }
  const shareDelta = delta(
    input.result,
    input.result.effects?.tokenDeltas,
    input.descriptor.share,
    MELLOW_QUEUE_PROBE_ACTOR,
  );
  const assetDelta = delta(
    input.result,
    input.result.effects?.tokenDeltas,
    input.descriptor.asset,
    MELLOW_QUEUE_PROBE_ACTOR,
  );
  if (shareDelta !== -input.sharesIn || assetDelta <= 0n) {
    throw new Error("mellow redeem effects are not exact");
  }
  return Object.freeze({ assets: assetDelta });
}

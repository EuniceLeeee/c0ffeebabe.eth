import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CallerRef } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { assertRouteBound, canonicalAddress, lowerAddress, sameAddress } from "../standard-family/common.js";
import { ARCANA_SOURCE_INTERFACE } from "./abi.js";
import type { ArcanaDescriptor, ArcanaRoute } from "./types.js";

export const ARCANA_MIGRATION_ADAPTER = "arcana-migration" as const;

/** Historical executor; at N it has max allowance to the migration source. */
export const ARCANA_PROBE_ACTOR = ethers.getAddress("0xE08D97e151473A848C3d9CA3f323Cb720472D015");
export const ARCANA_PROBE_ACTOR_EVIDENCE_ID = "arcana-migration-probe-actor";

export const ARCANA_SAMPLE_AMOUNT = 1_000_000_000_000_000_000n;

export function arcanaStaticProjection(descriptor: ArcanaDescriptor) {
  return {
    source: lowerAddress(descriptor.source),
    destination: lowerAddress(descriptor.destination),
    oldToken: lowerAddress(descriptor.oldToken),
    arcToken: lowerAddress(descriptor.arcToken),
    tokenId: descriptor.tokenId.toLowerCase(),
    selector: ARCANA_SOURCE_INTERFACE.getFunction("lockAndBridge")!.selector.toLowerCase(),
    tokenDecimals: descriptor.tokenDecimals,
    tokenTwapValue: descriptor.tokenTwapValue.toString(),
    tokenMultiplier: descriptor.tokenMultiplier.toString(),
    multiplierScale: descriptor.multiplierScale.toString(),
  };
}

export function assertArcanaInvocation(descriptor: ArcanaDescriptor, route: ArcanaRoute): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.source,
    route,
    bindingFingerprint: hashCanonical(arcanaStaticProjection(descriptor)),
  });
  if (
    route.adapterId !== ARCANA_MIGRATION_ADAPTER ||
    route.direction !== "migrate-to-arc" ||
    !sameAddress(route.tokenIn, descriptor.oldToken) ||
    !sameAddress(route.tokenOut, descriptor.arcToken)
  ) {
    throw new Error("arcana route is incompatible with its descriptor");
  }
}

function probeCaller(): CallerRef {
  return Object.freeze({ kind: "verified-actor" as const, evidenceId: ARCANA_PROBE_ACTOR_EVIDENCE_ID });
}

export function arcanaMigrationSimulation(input: {
  readonly id: string;
  readonly descriptor: ArcanaDescriptor;
  readonly amountIn: bigint;
}): AdapterRequest {
  const caller = probeCaller();
  return Object.freeze({
    id: input.id,
    kind: "effect-delta-simulation" as const,
    call: Object.freeze({
      caller,
      executionMode: "impersonated-call-frame" as const,
      to: canonicalAddress(input.descriptor.source),
      data: ARCANA_SOURCE_INTERFACE.encodeFunctionData("lockAndBridge", [
        input.descriptor.tokenId,
        input.amountIn,
        ARCANA_PROBE_ACTOR,
      ]),
    }),
    overrideIntent: Object.freeze({
      caller,
      tokenBalances: Object.freeze([Object.freeze({
        token: canonicalAddress(input.descriptor.oldToken),
        amount: input.amountIn,
      })]),
    }),
    observeTokenBalances: Object.freeze([
      Object.freeze({ token: canonicalAddress(input.descriptor.oldToken), account: caller }),
      Object.freeze({ token: canonicalAddress(input.descriptor.arcToken), account: caller }),
    ]),
    observe: Object.freeze([
      "return-data" as const,
      "token-delta" as const,
      "total-supply-delta" as const,
      "logs" as const,
    ]),
  });
}

export function validateArcanaMigration(input: {
  readonly result: Extract<AdapterRequestResult, { readonly ok: true }>;
  readonly descriptor: ArcanaDescriptor;
  readonly amountIn: bigint;
}): { readonly arcOut: bigint } {
  if (input.result.completion !== "returned") {
    throw new Error("arcana migration simulation did not return");
  }
  const deltas = input.result.effects?.tokenDeltas ?? [];
  const oldDelta = deltas
    .filter((d) => sameAddress(d.token, input.descriptor.oldToken) && sameAddress(d.account, ARCANA_PROBE_ACTOR))
    .reduce((sum, d) => sum + d.delta, 0n);
  const arcDelta = deltas
    .filter((d) => sameAddress(d.token, input.descriptor.arcToken) && sameAddress(d.account, ARCANA_PROBE_ACTOR))
    .reduce((sum, d) => sum + d.delta, 0n);
  if (oldDelta !== -input.amountIn || arcDelta <= 0n) {
    throw new Error("arcana migration effects are not exact");
  }
  return Object.freeze({ arcOut: arcDelta });
}

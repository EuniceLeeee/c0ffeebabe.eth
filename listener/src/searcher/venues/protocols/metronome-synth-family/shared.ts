import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import type {
  MetronomeSynthDescriptor,
  MetronomeSynthDirection,
  MetronomeSynthRoute,
} from "./types.js";

export const METRONOME_SYNTH_POOL_INTERFACE = new ethers.Interface([
  "function doesSyntheticTokenExist(address syntheticToken) view returns (bool)",
  "function quoteSwapOut(address syntheticTokenIn,address syntheticTokenOut,uint256 amountIn) view returns (uint256 amountOut,uint256 fee)",
  "function swap(address syntheticTokenIn,address syntheticTokenOut,uint256 amountIn) returns (uint256 amountOut)",
]);
export const METRONOME_SYNTH_ERC20_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);
export const METRONOME_SYNTH_FORWARDER_INTERFACE = new ethers.Interface([
  "function forward(address target,bytes data)",
]);
export const METRONOME_SYNTH_SAMPLE = 10n ** 18n;
export const METRONOME_SYNTH_SUPPORTED_TOKENS = Object.freeze([
  canonicalAddress(ADDR.MSETH),
  canonicalAddress(ADDR.MSBTC),
  canonicalAddress(ADDR.MSUSD),
]);
export const METRONOME_SYNTH_ORACLE_BINDING = hashCanonical({
  forwarder: lowerAddress(ADDR.METRONOME_ORACLE_FORWARDER),
  oracle: lowerAddress(ADDR.METRONOME_ORACLE),
  selector: "0xb1dc65a4",
});

export function metronomeSynthDirectionsProjection(
  directions: readonly MetronomeSynthDirection[],
) {
  return directions.map((direction) => [
    lowerAddress(direction.tokenIn),
    lowerAddress(direction.tokenOut),
  ] as const).sort(([leftIn, leftOut], [rightIn, rightOut]) =>
    leftIn.localeCompare(rightIn) || leftOut.localeCompare(rightOut)
  );
}

export function metronomeSynthStaticProjection(
  descriptor: MetronomeSynthDescriptor,
) {
  return {
    pool: lowerAddress(descriptor.pool),
    tokens: descriptor.tokens.map(lowerAddress).sort(),
    directions: metronomeSynthDirectionsProjection(descriptor.directions),
    oracleBinding: descriptor.oracleBinding,
    quoteSemantics: "metronome-quote-swap-out-v1",
  };
}

export function assertMetronomeSynthInvocation(
  descriptor: MetronomeSynthDescriptor,
  route: MetronomeSynthRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.pool,
    route,
    bindingFingerprint: hashCanonical(
      metronomeSynthStaticProjection(descriptor),
    ),
  });
  if (
    route.adapterId !== "metronome-synth-swap" ||
    !descriptor.directions.some((direction) =>
      sameAddress(direction.tokenIn, route.tokenIn) &&
      sameAddress(direction.tokenOut, route.tokenOut)
    )
  ) {
    throw new Error("Metronome synth route lacks an active direction proof");
  }
}

export function metronomeSynthUniqueAddresses(
  values: readonly string[],
): string[] {
  return [...new Map(values.map((value) => {
    const address = canonicalAddress(value);
    return [lowerAddress(address), address] as const;
  })).values()].sort((left, right) =>
    lowerAddress(left).localeCompare(lowerAddress(right))
  );
}

export function metronomeSynthDirectedPairs(
  tokens: readonly string[],
): MetronomeSynthDirection[] {
  return tokens.flatMap((tokenIn) => tokens.flatMap((tokenOut) =>
    sameAddress(tokenIn, tokenOut)
      ? []
      : [{
          tokenIn: canonicalAddress(tokenIn),
          tokenOut: canonicalAddress(tokenOut),
        }]
  ));
}

export function metronomeSynthActiveQuoteId(
  direction: MetronomeSynthDirection,
): string {
  return `identity-quote:${lowerAddress(direction.tokenIn)}:${lowerAddress(direction.tokenOut)}`;
}

export function metronomeSynthCurrentRequestId(
  route: MetronomeSynthRoute,
): string {
  return `current:${lowerAddress(route.tokenIn)}:${lowerAddress(route.tokenOut)}`;
}

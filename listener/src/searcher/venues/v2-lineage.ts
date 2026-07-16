export type V2LineageVenueId =
  | "univ2"
  | "sushiswap-v2"
  | "pancake-v2"
  | "rigelswap"
  | "difx";

export interface V2MeasuredFeeRule {
  readonly kind: "constant-bps";
  readonly feeBps: bigint;
  readonly evidence: string;
}

export interface V2LineageDescriptor {
  readonly venue: V2LineageVenueId;
  readonly factory: string;
  readonly executionFamily: "univ2-standard";
  readonly runtimeAdapter: "univ2";
  readonly discoverable: boolean;
  readonly quotable: boolean;
  readonly buildable: boolean;
  readonly supportedInProd: boolean;
  /** Absent means the factory is not fee-verified and retains the legacy fallback. */
  readonly measuredFeeRule: V2MeasuredFeeRule | null;
}

/**
 * Single source for V2 factory provenance, execution compatibility, and
 * measured fee rules. A factory belongs here only when its lineage has been
 * investigated; production flags still fail closed independently.
 */
export const V2_LINEAGES: readonly V2LineageDescriptor[] = Object.freeze([
  Object.freeze({
    venue: "univ2",
    factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    executionFamily: "univ2-standard",
    runtimeAdapter: "univ2",
    discoverable: true,
    quotable: true,
    buildable: true,
    supportedInProd: true,
    measuredFeeRule: Object.freeze({
      kind: "constant-bps",
      feeBps: 30n,
      evidence: "canonical UniV2 997/1000 invariant",
    }),
  }),
  Object.freeze({
    venue: "sushiswap-v2",
    factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
    executionFamily: "univ2-standard",
    runtimeAdapter: "univ2",
    discoverable: true,
    quotable: true,
    buildable: true,
    supportedInProd: true,
    measuredFeeRule: Object.freeze({
      kind: "constant-bps",
      feeBps: 30n,
      evidence: "canonical SushiV2 997/1000 invariant",
    }),
  }),
  Object.freeze({
    venue: "pancake-v2",
    factory: "0x1097053fd2ea711dad45caccc45eff7548fcb362",
    executionFamily: "univ2-standard",
    runtimeAdapter: "univ2",
    discoverable: true,
    quotable: true,
    buildable: true,
    supportedInProd: true,
    measuredFeeRule: Object.freeze({
      kind: "constant-bps",
      feeBps: 25n,
      evidence:
        "fork-swap verified 2026-07-14 on pair 0x17C1Ae82D99379240059940093762c5e4539aba5",
    }),
  }),
  Object.freeze({
    venue: "rigelswap",
    factory: "0x880AE0A0aF8FF8f31F51599891baa8A65dB5e152",
    executionFamily: "univ2-standard",
    runtimeAdapter: "univ2",
    discoverable: false,
    quotable: true,
    buildable: true,
    supportedInProd: false,
    measuredFeeRule: null,
  }),
  Object.freeze({
    venue: "difx",
    factory: "0xe5aaA01C4732d6B20cBb8522803f84a2cDf96334",
    executionFamily: "univ2-standard",
    runtimeAdapter: "univ2",
    discoverable: false,
    quotable: true,
    buildable: true,
    supportedInProd: false,
    measuredFeeRule: null,
  }),
]);

export function findV2LineageByFactory(
  factory: string | null | undefined,
): V2LineageDescriptor | null {
  if (!factory) return null;
  const normalized = factory.toLowerCase();
  return V2_LINEAGES.find((descriptor) =>
    descriptor.factory.toLowerCase() === normalized
  ) ?? null;
}

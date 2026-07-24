import {
  BLIND_SCHEMA_VERSION,
} from "../adapter-family-blind-contract.js";
import {
  CONVERSION_PRIVATE_PREDICATE_PROFILE,
  type ConversionFreshnessPrivatePredicate,
} from "../conversion-freshness-oracle.js";

/**
 * Trusted-oracle-only fixture. None of these values may enter a producer
 * manifest, production closure, candidate injection, or challenger config.
 */
export const WSTETH_FRESHNESS_INTEGRATION_RANGE = Object.freeze({
  fromBlock: 25_300_000,
  toBlock: 25_595_500,
});

export const WSTETH_FRESHNESS_KNOWN_CANDIDATES = Object.freeze([
  25_588_234,
  25_595_395,
] as const);

export function wstethFreshnessPrivatePredicate():
ConversionFreshnessPrivatePredicate {
  const steth = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
  const wsteth = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0";
  return {
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: CONVERSION_PRIVATE_PREDICATE_PROFILE,
    predicateVersion: "conversion-update-event-v1",
    chainId: 1,
    protocol: "wsteth",
    instanceAddress: wsteth,
    event: {
      address: steth,
      topic0:
        "0xff08c3ef606d198e316ef5b822193c489965899eb4e3c248cea1a4626c3eda50",
    },
    topologyReads: [
      {
        id: "event-source-code",
        kind: "code",
        address: steth,
      },
      {
        id: "instance-code",
        kind: "code",
        address: wsteth,
      },
      {
        id: "underlying-link",
        kind: "call",
        to: wsteth,
        data: "0xc1fe3e48",
      },
    ],
    rateReads: [
      {
        id: "get-steth-by-wsteth",
        kind: "call",
        to: wsteth,
        data:
          "0xbb2952fc0000000000000000000000000000000000000000000000000de0b6b3a7640000",
      },
      {
        id: "get-wsteth-by-steth",
        kind: "call",
        to: wsteth,
        data:
          "0xb0e389000000000000000000000000000000000000000000000000000de0b6b3a7640000",
      },
    ],
  };
}

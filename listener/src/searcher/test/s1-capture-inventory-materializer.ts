import assert from "node:assert/strict";
import {
  materializeCaptureInventory,
  type CaptureInventoryProvider,
} from "../materialize-s1-capture-inventory.js";
import { familyId } from "../venues/adapter-family-identifiers.js";
import type { UnifiedObservation } from
  "../venues/adapter-family-plugin.js";
import type { FamilyCapabilityCatalog } from
  "../venues/family-capability-catalog.js";

const FAMILY = familyId("synthetic:inventory");
const ACTION = "synthetic-inventory-action";
const ADDRESS = `0x${"12".repeat(20)}`;
const SELECTOR = "0x12345678";
const TX_HASH = `0x${"78".repeat(32)}`;
const plugin = Object.freeze({
  manifest: Object.freeze({ familyId: FAMILY, domain: "protocol" as const }),
  discovery: Object.freeze({
    sources: Object.freeze(["observed-call" as const]),
    callPatterns: Object.freeze([Object.freeze({
      id: "synthetic-call",
      selector: SELECTOR,
    })]),
    decodeCandidate: (input: {
      readonly observation: UnifiedObservation;
      readonly matchedPatternId: string;
    }) => input.observation.kind === "call" &&
        input.matchedPatternId === "synthetic-call"
      ? Object.freeze({
          candidateKind: "synthetic",
          address: input.observation.target,
        })
      : null,
    candidateKey: (candidate: { readonly address: string }) => candidate.address,
  }),
});
const family = Object.freeze({ plugin });
const catalog = Object.freeze({
  catalogHash: "a".repeat(64),
  listAll: () => Object.freeze([family]),
  forStrictFamily: (id: string) => {
    if (id !== FAMILY) throw new Error("unknown synthetic Family");
    return family;
  },
  ownerOfAction: (id: string) => {
    if (id !== ACTION) throw new Error("unknown synthetic action");
    return FAMILY;
  },
  matches: (observation: UnifiedObservation) => observation.kind === "call" &&
      observation.data.slice(0, 10).toLowerCase() === SELECTOR
    ? Object.freeze([Object.freeze({
        familyId: FAMILY,
        patternId: "synthetic-call",
      })])
    : Object.freeze([]),
}) as unknown as FamilyCapabilityCatalog;

const source = Object.freeze({
  number: 100,
  hash: `0x${"ab".repeat(32)}`,
  generation: 100,
});
const provider: CaptureInventoryProvider = {
  call: async () => "0x",
  getCode: async () => "0x01",
  getStorage: async () => `0x${"00".repeat(32)}`,
  getLogs: async () => Object.freeze([]),
  getTransactionReceipt: async () => Object.freeze({
    blockNumber: 99,
    logs: Object.freeze([]),
  }),
  traceTransaction: async () => Object.freeze({
    to: ADDRESS,
    from: `0x${"56".repeat(20)}`,
    input: SELECTOR,
  }),
};

const inventory = await materializeCaptureInventory({
  catalog,
  source,
  rawArtifacts: Object.freeze({
    graph: Object.freeze({
      pools: Object.freeze([Object.freeze({
        arbitraryLabel: ACTION,
        arbitraryAddress: ADDRESS,
      })]),
    }),
    protocolCache: Object.freeze({
      evidence: Object.freeze([Object.freeze({ txHash: TX_HASH })]),
      family: ACTION,
    }),
  }),
  provider,
});
assert.equal(inventory.entries.length, 1);
assert.equal(inventory.entries[0]?.familyId, FAMILY);
assert.equal(inventory.entries[0]?.candidateIdentity, ADDRESS);
assert.equal(inventory.unresolved.length, 0);
console.log("S1 capture inventory materializer PASS");

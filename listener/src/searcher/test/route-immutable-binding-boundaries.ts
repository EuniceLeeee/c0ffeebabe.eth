import assert from "node:assert/strict";
import {
  blindCompatibilityCanonicalEdgeId,
  blindCompatibilityPoolIdentity,
} from "../blind-production-compatibility.js";
import { blindProductionAuditHash } from "../blind-production-audit.js";
import { blockScanRouteId } from "../blockscan-route-identity.js";
import type {
  PoolEntry,
  TokenEdge,
  TokenQueryBackend,
} from "../planner/token-graph.js";
import { poolRegistryKey } from "../pool-registry-key.js";
import { hashTokenGraph } from "../strategy-views.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  blockScanEdgeKey,
  blockScanEdgeMetadataFingerprint,
  stateSchemaFingerprint,
} from "../venues/blockscan-state-capability.js";
import { RouteLegRegistry } from "../venues/route-leg-registry.js";
import {
  edgeExecutionVariantKey,
  routeInstanceKey,
} from "../venues/route-instance-identity.js";
import {
  createRouteImmutableBinding,
  validateRouteImmutableBinding,
} from "../venues/route-immutable-binding.js";

const TOKEN_A = "0x0000000000000000000000000000000000000001";
const TOKEN_B = "0x0000000000000000000000000000000000000002";
const POOL = "0x0000000000000000000000000000000000000010";

const binding = createRouteImmutableBinding(
  "fixture.route.v1",
  "0x0102",
);
const siblingBinding = createRouteImmutableBinding(
  "fixture.route.v1",
  "0x0506",
);
const tamperedBinding = {
  ...binding,
  payload: "0x0304",
};

assert.deepEqual(
  validateRouteImmutableBinding(JSON.parse(JSON.stringify(binding))),
  binding,
  "binding must survive JSON persistence with the same content address",
);
assert.throws(
  () => validateRouteImmutableBinding(tamperedBinding),
  /route immutable binding hash mismatch/,
  "a payload change with a stale inner hash must fail closed",
);

const edge: TokenEdge = {
  adapterId: "univ2-swap",
  target: POOL,
  tokenIn: TOKEN_A,
  tokenOut: TOKEN_B,
  slotKind: "swap",
  ...deriveEdgeTaxonomy("swap"),
};
const legacyUnboundVariantKey = JSON.stringify([
  edge.adapterId,
  null,
  null,
  null,
  null,
]);
assert.equal(
  edgeExecutionVariantKey(edge),
  legacyUnboundVariantKey,
  "an absent binding must not migrate the frozen legacy execution identity",
);
assert.equal(
  blockScanEdgeKey(edge),
  [
    POOL,
    POOL,
    TOKEN_A,
    TOKEN_B,
    "swap",
    "",
    legacyUnboundVariantKey,
  ].join("\u001f"),
  "an absent binding must not migrate the frozen legacy state edge key",
);
assert.equal(
  stateSchemaFingerprint([edge]),
  "05251a015cce80f14911abb4b08d1e0965ef32fb7630cdd7f4c117113e5111df",
  "an absent binding must not migrate the frozen legacy state schema",
);
assert.equal(
  blockScanEdgeMetadataFingerprint(edge),
  "66f0cb66d333d726670d015dbdec52c3c3a950153e6570d82a6ec02c8c9dc402",
  "an absent binding must not migrate the frozen legacy edge metadata",
);
assert.equal(
  hashTokenGraph([edge]),
  "0x75c89340d127d2f7e1c4c68b78ba06b1ee92ddd8d5519a052a0ff0ca888a3a45",
  "an absent binding must not migrate the frozen legacy graph hash",
);
assert.equal(
  blindCompatibilityCanonicalEdgeId(edge),
  "edge:0100c1ef337990cd0d425a90ec6ceb3e49c0ea9fd5711a3901c0baa93bfe7567",
  "an absent binding must not migrate frozen blind edge evidence",
);
const pool: PoolEntry = {
  address: POOL,
  adapter: "univ2",
  token0: TOKEN_A,
  token1: TOKEN_B,
};

assert.equal(
  poolRegistryKey(pool),
  POOL,
  "an absent binding must not migrate the frozen legacy registry identity",
);
assert.equal(
  blindProductionAuditHash([blindCompatibilityPoolIdentity(pool)]),
  "50c7e4179f7ea054b77147eb58c77496a8b3214da9865d61de24cb2ade4c0cd6",
  "an absent binding must not migrate frozen blind pool evidence",
);
assert.notEqual(
  poolRegistryKey({ ...pool, routeBinding: binding }),
  poolRegistryKey({ ...pool, routeBinding: siblingBinding }),
  "binding-only physical instances must not collapse",
);
assert.throws(
  () => poolRegistryKey({ ...pool, routeBinding: tamperedBinding }),
  /route immutable binding hash mismatch/,
  "registry identity must reject tampered bindings",
);
assert.notEqual(
  poolRegistryKey({
    ...pool,
    logicalInstanceId: "left:right",
    poolId: "tail",
    routeBinding: binding,
  }),
  poolRegistryKey({
    ...pool,
    logicalInstanceId: "left",
    poolId: "right:tail",
    routeBinding: binding,
  }),
  "binding-aware registry tuples must not collide through delimiter injection",
);

const identityFamily = {
  id: "fixture-route-binding",
  routeIdentity: {
    instanceKey: () => POOL,
    executionVariantKey: () => "fixture-swap",
  },
};
assert.notEqual(
  routeInstanceKey(identityFamily, { ...pool, routeBinding: binding }),
  routeInstanceKey(identityFamily, {
    ...pool,
    routeBinding: siblingBinding,
  }),
  "shared route identity must retain binding identity",
);

const boundEdge = { ...edge, routeBinding: binding };
const siblingEdge = { ...edge, routeBinding: siblingBinding };
assert.notEqual(
  edgeExecutionVariantKey(boundEdge),
  edgeExecutionVariantKey(siblingEdge),
  "legacy unbound edge fallback must distinguish binding-only variants",
);
assert.notEqual(
  blockScanEdgeKey(boundEdge),
  blockScanEdgeKey(siblingEdge),
  "state edge keys must distinguish binding-only routes",
);
assert.notEqual(
  blockScanRouteId([boundEdge]),
  blockScanRouteId([siblingEdge]),
  "reject-blacklist route keys must distinguish binding-only routes",
);
assert.notEqual(
  stateSchemaFingerprint([boundEdge]),
  stateSchemaFingerprint([siblingEdge]),
  "state schemas must bind immutable execution metadata",
);
assert.notEqual(
  blockScanEdgeMetadataFingerprint(boundEdge),
  blockScanEdgeMetadataFingerprint(siblingEdge),
  "edge metadata fingerprints must bind immutable execution metadata",
);
assert.notEqual(
  hashTokenGraph([boundEdge]),
  hashTokenGraph([siblingEdge]),
  "runtime graph hashes must distinguish binding-only routes",
);
assert.notEqual(
  blindCompatibilityCanonicalEdgeId(boundEdge),
  blindCompatibilityCanonicalEdgeId(siblingEdge),
  "trusted blind edge evidence must distinguish binding-only routes",
);
assert.notEqual(
  blindProductionAuditHash([
    blindCompatibilityPoolIdentity({
      ...pool,
      routeBinding: binding,
    }),
  ]),
  blindProductionAuditHash([
    blindCompatibilityPoolIdentity({
      ...pool,
      routeBinding: siblingBinding,
    }),
  ]),
  "trusted blind pool evidence must distinguish binding-only routes",
);

let buildCalls = 0;
let emittedBinding = binding;
const fixtureFamily = {
  id: "fixture-route-binding",
  kind: "swap",
  poolAdapters: ["univ2"],
  edgeAdapterIds: ["univ2-swap"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  routeIdentity: identityFamily.routeIdentity,
  async buildEdges(): Promise<TokenEdge[]> {
    buildCalls++;
    return [{ ...edge, routeBinding: emittedBinding }];
  },
};
const registry = new RouteLegRegistry([fixtureFamily as never]);
const noReadBackend: TokenQueryBackend = {
  async call() {
    throw new Error("binding boundary must not read chain state");
  },
};
await assert.rejects(
  registry.buildEdges(
    { ...pool, routeBinding: tamperedBinding },
    noReadBackend,
  ),
  /route immutable binding hash mismatch/,
  "tampered pool metadata must fail before the family callback",
);
assert.equal(buildCalls, 0);

emittedBinding = siblingBinding;
await assert.rejects(
  registry.buildEdges(
    { ...pool, routeBinding: binding },
    noReadBackend,
  ),
  /mismatched immutable route binding/,
  "a family cannot replace the admitted pool binding on its edge",
);

console.log("route immutable binding boundary tests passed");

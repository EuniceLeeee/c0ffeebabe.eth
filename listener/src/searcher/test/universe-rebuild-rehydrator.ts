import assert from "node:assert/strict";
import {
  assertIssuedFamilyRouteRuntimeHandle,
  reissuePreparedInstanceRouteHandles,
} from "../venues/adapter-family-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "../venues/production-family-composition.js";
import { createRebuildWiring } from "../universe-rebuild-production.js";
import type { DurableVerifiedMemo } from "../universe-rebuild-checkpoint.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_750_000,
  hash: "0x" + "a1".repeat(32),
  generation: 1,
});
const FAMILY_ID = "univ2-standard";
const INSTANCE_KEY = "0x" + "11".repeat(20);
const ROUTE_KEY = "univ2:" + INSTANCE_KEY + ":0:1";

function routeDescriptor(): unknown {
  return Object.freeze({
    routeKey: ROUTE_KEY,
    familyId: FAMILY_ID,
    lineageId: FAMILY_ID + ":lineage",
    instanceKey: INSTANCE_KEY,
    tokenIn: "0x" + "22".repeat(20),
    tokenOut: "0x" + "33".repeat(20),
    taxonomy: Object.freeze([{ slotKind: "swap" }]),
    bindingRef: Object.freeze({ bindingKey: "b", fingerprint: "bf" }),
    runtimeRequirements: Object.freeze([]),
  });
}

function memoFor(): DurableVerifiedMemo {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
    .forStrictFamily(FAMILY_ID as never);
  return Object.freeze({
    familyCandidateKey: "cand:key",
    familyInstanceKey: "inst:key",
    familyId: FAMILY_ID,
    candidateKey: INSTANCE_KEY,
    instanceKey: INSTANCE_KEY,
    candidateFingerprint: "cf",
    familyDefinitionHash: "fdh",
    validity: Object.freeze({
      policy: "immutable-code",
      authorityFingerprint: "fdh",
      proofSource: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    }),
    verifiedIdentity: Object.freeze({ lineageId: FAMILY_ID + ":lineage" }),
    compiledDescriptor: Object.freeze({
      familyId: FAMILY_ID,
      instanceKey: INSTANCE_KEY,
      lineageId: FAMILY_ID + ":lineage",
    }),
    staticProjection: Object.freeze({ routes: Object.freeze([routeDescriptor()]) }),
    evidenceFingerprint: "ef",
    memoFingerprint: "mf",
  }) as DurableVerifiedMemo;
}

async function main(): Promise<void> {
  const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
  const family = catalog.forStrictFamily(FAMILY_ID as never);
  const route = routeDescriptor() as never;
  const instance = Object.freeze({
    familyId: FAMILY_ID,
    lineageId: FAMILY_ID + ":lineage",
    candidateKey: INSTANCE_KEY,
    instanceKey: INSTANCE_KEY,
    descriptor: Object.freeze({ familyId: FAMILY_ID, instanceKey: INSTANCE_KEY }),
    routes: Object.freeze([route]),
    routeHandles: Object.freeze([]),
    pricingInstances: Object.freeze([]),
    staticBindingFingerprint: "sb",
    staticEvidenceFingerprint: "se",
    evidenceRefs: Object.freeze([]),
  }) as never;

  // Direct central reissuance: fresh handles bound to the stored route.
  const rehydrated = reissuePreparedInstanceRouteHandles({
    family: family as never,
    instance,
    source: SOURCE,
    generation: SOURCE.generation,
  });
  assert.equal(rehydrated.routeHandles.length, 1);
  assert.equal(rehydrated.routeHandles[0]?.routeKey, ROUTE_KEY);
  assertIssuedFamilyRouteRuntimeHandle(family as never, rehydrated.routeHandles[0]);

  // Wiring-level rehydration from a memo (audit §9): no identity RPC, the
  // rebuilt instance carries re-issued handles at the memo's proof source.
  const wiring = createRebuildWiring({
    rpcUrl: "http://127.0.0.1:1", // never contacted during rehydration
  });
  const rebuilt = wiring.rehydrateVerifiedInstance({
    memo: memoFor(),
    cutoff: SOURCE,
  }) as { readonly routeHandles?: readonly unknown[]; readonly familyInstanceKey: string };
  assert.equal(rebuilt.familyInstanceKey, "inst:key");
  assert.equal(
    (rebuilt.routeHandles ?? []).length,
    1,
    "memo rehydration must re-issue the route handles",
  );
  const rebuiltFamily = catalog.forStrictFamily(FAMILY_ID as never);
  assertIssuedFamilyRouteRuntimeHandle(
    rebuiltFamily as never,
    (rebuilt.routeHandles as never[])[0],
  );

  console.log("universe rebuild rehydrator PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

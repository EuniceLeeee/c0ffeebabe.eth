import assert from "node:assert/strict";
import {
  extractInstanceAddress,
  reverifyCarriedInstanceContinuity,
} from "../strict-carry-continuity.js";
import {
  runWstethLifecycle,
  wstethFixtureRuntime,
} from "../architecture-migration-fixture-replay.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import { WSTETH_FAMILY_ID } from
  "../venues/protocols/wsteth-family/manifest.js";
import type { PreparedFamilyInstance } from
  "../venues/adapter-family-runtime.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"61".repeat(32)}`,
  generation: 44,
});
const CURRENT: CanonicalSource = Object.freeze({
  number: SOURCE.number + 40,
  hash: `0x${"62".repeat(32)}`,
  generation: 45,
});
const CODE_HASH = `0x${"11".repeat(32)}`;
const IMPLEMENTATION_WORD = `0x${"22".repeat(32)}`;

async function main(): Promise<void> {
  const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
  const publication = await runWstethLifecycle(SOURCE, catalog);
  const instance = publication.instances[0];
  assert(instance, "wsteth lifecycle must stage one instance");

  const address = extractInstanceAddress(instance);
  assert.match(
    address ?? "",
    /^0x[0-9a-fA-F]{40}$/,
    "compiled identity provenance must expose the instance address",
  );

  // No address provenance: the carry stays fail-closed without any read.
  const addressless: PreparedFamilyInstance = Object.freeze({
    ...instance,
    descriptor: Object.freeze({
      ...instance.descriptor,
      provenance: Object.freeze([]),
    }),
  });
  assert.equal(extractInstanceAddress(addressless), null);
  assert.equal(
    await reverifyCarriedInstanceContinuity({
      catalog,
      familyId: WSTETH_FAMILY_ID,
      instance: addressless,
      current: CURRENT,
      runtime: wstethFixtureRuntime(),
      readAddressSurface: async () => {
        throw new Error("surface must not be read for an addressless instance");
      },
    }),
    null,
  );

  // Unreadable current surface: fail-closed, no evidence.
  assert.equal(
    await reverifyCarriedInstanceContinuity({
      catalog,
      familyId: WSTETH_FAMILY_ID,
      instance,
      current: CURRENT,
      runtime: wstethFixtureRuntime(),
      readAddressSurface: async () => null,
    }),
    null,
  );

  // Continuity re-verified: the surface read is pinned to the current source
  // and the re-issued lifecycle keeps the same instance identity.
  const reads: {
    at: CanonicalSource | null;
    target: string | null;
  } = { at: null, target: null };
  const evidenceRef = await reverifyCarriedInstanceContinuity({
    catalog,
    familyId: WSTETH_FAMILY_ID,
    instance,
    current: CURRENT,
    runtime: wstethFixtureRuntime(),
    readAddressSurface: async (target, at) => {
      reads.target = target;
      reads.at = at;
      return Object.freeze({
        codeHash: CODE_HASH,
        implementationWord: IMPLEMENTATION_WORD,
      });
    },
  });
  assert(evidenceRef !== null, "verified continuity must return an evidence ref");
  assert.match(evidenceRef, /^central:state-continuity:/);
  assert.equal(reads.at?.number, CURRENT.number);
  assert.equal(reads.target, address);

  // A lifecycle that cannot re-issue the same identity returns no evidence.
  const foreignInstance: PreparedFamilyInstance = Object.freeze({
    ...instance,
    instanceKey: "instance:deadbeef" as never,
    descriptor: Object.freeze({
      ...instance.descriptor,
      provenance: Object.freeze([Object.freeze({
        kind: "subject",
        subject: `0x${"dd".repeat(20)}`,
      })]),
    }),
  });
  assert.equal(
    await reverifyCarriedInstanceContinuity({
      catalog,
      familyId: WSTETH_FAMILY_ID,
      instance: foreignInstance,
      current: CURRENT,
      runtime: wstethFixtureRuntime(),
      readAddressSurface: async () => Object.freeze({
        codeHash: CODE_HASH,
        implementationWord: IMPLEMENTATION_WORD,
      }),
    }),
    null,
    "an identity the lifecycle cannot re-issue must fail closed",
  );

  console.log("strict carry continuity PASS");
}

main();

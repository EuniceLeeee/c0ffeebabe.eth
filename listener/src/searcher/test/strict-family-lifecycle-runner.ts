import assert from "node:assert/strict";
import {
  runStrictFamilyLifecycle,
} from "../strict-family-lifecycle-runner.js";
import {
  wstethFixtureRuntime,
} from "../architecture-migration-fixture-replay.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";
import { WSTETH_FAMILY_ID } from
  "../venues/protocols/wsteth-family/manifest.js";
import { WSTETH_INTERFACE } from
  "../venues/protocols/wsteth-family/codec.js";

const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";

async function main(): Promise<void> {
  const publication = await runStrictFamilyLifecycle({
    catalog,
    familyId: WSTETH_FAMILY_ID,
    source: SOURCE,
    observations: Object.freeze([Object.freeze({
      kind: "call" as const,
      source: SOURCE,
      target: WSTETH,
      data: `${WSTETH_INTERFACE.getFunction("wrap")!.selector}${"0".repeat(64)}`,
    })]),
    runtime: wstethFixtureRuntime(),
  });
  assert(publication.instances.length >= 1);
  assert.equal(publication.instances[0]!.familyId, WSTETH_FAMILY_ID);

  await assert.rejects(
    () => runStrictFamilyLifecycle({
      catalog,
      familyId: WSTETH_FAMILY_ID,
      source: SOURCE,
      observations: Object.freeze([Object.freeze({
        kind: "call" as const,
        source: SOURCE,
        target: WSTETH,
        data: `0x${"00".repeat(4)}`,
      })]),
      runtime: wstethFixtureRuntime(),
    }),
    /no matched observation/,
  );
  console.log("strict-family-lifecycle-runner PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

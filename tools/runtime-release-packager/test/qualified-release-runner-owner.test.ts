import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import * as packager from "../src/index.ts";
import { CANONICAL_LIMITS, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  issueDeploymentReleaseClockV1,
  readDeploymentReleaseClockUnixNsV1,
} from "../src/internal/deployment-clock-owner.ts";
import {
  installQualifiedReleaseAcceptanceRunnerV1,
  observeQualifiedReleaseAcceptanceAdvisoryV1,
  readQualifiedReleaseLineageObservationV1,
} from "../src/assembled-release-acceptance.ts";

test("qualified release lineage projection rejects structural clones", () => {
  assert.throws(
    () => readQualifiedReleaseLineageObservationV1(Object.freeze({})),
    /not packager-loader-issued/,
  );
});

test("qualified runner rejects a structural capability before reading a material source", async () => {
  let sourceRead = false;
  const source = Object.freeze({
    get value() {
      sourceRead = true;
      throw new Error("source must remain unread");
    },
  });
  await assert.rejects(
    observeQualifiedReleaseAcceptanceAdvisoryV1(Object.freeze({}), source),
    /was not packager-loader-issued/,
  );
  assert.equal(sourceRead, false);
});

test("qualified runner installation cannot be opened by raw material or a signer callback", () => {
  assert.throws(
    () => installQualifiedReleaseAcceptanceRunnerV1({
      boundaryReceipt: Object.freeze({}),
      runtimeBinding: Object.freeze({}),
      runtimeSignerPin: Object.freeze({}),
      externalQualifications: [],
      predicateMaterials: [],
      signer: () => "forbidden",
      gateCoreInput: Object.freeze({ verdict: "pass" }),
    } as never),
    /unknown field "signer"/,
  );
});

test("public packager surface is read-only verification", () => {
  assert.equal("issueCommonEnvelopeAuthorityPortV1" in packager, false);
  assert.equal("evaluateGateCoreRuntime" in packager, false);
  assert.equal("assembleReleaseGateInvocations" in packager, false);
  assert.equal("installQualifiedReleaseAcceptanceRunnerV1" in packager, false);
  assert.equal("runQualifiedReleaseAcceptanceV1" in packager, false);
  assert.equal("readQualifiedReleaseLineageObservationV1" in packager, false);
  assert.equal("observeProductionReleaseAcceptanceAdvisoryV1" in packager, false);
  assert.equal("prepareProductionReleaseAcceptanceV1" in packager, false);
  assert.equal("prepareProductionReleasePackageV1" in packager, false);
  assert.equal("completeProductionReleasePackageV1" in packager, false);
  assert.equal("issueDeploymentReleaseClockV1" in packager, false);
  assert.equal("readDeploymentReleaseClockUnixNsV1" in packager, false);
  assert.equal(typeof packager.verifyRuntimeReleaseBindingSignatureV1, "function");
  assert.equal(typeof packager.decodeReleasePackageManifestV1, "function");
  assert.equal(typeof packager.verifyReleasePackageDirectoryV1, "function");
  assert.equal(typeof packager.verifyInstalledReleaseV1, "function");
});

test("public loader does not execute the qualified runner or GateCore before Boundary", () => {
  const loader = readFileSync(new URL("../src/assembled-release-acceptance.ts", import.meta.url), "utf8");
  assert.match(loader, /import type \{[^;]+from "\.\/internal\/qualified-release-runner-owner\.ts";/);
  assert.doesNotMatch(loader, /import\s+(?!type\b)[^;]+from "\.\/internal\/qualified-release-runner-owner\.ts";/);
  assert.equal(existsSync(new URL("../src/internal/assembled-release-acceptance-owner.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("../src/internal/production-release-workflow-owner.ts", import.meta.url)), false);
});

function installWithArrays(externalQualifications: unknown, predicateMaterials: unknown): void {
  installQualifiedReleaseAcceptanceRunnerV1({
    boundaryReceipt: Object.freeze({}),
    runtimeBinding: Object.freeze({}),
    runtimeSignerPin: Object.freeze({}),
    externalQualifications,
    predicateMaterials,
  } as never);
}

test("qualified runner rejects hostile denominator arrays without executing traps or accessors", () => {
  let traps = 0;
  const proxied = new Proxy([], {
    getOwnPropertyDescriptor() { traps += 1; throw new Error("trap must not execute"); },
    ownKeys() { traps += 1; throw new Error("trap must not execute"); },
    get() { traps += 1; throw new Error("trap must not execute"); },
  });
  assert.throws(() => installWithArrays([], proxied), /must not be a Proxy/);
  assert.equal(traps, 0);

  let accessorReads = 0;
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    configurable: true,
    get() { accessorReads += 1; throw new Error("accessor must not execute"); },
  });
  accessor.length = 1;
  assert.throws(() => installWithArrays(accessor, []), /enumerable data property/);
  assert.equal(accessorReads, 0);

  assert.throws(() => installWithArrays(new Array(1), []), /dense exact array/);
  const extra = Object.assign([], { extra: true });
  assert.throws(() => installWithArrays(extra, []), /dense exact array/);
  assert.throws(() => installWithArrays(new Array(CANONICAL_LIMITS.maxArrayItems + 1), []), /array length invalid/);
});

test("deployment clock is opaque, release-bound, clone-resistant, and caller time is not accepted", () => {
  const first = hashDomain("test/deployment-clock/v1", "first") as Hash;
  const second = hashDomain("test/deployment-clock/v1", "second") as Hash;
  const clock = issueDeploymentReleaseClockV1(first);
  assert.match(readDeploymentReleaseClockUnixNsV1(clock, first), /^(0|[1-9][0-9]*)$/);
  assert.throws(() => readDeploymentReleaseClockUnixNsV1(clock, second), /runtime binding mismatch/);
  assert.throws(() => readDeploymentReleaseClockUnixNsV1(Object.freeze({}), first), /not deployment-owner-issued/);
  assert.throws(() => installQualifiedReleaseAcceptanceRunnerV1({
    boundaryReceipt: Object.freeze({}),
    runtimeBinding: Object.freeze({}),
    runtimeSignerPin: Object.freeze({}),
    externalQualifications: [],
    predicateMaterials: [],
    nowUnixNs: "1",
  } as never), /unknown field "nowUnixNs"/);
});

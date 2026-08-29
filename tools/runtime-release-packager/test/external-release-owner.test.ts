import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sealAssembledReleaseAcceptanceResultsV1 } from "../../../acceptance/gate-core/src/internal/assembled-acceptance-owner.ts";
import { prepareAssembledReleaseAcceptanceV1 } from "../src/external-release-owner.ts";
import {
  completeFrozenProductionArtifactBaseV1,
  materializeFrozenProductionArtifactBaseV1,
  materializeApprovedProductionReleasePackageV1,
  materializePreparedProductionReleasePackageV1,
  prepareFrozenProductionArtifactBaseV1,
  readProductionReleasePackageSigningRequestV1,
} from "../src/external-release-owner.ts";
import { readProductionReleaseAcceptanceSigningRequestV1 } from "../src/production-workflow.ts";
import { installApprovedProductionReleaseV1 } from "../src/production-install-owner.ts";
import { PACKAGE_INSTALL_PATHS_V1 } from "../src/deployment-package.ts";

function hostile(label: string): object {
  return Object.freeze(Object.defineProperty({}, "value", {
    enumerable: true,
    get() { throw new Error(`${label} must remain unread`); },
  }));
}

test("external release owner rejects incomplete structural clones before reading signed inputs", () => {
  assert.throws(() => prepareAssembledReleaseAcceptanceV1({
    invocationSet: Object.freeze({}),
    runtimeBinding: hostile("binding"),
    runtimeSignerPin: hostile("pin"),
    externalQualifications: Object.freeze([]),
  } as never), /incomplete or was not evaluated/);
});

test("external release owner rejects a non-pass GateCore result before forming signing bytes", () => {
  const invocationSet = Object.freeze(Object.create(null));
  sealAssembledReleaseAcceptanceResultsV1(invocationSet, [Object.freeze({
    verdict: "fail" as const,
    certificate: Object.freeze({}),
    reasons: Object.freeze([]),
  }) as never]);
  assert.throws(() => prepareAssembledReleaseAcceptanceV1({
    invocationSet,
    runtimeBinding: hostile("binding"),
    runtimeSignerPin: hostile("pin"),
    externalQualifications: Object.freeze([]),
  } as never), /denominator did not pass/);
});

test("frozen production base rejects a structural prepared-acceptance forgery before reading artifacts", () => {
  const forgedPreparedAcceptance = Object.freeze({
    acceptanceCertificates: Object.freeze([]),
    releaseAcceptanceSet: hostile("set"),
    signingInput: hostile("input"),
    signingBytes: new Uint8Array(),
  });
  assert.throws(
    () => prepareFrozenProductionArtifactBaseV1(Object.freeze({
      preparedAcceptanceCapability: forgedPreparedAcceptance,
      stagingArtifacts: hostile("staging artifacts"),
      stagingArtifactBytes: hostile("staging bytes"),
    }) as never),
    /not qualified-runner-issued/,
  );
  assert.throws(
    () => readProductionReleaseAcceptanceSigningRequestV1(forgedPreparedAcceptance),
    /not qualified-runner-issued/,
  );
});

test("frozen A is opaque and structural clones cannot become B or durable A", () => {
  const forgedBase = Object.freeze({
    schemaVersion: 1,
    kind: "aloha.frozen-production-artifact-base",
    baseRoot: "0x" + "0".repeat(64),
    artifacts: Object.freeze(Array.from({ length: 25 }, () => hostile("artifact"))),
  });
  assert.throws(
    () => completeFrozenProductionArtifactBaseV1(forgedBase, hostile("acceptance approval") as never),
    /not release-owner-issued/,
  );
  assert.throws(
    () => materializeFrozenProductionArtifactBaseV1(forgedBase),
    /not release-owner-issued/,
  );
});

test("prepared package clones cannot expose signing bytes or leave a partial package", () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), "aloha-approved-package-clone-")));
  try {
    const clone = Object.freeze({});
    assert.throws(
      () => readProductionReleasePackageSigningRequestV1(clone),
      /not release-owner-issued/,
    );
    assert.throws(
      () => materializeApprovedProductionReleasePackageV1(clone, hostile("approval") as never, repository),
      /not release-owner-issued/,
    );
    assert.throws(
      () => materializePreparedProductionReleasePackageV1(clone, repository),
      /not release-owner-issued/,
    );
    assert.deepEqual(readdirSync(repository), []);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("external workflow has fixed approval inputs and cannot mint, install, or start", () => {
  const workflow = readFileSync(new URL("../src/external-release-workflow.ts", import.meta.url), "utf8");
  const owner = readFileSync(new URL("../src/external-release-owner.ts", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(workflow, /acceptanceApprovalPath: "\/var\/lib\/aloha\/release-packaging\/acceptance-approval\/release-acceptance-approval\.json"/);
  assert.match(workflow, /packageApprovalPath: "\/var\/lib\/aloha\/release-packaging\/package-approval\/runtime-release-package-approval\.json"/);
  assert.match(workflow, /preparedPackageRepository: "\/var\/lib\/aloha\/release-packaging\/prepared-packages"/);
  assert.match(workflow, /reopenFrozenProductionArtifactBaseV1\(artifactBaseDirectory\)/);
  assert.match(workflow, /completeFrozenProductionArtifactBaseV1\(artifactBase, acceptanceApproval\)/);
  assert.match(workflow, /materializePreparedProductionReleasePackageV1/);
  assert.match(workflow, /reopenPreparedProductionReleasePackageV1/);
  assert.match(workflow, /materializeApprovedProductionReleasePackageV1/);
  assert.match(owner, /preparedPackageArtifactBaseRoots\.set\(prepared, state\.baseRoot\)/);
  assert.match(owner, /artifactBaseRoot: Hash/);
  assert.match(owner, /reopenFrozenProductionArtifactBaseV1\(join\(/);
  assert.match(owner, /prepared release package is not the exact A plus externally signed acceptance approval/);
  assert.doesNotMatch(workflow, /createSignedReleaseAcceptanceApprovalV1|createRuntimeReleasePackageApprovalV1|installApprovedProductionReleaseV1|systemctl|execFile/);
  assert.match(cli, /command === "prepare-package-approval"/);
  assert.match(cli, /command === "materialize-approved"/);
  assert.doesNotMatch(cli, /--acceptance-approval|--package-approval|createSignedReleaseAcceptanceApprovalV1|createRuntimeReleasePackageApprovalV1/);
});

test("production install owner has fixed targets, publishes unit last, and never starts systemd", () => {
  assert.equal(Object.keys(PACKAGE_INSTALL_PATHS_V1).length, 26);
  const source = readFileSync(new URL("../src/production-install-owner.ts", import.meta.url), "utf8");
  assert.match(source, /PRODUCTION_RELEASE_PACKAGE_REPOSITORY_V1/);
  assert.match(source, /PRODUCTION_RELEASE_LAYOUT_V1\.systemdUnitPath/);
  assert.match(source, /target === PRODUCTION_RELEASE_LAYOUT_V1\.revmWorkerExecutablePath[\s\S]*PRODUCTION_RELEASE_LAYOUT_V1\.proofSignerExecutablePath \? 0o555 : 0o444/);
  assert.match(source, /installFiles\.push\(unit!\)/);
  assert.match(source, /verifyReleasePackageDirectoryV1/);
  assert.match(source, /verifyInstalledReleaseV1/);
  assert.doesNotMatch(source, /systemctl[^\n]*(?:start|enable|daemon-reload)|execFileSync\([^\n]*(?:start|enable|daemon-reload)/);
  assert.doesNotMatch(source, /targetRoot|layoutValue|installPathValue|serviceNameValue/);
  const invoke = installApprovedProductionReleaseV1 as unknown as (...args: unknown[]) => unknown;
  assert.throws(() => invoke(), /accepts only one package directory/);
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { decodeCanonicalJson, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { readPredicateDomainMaterialCapabilityV1 } from "../../gate-core/src/internal/predicate-domain-material-state.ts";
import { ARTIFACT_LINEAGE_MATERIAL_PROVIDER } from "../src/material-providers/artifact-lineage.ts";
import * as collectorsPublicApi from "../src/index.ts";
import * as artifactLineageObserverModule from "../src/production-artifact-lineage-observer.ts";
import {
  issueProductionArtifactLineageStageOneObserverPortV1,
} from "../src/internal/artifact-lineage-stage-one-owner.ts";
import * as artifactLineageStageOneOwnerModule from "../src/internal/artifact-lineage-stage-one-owner.ts";
import {
  issueReleaseOwnedObserverStoreV1,
  readReleaseOwnedObserverStoreV1,
} from "../src/internal/release-owned-observer-store.ts";
import {
  readArtifactLineageStageOneCapabilityV1,
} from "../src/production-artifact-lineage-observer.ts";
import { issueProductionPredicateMaterialSourceV1 } from "../src/production-predicate-material-source.ts";
import {
  readArtifactLineageStageTwoAuthorityV1,
} from "../src/internal/artifact-lineage-stage-one-state.ts";
import { registerProductionPredicateMaterialSourceStateV1 } from "../src/internal/predicate-material-source-owner.ts";

const execFileAsync = promisify(execFile);
const h = (value: string): Hash => hashDomain("test/artifact-lineage-stage-one/v2", value);

const fixedPaths = Object.freeze([
  "acceptance/gate-core/src/generated/predicate-composition.ts",
  "acceptance/gate-core/src/generated/release-role-manifest.ts",
  "acceptance/gate-core/src/generated/release-runtime.ts",
  "acceptance/gate-core/src/generated/release-authority.ts",
  "acceptance/gate-core/src/release-role-manifest.ledger.json",
]);

async function createCandidate(): Promise<Readonly<{ readonly root: string; readonly commit: string }>> {
  const root = await mkdtemp(join(tmpdir(), "aloha-stage-one-candidate-"));
  await execFileAsync("/usr/bin/git", ["-C", root, "init", "--quiet"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "config", "user.email", "facts@example.invalid"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "config", "user.name", "Facts Fixture"]);
  for (const [index, path] of fixedPaths.entries()) {
    const physical = join(root, path);
    await mkdir(dirname(physical), { recursive: true });
    await writeFile(
      physical,
      path.endsWith(".json")
        ? `${JSON.stringify({ fixture: path, sequence: String(index) })}\n`
        : `export const FIXTURE_${index} = ${JSON.stringify(path)};\n`,
    );
  }
  await execFileAsync("/usr/bin/git", ["-C", root, "add", "--", ...fixedPaths]);
  await execFileAsync("/usr/bin/git", ["-C", root, "commit", "--quiet", "-m", "candidate"]);
  const { stdout } = await execFileAsync("/usr/bin/git", ["-C", root, "rev-parse", "HEAD"]);
  return Object.freeze({ root: await realpath(root), commit: stdout.trim() });
}

function store(directory: string, commit: string, binding = "binding") {
  return issueReleaseOwnedObserverStoreV1({
    directory,
    observedStoreEpoch: "5",
    authority: {
      bindingId: h(binding),
      releaseAuthorityApprovalId: h(`${binding}-approval`),
      qualificationRegistryRoot: h(`${binding}-registry`),
      predicateCompositionRootDigest: h(`${binding}-composition`),
      releaseRoleManifestRoot: h(`${binding}-role-manifest`),
      candidateReleaseCommit: commit,
    },
  });
}

function materialSource(observerStore: object, observer: object) {
  return issueProductionPredicateMaterialSourceV1({
    observerStore,
    artifactLineageStageOne: observer as never,
    performanceObserver: null,
    durableTerminalDiscovery: null,
    terminalSelectionObserver: null,
    runtimeRestartObserver: null,
    sourceRepositoryClosureObserver: null,
    legacyAuthorityClosureObserver: null,
  });
}

function stageTwoSource(
  observerStore: ReturnType<typeof store>,
  port: ReturnType<typeof issueProductionArtifactLineageStageOneObserverPortV1>,
  observed: Awaited<ReturnType<typeof readArtifactLineageStageOneCapabilityV1>>,
  readAuthority: () => unknown = () => readArtifactLineageStageTwoAuthorityV1(port, observerStore),
  readGit?: () => unknown,
) {
  return registerProductionPredicateMaterialSourceStateV1({
    sink: readReleaseOwnedObserverStoreV1(observerStore).sink,
    readArtifactLineageStageOne: () => observed,
    readArtifactLineageStageTwoAuthority: readAuthority,
    readArtifactLineageStageTwoGit: readGit ?? (async () => {
      const authority = readAuthority();
      const { observeArtifactLineageStageTwoGitEvidenceV1 } = await import("../src/internal/artifact-lineage-stage-two-git-owner.ts");
      return observeArtifactLineageStageTwoGitEvidenceV1(authority as never, observed, readReleaseOwnedObserverStoreV1(observerStore).sink.resolverPolicy.maxByteLength);
    }),
    readFullFamilyObservation: null,
    observePerformance: null,
    readDurableTerminalDiscovery: null,
    observeTerminalSelection: null,
    readRuntimeRestartBoundary: null,
    readSourceRepositoryClosureBoundary: null,
    readLegacyAuthorityClosureBoundary: null,
  });
}

async function materialStatus(source: ReturnType<typeof stageTwoSource>) {
  return readPredicateDomainMaterialCapabilityV1(await ARTIFACT_LINEAGE_MATERIAL_PROVIDER.provide(source));
}

test("release-owned Stage 1 reads the fixed denominator from one exact commit and emits its content-addressed manifest", async () => {
  const candidate = await createCandidate();
  const objects = await mkdtemp(join(tmpdir(), "aloha-stage-one-objects-"));
  try {
    const observerStore = store(objects, candidate.commit);
    const port = issueProductionArtifactLineageStageOneObserverPortV1({
      repositoryRoot: candidate.root,
      store: observerStore,
      assertCurrent() {},
    });
    const capability = await port.observe();
    const observed = await readArtifactLineageStageOneCapabilityV1(capability);
    assert.equal(observed.candidateReleaseCommit, candidate.commit);
    assert.match(observed.denominatorRoot, /^0x[0-9a-f]{64}$/);
    assert.equal(observed.artifacts.length, fixedPaths.length + 1);
    assert.equal(observed.predicateFacts.length, fixedPaths.length + 1);
    assert.equal(observed.predicateFacts.at(-1)!.claim.artifactRef.artifactRefId, observed.artifacts.at(-1)!.ref.artifactRefId);
    const manifest = decodeCanonicalJson(observed.artifacts.at(-1)!.bytes) as {
      readonly kind: string;
      readonly candidateReleaseCommit: string;
      readonly denominatorRoot: Hash;
      readonly entries: readonly { readonly path: string }[];
    };
    assert.equal(manifest.kind, "aloha.artifact-lineage-exact-release-denominator");
    assert.equal(manifest.candidateReleaseCommit, candidate.commit);
    assert.equal(manifest.denominatorRoot, observed.denominatorRoot);
    assert.deepEqual(manifest.entries.map(entry => entry.path), fixedPaths);

    const material = readPredicateDomainMaterialCapabilityV1(
      await ARTIFACT_LINEAGE_MATERIAL_PROVIDER.provide(materialSource(observerStore, port)),
    );
    assert.equal(material.status, "available");
    if (material.status === "available") {
      assert.equal(material.candidateReleaseCommit, candidate.commit);
      assert.equal(material.predicateFacts.length, fixedPaths.length + 1);
    }
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(objects, { recursive: true, force: true });
  }
});

test("Stage 1 is single-flight and revalidates every write-once object before returning material", async () => {
  const candidate = await createCandidate();
  const objects = await mkdtemp(join(tmpdir(), "aloha-stage-one-mutation-"));
  try {
    const observerStore = store(objects, candidate.commit);
    const port = issueProductionArtifactLineageStageOneObserverPortV1({
      repositoryRoot: candidate.root,
      store: observerStore,
      assertCurrent() {},
    });
    await writeFile(join(candidate.root, fixedPaths[0]!), "worktree mutation must not enter Stage 1\n");
    const firstCapability = await port.observe();
    assert.equal(await port.observe(), firstCapability);
    const first = await readArtifactLineageStageOneCapabilityV1(firstCapability);
    assert.match(Buffer.from(first.artifacts[0]!.bytes).toString("utf8"), /FIXTURE_0/);
    assert.doesNotMatch(Buffer.from(first.artifacts[0]!.bytes).toString("utf8"), /worktree mutation/);
    const victim = join(objects, first.artifacts[0]!.contentSha256.slice(2));
    await chmod(victim, 0o600);
    await writeFile(victim, "mutated");
    await assert.rejects(
      readArtifactLineageStageOneCapabilityV1(firstCapability),
      /identity changed|hash mismatch|changed during read|remains writable/,
    );
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(objects, { recursive: true, force: true });
  }
});

test("Stage 1 rejects symlink replacement, missing fixed paths, structural stores and structural observer ports", async () => {
  const candidate = await createCandidate();
  const objects = await mkdtemp(join(tmpdir(), "aloha-stage-one-splice-"));
  const foreignObjects = await mkdtemp(join(tmpdir(), "aloha-stage-one-foreign-store-"));
  try {
    const observerStore = store(objects, candidate.commit);
    const port = issueProductionArtifactLineageStageOneObserverPortV1({
      repositoryRoot: candidate.root,
      store: observerStore,
      assertCurrent() {},
    });
    const capability = await port.observe();
    const observed = await readArtifactLineageStageOneCapabilityV1(capability);
    const victim = join(objects, observed.artifacts[0]!.contentSha256.slice(2));
    const target = join(objects, "replacement");
    await writeFile(target, observed.artifacts[0]!.bytes);
    await unlink(victim);
    await symlink(target, victim);
    await assert.rejects(readArtifactLineageStageOneCapabilityV1(capability), /ELOOP|symbolic|physical|identity/);
    assert.throws(
      () => issueProductionArtifactLineageStageOneObserverPortV1({
        repositoryRoot: candidate.root,
        store: Object.freeze(Object.create(null)),
        assertCurrent() {},
      }),
      /store capability was not issued/,
    );
    assert.throws(
      () => materialSource(observerStore, Object.freeze({ observe() {} })),
      /observer port was not issued/,
    );
    const foreignStore = store(foreignObjects, candidate.commit, "foreign");
    const foreignPort = issueProductionArtifactLineageStageOneObserverPortV1({
      repositoryRoot: candidate.root,
      store: foreignStore,
      assertCurrent() {},
    });
    assert.throws(
      () => materialSource(observerStore, foreignPort),
      /different release-owned store/,
    );
    const current = false;
    const stalePort = issueProductionArtifactLineageStageOneObserverPortV1({
      repositoryRoot: candidate.root,
      store: observerStore,
      assertCurrent() {
        if (!current) throw new TypeError("runtime release is stale");
      },
    });
    await assert.rejects(stalePort.observe(), /runtime release is stale/);

    const missingRoot = await mkdtemp(join(tmpdir(), "aloha-stage-one-missing-"));
    let missingObjects: string | null = null;
    try {
      await execFileAsync("/usr/bin/git", ["-C", missingRoot, "init", "--quiet"]);
      await execFileAsync("/usr/bin/git", ["-C", missingRoot, "config", "user.email", "facts@example.invalid"]);
      await execFileAsync("/usr/bin/git", ["-C", missingRoot, "config", "user.name", "Facts Fixture"]);
      await writeFile(join(missingRoot, "README"), "missing denominator\n");
      await execFileAsync("/usr/bin/git", ["-C", missingRoot, "add", "README"]);
      await execFileAsync("/usr/bin/git", ["-C", missingRoot, "commit", "--quiet", "-m", "missing"]);
      const { stdout } = await execFileAsync("/usr/bin/git", ["-C", missingRoot, "rev-parse", "HEAD"]);
      const physicalMissingRoot = await realpath(missingRoot);
      missingObjects = await mkdtemp(join(tmpdir(), "aloha-stage-one-missing-objects-"));
      const missingPort = issueProductionArtifactLineageStageOneObserverPortV1({
        repositoryRoot: physicalMissingRoot,
        store: store(missingObjects, stdout.trim(), "missing"),
        assertCurrent() {},
      });
      await assert.rejects(missingPort.observe(), /missing a regular blob/);
    } finally {
      await rm(missingRoot, { recursive: true, force: true });
      if (missingObjects !== null) await rm(missingObjects, { recursive: true, force: true });
    }
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(objects, { recursive: true, force: true });
    await rm(foreignObjects, { recursive: true, force: true });
  }
});

test("public observer module exposes no Stage 1 authority mint", () => {
  assert.deepEqual(Object.keys(artifactLineageObserverModule).sort(), [
    "assertIssuedProductionArtifactLineageStageOneObserverPortV1",
    "readArtifactLineageStageOneCapabilityV1",
  ]);
  assert.equal("issueProductionArtifactLineageStageOneObserverPortV1" in collectorsPublicApi, false);
  assert.equal("issueReleaseOwnedObserverStoreV1" in collectorsPublicApi, false);
  assert.deepEqual(Object.keys(artifactLineageStageOneOwnerModule), [
    "issueProductionArtifactLineageStageOneObserverPortV1",
  ]);
});

test("Stage 1 publishes no capability when the release rotates during exact-commit observation", async () => {
  const candidate = await createCandidate();
  const objects = await mkdtemp(join(tmpdir(), "aloha-stage-one-mid-observation-rotation-"));
  try {
    let checks = 0;
    const port = issueProductionArtifactLineageStageOneObserverPortV1({
      repositoryRoot: candidate.root,
      store: store(objects, candidate.commit, "rotating"),
      assertCurrent() {
        checks += 1;
        if (checks === 2) throw new TypeError("runtime release rotated during Stage 1");
      },
    });
    await assert.rejects(port.observe(), /rotated during Stage 1/);
    assert.equal(checks, 2);
    await assert.rejects(port.observe(), /rotated during Stage 1/);
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(objects, { recursive: true, force: true });
  }
});

test("Stage 1 rechecks release currency on every cached observe and durable capability read", async () => {
  const candidate = await createCandidate();
  const objects = await mkdtemp(join(tmpdir(), "aloha-stage-one-post-observation-rotation-"));
  try {
    let current = true;
    const port = issueProductionArtifactLineageStageOneObserverPortV1({
      repositoryRoot: candidate.root,
      store: store(objects, candidate.commit, "post-observation-rotation"),
      assertCurrent() {
        if (!current) throw new TypeError("runtime release rotated after Stage 1");
      },
    });
    const capability = await port.observe();
    await readArtifactLineageStageOneCapabilityV1(capability);
    current = false;
    await assert.rejects(port.observe(), /rotated after Stage 1/);
    await assert.rejects(readArtifactLineageStageOneCapabilityV1(capability), /rotated after Stage 1/);
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(objects, { recursive: true, force: true });
  }
});

test("Stage 2 independently rejects missing, extra, reordered, root-spliced and fact-spliced denominators", async () => {
  const candidate = await createCandidate();
  const objects = await mkdtemp(join(tmpdir(), "aloha-stage-two-mutations-"));
  try {
    const observerStore = store(objects, candidate.commit, "stage-two-mutations");
    const port = issueProductionArtifactLineageStageOneObserverPortV1({ repositoryRoot: candidate.root, store: observerStore, assertCurrent() {} });
    const observed = await readArtifactLineageStageOneCapabilityV1(await port.observe());
    const mutations = [
      { ...observed, artifacts: observed.artifacts.slice(0, 5) },
      { ...observed, artifacts: Object.freeze([...observed.artifacts, observed.artifacts[0]!]), predicateFacts: Object.freeze([...observed.predicateFacts, observed.predicateFacts[0]!]) },
      { ...observed, artifacts: Object.freeze([observed.artifacts[1]!, observed.artifacts[0]!, ...observed.artifacts.slice(2)]), predicateFacts: Object.freeze([observed.predicateFacts[1]!, observed.predicateFacts[0]!, ...observed.predicateFacts.slice(2)]) },
      { ...observed, denominatorRoot: h("stage-two-forged-root") },
      { ...observed, predicateFacts: Object.freeze([observed.predicateFacts[1]!, observed.predicateFacts[0]!, ...observed.predicateFacts.slice(2)]) },
    ];
    for (const mutation of mutations) {
      const material = await materialStatus(stageTwoSource(observerStore, port, mutation));
      assert.equal(material.status, "invalid");
      if (material.status === "invalid") assert.equal(material.code, "owner-material-invalid");
    }
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(objects, { recursive: true, force: true });
  }
});

test("Stage 2 independently rejects spliced or producer-shaped Git evidence", async () => {
  const candidate = await createCandidate();
  const objects = await mkdtemp(join(tmpdir(), "aloha-stage-two-git-evidence-"));
  try {
    const observerStore = store(objects, candidate.commit, "stage-two-git-evidence");
    const port = issueProductionArtifactLineageStageOneObserverPortV1({ repositoryRoot: candidate.root, store: observerStore, assertCurrent() {} });
    const observed = await readArtifactLineageStageOneCapabilityV1(await port.observe());
    const fixedAuthority = readArtifactLineageStageTwoAuthorityV1(port, observerStore);
    const { observeArtifactLineageStageTwoGitEvidenceV1 } = await import("../src/internal/artifact-lineage-stage-two-git-owner.ts");
    const evidence = await observeArtifactLineageStageTwoGitEvidenceV1(
      fixedAuthority,
      observed,
      readReleaseOwnedObserverStoreV1(observerStore).sink.resolverPolicy.maxByteLength,
    );
    const mutations = [
      { ...evidence, candidateReleaseCommit: "0".repeat(40) },
      { ...evidence, denominatorRoot: h("stage-two-git-denominator-splice") },
      { ...evidence, evidenceRoot: h("stage-two-git-evidence-splice") },
      { ...evidence, verdict: "available" },
    ];
    for (const mutation of mutations) {
      const material = await materialStatus(stageTwoSource(
        observerStore,
        port,
        observed,
        () => fixedAuthority,
        () => mutation,
      ));
      assert.equal(material.status, "invalid");
      if (material.status === "invalid") assert.equal(material.code, "owner-material-invalid");
    }
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(objects, { recursive: true, force: true });
  }
});

test("Stage 2 reads the signed commit despite a newer HEAD and rejects current-authority rotation", async () => {
  const candidate = await createCandidate();
  const objects = await mkdtemp(join(tmpdir(), "aloha-stage-two-head-shadow-"));
  try {
    const observerStore = store(objects, candidate.commit, "stage-two-head-shadow");
    const port = issueProductionArtifactLineageStageOneObserverPortV1({ repositoryRoot: candidate.root, store: observerStore, assertCurrent() {} });
    const observed = await readArtifactLineageStageOneCapabilityV1(await port.observe());
    await writeFile(join(candidate.root, fixedPaths[0]!), "export const HEAD_SHADOW = true;\n");
    await execFileAsync("/usr/bin/git", ["-C", candidate.root, "add", "--", fixedPaths[0]!]);
    await execFileAsync("/usr/bin/git", ["-C", candidate.root, "commit", "--quiet", "-m", "head shadow"]);
    const shadow = await materialStatus(stageTwoSource(observerStore, port, observed));
    assert.equal(shadow.status, "available");
    if (shadow.status === "available") assert.equal(shadow.candidateReleaseCommit, candidate.commit);

    const fixedAuthority = readArtifactLineageStageTwoAuthorityV1(port, observerStore);
    let reads = 0;
    const rotated = await materialStatus(stageTwoSource(observerStore, port, observed, () => {
      reads += 1;
      return reads < 3 ? fixedAuthority : { ...fixedAuthority, releaseBindingId: h("rotated-stage-two-binding") };
    }));
    assert.equal(rotated.status, "invalid");
    assert.equal(reads, 3);
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(objects, { recursive: true, force: true });
  }
});

test("Stage 1 and Stage 2 fail locally without consulting a configured promisor remote", async () => {
  const candidate = await createCandidate();
  const objects = await mkdtemp(join(tmpdir(), "aloha-stage-two-promisor-"));
  const secondObjects = await mkdtemp(join(tmpdir(), "aloha-stage-one-promisor-"));
  try {
    const observerStore = store(objects, candidate.commit, "promisor-stage-two");
    const port = issueProductionArtifactLineageStageOneObserverPortV1({
      repositoryRoot: candidate.root,
      store: observerStore,
      assertCurrent() {},
    });
    const observed = await readArtifactLineageStageOneCapabilityV1(await port.observe());
    const { stdout } = await execFileAsync("/usr/bin/git", [
      "-C", candidate.root, "rev-parse", `${candidate.commit}:${fixedPaths[0]}`,
    ]);
    const blobObjectId = stdout.trim();
    const remoteProbePath = join(candidate.root, "promisor-remote-probe");
    const sshCommandPath = join(candidate.root, "promisor-ssh-command");
    await writeFile(sshCommandPath, `#!/bin/sh\nprintf invoked > ${remoteProbePath}\nexit 1\n`);
    await chmod(sshCommandPath, 0o755);
    await execFileAsync("/usr/bin/git", ["-C", candidate.root, "config", "core.repositoryFormatVersion", "1"]);
    await execFileAsync("/usr/bin/git", ["-C", candidate.root, "config", "extensions.partialClone", "origin"]);
    await execFileAsync("/usr/bin/git", ["-C", candidate.root, "config", "remote.origin.url", "ssh://127.0.0.1/aloha-promisor"]);
    await execFileAsync("/usr/bin/git", ["-C", candidate.root, "config", "remote.origin.promisor", "true"]);
    await execFileAsync("/usr/bin/git", ["-C", candidate.root, "config", "remote.origin.partialCloneFilter", "blob:none"]);
    await execFileAsync("/usr/bin/git", ["-C", candidate.root, "config", "core.sshCommand", sshCommandPath]);
    await unlink(join(candidate.root, ".git", "objects", blobObjectId.slice(0, 2), blobObjectId.slice(2)));

    const stageTwo = await materialStatus(stageTwoSource(observerStore, port, observed));
    assert.equal(stageTwo.status, "invalid");
    const secondPort = issueProductionArtifactLineageStageOneObserverPortV1({
      repositoryRoot: candidate.root,
      store: store(secondObjects, candidate.commit, "promisor-stage-one"),
      assertCurrent() {},
    });
    await assert.rejects(secondPort.observe());
    await assert.rejects(access(remoteProbePath), /ENOENT/);
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(objects, { recursive: true, force: true });
    await rm(secondObjects, { recursive: true, force: true });
  }
});

test("Stage 1 and predicate-source preflight reject proxies/accessors without executing caller code", async () => {
  const candidate = await createCandidate();
  const objects = await mkdtemp(join(tmpdir(), "aloha-stage-one-hostile-"));
  try {
    const observerStore = store(objects, candidate.commit);
    let traps = 0;
    const proxied = new Proxy({ repositoryRoot: candidate.root, store: observerStore, assertCurrent() {} }, {
      get() { traps += 1; throw new Error("proxy trap executed"); },
      ownKeys() { traps += 1; throw new Error("proxy trap executed"); },
    });
    assert.throws(
      () => issueProductionArtifactLineageStageOneObserverPortV1(proxied),
      /Proxy objects|plain object/,
    );
    assert.equal(traps, 0);

    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(hostile, {
      observerStore: { enumerable: true, value: observerStore },
      artifactLineageStageOne: { enumerable: true, get() { traps += 1; throw new Error("accessor executed"); } },
      performanceObserver: { enumerable: true, value: null },
      durableTerminalDiscovery: { enumerable: true, value: null },
      terminalSelectionObserver: { enumerable: true, value: null },
      runtimeRestartObserver: { enumerable: true, value: null },
      sourceRepositoryClosureObserver: { enumerable: true, value: null },
      legacyAuthorityClosureObserver: { enumerable: true, value: null },
    });
    assert.throws(() => issueProductionPredicateMaterialSourceV1(hostile as never), /data property/);
    assert.equal(traps, 0);
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(objects, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertInstalledProductionRuntimeEnvironmentV1,
} from "../src/internal/production-runtime-environment.ts";
import {
  closeProductionRuntimeAcceptanceEvidenceV1,
  installProductionRuntimeSigtermEvidenceV1,
  issueProductionRuntimeAcceptanceEvidenceOwnerV1,
  readProductionRuntimeAcceptanceEventsV1,
  recordProductionRuntimeProcessReadyV1,
} from "../src/runtime-acceptance-evidence.ts";

test("installed production bootstrap rejects a Git environment injection", () => {
  const saved = new Map<string, string>();
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GIT_")) {
      saved.set(name, process.env[name]!);
      delete process.env[name];
    }
  }
  process.env.GIT_CONFIG_GLOBAL = "/tmp/forged-git-config";
  try {
    assert.throws(assertInstalledProductionRuntimeEnvironmentV1, /forbidden runtime environment GIT_CONFIG_GLOBAL/);
  } finally {
    delete process.env.GIT_CONFIG_GLOBAL;
    for (const [name, value] of saved) process.env[name] = value;
  }
});

test("runtime acceptance evidence rejects structural owners before callbacks or signals run", async () => {
  const fake = Object.freeze(Object.create(null));
  let stopped = false;
  assert.throws(
    () => installProductionRuntimeSigtermEvidenceV1({
      owner: fake,
      stop: async () => { stopped = true; },
    }),
    /not issued/,
  );
  assert.equal(stopped, false);
  assert.throws(() => readProductionRuntimeAcceptanceEventsV1(fake), /not issued/);
  assert.throws(() => closeProductionRuntimeAcceptanceEvidenceV1(fake), /not issued/);
  await assert.rejects(
    Promise.resolve().then(() => recordProductionRuntimeProcessReadyV1(fake, Object.freeze({}) as never)),
    /not issued/,
  );
});

test("runtime acceptance owner rejects a structural checkpoint before opening durable evidence", () => {
  assert.throws(() => issueProductionRuntimeAcceptanceEvidenceOwnerV1({
    databasePath: "/tmp/aloha-runtime-acceptance-must-not-open.sqlite",
    release: {
      bindingId: `0x${"1".repeat(64)}`,
      releaseProvenanceHash: `0x${"2".repeat(64)}`,
      candidateReleaseCommit: "3".repeat(40),
    },
    runtimeAnchor: {
      bindingId: `0x${"1".repeat(64)}`,
      releaseProvenanceHash: `0x${"2".repeat(64)}`,
      candidateReleaseCommit: "3".repeat(40),
    } as never,
    checkpoint: Object.freeze({}) as never,
    strategy: {
      definitionCatalogRoot: `0x${"4".repeat(64)}`,
      strategyCatalogRoot: `0x${"6".repeat(64)}`,
      releaseProvenanceHash: `0x${"2".repeat(64)}`,
      compositionRoot: `0x${"5".repeat(64)}`,
    },
    phaseManifest: { kind: "production", bytes: new Uint8Array() },
    releaseIntentBytes: new Uint8Array(),
    systemdUnitBytes: new Uint8Array(),
    releaseEnvironmentBytes: new Uint8Array(),
    logPath: "/tmp/aloha-runtime-acceptance-must-not-open.log",
  }), /checkpoint store is not issued/);
});

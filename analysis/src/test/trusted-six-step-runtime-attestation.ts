import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  TRUSTED_SIX_STEP_PRODUCTION_INSTANCE_ID,
  canonicalTrustedSixStepInputSnapshotPayloadSha256,
  canonicalTrustedSixStepRuntimePayload,
  canonicalTrustedSixStepRuntimePayloadSha256,
  decodeTrustedSixStepRuntimeJsonInputs,
  validateTrustedSixStepInputSnapshot,
  validateTrustedSixStepRuntimeAttestation,
  type TrustedSixStepInputSnapshot,
  type TrustedSixStepRuntimeAttestation,
} from "../trusted-six-step-runtime-attestation.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const TX = `0x${"1".repeat(64)}`;
const UNIVERSE_PATH =
  `/opt/MEV-runtime/universe/active-pools-${SHA_A}.json`;

function fixture(): TrustedSixStepRuntimeAttestation {
  const unsigned = {
    schema_version: 1,
    kind: "trusted-six-step-runtime-attestation",
    instance_id: TRUSTED_SIX_STEP_PRODUCTION_INSTANCE_ID,
    runtime_commit: "c".repeat(40),
    process: {
      pid: 1234,
      starttime_ticks: "987654321",
      n_restarts: 2,
    },
    universe: {
      path: UNIVERSE_PATH,
      sha256: SHA_A,
    },
    universe_manifest: {
      path: `${UNIVERSE_PATH}.manifest.json`,
      sha256: SHA_B,
    },
    runtime_json_inputs: {},
    pool_universe_top_n: 20_000,
    searcher_config: {
      SEARCHER_BLOCKSCAN_MAX_CANDIDATES: "100",
      SEARCHER_BLOCKSCAN_PASS_BUDGET_MS: "11000",
      SEARCHER_BRIBE_BPS: "5000",
      SEARCHER_EV_GATE: "1",
      SEARCHER_POOL_UNIVERSE_MANIFEST_PATH: `${UNIVERSE_PATH}.manifest.json`,
      SEARCHER_POOL_UNIVERSE_PATH: UNIVERSE_PATH,
      SEARCHER_POOL_UNIVERSE_TOP_N: "20000",
      SEARCHER_RUNTIME_COMMIT: "c".repeat(40),
    },
    sample_receipt: {
      tx_hash: TX,
      receipt_sha256: SHA_B,
      block_hash: `0x${SHA_A}`,
      block_number: 25_600_000,
      transaction_index: 17,
      status: 1,
    },
    parent_block: {
      number: 25_599_999,
      hash: `0x${SHA_B}`,
      state_root: `0x${"d".repeat(64)}`,
    },
    observed_at: "2026-07-28T12:34:56.789Z",
  } as const;
  return {
    ...unsigned,
    searcher_config: { ...unsigned.searcher_config },
    payload_sha256: canonicalTrustedSixStepRuntimePayloadSha256(unsigned),
    command_id: "00000000-0000-0000-0000-000000000001",
  };
}

function snapshotFixture(): TrustedSixStepInputSnapshot {
  const runtime = fixture();
  const effectiveStateHash = createHash("sha256").update(JSON.stringify({
    applied_prefix_tx_hashes: [],
    base_block_hash: runtime.parent_block.hash,
    base_state_root: runtime.parent_block.state_root,
  })).digest("hex");
  const payload = {
    schema_version: 1 as const,
    kind: "trusted-six-step-input-snapshot" as const,
    sample_tx_hash: TX,
    lane: "block_scan_standing" as const,
    source_runtime_commit: runtime.runtime_commit,
    local_universe: { path: "/tmp/universe.json", sha256: SHA_A },
    local_universe_manifest: {
      path: "/tmp/universe.manifest.json",
      sha256: SHA_B,
    },
    runtime_attestation: runtime,
    state_anchor: {
      lane: "block_scan_standing" as const,
      opportunity_block: runtime.sample_receipt.block_number,
      base_block: runtime.parent_block.number,
      base_block_hash: runtime.parent_block.hash,
      base_state_root: runtime.parent_block.state_root,
      applied_prefix_tx_hashes: [] as const,
      trigger_tx_hash: null,
      target_tx_index: null,
      effective_state_hash: effectiveStateHash,
    },
    created_at: "2026-07-28T12:35:00.000Z",
  };
  const payloadSha256 =
    canonicalTrustedSixStepInputSnapshotPayloadSha256(payload);
  return {
    ...payload,
    payload_sha256: payloadSha256,
  };
}

test("accepts a strict, cross-bound runtime attestation", () => {
  const value = fixture();
  assert.deepEqual(
    validateTrustedSixStepRuntimeAttestation(value, TX.toUpperCase()),
    [],
  );
  assert.equal(
    value.payload_sha256,
    canonicalTrustedSixStepRuntimePayloadSha256(value),
  );
});

test("canonical payload excludes SSM transport fields and sorts config", () => {
  const first = fixture();
  const second = fixture();
  second.searcher_config = Object.fromEntries(
    Object.entries(second.searcher_config).reverse(),
  );
  second.command_id = "00000000-0000-0000-0000-000000000002";
  second.payload_sha256 = canonicalTrustedSixStepRuntimePayloadSha256(second);

  assert.equal(
    canonicalTrustedSixStepRuntimePayload(first),
    canonicalTrustedSixStepRuntimePayload(second),
  );
  assert.equal(first.payload_sha256, second.payload_sha256);
  assert.doesNotMatch(
    canonicalTrustedSixStepRuntimePayload(first),
    /auth_tag|command_id|payload_sha256/,
  );
});

test("rejects non-content-addressed or cross-universe paths", () => {
  const wrongUniverse = fixture();
  wrongUniverse.universe.path =
    "/opt/MEV-runtime/universe/active-pools-latest.json";
  wrongUniverse.payload_sha256 =
    canonicalTrustedSixStepRuntimePayloadSha256(wrongUniverse);
  assert.match(
    validateTrustedSixStepRuntimeAttestation(wrongUniverse, TX).join("\n"),
    /not content-addressed/,
  );

  const wrongManifest = fixture();
  wrongManifest.universe_manifest.path =
    `/opt/MEV-runtime/universe/active-pools-${SHA_B}.json.manifest.json`;
  wrongManifest.payload_sha256 =
    canonicalTrustedSixStepRuntimePayloadSha256(wrongManifest);
  assert.match(
    validateTrustedSixStepRuntimeAttestation(wrongManifest, TX).join("\n"),
    /does not belong|manifest path does not match/,
  );
});

test("binds and decodes portable content-addressed runtime JSON inputs", () => {
  const value = fixture();
  const bytes = Buffer.from('{"routers":[]}\n');
  const digest = createHash("sha256").update(bytes).digest("hex");
  const path =
    `/opt/MEV-runtime/routers/force-include-routers-${digest}.json`;
  value.searcher_config.SEARCHER_FORCE_INCLUDE_ROUTERS_PATH = path;
  value.runtime_json_inputs = {
    SEARCHER_FORCE_INCLUDE_ROUTERS_PATH: { path, sha256: digest },
  };
  value.payload_sha256 =
    canonicalTrustedSixStepRuntimePayloadSha256(value);
  assert.deepEqual(validateTrustedSixStepRuntimeAttestation(value, TX), []);
  assert.deepEqual(
    decodeTrustedSixStepRuntimeJsonInputs({
      SEARCHER_FORCE_INCLUDE_ROUTERS_PATH: {
        path,
        sha256: digest,
        base64: bytes.toString("base64"),
      },
    }, value),
    { SEARCHER_FORCE_INCLUDE_ROUTERS_PATH: bytes },
  );

  assert.throws(
    () => decodeTrustedSixStepRuntimeJsonInputs({
      SEARCHER_FORCE_INCLUDE_ROUTERS_PATH: {
        path,
        sha256: digest,
        base64: Buffer.from('{"routers":["tampered"]}\n').toString("base64"),
      },
    }, value),
    /hash mismatch/,
  );
});

test("rejects missing or non-content-addressed runtime JSON inputs", () => {
  const value = fixture();
  value.searcher_config.SEARCHER_V2_LINEAGES_PATH =
    "/opt/MEV-runtime/v2-lineages/v2-lineages-latest.json";
  value.payload_sha256 =
    canonicalTrustedSixStepRuntimePayloadSha256(value);
  assert.match(
    validateTrustedSixStepRuntimeAttestation(value, TX).join("\n"),
    /do not cover exact production JSON paths/,
  );

  value.runtime_json_inputs = {
    SEARCHER_V2_LINEAGES_PATH: {
      path: value.searcher_config.SEARCHER_V2_LINEAGES_PATH,
      sha256: SHA_A,
    },
  };
  value.payload_sha256 =
    canonicalTrustedSixStepRuntimePayloadSha256(value);
  assert.match(
    validateTrustedSixStepRuntimeAttestation(value, TX).join("\n"),
    /not content-addressed/,
  );
});

test("rejects secrets/endpoints and mismatched production config", () => {
  const rpcLeak = fixture();
  rpcLeak.searcher_config.SEARCHER_LIVE_RPC_URL =
    "http://127.0.0.1:8545";
  rpcLeak.payload_sha256 =
    canonicalTrustedSixStepRuntimePayloadSha256(rpcLeak);
  assert.match(
    validateTrustedSixStepRuntimeAttestation(rpcLeak, TX).join("\n"),
    /sensitive key|unsafe value/,
  );

  const wrongTopN = fixture();
  wrongTopN.searcher_config.SEARCHER_POOL_UNIVERSE_TOP_N = "6000";
  wrongTopN.payload_sha256 =
    canonicalTrustedSixStepRuntimePayloadSha256(wrongTopN);
  assert.match(
    validateTrustedSixStepRuntimeAttestation(wrongTopN, TX).join("\n"),
    /top-N does not match/,
  );
});

test("keeps production pass budgets while excluding credential-shaped names", () => {
  const value = fixture();
  assert.deepEqual(
    validateTrustedSixStepRuntimeAttestation(value, TX),
    [],
  );
  assert.equal(value.searcher_config.SEARCHER_BLOCKSCAN_PASS_BUDGET_MS, "11000");

  value.searcher_config.SEARCHER_SIGNER = "not-a-real-secret";
  value.payload_sha256 =
    canonicalTrustedSixStepRuntimePayloadSha256(value);
  assert.match(
    validateTrustedSixStepRuntimeAttestation(value, TX).join("\n"),
    /sensitive key/,
  );
});

test("rejects sample, parent and canonical payload mismatches", () => {
  const wrongTx = fixture();
  assert.match(
    validateTrustedSixStepRuntimeAttestation(
      wrongTx,
      `0x${"2".repeat(64)}`,
    ).join("\n"),
    /does not match requested sample/,
  );

  const wrongParent = fixture();
  wrongParent.parent_block.number -= 1;
  wrongParent.payload_sha256 =
    canonicalTrustedSixStepRuntimePayloadSha256(wrongParent);
  assert.match(
    validateTrustedSixStepRuntimeAttestation(wrongParent, TX).join("\n"),
    /block_number - 1/,
  );

  const wrongDigest = fixture();
  wrongDigest.payload_sha256 = "f".repeat(64);
  assert.match(
    validateTrustedSixStepRuntimeAttestation(wrongDigest, TX).join("\n"),
    /does not match the canonical payload/,
  );
});

test("rejects unknown fields instead of accepting caller-supplied runtime facts", () => {
  const value = fixture() as TrustedSixStepRuntimeAttestation
    & { rpc_url?: string };
  value.rpc_url = "http://attacker.invalid";
  assert.match(
    validateTrustedSixStepRuntimeAttestation(value, TX).join("\n"),
    /unknown top-level fields/,
  );
});

test("input snapshot freezes one hashed runtime/state/universe tuple", () => {
  const snapshot = snapshotFixture();
  assert.deepEqual(validateTrustedSixStepInputSnapshot(snapshot, TX), []);

  snapshot.local_universe.sha256 = SHA_B;
  snapshot.payload_sha256 =
    canonicalTrustedSixStepInputSnapshotPayloadSha256(snapshot);
  assert.match(
    validateTrustedSixStepInputSnapshot(snapshot, TX).join("\n"),
    /local universe does not match runtime attestation/,
  );
});

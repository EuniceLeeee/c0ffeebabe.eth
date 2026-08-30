import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  HISTORICAL_RPC_REPLAY_DESCRIPTOR_KIND,
  captureHistoricalRpcReplayV1,
  historicalRpcReadDescriptorKeyV1,
  loadFrozenHistoricalRpcReplayV1,
  materializeHistoricalRpcReplayV1,
  type HistoricalRpcReadDescriptorV1,
  type HistoricalRpcReplayCaptureV1,
} from "../src/frozen-rpc-replay.ts";

const blockHash = `0x${"1".repeat(64)}` as Hash;
const stateRoot = `0x${"2".repeat(64)}` as Hash;
const closureRoot = `0x${"3".repeat(64)}` as Hash;
const address = `0x${"4".repeat(40)}`;

function descriptor(changes: Partial<HistoricalRpcReadDescriptorV1> = {}): HistoricalRpcReadDescriptorV1 {
  return {
    schemaVersion: 1,
    kind: HISTORICAL_RPC_REPLAY_DESCRIPTOR_KIND,
    lane: "source",
    method: "eth_call",
    canonicalParams: [{ to: address, data: "0x0902f1ac" }, "0x64"],
    sourceCutoff: { chainId: "1", blockNumber: "0x64", blockHash, stateRoot },
    cutoffBinding: { kind: "block-number-param", paramIndex: "1" },
    owner: {
      ownerId: "@aloha/univ2-standard#getReserves",
      implementationClosureRoot: closureRoot,
    },
    ...changes,
  };
}

function response(value: CanonicalJson): Uint8Array {
  return encodeCanonicalBytes(value);
}

async function withStore(run: (directory: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "aloha-frozen-rpc-replay-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("captures, reloads, and replays exact response bytes without a verdict", async () => {
  await withStore(async (directory) => {
    const calls: Hash[] = [];
    const manifest = await captureHistoricalRpcReplayV1(directory, [descriptor()], {
      async read(value) {
        calls.push(historicalRpcReadDescriptorKeyV1(value));
        return response({ result: "0x1234" });
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(manifest.advisoryOnly, true);
    assert.equal(manifest.transportFactsOnly, true);
    assert.equal(manifest.chainStateQualified, false);
    assert.equal(manifest.transportOrigin, "reader-port-observed/untrusted-reader-port");
    assert.equal(manifest.fenceClaimLevel, "before-after-observation-only-a-b-a-not-excluded");
    assert.match(manifest.descriptorSetRoot, /^0x[0-9a-f]{64}$/);
    assert.match(manifest.responseObjectClosureRoot, /^0x[0-9a-f]{64}$/);
    assert.equal("verdict" in manifest, false);
    assert.equal("pass" in manifest, false);
    const replay = loadFrozenHistoricalRpcReplayV1(directory, manifest.manifestRoot);
    assert.equal(replay.transportOrigin, "reader-port-observed/untrusted-reader-port");
    assert.deepEqual(decodeCanonicalBytes(replay.read(descriptor())), { result: "0x1234" });
    assert.deepEqual(replay.stats(), { requests: 1, misses: 0, missedDescriptors: [] });
    assert.equal(replay.descriptorSetRoot, manifest.descriptorSetRoot);
    assert.equal(replay.responseObjectClosureRoot, manifest.responseObjectClosureRoot);
  });
});

test("parameter, lane, and owner changes are recorded descriptor misses while unsupported methods are invalid", async () => {
  await withStore((directory) => {
    const manifest = materializeHistoricalRpcReplayV1(directory, [{
      descriptor: descriptor(),
      responseBytes: response({ result: "0x1" }),
    }]);
    const replay = loadFrozenHistoricalRpcReplayV1(directory, manifest.manifestRoot);
    for (const changed of [
      descriptor({ canonicalParams: [{ to: address, data: "0x70a08231" }, "0x64"] }),
      descriptor({ lane: "base" }),
      descriptor({ owner: { ownerId: "@aloha/other#read", implementationClosureRoot: closureRoot } }),
    ]) assert.throws(() => replay.read(changed), /descriptor miss/);
    assert.throws(() => replay.read(descriptor({ method: "eth_getCode" })), /no compiled historical cutoff binding/);
    assert.equal(replay.stats().misses, 4);
    assert.deepEqual(
      replay.stats().missedDescriptors.map((miss) => miss.reason),
      ["descriptor-miss", "descriptor-miss", "descriptor-miss", "descriptor-invalid"],
    );
  });
});

test("dynamic block tags are rejected and recorded before lookup", async () => {
  await withStore((directory) => {
    const manifest = materializeHistoricalRpcReplayV1(directory, [{
      descriptor: descriptor(),
      responseBytes: response({ result: "0x1" }),
    }]);
    const replay = loadFrozenHistoricalRpcReplayV1(directory, manifest.manifestRoot);
    for (const tag of ["latest", "pending", "safe", "finalized", "earliest"] as const) {
      assert.throws(
        () => replay.read(descriptor({ canonicalParams: [{ to: address }, tag] })),
        new RegExp(`mutable block tag ${tag}`),
      );
    }
    assert.deepEqual(
      replay.stats().missedDescriptors.map((miss) => miss.reason),
      [
        "mutable-block-tag", "mutable-block-tag", "mutable-block-tag",
        "mutable-block-tag", "mutable-block-tag",
      ],
    );
  });
});

test("a different source cutoff fails closed and is recorded distinctly", async () => {
  await withStore((directory) => {
    const manifest = materializeHistoricalRpcReplayV1(directory, [{
      descriptor: descriptor(),
      responseBytes: response({ result: "0x1" }),
    }]);
    const replay = loadFrozenHistoricalRpcReplayV1(directory, manifest.manifestRoot);
    assert.throws(() => replay.read(descriptor({
      sourceCutoff: { ...descriptor().sourceCutoff, blockHash: `0x${"9".repeat(64)}` as Hash },
    })), /source cutoff mismatch/);
    assert.equal(replay.stats().missedDescriptors[0]!.reason, "source-cutoff-mismatch");
  });
});

test("one descriptor key cannot be captured with different response bytes", async () => {
  await withStore((directory) => {
    const captures: readonly HistoricalRpcReplayCaptureV1[] = [
      { descriptor: descriptor(), responseBytes: response({ result: "0x1" }) },
      { descriptor: descriptor(), responseBytes: response({ result: "0x2" }) },
    ];
    assert.throws(
      () => materializeHistoricalRpcReplayV1(directory, captures),
      /duplicate replay descriptor has different response bytes/,
    );
  });
});

test("direct materialization is explicitly untrusted caller material and cannot select another origin", async () => {
  await withStore((directory) => {
    const manifest = materializeHistoricalRpcReplayV1(directory, [{
      descriptor: descriptor(),
      responseBytes: response({ result: "0x1" }),
    }]);
    assert.equal(manifest.advisoryOnly, true);
    assert.equal(manifest.chainStateQualified, false);
    assert.equal(manifest.transportOrigin, "caller-materialized/untrusted-caller-material");
    assert.equal(manifest.fenceClaimLevel, "before-after-observation-only-a-b-a-not-excluded");
    assert.throws(
      () => materializeHistoricalRpcReplayV1(directory, [{
        descriptor: descriptor(),
        responseBytes: response({ result: "0x1" }),
        transportOrigin: "reader-port-observed/untrusted-reader-port",
      } as never]),
      /unknown field "transportOrigin"|response bytes/,
    );
  });
});

test("capture rejects mutable reads and cross-cutoff descriptor sets", async () => {
  await withStore((directory) => {
    assert.throws(() => materializeHistoricalRpcReplayV1(directory, [{
      descriptor: descriptor({ canonicalParams: [{ to: address }, "latest"] }),
      responseBytes: response({ result: "0x1" }),
    }]), /mutable block tag latest/);
    assert.throws(() => materializeHistoricalRpcReplayV1(directory, [
      { descriptor: descriptor(), responseBytes: response({ result: "0x1" }) },
      {
        descriptor: descriptor({
          lane: "base",
          canonicalParams: [{ to: address, data: "0x0902f1ac" }, "0x63"],
          sourceCutoff: { ...descriptor().sourceCutoff, blockNumber: "0x63" },
        }),
        responseBytes: response({ result: "0x2" }),
      },
    ]), /capture source cutoff mismatch/);
  });
});

test("cutoff binding rejects a fixed-number or EIP-1898 parameter mismatch", async () => {
  await withStore((directory) => {
    assert.throws(() => materializeHistoricalRpcReplayV1(directory, [{
      descriptor: descriptor({ canonicalParams: [{ to: address }, "0x63"] }),
      responseBytes: response({ result: "0x1" }),
    }]), /block-number param does not equal source cutoff/);
    assert.throws(() => materializeHistoricalRpcReplayV1(directory, [{
      descriptor: descriptor({
        canonicalParams: [
          { to: address },
          { blockHash: `0x${"9".repeat(64)}`, requireCanonical: true },
        ],
        cutoffBinding: { kind: "eip1898-block-hash-param", paramIndex: "1" },
      }),
      responseBytes: response({ result: "0x1" }),
    }]), /does not exactly bind canonical source cutoff/);
  });
});

test("cutoff parameter ownership is compiled rather than caller-declared", async () => {
  await withStore((directory) => {
    assert.throws(() => materializeHistoricalRpcReplayV1(directory, [{
      descriptor: descriptor({ cutoffBinding: { kind: "block-number-param", paramIndex: "0" } }),
      responseBytes: response({ result: "0x1" }),
    }]), /eth_call cutoff must be exact parameter 1/);
    assert.throws(() => materializeHistoricalRpcReplayV1(directory, [{
      descriptor: descriptor({
        method: "eth_getCode",
        canonicalParams: [address, "0x64"],
      }),
      responseBytes: response({ result: "0x1" }),
    }]), /no compiled historical cutoff binding/);
    assert.throws(() => materializeHistoricalRpcReplayV1(directory, [{
      descriptor: descriptor({
        method: "eth_chainId",
        canonicalParams: ["ignored"],
        cutoffBinding: { kind: "source-invariant", paramIndex: null },
      }),
      responseBytes: response("0x1"),
    }]), /must not have parameters/);
  });
});

test("reload rejects a missing or changed response object", async () => {
  await withStore((directory) => {
    const manifest = materializeHistoricalRpcReplayV1(directory, [{
      descriptor: descriptor(),
      responseBytes: response({ result: "0x1" }),
    }]);
    const entry = manifest.entries[0]!;
    unlinkSync(join(directory, "rpc-replay-v1", "objects", entry.responseObjectHash.slice(2)));
    assert.throws(
      () => loadFrozenHistoricalRpcReplayV1(directory, manifest.manifestRoot),
      /object closure mismatch/,
    );
  });
  await withStore((directory) => {
    const manifest = materializeHistoricalRpcReplayV1(directory, [{
      descriptor: descriptor(),
      responseBytes: response({ result: "0x1" }),
    }]);
    const entry = manifest.entries[0]!;
    const path = join(directory, "rpc-replay-v1", "objects", entry.responseObjectHash.slice(2));
    const bytes = readFileSync(path);
    bytes[bytes.length - 2] = bytes[bytes.length - 2] === 49 ? 50 : 49;
    writeFileSync(path, bytes);
    assert.throws(
      () => loadFrozenHistoricalRpcReplayV1(directory, manifest.manifestRoot),
      /response object bytes changed/,
    );
  });
});

test("permanent CAS keeps multiple manifests independently replayable", async () => {
  await withStore((directory) => {
    const first = materializeHistoricalRpcReplayV1(directory, [{
      descriptor: descriptor(),
      responseBytes: response({ result: "0x1" }),
    }]);
    const secondDescriptor = descriptor({
      canonicalParams: [{ to: address, data: "0x0902f1ac" }, "0x65"],
      sourceCutoff: {
        ...descriptor().sourceCutoff,
        blockNumber: "0x65",
        blockHash: `0x${"5".repeat(64)}` as Hash,
        stateRoot: `0x${"6".repeat(64)}` as Hash,
      },
    });
    const second = materializeHistoricalRpcReplayV1(directory, [{
      descriptor: secondDescriptor,
      responseBytes: response({ result: "0x2" }),
    }]);
    assert.deepEqual(
      decodeCanonicalBytes(loadFrozenHistoricalRpcReplayV1(directory, first.manifestRoot).read(descriptor())),
      { result: "0x1" },
    );
    assert.deepEqual(
      decodeCanonicalBytes(loadFrozenHistoricalRpcReplayV1(directory, second.manifestRoot).read(secondDescriptor)),
      { result: "0x2" },
    );
  });
});

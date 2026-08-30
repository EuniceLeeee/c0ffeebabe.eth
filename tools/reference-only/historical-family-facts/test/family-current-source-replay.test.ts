import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  encodeCanonicalBytes,
  hashDomain,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import type {
  FamilySearchCurrentSourceV1,
  FamilySearchSourceReadRequestV1,
} from "../../../../packages/family-sdk/search-runtime/index.ts";
import {
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_FAMILY_ID,
} from "../../../../families/univ2-standard/src/public.ts";
import { FLUID_DEX_SWAP_RESULT_SELECTOR } from "../../../../families/fluid-dex/src/abi.ts";
import { FLUID_DEX_FAMILY_ID } from "../../../../families/fluid-dex/src/manifest.ts";
import {
  createFamilyCurrentSourceCaptureV1,
  createFrozenFamilyCurrentSourceReplayV1,
  loadGeneratedFamilySearchAdapterBindingV1,
  type FamilyCurrentSourceReplayManifestV1,
} from "../src/family-current-source-replay.ts";

const h = (value: string): Hash => hashDomain("aloha/family-current-source-replay-test/v1", value);
const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const reserveBytes = `0x${word(1_000_000n)}${word(2_000_000n)}${word(42n)}`;
const source = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const pool = address("1");

async function withStore(run: (directory: string) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "aloha-family-current-source-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type RpcResponder = (
  body: Record<string, unknown>,
  response: ServerResponse,
  requestNumber: number,
) => Promise<void> | void;

async function withRpcServer(
  responder: RpcResponder,
  run: (endpoint: string, requests: readonly Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(body);
    try {
      await responder(body, response, requests.length);
    } catch {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const selected = server.address();
  if (selected === null || typeof selected === "string") throw new TypeError("local HTTP fixture did not bind");
  try {
    await run(`http://127.0.0.1:${selected.port}/rpc?token=fixture-secret`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function success(body: Record<string, unknown>, response: ServerResponse, dataHex = reserveBytes): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: dataHex }));
}

function currentSource(selectedSource = source): FamilySearchCurrentSourceV1 {
  return Object.freeze({ source: selectedSource, assertCurrent() {} });
}

function readRequest(
  data = "0x0902f1ac",
  requestId = h(`request:${data}`),
  responseEncoding: FamilySearchSourceReadRequestV1["responseEncoding"] = "abi-uint256",
): FamilySearchSourceReadRequestV1 {
  return Object.freeze({
    kind: "family-search.current-source-read",
    requestId,
    source,
    target: pool,
    data,
    responseEncoding,
  });
}

function captureOptions(directory: string, endpoint: string) {
  return {
    rootDirectory: directory,
    familyId: UNIV2_STANDARD_FAMILY_ID,
    endpoint,
    currentSource: currentSource(),
    timeoutMs: 1_000,
    headers: { authorization: "Bearer fixture-header-secret" },
  } as const;
}

async function captureTwo(
  directory: string,
  endpoint: string,
): Promise<Readonly<{ manifest: FamilyCurrentSourceReplayManifestV1; first: FamilySearchSourceReadRequestV1; second: FamilySearchSourceReadRequestV1 }>> {
  const first = readRequest("0x0902f1ac", h("first"));
  const second = readRequest("0x70a08231", h("second"), "hex");
  const capture = createFamilyCurrentSourceCaptureV1(captureOptions(directory, endpoint));
  await capture.readPort.read({ request: first });
  await capture.readPort.read({ request: second });
  return Object.freeze({ manifest: await capture.seal(), first, second });
}

test("generated binding is explicitly a canonical file observation", () => {
  const binding = loadGeneratedFamilySearchAdapterBindingV1(UNIV2_STANDARD_FAMILY_ID);
  assert.equal(binding.familyDefinitionHash, UNIV2_STANDARD_FAMILY_DEFINITION_HASH);
  assert.equal(binding.role, "search/v1");
  assert.equal(binding.modulePath, "families/univ2-standard/src/search/adapter.ts");
  assert.equal(binding.exportName, "UNIV2_STANDARD_SEARCH_ADAPTER_FACTORY");
  assert.match(binding.generatedRuntimeSourceHash, /^0x[0-9a-f]{64}$/);
});

test("main capture rejects caller ports and fetch injection", async () => {
  await withStore((directory) => {
    const base = {
      rootDirectory: directory,
      familyId: UNIV2_STANDARD_FAMILY_ID,
      endpoint: "http://127.0.0.1:1",
      currentSource: currentSource(),
    };
    assert.throws(
      () => createFamilyCurrentSourceCaptureV1({ ...base, upstream: { read() {} } } as never),
      /unknown field "upstream"/,
    );
    assert.throws(
      () => createFamilyCurrentSourceCaptureV1({ ...base, fetch() {} } as never),
      /unknown field "fetch"/,
    );
    assert.throws(
      () => createFamilyCurrentSourceCaptureV1({
        ...base,
        transportOrigin: "reader-port-observed/untrusted-reader-port",
      } as never),
      /unknown field "transportOrigin"/,
    );
  });
});

test("local HTTP capture binds exact EIP-1898 calls, duplicate logical order, and a transport-only wrapper", async () => {
  await withStore(async (directory) => {
    await withRpcServer((body, response) => success(body, response), async (endpoint, requests) => {
      const mutableRequest = {
        kind: "family-search.current-source-read" as const,
        requestId: h("mutable"),
        source: { ...source },
        target: pool,
        data: "0x0902f1ac",
        responseEncoding: "abi-uint256" as const,
      };
      const capture = createFamilyCurrentSourceCaptureV1(captureOptions(directory, endpoint));
      const pending = capture.readPort.read({ request: mutableRequest });
      mutableRequest.target = address("9");
      mutableRequest.data = "0x70a08231";
      mutableRequest.source.hash = h("mutated-after-call");
      assert.equal((await pending).kind, "returned");
      await capture.readPort.read({ request: readRequest("0x0902f1ac", h("mutable")) });
      const manifest = await capture.seal();

      assert.equal(requests.length, 1, "production transport may share the physical response");
      assert.deepEqual(requests[0], {
        jsonrpc: "2.0",
        id: h("mutable"),
        method: "eth_call",
        params: [
          { to: pool, data: "0x0902f1ac" },
          { blockHash: source.hash, requireCanonical: true },
        ],
      });
      assert.equal(manifest.kind, "aloha.family-current-source-replay-manifest-v1");
      assert.equal(manifest.advisoryOnly, true);
      assert.equal(manifest.transportOrigin, "http-json-rpc-eip1898-observed");
      assert.equal(manifest.transportFactsOnly, true);
      assert.equal(manifest.chainStateQualified, false);
      assert.equal(manifest.adapterExecutionQualified, false);
      assert.equal(manifest.fenceClaimLevel, "before-after-observation-only-a-b-a-not-excluded");
      assert.deepEqual(capture.binding, manifest.canonicalGeneratedBinding);
      assert.equal(manifest.generatedBindingClaim, "branded-generated-runtime-binding-and-file-hash-observation-only");
      assert.equal(manifest.stateRootClaimLevel, "source-session-asserted-not-independently-queried");
      assert.equal(manifest.logicalTranscript.length, 2);
      assert.deepEqual(manifest.logicalTranscript.map((entry) => entry.sequence), ["1", "2"]);
      assert.equal(manifest.logicalTranscript[0]!.requestId, h("mutable"));
      assert.equal(manifest.logicalTranscript[0]!.source.hash, source.hash);
      assert.equal(manifest.logicalTranscript[0]!.target, pool);
      assert.equal(manifest.logicalTranscript[0]!.data, "0x0902f1ac");
      assert.equal(manifest.logicalTranscript[0]!.responseEncoding, "abi-uint256");
      assert.equal(manifest.logicalTranscript[0]!.descriptorKey, manifest.logicalTranscript[1]!.descriptorKey);
      assert.equal(manifest.logicalTranscript[0]!.responseObjectHash, manifest.logicalTranscript[1]!.responseObjectHash);
      assert.notEqual(manifest.manifestRoot, manifest.historicalRpcReplayManifestRoot);

      const stored = readFileSync(
        join(directory, "family-current-source-replay-v1", "manifests", `${manifest.manifestRoot.slice(2)}.json`),
        "utf8",
      );
      assert.equal(stored.includes(endpoint), false);
      assert.equal(stored.includes("fixture-secret"), false);
      assert.equal(stored.includes("fixture-header-secret"), false);

      const frozen = createFrozenFamilyCurrentSourceReplayV1({ rootDirectory: directory, manifestRoot: manifest.manifestRoot });
      await frozen.readPort.read({ request: readRequest("0x0902f1ac", h("mutable")) });
      await frozen.readPort.read({ request: readRequest("0x0902f1ac", h("mutable")) });
      frozen.assertExactTranscriptConsumed();
      assert.deepEqual(frozen.stats(), { requests: 2, consumed: 2, expected: 2, violations: 0, misses: 0 });
    });
  });
});

test("Fluid declared-revert completion and RPC code survive exact capture and frozen replay", async () => {
  await withStore(async (directory) => {
    const dataHex = `${FLUID_DEX_SWAP_RESULT_SELECTOR}${word(123n)}`;
    await withRpcServer((body, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: 3, message: "execution reverted", data: dataHex },
      }));
    }, async (endpoint) => {
      const selected = Object.freeze({
        ...readRequest("0xabcdef01", h("fluid-declared-revert"), "abi-fluid-dex-swap-result-v1"),
        declaredRevertData: Object.freeze({
          kind: "declared-revert-data" as const,
          dataEncoding: "abi-fluid-dex-swap-result-v1" as const,
          selector: FLUID_DEX_SWAP_RESULT_SELECTOR,
          byteLength: 36,
        }),
      });
      const capture = createFamilyCurrentSourceCaptureV1({
        ...captureOptions(directory, endpoint),
        familyId: FLUID_DEX_FAMILY_ID,
      });
      const observed = await capture.readPort.read({ request: selected });
      assert.deepEqual(observed, {
        kind: "reverted",
        reasonCode: "declared-revert-data",
        requestId: selected.requestId,
        source,
        rpcErrorCode: 3,
        dataEncoding: selected.declaredRevertData.dataEncoding,
        dataHex,
      });
      const manifest = await capture.seal();
      assert.equal(manifest.logicalTranscript[0]!.completion, "declared-revert-data");
      assert.equal(manifest.logicalTranscript[0]!.rpcErrorCode, 3);
      assert.equal(manifest.logicalTranscript[0]!.resultDataEncoding, selected.declaredRevertData.dataEncoding);
      assert.deepEqual(manifest.logicalTranscript[0]!.declaredRevertData, selected.declaredRevertData);

      const frozen = createFrozenFamilyCurrentSourceReplayV1({ rootDirectory: directory, manifestRoot: manifest.manifestRoot });
      assert.deepEqual(await frozen.readPort.read({ request: selected }), observed);
      frozen.assertExactTranscriptConsumed();

      const withoutDeclaration = createFrozenFamilyCurrentSourceReplayV1({ rootDirectory: directory, manifestRoot: manifest.manifestRoot });
      const { declaredRevertData: _declaredRevertData, ...plain } = selected;
      await assert.rejects(async () => withoutDeclaration.readPort.read({ request: plain }), /transcript mismatch/);
    });
  });
});

test("frozen replay requires the exact ordered logical transcript", async () => {
  await withStore(async (directory) => {
    await withRpcServer((body, response) => success(body, response), async (endpoint) => {
      const { manifest, first, second } = await captureTwo(directory, endpoint);
      const fresh = () => createFrozenFamilyCurrentSourceReplayV1({ rootDirectory: directory, manifestRoot: manifest.manifestRoot });

      assert.throws(() => fresh().assertExactTranscriptConsumed(), /exact transcript/);

      const subset = fresh();
      await subset.readPort.read({ request: first });
      assert.throws(() => subset.assertExactTranscriptConsumed(), /exact transcript/);

      const reorder = fresh();
      await assert.rejects(async () => reorder.readPort.read({ request: second }), /transcript mismatch/);
      assert.throws(() => reorder.assertExactTranscriptConsumed(), /exact transcript/);

      const repeat = fresh();
      await repeat.readPort.read({ request: first });
      await assert.rejects(async () => repeat.readPort.read({ request: first }), /transcript mismatch/);

      const encodingMutation = fresh();
      await assert.rejects(async () => encodingMutation.readPort.read({
        request: { ...first, responseEncoding: "hex" },
      }), /transcript mismatch/);

      const requestIdMutation = fresh();
      await assert.rejects(async () => requestIdMutation.readPort.read({
        request: { ...first, requestId: h("wrong-request-id") },
      }), /transcript mismatch/);

      const sourceMutation = fresh();
      await assert.rejects(async () => sourceMutation.readPort.read({
        request: { ...first, source: { ...source, hash: h("wrong-source") } },
      }), /transcript mismatch/);

      const extra = fresh();
      await extra.readPort.read({ request: first });
      await extra.readPort.read({ request: second });
      extra.assertExactTranscriptConsumed();
      await assert.rejects(async () => extra.readPort.read({ request: second }), /extra transcript request/);
      assert.throws(() => extra.assertExactTranscriptConsumed(), /exact transcript/);
    });
  });
});

test("mid-flight consumer abort and deadline poison capture after the awaited HTTP response", async () => {
  for (const mode of ["abort", "deadline"] as const) {
    await withStore(async (directory) => {
      let arrivedResolve!: () => void;
      const arrived = new Promise<void>((resolve) => { arrivedResolve = resolve; });
      let releaseResolve!: () => void;
      const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
      await withRpcServer(async (body, response) => {
        arrivedResolve();
        await release;
        success(body, response);
      }, async (endpoint) => {
        const capture = createFamilyCurrentSourceCaptureV1(captureOptions(directory, endpoint));
        const controller = new AbortController();
        const deadlineAtMs = performance.now() + 30;
        const pending = capture.readPort.read({
          request: readRequest(),
          ...(mode === "abort" ? { signal: controller.signal } : { deadlineAtMs }),
        });
        const observed = Promise.resolve(pending).then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );
        await arrived;
        if (mode === "abort") controller.abort();
        else while (performance.now() < deadlineAtMs) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        releaseResolve();
        const completed = await observed;
        if (completed.error !== null) {
          assert.match(String(completed.error), mode === "abort" ? /aborted/ : /deadline elapsed/);
        } else {
          assert.equal(completed.value?.kind, "unavailable");
        }
        await assert.rejects(async () => capture.seal(), /not sealable/);
      });
    });
  }
});

test("wrong RPC id, RPC error, malformed response, HTTP unavailable, and wrong source cannot seal", async () => {
  for (const mode of ["wrong-id", "rpc-error", "malformed", "unavailable", "wrong-source"] as const) {
    await withStore(async (directory) => {
      await withRpcServer((body, response) => {
        if (mode === "unavailable") {
          response.writeHead(503, { "content-type": "application/json" });
          response.end("unavailable");
        } else if (mode === "malformed") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("not-json");
        } else if (mode === "rpc-error") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "fixture" } }));
        } else if (mode === "wrong-id") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: h("wrong-id"), result: reserveBytes }));
        } else {
          success(body, response);
        }
      }, async (endpoint, requests) => {
        const capture = createFamilyCurrentSourceCaptureV1(captureOptions(directory, endpoint));
        const selected = mode === "wrong-source"
          ? { ...readRequest(), source: { ...source, hash: h("wrong-source") } }
          : readRequest();
        const result = await capture.readPort.read({ request: selected });
        assert.equal(result.kind, "unavailable");
        await assert.rejects(async () => capture.seal(), /not sealable/);
        if (mode === "wrong-source") assert.equal(requests.length, 0);
      });
    });
  }
});

test("frozen pre-abort and elapsed deadline permanently poison exact consumption even after a full retry", async () => {
  await withStore(async (directory) => {
    await withRpcServer((body, response) => success(body, response), async (endpoint) => {
      const capture = createFamilyCurrentSourceCaptureV1(captureOptions(directory, endpoint));
      const selected = readRequest();
      await capture.readPort.read({ request: selected });
      const manifest = await capture.seal();
      const frozen = createFrozenFamilyCurrentSourceReplayV1({ rootDirectory: directory, manifestRoot: manifest.manifestRoot });
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(async () => frozen.readPort.read({ request: selected, signal: controller.signal }), /aborted/);
      await assert.rejects(
        async () => frozen.readPort.read({ request: selected, deadlineAtMs: performance.now() - 1 }),
        /deadline elapsed/,
      );
      await frozen.readPort.read({ request: selected });
      assert.deepEqual(frozen.stats(), { requests: 3, consumed: 1, expected: 1, violations: 2, misses: 0 });
      assert.throws(() => frozen.assertExactTranscriptConsumed(), /exact transcript/);
    });
  });
});

test("wrapper decoder rejects chain-state qualification escalation and root mutation", async () => {
  for (const mode of ["chain-state", "root"] as const) {
    await withStore(async (directory) => {
      await withRpcServer((body, response) => success(body, response), async (endpoint) => {
        const capture = createFamilyCurrentSourceCaptureV1(captureOptions(directory, endpoint));
        await capture.readPort.read({ request: readRequest() });
        const manifest = await capture.seal();
        const path = join(
          directory,
          "family-current-source-replay-v1",
          "manifests",
          `${manifest.manifestRoot.slice(2)}.json`,
        );
        const decoded = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        if (mode === "chain-state") decoded.chainStateQualified = true;
        else decoded.manifestRoot = h("mutated-wrapper-root");
        writeFileSync(path, encodeCanonicalBytes(decoded as never));
        assert.throws(
          () => createFrozenFamilyCurrentSourceReplayV1({ rootDirectory: directory, manifestRoot: manifest.manifestRoot }),
          mode === "chain-state" ? /invalid Family current-source replay manifest discriminator/ : /manifest root mismatch/,
        );
      });
    });
  }
});

test("wrapper loader rejects self-consistent bytes stored under another requested root", async () => {
  await withStore(async (directory) => {
    await withRpcServer((body, response) => success(body, response), async (endpoint) => {
      const first = createFamilyCurrentSourceCaptureV1(captureOptions(directory, endpoint));
      await first.readPort.read({ request: readRequest("0x0902f1ac", h("requested-root")) });
      const requested = await first.seal();

      const second = createFamilyCurrentSourceCaptureV1(captureOptions(directory, endpoint));
      await second.readPort.read({ request: readRequest("0x70a08231", h("foreign-root"), "hex") });
      const foreign = await second.seal();
      assert.notEqual(requested.manifestRoot, foreign.manifestRoot);

      const manifests = join(directory, "family-current-source-replay-v1", "manifests");
      writeFileSync(
        join(manifests, `${requested.manifestRoot.slice(2)}.json`),
        readFileSync(join(manifests, `${foreign.manifestRoot.slice(2)}.json`)),
      );
      assert.throws(
        () => createFrozenFamilyCurrentSourceReplayV1({ rootDirectory: directory, manifestRoot: requested.manifestRoot }),
        /does not match the requested root/,
      );
    });
  });
});

test("HTTP wrapper rejects a self-consistent caller-materialized inner replay origin", async () => {
  await withStore(async (directory) => {
    await withRpcServer((body, response) => success(body, response), async (endpoint) => {
      const capture = createFamilyCurrentSourceCaptureV1(captureOptions(directory, endpoint));
      await capture.readPort.read({ request: readRequest() });
      const manifest = await capture.seal();
      const innerPath = join(
        directory,
        "rpc-replay-v1",
        "manifests",
        `${manifest.historicalRpcReplayManifestRoot.slice(2)}.json`,
      );
      const inner = JSON.parse(readFileSync(innerPath, "utf8")) as Record<string, unknown>;
      const { manifestRoot: ignoredInnerRoot, ...innerBase } = inner;
      void ignoredInnerRoot;
      const callerInnerBase = {
        ...innerBase,
        transportOrigin: "caller-materialized/untrusted-caller-material",
      };
      const callerInnerRoot = hashDomain("aloha/historical-rpc-replay-manifest/v1", callerInnerBase);
      writeFileSync(
        join(directory, "rpc-replay-v1", "manifests", `${callerInnerRoot.slice(2)}.json`),
        encodeCanonicalBytes({ ...callerInnerBase, manifestRoot: callerInnerRoot } as never),
      );
      const outerPath = join(
        directory,
        "family-current-source-replay-v1",
        "manifests",
        `${manifest.manifestRoot.slice(2)}.json`,
      );
      const outer = JSON.parse(readFileSync(outerPath, "utf8")) as Record<string, unknown>;
      const { manifestRoot: ignoredOuterRoot, ...outerBase } = outer;
      void ignoredOuterRoot;
      const callerOuterBase = { ...outerBase, historicalRpcReplayManifestRoot: callerInnerRoot };
      const callerOuterRoot = hashDomain("aloha/family-current-source-replay-manifest/v1", callerOuterBase);
      writeFileSync(
        join(directory, "family-current-source-replay-v1", "manifests", `${callerOuterRoot.slice(2)}.json`),
        encodeCanonicalBytes({ ...callerOuterBase, manifestRoot: callerOuterRoot } as never),
      );
      assert.throws(
        () => createFrozenFamilyCurrentSourceReplayV1({ rootDirectory: directory, manifestRoot: callerOuterRoot }),
        /historical transport origin mismatch/,
      );
    });
  });
});

test("wrapper roots and stored bytes are deterministic", async () => {
  await withStore(async (directory) => {
    await withRpcServer((body, response) => success(body, response), async (endpoint) => {
      const first = createFamilyCurrentSourceCaptureV1(captureOptions(directory, endpoint));
      await first.readPort.read({ request: readRequest() });
      const left = await first.seal();
      const second = createFamilyCurrentSourceCaptureV1(captureOptions(directory, endpoint));
      await second.readPort.read({ request: readRequest() });
      const right = await second.seal();
      assert.equal(left.manifestRoot, right.manifestRoot);
      assert.deepEqual(Buffer.from(encodeCanonicalBytes(left)), Buffer.from(encodeCanonicalBytes(right)));
    });
  });
});

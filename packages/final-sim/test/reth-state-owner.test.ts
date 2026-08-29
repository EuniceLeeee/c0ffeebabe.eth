import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { createCanonicalSource, type CanonicalJournalStorePort, type ProducerSessionV1 } from "../../canonical-source/src/index.ts";
import type { CanonicalCutoffV1 } from "../../discovery/src/index.ts";
import { encodeExecutorExecuteCalldata, encodePackedCallProgram } from "../../execution-program/src/index.ts";
import { createTestRevmAuthorityIssuer } from "../../../runtime/revm-workers/test/qualified-authority.ts";
import { sealEmptyNominationClosureFixture } from "../../../specs/nomination-authority/test/fixture.ts";
import {
  createRethQualifiedExecutorStateOwner,
  RethStateOwnerError,
} from "../src/index.ts";
import { createSourceBoundExecutorProjection, type ExecutionProgramArtifactV1, type SourceViewV1 } from "../src/index.ts";
import { issueQualifiedFinalSimulationPortFactoryV1 } from "../src/internal/final-simulation-owner.ts";

const h = (value: string): Hash => hashDomain("test/reth-state-owner", value);
const source: CanonicalCutoffV1 = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const head = Object.freeze({ ...source, parentHash: h("parent-block") });
const cutoff: CanonicalCutoffV1 = Object.freeze({ chainId: "1", number: "99", hash: h("cutoff"), stateRoot: h("cutoff-state") });
const nomination = sealEmptyNominationClosureFixture({
  cutoff,
  familyId: "final-sim-fixture-family",
  familyDefinitionHash: h("nomination-family-definition"),
  sourcePlanIdentity: h("nomination-source-plan-identity"),
  sourcePlanLeafDigest: h("nomination-source-plan-leaf"),
  nominationProgramRoot: h("nomination-program"),
  nominationProgramProposalLeafDigest: h("nomination-program-proposal"),
  qualificationRoot: h("nomination-qualification"),
  recentObservationRoot: h("nomination-recent-observation"),
  sourceExecutionSetRoot: h("nomination-source-execution-set"),
  sourceCoverageRoot: h("nomination-source-coverage"),
  persistedExecutionRoot: h("nomination-persisted-execution"),
  resultPartitionRoot: h("nomination-result-partition"),
});
const executorAddress = "0x2222222222222222222222222222222222222222";
const callerAddress = "0x1111111111111111111111111111111111111111";
const tokenAddress = "0x3333333333333333333333333333333333333333";
const storageSlot = `0x${"00".repeat(31)}01`;
const executorCode = "0x600054600101600055600054602060005260206000f3";

function program(): ExecutionProgramArtifactV1 {
  const programBytes = encodeExecutorExecuteCalldata(encodePackedCallProgram([{ target: tokenAddress, value: "0", calldata: "0x" }]));
  const body = {
    kind: "execution-program" as const,
    generationId: "generation-1",
    source,
    routeHash: h("route"),
    programBytes,
    payloadHash: h("payload"),
    issuerRef: h("issuer"),
    obligationRoot: h("obligations"),
  };
  return Object.freeze({ ...body, programHash: hashDomain("aloha/execution-program-artifact/v1", body) });
}

class MemoryJournalStore implements CanonicalJournalStorePort {
  #token: string | null = null;
  #bytes: Uint8Array | null = null;

  load() {
    return this.#bytes === null || this.#token === null ? null : { token: this.#token, bytes: new Uint8Array(this.#bytes) };
  }

  compareAndSwap(expectedToken: string | null, bytes: Uint8Array): string {
    if (expectedToken !== this.#token) throw new Error("journal CAS conflict");
    this.#token = this.#token === null ? "1" : String(Number(this.#token) + 1);
    this.#bytes = new Uint8Array(bytes);
    return this.#token;
  }
}

async function sessionFixture(): Promise<{ readonly session: ProducerSessionV1; readonly graph: { readonly binding: Record<string, unknown>; readonly assertActive: () => void } }> {
  const canonical = createCanonicalSource({
    async getLatestHeader() { return head; },
    async getHeader(number: string) {
      return number === head.number ? { kind: "found" as const, header: head } : { kind: "unavailable" as const, failureCode: "not-indexed" };
    },
  }, { journalStore: new MemoryJournalStore() });
  await canonical.freezeView();
  const graph = {
    binding: {
      generationId: "generation-1",
      readyRecordHash: h("ready"),
      generationRefreshPolicyHash: h("policy"),
      cutoff,
      definitionCatalogRoot: h("definition"),
      instanceCatalogRoot: h("instance"),
      graphRoot: h("graph"),
      releaseProvenanceHash: h("release"),
      candidatePartitionProofStorageHash: h("partition"),
      nominationClosureRoot: nomination.closure.root,
      nominationClosureStorageHash: nomination.storageHash,
    },
    assertActive: () => undefined,
  };
  const observation = await canonical.observeCurrentHead();
  const producerSession = await canonical.openHeadSession(observation, graph);
  return { session: producerSession, graph };
}

interface RpcRequest {
  readonly id: string;
  readonly method: string;
  readonly params: readonly unknown[];
}

function fixtureFetch(calls: RpcRequest[]): typeof globalThis.fetch {
  return (async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    calls.push(request);
    let result: unknown;
    if (request.method === "eth_getBlockByHash") {
      result = {
        hash: source.hash,
        number: "0x64",
        stateRoot: source.stateRoot,
        timestamp: "0x7",
        gasLimit: "0x1c9c380",
        baseFeePerGas: "0x1",
        miner: "0x4444444444444444444444444444444444444444",
        mixHash: h("mix"),
      };
    } else if (request.method === "eth_getBalance") {
      result = request.params[0] === executorAddress ? "0x2a" : "0x0";
    } else if (request.method === "eth_getTransactionCount") {
      result = request.params[0] === executorAddress ? "0x2" : "0x0";
    } else if (request.method === "eth_getCode") {
      result = request.params[0] === executorAddress ? executorCode : "0x";
    } else if (request.method === "eth_getStorageAt") {
      result = "0x" + "00".repeat(31) + "2a";
    } else {
      throw new Error(`unexpected method ${request.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200 });
  }) as typeof globalThis.fetch;
}

test("Reth owner reads exact EIP-1898 state and only then issues final-sim capability", async () => {
  const calls: RpcRequest[] = [];
  const authority = createTestRevmAuthorityIssuer(["state-owner-epoch"]);
  const owner = createRethQualifiedExecutorStateOwner({ endpoint: "http://reth.test", fetch: fixtureFetch(calls) });
  const { session } = await sessionFixture();
  const snapshot = await owner.issue({
    session: session.currentSourceCapability,
    authority,
    executorAddress,
    callerAddress,
    qualifiedExecutorCodeHash: hashDomain("aloha/qualified-final-simulation-executor-code/v1", executorCode),
    executorConfig: { gasLimit: "1000000", value: "0" },
    accounts: [{ address: tokenAddress, storageSlots: [storageSlot] }],
  });
  const projection = createSourceBoundExecutorProjection({ snapshot, authority });
  const projected = projection.project({ program: program(), callerId: callerAddress, generationId: "generation-1", cutoff });
  const input = projected.input as Record<string, unknown>;
  assert.equal(input.to, executorAddress);
  assert.equal((input.accounts as Record<string, unknown>)[executorAddress] && ((input.accounts as Record<string, Record<string, unknown>>)[executorAddress]!.code), executorCode);
  assert.equal(((input.accounts as Record<string, Record<string, unknown>>)[executorAddress]!.balance), "42");
  assert.equal(((input.accounts as Record<string, Record<string, unknown>>)[tokenAddress]!.storage as Record<string, string>)[storageSlot], `0x${"00".repeat(31)}2a`);
  assert.deepEqual(input.block, { timestamp: "7", gasLimit: "30000000", baseFeePerGas: "1", beneficiary: "0x4444444444444444444444444444444444444444", prevrandao: h("mix") });
  const stateReads = calls.filter(call => call.method !== "eth_getBlockByHash");
  assert.ok(stateReads.length > 0);
  for (const call of stateReads) {
    const block = call.params.at(-1);
    assert.deepEqual(block, { blockHash: source.hash, requireCanonical: true });
  }
  assert.equal(calls.filter(call => call.method === "eth_getBlockByHash").length, 1);
});

test("Reth owner overlaps state reads without exceeding its physical request bound", async () => {
  const calls: RpcRequest[] = [];
  const baseFetch = fixtureFetch(calls);
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fallback = setTimeout(release, 200);
  const fetch = (async (url, init) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (active === 8) {
      clearTimeout(fallback);
      release();
    }
    try {
      await gate;
      return await baseFetch(url, init);
    } finally {
      active -= 1;
    }
  }) as typeof globalThis.fetch;
  const authority = createTestRevmAuthorityIssuer(["state-owner-bounded-epoch"]);
  const owner = createRethQualifiedExecutorStateOwner({
    endpoint: "http://reth.test",
    fetch,
  });
  const { session } = await sessionFixture();
  await owner.issue({
    session: session.currentSourceCapability,
    authority,
    executorAddress,
    callerAddress,
    qualifiedExecutorCodeHash: hashDomain("aloha/qualified-final-simulation-executor-code/v1", executorCode),
    accounts: [{ address: tokenAddress, storageSlots: [storageSlot] }],
  });
  assert.equal(maxActive, 8);
  assert.equal(active, 0);
  assert.equal(calls.length, 11);
});

test("Reth owner rejects caller-supplied state, wrong qualified code, and source changes", async () => {
  const authority = createTestRevmAuthorityIssuer(["state-owner-epoch"]);
  const calls: RpcRequest[] = [];
  const owner = createRethQualifiedExecutorStateOwner({ endpoint: "http://reth.test", fetch: fixtureFetch(calls) });
  const fixture = await sessionFixture();
  await assert.rejects(
    () => owner.issue({ session: fixture.session.currentSourceCapability, authority, executorAddress, callerAddress, qualifiedExecutorCodeHash: hashDomain("aloha/qualified-final-simulation-executor-code/v1", executorCode), executorConfig: { accounts: {} } }),
    /state-owned/,
  );
  await assert.rejects(
    () => owner.issue({ session: fixture.session.currentSourceCapability, authority, executorAddress, callerAddress, qualifiedExecutorCodeHash: h("wrong-code") }),
    (error: unknown) => error instanceof RethStateOwnerError && error.code === "state-mismatch",
  );
  const stale = await sessionFixture();
  stale.graph.binding.generationId = "generation-mutated";
  await assert.rejects(
    () => owner.issue({ session: stale.session.currentSourceCapability, authority, executorAddress, callerAddress, qualifiedExecutorCodeHash: hashDomain("aloha/qualified-final-simulation-executor-code/v1", executorCode) }),
    (error: unknown) => error instanceof RethStateOwnerError && error.code === "source-stale",
  );
  const cutoffMutation = await sessionFixture();
  cutoffMutation.graph.binding.cutoff = source;
  await assert.rejects(
    () => owner.issue({ session: cutoffMutation.session.currentSourceCapability, authority, executorAddress, callerAddress, qualifiedExecutorCodeHash: hashDomain("aloha/qualified-final-simulation-executor-code/v1", executorCode) }),
    (error: unknown) => error instanceof RethStateOwnerError && error.code === "source-stale",
  );
  const clone = await sessionFixture();
  await assert.rejects(
    () => owner.issue({ session: Object.freeze({ ...clone.session.currentSourceCapability }) as never, authority, executorAddress, callerAddress, qualifiedExecutorCodeHash: hashDomain("aloha/qualified-final-simulation-executor-code/v1", executorCode) }),
    /not canonical-source issued/,
  );
});

test("final-sim factory resolves only the explicit canonical-source session capability", async () => {
  const { session } = await sessionFixture();
  let issuedFor: Hash | null = null;
  const factory = issueQualifiedFinalSimulationPortFactoryV1<unknown>({
    issue(currentSource, currentSourceCapability) {
      issuedFor = currentSource.sessionId;
      assert.equal(currentSourceCapability, session.currentSourceCapability);
      return Object.freeze({
        rejectionAuthority: Object.freeze({
          read() { throw new TypeError("no final-simulation rejection was issued"); },
        }),
        async simulate() {
          return Object.freeze({ kind: "retryable" as const, stage: "final-sim" as const, code: "test-only" });
        },
      });
    },
  });
  await factory.issue(session.currentSourceCapability);
  assert.equal(issuedFor, session.sessionId);
  await assert.rejects(
    async () => factory.issue(Object.freeze({ ...session.currentSourceCapability }) as never),
    /not canonical-source issued/,
  );
  await session.close();
  await assert.rejects(
    async () => factory.issue(session.currentSourceCapability),
    /producer session is closed/,
  );
});

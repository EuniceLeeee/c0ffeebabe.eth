import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  decodeSourcePlanDiscoveryResult,
  sealSourceCoverage,
  type CanonicalCutoffV1,
  type SourcePlanRefV1,
} from "../../discovery/src/index.ts";
import { sealRecentObservation } from "../../observation/src/index.ts";
import { WorkScheduler } from "../../scheduler/src/index.ts";
import {
  releaseApproval,
  runtimeAuthorityForReleaseApproval,
} from "../../attestation/test/authority-fixture.ts";
import {
  UNIV2_PAIR_CREATED_TOPIC0,
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_FAMILY_ID,
  UNIV2_STANDARD_HISTORY_NOMINATION_PROGRAM,
  UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME,
  UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  UNIV2_STANDARD_SOURCE_NOMINATION_PROGRAM,
  UNIV2_STANDARD_SOURCE_PLAN_RUNTIME,
  UNIV2_STANDARD_SOURCE_PLAN_SCHEMA_HASH,
  UNIV2_SYNC_EVENT_TOPIC0,
} from "../../../families/univ2-standard/src/public.ts";
import {
  createRuntimeReleaseDiscoveryPort,
  type RuntimeReleaseSourcePlanBindingV1,
} from "../src/internal/discovery-owner.ts";
import {
  issueRuntimeReleaseQualifiedDiscoverySourcePort,
  readRuntimeReleaseQualifiedDiscoverySourcePort,
} from "../src/internal/discovery-source-authority-owner.ts";

const h = (value: string): Hash => hashDomain("test/runtime-release-discovery-continuity", value);
const pool = `0x${"11".repeat(20)}`;

const cutoff = (number: bigint): CanonicalCutoffV1 => Object.freeze({
  chainId: "1",
  number: number.toString(),
  hash: h(`block:${number}`),
  stateRoot: h(`state:${number}`),
});

const blockTag = (value: bigint): string => `0x${value.toString(16)}`;

interface RecordedRpc {
  readonly method: string;
  readonly params: readonly CanonicalJson[];
}

async function rpcFixture(options: { readonly recentSiblings?: boolean } = {}) {
  const requests: RecordedRpc[] = [];
  let invalidHistoryDelta = false;
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      readonly id: string;
      readonly method: string;
      readonly params: readonly CanonicalJson[];
    };
    requests.push({ method: rpc.method, params: rpc.params });
    let result: CanonicalJson;
    if (rpc.method === "eth_chainId") {
      result = "0x1";
    } else if (rpc.method === "eth_getBlockByNumber") {
      const number = BigInt(String(rpc.params[0]));
      const value = cutoff(number);
      result = {
        number: blockTag(number),
        hash: value.hash,
        parentHash: h(`block:${number - 1n}`),
        stateRoot: value.stateRoot,
      };
    } else if (rpc.method === "eth_getLogs") {
      const filter = rpc.params[0] as Readonly<Record<string, CanonicalJson>>;
      if (Object.prototype.hasOwnProperty.call(filter, "blockHash")) {
        const blockHash = filter.blockHash;
        result = options.recentSiblings && blockHash === cutoff(49n).hash
          ? [{
            address: pool,
            topics: [UNIV2_SYNC_EVENT_TOPIC0],
            data: "0x",
            blockNumber: "0x31",
            blockHash,
            transactionHash: h("matching-tx"),
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false,
          }, {
            address: pool,
            topics: [h("unrelated-topic")],
            data: "0x1234",
            blockNumber: "0x31",
            blockHash,
            transactionHash: h("sibling-tx"),
            transactionIndex: "0x1",
            logIndex: "0x1",
            removed: false,
          }]
          : [];
      } else {
        result = invalidHistoryDelta && filter.fromBlock === "0x33"
          ? [{
            address: `0x${"ff".repeat(20)}`,
            topics: [
              UNIV2_PAIR_CREATED_TOPIC0,
              `0x${"0".repeat(24)}${"22".repeat(20)}`,
              `0x${"0".repeat(24)}${"33".repeat(20)}`,
            ],
            data: `0x${"0".repeat(24)}${pool.slice(2)}${"1".padStart(64, "0")}`,
            blockNumber: "0x32",
            blockHash: cutoff(50n).hash,
            transactionHash: h("invalid-delta-tx"),
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false,
          }]
          : [];
      }
    } else {
      throw new Error(`unexpected RPC method ${rpc.method}`);
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("RPC fixture did not bind");
  return Object.freeze({
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    setInvalidHistoryDelta(value: boolean) {
      invalidHistoryDelta = value;
    },
    async close() {
      server.close();
      await once(server, "close");
    },
  });
}

function releaseDiscoveryFixture(
  endpoint: string,
  plans: readonly Omit<RuntimeReleaseSourcePlanBindingV1, "nominationProgramProposalLeafDigest" | "nominationQualificationLeafDigest">[],
) {
  const approval = releaseApproval(
    h("framework"),
    h("executor"),
    "worker-epoch",
    h("executor-session"),
    h("release-authority"),
    h("qualified-capabilities"),
    endpoint,
  );
  const authority = runtimeAuthorityForReleaseApproval(approval);
  const binding = approval.resolver.resolve(approval.capability).provenance.runtimeBinding;
  const qualification = binding.nominationQualificationSet.entries[0]!;
  const source = readRuntimeReleaseQualifiedDiscoverySourcePort(
    authority,
    issueRuntimeReleaseQualifiedDiscoverySourcePort(authority, {
      profile: "reth-json-rpc-v1",
      endpoint,
      chainId: "1",
      providerIdentity: "reth-mainnet",
      backendEpoch: "reth-backend-1",
    }),
  );
  const createPort = (processEpoch: string, scheduler: WorkScheduler) => createRuntimeReleaseDiscoveryPort({
    bindings: plans.map(plan => Object.freeze({
      ...plan,
      nominationProgramProposalLeafDigest: qualification.proposalLeafDigest,
      nominationQualificationLeafDigest: qualification.qualificationLeafDigest,
    })),
    source,
    scheduler,
    release: {
      bindingId: source.release.bindingId,
      releaseProvenanceHash: source.release.releaseProvenanceHash,
      processEpoch,
    },
    assertCurrent() {},
  });
  return Object.freeze({ approval, binding, source, createPort });
}

const recentPlan: SourcePlanRefV1 = Object.freeze({
  ownerRef: h("recent-owner"),
  sourcePlanRef: h("recent-plan"),
  familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  completeness: "nomination-only",
  historyStartBlock: null,
});

const historyPlan: SourcePlanRefV1 = Object.freeze({
  ownerRef: h("history-owner"),
  sourcePlanRef: h("history-plan"),
  familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  completeness: "contiguous-history",
  historyStartBlock: "0",
});

test("real 50-block observer keeps same-block topic siblings out of the Family and exact-binds matching raw bytes", async () => {
  const rpc = await rpcFixture({ recentSiblings: true });
  try {
    const release = releaseDiscoveryFixture(rpc.endpoint, [{
      familyId: UNIV2_STANDARD_FAMILY_ID,
      familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
      sourcePlanRef: recentPlan,
      sourcePlanLeafDigest: h("recent-leaf"),
      sourcePlanSchemaHash: UNIV2_STANDARD_SOURCE_PLAN_SCHEMA_HASH,
      sourcePlanClosureRoot: h("recent-closure"),
      runtime: UNIV2_STANDARD_SOURCE_PLAN_RUNTIME,
      nominationProgram: UNIV2_STANDARD_SOURCE_NOMINATION_PROGRAM,
      nominationProgramRoot: h("recent-program"),
    }]);
    const scheduler = new WorkScheduler();
    const port = release.createPort("topic-sibling-process", scheduler);
    const catalog = { definitionCatalogRoot: h("catalog"), declaredSourcePlans: [recentPlan] };
    const frozenCutoff = cutoff(49n);
    const source = await port.executeAllDeclaredPlans(catalog, frozenCutoff, null, new AbortController().signal);
    const scan = await port.scanRecentBlocks(frozenCutoff, new AbortController().signal);
    const recent = sealRecentObservation(frozenCutoff, { from: "0", to: "49" }, scan.blocks, scan.rawEvidenceLocators);
    const coverage = sealSourceCoverage(frozenCutoff, [recentPlan], source.discovery.executions);
    const capability = await port.nominateAll(
      catalog,
      frozenCutoff,
      source.discovery.executions,
      source.discovery.evidence,
      source.discovery.rawEvidenceLocators,
      recent,
      scan.rawEvidenceLocators,
      source.sourceExecutionSet,
      coverage,
      new AbortController().signal,
    );
    const issued = port.readIssuedNomination(capability);
    assert.equal(recent.orderedHeaders.length, 50);
    assert.equal(recent.evidence.length, 2);
    assert.equal(issued.candidates.length, 1);
    assert.equal(issued.candidates[0]!.instanceNominationKey, pool);
    assert.equal(issued.candidates[0]!.evidence.length, 1);
    assert.equal(issued.candidates[0]!.evidence[0]!.kind, "recent-log");
    if (issued.candidates[0]!.evidence[0]!.kind !== "recent-log") throw new Error("expected recent-log evidence");
    assert.equal(issued.candidates[0]!.evidence[0]!.topic, UNIV2_SYNC_EVENT_TOPIC0);
    assert.equal(rpc.requests.filter(request => request.method === "eth_getBlockByNumber").length, 51);
    assert.equal(rpc.requests.filter(request => request.method === "eth_getLogs").length, 50);
    assert.equal(rpc.requests.filter(request => request.method === "eth_chainId").length, 1);
    assert.equal(scheduler.snapshot().accounting.permitsIssued, 102);
    assert.equal(scheduler.snapshot().accounting.permitsReleased, 102);
    scheduler.assertPermitConservation();

    const second = release.createPort("topic-sibling-tamper-process", new WorkScheduler());
    const secondSource = await second.executeAllDeclaredPlans(catalog, frozenCutoff, null, new AbortController().signal);
    const matching = scan.rawEvidenceLocators.find(locator => locator.rawLocatorHash === recent.evidence.find(evidence => evidence.topic === UNIV2_SYNC_EVENT_TOPIC0)!.rawLocatorHash)!;
    const sibling = scan.rawEvidenceLocators.find(locator => locator.rawLocatorHash !== matching.rawLocatorHash)!;
    const tampered = scan.rawEvidenceLocators.map(locator => locator.rawLocatorHash === matching.rawLocatorHash
      ? Object.freeze({ ...locator, bytes: sibling.bytes })
      : locator);
    await assert.rejects(
      second.nominateAll(
        catalog,
        frozenCutoff,
        secondSource.discovery.executions,
        secondSource.discovery.evidence,
        secondSource.discovery.rawEvidenceLocators,
        recent,
        tampered,
        secondSource.sourceExecutionSet,
        sealSourceCoverage(frozenCutoff, [recentPlan], secondSource.discovery.executions),
        new AbortController().signal,
      ),
      /hash mismatch|raw evidence/i,
    );
  } finally {
    await rpc.close();
  }
});

test("real history runtime consumes only the exact successor delta and rejects a corrupt durable cursor", async () => {
  const rpc = await rpcFixture();
  try {
    const release = releaseDiscoveryFixture(rpc.endpoint, [{
      familyId: UNIV2_STANDARD_FAMILY_ID,
      familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
      sourcePlanRef: historyPlan,
      sourcePlanLeafDigest: h("history-leaf"),
      sourcePlanSchemaHash: UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
      sourcePlanClosureRoot: h("history-closure"),
      runtime: UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME,
      nominationProgram: UNIV2_STANDARD_HISTORY_NOMINATION_PROGRAM,
      nominationProgramRoot: h("history-program"),
    }]);
    const catalog = { definitionCatalogRoot: h("catalog"), declaredSourcePlans: [historyPlan] };
    const firstScheduler = new WorkScheduler();
    const firstPort = release.createPort("history-process-a", firstScheduler);
    const firstCutoff = cutoff(49n);
    const first = await firstPort.executeAllDeclaredPlans(catalog, firstCutoff, null, new AbortController().signal);
    const firstDiscovery = decodeSourcePlanDiscoveryResult(first.discovery);
    const predecessor = Object.freeze({
      sourceCoverage: sealSourceCoverage(firstCutoff, [historyPlan], firstDiscovery.executions),
      sourceExecutionSet: first.sourceExecutionSet,
      rawEvidenceLocators: firstDiscovery.rawEvidenceLocators,
    });

    const secondScheduler = new WorkScheduler();
    const secondPort = release.createPort("history-process-reopened", secondScheduler);
    const second = await secondPort.executeAllDeclaredPlans(catalog, cutoff(50n), predecessor, new AbortController().signal);
    assert.equal(second.sourceExecutionSet.executions[0]!.execution.previousAppliedThrough, "49");
    assert.equal(second.sourceExecutionSet.executions[0]!.execution.from, "50");
    assert.equal(second.sourceExecutionSet.executions[0]!.previousExecutionRoot, first.sourceExecutionSet.executions[0]!.persistedExecutionRoot);
    const rangeFilters = rpc.requests
      .filter(request => request.method === "eth_getLogs")
      .map(request => request.params[0] as Readonly<Record<string, CanonicalJson>>)
      .filter(filter => Object.prototype.hasOwnProperty.call(filter, "fromBlock"));
    assert.deepEqual(rangeFilters, [{
      fromBlock: "0x0",
      toBlock: "0x31",
      topics: [UNIV2_PAIR_CREATED_TOPIC0],
    }, {
      fromBlock: "0x32",
      toBlock: "0x32",
      topics: [UNIV2_PAIR_CREATED_TOPIC0],
    }]);
    assert.equal(firstScheduler.snapshot().accounting.permitsIssued, 3);
    assert.equal(firstScheduler.snapshot().accounting.permitsReleased, 3);
    assert.equal(secondScheduler.snapshot().accounting.permitsIssued, 3);
    assert.equal(secondScheduler.snapshot().accounting.permitsReleased, 3);
    firstScheduler.assertPermitConservation();
    secondScheduler.assertPermitConservation();

    const malformed = {
      ...predecessor,
      sourceExecutionSet: {
        ...predecessor.sourceExecutionSet,
        executionSetRoot: h("forged-execution-set-root"),
      },
    };
    const sourceScansBefore = rangeFilters.length;
    await assert.rejects(
      release.createPort("history-process-invalid-cursor", new WorkScheduler()).executeAllDeclaredPlans(
        catalog,
        cutoff(51n),
        malformed as never,
        new AbortController().signal,
      ),
      /predecessor closure is invalid|root\/order mismatch/,
    );
    const sourceScansAfter = rpc.requests
      .filter(request => request.method === "eth_getLogs")
      .map(request => request.params[0] as Readonly<Record<string, CanonicalJson>>)
      .filter(filter => Object.prototype.hasOwnProperty.call(filter, "fromBlock")).length;
    assert.equal(sourceScansAfter, sourceScansBefore, "invalid cursor must not fall back to a full physical scan");

    const secondDiscovery = decodeSourcePlanDiscoveryResult(second.discovery);
    const secondPredecessor = Object.freeze({
      sourceCoverage: sealSourceCoverage(cutoff(50n), [historyPlan], secondDiscovery.executions),
      sourceExecutionSet: second.sourceExecutionSet,
      rawEvidenceLocators: secondDiscovery.rawEvidenceLocators,
    });
    rpc.setInvalidHistoryDelta(true);
    await assert.rejects(
      release.createPort("history-process-invalid-delta", new WorkScheduler()).executeAllDeclaredPlans(
        catalog,
        cutoff(51n),
        secondPredecessor,
        new AbortController().signal,
      ),
      /outside the requested range/,
    );
    const finalSourceScans = rpc.requests
      .filter(request => request.method === "eth_getLogs")
      .map(request => request.params[0] as Readonly<Record<string, CanonicalJson>>)
      .filter(filter => Object.prototype.hasOwnProperty.call(filter, "fromBlock"));
    assert.equal(finalSourceScans.length, 3);
    assert.deepEqual(finalSourceScans[2], {
      fromBlock: "0x33",
      toBlock: "0x33",
      topics: [UNIV2_PAIR_CREATED_TOPIC0],
    });
  } finally {
    await rpc.close();
  }
});

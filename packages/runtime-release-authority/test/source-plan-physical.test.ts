import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  sealSourceCoverage,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  type CanonicalCutoffV1,
  type RawEvidenceLocatorContentV1,
  type SourcePlanEvidenceRefV1,
  type SourcePlanRefV1,
} from "../../discovery/src/index.ts";
import {
  decodeFamilySourcePlanPhysicalObservation,
  type FamilySourcePlanExecutionInputV1,
  type FamilySourcePlanPhysicalPortV1,
  type FamilySourcePlanNominationProgramV1,
  type FamilySourcePlanRuntimeV1,
} from "../../family-sdk/runtime/index.ts";
import { WorkScheduler } from "../../scheduler/src/index.ts";
import {
  releaseApproval,
  runtimeAuthorityForReleaseApproval,
} from "../../attestation/test/authority-fixture.ts";
import { createRuntimeReleaseDiscoveryPort } from "../src/internal/discovery-owner.ts";
import {
  issueRuntimeReleaseQualifiedDiscoverySourcePort,
  readRuntimeReleaseQualifiedDiscoverySourcePort,
} from "../src/internal/discovery-source-authority-owner.ts";

const h = (value: string): Hash => hashDomain("test/runtime-release-source-plan", value);
const cutoff: CanonicalCutoffV1 = Object.freeze({
  chainId: "1",
  number: "100",
  hash: h("block"),
  stateRoot: h("state"),
});
const familyDefinitionHash = h("family-definition");
const plan: SourcePlanRefV1 = Object.freeze({
  ownerRef: h("owner"),
  sourcePlanRef: h("source-plan"),
  familyDefinitionHash,
  completeness: "complete-snapshot",
  historyStartBlock: null,
});
const schemaHash = h("source-plan-schema");
const nominationProgram: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash,
  async evaluate() { return Object.freeze([]); },
});

function runtime(options: { readonly skipPhysical?: boolean; readonly forgeRaw?: boolean } = {}): FamilySourcePlanRuntimeV1 {
  return Object.freeze({
    sourcePlanId: "complete.snapshot.test",
    completeness: "complete-snapshot" as const,
    historyStartBlock: null,
    schemaHash,
    async execute(
      input: FamilySourcePlanExecutionInputV1,
      physical: FamilySourcePlanPhysicalPortV1,
      signal: AbortSignal,
    ) {
      const observed = options.skipPhysical
        ? null
        : await physical.request({
          familyDefinitionHash,
          plan: input.plan,
          cutoff: input.cutoff,
          requestSchemaHash: schemaHash,
          request: {
            kind: "family-source-plan-rpc",
            version: 1,
            method: "eth_call",
            params: Object.freeze([{ to: "0x0000000000000000000000000000000000000001", data: "0x" }, "0x64"]),
            target: "0x0000000000000000000000000000000000000001",
            manager: null,
            topic: null,
            lookback: null,
            chunk: null,
          },
        }, signal);
      let rawEvidenceLocators: readonly RawEvidenceLocatorContentV1[] = observed === null
        ? Object.freeze([])
        : Object.freeze([observed.rawEvidenceLocator]);
      let refs: readonly SourcePlanEvidenceRefV1[] = observed === null
        ? Object.freeze([])
        : Object.freeze([{
          kind: "source-plan" as const,
          version: 1 as const,
          ownerRef: input.plan.ownerRef,
          sourcePlanRef: input.plan.sourcePlanRef,
          evidenceRef: observed.evidenceRef,
          rawLocatorHash: observed.rawLocatorHash,
        }]);
      if (options.forgeRaw && observed !== null) {
        const bytes = encodeCanonicalBytes({ forged: true });
        const rawLocatorHash = sha256Hex(bytes);
        rawEvidenceLocators = Object.freeze([Object.freeze({
          kind: "raw-evidence-locator" as const,
          version: 1 as const,
          rawLocatorHash,
          bytes,
        })]);
        refs = Object.freeze([Object.freeze({ ...refs[0]!, rawLocatorHash })]);
      }
      const rawLocatorHashes = Object.freeze(rawEvidenceLocators.map(value => value.rawLocatorHash).sort());
      const sourceEvidence = Object.freeze({
        kind: "source-plan-evidence" as const,
        version: 1 as const,
        plan: input.plan,
        cutoff: input.cutoff,
        refs,
        rawLocatorHashes,
        evidenceRoot: sourcePlanEvidenceRoot({ plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes }),
      });
      const opaqueResult: CanonicalJson = Object.freeze({
        kind: "complete-snapshot-result",
        response: observed?.response ?? null,
      });
      const resultPartitionRoot = hashDomain("test/source-plan-result", opaqueResult);
      const withoutRoot = {
        kind: "source-plan-execution" as const,
        version: 1 as const,
        plan: input.plan,
        cutoff: input.cutoff,
        outcome: "complete" as const,
        from: input.cutoff.number,
        through: input.cutoff.number,
        previousAppliedThrough: null,
        resultPartitionRoot,
        opaqueResult,
        sourceEvidenceRefs: refs,
        rawLocatorHashes,
        sourceEvidenceRoot: sourceEvidence.evidenceRoot,
      };
      return Object.freeze({
        execution: Object.freeze({ ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) }),
        sourceEvidence,
        rawEvidenceLocators,
      });
    },
    async nominate() {
      return Object.freeze([]);
    },
  });
}

async function fixture(sourceRuntime: FamilySourcePlanRuntimeV1) {
  const requests: Array<{ readonly jsonrpc: string; readonly id: string; readonly method: string; readonly params: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof requests[number];
    requests.push(rpc);
    const result = rpc.method === "eth_chainId"
      ? "0x1"
      : rpc.method === "eth_getBlockByNumber"
        ? { number: "0x64", hash: cutoff.hash, stateRoot: cutoff.stateRoot }
        : { instances: [] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test RPC did not bind a TCP port");
  const bindings = [{
    familyId: "family",
    familyDefinitionHash,
    sourcePlanRef: plan,
    sourcePlanLeafDigest: h("plan-leaf"),
    sourcePlanSchemaHash: schemaHash,
    sourcePlanClosureRoot: h("plan-closure"),
    runtime: sourceRuntime,
    nominationProgram,
    nominationProgramRoot: h("nomination-program"),
    nominationProgramProposalLeafDigest: h("nomination-program-proposal"),
    nominationQualificationLeafDigest: h("nomination-qualification"),
  }];
  const endpoint = `http://127.0.0.1:${address.port}`;
  const approval = releaseApproval(
    h("source-framework-authority"),
    h("source-executor-authority"),
    "source-worker-epoch",
    h("source-executor-session"),
    h("source-release-authority"),
    h("source-capability-root"),
    endpoint,
  );
  const authority = runtimeAuthorityForReleaseApproval(approval);
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
  const scheduler = new WorkScheduler();
  const bindingId = source.release.bindingId;
  const releaseProvenanceHash = source.release.releaseProvenanceHash;
  const createPort = (processEpoch: string) => createRuntimeReleaseDiscoveryPort({
    bindings,
    source,
    scheduler,
    release: { bindingId, releaseProvenanceHash, processEpoch },
    assertCurrent() {},
  });
  return Object.freeze({
    requests,
    port: createPort("source-plan-test-process"),
    createPort,
    bindingId,
    releaseProvenanceHash,
    scheduler,
    async close() {
      server.close();
      await once(server, "close");
    },
  });
}

test("complete source coverage is derived from an owner-recorded physical observation", async () => {
  const value = await fixture(runtime());
  try {
    const discovery = await value.port.executeAllDeclaredPlans(
      { definitionCatalogRoot: h("catalog"), declaredSourcePlans: [plan] },
      cutoff,
      null,
      new AbortController().signal,
    );
    assert.deepEqual(value.requests.map(request => request.method), ["eth_chainId", "eth_getBlockByNumber", "eth_call"]);
    assert.equal(value.scheduler.snapshot().accounting.permitsIssued, 3);
    assert.equal(value.scheduler.snapshot().accounting.permitsReleased, 3);
    value.scheduler.assertPermitConservation();
    const observation = decodeFamilySourcePlanPhysicalObservation(discovery.discovery.rawEvidenceLocators[0]!.bytes);
    assert.equal(observation.releaseBindingId, value.bindingId);
    assert.equal(observation.releaseProvenanceHash, value.releaseProvenanceHash);
    assert.equal(observation.provider, "reth-mainnet");
    assert.notEqual(observation.backendEpoch, observation.sourceAuthorityRoot);
    assert.match(observation.sourceAnchorRoot, /^0x[0-9a-f]{64}$/);
    assert.equal(observation.request.method, "eth_call");
    assert.deepEqual(observation.response, { instances: [] });
    const coverage = sealSourceCoverage(cutoff, [plan], discovery.discovery.executions);
    assert.equal(coverage.entries[0]!.contributesOmissionAuthority, true);
    const restarted = await value.createPort("source-plan-test-process-restarted").executeAllDeclaredPlans(
      { definitionCatalogRoot: h("catalog"), declaredSourcePlans: [plan] },
      cutoff,
      null,
      new AbortController().signal,
    );
    assert.equal(restarted.sourceExecutionSet.executions[0]!.sourceAuthorityRoot, discovery.sourceExecutionSet.executions[0]!.sourceAuthorityRoot);
    assert.equal(value.scheduler.snapshot().accounting.permitsIssued, 6);
    assert.equal(value.scheduler.snapshot().accounting.permitsReleased, 6);
    value.scheduler.assertPermitConservation();
  } finally {
    await value.close();
  }
});

test("a self-consistent complete result without a physical observation is rejected", async () => {
  const value = await fixture(runtime({ skipPhysical: true }));
  try {
    await assert.rejects(
      value.port.executeAllDeclaredPlans(
        { definitionCatalogRoot: h("catalog"), declaredSourcePlans: [plan] },
        cutoff,
        null,
        new AbortController().signal,
      ),
      /no physical observation/,
    );
  } finally {
    await value.close();
  }
});

test("Family code cannot replace owner-recorded physical bytes", async () => {
  const value = await fixture(runtime({ forgeRaw: true }));
  try {
    await assert.rejects(
      value.port.executeAllDeclaredPlans(
        { definitionCatalogRoot: h("catalog"), declaredSourcePlans: [plan] },
        cutoff,
        null,
        new AbortController().signal,
      ),
      /not issued by the physical owner/,
    );
  } finally {
    await value.close();
  }
});

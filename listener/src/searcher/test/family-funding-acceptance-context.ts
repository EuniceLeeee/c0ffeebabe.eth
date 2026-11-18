import assert from "node:assert/strict";
import { getAddress } from "ethers";
import { assertDurableVerifiedMemoFingerprint, type DurableVerifiedMemo, type StartupCheckpointEnvelope } from "../universe-rebuild-checkpoint.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import type { FundingExecutionBinding } from "../venues/adapter-family-plugin.js";
import type { FamilyTransaction, FamilyTransactionLeg } from "./family-transaction-registry.js";
import { transactionTestActors } from "./protocol-json-sample-registration.js";
import { validateTransactionStateSelection, type TransactionStateSelection } from "./family-transaction-source.js";
import type { LoadedFamilyBox } from "../venues/family-capability-catalog.js";
import { parseFundingAcceptanceCase, type FundingAcceptanceCase, type FundingAcceptanceContext } from "./family-funding-acceptance.js";

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** Funding publishes a token to Ready's Funding table, not a synthetic Graph edge. */
export function assertFundingReadyPublication(family: LoadedFamilyBox, memo: DurableVerifiedMemo,
  source: CanonicalSource, sample: FundingAcceptanceCase) {
  assert.equal(family.plugin.manifest.domain, "funding"); assert("funding" in family.plugin);
  assert.equal(family.plugin.manifest.familyId, sample.familyId);
  assertDurableVerifiedMemoFingerprint(memo);
  assert.equal(memo.familyId, sample.familyId); assert.equal(memo.instanceKey, sample.instanceKey);
  assert.equal(source.number, sample.source.number); assert(same(source.hash, sample.source.hash));
  assert.equal(memo.validity.policy, "dependency-proof");
  assert.equal(memo.validity.proofSource.number, source.number);
  assert(same(memo.validity.proofSource.hash, source.hash), "Funding publication proof is stale");
  assert(typeof memo.memoFingerprint === "string" && memo.memoFingerprint.length > 0);
  const identity = memo.verifiedIdentity as any, descriptor = memo.compiledDescriptor as any;
  const publication = memo.staticProjection as any, candidate = memo.candidateSnapshot as any;
  const bindings = descriptor?.bindings as readonly FundingExecutionBinding[];
  assert(identity?.domain === "funding" && identity.familyId === sample.familyId);
  assert.equal(identity.source?.number, source.number); assert(same(identity.source?.hash, source.hash));
  assert.equal(identity.source?.generation, source.generation);
  assert(descriptor?.domain === "funding" && Array.isArray(bindings) && bindings.length > 0);
  assert(publication?.domain === "funding" && publication.format === "prepared-selector-funding-v1");
  assert.deepEqual(publication.bindings, bindings); assert.deepEqual(identity.bindings, bindings);
  assert(Array.isArray(publication.evidenceRefs) && publication.evidenceRefs.length > 0 && publication.evidenceRefs.every((value: unknown) => typeof value === "string" && value.length > 0));
  assert(candidate?.familyId === sample.familyId && candidate.candidateKind === "selector-funding" && candidate.assets?.some((asset:string)=>same(asset,sample.token)), "Funding candidate does not name this asset");
  const sources = family.plugin.funding.liquidity.sources([sample.token], bindings).filter(item => item.fundingId === sample.fundingId && same(item.asset, sample.token));
  assert.equal(sources.length, 1, "Funding case requires one complete provider-bound source");
  const selected = sources[0]!;
  assert.equal(selected.instanceKey, sample.instanceKey);
  assert(family.plugin.manifest.supportedLineages.includes(sample.lineageId as never));
  assert(same(getAddress(candidate.provider), getAddress(selected.provider)), "Funding candidate provider differs from current source");
  return { familyId: sample.familyId, instanceKey: sample.instanceKey, lineageId: sample.lineageId,
    asset: getAddress(sample.token), fundingId: sample.fundingId, bindings, source, memoFingerprint: memo.memoFingerprint,
    publicationKind: "funding-token" as const, memo };
}

export function assertFundingRuntimeReady(context: Pick<FundingAcceptanceContext, "family" | "memo" | "source" | "ready">,
  sample: FundingAcceptanceCase) {
  assert.deepEqual(context.source, context.ready.cutoff, "Funding Ready/source mismatch");
  return { ...assertFundingReadyPublication(context.family, context.memo, context.source, sample),
    graphHash: context.ready.graphHash, catalogHash: context.ready.catalogHash };
}

export async function assertFundingTransactionReady({ envelope, sample }: {
  envelope: StartupCheckpointEnvelope; sample: FundingAcceptanceCase;
}) {
  const [{ activeReadyMemos }, { resolveStrictReadyRuntime }, { createRebuildWiring },
    { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog }] = await Promise.all([
    import("../universe-rebuild-checkpoint.js"), import("../strict-ready-runtime.js"),
    import("../universe-rebuild-production.js"), import("../venues/production-family-composition.js"),
  ]);
  assert.equal(envelope.inProgressRun, null, "Funding requires a committed checkpoint");
  const { ready } = resolveStrictReadyRuntime(envelope.readyGeneration), family = catalog.forStrictFamily(sample.familyId as never);
  const memos = activeReadyMemos(envelope).filter(memo => memo.familyId === sample.familyId && memo.instanceKey === sample.instanceKey);
  assert.equal(memos.length, 1, "Funding case is absent or ambiguous in active Ready");
  const memo = memos[0]!, wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [sample.familyId],
    executionIdentity: { executor: sample.executor, transactionOrigin: sample.owner } });
  assert(wiring.isReadyMemoDefinitionCurrent?.(memo), "Funding Ready definition is stale");
  const publication = wiring.rehydrateVerifiedInstance({ memo, cutoff: ready.cutoff }) as any;
  assert(publication?.domain === "funding" && publication.familyId === sample.familyId && publication.instanceKey === sample.instanceKey && publication.bindings?.some((binding:FundingExecutionBinding)=>same(binding.asset,sample.token)));
  return assertFundingRuntimeReady({ family, memo, source: ready.cutoff, ready }, sample);
}

/** Current selector/call resource ownership is resolved from admitted TX census.
 * Legacy fixture family labels and asset-only keys are reference provenance. */
export async function resolveFundingTransactionCase(envelope:StartupCheckpointEnvelope, transaction:FamilyTransaction,
 leg:FamilyTransactionLeg, stateSelection?:TransactionStateSelection):Promise<FundingAcceptanceCase> {
  assert.equal(leg.domain,"funding");
  const [{activeReadyMemos},{PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG:catalog}]=await Promise.all([
    import("../universe-rebuild-checkpoint.js"),import("../venues/production-family-composition.js")]);
  const matches:FundingAcceptanceCase[]=[];
  for(const memo of activeReadyMemos(envelope)){
    const family=catalog.forStrictFamily(memo.familyId as never);if(family.plugin.manifest.domain!=="funding" || !("funding" in family.plugin))continue;
    const candidate=memo.candidateSnapshot as any;
    if(candidate?.census?.transactionHash?.toLowerCase()!==transaction.transactionHash.toLowerCase())continue;
    const bindings=(memo.compiledDescriptor as any)?.bindings as readonly FundingExecutionBinding[]|undefined;if(!bindings?.length)continue;
    for(const binding of bindings){
      if(!same(binding.asset,leg.tokenIn!) || leg.execution?.target && !same(binding.provider,leg.execution.target) ||
        leg.execution?.selector && !same(binding.selector,leg.execution.selector) || leg.execution?.poolId!==undefined && binding.poolId!==leg.execution.poolId ||
        leg.execution?.poolNamespace!==undefined && binding.poolNamespace!==leg.execution.poolNamespace)continue;
      const source=family.plugin.funding.liquidity.sources([binding.asset],[binding])[0];assert(source);
      const executionSource=validateTransactionStateSelection(leg.source!,stateSelection).executionSource;
      matches.push(parseFundingAcceptanceCase({version:1,domain:"funding",id:leg.id,familyId:memo.familyId,instanceKey:memo.instanceKey,
        fundingId:source.fundingId,lineageId:family.plugin.manifest.supportedLineages[0],source:{number:executionSource.number,hash:executionSource.hash},
        ...transactionTestActors(leg),transactionHash:transaction.transactionHash,token:binding.asset,amountIn:leg.amountIn}));
    }
  }
  const unique=[...new Map(matches.map(sample=>[sample.fundingId,sample])).values()];
  assert.equal(unique.length,1,"Funding TX selector/resource binding is absent or ambiguous; supply an execution target/selector pin");
  return unique[0]!;
}

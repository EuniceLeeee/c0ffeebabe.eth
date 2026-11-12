import assert from "node:assert/strict";
import { getAddress } from "ethers";
import type { DurableVerifiedMemo, StartupCheckpointEnvelope } from "../universe-rebuild-checkpoint.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import type { LoadedFamilyBox } from "../venues/family-capability-catalog.js";
import type { FundingAcceptanceCase, FundingAcceptanceContext } from "./family-funding-acceptance.js";

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** Funding publishes a token to Ready's Funding table, not a synthetic Graph edge. */
export function assertFundingReadyPublication(family: LoadedFamilyBox, memo: DurableVerifiedMemo,
  source: CanonicalSource, sample: FundingAcceptanceCase) {
  assert.equal(family.plugin.manifest.domain, "funding"); assert("funding" in family.plugin);
  assert.equal(family.plugin.manifest.familyId, sample.familyId);
  assert.equal(memo.familyId, sample.familyId); assert.equal(memo.instanceKey, sample.instanceKey);
  assert.equal(source.number, sample.source.number); assert(same(source.hash, sample.source.hash));
  assert.equal(memo.validity.policy, "dependency-proof");
  assert.equal(memo.validity.proofSource.number, source.number);
  assert(same(memo.validity.proofSource.hash, source.hash), "Funding publication proof is stale");
  assert(typeof memo.memoFingerprint === "string" && memo.memoFingerprint.length > 0);
  const identity = memo.verifiedIdentity as any, descriptor = memo.compiledDescriptor as any;
  const publication = memo.staticProjection as any, candidate = memo.candidateSnapshot as any;
  assert(identity?.domain === "funding" && identity.familyId === sample.familyId && same(identity.asset, sample.token));
  assert.equal(identity.source?.number, source.number); assert(same(identity.source?.hash, source.hash));
  assert.equal(identity.source?.generation, source.generation);
  assert(descriptor?.domain === "funding" && same(descriptor.asset, sample.token));
  assert(publication?.domain === "funding" && publication.format === "prepared-funding-token-v1" && same(publication.asset, sample.token));
  assert(Array.isArray(publication.evidenceRefs) && publication.evidenceRefs.length > 0 && publication.evidenceRefs.every((value: unknown) => typeof value === "string" && value.length > 0));
  assert(candidate?.familyId === sample.familyId && candidate.candidateKind === "observed-funding-token" && same(candidate.asset, sample.token), "Funding candidate does not name this asset");
  const sources = family.plugin.funding.liquidity.sources([sample.token]).filter(item => item.fundingId === sample.instanceKey && same(item.asset, sample.token));
  assert.equal(sources.length, 1, "Funding case requires one complete current source");
  const selected = sources[0]! as typeof sources[number] & { lineageId?: string; provider?: string };
  assert.equal(selected.lineageId, sample.lineageId, "Funding case lineage differs from current source");
  assert(family.plugin.manifest.supportedLineages.includes(sample.lineageId as never));
  assert(same(getAddress(candidate.provider), getAddress(selected.provider ?? selected.instanceKey)), "Funding candidate provider differs from current source");
  return { familyId: sample.familyId, instanceKey: sample.instanceKey, lineageId: sample.lineageId,
    asset: getAddress(sample.token), source, memoFingerprint: memo.memoFingerprint,
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
  assert(publication?.domain === "funding" && publication.familyId === sample.familyId && publication.instanceKey === sample.instanceKey && same(publication.asset, sample.token));
  return assertFundingRuntimeReady({ family, memo, source: ready.cutoff, ready }, sample);
}

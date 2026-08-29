import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  sealInstancePublication,
  type AssetPortV1,
  type InstancePublicationV1,
  type StaticTransitionProjectionDraftV1,
} from "../../../../packages/catalog/src/index.ts";
import { erc20AssetPortBindingV1 } from "../../../../packages/asset-ref/src/index.ts";
import {
  familyCandidateKeyForNomination,
  type UniV2NominationV1,
} from "../schema/index.ts";
import {
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_REQUESTED_ARTIFACT_DEPENDENCY_ROOT,
  uniV2IdentityValidityDependencyRoot,
} from "../family-definition.ts";
import type { UniV2IdentityVerifiedV1 } from "./identity.ts";
import { uniV2IdentityDescriptorHash } from "./identity.ts";
import type { UniV2MaterializationVerifiedV1 } from "./materialization.ts";
import { sealMaterializedState } from "../schema/index.ts";

export interface UniV2ProjectionInputV1 {
  readonly nomination: UniV2NominationV1;
  readonly identity: UniV2IdentityVerifiedV1;
  readonly materialization: UniV2MaterializationVerifiedV1;
  /** Fee policy is release-bound configuration; it is not inferred from a pool address. */
  readonly feeBps: bigint;
  readonly evidenceRoot: Hash;
  readonly publicationIdentityMemo: CanonicalJson;
}

export interface UniV2ProjectionVerifiedV1 {
  readonly publication: InstancePublicationV1;
  readonly familyCandidateKey: Hash;
  readonly instanceKey: string;
  readonly stateHash: Hash;
  readonly feeBps: bigint;
}

export type UniV2ProjectionOutcomeV1 =
  | { readonly status: "verified"; readonly projection: UniV2ProjectionVerifiedV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "invalid-fee" };

function assertFee(feeBps: bigint): void {
  if (feeBps < 0n || feeBps >= 10_000n) throw new Error("invalid-fee");
}

function portRef(pool: string, direction: "token0-to-token1" | "token1-to-token0", token: string): Hash {
  return hashDomain("aloha/univ2-standard/asset-port/v1", { pool, direction, token });
}

function transition(
  chainId: string,
  pool: string,
  direction: "token0-to-token1" | "token1-to-token0",
  inputToken: string,
  outputToken: string,
  reserveIn: string,
  reserveOut: string,
  stateHash: Hash,
  feeBps: bigint,
): StaticTransitionProjectionDraftV1 {
  const inputAsset: AssetPortV1 = Object.freeze({
    ...erc20AssetPortBindingV1(chainId, inputToken),
    portRef: portRef(pool, direction, inputToken),
    ordinal: "0",
  });
  const outputAsset: AssetPortV1 = Object.freeze({
    ...erc20AssetPortBindingV1(chainId, outputToken),
    portRef: portRef(pool, direction, outputToken),
    ordinal: "0",
  });
  const feeHash = hashDomain("aloha/univ2-standard/fee-policy/v1", feeBps.toString(10));
  const opaqueTransitionRef = hashDomain("aloha/univ2-standard/transition/v1", {
    pool,
    direction,
    reserveIn,
    reserveOut,
    stateHash,
    feeBps: feeBps.toString(10),
  });
  const constraintRefs = Object.freeze([stateHash, feeHash].sort());
  const payload = {
    inputAssetPorts: [inputAsset],
    outputAssetPorts: [outputAsset],
    opaqueTransitionRef,
    constraintRefs,
  };
  return Object.freeze({
    ...payload,
    staticProjectionHash: hashDomain("aloha/univ2-standard/static-projection/v1", payload),
  });
}

/**
 * Projection is the only Family-owned operation that creates a catalog
 * publication.  It uses the generic catalog sealer; no Graph or planner
 * object is created here.
 */
export function projectUniV2(input: UniV2ProjectionInputV1): UniV2ProjectionOutcomeV1 {
  assertFee(input.feeBps);
  if (input.identity.facts.pool !== input.nomination.pool || input.materialization.pool !== input.nomination.pool) {
    throw new Error("univ2-projection-pool-mismatch");
  }
  if (input.identity.candidateSnapshotHash !== input.nomination.candidateSnapshotHash) {
    throw new Error("univ2-projection-candidate-snapshot-mismatch");
  }
  if (input.materialization.identityFactsHash !== input.identity.factsHash) {
    throw new Error("univ2-projection-identity-state-mismatch");
  }
  if (input.materialization.state.pool !== input.materialization.pool) throw new Error("univ2-projection-state-pool-mismatch");
  if (
    input.identity.cutoff.chainId !== input.materialization.cutoff.chainId
    || input.identity.cutoff.number !== input.materialization.cutoff.number
    || input.identity.cutoff.hash !== input.materialization.cutoff.hash
    || input.identity.cutoff.stateRoot !== input.materialization.cutoff.stateRoot
  ) throw new Error("univ2-projection-cutoff-mismatch");

  const state = input.materialization.state;
  if (
    state.cutoff.chainId !== input.materialization.cutoff.chainId
    || state.cutoff.number !== input.materialization.cutoff.number
    || state.cutoff.hash !== input.materialization.cutoff.hash
    || state.cutoff.stateRoot !== input.materialization.cutoff.stateRoot
  ) throw new Error("univ2-projection-state-cutoff-mismatch");
  const resealedState = sealMaterializedState({
    cutoff: state.cutoff,
    pool: state.pool,
    reserve0: state.reserve0,
    reserve1: state.reserve1,
    blockTimestampLast: state.blockTimestampLast,
  });
  if (resealedState.stateHash !== state.stateHash) throw new Error("univ2-materialized-state-hash-mismatch");
  const reserve0 = BigInt(state.reserve0);
  const reserve1 = BigInt(state.reserve1);
  if (reserve0 <= 0n || reserve1 <= 0n) throw new Error("univ2-projection-zero-liquidity");
  const pool = input.identity.facts.pool;
  const transitions = [
    transition(input.identity.cutoff.chainId, pool, "token0-to-token1", input.identity.facts.token0, input.identity.facts.token1, state.reserve0, state.reserve1, state.stateHash, input.feeBps),
    transition(input.identity.cutoff.chainId, pool, "token1-to-token0", input.identity.facts.token1, input.identity.facts.token0, state.reserve1, state.reserve0, state.stateHash, input.feeBps),
  ];
  const familyCandidateKey = familyCandidateKeyForNomination(input.nomination.instanceNominationKey);
  const descriptorHash = uniV2IdentityDescriptorHash(input.identity.facts);
  const staticProjectionMemoHash = hashDomain("aloha/univ2-standard/static-projection-memo/v1", transitions);
  const validityDependencyRoot = uniV2IdentityValidityDependencyRoot(input.identity.factsHash);
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson(input.publicationIdentityMemo));
  const publication = sealInstancePublication({
    familyId: "univ2-standard",
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    familyCandidateKey,
    instanceKey: pool,
    cutoff: input.identity.cutoff,
    identityMemo,
    identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo),
    descriptorHash,
    staticProjectionMemoHash,
    requestedArtifactDependencyRoot: UNIV2_STANDARD_REQUESTED_ARTIFACT_DEPENDENCY_ROOT,
    validityDependencyRoot,
    transitions,
    evidenceRoot: input.evidenceRoot,
  });
  return Object.freeze({
    status: "verified",
    projection: Object.freeze({
      publication,
      familyCandidateKey,
      instanceKey: pool,
      stateHash: state.stateHash,
      feeBps: input.feeBps,
    }),
  });
}

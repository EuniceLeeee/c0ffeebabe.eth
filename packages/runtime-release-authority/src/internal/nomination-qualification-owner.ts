import { assertHash, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { sourcePlanIdentity } from "../../../../packages/discovery/src/index.ts";
import {
  assertGeneratedFamilyRuntimeFactory,
  readGeneratedFamilySourcePlanRuntimes,
  type GeneratedFamilyRuntimeAuthorityCapabilityV1,
  type GeneratedFamilyRuntimeFactoryV1,
} from "../../../../packages/family-composition/src/internal/generated-runtime-composition.ts";
import type { CandidateNominationQualificationBindingV1 } from "../../../../specs/candidate-partition-authority/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";

/** Opaque release-owner verifier. Checkpoint can invoke the assertion through
 * its proof issuer, but can neither inspect nor mint the signed/generated map. */
export interface RuntimeReleaseNominationQualificationVerifierPortV1 {
  assertQualified(bindings: readonly CandidateNominationQualificationBindingV1[]): void;
}

interface NominationQualificationVerifierStateV1 {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly version: bigint;
  readonly bindingId: Hash;
  readonly exactBySourcePlanIdentity: ReadonlyMap<Hash, CandidateNominationQualificationBindingV1>;
}

const states = new WeakMap<object, NominationQualificationVerifierStateV1>();

function assertCurrent(state: NominationQualificationVerifierStateV1): void {
  const current = assertActiveRuntimeReleaseAuthorityState(state.authority);
  if (current.version !== state.version || current.binding.bindingId !== state.bindingId) {
    throw new TypeError("nomination qualification verifier stale after runtime release rotation");
  }
}

function decodeBinding(
  value: CandidateNominationQualificationBindingV1,
  index: number,
): CandidateNominationQualificationBindingV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`nomination qualification binding ${index} is invalid`);
  }
  const expected = [
    "nominationProgramProposalLeafDigest",
    "nominationProgramRoot",
    "qualificationLeafDigest",
    "sourcePlanIdentity",
    "sourcePlanLeafDigest",
  ];
  const actual = Reflect.ownKeys(value).map(key => {
    if (typeof key !== "string") throw new TypeError(`nomination qualification binding ${index} has a symbol field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`nomination qualification binding ${index} has an accessor field ${key}`);
    }
    return key;
  }).sort();
  if (actual.length !== expected.length || actual.some((key, fieldIndex) => key !== expected[fieldIndex])) {
    throw new TypeError(`nomination qualification binding ${index} has non-exact fields`);
  }
  return Object.freeze({
    sourcePlanIdentity: assertHash(value.sourcePlanIdentity, `nominationQualificationBindings[${index}].sourcePlanIdentity`),
    sourcePlanLeafDigest: assertHash(value.sourcePlanLeafDigest, `nominationQualificationBindings[${index}].sourcePlanLeafDigest`),
    nominationProgramRoot: assertHash(value.nominationProgramRoot, `nominationQualificationBindings[${index}].nominationProgramRoot`),
    nominationProgramProposalLeafDigest: assertHash(value.nominationProgramProposalLeafDigest, `nominationQualificationBindings[${index}].nominationProgramProposalLeafDigest`),
    qualificationLeafDigest: assertHash(value.qualificationLeafDigest, `nominationQualificationBindings[${index}].qualificationLeafDigest`),
  });
}

function sameBinding(
  actual: CandidateNominationQualificationBindingV1,
  expected: CandidateNominationQualificationBindingV1,
): boolean {
  return actual.sourcePlanIdentity === expected.sourcePlanIdentity
    && actual.sourcePlanLeafDigest === expected.sourcePlanLeafDigest
    && actual.nominationProgramRoot === expected.nominationProgramRoot
    && actual.nominationProgramProposalLeafDigest === expected.nominationProgramProposalLeafDigest
    && actual.qualificationLeafDigest === expected.qualificationLeafDigest;
}

/** Derive the verifier only from a verified release and its opaque generated
 * Family capability. No caller-supplied plan/root array is accepted here. */
export function issueRuntimeReleaseNominationQualificationVerifier(
  authorityValue: unknown,
  factoryValue: unknown,
  capabilityValue: unknown,
): RuntimeReleaseNominationQualificationVerifierPortV1 {
  const authority = authorityValue as RuntimeReleaseAuthorityV1;
  const release = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  assertGeneratedFamilyRuntimeFactory(factoryValue);
  const factory = factoryValue as GeneratedFamilyRuntimeFactoryV1;
  const bindings = readGeneratedFamilySourcePlanRuntimes(
    factory,
    capabilityValue as GeneratedFamilyRuntimeAuthorityCapabilityV1,
  );
  const exactBySourcePlanIdentity = new Map<Hash, CandidateNominationQualificationBindingV1>();
  for (const [index, binding] of bindings.entries()) {
    const exact = decodeBinding(Object.freeze({
      sourcePlanIdentity: sourcePlanIdentity(binding.sourcePlanRef),
      sourcePlanLeafDigest: binding.sourcePlanLeafDigest,
      nominationProgramRoot: binding.nominationProgramRoot,
      nominationProgramProposalLeafDigest: binding.nominationProgramProposalLeafDigest,
      qualificationLeafDigest: binding.nominationQualificationLeafDigest,
    }), index);
    if (exactBySourcePlanIdentity.has(exact.sourcePlanIdentity)) {
      throw new TypeError("generated nomination qualification contains duplicate source plan identity");
    }
    exactBySourcePlanIdentity.set(exact.sourcePlanIdentity, exact);
  }
  if (exactBySourcePlanIdentity.size === 0) {
    throw new TypeError("generated nomination qualification set is empty");
  }
  const state: NominationQualificationVerifierStateV1 = {
    authority,
    version: release.version,
    bindingId: release.binding.bindingId,
    exactBySourcePlanIdentity,
  };
  const verifier = Object.freeze({
    assertQualified(values: readonly CandidateNominationQualificationBindingV1[]): void {
      assertCurrent(state);
      if (!Array.isArray(values)) throw new TypeError("nomination qualification bindings are required");
      if (values.length !== state.exactBySourcePlanIdentity.size) {
        throw new TypeError("nomination qualification bindings do not cover the generated source-plan set");
      }
      const seen = new Set<Hash>();
      for (const [index, value] of values.entries()) {
        const actual = decodeBinding(value, index);
        if (seen.has(actual.sourcePlanIdentity)) throw new TypeError("duplicate nomination qualification source plan identity");
        seen.add(actual.sourcePlanIdentity);
        const expected = state.exactBySourcePlanIdentity.get(actual.sourcePlanIdentity);
        if (expected === undefined || !sameBinding(actual, expected)) {
          throw new TypeError("nomination qualification is not in the signed runtime release generated set");
        }
      }
      if (seen.size !== state.exactBySourcePlanIdentity.size) {
        throw new TypeError("nomination qualification bindings do not cover the generated source-plan set");
      }
    },
  });
  states.set(verifier, state);
  return verifier;
}

export function assertRuntimeReleaseNominationQualificationVerifier(
  value: unknown,
  authority: RuntimeReleaseAuthorityV1,
): RuntimeReleaseNominationQualificationVerifierPortV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("nomination qualification verifier is not release-issued");
  }
  const state = states.get(value);
  if (state === undefined || state.authority !== authority) {
    throw new TypeError("nomination qualification verifier is not release-issued for this authority");
  }
  assertCurrent(state);
  return value as RuntimeReleaseNominationQualificationVerifierPortV1;
}

import {
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  evaluateSixStepPredicate,
  type SixStepPredicateVerdict,
  type SixStepRuntimeFactsV1,
} from "./predicate.ts";
import {
  evaluateSixStepReferenceModel,
  type SixStepReferenceInputV1,
  type SixStepReferenceVerdict,
} from "./reference-model.ts";
import {
  SIX_STEP_CRITICAL_MUTATION_IDS,
  SIX_STEP_PREDICATE_SPEC,
} from "./spec.ts";
import {
  buildSixStepQualificationMutationCases,
  SIX_STEP_MUTATION_REGISTRY_IMPLEMENTATION_DIGEST,
  resolveSixStepMutationDefinition,
} from "./mutations.ts";
import {
  readIssuedSixStepQualificationCorpusV1,
  type IssuedSixStepQualificationCorpusV1,
} from "./internal/qualification-corpus-owner.ts";
import { SIX_STEP_VALUATION_ORACLE_GENERIC_CORE_DIGEST } from "./valuation-oracle.ts";
import { SIX_STEP_VALUATION_ORACLE_MANIFEST_ENTRIES } from "./composition/valuation-oracle-manifest.ts";
import {
  sealEconomicValuationOwnerQualificationCertificateV1,
  type EconomicValuationOwnerQualificationCertificateV1,
} from "../../../specs/economic-valuation-owner/src/index.ts";

export type SixStepQualificationCaseClass = "positive" | "negative" | "invalid";

/** The immutable evidence envelope that a mutation is allowed to damage. */
export interface SixStepQualificationFixtureV1 {
  readonly runtime: SixStepRuntimeFactsV1;
  readonly reference: SixStepReferenceInputV1;
}

/** A prebuilt evidence case. Executable functions and verdicts are forbidden. */
export interface SixStepMutationCaseV1 {
  readonly mutationId: string;
  readonly fixture: SixStepQualificationFixtureV1;
}

export interface ExecutedSixStepCaseV1 {
  readonly caseId: string;
  readonly class: SixStepQualificationCaseClass;
  readonly mutationId: string | null;
  readonly runtimeVerdict: SixStepPredicateVerdict;
  readonly referenceVerdict: SixStepReferenceVerdict;
  readonly evidenceRoot: Hash;
}

export interface SixStepQualificationRunV1 {
  readonly cases: readonly ExecutedSixStepCaseV1[];
  readonly structuralErrors: readonly string[];
}

export interface SixStepQualificationCertificateV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.six-step-verifier-qualification";
  readonly certificateId: Hash;
  readonly predicateSpecDigest: Hash;
  readonly qualificationSpecDigest: Hash;
  readonly mutationRegistryImplementationDigest: Hash;
  readonly evidenceRootSchemeDigest: Hash;
  readonly valuationOracleGenericCoreDigest: Hash;
  readonly positiveEvidenceRoot: Hash;
  readonly positiveCaseRoot: Hash;
  readonly negativeCaseRoot: Hash;
  readonly invalidCaseRoot: Hash;
  readonly declaredCriticalMutationIds: readonly string[];
  readonly rejectedOrInvalidMutationIds: readonly string[];
  readonly independentOracleCaseRoot: Hash;
  readonly independentOracleCaseCount: string;
  readonly positiveCase: ExecutedSixStepCaseV1;
  readonly mutationCases: readonly ExecutedSixStepCaseV1[];
  readonly verdict: "qualified" | "not-qualified";
}

export interface SixStepValuationOwnerQualificationSubjectV1 {
  readonly ownerRef: Hash;
  readonly proposedOwnerLeafDigest: Hash;
  readonly implementationHash: Hash;
  readonly factSchemaRef: Hash;
  readonly implementationClosureRoot: Hash;
  readonly qualificationSpecDigest: Hash;
  readonly qualificationSpecClosureRoot: Hash;
  readonly criticalMutationCorpusRoot: Hash;
  readonly criticalMutationCorpusClosureRoot: Hash;
  readonly independentOracleCaseRoot: Hash;
  readonly independentOracleClosureRoot: Hash;
}

export interface SixStepValuationOwnerQualificationAuthorityV1 {
  readonly approvalId: Hash;
  readonly approvalPayloadHash: Hash;
}

const SIX_STEP_EVIDENCE_ROOT_SCHEME_DIGEST = hashDomain(
  "aloha/six-step/qualification-evidence-root-scheme/v1",
  {
    version: "bounded-ordered-component-roots-v2",
    collections: ["facts", "refs", "claims", "policies", "leases", "observations"],
    referenceCollections: ["events", "semanticArtifacts", "productionReceipts", "stageFacts", "evidence"],
    observationCollections: ["rawArtifactRefs", "observedClaimIds"],
  },
);

function qualificationSpecDigest(): Hash {
  return hashDomain("aloha/six-step/qualification-spec/v1", {
    declaredCriticalMutationIds: [...SIX_STEP_CRITICAL_MUTATION_IDS].sort(),
    independentOracleCaseCount: (SIX_STEP_CRITICAL_MUTATION_IDS.length + 1).toString(),
    runner: "fixed-evidence-case-registry-v1",
    mutationRegistryImplementationDigest: SIX_STEP_MUTATION_REGISTRY_IMPLEMENTATION_DIGEST,
    evidenceRootSchemeDigest: SIX_STEP_EVIDENCE_ROOT_SCHEME_DIGEST,
    valuationOracleGenericCoreDigest: SIX_STEP_VALUATION_ORACLE_GENERIC_CORE_DIGEST,
  });
}

function root(domain: string, values: readonly unknown[]): Hash {
  return hashDomain(domain, values.map((value) => encodeCanonicalJson(value)));
}

function orderedValueRoot(domain: string, values: readonly unknown[]): Hash {
  return hashDomain(domain, values.map((value) => hashDomain(`${domain}/entry/v1`, value)));
}

function observationRoot(domain: string, value: SixStepRuntimeFactsV1["observations"][number]): Hash {
  return hashDomain(domain, {
    observationId: value.observationId,
    rawArtifactRefsRoot: orderedValueRoot(`${domain}/raw-artifact-refs/v1`, value.rawArtifactRefs),
    observedClaimIdsRoot: orderedValueRoot(`${domain}/observed-claim-ids/v1`, value.observedClaimIds),
  });
}

function evidenceEnvelopeRoot(domain: string, value: SixStepRuntimeFactsV1): Hash {
  return hashDomain(domain, {
    factsRoot: orderedValueRoot(`${domain}/facts/v1`, value.facts),
    refsRoot: orderedValueRoot(`${domain}/refs/v1`, value.refs),
    claimsRoot: orderedValueRoot(`${domain}/claims/v1`, value.claims),
    policiesRoot: orderedValueRoot(`${domain}/policies/v1`, value.policies),
    leasesRoot: orderedValueRoot(`${domain}/leases/v1`, value.leases),
    observationsRoot: hashDomain(`${domain}/observations/v1`, value.observations.map((observation) => observationRoot(`${domain}/observation/v1`, observation))),
  });
}

/** Recomputed from bounded ordered component roots so every artifact remains
 * bound without placing a complete qualification fixture inside one codec
 * budget. Callers cannot supply any component root. */
export function hashSixStepEvidenceRoot(fixture: SixStepQualificationFixtureV1): Hash {
  return hashDomain("aloha/six-step/qualification-evidence/v2", {
    runtimeRoot: evidenceEnvelopeRoot("aloha/six-step/qualification/runtime/v1", fixture.runtime),
    referenceRoot: hashDomain("aloha/six-step/qualification/reference/v1", {
      eventsRoot: orderedValueRoot("aloha/six-step/qualification/reference/events/v1", fixture.reference.events),
      semanticArtifactsRoot: orderedValueRoot("aloha/six-step/qualification/reference/semantic-artifacts/v1", fixture.reference.semanticArtifacts),
      productionReceiptsRoot: orderedValueRoot("aloha/six-step/qualification/reference/production-receipts/v1", fixture.reference.productionReceipts),
      stageFactsRoot: orderedValueRoot("aloha/six-step/qualification/reference/stage-facts/v1", fixture.reference.stageFacts),
      economicEvaluatorBindingRoot: hashDomain("aloha/six-step/qualification/reference-economic-evaluator-binding/v1", fixture.reference.economicEvaluatorBinding),
      evidenceRoot: evidenceEnvelopeRoot("aloha/six-step/qualification/reference/evidence/v1", fixture.reference.evidence as SixStepRuntimeFactsV1),
    }),
  });
}

function caseRoot(
  cases: readonly ExecutedSixStepCaseV1[],
  className: SixStepQualificationCaseClass,
): Hash {
  return root(
    `aloha/six-step/qualification/${className}-cases/v1`,
    cases
      .filter((item) => item.class === className)
      .sort((left, right) => left.caseId.localeCompare(right.caseId)),
  );
}

function exactMutationSet(cases: readonly SixStepMutationCaseV1[]): readonly string[] {
  const ids = cases.map((item) => item.mutationId);
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    const keys = Reflect.ownKeys(cases[index] as object).filter((key): key is string => typeof key === "string").sort();
    if (encodeCanonicalJson(keys) !== encodeCanonicalJson(["fixture", "mutationId"])) throw new TypeError(`mutation ${id} has unsupported fields`);
    if (seen.has(id)) throw new TypeError(`duplicate six-step mutationId: ${id}`);
    seen.add(id);
  }
  const declared = new Set<string>(SIX_STEP_CRITICAL_MUTATION_IDS);
  for (const id of ids) if (!declared.has(id)) throw new TypeError(`undeclared six-step mutationId: ${id}`);
  if (ids.length !== declared.size || [...declared].some((id) => !seen.has(id))) throw new TypeError("six-step mutation corpus is incomplete");
  return Object.freeze([...ids].sort());
}

/** Build the package-owned deterministic corpus and execute both verdict paths. */
export function executeSixStepQualificationCorpus(
  base: SixStepQualificationFixtureV1,
): SixStepQualificationRunV1 {
  const mutationCases = buildSixStepQualificationMutationCases(base);
  const structuralErrors: string[] = [];
  let mutationIds: readonly string[] = [];
  try {
    mutationIds = exactMutationSet(mutationCases);
  } catch (error) {
    structuralErrors.push(error instanceof Error ? error.message : "invalid mutation corpus");
  }
  const baseRoot = hashSixStepEvidenceRoot(base);
  const baseRuntime = evaluateSixStepPredicate(base.runtime);
  const baseReference = evaluateSixStepReferenceModel(base.reference);
  const cases: ExecutedSixStepCaseV1[] = [{
    caseId: "positive",
    class: "positive",
    mutationId: null,
    runtimeVerdict: baseRuntime.verdict,
    referenceVerdict: baseReference.verdict,
    evidenceRoot: baseRoot,
  }];
  const mutationEvidenceRoots = new Map<Hash, string>();
  if (structuralErrors.length === 0) {
    for (const mutationCase of mutationCases) {
      const definition = resolveSixStepMutationDefinition(mutationCase.mutationId);
      if (definition === null) {
        structuralErrors.push(`${mutationCase.mutationId}:registry-entry-missing`);
        continue;
      }
      const mutated = mutationCase.fixture;
      const evidenceRoot = hashSixStepEvidenceRoot(mutated);
      if (evidenceRoot === baseRoot) {
        structuralErrors.push(`${mutationCase.mutationId}:mutation-no-op`);
        continue;
      }
      const priorMutationId = mutationEvidenceRoots.get(evidenceRoot);
      if (priorMutationId !== undefined) {
        structuralErrors.push(`${mutationCase.mutationId}:duplicate-mutation-evidence:${priorMutationId}`);
        continue;
      }
      mutationEvidenceRoots.set(evidenceRoot, mutationCase.mutationId);
      const runtime = evaluateSixStepPredicate(mutated.runtime);
      const reference = evaluateSixStepReferenceModel(mutated.reference);
      if (!runtime.reasons.some((reason) => reason.path === definition.requiredRuntimePath)) {
        structuralErrors.push(`${mutationCase.mutationId}:target-runtime-reason-missing`);
      }
      if (!reference.reasons.includes(definition.requiredReferenceReason)) {
        structuralErrors.push(`${mutationCase.mutationId}:target-reference-reason-missing`);
      }
      const rejected = runtime.verdict !== "pass" && reference.verdict !== "pass";
      cases.push({
        caseId: `mutation:${mutationCase.mutationId}`,
        class: rejected && runtime.verdict === "fail" && reference.verdict === "fail" ? "negative" : "invalid",
        mutationId: mutationCase.mutationId,
        runtimeVerdict: runtime.verdict,
        referenceVerdict: reference.verdict,
        evidenceRoot,
      });
    }
  }
  if (mutationIds.length !== SIX_STEP_CRITICAL_MUTATION_IDS.length) structuralErrors.push("six-step mutation set is not exact");
  return Object.freeze({ cases: Object.freeze(cases), structuralErrors: Object.freeze(structuralErrors) });
}

/**
 * Qualification accepts only an owner-issued positive fixture. Mutation code,
 * cases, verdicts, expected-success fields, and evidence roots stay package-owned.
 */
export function qualifySixStepCorpus(
  issuedCorpus: IssuedSixStepQualificationCorpusV1,
): SixStepQualificationCertificateV1 {
  const positiveFixture = readIssuedSixStepQualificationCorpusV1(issuedCorpus);
  const run = executeSixStepQualificationCorpus(positiveFixture);
  const reasons = [...run.structuralErrors];
  const positive = run.cases.filter((item) => item.class === "positive");
  if (positive.length !== 1 || positive[0]?.runtimeVerdict !== "pass" || positive[0]?.referenceVerdict !== "pass") reasons.push("positive-case-missing-or-failed");
  const declared = [...SIX_STEP_CRITICAL_MUTATION_IDS].sort();
  const executed = run.cases
    .map((item) => item.mutationId)
    .filter((value): value is string => value !== null)
    .sort();
  if (encodeCanonicalJson(executed) !== encodeCanonicalJson(declared)) reasons.push("critical-mutation-set-mismatch");
  const rejectedOrInvalid = run.cases
    .filter((item) => item.mutationId !== null && item.runtimeVerdict !== "pass" && item.referenceVerdict !== "pass" && item.runtimeVerdict === item.referenceVerdict)
    .map((item) => item.mutationId as string)
    .sort();
  if (encodeCanonicalJson(rejectedOrInvalid) !== encodeCanonicalJson(declared)) reasons.push("mutation-not-rejected-or-invalid");
  for (const item of run.cases) if (item.runtimeVerdict !== item.referenceVerdict) reasons.push(`runtime-reference-disagreement:${item.caseId}`);
  const orderedCases = run.cases.slice().sort((left, right) => left.caseId.localeCompare(right.caseId));
  const positiveCases = orderedCases.filter((item) => item.mutationId === null);
  const mutationCases = orderedCases.filter((item) => item.mutationId !== null);
  const independentOracleCases = orderedCases.map((item) => ({
    caseId: item.caseId,
    class: item.class,
    mutationId: item.mutationId,
    referenceVerdict: item.referenceVerdict,
    evidenceRoot: item.evidenceRoot,
  })).sort((left, right) => left.caseId.localeCompare(right.caseId));
  const payload = {
    predicateSpecDigest: SIX_STEP_PREDICATE_SPEC.specDigest,
    qualificationSpecDigest: qualificationSpecDigest(),
    mutationRegistryImplementationDigest: SIX_STEP_MUTATION_REGISTRY_IMPLEMENTATION_DIGEST,
    evidenceRootSchemeDigest: SIX_STEP_EVIDENCE_ROOT_SCHEME_DIGEST,
    valuationOracleGenericCoreDigest: SIX_STEP_VALUATION_ORACLE_GENERIC_CORE_DIGEST,
    positiveEvidenceRoot: positive[0]?.evidenceRoot ?? hashDomain("aloha/six-step/missing-positive-evidence/v1", null),
    positiveCaseRoot: caseRoot(run.cases, "positive"),
    negativeCaseRoot: caseRoot(run.cases, "negative"),
    invalidCaseRoot: caseRoot(run.cases, "invalid"),
    declaredCriticalMutationIds: declared,
    rejectedOrInvalidMutationIds: rejectedOrInvalid,
    independentOracleCaseRoot: root("aloha/six-step/qualification/independent-oracle-cases/v1", independentOracleCases),
    independentOracleCaseCount: independentOracleCases.length.toString(),
    positiveCase: positiveCases[0]!,
    mutationCases,
  };
  const certificateId = hashDomain("aloha/six-step/verifier-qualification/v1", payload);
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.six-step-verifier-qualification",
    certificateId,
    ...payload,
    verdict: reasons.length === 0 ? "qualified" : "not-qualified",
  });
}

export function assertQualifiedSixStepCertificate(
  certificate: SixStepQualificationCertificateV1,
): void {
  const keys = Reflect.ownKeys(certificate as object).filter((key): key is string => typeof key === "string").sort();
  const expectedKeys = ["schemaVersion", "kind", "certificateId", "predicateSpecDigest", "qualificationSpecDigest", "mutationRegistryImplementationDigest", "evidenceRootSchemeDigest", "valuationOracleGenericCoreDigest", "positiveEvidenceRoot", "positiveCaseRoot", "negativeCaseRoot", "invalidCaseRoot", "declaredCriticalMutationIds", "rejectedOrInvalidMutationIds", "independentOracleCaseRoot", "independentOracleCaseCount", "positiveCase", "mutationCases", "verdict"].sort();
  if (encodeCanonicalJson(keys) !== encodeCanonicalJson(expectedKeys)) throw new TypeError("six-step qualification certificate has non-exact fields");
  if (certificate.schemaVersion !== 1 || certificate.kind !== "aloha.six-step-verifier-qualification") throw new TypeError("six-step qualification certificate kind/version changed");
  if (certificate.verdict !== "qualified") throw new TypeError("six-step qualification is not qualified");
  if (certificate.predicateSpecDigest !== SIX_STEP_PREDICATE_SPEC.specDigest) throw new TypeError("six-step predicate spec changed");
  if (certificate.qualificationSpecDigest !== qualificationSpecDigest()) throw new TypeError("six-step qualification spec changed");
  if (certificate.mutationRegistryImplementationDigest !== SIX_STEP_MUTATION_REGISTRY_IMPLEMENTATION_DIGEST) throw new TypeError("six-step mutation registry changed");
  if (certificate.evidenceRootSchemeDigest !== SIX_STEP_EVIDENCE_ROOT_SCHEME_DIGEST) throw new TypeError("six-step evidence root scheme changed");
  if (certificate.valuationOracleGenericCoreDigest !== SIX_STEP_VALUATION_ORACLE_GENERIC_CORE_DIGEST) throw new TypeError("six-step valuation oracle generic core changed");
  if (certificate.declaredCriticalMutationIds.length !== SIX_STEP_CRITICAL_MUTATION_IDS.length || encodeCanonicalJson(certificate.declaredCriticalMutationIds) !== encodeCanonicalJson([...SIX_STEP_CRITICAL_MUTATION_IDS].sort()) || encodeCanonicalJson(certificate.declaredCriticalMutationIds) !== encodeCanonicalJson(certificate.rejectedOrInvalidMutationIds)) throw new TypeError("six-step mutation coverage is incomplete");
  if (certificate.independentOracleCaseCount !== (SIX_STEP_CRITICAL_MUTATION_IDS.length + 1).toString()) throw new TypeError("six-step independent oracle count is not exact");
  for (const [field, value] of Object.entries({ positiveEvidenceRoot: certificate.positiveEvidenceRoot, positiveCaseRoot: certificate.positiveCaseRoot, negativeCaseRoot: certificate.negativeCaseRoot, invalidCaseRoot: certificate.invalidCaseRoot, independentOracleCaseRoot: certificate.independentOracleCaseRoot })) {
    if (!/^0x[0-9a-f]{64}$/.test(value) || /^0x0+$/.test(value)) throw new TypeError(`six-step ${field} is invalid`);
  }
  const assertCase = (item: ExecutedSixStepCaseV1, caseId: string, mutationId: string | null): void => {
    const caseKeys = Reflect.ownKeys(item as object).filter((key): key is string => typeof key === "string").sort();
    if (encodeCanonicalJson(caseKeys) !== encodeCanonicalJson(["caseId", "class", "evidenceRoot", "mutationId", "referenceVerdict", "runtimeVerdict"])) throw new TypeError("six-step qualification case has non-exact fields");
    if (item.caseId !== caseId || item.mutationId !== mutationId) throw new TypeError("six-step qualification case identity is invalid");
    if (!(["pass", "fail", "invalid"] as const).includes(item.runtimeVerdict)
      || !(["pass", "fail", "invalid"] as const).includes(item.referenceVerdict)
      || !(["positive", "negative", "invalid"] as const).includes(item.class)
      || !/^0x[0-9a-f]{64}$/.test(item.evidenceRoot) || /^0x0+$/.test(item.evidenceRoot)) throw new TypeError("six-step qualification case content is invalid");
  };
  assertCase(certificate.positiveCase, "positive", null);
  if (certificate.positiveCase.class !== "positive"
    || certificate.positiveCase.runtimeVerdict !== "pass"
    || certificate.positiveCase.referenceVerdict !== "pass"
    || certificate.positiveCase.evidenceRoot !== certificate.positiveEvidenceRoot
    || certificate.mutationCases.length !== SIX_STEP_CRITICAL_MUTATION_IDS.length) throw new TypeError("six-step positive or mutation case set is invalid");
  for (const [index, mutationId] of [...SIX_STEP_CRITICAL_MUTATION_IDS].sort().entries()) {
    const item = certificate.mutationCases[index];
    if (item === undefined) throw new TypeError("six-step mutation case set is incomplete");
    assertCase(item, `mutation:${mutationId}`, mutationId);
    const expectedClass = item.runtimeVerdict === "fail" && item.referenceVerdict === "fail" ? "negative" : "invalid";
    if (item.runtimeVerdict === "pass" || item.referenceVerdict === "pass" || item.runtimeVerdict !== item.referenceVerdict || item.class !== expectedClass) throw new TypeError("six-step mutation case verdict is invalid");
  }
  const allCases = [certificate.positiveCase, ...certificate.mutationCases];
  const independentOracleCases = allCases.map((item) => ({ caseId: item.caseId, class: item.class, mutationId: item.mutationId, referenceVerdict: item.referenceVerdict, evidenceRoot: item.evidenceRoot })).sort((left, right) => left.caseId.localeCompare(right.caseId));
  if (certificate.positiveCaseRoot !== caseRoot(allCases, "positive")
    || certificate.negativeCaseRoot !== caseRoot(allCases, "negative")
    || certificate.invalidCaseRoot !== caseRoot(allCases, "invalid")
    || certificate.independentOracleCaseRoot !== root("aloha/six-step/qualification/independent-oracle-cases/v1", independentOracleCases)) throw new TypeError("six-step qualification case roots are invalid");
  const { schemaVersion: _schemaVersion, kind: _kind, certificateId: _certificateId, verdict: _verdict, ...payload } = certificate;
  const expectedCertificateId = hashDomain("aloha/six-step/verifier-qualification/v1", payload);
  if (certificate.certificateId !== expectedCertificateId) throw new TypeError("six-step qualification certificate identity mismatch");
}

/** Converts an already-qualified generic Six-Step run into one owner-scoped
 * acceptance certificate. The release authority supplies only its externally
 * verified approval identity; it cannot supply executed verdicts or roots. */
export function sealSixStepValuationOwnerQualificationCertificateV1(
  sixStepCertificate: SixStepQualificationCertificateV1,
  subject: SixStepValuationOwnerQualificationSubjectV1,
  authority: SixStepValuationOwnerQualificationAuthorityV1,
): EconomicValuationOwnerQualificationCertificateV1 {
  assertQualifiedSixStepCertificate(sixStepCertificate);
  const manifest = SIX_STEP_VALUATION_ORACLE_MANIFEST_ENTRIES.find(entry => entry.ownerRef === subject.ownerRef);
  if (manifest === undefined
    || manifest.ownerImplementationHash !== subject.implementationHash
    || manifest.factSchemaRef !== subject.factSchemaRef) {
    throw new TypeError("six-step valuation owner is absent from the qualified oracle manifest");
  }
  const ownerMutation = sixStepCertificate.mutationCases.find(item => item.mutationId === "stage6-economic-valuation-owner-splice");
  if (ownerMutation === undefined || ownerMutation.runtimeVerdict === "pass" || ownerMutation.referenceVerdict === "pass") {
    throw new TypeError("six-step valuation owner mutation did not execute fail-closed");
  }
  const executedPositiveCaseRoot = hashDomain("aloha/six-step/valuation-owner/executed-positive-cases/v1", [sixStepCertificate.positiveCase]);
  const executedNegativeCaseRoot = hashDomain(
    "aloha/six-step/valuation-owner/executed-negative-cases/v1",
    ownerMutation.class === "negative" ? [ownerMutation] : [],
  );
  const executedInvalidCaseRoot = hashDomain(
    "aloha/six-step/valuation-owner/executed-invalid-cases/v1",
    ownerMutation.class === "invalid" ? [ownerMutation] : [],
  );
  return sealEconomicValuationOwnerQualificationCertificateV1({
    schemaVersion: 1,
    kind: "aloha.economic-valuation-owner-qualification-certificate",
    ...subject,
    executedPositiveCaseRoot,
    executedNegativeCaseRoot,
    executedInvalidCaseRoot,
    verifierImplementationDigest: hashDomain("aloha/six-step/valuation-owner-verifier-implementation/v1", {
      genericCoreDigest: SIX_STEP_VALUATION_ORACLE_GENERIC_CORE_DIGEST,
      predicateOracleProgramDescriptorDigest: manifest.predicateOracleProgramDescriptorDigest,
      referenceOracleProgramDescriptorDigest: manifest.referenceOracleProgramDescriptorDigest,
      mutationRegistryImplementationDigest: SIX_STEP_MUTATION_REGISTRY_IMPLEMENTATION_DIGEST,
    }),
    qualificationAuthorityApprovalId: authority.approvalId,
    qualificationAuthorityApprovalPayloadHash: authority.approvalPayloadHash,
  });
}

import {
  assertHash,
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  evaluateTerminalSelectionPredicate,
  type TerminalSelectionPredicateVerdict,
  type TerminalSelectionRuntimeFactsV1,
} from "./predicate.ts";
import {
  evaluateTerminalSelectionReferenceModel,
  type TerminalSelectionReferenceInputV1,
  type TerminalSelectionReferenceResultV1,
  type TerminalSelectionReferenceVerdict,
} from "./reference-model.ts";
import {
  TERMINAL_SELECTION_CRITICAL_MUTATION_IDS,
  TERMINAL_SELECTION_INVOCATION_SEAL_ROLE,
  TERMINAL_SELECTION_OBSERVER_ROLE,
  TERMINAL_SELECTION_RAW_OBSERVER_ROLE,
  TERMINAL_SELECTION_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  TERMINAL_SELECTION_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  TERMINAL_SELECTION_PREDICATE_SPEC,
  TERMINAL_SELECTION_PREDICATE_SPEC_DIGEST,
} from "./spec.ts";
import {
  TERMINAL_SELECTION_MUTATION_REGISTRY,
  TERMINAL_SELECTION_MUTATION_REGISTRY_DIGEST,
} from "./mutations.ts";
export {
  TERMINAL_SELECTION_MUTATION_REGISTRY,
  TERMINAL_SELECTION_MUTATION_REGISTRY_DIGEST,
  type TerminalSelectionCriticalMutationId,
  type TerminalSelectionMutationDefinitionV1,
  type TerminalSelectionMutationFixtureV1,
} from "./mutations.ts";

export {
  evaluateTerminalSelectionReferenceModel,
  TERMINAL_SELECTION_CRITICAL_MUTATION_IDS,
  TERMINAL_SELECTION_INVOCATION_SEAL_ROLE,
  TERMINAL_SELECTION_OBSERVER_ROLE,
  TERMINAL_SELECTION_RAW_OBSERVER_ROLE,
  TERMINAL_SELECTION_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  TERMINAL_SELECTION_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  TERMINAL_SELECTION_PREDICATE_SPEC,
  TERMINAL_SELECTION_PREDICATE_SPEC_DIGEST,
  type TerminalSelectionReferenceInputV1,
  type TerminalSelectionReferenceResultV1,
  type TerminalSelectionReferenceVerdict,
};

export interface TerminalSelectionQualificationFixtureV1 {
  readonly runtime: TerminalSelectionRuntimeFactsV1;
  readonly reference: TerminalSelectionReferenceInputV1;
}

export interface TerminalSelectionMutationMutatorV1 {
  readonly mutationId: string;
  readonly implementationDigest: Hash;
  readonly apply: (base: TerminalSelectionQualificationFixtureV1) => TerminalSelectionQualificationFixtureV1;
}

export interface TerminalSelectionQualificationRunnerV1 {
  readonly base: TerminalSelectionQualificationFixtureV1;
  readonly mutators: readonly TerminalSelectionMutationMutatorV1[];
}

export interface ExecutedTerminalSelectionCaseV1 {
  readonly caseId: string;
  readonly mutationId: string | null;
  readonly runtimeVerdict: TerminalSelectionPredicateVerdict;
  readonly referenceVerdict: TerminalSelectionReferenceVerdict;
  readonly evidenceRoot: Hash;
}

export interface TerminalSelectionQualificationCertificateV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.terminal-selection-verifier-qualification";
  readonly certificateId: Hash;
  readonly predicateSpecDigest: Hash;
  readonly predicateProgramDescriptorDigest: Hash;
  readonly oracleProgramDescriptorDigest: Hash;
  readonly mutationRegistryDigest: Hash;
  readonly qualificationSpecDigest: Hash;
  readonly positiveEvidenceRoot: Hash;
  readonly positiveCaseRoot: Hash;
  readonly mutationCaseRoot: Hash;
  readonly declaredCriticalMutationIds: readonly string[];
  readonly rejectedOrInvalidMutationIds: readonly string[];
  readonly independentOracleCaseRoot: Hash;
  readonly independentOracleCaseCount: string;
  readonly positiveCase: ExecutedTerminalSelectionCaseV1;
  readonly mutationCases: readonly ExecutedTerminalSelectionCaseV1[];
  readonly verdict: "qualified" | "not-qualified";
}

function evidenceRoot(fixture: TerminalSelectionQualificationFixtureV1): Hash {
  return hashDomain("aloha/terminal-selection/qualification-evidence/v1", {
    runtime: fixture.runtime,
    reference: fixture.reference,
  });
}

function caseRoot(domain: string, cases: readonly ExecutedTerminalSelectionCaseV1[]): Hash {
  return hashDomain(domain, cases
    .slice()
    .sort((left, right) => left.caseId.localeCompare(right.caseId))
    .map(item => encodeCanonicalJson(item)));
}

function exactMutationSet(mutators: readonly TerminalSelectionMutationMutatorV1[]): readonly string[] {
  const declared = new Set<string>(TERMINAL_SELECTION_CRITICAL_MUTATION_IDS);
  const seen = new Set<string>();
  for (const [index, mutator] of mutators.entries()) {
    const keys = Reflect.ownKeys(mutator as object).filter((key): key is string => typeof key === "string").sort();
    if (encodeCanonicalJson(keys) !== encodeCanonicalJson(["apply", "implementationDigest", "mutationId"])) throw new TypeError(`mutation ${mutator.mutationId} has unsupported fields`);
    if (!declared.has(mutator.mutationId)) throw new TypeError(`undeclared terminal-selection mutationId: ${mutator.mutationId}`);
    if (seen.has(mutator.mutationId)) throw new TypeError(`duplicate terminal-selection mutationId: ${mutator.mutationId}`);
    const expected = TERMINAL_SELECTION_MUTATION_REGISTRY[index];
    if (expected === undefined
      || expected.mutationId !== mutator.mutationId
      || expected.implementationDigest !== mutator.implementationDigest
      || expected.apply !== mutator.apply) {
      throw new TypeError(`terminal-selection mutation implementation mismatch: ${mutator.mutationId}`);
    }
    seen.add(mutator.mutationId);
  }
  if (seen.size !== declared.size || [...declared].some(id => !seen.has(id))) throw new TypeError("terminal-selection mutation corpus is incomplete");
  return Object.freeze([...seen].sort());
}

function buildTerminalSelectionQualificationCertificate(
  runner: TerminalSelectionQualificationRunnerV1,
): TerminalSelectionQualificationCertificateV1 {
  const errors: string[] = [];
  let mutationIds: readonly string[] = [];
  try {
    mutationIds = exactMutationSet(runner.mutators);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "invalid terminal-selection mutation corpus");
  }
  const baseRoot = evidenceRoot(runner.base);
  const baseRuntime = evaluateTerminalSelectionPredicate(runner.base.runtime);
  const baseReference = evaluateTerminalSelectionReferenceModel(runner.base.reference);
  const cases: ExecutedTerminalSelectionCaseV1[] = [Object.freeze({
    caseId: "positive",
    mutationId: null,
    runtimeVerdict: baseRuntime.verdict,
    referenceVerdict: baseReference.verdict,
    evidenceRoot: baseRoot,
  })];
  if (baseRuntime.verdict !== "pass" || baseReference.verdict !== "pass" || baseRuntime.verdict !== baseReference.verdict) {
    errors.push("positive-case-missing-or-failed");
  }
  if (errors.length === 0) {
    for (const mutator of runner.mutators) {
      let mutated: TerminalSelectionQualificationFixtureV1;
      try {
        mutated = mutator.apply(structuredClone(runner.base) as TerminalSelectionQualificationFixtureV1);
      } catch {
        errors.push(`${mutator.mutationId}:mutator-threw`);
        continue;
      }
      const mutatedRoot = evidenceRoot(mutated);
      if (mutatedRoot === baseRoot) {
        errors.push(`${mutator.mutationId}:mutator-no-op`);
        continue;
      }
      const runtime = evaluateTerminalSelectionPredicate(mutated.runtime);
      const reference = evaluateTerminalSelectionReferenceModel(mutated.reference);
      cases.push(Object.freeze({
        caseId: `mutation:${mutator.mutationId}`,
        mutationId: mutator.mutationId,
        runtimeVerdict: runtime.verdict,
        referenceVerdict: reference.verdict,
        evidenceRoot: mutatedRoot,
      }));
      if (runtime.verdict === "pass" || reference.verdict === "pass") errors.push(`${mutator.mutationId}:mutation-passed`);
      if (runtime.verdict !== reference.verdict) errors.push(`${mutator.mutationId}:runtime-reference-disagreement`);
    }
  }
  const declared = [...TERMINAL_SELECTION_CRITICAL_MUTATION_IDS].sort();
  const rejectedOrInvalid = cases
    .filter(item => item.mutationId !== null && item.runtimeVerdict !== "pass" && item.runtimeVerdict === item.referenceVerdict)
    .map(item => item.mutationId as string)
    .sort();
  if (encodeCanonicalJson(mutationIds) !== encodeCanonicalJson(declared)
    || encodeCanonicalJson(rejectedOrInvalid) !== encodeCanonicalJson(declared)) {
    errors.push("critical-mutation-set-mismatch");
  }
  const orderedCases = cases.slice().sort((left, right) => left.caseId.localeCompare(right.caseId));
  const positiveCases = orderedCases.filter(item => item.mutationId === null);
  const mutationCases = orderedCases.filter(item => item.mutationId !== null);
  const positiveCaseRoot = caseRoot("aloha/terminal-selection/qualification/positive-cases/v1", positiveCases);
  const mutationCaseRoot = caseRoot("aloha/terminal-selection/qualification/mutation-cases/v1", mutationCases);
  const independentOracleCaseRoot = hashDomain("aloha/terminal-selection/qualification/independent-oracle-cases/v1", {
    positiveCaseRoot,
    mutationCaseRoot,
  });
  const qualificationSpecDigest = hashDomain("aloha/terminal-selection/qualification-spec/v1", {
    declaredCriticalMutationIds: declared,
    independentOracleCaseCount: orderedCases.length.toString(),
    mutationRegistryDigest: TERMINAL_SELECTION_MUTATION_REGISTRY_DIGEST,
    predicateProgramDescriptorDigest: TERMINAL_SELECTION_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
    oracleProgramDescriptorDigest: TERMINAL_SELECTION_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
    runner: "fixed-coherent-mutator-registry-v1",
  });
  const verdict = errors.length === 0 ? "qualified" as const : "not-qualified" as const;
  const payload = Object.freeze({
    predicateSpecDigest: TERMINAL_SELECTION_PREDICATE_SPEC.specDigest,
    predicateProgramDescriptorDigest: TERMINAL_SELECTION_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
    oracleProgramDescriptorDigest: TERMINAL_SELECTION_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
    mutationRegistryDigest: TERMINAL_SELECTION_MUTATION_REGISTRY_DIGEST,
    qualificationSpecDigest,
    positiveEvidenceRoot: baseRoot,
    positiveCaseRoot,
    mutationCaseRoot,
    declaredCriticalMutationIds: declared,
    rejectedOrInvalidMutationIds: rejectedOrInvalid,
    independentOracleCaseRoot,
    independentOracleCaseCount: orderedCases.length.toString(),
    positiveCase: positiveCases[0]!,
    mutationCases,
    verdict,
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.terminal-selection-verifier-qualification",
    certificateId: hashDomain("aloha/terminal-selection/verifier-qualification/v1", payload),
    ...payload,
  });
}

/** Production qualification always executes the package-owned fixed registry. */
export function qualifyTerminalSelectionCorpus(
  base: TerminalSelectionQualificationFixtureV1,
): TerminalSelectionQualificationCertificateV1 {
  return buildTerminalSelectionQualificationCertificate({
    base,
    mutators: TERMINAL_SELECTION_MUTATION_REGISTRY,
  });
}

/** Structural corpus audit for negative tests; it cannot mint a certificate. */
export function validateTerminalSelectionMutationCorpus(
  base: TerminalSelectionQualificationFixtureV1,
  mutators: readonly TerminalSelectionMutationMutatorV1[],
): boolean {
  return buildTerminalSelectionQualificationCertificate({ base, mutators }).verdict === "qualified";
}

export function assertQualifiedTerminalSelectionCertificate(
  certificate: TerminalSelectionQualificationCertificateV1,
): void {
  const exactKeys = [
    "schemaVersion", "kind", "certificateId", "predicateSpecDigest", "predicateProgramDescriptorDigest",
    "oracleProgramDescriptorDigest", "mutationRegistryDigest", "qualificationSpecDigest", "positiveEvidenceRoot",
    "positiveCaseRoot", "mutationCaseRoot", "declaredCriticalMutationIds", "rejectedOrInvalidMutationIds",
    "independentOracleCaseRoot", "independentOracleCaseCount", "positiveCase", "mutationCases", "verdict",
  ].sort();
  const actualKeys = Reflect.ownKeys(certificate as object).filter((key): key is string => typeof key === "string").sort();
  if (encodeCanonicalJson(actualKeys) !== encodeCanonicalJson(exactKeys)) throw new TypeError("terminal-selection qualification certificate shape is invalid");
  if (certificate.schemaVersion !== 1 || certificate.kind !== "aloha.terminal-selection-verifier-qualification") throw new TypeError("terminal-selection qualification certificate identity is invalid");
  if (certificate.verdict !== "qualified") throw new TypeError("terminal-selection qualification is not qualified");
  if (certificate.predicateSpecDigest !== TERMINAL_SELECTION_PREDICATE_SPEC.specDigest) throw new TypeError("terminal-selection predicate spec changed");
  if (certificate.predicateProgramDescriptorDigest !== TERMINAL_SELECTION_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST
    || certificate.oracleProgramDescriptorDigest !== TERMINAL_SELECTION_ORACLE_PROGRAM_DESCRIPTOR_DIGEST) {
    throw new TypeError("terminal-selection verifier implementation changed");
  }
  if (certificate.mutationRegistryDigest !== TERMINAL_SELECTION_MUTATION_REGISTRY_DIGEST) throw new TypeError("terminal-selection mutation registry changed");
  for (const [path, value] of [
    ["certificateId", certificate.certificateId],
    ["predicateSpecDigest", certificate.predicateSpecDigest],
    ["predicateProgramDescriptorDigest", certificate.predicateProgramDescriptorDigest],
    ["oracleProgramDescriptorDigest", certificate.oracleProgramDescriptorDigest],
    ["mutationRegistryDigest", certificate.mutationRegistryDigest],
    ["qualificationSpecDigest", certificate.qualificationSpecDigest],
    ["positiveEvidenceRoot", certificate.positiveEvidenceRoot],
    ["positiveCaseRoot", certificate.positiveCaseRoot],
    ["mutationCaseRoot", certificate.mutationCaseRoot],
    ["independentOracleCaseRoot", certificate.independentOracleCaseRoot],
  ] as const) assertHash(value, `terminalSelectionQualification.${path}`);
  const declared = [...TERMINAL_SELECTION_CRITICAL_MUTATION_IDS].sort();
  if (encodeCanonicalJson(certificate.declaredCriticalMutationIds) !== encodeCanonicalJson(declared)
    || encodeCanonicalJson(certificate.rejectedOrInvalidMutationIds) !== encodeCanonicalJson(declared)) {
    throw new TypeError("terminal-selection mutation coverage is incomplete");
  }
  const expectedCaseCount = declared.length + 1;
  const assertCase = (item: ExecutedTerminalSelectionCaseV1, expectedCaseId: string, expectedMutationId: string | null): void => {
    const caseKeys = Reflect.ownKeys(item as object).filter((key): key is string => typeof key === "string").sort();
    if (encodeCanonicalJson(caseKeys) !== encodeCanonicalJson(["caseId", "evidenceRoot", "mutationId", "referenceVerdict", "runtimeVerdict"])) {
      throw new TypeError("terminal-selection qualification case shape is invalid");
    }
    if (item.caseId !== expectedCaseId || item.mutationId !== expectedMutationId) {
      throw new TypeError("terminal-selection qualification case identity is invalid");
    }
    if (!(["pass", "fail", "invalid"] as const).includes(item.runtimeVerdict)
      || !(["pass", "fail", "invalid"] as const).includes(item.referenceVerdict)) {
      throw new TypeError("terminal-selection qualification case verdict is invalid");
    }
    assertHash(item.evidenceRoot, `terminalSelectionQualification.cases.${expectedCaseId}.evidenceRoot`);
  };
  assertCase(certificate.positiveCase, "positive", null);
  if (certificate.independentOracleCaseCount !== String(expectedCaseCount)
    || certificate.mutationCases.length !== declared.length
    || certificate.positiveCase.caseId !== "positive"
    || certificate.positiveCase.mutationId !== null
    || certificate.positiveCase.evidenceRoot !== certificate.positiveEvidenceRoot
    || certificate.positiveCase.runtimeVerdict !== "pass"
    || certificate.positiveCase.referenceVerdict !== "pass") {
    throw new TypeError("terminal-selection independent oracle case set is invalid");
  }
  for (const [index, mutationId] of declared.entries()) {
    const item = certificate.mutationCases[index];
    if (item === undefined) throw new TypeError("terminal-selection mutation case set is incomplete");
    assertCase(item, `mutation:${mutationId}`, mutationId);
    if (item.runtimeVerdict === "pass"
      || item.referenceVerdict === "pass"
      || item.runtimeVerdict !== item.referenceVerdict) {
      throw new TypeError("terminal-selection mutation case set is invalid");
    }
  }
  const positiveCaseRoot = caseRoot("aloha/terminal-selection/qualification/positive-cases/v1", [certificate.positiveCase]);
  const mutationCaseRoot = caseRoot("aloha/terminal-selection/qualification/mutation-cases/v1", certificate.mutationCases);
  const independentOracleCaseRoot = hashDomain("aloha/terminal-selection/qualification/independent-oracle-cases/v1", {
    positiveCaseRoot,
    mutationCaseRoot,
  });
  if (certificate.positiveCaseRoot !== positiveCaseRoot
    || certificate.mutationCaseRoot !== mutationCaseRoot
    || certificate.independentOracleCaseRoot !== independentOracleCaseRoot) {
    throw new TypeError("terminal-selection qualification case roots are invalid");
  }
  const qualificationSpecDigest = hashDomain("aloha/terminal-selection/qualification-spec/v1", {
    declaredCriticalMutationIds: declared,
    independentOracleCaseCount: String(expectedCaseCount),
    mutationRegistryDigest: TERMINAL_SELECTION_MUTATION_REGISTRY_DIGEST,
    predicateProgramDescriptorDigest: TERMINAL_SELECTION_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
    oracleProgramDescriptorDigest: TERMINAL_SELECTION_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
    runner: "fixed-coherent-mutator-registry-v1",
  });
  if (certificate.qualificationSpecDigest !== qualificationSpecDigest) throw new TypeError("terminal-selection qualification spec changed");
  const { schemaVersion: _schemaVersion, kind: _kind, certificateId: _certificateId, ...payload } = certificate;
  if (certificate.certificateId !== hashDomain("aloha/terminal-selection/verifier-qualification/v1", payload)) {
    throw new TypeError("terminal-selection qualification certificate id mismatch");
  }
}

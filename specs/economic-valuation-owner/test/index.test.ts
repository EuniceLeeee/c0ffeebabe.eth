import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeEconomicValuationOwnerQualificationCertificateV1,
  joinEconomicValuationOwnerQualificationSetV1,
  sealEconomicValuationOwnerQualificationCertificateSetV1,
  sealEconomicValuationOwnerQualificationCertificateV1,
  sealGeneratedEconomicValuationOwnerRegistryV1,
  sealQualifiedEconomicValuationOwnerEntryV1,
  type EconomicValuationOwnerDeclarationV1,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/economic-valuation-owner", value);
const declaration = (name: string): EconomicValuationOwnerDeclarationV1 => ({
  ownerRef: h(`${name}:owner`),
  modulePath: `valuation-owners/${name}/src/runtime.ts`,
  exportName: "readEconomicValuationOwnerV1",
  implementationHash: h(`${name}:implementation`),
  factSchemaRef: h(`${name}:fact-schema`),
  sourceReadCapabilityRefs: [],
  qualificationModulePath: `valuation-owners/${name}/src/qualification.ts`,
  qualificationSpecExportName: "QUALIFICATION_SPEC",
  criticalMutationCorpusExportName: "MUTATION_CORPUS",
  independentOracleCasesExportName: "INDEPENDENT_ORACLE_CASES",
  qualificationSpecDigest: h(`${name}:qualification-spec`),
  criticalMutationCorpusRoot: h(`${name}:mutations`),
  independentOracleCaseRoot: h(`${name}:oracle`),
});
const closures = Object.freeze({
  qualificationSpecClosureRoot: h("qualification-spec-closure"),
  criticalMutationCorpusClosureRoot: h("mutation-corpus-closure"),
  independentOracleClosureRoot: h("independent-oracle-closure"),
});

test("registry roots bind runtime identity, closure, fact schema and qualification", () => {
  const first = sealQualifiedEconomicValuationOwnerEntryV1(declaration("native"), h("native:closure"), closures);
  const original = sealGeneratedEconomicValuationOwnerRegistryV1([first]);
  for (const changed of [
    sealQualifiedEconomicValuationOwnerEntryV1({ ...declaration("native"), implementationHash: h("changed") }, h("native:closure"), closures),
    sealQualifiedEconomicValuationOwnerEntryV1(declaration("native"), h("changed-closure"), closures),
    sealQualifiedEconomicValuationOwnerEntryV1({ ...declaration("native"), factSchemaRef: h("changed-schema") }, h("native:closure"), closures),
    sealQualifiedEconomicValuationOwnerEntryV1({ ...declaration("native"), independentOracleCaseRoot: h("changed-oracle") }, h("native:closure"), closures),
  ]) {
    const registry = sealGeneratedEconomicValuationOwnerRegistryV1([changed]);
    assert.notEqual(registry.valuationOwnerRegistryRoot, original.valuationOwnerRegistryRoot);
  }
});

test("registry rejects stale leaves, duplicates and non-canonical source capability refs", () => {
  const first = sealQualifiedEconomicValuationOwnerEntryV1(declaration("native"), h("native:closure"), closures);
  assert.throws(() => sealGeneratedEconomicValuationOwnerRegistryV1([{ ...first, qualificationLeafDigest: h("stale") }]), /leaf mismatch/);
  assert.throws(() => sealGeneratedEconomicValuationOwnerRegistryV1([first, first]), /qualification leaves must be unique/);
  assert.throws(() => sealQualifiedEconomicValuationOwnerEntryV1({
    ...declaration("native"),
    sourceReadCapabilityRefs: [h("z"), h("a")],
  }, h("native:closure"), closures), /strictly sorted and unique/);
});

test("externally issued qualification certificates bind executed oracle/mutation outcomes and exact proposed owner leaf", () => {
  const entry = sealQualifiedEconomicValuationOwnerEntryV1(declaration("native"), h("native:closure"), closures);
  const registry = sealGeneratedEconomicValuationOwnerRegistryV1([entry]);
  const certificate = sealEconomicValuationOwnerQualificationCertificateV1({
    schemaVersion: 1,
    kind: "aloha.economic-valuation-owner-qualification-certificate",
    ownerRef: entry.ownerRef,
    proposedOwnerLeafDigest: entry.qualificationLeafDigest,
    implementationHash: entry.implementationHash,
    factSchemaRef: entry.factSchemaRef,
    implementationClosureRoot: entry.implementationClosureRoot,
    qualificationSpecDigest: entry.qualificationSpecDigest,
    qualificationSpecClosureRoot: entry.qualificationSpecClosureRoot,
    criticalMutationCorpusRoot: entry.criticalMutationCorpusRoot,
    criticalMutationCorpusClosureRoot: entry.criticalMutationCorpusClosureRoot,
    independentOracleCaseRoot: entry.independentOracleCaseRoot,
    independentOracleClosureRoot: entry.independentOracleClosureRoot,
    executedPositiveCaseRoot: h("executed-positive"),
    executedNegativeCaseRoot: h("executed-negative"),
    executedInvalidCaseRoot: h("executed-invalid"),
    verifierImplementationDigest: h("verifier"),
    qualificationAuthorityApprovalId: h("qualification-approval"),
    qualificationAuthorityApprovalPayloadHash: h("qualification-approval-payload"),
  });
  assert.deepEqual(decodeEconomicValuationOwnerQualificationCertificateV1(certificate), certificate);
  const set = sealEconomicValuationOwnerQualificationCertificateSetV1([certificate]);
  assert.match(set.root, /^0x[0-9a-f]{64}$/);
  const joined = joinEconomicValuationOwnerQualificationSetV1(registry, set.certificates, set.root);
  assert.equal(joined.registry.valuationOwnerRegistryRoot, registry.valuationOwnerRegistryRoot);
  assert.equal(joined.qualifiedValuationOwnerSetRoot, set.root);
  assert.throws(
    () => joinEconomicValuationOwnerQualificationSetV1(registry, set.certificates, h("wrong-set-root")),
    /qualified set root mismatch/,
  );
  assert.throws(
    () => joinEconomicValuationOwnerQualificationSetV1(registry, [], h("empty-set-root")),
    /certificate set must be non-empty/,
  );
  const foreign = sealEconomicValuationOwnerQualificationCertificateV1({
    ...certificate,
    ownerRef: h("foreign-owner"),
    proposedOwnerLeafDigest: h("foreign-proposal"),
  });
  const superset = sealEconomicValuationOwnerQualificationCertificateSetV1(
    [certificate, foreign].sort((left, right) => left.ownerRef.localeCompare(right.ownerRef)),
  );
  assert.throws(
    () => joinEconomicValuationOwnerQualificationSetV1(registry, superset.certificates, superset.root),
    /cardinality mismatch/,
  );
  assert.throws(
    () => joinEconomicValuationOwnerQualificationSetV1(
      registry,
      [sealEconomicValuationOwnerQualificationCertificateV1({
        ...certificate,
        proposedOwnerLeafDigest: h("foreign-proposal"),
      })],
      sealEconomicValuationOwnerQualificationCertificateSetV1([sealEconomicValuationOwnerQualificationCertificateV1({
        ...certificate,
        proposedOwnerLeafDigest: h("foreign-proposal"),
      })]).root,
    ),
    /does not exact-join proposal/,
  );
  assert.throws(() => decodeEconomicValuationOwnerQualificationCertificateV1({
    ...certificate,
    executedNegativeCaseRoot: h("forged-negative"),
  }), /certificate root mismatch/);
});

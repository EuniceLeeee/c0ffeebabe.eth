import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJsonFingerprint } from "../universe-rebuild-checkpoint.js";
import { reconcileReadyInputs } from "../ready-input-reconciliation.js";
import { createReadyRuleCompatibility, issueReadyRuleMigration, sealReadyRuleBindings,
  validateReadyRuleBindings, type ReadyRuleHashes } from "../ready-rule-bindings.js";

const h = (s: string) => s.repeat(64);
const scopes = (s: string): ReadyRuleHashes => ({ full: h(s), memo: h(s), discovery: h(s) });
const origin = { generation: 18, checkpointFingerprint: h("a"), sourceSha256: h("b"), archiveManifestSha256: h("c") };
const rules = { a: scopes("1"), b: scopes("2") };
const legacy = { a: scopes("3"), b: scopes("4") };
const current = { a: scopes("5"), b: scopes("6") };
function bindings() {
  return sealReadyRuleBindings({ version: 1, origin, families: Object.fromEntries(["a", "b"].map(id => [id,
    Object.fromEntries(["full", "memo", "discovery"].map(scope => [scope, {
      rulesHash: rules[id as "a" | "b"][scope as keyof ReadyRuleHashes],
      definitionHashes: [legacy[id as "a" | "b"][scope as keyof ReadyRuleHashes]],
    }]))])) as any });
}
test("equivalent archived rules preserve old proof IDs; changed rules and other Families cannot borrow them", () => {
  const c = createReadyRuleCompatibility({ bindings: bindings(), currentRules: { ...rules, b: scopes("7") }, currentHashes: current });
  assert(c.equivalent("a", legacy.a.full, current.a.full));
  assert(c.accepts("a", "memo", legacy.a.memo));
  assert(!c.accepts("a", "memo", legacy.b.memo));
  assert(!c.accepts("b", "memo", legacy.b.memo));
  assert(!c.equivalent("a", legacy.a.full, h("f")));
  const next = c.nextBindings();
  assert.deepEqual(next.origin, origin);
  assert.deepEqual(next.families.a.memo.definitionHashes, [h("3"), h("5")]);
  assert.deepEqual(next.families.b.memo.definitionHashes, [h("6")]);
  assert(Object.isFrozen(next.families.a.memo.definitionHashes));
  assert.throws(() => validateReadyRuleBindings({ ...next, fingerprint: h("0") }));
  const disabled = createReadyRuleCompatibility({ bindings: bindings(), currentRules: {a: rules.a}, currentHashes: {a: current.a} });
  assert(!disabled.accepts("b", "memo", legacy.b.memo));
  const restored = createReadyRuleCompatibility({ bindings: disabled.nextBindings(), currentRules: rules, currentHashes: current });
  assert(restored.accepts("b", "memo", legacy.b.memo), "disable/enable preserves historical equivalence without making it active");
});

test("all completed statuses inherit under identical rules, while source/input/force changes still execute normally", () => {
  const c = createReadyRuleCompatibility({ bindings: bindings(), currentRules: rules, currentHashes: current });
  const cutoff = { number: 100, hash: "0x" + h("a"), generation: 1 };
  const candidates = { v: { address: "v" }, r: { address: "r" }, t: { address: "t" } };
  const outcomes = { v: { status: "verified" }, r: { status: "terminal-rejected" }, t: { status: "retryable" } };
  const input: any = { candidatesByFamily: new Map([["a", candidates]]), familyDefinitionHashes: { a: current.a.full },
    definitionsEquivalent: c.equivalent, previousPartitions: { a: { familyDefinitionHash: legacy.a.full,
      candidatesByKey: candidates, candidateSetHash: canonicalJsonFingerprint(candidates, "universe-candidate-partition-v1:"),
      outcomesByCandidateKey: outcomes } }, cutoff, sameProofSource: true, forcedStatuses: new Set() };
  const result = reconcileReadyInputs(input);
  assert.equal(result.inheritedOutcomes.size, 3);
  assert.equal(result.classes.A, 3);
  assert.equal(reconcileReadyInputs({ ...input, sameProofSource: false }).inheritedOutcomes.size, 0);
  assert.equal(reconcileReadyInputs({ ...input, forcedStatuses: new Set(["retryable"]) }).inheritedOutcomes.size, 2);
  assert.equal(reconcileReadyInputs({ ...input, candidatesByFamily: new Map([["a", { ...candidates, v: { address: "changed" } }]]) }).inheritedOutcomes.size, 2);
  assert.equal(reconcileReadyInputs({ ...input, definitionsEquivalent: () => false }).inheritedOutcomes.size, 0);
});

test("migration requires independently reproduced old definitions and leaves evidence untouched", () => {
  const checkpoint: any = { checkpointFingerprint: origin.checkpointFingerprint, inProgressRun: null,
    readyGeneration: { generation: 18, familyPartitions: { a: { familyDefinitionHash: legacy.a.full,
      discoveryDefinitionHash: legacy.a.discovery } } },
    verifiedMemos: { v: { familyId: "a", familyDefinitionHash: legacy.a.memo, memoFingerprint: h("d"),
      validity: { proofSource: { number: 100, hash: "0x" + h("e") }, authorityFingerprint: h("f") } } } };
  const before = JSON.stringify(checkpoint);
  const input = { checkpoint, archivedHashes: legacy, archivedRules: rules,
    sourceSha256: origin.sourceSha256, archiveManifestSha256: origin.archiveManifestSha256 };
  const migration = issueReadyRuleMigration(input);
  assert.equal(migration.bindings.families.a.memo.rulesHash, rules.a.memo);
  assert.equal(JSON.stringify(checkpoint), before);
  assert.throws(() => issueReadyRuleMigration({ ...input, archivedHashes: current }), /archived Ready/);
  assert.throws(() => issueReadyRuleMigration({ ...input, checkpoint: { ...checkpoint, inProgressRun: {} } }), /completed Ready/);
  assert.throws(() => issueReadyRuleMigration({ ...input, checkpoint: { ...checkpoint,
    verifiedMemos: { v: { ...checkpoint.verifiedMemos.v, familyDefinitionHash: h("0") } } } }), /memo definition/);
});

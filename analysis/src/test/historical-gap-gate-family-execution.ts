import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gate = readFileSync(
  new URL("../cli/historical-gap-gate.ts", import.meta.url),
  "utf8",
);

test("family execution dispatch bypasses the production hunt path", () => {
  const start = gate.indexOf('} else if (track === "family-execution") {');
  const end = gate.indexOf("\n      }\n      assertFrozenWorktree", start);
  assert.ok(start > 0 && end > start, "family-execution dispatch is absent");
  const dispatch = gate.slice(start, end);
  assert.match(dispatch, /validateFamilyReplayEnvironment\(record\)/);
  assert.match(dispatch, /runFamilyExecutionReplays\(/);
  assert.match(dispatch, /assertTrustedRpcStillMatches\(record, familyReplayEnvironment\)/);
  assert.doesNotMatch(dispatch, /runCandidateReplays|runTrustedSmoke|ab-canary-gate|blockscan-hunt|backrun-hunt/);
});

test("family execution materializes only hash-bound artifact-ref fixture and evidence", () => {
  assert.match(gate, /safeGitAt\(\s*artifactObjectRoot,\s*\["show", `\$\{artifactCommit\}:\$\{fixturePath\}`\]/);
  assert.match(gate, /sha256\(fixtureBytes\) !== fixtureSha256/);
  assert.match(gate, /sha256\(evidenceBytes\) !== evidenceSha256/);
  assert.match(gate, /landed as Record<string, unknown>\)\.evidencePath !== evidencePath/);
  assert.match(gate, /landed as Record<string, unknown>\)\.evidenceSha256 !== evidenceSha256/);
  assert.match(gate, /materializeFamilyArtifact\(artifactRoot, fixturePath, fixtureBytes\)/);
  assert.match(gate, /materializeFamilyArtifact\(artifactRoot, evidencePath, evidenceBytes\)/);
});

test("family execution accepts only semantic baseline and challenger results", () => {
  assert.match(gate, /--probe-family", executionFamilyId/);
  assert.match(gate, /ADAPTER_FAMILY_REGISTRY_PROBE/);
  assert.match(gate, /ADAPTER_FAMILY_REPLAY_RESULT/);
  assert.match(gate, /sixStepEvidence: SemanticSixStepEvidence\[\]/);
  assert.match(gate, /validFamilySemanticEvidence\(report\)/);
  assert.match(gate, /semanticSixStepSequenceError\(evidence\)/);
  assert.match(gate, /evidence\[0\]\?\.status !== "bypassed"/);
  assert.match(gate, /evidence\[1\]\?\.status !== "bypassed"/);
  assert.match(gate, /evidence\.slice\(2\)\.every\(\(stage\) => stage\.status === "pass"\)/);
  assert.match(gate, /baseline family replay \$\{index\} must emit registered\+implemented_not_validated/);
  assert.match(gate, /replay\.report\.failureOwnerFamilyId !== sample\.executionFamilyId/);
  assert.match(gate, /replay\.report\.failureIdentity\?\.ownerFamilyId !== sample\.executionFamilyId/);
  assert.match(gate, /familyFailureIdentityMatchesEvidence\(replay\.report\)/);
  assert.match(gate, /replay\.report\.stages\.chainAnchor !== true/);
  assert.match(gate, /challengerReplay\.report\.verdict !== "adapter_replay_pass"/);
  assert.match(gate, /challengerReplay\.report\.failureOwnerFamilyId !== null/);
  assert.match(gate, /Object\.values\(challengerReplay\.report\.stages\)\.some\(\(passed\) => passed !== true\)/);
  assert.match(gate, /baseline family replay confirmation/);
  assert.match(gate, /familyReplayFailureFingerprint\(confirmation\.report\)/);
  assert.match(gate, /confirmation\.report\.failureOwnerFamilyId !== sample\.executionFamilyId/);
  assert.match(gate, /confirmationFingerprint !== baseline\.failure_fingerprint_sha256/);
  assert.doesNotMatch(gate, /JSON\.stringify\(confirmation\.report\) !== JSON\.stringify\(baseline\.replay\)/);
  assert.match(gate, /a transient runner\/RPC failure cannot prove a family flip/);
  assert.match(gate, /result\.status === null/);
  assert.match(gate, /must emit exactly one \$\{marker\} marker/);
  assert.match(gate, /SEARCHER_LIVE_RPC_URL: rpcUrl/);
  assert.doesNotMatch(gate, /family_not_registered"[\s\S]{0,300}result\.status\s*!==\s*0/);
});

test("family execution runs and receipt-binds the trusted conformance suite", () => {
  for (const script of [
    "src/searcher/test/adapter-descriptors.ts",
    "src/searcher/test/route-adapters.ts",
    "src/searcher/test/token-graph-family-isolation.ts",
    "src/searcher/test/adapter-family-shared-surface-conformance.ts",
    "src/searcher/test/family-ownership-manifest.ts",
  ]) {
    assert.match(gate, new RegExp(script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(gate, /runFamilyConformanceGates\(validationRoot, baselineRoot\)/);
  assert.match(gate, /family conformance script differs from the frozen baseline/);
  assert.match(gate, /if \(result\.status !== 0\)/);
  assert.match(gate, /source_sha256: sourceSha256/);
  assert.match(gate, /output_sha256: sha256\(result\.output\)/);
  assert.match(gate, /family_conformance: input\.familyConformance/);
  assert.match(gate, /validateStoredFamilyConformance\(record, receipt\.family_conformance/);
  assert.match(gate, /`\$\{record\.challenger_commit\}:listener\/\$\{scriptPath\}`/);
  assert.match(gate, /`\$\{record\.base_commit\}:listener\/\$\{scriptPath\}`/);
  assert.match(
    gate,
    /receipt\.family_conformance[\s\S]{0,120}receipt\.family_ownership[\s\S]{0,120}receipt\.family_replay_environment/,
  );
});

test("family execution derives changed owners and requires exact fixture coverage", () => {
  assert.match(gate, /runFamilyOwnershipManifest\(\s*baseRoot/);
  assert.match(gate, /runFamilyOwnershipManifest\(\s*challengerRoot/);
  assert.match(gate, /validateFamilyExecutionDiffCoverage\(\{/);
  assert.match(gate, /subjectFamilyIds: samples\.map\(\(sample\) => sample\.executionFamilyId\)/);
  assert.match(gate, /family execution ownership coverage failed/);
  assert.match(gate, /family_ownership\?: HistoricalFamilyOwnershipAttestation/);
  assert.match(gate, /family_ownership: input\.familyOwnership/);
  assert.match(gate, /validateStoredFamilyOwnership\(/);
  assert.match(gate, /affected_execution_family_ids/);
  assert.match(gate, /subject_execution_family_ids/);
  assert.match(gate, /family execution receipt is missing exact registry-derived family ownership coverage/);
  assert.ok(
    gate.indexOf("familyOwnership = prepareFamilyExecutionOwnership(") <
      gate.indexOf("familyReplayEnvironment = await validateFamilyReplayEnvironment(record)"),
    "ownership coverage must fail before opening the trusted replay tunnel",
  );
});

test("family execution receipt binds both sides and archives fixture evidence", () => {
  assert.match(gate, /family_execution_artifacts\?: HistoricalFamilyExecutionArtifact\[\]/);
  assert.match(gate, /family_conformance\?: HistoricalFamilyConformanceAttestation/);
  assert.match(gate, /family_replay_environment\?:/);
  assert.match(gate, /baseline: HistoricalFamilyExecutionSideResult/);
  assert.match(gate, /challenger: HistoricalFamilyExecutionSideResult/);
  assert.match(gate, /validStoredFamilyBaseline\(artifact\.baseline, artifact\)/);
  assert.match(gate, /side\.replay!\.failureOwnerFamilyId === artifact\.execution_family_id/);
  assert.match(gate, /validStoredFamilyChallenger\(artifact\.challenger, artifact\)/);
  assert.match(gate, /requireArchivedArtifact\(artifact\.fixture_path, artifact\.fixture_sha256/);
  assert.match(gate, /requireArchivedArtifact\(artifact\.evidence_path, artifact\.evidence_sha256/);
});

test("landed witness binds the solver-selected resolved plan and final calldata", () => {
  const runner = readFileSync(
    new URL("../../../listener/src/searcher/test/adapter-replay.ts", import.meta.url),
    "utf8",
  );
  const solve = runner.indexOf("const solved = await (async");
  const witness = runner.indexOf(
    "const executionSurfaces = referenceExecutionSurfaces",
    solve,
  );
  const reference = runner.indexOf(
    "const referenceTraceHash = await validateReferenceRoute",
    witness,
  );
  const finalSim = runner.indexOf("const sim = await simulator.simulate(solved)", reference);
  assert.ok(solve > 0 && witness > solve && reference > witness && finalSim > reference);
  assert.match(
    runner.slice(witness, reference),
    /fixture,\s*edges,\s*solved\.root/,
  );
  const helperStart = runner.indexOf("function referenceExecutionSurfaces");
  const helperEnd = runner.indexOf("\nfunction firstEncodedExternalCall", helperStart);
  const helper = runner.slice(helperStart, helperEnd);
  assert.match(helper, /compilePlan\(node, DEFAULT_SEARCHER_EXECUTOR\)/);
  assert.match(helper, /executionNodes\.length !== fixture\.route\.length/);
  assert.match(
    helper,
    /resolvedPlanExecutionIdentity\(family, node\)/,
  );
  assert.match(
    helper,
    /!planExecutionIdentityMatchesEdge\(planIdentity, edge\)/,
  );
  assert.doesNotMatch(
    helper,
    /resolvedPlanExecutionIdentity\([^,]+,\s*edge/,
  );
  assert.doesNotMatch(
    helper,
    /node\.tokenOut\.toLowerCase\(\) !== leg\.tokenOut\.toLowerCase\(\)/,
  );
  assert.doesNotMatch(helper, /buildPlanFragment|new Uint8Array\(\)/);
  assert.match(
    runner.slice(finalSim, finalSim + 600),
    /sim\.calldata\.toLowerCase\(\) !== resolvedCalldata\.toLowerCase\(\)/,
  );
});

test("family runner is registry-derived instead of maintaining a per-family source map", () => {
  const runner = readFileSync(
    new URL("../../../listener/src/searcher/test/adapter-replay.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(runner, /FAMILY_SOURCE_FILES/);
  assert.match(runner, /familyContractSha256\(fixture\.executionFamilyId\)/);
  assert.match(runner, /PRODUCTION_ADAPTER_FAMILIES\.routes\(\)\.list\(\)/);
  assert.match(runner, /--probe-family must be used alone/);
});

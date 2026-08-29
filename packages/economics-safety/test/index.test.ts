import assert from "node:assert/strict";
import test from "node:test";
import { encodeCanonicalJson, hashDomain, type CanonicalJson, type Hash } from "../../canonical-codec/src/index.ts";
import { erc20AssetReferenceV1, nativeAssetReferenceV1 } from "../../asset-ref/src/index.ts";
import {
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_SWAP_ACTION_OWNER,
  UNIV2_STANDARD_SWAP_ACTION_PORT,
  type UniV2ExactEvaluationV1,
} from "../../../families/univ2-standard/src/public.ts";
import {
  assertIssuedEconomicSafetyFinalizationServiceV1,
  createEconomicSafetyQualifiedEvaluatorV1,
  EconomicSafetyPolicyRejectionErrorV1,
  validateEconomicSafetyChainRejectionV1,
  validateEconomicSafetyEvidenceV1,
  type EconomicSafetyDecisionV1,
  type EconomicSafetyFinalizationInputV1,
} from "../src/index.ts";
import { issueEconomicSafetyFinalizationServiceV1 } from "../src/internal/owner.ts";
import {
  ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
  sealSafetyProfileV1,
} from "../../../specs/economic-safety-profile/src/index.ts";

const h = (value: string): Hash => hashDomain("aloha/economic-safety/test/v1", value);
const release = h("release");
const declaration = Object.freeze({ obligationRef: h("obligation"), ownerRef: h("owner"), policy: "must-satisfy" as const });
const obligationRoot = hashDomain("aloha/search-runtime-obligation-root/v1", [declaration.obligationRef]);
const decisionClaim = Object.freeze({
  claimSchemaRef: h("schema"),
  ownerRef: declaration.ownerRef,
  qualificationLeafDigest: h("owner-qualification-leaf"),
  revmObservationSchemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
});
const decisionProfile = sealSafetyProfileV1({
  profileRef: h("safety-profile"),
  requiredClaims: Object.freeze([decisionClaim]),
  qualifiedOwnerSetRoot: h("qualified-owner-set"),
});

function input(): EconomicSafetyFinalizationInputV1 {
  return Object.freeze({
    releaseProvenanceHash: release,
    correlationId: h("correlation"),
    generationId: "generation-1",
    source: Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") }),
    objectiveRef: h("objective"),
    exactHash: h("exact"),
    programHash: h("program"),
    obligationRoot,
    finalSimulationReceiptHash: h("simulation"),
    effectsHash: h("effects"),
    executionOwnerEvidenceRoot: h("execution-owner-evidence"),
    finalSimulationOwnerEvidenceRoot: h("final-owner-evidence"),
    dryRun: true,
    executionOwnerFacts: Object.freeze({ kind: "execution-owner", gasPolicy: "actual" }),
    finalSimulationOwnerFacts: Object.freeze({ kind: "final-owner", executionReceiptHash: h("worker-receipt") }),
    declaredObligations: Object.freeze([declaration]),
  });
}

function decision(): EconomicSafetyDecisionV1 {
  const source = input().source;
  const profitAsset = nativeAssetReferenceV1("1");
  const valuationFactBody = Object.freeze({
    kind: "aloha.economic-valuation-fact-v1" as const,
    ownerRef: h("valuation-owner"),
    generationId: "generation-1",
    source,
    assetRef: profitAsset.assetRef,
    numerator: "1" as const,
    denominator: "1" as const,
    ownerImplementationHash: h("valuation-owner-implementation"),
    valuationOwnerRegistryRoot: h("valuation-owner-registry"),
    qualifiedValuationOwnerSetRoot: h("qualified-valuation-owner-set"),
    qualificationLeafDigest: h("valuation-owner-leaf"),
    currentSourceObservationRoot: h("valuation-current-source-observation"),
  });
  const valuationFact = Object.freeze({
    ...valuationFactBody,
    factRoot: hashDomain("aloha/economic-valuation-fact/v1", valuationFactBody),
  });
  return Object.freeze({
    economic: Object.freeze({
      kind: "aloha.economic-receipt-v1",
      gasUsed: "100",
      nextBlockBaseFeePerGas: "10",
      priorityFeePerGas: "2",
      effectiveGasPrice: "12",
      gasCostNative: "1200",
      profitAsset,
      grossProfitAmount: "5000",
      valuationNumerator: "1",
      valuationDenominator: "1",
      valuationFactRoot: valuationFact.factRoot,
      valuationFact,
      grossProfitNative: "5000",
      bidCostNative: "300",
      netProfitNative: "3500",
      minNetProfitNative: "1000",
      verdict: "positive-net-ev",
    }),
    safety: Object.freeze({
      kind: "aloha.final-safety-receipt-v1",
      obligationRoot,
      obligationReceipts: Object.freeze([Object.freeze({
        schemaRef: h("schema"),
        ownerRef: declaration.ownerRef,
        qualificationLeafDigest: decisionClaim.qualificationLeafDigest,
        verifierHash: h("verifier"),
        subjectRoot: declaration.obligationRef,
        proofRoot: h("proof"),
        outcome: "satisfied" as const,
      })]),
      safetyProfileRef: decisionProfile.profileRef,
      safetyProfileRoot: decisionProfile.profileCompositionRoot,
      selectedRequiredClaims: decisionProfile.requiredClaims,
      requiredClaimSetRoot: hashDomain("aloha/economic-safety-selected-required-claim-set/v1", decisionProfile.requiredClaims),
      revmObservationSchemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
      revmObservationRoot: h("revm-observation"),
      assetConservationProofRoot: h("conservation"),
      assetConservation: "satisfied",
      verdict: "safe",
    }),
  });
}

function service() {
  return issueEconomicSafetyFinalizationServiceV1({
    authorityRoot: h("authority"),
    implementationHash: h("implementation"),
    releaseProvenanceHash: release,
    evaluator: Object.freeze({ async evaluate() { return decision(); } }),
  });
}

test("owner issues exact economics/safety evidence and rejects clone/foreign capability", async () => {
  const owner = service();
  assertIssuedEconomicSafetyFinalizationServiceV1(owner);
  assert.throws(() => assertIssuedEconomicSafetyFinalizationServiceV1({ ...owner }), /not owner-issued/);
  const capability = await owner.finalize(input());
  const evidence = owner.read(capability);
  assert.equal(evidence.kind, "aloha.economic-safety-finalization-evidence-v1");
  if (evidence.kind !== "aloha.economic-safety-finalization-evidence-v1") throw new TypeError("expected accepted economic safety evidence");
  assert.equal(validateEconomicSafetyEvidenceV1(evidence, input()).evidenceRoot, evidence.evidenceRoot);
  assert.throws(() => owner.read({ ...capability }), /was not issued/);
  assert.throws(() => service().read(capability), /was not issued/);
});

test("owner seals typed policy rejection while forged capabilities and semantic faults stay invalid", async () => {
  const owner = issueEconomicSafetyFinalizationServiceV1({
    authorityRoot: h("authority"),
    implementationHash: h("implementation"),
    releaseProvenanceHash: release,
    evaluator: Object.freeze({ async evaluate(): Promise<never> {
      throw new EconomicSafetyPolicyRejectionErrorV1("quoted-gain-not-positive");
    } }),
  });
  const capability = await owner.finalize(input());
  const rejection = owner.read(capability);
  assert.equal(rejection.kind, "aloha.economic-safety-chain-rejection-v1");
  if (rejection.kind !== "aloha.economic-safety-chain-rejection-v1") throw new TypeError("expected economic safety rejection");
  assert.equal(validateEconomicSafetyChainRejectionV1(rejection, input(), owner.binding()).code, "quoted-gain-not-positive");
  assert.throws(() => owner.read({ ...capability }), /was not issued/);

  const semanticFault = issueEconomicSafetyFinalizationServiceV1({
    authorityRoot: h("authority"),
    implementationHash: h("implementation"),
    releaseProvenanceHash: release,
    evaluator: Object.freeze({ async evaluate(): Promise<never> { throw new TypeError("worker source/program mismatch"); } }),
  });
  await assert.rejects(() => semanticFault.finalize(input()), /worker source\/program mismatch/);
});

test("economic arithmetic, release, source, owner facts and obligations fail closed", async () => {
  const baseline = input();
  await assert.rejects(() => service().finalize({ ...baseline, releaseProvenanceHash: h("foreign") }), /release provenance/);
  await assert.rejects(() => service().finalize({ ...baseline, dryRun: false } as never), /dryRun/);
  await assert.rejects(() => service().finalize({ ...baseline, declaredObligations: [] }), /non-empty/);
  await assert.rejects(() => issueEconomicSafetyFinalizationServiceV1({
    authorityRoot: h("authority"), implementationHash: h("implementation"), releaseProvenanceHash: release,
    evaluator: { async evaluate() { return ({ ...decision(), economic: { ...decision().economic, gasCostNative: "1199" } }); } },
  }).finalize(baseline), /arithmetic/);
  await assert.rejects(() => issueEconomicSafetyFinalizationServiceV1({
    authorityRoot: h("authority"), implementationHash: h("implementation"), releaseProvenanceHash: release,
    evaluator: { async evaluate() { return ({ ...decision(), safety: { ...decision().safety, obligationReceipts: [] } }); } },
  }).finalize(baseline), /covered|coverage/);
  await assert.rejects(() => issueEconomicSafetyFinalizationServiceV1({
    authorityRoot: h("authority"), implementationHash: h("implementation"), releaseProvenanceHash: release,
    evaluator: { async evaluate() { return ({ ...decision(), safety: { ...decision().safety, requiredClaimSetRoot: h("splice") } }); } },
  }).finalize(baseline), /claim set root/);
});

test("durable evidence validation rejects jointly recomputed-looking fact substitutions", async () => {
  const owner = service();
  const baseline = input();
  const evidence = owner.read(await owner.finalize(baseline));
  if (evidence.kind !== "aloha.economic-safety-finalization-evidence-v1") throw new TypeError("expected accepted economic safety evidence");
  assert.throws(() => validateEconomicSafetyEvidenceV1({
    ...evidence,
    executionOwnerFacts: { kind: "execution-owner", gasPolicy: "guessed" },
  }, baseline), /owner facts|commitment|root/);
  assert.throws(() => validateEconomicSafetyEvidenceV1(evidence, {
    ...baseline,
    finalSimulationOwnerFacts: { kind: "final-owner", executionReceiptHash: h("other") },
  }), /owner facts/);
});

test("qualified evaluator rejects an objective absent from the release policy set before evaluating facts", async () => {
  const profitAsset = nativeAssetReferenceV1("1");
  const actionOwners = Object.freeze([Object.freeze({
    familyDefinitionHash: h("qualified-family"),
    ownerId: "owner-1",
    ownerRef: h("qualified-owner"),
    implementationHash: h("owner-implementation"),
    schemaRef: h("owner-schema"),
    implementationClosureRoot: h("owner-closure"),
    claimSchemaRefs: Object.freeze([h("owner-claim")]),
    qualificationLeafDigest: h("owner-leaf"),
    verifierHash: h("owner-verifier"),
    verify: (value: unknown) => value,
    verifyObligations: (value: unknown) => value,
  })]);
  const safetyProfile = sealSafetyProfileV1({
    profileRef: h("objective-test-profile"),
    requiredClaims: Object.freeze([Object.freeze({
      claimSchemaRef: actionOwners[0]!.claimSchemaRefs[0]!,
      ownerRef: actionOwners[0]!.ownerRef,
      qualificationLeafDigest: actionOwners[0]!.qualificationLeafDigest,
      revmObservationSchemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
    })]),
    qualifiedOwnerSetRoot: h("objective-test-qualified-owner-set"),
  });
  const evaluator = createEconomicSafetyQualifiedEvaluatorV1([Object.freeze({
    objectiveRef: h("qualified-objective"),
    profitAsset,
    profitAccount: "0x0000000000000000000000000000000000000001",
    minNetGain: "1",
    maxGas: "1000000",
    maxValueAtRisk: "1000000",
    priorityFeePerGas: "1",
    bidCostNative: "0",
    valuationOwnerRef: h("valuation-owner"),
  })], actionOwners, [Object.freeze({
    ownerRef: h("valuation-owner"),
    implementationHash: h("valuation-owner-implementation"),
    factSchemaRef: h("valuation-fact-schema"),
    implementationClosureRoot: h("valuation-closure"),
    qualificationLeafDigest: h("valuation-leaf"),
    valuationOwnerRegistryRoot: h("valuation-registry"),
    qualifiedValuationOwnerSetRoot: h("valuation-qualified-set"),
    async observeCurrentSource(): Promise<never> { throw new TypeError("unused test valuation owner"); },
  })], Object.freeze({
    executorKind: "revm",
    engineBuildFingerprint: h("engine-build"),
    executableFingerprint: h("executable"),
    qualifiedExecutorRegistryRoot: h("registry"),
    selectedExecutorLeafHash: h("executor-leaf"),
    releaseRoleManifestRoot: h("release-role-manifest"),
  }), safetyProfile);
  await assert.rejects(() => evaluator.evaluate(input()), /not release-qualified/);
});

test("qualified evaluator independently closes a real UniV2 action loop and exact-joins REVM qualification", async () => {
  const source = Object.freeze({ chainId: "1", number: "100", hash: h("qualified-block"), stateRoot: h("qualified-state") });
  const token0 = "0x1111111111111111111111111111111111111111";
  const token1 = "0x2222222222222222222222222222222222222222";
  const pool0 = "0x3333333333333333333333333333333333333333";
  const pool1 = "0x4444444444444444444444444444444444444444";
  const profitAccount = "0x5555555555555555555555555555555555555555";
  const profitAsset = erc20AssetReferenceV1(source.chainId, token0);
  const intermediateAsset = erc20AssetReferenceV1(source.chainId, token1);
  const exact = (
    direction: "token0-to-token1" | "token1-to-token0",
    inputAssetRef: Hash,
    outputAssetRef: Hash,
    amountIn: string,
    amountOut: string,
    stateFactsRoot: Hash,
  ): UniV2ExactEvaluationV1 => {
    const common = { stateFactsRoot, direction, amountIn, amountOut };
    const obligationRefs = Object.freeze([
      Object.freeze({ kind: "input" as const, ref: hashDomain("aloha/univ2-standard/obligation/input/v1", common) }),
      Object.freeze({ kind: "output" as const, ref: hashDomain("aloha/univ2-standard/obligation/output/v1", common) }),
    ]);
    return Object.freeze({
      kind: "univ2-standard.exact-evaluation",
      schemaVersion: 1,
      schemaRef: h(`exact-schema:${direction}`),
      capabilityId: `test.${direction}`,
      interpreterHash: h(`exact-interpreter:${direction}`),
      source,
      inputs: Object.freeze([Object.freeze({ assetRef: inputAssetRef, amount: amountIn })]),
      outputs: Object.freeze([Object.freeze({ assetRef: outputAssetRef, amount: amountOut })]),
      gasUpperBound: "200000",
      constraintRefs: Object.freeze([stateFactsRoot]),
      obligationRefs,
      obligationRoot: hashDomain("aloha/univ2-standard/obligation-root/v1", obligationRefs),
      stateFactsRoot,
      opaqueBytes: "0x01",
      status: "verified",
      reasonCode: null,
      evaluationHash: h(`exact-evaluation:${direction}`),
    }) as unknown as UniV2ExactEvaluationV1;
  };
  const first = UNIV2_STANDARD_SWAP_ACTION_PORT.build({
    exact: exact("token0-to-token1", profitAsset.assetRef, intermediateAsset.assetRef, "100", "200", h("pool0-state")),
    pool: pool0,
    tokenIn: token0,
    tokenOut: token1,
    direction: "token0-to-token1",
    recipient: profitAccount,
    callbackDataHex: "0x",
  });
  const second = UNIV2_STANDARD_SWAP_ACTION_PORT.build({
    exact: exact("token1-to-token0", intermediateAsset.assetRef, profitAsset.assetRef, "200", "130", h("pool1-state")),
    pool: pool1,
    tokenIn: token1,
    tokenOut: token0,
    direction: "token1-to-token0",
    recipient: profitAccount,
    callbackDataHex: "0x",
  });
  const ownerRef = h("univ2-action-owner");
  const verifierHash = h("univ2-action-verifier");
  const owner = Object.freeze({
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    ownerId: UNIV2_STANDARD_SWAP_ACTION_OWNER.ownerId,
    ownerRef,
    implementationHash: UNIV2_STANDARD_SWAP_ACTION_OWNER.implementationHash,
    schemaRef: UNIV2_STANDARD_SWAP_ACTION_OWNER.schemaHash,
    implementationClosureRoot: h("univ2-action-owner-closure"),
    claimSchemaRefs: Object.freeze([UNIV2_STANDARD_SWAP_ACTION_OWNER.schemaHash]),
    qualificationLeafDigest: h("univ2-action-owner-qualification-leaf"),
    verifierHash,
    verify: (value: unknown) => UNIV2_STANDARD_SWAP_ACTION_PORT.decode(value),
    verifyObligations: (value: unknown) => UNIV2_STANDARD_SWAP_ACTION_PORT.verifyObligations(value),
  });
  const valuationOwnerRef = h("qualified-valuation-owner");
  const valuationImplementationHash = h("qualified-valuation-implementation");
  const valuationFactSchemaRef = h("qualified-valuation-fact-schema");
  const valuationImplementationClosureRoot = h("qualified-valuation-closure");
  const valuationQualificationLeafDigest = h("qualified-valuation-leaf");
  const valuationOwnerRegistryRoot = h("qualified-valuation-registry");
  const qualifiedValuationOwnerSetRoot = h("qualified-valuation-set");
  const valuationOwner = Object.freeze({
    ownerRef: valuationOwnerRef,
    implementationHash: valuationImplementationHash,
    factSchemaRef: valuationFactSchemaRef,
    implementationClosureRoot: valuationImplementationClosureRoot,
    qualificationLeafDigest: valuationQualificationLeafDigest,
    valuationOwnerRegistryRoot,
    qualifiedValuationOwnerSetRoot,
    async observeCurrentSource(value: {
      readonly generationId: string;
      readonly source: EconomicSafetyFinalizationInputV1["source"];
      readonly asset: typeof profitAsset;
    }) {
      const body = Object.freeze({
        kind: "aloha.economic-valuation-fact-v1" as const,
        ownerRef: valuationOwnerRef,
        generationId: value.generationId,
        source: value.source,
        assetRef: value.asset.assetRef,
        numerator: "1",
        denominator: "1",
        ownerImplementationHash: valuationImplementationHash,
        valuationOwnerRegistryRoot,
        qualifiedValuationOwnerSetRoot,
        qualificationLeafDigest: valuationQualificationLeafDigest,
        currentSourceObservationRoot: hashDomain("test/economic-valuation-current-source-observation/v1", {
          generationId: value.generationId,
          source: value.source,
          assetRef: value.asset.assetRef,
        }),
      });
      return Object.freeze({ ...body, factRoot: hashDomain("aloha/economic-valuation-fact/v1", body) });
    },
  });
  const objectiveRef = h("qualified-univ2-objective");
  const qualification = Object.freeze({
    executorKind: "revm",
    engineBuildFingerprint: h("qualified-engine-build"),
    executableFingerprint: h("qualified-executable"),
    qualifiedExecutorRegistryRoot: h("qualified-registry"),
    selectedExecutorLeafHash: h("qualified-executor-leaf"),
    releaseRoleManifestRoot: h("qualified-release-role-manifest"),
  });
  const safetyProfile = sealSafetyProfileV1({
    profileRef: h("univ2-safety-profile"),
    requiredClaims: Object.freeze([Object.freeze({
      claimSchemaRef: owner.claimSchemaRefs[0]!,
      ownerRef: owner.ownerRef,
      qualificationLeafDigest: owner.qualificationLeafDigest,
      revmObservationSchemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
    })]),
    qualifiedOwnerSetRoot: h("univ2-qualified-owner-set"),
  });
  const evaluator = createEconomicSafetyQualifiedEvaluatorV1([Object.freeze({
    objectiveRef,
    profitAsset,
    profitAccount,
    minNetGain: "1",
    maxGas: "1000000",
    maxValueAtRisk: "1000",
    priorityFeePerGas: "0",
    bidCostNative: "0",
    valuationOwnerRef,
  })], [owner], [valuationOwner], qualification, safetyProfile);
  const actionFact = (action: typeof first, ordinal: number) => Object.freeze({
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    routeBindingHash: h(`route-binding:${ordinal}`),
    actionOwnerId: owner.ownerId,
    actionOwnerRef: ownerRef,
    actionHash: action.actionHash,
    actionArtifactHash: h(`action-artifact:${ordinal}`),
    exactEvaluationHash: action.exactEvaluationHash,
    payload: action,
    payloadHash: hashDomain("aloha/family-search-payload/v1", { kind: "action", payload: action }),
    inputs: action.inputs,
    outputs: action.outputs,
    obligationRoot: action.obligationRoot,
  });
  const declarations = Object.freeze([first, second].map(action => Object.freeze({
    obligationRef: action.obligationRoot,
    ownerRef,
    policy: "must-satisfy" as const,
  })));
  const runtimeObligationRoot = hashDomain("aloha/search-runtime-obligation-root/v1", declarations.map(value => value.obligationRef));
  const observationPairs = Object.freeze([
    Object.freeze({ token: token0, account: profitAccount }),
    Object.freeze({ token: token1, account: profitAccount }),
  ]);
  const effectTransport = Object.freeze({
    caller: Object.freeze({ executionMode: "top-level" }),
    preCalls: Object.freeze([]),
    observeTokenBalances: observationPairs,
    observeLogs: false,
  });
  const caller = Object.freeze({ address: profitAccount, mode: "top-level", observedSender: profitAccount, verifiedActors: Object.freeze({}) });
  const observedAccounts = Object.freeze([profitAccount]);
  const effectsBody = Object.freeze({
    accounts: Object.freeze([]),
    before: Object.freeze([]),
    gasUsed: "1",
    output: "0x",
    status: "returned",
    preCalls: Object.freeze([]),
    tokenBalancesBefore: Object.freeze([
      Object.freeze({ token: token0, account: profitAccount, balance: "1000" }),
      Object.freeze({ token: token1, account: profitAccount, balance: "0" }),
    ]),
    tokenBalancesAfter: Object.freeze([
      Object.freeze({ token: token0, account: profitAccount, balance: "1030" }),
      Object.freeze({ token: token1, account: profitAccount, balance: "0" }),
    ]),
  });
  const effects = Object.freeze({
    format: "revm-effects-v1",
    bytes: encodeCanonicalJson(effectsBody as unknown as CanonicalJson),
    observedAccounts,
    effectsHash: hashDomain("aloha/revm-effects-wire/v1", {
      format: "revm-effects-v1",
      bytes: encodeCanonicalJson(effectsBody as unknown as CanonicalJson),
      observedAccounts,
    }),
  });
  const authority = Object.freeze({ authorityRoot: h("executor-authority"), workerEpoch: "epoch-1", executorSessionHash: h("executor-session") });
  const workerBody = Object.freeze({
    requestId: h("request"),
    workerEpoch: authority.workerEpoch,
    ownerRef,
    generationId: "generation-1",
    attemptId: h("attempt"),
    authority,
    inputHash: h("worker-input"),
    deadlineAtMs: 1000,
    source,
    caller,
    observeAccounts: observedAccounts,
    programHash: h("program-wire"),
    status: "returned",
    output: "0x",
    effects,
    effectTransport,
  });
  const workerReceipt = Object.freeze({
    requestId: workerBody.requestId,
    attemptId: workerBody.attemptId,
    ownerRef: workerBody.ownerRef,
    generationId: workerBody.generationId,
    authority,
    inputHash: workerBody.inputHash,
    deadlineAtMs: workerBody.deadlineAtMs,
    authorityRoot: authority.authorityRoot,
    workerEpoch: authority.workerEpoch,
    executorSessionHash: authority.executorSessionHash,
    engine: "revm",
    engineBuildFingerprint: qualification.engineBuildFingerprint,
    caller,
    observeAccounts: observedAccounts,
    source,
    programHash: workerBody.programHash,
    status: "returned",
    output: "0x",
    effects,
    effectTransport,
    executionReceiptHash: hashDomain("aloha/revm-execution-receipt/v1", workerBody),
  });
  const executionOwnerFacts = Object.freeze({
    kind: "aloha.search-runtime.execution-program-owner-facts-v1",
    callerMode: "top-level",
    preCalls: Object.freeze([]),
    observationPairs,
    observeLogs: false,
    callSequence: Object.freeze([]),
    routeAssetReferences: Object.freeze([profitAsset, intermediateAsset]),
    actionOwners: Object.freeze([actionFact(first, 0), actionFact(second, 1)]),
    declaredObligations: declarations,
    obligationRoot: runtimeObligationRoot,
  });
  const finalSimulationOwnerFacts = Object.freeze({
    kind: "aloha.qualified-final-simulation-owner-facts-v1",
    artifactProgramHash: workerBody.programHash,
    wireProgramHash: workerBody.programHash,
    executorQualification: Object.freeze({
      engineBuildFingerprint: qualification.engineBuildFingerprint,
      executableFingerprint: qualification.executableFingerprint,
      qualifiedExecutorRegistryRoot: qualification.qualifiedExecutorRegistryRoot,
      selectedExecutorLeafHash: qualification.selectedExecutorLeafHash,
      releaseRoleManifestRoot: qualification.releaseRoleManifestRoot,
    }),
    projection: Object.freeze({
      input: Object.freeze({ block: Object.freeze({ baseFeePerGas: "0" }) }),
      caller,
      observeAccounts: observedAccounts,
      effectTransport,
    }),
    workerReceipt,
  });
  const qualifiedInput: EconomicSafetyFinalizationInputV1 = Object.freeze({
    releaseProvenanceHash: release,
    correlationId: h("qualified-correlation"),
    generationId: "generation-1",
    source,
    objectiveRef,
    exactHash: h("qualified-exact"),
    programHash: workerBody.programHash,
    obligationRoot: runtimeObligationRoot,
    finalSimulationReceiptHash: h("qualified-final-sim"),
    effectsHash: effects.effectsHash,
    executionOwnerEvidenceRoot: h("qualified-execution-owner-evidence"),
    finalSimulationOwnerEvidenceRoot: h("qualified-final-owner-evidence"),
    dryRun: true,
    executionOwnerFacts: executionOwnerFacts as unknown as CanonicalJson,
    finalSimulationOwnerFacts: finalSimulationOwnerFacts as unknown as CanonicalJson,
    declaredObligations: declarations,
  });
  const result = await evaluator.evaluate(qualifiedInput);
  assert.equal(result.economic.grossProfitAmount, "30");
  assert.equal(result.economic.netProfitNative, "30");
  assert.equal(result.safety.obligationReceipts.length, 2);
  assert.equal(result.safety.verdict, "safe");

  const alteredQualificationFacts = Object.freeze({
    ...finalSimulationOwnerFacts,
    executorQualification: Object.freeze({
      ...finalSimulationOwnerFacts.executorQualification,
      executableFingerprint: h("foreign-executable"),
    }),
  });
  await assert.rejects(() => evaluator.evaluate({
    ...qualifiedInput,
    finalSimulationOwnerFacts: alteredQualificationFacts as unknown as CanonicalJson,
  }), /executor qualification/);
  await assert.rejects(() => evaluator.evaluate({
    ...qualifiedInput,
    finalSimulationOwnerFacts: {
      ...finalSimulationOwnerFacts,
      workerReceipt: { ...workerReceipt, engineBuildFingerprint: h("foreign-engine") },
    } as unknown as CanonicalJson,
  }), /qualified REVM engine/);
  assert.throws(() => createEconomicSafetyQualifiedEvaluatorV1(
    [Object.freeze({
      objectiveRef,
      profitAsset,
      profitAccount,
      minNetGain: "1",
      maxGas: "1000000",
      maxValueAtRisk: "1000",
      priorityFeePerGas: "0",
      bidCostNative: "0",
      valuationOwnerRef,
    })],
    [Object.freeze({ ...owner, verifyObligations: undefined as never })],
    [valuationOwner],
    qualification,
    safetyProfile,
  ), /verifyObligations/);

  const alteredEffectsBody = Object.freeze({
    ...effectsBody,
    tokenBalancesAfter: Object.freeze([
      Object.freeze({ token: token0, account: profitAccount, balance: "1031" }),
      Object.freeze({ token: token1, account: profitAccount, balance: "0" }),
    ]),
  });
  const alteredEffectsBytes = encodeCanonicalJson(alteredEffectsBody as unknown as CanonicalJson);
  const alteredEffects = Object.freeze({
    ...effects,
    bytes: alteredEffectsBytes,
    effectsHash: hashDomain("aloha/revm-effects-wire/v1", {
      format: effects.format,
      bytes: alteredEffectsBytes,
      observedAccounts,
    }),
  });
  const alteredWorkerBody = Object.freeze({ ...workerBody, effects: alteredEffects });
  const alteredWorkerReceipt = Object.freeze({
    ...workerReceipt,
    effects: alteredEffects,
    executionReceiptHash: hashDomain("aloha/revm-execution-receipt/v1", alteredWorkerBody),
  });
  await assert.rejects(() => evaluator.evaluate({
    ...qualifiedInput,
    effectsHash: alteredEffects.effectsHash,
    finalSimulationOwnerFacts: {
      ...finalSimulationOwnerFacts,
      workerReceipt: alteredWorkerReceipt,
    } as unknown as CanonicalJson,
  }), /quoted gain/);
  await assert.rejects(() => evaluator.evaluate({
    ...qualifiedInput,
    finalSimulationOwnerFacts: {
      ...finalSimulationOwnerFacts,
      workerReceipt: { ...workerReceipt, executionReceiptHash: h("spliced-execution-receipt") },
    } as unknown as CanonicalJson,
  }), /execution receipt hash/);
});

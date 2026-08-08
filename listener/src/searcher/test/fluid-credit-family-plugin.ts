import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  definedFamilyPluginContractSummary,
  type UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
  ObservedEffects,
} from "../venues/adapter-request-program.js";
import { hashCanonical } from "../venues/canonical-value.js";
import { fluidCreditStrictFamilyPlugin } from
  "../venues/credit/fluid-family-plugin.js";
import {
  FLUID_CREDIT_PROBE_ACTOR,
  FLUID_ERC20_INTERFACE,
  FLUID_VAULT_FACTORY_INTERFACE,
  FLUID_VAULT_INTERFACE,
  FLUID_VAULT_OPERATE_SELECTOR,
  fluidDebtAmount,
} from "../venues/credit/fluid-family/codec.js";
import {
  FLUID_CREDIT_ADDRESS_SURFACE_PATTERN_ID,
  FLUID_CREDIT_OPERATE_CALL_PATTERN_ID,
} from "../venues/credit/fluid-family/discovery.js";
import { FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID } from
  "../venues/credit/fluid-family/identity.js";
import type {
  FluidCreditCandidate,
  FluidCreditIdentity,
  FluidCreditIdentityEvidence,
} from "../venues/credit/fluid-family/types.js";

const VAULT = ethers.getAddress("0x1111111111111111111111111111111111111111");
const OTHER_VAULT = ethers.getAddress(
  "0x1212121212121212121212121212121212121212",
);
const LIQUIDITY = ethers.getAddress(
  "0x2020202020202020202020202020202020202020",
);
const FACTORY = ethers.getAddress("0x2222222222222222222222222222222222222222");
const SUPPLY_TOKEN = ethers.getAddress(
  "0x3333333333333333333333333333333333333333",
);
const BORROW_TOKEN = ethers.getAddress(
  "0x4444444444444444444444444444444444444444",
);
const EXECUTOR = ethers.getAddress(
  "0x5555555555555555555555555555555555555555",
);
const VAULT_ID = 17n;
const SUPPLY_DECIMALS = 18;
const BORROW_DECIMALS = 6;
const IDENTITY_COLLATERAL = 1_000n * 10n ** 18n;
const IDENTITY_DEBT = 10n ** 6n;
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_002,
  hash: `0x${"cd".repeat(32)}`,
  generation: 11,
});
const FOREIGN_SOURCE: CanonicalSource = Object.freeze({
  number: SOURCE.number,
  hash: `0x${"de".repeat(32)}`,
  generation: SOURCE.generation,
});
const PROVENANCE = Object.freeze({
  kind: "fixture",
  fingerprint: "fluid-credit-v1",
});

const callObservation: UnifiedObservation = Object.freeze({
  kind: "call",
  source: SOURCE,
  target: VAULT,
  sender: EXECUTOR,
  data: FLUID_VAULT_INTERFACE.encodeFunctionData("operate", [
    0n,
    IDENTITY_COLLATERAL,
    IDENTITY_DEBT,
    EXECUTOR,
  ]),
});
assert.equal(
  callObservation.data.slice(0, 10).toLowerCase(),
  FLUID_VAULT_OPERATE_SELECTOR,
);
const callCandidate = fluidCreditStrictFamilyPlugin.discovery.decodeCandidate({
  observation: callObservation,
  matchedPatternId: FLUID_CREDIT_OPERATE_CALL_PATTERN_ID,
});
assert(callCandidate !== null);
assert.equal(callCandidate.vault, VAULT);
assert.equal(callCandidate.sourceKind, "operate-call");

const addressCandidate = fluidCreditStrictFamilyPlugin.discovery.decodeCandidate({
  observation: Object.freeze({
    kind: "address-surface" as const,
    source: SOURCE,
    address: VAULT,
    codeHash: `0x${"12".repeat(32)}`,
    implementationWord: ethers.ZeroHash,
    interfaceFingerprints: ["fluid-credit:constantsView+operate"],
  }),
  matchedPatternId: FLUID_CREDIT_ADDRESS_SURFACE_PATTERN_ID,
});
assert(addressCandidate !== null);
assert.equal(addressCandidate.sourceKind, "address-surface");

const identity = runIdentity(callCandidate, VAULT);
assert.equal(identity.facts.factoryBinding.reverseVault, VAULT);
assert.equal(identity.facts.supplyToken, SUPPLY_TOKEN);
assert.equal(identity.facts.borrowToken, BORROW_TOKEN);
assert.equal(identity.facts.supplyDecimals, SUPPLY_DECIMALS);
assert.equal(identity.facts.borrowDecimals, BORROW_DECIMALS);
assert.equal(identity.facts.activeProbeActor, FLUID_CREDIT_PROBE_ACTOR);

const forgedReverse = runThroughReverse(callCandidate, OTHER_VAULT);
assert.deepEqual(
  fluidCreditStrictFamilyPlugin.identity.variants[0].decide({
    candidate: callCandidate,
    evidence: forgedReverse,
    step: 2,
  }),
  { status: "rejected", reason: "factory_reverse_binding_failed" },
);

const validReverse = runThroughReverse(callCandidate, VAULT);
const inactive = decodeActiveBehavior(callCandidate, validReverse, {
  tokenDeltas: [{
    token: SUPPLY_TOKEN,
    account: FLUID_CREDIT_PROBE_ACTOR,
    delta: -IDENTITY_COLLATERAL,
  }],
});
assert.deepEqual(
  fluidCreditStrictFamilyPlugin.identity.variants[0].decide({
    candidate: callCandidate,
    evidence: inactive,
    step: 3,
  }),
  { status: "rejected", reason: "nonzero_operate_effect_proof_failed" },
  "a missing borrow-token delta cannot prove active credit behavior",
);
assert.throws(
  () => fluidCreditStrictFamilyPlugin.identity.variants[0].decode({
    step: { candidate: callCandidate, step: 0 },
    results: [{
      id: "vault-constants",
      ok: false,
      source: SOURCE,
      failure: "rpc",
    }],
  }),
  /unresolved: rpc/,
  "transport failure stays unresolved rather than becoming rejection proof",
);

const draft = fluidCreditStrictFamilyPlugin.instance.compileDraft(identity);
const descriptor = fluidCreditStrictFamilyPlugin.instance.finalizeDescriptor({
  identity,
  draft,
  sharedBindings: [],
});
const routes = fluidCreditStrictFamilyPlugin.routes.project({ descriptor });
assert.equal(routes.length, 1);
const route = routes[0];
assert.equal(route.tokenIn, SUPPLY_TOKEN);
assert.equal(route.tokenOut, BORROW_TOKEN);
assert.equal(route.lifecycle, "standing-position");
assert.equal(route.taxonomy.slotKind, "lend");
assert.equal(
  fluidCreditStrictFamilyPlugin.credit.position.lifecycle,
  "standing-position",
);
assert.equal(
  fluidCreditStrictFamilyPlugin.credit.position.finalSafety,
  "position-and-repayment-required",
);
assert.equal(
  fluidCreditStrictFamilyPlugin.credit.risk.blocksPrefixInversion,
  true,
);
assert.match(
  fluidCreditStrictFamilyPlugin.credit.position.positionKey({
    descriptor,
    route,
  }),
  /^[0-9a-f]{64}$/,
);

const staticFingerprint = hashCanonical(
  fluidCreditStrictFamilyPlugin.instance.staticBindingProjection(descriptor),
);
assert.notEqual(
  staticFingerprint,
  hashCanonical(fluidCreditStrictFamilyPlugin.instance.staticBindingProjection({
    ...descriptor,
    factoryBinding: {
      ...descriptor.factoryBinding,
      vaultId: descriptor.factoryBinding.vaultId + 1n,
    },
  })),
  "Factory reverse binding participates in descriptor invalidation",
);

const collateralAmount = 2_000n * 10n ** 18n;
const debtBps = 8_500n;
const debtAmount = collateralAmount * debtBps / 10_000n / 10n ** 12n;
assert.equal(
  fluidDebtAmount({
    collateralAmount,
    debtBps,
    supplyDecimals: SUPPLY_DECIMALS,
    borrowDecimals: BORROW_DECIMALS,
  }),
  debtAmount,
  "18-to-6 decimal scaling preserves the legacy /1e12 debt formula",
);

const riskProgram = fluidCreditStrictFamilyPlugin.credit.risk.evidence;
assert(riskProgram !== undefined);
const riskInput = Object.freeze({
  descriptor,
  route,
  collateralAmount,
  debtBps,
  source: SOURCE,
  executor: EXECUTOR,
  runtimeEvidence: Object.freeze([]),
});
assert.deepEqual(riskProgram.requirements(riskInput), {
  transports: ["effect-delta-simulation"],
  caller: "executor",
  effects: ["return-data", "token-delta"],
});
const riskRequests = riskProgram.buildRequests(riskInput);
assert.equal(riskRequests.length, 1);
const riskRequest = riskRequests[0];
assert.equal(riskRequest.kind, "effect-delta-simulation");
if (riskRequest.kind !== "effect-delta-simulation") {
  throw new Error("fluid-credit risk request kind");
}
assert.deepEqual(riskRequest.call.caller, { kind: "executor" });
assert.equal(riskRequest.call.to, VAULT);
assert.equal(riskRequest.preCalls?.length, 1);
assert.deepEqual(riskRequest.preCalls?.[0]?.caller, { kind: "executor" });
assert.equal(riskRequest.preCalls?.[0]?.to, SUPPLY_TOKEN);
const riskApproveArgs = FLUID_ERC20_INTERFACE.decodeFunctionData(
  "approve",
  riskRequest.preCalls![0].data,
);
assert.equal(riskApproveArgs[0], VAULT);
assert.equal(riskApproveArgs[1], collateralAmount);
assert.deepEqual(riskRequest.overrideIntent.caller, { kind: "executor" });
assert.deepEqual(riskRequest.overrideIntent.tokenBalances, [{
  token: SUPPLY_TOKEN,
  amount: collateralAmount,
}]);
assert.deepEqual(riskRequest.observe, ["return-data", "token-delta"]);
const operateArgs = FLUID_VAULT_INTERFACE.decodeFunctionData(
  "operate",
  riskRequest.call.data,
);
assert.equal(operateArgs[0], 0n);
assert.equal(operateArgs[1], collateralAmount);
assert.equal(operateArgs[2], debtAmount);
assert.equal(operateArgs[3], EXECUTOR);

const riskEvidence = riskProgram.decode({
  programInput: riskInput,
  results: [operateSuccess({
    id: "risk-operate-effect-proof",
    actor: EXECUTOR,
    collateralAmount,
    debtAmount,
  })],
});
assert.equal(riskEvidence.source.hash, SOURCE.hash);
assert.equal(riskEvidence.executor, EXECUTOR);
assert.equal(riskEvidence.collateralAmount, collateralAmount);
assert.equal(riskEvidence.debtAmount, debtAmount);
assert.equal(
  fluidCreditStrictFamilyPlugin.credit.risk.quoteOutputByDebtBps({
    descriptor,
    route,
    collateralAmount,
    debtBps,
    evidence: riskEvidence,
  }),
  debtAmount,
);
assert.throws(
  () => riskProgram.decode({
    programInput: riskInput,
    results: [operateSuccess({
      id: "risk-operate-effect-proof",
      actor: EXECUTOR,
      collateralAmount,
      debtAmount,
      source: FOREIGN_SOURCE,
    })],
  }),
  /foreign source/,
  "risk evidence is bound to the requested source",
);
assert.throws(
  () => riskProgram.decode({
    programInput: riskInput,
    results: [success(
      "risk-operate-effect-proof",
      encodedOperateResult(9n, collateralAmount, debtAmount),
      {
        tokenDeltas: [{
          token: SUPPLY_TOKEN,
          account: EXECUTOR,
          delta: -collateralAmount,
        }],
      },
    )],
  }),
  /did not prove standing position effects/,
  "missing debt-token effects fail closed",
);
assert.throws(
  () => riskProgram.decode({
    programInput: riskInput,
    results: [{
      id: "risk-operate-effect-proof",
      ok: false,
      source: SOURCE,
      failure: "deadline",
    }],
  }),
  /unresolved: deadline/,
  "risk transport failure remains unresolved",
);

const fragment = fluidCreditStrictFamilyPlugin.execution.buildFragment({
  descriptor,
  route,
  amountIn: collateralAmount,
  quotedAmountOut: debtAmount,
  minAmountOut: debtAmount,
  exactEvidence: riskEvidence,
  executor: EXECUTOR,
  runtimeEvidence: [],
});
assert.equal(fragment.requirements[0]?.kind, "approve");
assert.equal(fragment.nodes[0]?.adapterId, "fluid-vault");
assert.equal(fragment.nodes[0]?.params.nftId, 0n);
assert.equal(fragment.nodes[0]?.params.collateralDelta, collateralAmount);
assert.equal(fragment.nodes[0]?.params.debtDelta, debtAmount);
assert.throws(
  () => fluidCreditStrictFamilyPlugin.execution.buildFragment({
    descriptor,
    route,
    amountIn: collateralAmount,
    quotedAmountOut: debtAmount,
    minAmountOut: debtAmount,
    exactEvidence: {
      ...riskEvidence,
      executor: OTHER_VAULT,
    },
    executor: EXECUTOR,
    runtimeEvidence: [],
  }),
  /incompatible risk evidence/,
  "execution rejects evidence for another executor",
);
assert.throws(
  () => fluidCreditStrictFamilyPlugin.credit.risk.quoteOutputByDebtBps({
    descriptor,
    route,
    collateralAmount,
    debtBps,
    evidence: {
      ...riskEvidence,
      collateralAmount: collateralAmount + 1n,
    },
  }),
  /incompatible evidence/,
  "risk sizing rejects evidence for another amount",
);

const summary = definedFamilyPluginContractSummary(
  fluidCreditStrictFamilyPlugin,
);
assert.equal(summary.domain, "credit");
assert.deepEqual(summary.suppliedActionAdapterIds, [
  "fluid-dex-liquidate",
  "fluid-vault",
]);
assert(!("pricing" in fluidCreditStrictFamilyPlugin));
assert(!("exact" in fluidCreditStrictFamilyPlugin));
assert.equal(fluidCreditStrictFamilyPlugin.actionAdapters.length, 2);
for (const action of fluidCreditStrictFamilyPlugin.actionAdapters) {
  assert.equal(action.descriptor.edgeKind, "credit");
  assert.equal(action.descriptor.leavesStandingPositionDefault, true);
}

console.log("fluid-credit-family-plugin PASS");

function runIdentity(
  candidate: FluidCreditCandidate,
  reverseVault: string,
): FluidCreditIdentity {
  const reverse = runThroughReverse(candidate, reverseVault);
  const active = decodeActiveBehavior(candidate, reverse, {
    tokenDeltas: [
      {
        token: SUPPLY_TOKEN,
        account: FLUID_CREDIT_PROBE_ACTOR,
        delta: -IDENTITY_COLLATERAL,
      },
      {
        token: BORROW_TOKEN,
        account: FLUID_CREDIT_PROBE_ACTOR,
        delta: IDENTITY_DEBT,
      },
    ],
  });
  const decision = fluidCreditStrictFamilyPlugin.identity.variants[0].decide({
    candidate,
    evidence: active,
    step: 3,
  });
  assert.equal(decision.status, "verified");
  if (decision.status !== "verified") throw new Error("identity not verified");
  return decision.identity;
}

function runThroughReverse(
  candidate: FluidCreditCandidate,
  reverseVault: string,
): Extract<FluidCreditIdentityEvidence, { readonly phase: "reverse-binding" }> {
  const variant = fluidCreditStrictFamilyPlugin.identity.variants[0];
  const constants = variant.decode({
    step: { candidate, step: 0 },
    results: [
      success("vault-constants", encodedConstants()),
      success("vault-code", "0x6000"),
    ],
  }) as FluidCreditIdentityEvidence;
  assert.equal(constants.phase, "constants");
  assert.deepEqual(variant.decide({ candidate, evidence: constants, step: 1 }), {
    status: "continue",
  });
  const reverse = variant.decode({
    step: { candidate, evidence: constants, step: 1 },
    results: [
      success(
        "factory-reverse-vault",
        FLUID_VAULT_FACTORY_INTERFACE.encodeFunctionResult(
          "getVaultAddress",
          [reverseVault],
        ),
      ),
      success("supply-token-code", "0x6001"),
      success("borrow-token-code", "0x6002"),
    ],
  }) as FluidCreditIdentityEvidence;
  if (reverse.phase !== "reverse-binding") {
    throw new Error("reverse binding was not decoded");
  }
  return reverse;
}

function decodeActiveBehavior(
  candidate: FluidCreditCandidate,
  reverse: Extract<
    FluidCreditIdentityEvidence,
    { readonly phase: "reverse-binding" }
  >,
  effects: ObservedEffects,
): Extract<FluidCreditIdentityEvidence, { readonly phase: "active-behavior" }> {
  const variant = fluidCreditStrictFamilyPlugin.identity.variants[0];
  assert.deepEqual(variant.decide({ candidate, evidence: reverse, step: 2 }), {
    status: "continue",
  });
  const requests = variant.buildRequests({
    candidate,
    evidence: reverse,
    step: 2,
  });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.kind, "effect-delta-simulation");
  if (request.kind !== "effect-delta-simulation") {
    throw new Error("fluid-credit active proof request kind");
  }
  assert.deepEqual(request.call.caller, {
    kind: "verified-actor",
    evidenceId: FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID,
  });
  assert.equal(request.call.to, VAULT);
  assert.equal(request.preCalls?.length, 1);
  const approve = request.preCalls![0];
  assert.deepEqual(approve.caller, {
    kind: "verified-actor",
    evidenceId: FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID,
  });
  assert.equal(approve.to, SUPPLY_TOKEN);
  const approveArgs = FLUID_ERC20_INTERFACE.decodeFunctionData(
    "approve",
    approve.data,
  );
  assert.equal(approveArgs[0], VAULT);
  assert.equal(approveArgs[1], IDENTITY_COLLATERAL);
  assert.deepEqual(request.observe, ["return-data", "token-delta"]);
  const evidence = variant.decode({
    step: { candidate, evidence: reverse, step: 2 },
    results: [success(
      "active-operate-effect-proof",
      encodedOperateResult(7n, IDENTITY_COLLATERAL, IDENTITY_DEBT),
      effects,
    )],
  }) as FluidCreditIdentityEvidence;
  if (evidence.phase !== "active-behavior") {
    throw new Error("active behavior was not decoded");
  }
  return evidence;
}

function encodedConstants(): string {
  return FLUID_VAULT_INTERFACE.encodeFunctionResult("constantsView", [[
    LIQUIDITY,
    FACTORY,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    SUPPLY_TOKEN,
    BORROW_TOKEN,
    SUPPLY_DECIMALS,
    BORROW_DECIMALS,
    VAULT_ID,
    ethers.ZeroHash,
    ethers.ZeroHash,
    ethers.ZeroHash,
    ethers.ZeroHash,
  ]]);
}

function encodedOperateResult(
  nftId: bigint,
  finalSupply: bigint,
  finalBorrow: bigint,
): string {
  return FLUID_VAULT_INTERFACE.encodeFunctionResult("operate", [
    nftId,
    finalSupply,
    finalBorrow,
  ]);
}

function operateSuccess(input: {
  readonly id: string;
  readonly actor: string;
  readonly collateralAmount: bigint;
  readonly debtAmount: bigint;
  readonly source?: CanonicalSource;
}): AdapterRequestResult {
  return success(
    input.id,
    encodedOperateResult(9n, input.collateralAmount, input.debtAmount),
    {
      tokenDeltas: [
        {
          token: SUPPLY_TOKEN,
          account: input.actor,
          delta: -input.collateralAmount,
        },
        {
          token: BORROW_TOKEN,
          account: input.actor,
          delta: input.debtAmount,
        },
      ],
    },
    input.source,
  );
}

function success(
  id: string,
  data: string,
  effects?: ObservedEffects,
  source: CanonicalSource = SOURCE,
): AdapterRequestResult {
  const base = {
    id,
    ok: true as const,
    source,
    provenance: PROVENANCE,
    completion: "returned" as const,
    data,
  };
  return effects === undefined
    ? Object.freeze(base)
    : Object.freeze({ ...base, effects: Object.freeze(effects) });
}

import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  createBoundedRequestExecutor,
  FamilyDecodeError,
  runRequestProgram,
  type AdapterRequestResult,
  type CanonicalSource,
  type ObservedEffects,
} from "../venues/adapter-request-program.js";
import { RequiredAdapterRequestError } from
  "../venues/adapter-request-failure.js";
import {
  ERC4626_ERC20_INTERFACE,
  ERC4626_INTERFACE,
  ERC4626_PROBE_ACTOR,
} from "../venues/protocols/erc4626-family/abi.js";
import { erc4626Identity } from
  "../venues/protocols/erc4626-family/identity.js";
import { erc4626Instance } from "../venues/protocols/erc4626-family/instance.js";
import { erc4626Routes } from "../venues/protocols/erc4626-family/routes.js";
import { erc4626Exact } from "../venues/protocols/erc4626-family/exact.js";
import type {
  Erc4626ActiveEvidence,
  Erc4626BaseEvidence,
  Erc4626Candidate,
} from "../venues/protocols/erc4626-family/types.js";

const VAULT = ethers.getAddress("0x1111111111111111111111111111111111111111");
const ASSET = ethers.getAddress("0x2222222222222222222222222222222222222222");
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_778_225,
  hash: `0x${"ab".repeat(32)}`,
  generation: 25_778_225,
});
const PROVENANCE = Object.freeze({
  kind: "fixture",
  fingerprint: "erc4626-direction-v1",
});
const CANDIDATE: Erc4626Candidate = Object.freeze({
  candidateKind: "erc4626-vault",
  vault: VAULT,
});
const BASE: Erc4626BaseEvidence = Object.freeze({
  phase: "base",
  vault: VAULT,
  vaultCodeHash: ethers.keccak256("0x6001"),
  asset: ASSET,
  assetCodeHash: ethers.keccak256("0x6002"),
  totalAssets: 2_000n,
  totalSupply: 1_000n,
  sampleAssets: 1_000n,
  sampleShares: 500n,
  previewDeposit: 500n,
  previewRedeem: 1_000n,
  baseValid: true,
});
const variant = erc4626Identity.variants[0]!;
const activeStep = Object.freeze({
  candidate: CANDIDATE,
  evidence: BASE,
  step: 1,
});

const requests = variant.buildRequests(activeStep);
assert.equal(
  requests.find((request) => request.id === "active-deposit")?.required,
  false,
);
assert.equal(
  requests.find((request) => request.id === "active-redeem")?.required,
  false,
);
for (const id of ["active-deposit", "active-redeem"]) {
  const request = requests.find((request) => request.id === id);
  assert(request?.kind === "effect-delta-simulation");
  const account = { kind: "verified-actor", evidenceId: "erc4626-probe-actor" };
  assert.deepEqual(request.observeTokenBalances, [
    { token: ASSET, account },
    { token: VAULT, account },
  ], `${id} must explicitly observe both input debit and output receipt`);
  assert.deepEqual(request.overrideIntent.tokenBalances, [{
    token: id === "active-deposit" ? ASSET : VAULT,
    amount: id === "active-deposit" ? BASE.sampleAssets : BASE.sampleShares,
  }], "observing output must not fund the output token");
}
for (const delta of [0n, 999n]) {
  const effects = redeemEffects();
  const negative = decodeActive(reverted("active-deposit", "0x"), redeemSuccess({
    ...effects,
    tokenDeltas: effects.tokenDeltas!.map(row => row.token === ASSET ? { ...row, delta } : row),
  }));
  assert.equal(negative.redeemVerified, false, "return/event alone cannot replace actual full receipt");
}
const assetBalanceRequest = requests.find((request) =>
  request.id === "active-asset-balance"
);
assert.equal(assetBalanceRequest?.kind, "eth-call");
if (assetBalanceRequest?.kind !== "eth-call") {
  throw new Error("active asset balance request is not an eth-call");
}
assert.equal(assetBalanceRequest.completion, "return-or-revert-data");
assert.equal(
  assetBalanceRequest.required,
  false,
);
const shareBalanceRequest = requests.find((request) =>
  request.id === "active-share-balance"
);
assert.equal(shareBalanceRequest?.kind, "eth-call");
if (shareBalanceRequest?.kind !== "eth-call") {
  throw new Error("active share balance request is not an eth-call");
}
assert.equal(shareBalanceRequest.completion, "return-or-revert-data");
assert.equal(
  shareBalanceRequest.required,
  false,
);

const depositOnly = decodeActive(
  depositSuccess(),
  failure("active-redeem", "resource-limited"),
);
assert.deepEqual(
  verifiedDirections(depositOnly),
  { deposit: true, redeem: false },
  "a resource-limited redeem probe cannot discard a proven deposit route",
);

const redeemOnly = decodeActive(
  failure("active-deposit", "deadline"),
  redeemSuccess(),
);
assert.deepEqual(
  verifiedDirections(redeemOnly),
  { deposit: false, redeem: true },
  "a resource-limited deposit probe cannot discard a proven redeem route",
);

assert.throws(
  () => decodeActive(
    failure("active-deposit", "resource-limited"),
    failure("active-redeem", "rpc"),
  ),
  (error: unknown) =>
    error instanceof RequiredAdapterRequestError &&
    error.failureCode === "resource-limited",
  "two unresolved directions remain retryable with the original failure class",
);

const behaviorFailed = decodeActive(
  depositSuccess(Object.freeze({})),
  redeemSuccess(Object.freeze({})),
);
assert.deepEqual(
  variant.decide({ candidate: CANDIDATE, evidence: behaviorFailed, step: 2 }),
  { status: "chain-proven-rejected", reasonCode: "erc4626_execution_surfaces_failed", evidenceRequestIds: ["active-deposit", "active-redeem"] },
  "only two completed negative behavior probes are chain-proven rejection",
);

const malformedAssetSurface = decodeResults([
  ...commonActiveResults().map((result) =>
    result.id === "active-asset-balance"
      ? success("active-asset-balance", `0x${"00".repeat(64)}`)
      : result.id === "active-share-balance"
      ? failure("active-share-balance", "rpc")
      : result
  ),
  failure("active-deposit", "resource-limited"),
  failure("active-redeem", "rpc"),
]);
assert.deepEqual(
  variant.decide({
    candidate: CANDIDATE,
    evidence: malformedAssetSurface,
    step: 2,
  }),
  { status: "chain-proven-rejected", reasonCode: "erc4626_erc20_surfaces_failed", evidenceRequestIds: ["base-asset"] },
  "malformed ERC20 balance data is chain-proven rejection, not retryable simulation",
);

const revertedShareSurface = decodeResults([
  ...commonActiveResults().map((result) =>
    result.id === "active-share-balance"
      ? reverted("active-share-balance", "0x")
      : result
  ),
  failure("active-deposit", "resource-limited"),
  failure("active-redeem", "rpc"),
]);
assert.deepEqual(
  variant.decide({
    candidate: CANDIDATE,
    evidence: revertedShareSurface,
    step: 2,
  }),
  { status: "chain-proven-rejected", reasonCode: "erc4626_erc20_surfaces_failed", evidenceRequestIds: ["base-asset"] },
  "declared ERC20 balance revert is chain-proven rejection",
);

assert.throws(
  () => decodeResults([
    ...commonActiveResults().map((result) =>
      result.id === "active-share-balance"
        ? failure("active-share-balance", "deadline")
        : result
    ),
    depositSuccess(),
    redeemSuccess(),
  ]),
  (error: unknown) =>
    error instanceof RequiredAdapterRequestError &&
    error.failureCode === "deadline",
  "an unresolved balance surface remains retryable when no sibling proves rejection",
);

assert.throws(
  () => variant.decode({
    step: activeStep,
    results: [
      failure("active-asset-code", "rpc"),
      ...commonActiveResults().slice(1),
      depositSuccess(),
      redeemSuccess(),
    ],
  }),
  (error: unknown) =>
    error instanceof RequiredAdapterRequestError && error.failureCode === "rpc",
  "shared active evidence remains required",
);

// Base already queries more than one amount. Preserve the next viable preview
// instead of treating the first preview as proof of execution at that amount.
const baseStep = { candidate: CANDIDATE, evidence: undefined, step: 0 };
const decodedBase = variant.decode({ step: baseStep, results: variant.buildRequests(baseStep).map(request => {
  if (request.kind === "get-code") return success(request.id, "0x6001");
  assert(request.kind === "eth-call");
  const call = ERC4626_INTERFACE.parseTransaction({ data: request.data })!;
  const value = call.name === "asset" ? ASSET
    : call.name === "totalAssets" || call.name === "totalSupply" ? 10n ** 22n
    : call.name === "convertToShares" || call.name === "previewDeposit" ? BigInt(call.args[0]) / 2n
    : BigInt(call.args[0]) * 2n;
  return success(request.id, ERC4626_INTERFACE.encodeFunctionResult(call.name, [value]));
}) }) as Erc4626BaseEvidence;
assert.equal(decodedBase.sampleAssets, 10n ** 6n);
assert.deepEqual(decodedBase.alternateDepositSample, { amount: 10n ** 18n, preview: 5n * 10n ** 17n });

const retryBase = { ...BASE, alternateDepositSample: { amount: 2_000n, preview: 1_000n } };
const retryInitial = (deposit: AdapterRequestResult, redeem = redeemSuccess()) => variant.decode({
  step: { candidate: CANDIDATE, evidence: retryBase, step: 1 },
  results: [...commonActiveResults(), deposit, redeem],
}) as Erc4626ActiveEvidence;
const needsRetry = retryInitial(reverted("active-deposit", "0x12345678"));
assert.deepEqual(variant.decide({ candidate: CANDIDATE, evidence: needsRetry, step: 2 }), { status: "continue" });
assert.deepEqual(needsRetry.depositRetry, { amount: 2_000n, preview: 1_000n, source: SOURCE });
const retryStep = { candidate: CANDIDATE, evidence: needsRetry, step: 2 };
const retryRequests = variant.buildRequests(retryStep);
assert.deepEqual(retryRequests.map(r => r.id), ["fallback-roundtrip", "fallback-deposit"]);
assert(retryRequests.every(r => !requests.some(old => old.id === r.id)), "retry must not repeat a request id");
const retryDeposit = retryRequests.find(r => r.id === "fallback-deposit")!;
assert(retryDeposit.kind === "effect-delta-simulation");
assert.equal(ERC4626_INTERFACE.decodeFunctionData("deposit", retryDeposit.call.data)[0], 2_000n);
assert.equal(ERC4626_ERC20_INTERFACE.decodeFunctionData("approve", retryDeposit.preCalls![0]!.data)[1], 2_000n);
assert.deepEqual(retryDeposit.overrideIntent.tokenBalances, [{ token: ASSET, amount: 2_000n }]);
assert.equal(retryDeposit.observeTokenBalances?.length, 2);
const fallbackRoundTrip = success("fallback-roundtrip", ERC4626_INTERFACE.encodeFunctionResult("previewRedeem", [2_000n]));
const fallbackSuccess = success("fallback-deposit", ERC4626_INTERFACE.encodeFunctionResult("deposit", [1_000n]), depositEffects(2_000n, 1_000n));
const fallbackDecode = (deposit: AdapterRequestResult, roundTrip = fallbackRoundTrip, previous = needsRetry) => variant.decode({
  step: { candidate: CANDIDATE, evidence: previous, step: 2 }, results: [roundTrip, deposit],
}) as Erc4626ActiveEvidence;
const retryPassed = fallbackDecode(fallbackSuccess);
assert.deepEqual(verifiedDirections(retryPassed), { deposit: true, redeem: true });
assert.equal(retryPassed.depositRetry, undefined);
assert.equal(retryPassed.alternateDepositSample, undefined);
assert.equal(retryPassed.depositRetryCompleted, true);
assert.notEqual(retryPassed.behaviorProofHash, needsRetry.behaviorProofHash, "prior failure and retry must be bound");
for (const deposit of [depositSuccess(), depositSuccess({}), failure("active-deposit", "rpc")]) {
  assert.equal(retryInitial(deposit).depositRetry, undefined, "success, bad effects and transport failure do not trigger amount retry");
}
assert.throws(() => retryInitial(reverted("active-deposit", "0x"), failure("active-redeem", "deadline")),
  (error: unknown) => error instanceof RequiredAdapterRequestError && error.failureCode === "deadline",
  "fallback must not hide an unresolved sibling when neither direction is proven");
for (const failed of [reverted("fallback-deposit", "0x"), failure("fallback-deposit", "rpc"),
  success("fallback-deposit", ERC4626_INTERFACE.encodeFunctionResult("deposit", [1_000n]), {})]) {
  assert.deepEqual(verifiedDirections(fallbackDecode(failed)), { deposit: false, redeem: true });
}
for (const badEffects of [
  { ...depositEffects(2_000n, 1_000n), tokenDeltas: depositEffects(2_000n, 1_000n).tokenDeltas!.map(row => row.token === ASSET ? { ...row, delta: 0n } : row) },
  { ...depositEffects(2_000n, 1_000n), tokenDeltas: depositEffects(2_000n, 1_000n).tokenDeltas!.map(row => row.token === VAULT ? { ...row, delta: 999n } : row) },
  { ...depositEffects(2_000n, 1_000n), totalSupplyDeltas: [] },
  { ...depositEffects(2_000n, 1_000n), logs: [] },
]) {
  assert.equal(fallbackDecode(success("fallback-deposit", ERC4626_INTERFACE.encodeFunctionResult("deposit", [1_000n]), badEffects)).depositVerified, false);
}
assert.equal(fallbackDecode(fallbackSuccess, success("fallback-roundtrip", ERC4626_INTERFACE.encodeFunctionResult("previewRedeem", [3_000n]))).depositVerified, false);
assert.throws(() => fallbackDecode({ ...fallbackSuccess, source: { ...SOURCE, hash: `0x${"cd".repeat(32)}` } }), /source/i);
const neitherBeforeRetry = retryInitial(reverted("active-deposit", "0x"), reverted("active-redeem", "0x"));
assert.throws(() => fallbackDecode(failure("fallback-deposit", "rpc"), fallbackRoundTrip, neitherBeforeRetry),
  (error: unknown) => error instanceof RequiredAdapterRequestError && error.failureCode === "rpc");
const neitherAfterRetry = fallbackDecode(reverted("fallback-deposit", "0x"), fallbackRoundTrip, neitherBeforeRetry);
assert.equal(variant.decide({ candidate: CANDIDATE, evidence: neitherAfterRetry, step: 3 }).status, "chain-proven-rejected");

const fullyVerified = variant.decide({
  candidate: CANDIDATE, evidence: decodeActive(depositSuccess(), redeemSuccess()), step: 2,
});
assert.equal(fullyVerified.status, "verified");
if (fullyVerified.status !== "verified") throw new Error("fixture identity not verified");
const descriptor = erc4626Instance.compileDraft(fullyVerified.identity);
const quoteRoutes = erc4626Routes.project({ descriptor });
assert.equal(quoteRoutes.length, 2);
for (const route of quoteRoutes) {
  for (const amountIn of [17n, 2_479_563n, 1_234_567_890_123_456_789n]) {
    const input = { descriptor, route, amountIn, source: SOURCE,
      executor: ERC4626_PROBE_ACTOR, runtimeEvidence: [] };
    const method = erc4626Exact.methods().find(m => m.kind === "request-program");
    assert(method?.kind === "request-program");
    assert.equal(method.chainAmountQuote, true);
    const calls = method.program.buildRequests(input);
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.kind, "eth-call");
    if (call.kind !== "eth-call") throw new Error("unexpected transport");
    const fn = route.direction === "deposit" ? "previewDeposit" : "previewRedeem";
    assert.equal(BigInt(ERC4626_INTERFACE.decodeFunctionData(fn, call.data)[0]), amountIn,
      "explicit raw amount must not be replaced by oneAsset / oneShare");
  }
}
// Register after the raw Family checks above: registration installs the same
// active-proof guards used in production, so raw decode alone is insufficient.
const { plugin: erc4626FamilyPlugin } = await import(
  "../venues/production-families/erc4626.production.js"
);
const registeredVariant = erc4626FamilyPlugin.identity.variants[0]!;
let registeredDecodeCalls = 0;

for (const malformed of [null, "deposit", "roundtrip"] as const) {
const registeredRetry = await runRequestProgram({
  familyId: erc4626FamilyPlugin.manifest.familyId,
  source: SOURCE, programInput: retryStep,
  program: {
    requirements: step => registeredVariant.requirements(step),
    buildRequests: step => registeredVariant.buildRequests(step),
    decode: ({ programInput, results }) => registeredVariant.decode({ step: programInput, results }) as Erc4626ActiveEvidence,
  },
  executor: createBoundedRequestExecutor({
    assertSupported(requirements) { assert(requirements.transports.includes("effect-delta-simulation")); },
    assertCallerBinding({ callerRef }) { assert.deepEqual(callerRef, { kind: "verified-actor", evidenceId: "erc4626-probe-actor" }); },
    assertWithinBudget(_familyId, actualRequests) { assert.deepEqual(actualRequests, retryRequests); },
    async execute() { return [
      malformed === "roundtrip" ? success("fallback-roundtrip", "0x") : fallbackRoundTrip,
      malformed === "deposit" ? success("fallback-deposit", "0x", depositEffects(2_000n, 1_000n)) : fallbackSuccess,
    ]; },
    sealStaticEvidenceReuseProof() { throw new Error("retry remains an active proof"); },
  }),
});
assert.deepEqual(verifiedDirections(registeredRetry.evidence), { deposit: malformed === null, redeem: true });
assert.equal(registeredRetry.trustedResults.length, 2);
}
assert.throws(() => fallbackDecode(success("fallback-deposit", "0x"), fallbackRoundTrip, neitherBeforeRetry));
assert.throws(() => fallbackDecode(fallbackSuccess, success("fallback-roundtrip", "0x"), neitherBeforeRetry));

const registeredDepositOnly = await runRegisteredActiveProgram([
  ...commonActiveResults(),
  depositSuccess(),
  failure("active-redeem", "deadline"),
]);
assert.deepEqual(
  verifiedDirections(registeredDepositOnly.evidence),
  { deposit: true, redeem: false },
  "registered central execution must retain only the independently proven deposit direction",
);
assert.equal(registeredDepositOnly.trustedResults.length, requests.length);
assert.equal(registeredDepositOnly.reuseProof, undefined);

const registeredRedeemOnly = await runRegisteredActiveProgram([
  ...commonActiveResults(),
  failure("active-deposit", "deadline"),
  redeemSuccess(),
]);
assert.deepEqual(
  verifiedDirections(registeredRedeemOnly.evidence),
  { deposit: false, redeem: true },
  "registered central execution must retain only the independently proven redeem direction",
);

await assert.rejects(
  runRegisteredActiveProgram([
    ...commonActiveResults(),
    failure("active-deposit", "resource-limited"),
    failure("active-redeem", "deadline"),
  ]),
  (error: unknown) => error instanceof FamilyDecodeError &&
    error.uncertainty === "transport" &&
    /required adapter request active-deposit failed: resource-limited/.test(error.message),
  "two unresolved directions remain retryable and cannot produce verified evidence",
);

const decodeCallsBeforeRequiredFailure = registeredDecodeCalls;
await assert.rejects(
  runRegisteredActiveProgram([
    failure("active-asset-code", "rpc"),
    ...commonActiveResults().slice(1),
    depositSuccess(),
    redeemSuccess(),
  ]),
  (error: unknown) => error instanceof RequiredAdapterRequestError &&
    error.failureCode === "rpc",
);
assert.equal(
  registeredDecodeCalls,
  decodeCallsBeforeRequiredFailure,
  "the central required-request gate must reject before invoking Family decode",
);

const completeActiveResults = [
  ...commonActiveResults(), depositSuccess(), redeemSuccess(),
];
const malformedResultSets: readonly {
  readonly results: readonly AdapterRequestResult[];
  readonly error: RegExp;
}[] = [
  {
    results: completeActiveResults.slice(0, -1),
    error: /omitted result id: active-redeem/,
  },
  {
    results: [...completeActiveResults, depositSuccess()],
    error: /duplicate result id: active-deposit/,
  },
  {
    results: [...completeActiveResults, failure("unknown-request", "deadline")],
    error: /unknown result id: unknown-request/,
  },
  {
    results: completeActiveResults.map((result) => result.id === "active-redeem"
      ? { ...result, source: { ...SOURCE, hash: `0x${"cd".repeat(32)}` } }
      : result),
    error: /source mismatch for active-redeem/,
  },
];
for (const malformed of malformedResultSets) {
  const beforeDecode = registeredDecodeCalls;
  await assert.rejects(runRegisteredActiveProgram(malformed.results), malformed.error);
  assert.equal(registeredDecodeCalls, beforeDecode,
    "optional failures must not weaken central result-set validation");
}

await import("./erc4626-deposit-lifecycle.js");
console.log("erc4626-family-plugin PASS (raw + registered direction-isolated proof, required failures, exact amount)");

async function runRegisteredActiveProgram(
  results: readonly AdapterRequestResult[],
) {
  return runRequestProgram({
    familyId: erc4626FamilyPlugin.manifest.familyId,
    source: SOURCE,
    programInput: activeStep,
    program: {
      requirements: (step: typeof activeStep) => registeredVariant.requirements(step),
      buildRequests: (step: typeof activeStep) => registeredVariant.buildRequests(step),
      decode: ({ programInput, results }) => {
        registeredDecodeCalls++;
        return registeredVariant.decode({
          step: programInput,
          results,
        }) as Erc4626ActiveEvidence;
      },
    },
    executor: createBoundedRequestExecutor({
      assertSupported(requirements) {
        assert(requirements.transports.includes("effect-delta-simulation"));
      },
      assertCallerBinding({ callerRef }) {
        assert.deepEqual(callerRef, {
          kind: "verified-actor",
          evidenceId: "erc4626-probe-actor",
        });
      },
      assertWithinBudget(familyId, actualRequests) {
        assert.equal(familyId, erc4626FamilyPlugin.manifest.familyId);
        assert.deepEqual(actualRequests, requests);
      },
      async execute() {
        return results;
      },
      sealStaticEvidenceReuseProof() {
        throw new Error("active behavior proof must not enter the static cache");
      },
    }),
  });
}

function decodeActive(
  deposit: AdapterRequestResult,
  redeem: AdapterRequestResult,
): Erc4626ActiveEvidence {
  return decodeResults([...commonActiveResults(), deposit, redeem]);
}

function decodeResults(
  results: readonly AdapterRequestResult[],
): Erc4626ActiveEvidence {
  return variant.decode({
    step: activeStep,
    results,
  }) as Erc4626ActiveEvidence;
}

function verifiedDirections(evidence: Erc4626ActiveEvidence): {
  readonly deposit: boolean;
  readonly redeem: boolean;
} {
  const decision = variant.decide({
    candidate: CANDIDATE,
    evidence,
    step: 2,
  });
  assert.equal(decision.status, "verified");
  if (decision.status !== "verified") throw new Error("identity was not verified");
  return decision.identity.verifiedDirections;
}

function commonActiveResults(): readonly AdapterRequestResult[] {
  return Object.freeze([
    success("active-asset-code", "0x6002"),
    success(
      "active-asset-balance",
      ERC4626_ERC20_INTERFACE.encodeFunctionResult("balanceOf", [0n]),
    ),
    success(
      "active-share-balance",
      ERC4626_ERC20_INTERFACE.encodeFunctionResult("balanceOf", [0n]),
    ),
    success(
      "active-roundtrip",
      ERC4626_INTERFACE.encodeFunctionResult("previewRedeem", [1_000n]),
    ),
    success(
      "active-preview-redeem",
      ERC4626_INTERFACE.encodeFunctionResult("previewRedeem", [1_000n]),
    ),
  ]);
}

function depositSuccess(
  effects: ObservedEffects = depositEffects(),
): AdapterRequestResult {
  return success(
    "active-deposit",
    ERC4626_INTERFACE.encodeFunctionResult("deposit", [500n]),
    effects,
  );
}

function redeemSuccess(
  effects: ObservedEffects = redeemEffects(),
): AdapterRequestResult {
  return success(
    "active-redeem",
    ERC4626_INTERFACE.encodeFunctionResult("redeem", [1_000n]),
    effects,
  );
}

function depositEffects(assets = 1_000n, shares = 500n): ObservedEffects {
  const event = ERC4626_INTERFACE.encodeEventLog(
    ERC4626_INTERFACE.getEvent("Deposit")!,
    [ERC4626_PROBE_ACTOR, ERC4626_PROBE_ACTOR, assets, shares],
  );
  return Object.freeze({
    tokenDeltas: Object.freeze([
      Object.freeze({ token: ASSET, account: ERC4626_PROBE_ACTOR, delta: -assets }),
      Object.freeze({ token: VAULT, account: ERC4626_PROBE_ACTOR, delta: shares }),
    ]),
    totalSupplyDeltas: Object.freeze([
      Object.freeze({ token: VAULT, delta: shares }),
    ]),
    logs: Object.freeze([
      Object.freeze({ address: VAULT, topics: event.topics, data: event.data }),
    ]),
  });
}

function redeemEffects(): ObservedEffects {
  const event = ERC4626_INTERFACE.encodeEventLog(
    ERC4626_INTERFACE.getEvent("Withdraw")!,
    [
      ERC4626_PROBE_ACTOR,
      ERC4626_PROBE_ACTOR,
      ERC4626_PROBE_ACTOR,
      1_000n,
      500n,
    ],
  );
  return Object.freeze({
    tokenDeltas: Object.freeze([
      Object.freeze({ token: VAULT, account: ERC4626_PROBE_ACTOR, delta: -500n }),
      Object.freeze({ token: ASSET, account: ERC4626_PROBE_ACTOR, delta: 1_000n }),
    ]),
    totalSupplyDeltas: Object.freeze([
      Object.freeze({ token: VAULT, delta: -500n }),
    ]),
    logs: Object.freeze([
      Object.freeze({ address: VAULT, topics: event.topics, data: event.data }),
    ]),
  });
}

function success(
  id: string,
  data: string,
  effects?: ObservedEffects,
): AdapterRequestResult {
  return Object.freeze({
    id,
    ok: true as const,
    source: SOURCE,
    provenance: PROVENANCE,
    completion: "returned" as const,
    data,
    ...(effects === undefined ? {} : { effects }),
  });
}

function failure(
  id: string,
  failureCode: Extract<
    AdapterRequestResult,
    { readonly ok: false }
  >["failure"],
): AdapterRequestResult {
  return Object.freeze({
    id,
    ok: false as const,
    source: SOURCE,
    failure: failureCode,
  });
}

function reverted(id: string, data: string): AdapterRequestResult {
  return Object.freeze({
    id,
    ok: true as const,
    source: SOURCE,
    provenance: PROVENANCE,
    completion: "reverted-as-declared" as const,
    data,
  });
}

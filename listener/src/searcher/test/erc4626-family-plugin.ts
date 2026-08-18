import assert from "node:assert/strict";
import { ethers } from "ethers";
import type {
  AdapterRequestResult,
  CanonicalSource,
  ObservedEffects,
} from "../venues/adapter-request-program.js";
import { RequiredAdapterRequestError } from
  "../venues/adapter-request-program.js";
import {
  ERC4626_ERC20_INTERFACE,
  ERC4626_INTERFACE,
  ERC4626_PROBE_ACTOR,
} from "../venues/protocols/erc4626-family/abi.js";
import { erc4626Identity } from
  "../venues/protocols/erc4626-family/identity.js";
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
  { status: "rejected", reason: "erc4626_execution_surfaces_failed" },
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
  { status: "rejected", reason: "erc4626_erc20_surfaces_failed" },
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
  { status: "rejected", reason: "erc4626_erc20_surfaces_failed" },
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

console.log("erc4626-family-plugin PASS (direction-isolated active proof)");

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

function depositEffects(): ObservedEffects {
  const event = ERC4626_INTERFACE.encodeEventLog(
    ERC4626_INTERFACE.getEvent("Deposit")!,
    [ERC4626_PROBE_ACTOR, ERC4626_PROBE_ACTOR, 1_000n, 500n],
  );
  return Object.freeze({
    tokenDeltas: Object.freeze([
      Object.freeze({ token: ASSET, account: ERC4626_PROBE_ACTOR, delta: -1_000n }),
      Object.freeze({ token: VAULT, account: ERC4626_PROBE_ACTOR, delta: 500n }),
    ]),
    totalSupplyDeltas: Object.freeze([
      Object.freeze({ token: VAULT, delta: 500n }),
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

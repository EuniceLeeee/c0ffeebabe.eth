import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import {
  createProtocolTraceMemo,
  protocolObservedSourceFingerprint,
  scanObservedProtocolTrace,
  scanProtocolDiscoveryRange,
  shouldTraceForProtocolDiscovery,
} from "../observed-protocol-discovery.js";
import { createProtocolDiscoveryEvidenceCache } from "../protocol-discovery-cache.js";
import { erc4626Adapter } from "../venues/protocols/erc4626.js";
import type {
  ProtocolDiscoveryContext,
  ProtocolDiscoveryReadControl,
  ProtocolDiscoveryReceipt,
} from "../venues/route-leg-adapter.js";

const VAULT = "0x1111111111111111111111111111111111111111";
const ASSET = "0x2222222222222222222222222222222222222222";
const USER = "0x3333333333333333333333333333333333333333";
const TX_HASH = `0x${"cd".repeat(32)}`;
const ZERO_WORD = `0x${"0".repeat(64)}`;
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function redeem(uint256,address,address)",
]);
const ERC20 = new ethers.Interface(["function transfer(address,uint256)"]);
const WITHDRAW = ethers.id("Withdraw(address,address,address,uint256,uint256)").toLowerCase();
const TRANSFER = ethers.id("Transfer(address,address,uint256)").toLowerCase();

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const topicAddress = (address: string): string => ethers.zeroPadValue(address, 32).toLowerCase();
const withdrawLog = {
  address: VAULT,
  topics: [WITHDRAW, topicAddress(USER), topicAddress(USER), topicAddress(USER)],
  data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [100n, 90n]),
  transactionHash: TX_HASH,
  blockNumber: 123,
};
const transferLog = {
  address: ASSET,
  topics: [TRANSFER, topicAddress(VAULT), topicAddress(USER)],
  data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [100n]),
  transactionHash: TX_HASH,
  blockNumber: 123,
};
const shareBurnLog = {
  address: VAULT,
  topics: [TRANSFER, topicAddress(USER), ZERO_WORD],
  data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [90n]),
  transactionHash: TX_HASH,
  blockNumber: 123,
};
const receipt: ProtocolDiscoveryReceipt = {
  status: 1,
  logs: [withdrawLog, transferLog, shareBurnLog],
};

function redeemTrace(target = VAULT, includePayout = true): unknown {
  return {
    to: target,
    input: ERC4626.encodeFunctionData("redeem", [90n, USER, USER]),
    calls: includePayout
      ? [{ to: ASSET, input: ERC20.encodeFunctionData("transfer", [USER, 100n]) }]
      : [],
  };
}
const context: ProtocolDiscoveryContext = {
  blockNumber: 123,
  fromBlock: 123,
  toBlock: 123,
  graphTokens: [VAULT, ASSET],
  retainedInstances: [],
  backend: {
    async call(req) {
      if (req.to.toLowerCase() !== VAULT.toLowerCase()) throw new Error("unexpected target");
      if (req.data.slice(0, 10) === ERC4626.getFunction("asset")!.selector) {
        return ERC4626.encodeFunctionResult("asset", [ASSET]);
      }
      if (req.data.slice(0, 10) === ERC4626.getFunction("previewRedeem")!.selector) {
        const shares = BigInt(ERC4626.decodeFunctionData("previewRedeem", req.data)[0]);
        return ERC4626.encodeFunctionResult("previewRedeem", [shares * 10n / 9n]);
      }
      throw new Error("unexpected selector");
    },
    async getCode() { return "0x6000"; },
    async getStorageAt() { return ZERO_WORD; },
    async getLogs() { return []; },
    async getTransactionReceipt() { return receipt; },
    async traceTransaction() {
      return redeemTrace();
    },
  },
};

const known = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt,
  trace: redeemTrace(),
});
assert(known.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1, "known address+selector candidate");
assert(known.unknownSelectors.length === 0, "known protocol call must keep unknown diagnostics clean");

let hangingObservedMatcherCalls = 0;
const hangingObservedAdapter = {
  ...erc4626Adapter,
  id: "protocol:erc4626-hanging-observed-matcher" as const,
  discovery: {
    ...erc4626Adapter.discovery!,
    observedMatcherVersion: "erc4626-hanging-observed-v1",
    async candidateFromObservedCall() {
      hangingObservedMatcherCalls++;
      return new Promise<never>(() => {});
    },
  },
};
const familySettledObserved = await scanObservedProtocolTrace({
  adapters: [hangingObservedAdapter, erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt,
  trace: redeemTrace(),
  familyGuardOptions: { timeoutMs: 5, failureThreshold: 1 },
});
assert(
  familySettledObserved.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1,
  "timed-out observed matcher must not suppress a healthy sibling candidate",
);
assert(
  !familySettledObserved.candidatesByAdapter.has(hangingObservedAdapter.id) &&
    hangingObservedMatcherCalls === 1,
  "timed-out observed family must remain isolated",
);
assert(
  familySettledObserved.sourceErrors.some((error) =>
    error.adapterId === hangingObservedAdapter.id && error.retryable
  ),
  "timed-out observed matcher must leave its family source retryable",
);

const observedFingerprint = protocolObservedSourceFingerprint([erc4626Adapter]);
const observedAlias = {
  ...erc4626Adapter,
  id: "protocol:erc4626-observed-fingerprint-fixture" as const,
  discovery: {
    ...erc4626Adapter.discovery!,
    observedMatcherVersion: "erc4626-observed-fixture-v1",
  },
};
const addressOnlyAlias = {
  ...erc4626Adapter,
  id: "protocol:erc4626-address-fingerprint-fixture" as const,
  discovery: {
    ...erc4626Adapter.discovery!,
    candidateSources: ["dex-token-domain"] as const,
    eventTopics: [],
    callSelectors: [],
    observedMatcherVersion: undefined,
    candidateFromObservedCall: undefined,
  },
};
const observedOnlyAlias = {
  ...observedAlias,
  id: "protocol:erc4626-observed-only-fixture" as const,
  discovery: {
    ...observedAlias.discovery!,
    candidateSources: ["observed-interaction"] as const,
    candidateAddressHints: [],
    addressMatcherVersion: undefined,
    addressMatcherCachePolicy: undefined,
    candidateFromAddress: undefined,
  },
};
let cacheMatcherCalls = 0;
let cacheFingerprintReads = 0;
let currentDependencyFingerprint = `0x${"44".repeat(32)}`;
const fingerprintCachedAlias = {
  ...addressOnlyAlias,
  id: "protocol:erc4626-fingerprint-cache-fixture" as const,
  discovery: {
    ...addressOnlyAlias.discovery!,
    addressMatcherVersion: "fingerprint-cache-fixture-v1",
    addressMatcherCachePolicy: {
      kind: "current-block-dependency-fingerprint" as const,
      invariant:
        "matcher-output-immutable-while-code-implementation-and-dependencies-match" as const,
      version: "fixture-dependencies-v1",
      async currentDependencyFingerprint() {
        cacheFingerprintReads++;
        return currentDependencyFingerprint;
      },
    },
    async candidateFromAddress(candidate: {
      readonly target: string;
      readonly codeHash: string;
      readonly implementationWord: string;
    }) {
      cacheMatcherCalls++;
      return {
        pool: {
          address: candidate.target,
          adapter: "erc4626" as const,
          fixedTokenIn: ASSET,
        },
        source: "fingerprint-cache-fixture",
      };
    },
  },
};
assert(
  observedFingerprint === protocolObservedSourceFingerprint([erc4626Adapter]),
  "observed-source fingerprint must be deterministic",
);
assert(
  observedFingerprint !== protocolObservedSourceFingerprint([erc4626Adapter, observedAlias]),
  "adding an observed family must change the shared cursor fingerprint",
);
assert(
  observedFingerprint === protocolObservedSourceFingerprint([erc4626Adapter, addressOnlyAlias]),
  "an address-only matcher change must not erase the independent observed-history cursor",
);
assert(
  protocolObservedSourceFingerprint([erc4626Adapter, observedAlias]) ===
    protocolObservedSourceFingerprint([observedAlias, erc4626Adapter]),
  "observed-source fingerprint must not depend on registration order",
);

{
  const evidenceCache = createProtocolDiscoveryEvidenceCache(1);
  const addressContextAt = (blockNumber: number): ProtocolDiscoveryContext => ({
    ...context,
    blockNumber,
    fromBlock: blockNumber,
    toBlock: blockNumber,
    backend: {
      ...context.backend,
      async getLogs() { return []; },
    },
  });
  const first = await scanProtocolDiscoveryRange({
    adapters: [fingerprintCachedAlias],
    context: addressContextAt(123),
    candidateAddresses: [VAULT],
    evidenceCache,
  });
  const unchanged = await scanProtocolDiscoveryRange({
    adapters: [fingerprintCachedAlias],
    context: addressContextAt(124),
    candidateAddresses: [VAULT],
    evidenceCache,
  });
  assert(
    first.addressStats.probes === 1 &&
      unchanged.addressStats.cacheHits === 1 &&
      cacheMatcherCalls === 1 &&
      cacheFingerprintReads === 2,
    "cross-block reuse requires a family-owned fingerprint read at the current source block",
  );
  currentDependencyFingerprint = `0x${"55".repeat(32)}`;
  const changed = await scanProtocolDiscoveryRange({
    adapters: [fingerprintCachedAlias],
    context: addressContextAt(125),
    candidateAddresses: [VAULT],
    evidenceCache,
  });
  assert(
    changed.addressStats.cacheHits === 0 &&
      changed.addressStats.probes === 1 &&
      Number(cacheMatcherCalls) === 2,
    "a current-block dependency change must force the family matcher even with stable code",
  );
}

{
  const lateFamilyId = "protocol:late-address-family";
  const healthyFamilyId = "protocol:healthy-address-family";
  let lateSignal: AbortSignal | undefined;
  let lateBackendResolved = false;
  let markLateBackendStarted!: () => void;
  const lateBackendStarted = new Promise<void>((resolve) => {
    markLateBackendStarted = resolve;
  });
  let healthyStartedBeforeLateAbort = false;
  const lateAdapter = {
    ...addressOnlyAlias,
    id: "protocol:late-address-family" as const,
    discovery: {
      ...addressOnlyAlias.discovery!,
      addressMatcherVersion: "late-address-family-v1",
      async candidateFromAddress(surface: {
        readonly target: string;
        readonly codeHash: string;
        readonly implementationWord: string;
      }, matcherContext: ProtocolDiscoveryContext) {
        await matcherContext.backend.call({
          to: surface.target,
          data: "0xfeed0001",
        });
        return {
          pool: {
            address: surface.target,
            adapter: "erc4626" as const,
            fixedTokenIn: ASSET,
          },
          source: "late-address-family",
        };
      },
    },
  };
  const healthyAdapter = {
    ...addressOnlyAlias,
    id: "protocol:healthy-address-family" as const,
    discovery: {
      ...addressOnlyAlias.discovery!,
      addressMatcherVersion: "healthy-address-family-v1",
      async candidateFromAddress(surface: {
        readonly target: string;
        readonly codeHash: string;
        readonly implementationWord: string;
      }) {
        await lateBackendStarted;
        healthyStartedBeforeLateAbort = lateSignal?.aborted === false;
        return {
          pool: {
            address: surface.target,
            adapter: "erc4626" as const,
            fixedTokenIn: ASSET,
          },
          source: "healthy-address-family",
        };
      },
    },
  };
  const parent = new AbortController();
  const evidenceCache = createProtocolDiscoveryEvidenceCache(1);
  const concurrentContext: ProtocolDiscoveryContext = {
    ...context,
    backend: {
      ...context.backend,
      call(req, control) {
        if (req.data !== "0xfeed0001") {
          return context.backend.call(req, control);
        }
        lateSignal = control?.signal;
        markLateBackendStarted();
        return new Promise<string>((resolve) => {
          setTimeout(() => {
            lateBackendResolved = true;
            resolve("0x");
          }, 60);
        });
      },
      async getLogs() {
        return [];
      },
    },
  };
  const concurrent = await scanProtocolDiscoveryRange({
    adapters: [lateAdapter, healthyAdapter],
    context: concurrentContext,
    candidateAddresses: [VAULT],
    evidenceCache,
    familyGuardOptions: {
      timeoutMs: 20,
      failureThreshold: 1,
      deadlineAtMs: Date.now() + 1_000,
      signal: parent.signal,
      maxConcurrentPerFamily: 1,
    },
  });
  assert(
    healthyStartedBeforeLateAbort,
    "address matchers from sibling families must execute concurrently",
  );
  assert(
    concurrent.candidatesByAdapter.get(healthyFamilyId)?.length === 1 &&
      !concurrent.candidatesByAdapter.has(lateFamilyId),
    "a timed-out address family must not suppress its healthy sibling",
  );
  assert(lateSignal?.aborted === true, "matcher timeout must reach its backend child signal");
  assert(!parent.signal.aborted, "matcher timeout must leave the parent signal live");
  assert(
    !evidenceCache.addressEntries.has(
      `${lateFamilyId}|${VAULT.toLowerCase()}`,
    ),
    "timed-out matcher must not publish an address cache entry",
  );
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert(lateBackendResolved, "fixture backend must prove a late result arrived");
  assert(
    !evidenceCache.addressEntries.has(
      `${lateFamilyId}|${VAULT.toLowerCase()}`,
    ),
    "late matcher settlement must not mutate the evidence cache",
  );
}

const siblingPayout = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt,
  trace: {
    to: USER,
    input: "0x12345678",
    calls: [
      redeemTrace(VAULT, false),
      {
        to: USER,
        input: "0x87654321",
        calls: [{ to: ASSET, input: ERC20.encodeFunctionData("transfer", [USER, 100n]) }],
      },
    ],
  },
});
assert(
  siblingPayout.candidatesByAdapter.size === 0,
  "receipt payout must be causally nested under the matching redeem/withdraw call",
);

const ambiguous = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter, erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt,
  trace: redeemTrace(),
});
assert(
  ambiguous.candidatesByAdapter.size === 0,
  "duplicate registrations of one adapter id are invalid scanner input",
);
assert(
  ambiguous.unknownSelectors[0]?.reason === "protocol_like_flow_ambiguous_adapter",
  "ambiguous adapter match must be explicit",
);

// Cross-adapter full matches are forwarded per adapter: the coordinator owns
// the post-probe adjudication, the observed scan never drops them early.
const crossAdapter = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter, { ...erc4626Adapter, id: "protocol:erc4626-observed-alias" }],
  context,
  txHash: TX_HASH,
  receipt,
  trace: redeemTrace(),
});
assert(
  crossAdapter.candidatesByAdapter.size === 2 &&
    crossAdapter.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1 &&
    crossAdapter.candidatesByAdapter.get("protocol:erc4626-observed-alias")?.length === 1,
  "cross-adapter observed matches must all reach the coordinator",
);
assert(
  crossAdapter.unknownSelectors[0]?.reason === "protocol_like_flow_ambiguous_adapter",
  "cross-adapter observed match keeps its explicit diagnostic",
);

let logReads = 0;
let receiptReads = 0;
let traceReads = 0;
const rangeContext: ProtocolDiscoveryContext = {
  ...context,
  backend: {
    ...context.backend,
    async getLogs(req) {
      logReads++;
      assert(req.topics[0] === WITHDRAW, "shared scanner must query adapter-declared topic");
      return [withdrawLog, { ...withdrawLog }];
    },
    async getTransactionReceipt() {
      receiptReads++;
      return receipt;
    },
    async traceTransaction() {
      traceReads++;
      return redeemTrace();
    },
  },
};
const range = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: rangeContext,
});
assert(range.sourceComplete, "shared scanner source must complete");
assert(range.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1, "shared scanner dispatches ERC4626");
assert(logReads === 1, "one block window must be scanned once outside the adapter");
assert(receiptReads === 1, "duplicate event logs must share one receipt read per tx");
assert(traceReads === 1, "candidate parsing and evidence must share one trace read per tx");

{
  const parent = new AbortController();
  const deadlineAtMs = Date.now() + 1_000;
  const directControls = new Map<string, ProtocolDiscoveryReadControl | undefined>();
  let matcherControl: ProtocolDiscoveryReadControl | undefined;
  const waitForParentStop = (
    control: ProtocolDiscoveryReadControl | undefined,
  ): Promise<never> => new Promise((_resolve, reject) => {
    if (!control?.signal) {
      reject(new Error("fixture expected a propagated parent signal"));
      return;
    }
    const stop = (): void =>
      reject(control.signal!.reason ?? new Error("fixture parent stopped"));
    if (control.signal.aborted) {
      stop();
      return;
    }
    control.signal.addEventListener("abort", stop, { once: true });
  });
  const parentControlledAddressAdapter = {
    ...addressOnlyAlias,
    id: "protocol:parent-controlled-address-fixture" as const,
    discovery: {
      ...addressOnlyAlias.discovery!,
      addressMatcherVersion: "parent-controlled-address-v1",
      async candidateFromAddress(
        surface: {
          readonly target: string;
          readonly codeHash: string;
          readonly implementationWord: string;
        },
        matcherContext: ProtocolDiscoveryContext,
      ) {
        await matcherContext.backend.call({
          to: surface.target,
          data: "0xfeed0002",
        });
        return null;
      },
    },
  };
  const controlledContext: ProtocolDiscoveryContext = {
    ...context,
    backend: {
      ...context.backend,
      call(req, control) {
        if (req.data !== "0xfeed0002") {
          return context.backend.call(req, control);
        }
        matcherControl = control;
        return waitForParentStop(control);
      },
      async getCode(_address, control) {
        directControls.set("getCode", control);
        return "0x6000";
      },
      async getStorageAt(_address, _position, control) {
        directControls.set("getStorageAt", control);
        return ZERO_WORD;
      },
      async getLogs(_req, control) {
        directControls.set("getLogs", control);
        return [withdrawLog];
      },
      async getTransactionReceipt(_txHash, control) {
        directControls.set("getTransactionReceipt", control);
        return receipt;
      },
      traceTransaction(_txHash, control) {
        directControls.set("traceTransaction", control);
        return waitForParentStop(control);
      },
    },
  };
  const pending = scanProtocolDiscoveryRange({
    adapters: [erc4626Adapter, parentControlledAddressAdapter],
    context: controlledContext,
    candidateAddresses: [VAULT],
    control: { deadlineAtMs, signal: parent.signal },
  });
  const controlsReadyAt = Date.now() + 250;
  while (
    (
      directControls.size < 5 ||
      matcherControl === undefined
    ) &&
    Date.now() < controlsReadyAt
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert(
    directControls.size === 5 && matcherControl !== undefined,
    "range scanner must start every direct source read and its family matcher",
  );
  parent.abort(new Error("fixture background pass cancelled"));
  let cancellation: unknown = null;
  try {
    await pending;
  } catch (error) {
    cancellation = error;
  }
  assert(
    cancellation instanceof Error &&
      /fixture background pass cancelled/.test(cancellation.message),
    "parent cancellation must reject the range instead of becoming source-incomplete",
  );
  for (const [operation, control] of directControls) {
    assert(
      control?.deadlineAtMs === deadlineAtMs &&
        control.signal === parent.signal &&
        control.signal.aborted,
      `${operation} must receive the exact parent deadline and signal`,
    );
  }
  assert(
    matcherControl.deadlineAtMs === deadlineAtMs &&
      matcherControl.signal?.aborted === true,
    "the same parent lifetime must reach family-scoped matcher reads",
  );
}

// Acceptance 3: the live observed lane and the range scanner share one trace
// memo, so a tx observed live is never debug_traced again by the range sweep.
{
  logReads = 0;
  receiptReads = 0;
  traceReads = 0;
  const memo = createProtocolTraceMemo();
  const observedLaneTrace = await memo.trace(
    TX_HASH,
    123,
    () => rangeContext.backend.traceTransaction(TX_HASH),
  );
  assert(observedLaneTrace !== undefined && traceReads === 1, "observed lane fetches the first trace");
  const memoized = await scanProtocolDiscoveryRange({
    adapters: [erc4626Adapter],
    context: rangeContext,
    traceMemo: memo,
  });
  assert(
    memoized.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1,
    "memoized trace must still produce the observed candidate",
  );
  assert(traceReads === 1, "range scanner must reuse the observed lane trace instead of re-tracing");
  assert(memo.stats.hits === 1 && memo.stats.misses === 1, "trace memo must account one hit and one miss");

  let failingReads = 0;
  const failingFetch = () => {
    failingReads++;
    return Promise.reject(new Error("trace backend down"));
  };
  await memo.trace(`0x${"ef".repeat(32)}`, 123, failingFetch).catch(() => {});
  await memo.trace(`0x${"ef".repeat(32)}`, 123, failingFetch).catch(() => {});
  assert(failingReads === 2, "failed trace fetches must never be memoized");

  memo.prune(1_000);
  const repruned = await scanProtocolDiscoveryRange({
    adapters: [erc4626Adapter],
    context: rangeContext,
    traceMemo: memo,
  });
  assert(
    repruned.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1 && Number(traceReads) === 2,
    "expired memo entries must re-trace instead of serving stale traces",
  );
}

const splitSourceContext: ProtocolDiscoveryContext = {
  ...rangeContext,
  backend: {
    ...rangeContext.backend,
    async getCode(address) {
      if (address.toLowerCase() === ASSET.toLowerCase()) {
        throw Object.assign(new Error("local reth code read timed out"), { code: "TIMEOUT" });
      }
      return rangeContext.backend.getCode(address);
    },
  },
};
const splitSource = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: splitSourceContext,
  candidateAddresses: [ASSET],
});
assert(!splitSource.sourceComplete, "address-source timeout must keep the combined pass incomplete");
assert(!splitSource.addressSourceComplete, "address-source timeout must remain retryable");
assert(splitSource.eventSourceComplete, "independent event cursor must still be allowed to advance");
assert(
  splitSource.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1,
  "address-source failure must not discard a fully verified observed candidate",
);

{
  const addressFailure = await scanProtocolDiscoveryRange({
    adapters: [addressOnlyAlias, observedOnlyAlias],
    context: {
      ...context,
      backend: {
        ...context.backend,
        async getCode() {
          throw Object.assign(new Error("address backend unavailable"), { code: "TIMEOUT" });
        },
        async getLogs() { return []; },
      },
    },
    candidateAddresses: [ASSET],
  });
  const addressIssue = addressFailure.sourceErrors.find((error) => error.retryable);
  assert(
    addressIssue?.sourceKind === "dex-token-domain" &&
      addressIssue.impactedFamilyIds.length === 1 &&
      addressIssue.impactedFamilyIds[0] === addressOnlyAlias.id,
    "address source failure must name only dex-token-domain family owners",
  );

  const hintedOwner = {
    ...addressOnlyAlias,
    id: "protocol:hinted-code-read-owner" as const,
    discovery: {
      ...addressOnlyAlias.discovery!,
      candidateAddressHints: [USER],
    },
  };
  const unrelatedHintOwner = {
    ...addressOnlyAlias,
    id: "protocol:unrelated-hint-owner" as const,
    discovery: {
      ...addressOnlyAlias.discovery!,
      candidateAddressHints: [
        "0x4444444444444444444444444444444444444444",
      ],
    },
  };
  const hintedFailure = await scanProtocolDiscoveryRange({
    adapters: [hintedOwner, unrelatedHintOwner],
    context: {
      ...context,
      backend: {
        ...context.backend,
        async getCode() {
          throw new Error("hint code unavailable");
        },
        async getLogs() {
          return [];
        },
      },
    },
    candidateAddresses: [USER],
  });
  const hintedIssue = hintedFailure.sourceErrors.find((error) =>
    error.sourceKind === "dex-token-domain"
  );
  assert(
    hintedIssue?.impactedFamilyIds.length === 1 &&
      hintedIssue.impactedFamilyIds[0] === hintedOwner.id,
    "hint-only code-read failure must affect only the declaring family",
  );

  const observedFailure = await scanProtocolDiscoveryRange({
    adapters: [addressOnlyAlias, observedOnlyAlias],
    context: {
      ...context,
      backend: {
        ...context.backend,
        async getLogs() {
          throw Object.assign(new Error("event backend unavailable"), { code: "TIMEOUT" });
        },
      },
    },
  });
  const observedIssue = observedFailure.sourceErrors.find((error) => error.retryable);
  assert(
    observedIssue?.sourceKind === "observed-interaction" &&
      observedIssue.impactedFamilyIds.length === 1 &&
      observedIssue.impactedFamilyIds[0] === observedOnlyAlias.id,
    "event/trace source failure must name only observed-interaction family owners",
  );
}

const falseWithdrawContext: ProtocolDiscoveryContext = {
  ...context,
  backend: {
    ...context.backend,
    async call(req) {
      if (req.to.toLowerCase() === USER.toLowerCase()) {
        throw Object.assign(new Error("not an ERC4626 vault"), { code: "CALL_EXCEPTION" });
      }
      return context.backend.call(req);
    },
    async getLogs() { return [withdrawLog]; },
    async getTransactionReceipt() { return receipt; },
    async traceTransaction() {
      return redeemTrace(USER);
    },
  },
};
const falseWithdraw = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: falseWithdrawContext,
});
assert(falseWithdraw.sourceComplete, "ordinary address mismatch must not poison the scan cursor");
assert(falseWithdraw.candidatesByAdapter.size === 0, "Withdraw topic plus selector is not a full match");
assert(
  falseWithdraw.unknownSelectors[0]?.reason === "protocol_like_flow_unverified_match",
  "known selector with insufficient address/receipt evidence must not be mislabeled unknown",
);

const prunedHistoryContext: ProtocolDiscoveryContext = {
  ...rangeContext,
  backend: {
    ...rangeContext.backend,
    async traceTransaction() {
      throw Object.assign(new Error("historical state is pruned"), { code: "SERVER_ERROR" });
    },
  },
};
const prunedHistory = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: prunedHistoryContext,
});
assert(
  !prunedHistory.sourceComplete && !prunedHistory.eventSourceComplete &&
    prunedHistory.sourceErrors.some((error) =>
      error.sourceKind === "observed-interaction" &&
      error.retryable
    ),
  "pruned trace evidence must prevent the observed cursor from claiming completeness",
);
assert(
  prunedHistory.candidatesByAdapter.size === 0,
  "pruned historical trace evidence must fail closed until an archive/materialized backend is used",
);

const mixed = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt,
  trace: {
    ...(redeemTrace() as Record<string, unknown>),
    calls: [
      { to: ASSET, input: ERC20.encodeFunctionData("transfer", [USER, 100n]) },
      { to: USER, input: "0x12345678" },
    ],
  },
});
assert(mixed.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1, "known route remains admitted");
assert(
  mixed.unknownSelectors.length === 0,
  "unrelated helper calls inside a known protocol tx must not create unknown-selector noise",
);

const mintLog = {
  address: ASSET,
  topics: [TRANSFER, ZERO_WORD, topicAddress(USER)],
  data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1n]),
};
const burnLog = {
  address: ASSET,
  topics: [TRANSFER, topicAddress(USER), ZERO_WORD],
  data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1n]),
};
const protocolLike: ProtocolDiscoveryReceipt = { status: 1, logs: [mintLog, burnLog] };
const unknown = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt: protocolLike,
  trace: { to: USER, input: "0x12345678" },
});
assert(unknown.candidatesByAdapter.size === 0, "unknown selector must never produce an edge candidate");
assert(unknown.unknownSelectors.length === 1, "unknown selector must produce one diagnostic");
assert(unknown.unknownSelectors[0].recommendation === "inspect_calltrace", "diagnostic recommendation");

const sameSelectorDifferentAddress = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt: protocolLike,
  trace: {
    to: "0x4444444444444444444444444444444444444444",
    input: "0x87654321",
    calls: [
      { to: USER, input: "0x12345678", calls: [{ to: ASSET, input: "0xa9059cbb" }] },
      { to: VAULT, input: "0x12345678", calls: [{ to: ASSET, input: "0xa9059cbb" }] },
    ],
  },
});
assert(
  sameSelectorDifferentAddress.unknownSelectors.length === 2,
  "classification/dedupe key must retain address+selector rather than selector alone",
);

const lpMint = {
  address: ASSET,
  topics: [ethers.id("Mint(address,uint256,uint256)").toLowerCase()],
  data: "0x",
};
assert(
  !shouldTraceForProtocolDiscovery([mintLog, burnLog, lpMint], [erc4626Adapter]),
  "LP mint/burn flow must remain LP instead of protocol unknown",
);
const lp = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt: { status: 1, logs: [mintLog, burnLog, lpMint] },
  trace: { to: USER, input: "0x12345678" },
});
assert(lp.unknownSelectors.length === 0, "LP flow must not emit protocol unknown diagnostics");

const mixedLp = { ...lpMint, address: USER };
assert(
  shouldTraceForProtocolDiscovery([mintLog, burnLog, mixedLp], [erc4626Adapter]),
  "a separate protocol-like burn+mint must survive unrelated LP activity",
);

console.log("observed-protocol-discovery PASS");

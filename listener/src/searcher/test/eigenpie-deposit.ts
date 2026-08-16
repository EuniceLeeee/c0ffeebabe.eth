import "../../shared/adapters/index.js";

import { ethers } from "ethers";
import { get } from "../../adapters/registry.js";
import { bytesToHex } from "../../encoder.js";
import {
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  createCanonicalProtocolIdentityAttester,
  prepareProtocolDiscoveryProjection,
  runProtocolDiscovery,
} from "../protocol-instance-discovery.js";
import { buildStrategyViews } from "../strategy-views.js";
import { scanObservedProtocolTrace } from "../observed-protocol-discovery.js";
import { discoverErc20BalanceStorageSlot } from "../protocol-discovery-erc20-state.js";
import {
  IdentityResolverRegistry,
  attestPoolIdentities,
  createPoolIdentityCache,
} from "../venues/identity.js";
import { PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS } from
  "../venues/production-registry.js";
import {
  EIGENPIE_POOL_ADAPTER,
  pairInstanceId,
  probeEigenpieDepositCandidate,
  eigenpieIface,
} from "../venues/protocols/eigenpie-discovery.js";
import { eigenpieAdapter } from "../venues/protocols/eigenpie.js";
import { createStrictCentralAdapterRuntime, type StrictSimulationTransport } from "../strict-central-adapter-runtime.js";
import { PRODUCTION_STRICT_VERIFIED_ACTORS } from "../venues/production-verified-actors.js";
import type { CentralAdapterRuntime } from "../adapter-work-intent.js";
import type {
  ProtocolDiscoveryContext,
  ProtocolDiscoveryLog,
  ProtocolDiscoveryReadBackend,
} from "../venues/route-leg-adapter.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const TARGET = "0x00000000000000000000000000000000000000A1";
const TOKEN_IN = "0x00000000000000000000000000000000000000B1";
const TOKEN_OUT = "0x00000000000000000000000000000000000000C1";
const TOKEN_OUT_2 = "0x00000000000000000000000000000000000000C2";
const DEPOSITOR = "0x00000000000000000000000000000000000000D1";
const AMOUNT_IN = 1_000n;
const AMOUNT_OUT = 900n;
const TARGET_INPUT_BEFORE = 100n;
const HOLDER_OUTPUT_BEFORE = 5n;
const SUPPLY_BEFORE = 10_000n;
const BALANCE_SLOT = ethers.toBeHex(123n, 32);

const erc20 = new ethers.Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function transferFrom(address from,address to,uint256 amount) returns (bool)",
  "function mint(address to,uint256 amount)",
  "event Transfer(address indexed from,address indexed to,uint256 amount)",
]);

function transferLog(token: string, from: string, to: string, amount: bigint): ProtocolDiscoveryLog {
  const encoded = erc20.encodeEventLog(erc20.getEvent("Transfer")!, [from, to, amount]);
  return { address: token, topics: encoded.topics, data: encoded.data, blockNumber: 123 };
}

function depositLog(
  depositor = DEPOSITOR,
  tokenIn = TOKEN_IN,
  amountIn = AMOUNT_IN,
  amountOut = AMOUNT_OUT,
  isPreDeposit = false,
): ProtocolDiscoveryLog {
  const encoded = eigenpieIface.encodeEventLog(
    eigenpieIface.getEvent("AssetDeposit")!,
    [depositor, tokenIn, amountIn, ethers.ZeroAddress, amountOut, isPreDeposit],
  );
  return { address: TARGET, topics: encoded.topics, data: encoded.data, blockNumber: 123 };
}

const observedInput = eigenpieIface.encodeFunctionData("depositAsset", [
  TOKEN_IN,
  AMOUNT_IN,
  800n,
  ethers.ZeroAddress,
]);

function causalTrace(mintAmount = AMOUNT_OUT): unknown {
  return {
    from: DEPOSITOR,
    to: TARGET,
    input: observedInput,
    calls: [
      {
        from: TARGET,
        to: TOKEN_IN,
        input: erc20.encodeFunctionData("transferFrom", [DEPOSITOR, TARGET, AMOUNT_IN]),
      },
      {
        from: TARGET,
        to: TOKEN_OUT,
        input: erc20.encodeFunctionData("mint", [DEPOSITOR, mintAmount]),
      },
    ],
  };
}

function observedLogs(): ProtocolDiscoveryLog[] {
  return [
    transferLog(TOKEN_IN, DEPOSITOR, TARGET, AMOUNT_IN),
    transferLog(TOKEN_OUT, ethers.ZeroAddress, DEPOSITOR, AMOUNT_OUT),
    depositLog(),
  ];
}

function makeContext(options: { corruptSupply?: boolean } = {}): ProtocolDiscoveryContext {
  const backend: ProtocolDiscoveryReadBackend = {
    async call(req) {
      const selector = req.data.slice(0, 10).toLowerCase();
      if (selector === eigenpieIface.getFunction("getMLRTAmountToMint")!.selector) {
        const decoded = eigenpieIface.decodeFunctionData(
          "getMLRTAmountToMint",
          req.data,
        );
        const amount = BigInt(decoded[1]);
        return eigenpieIface.encodeFunctionResult("getMLRTAmountToMint", [
          amount * 9n / 10n,
          TOKEN_OUT,
        ]);
      }
      if (selector === erc20.getFunction("balanceOf")!.selector) {
        const owner = ethers.getAddress(String(erc20.decodeFunctionData("balanceOf", req.data)[0]));
        let balance = 0n;
        if (req.to.toLowerCase() === TOKEN_IN.toLowerCase() && owner.toLowerCase() === TARGET.toLowerCase()) {
          balance = TARGET_INPUT_BEFORE;
        }
        if (
          req.to.toLowerCase() === TOKEN_OUT.toLowerCase() &&
          owner.toLowerCase() === DEPOSITOR.toLowerCase()
        ) balance = HOLDER_OUTPUT_BEFORE;
        return erc20.encodeFunctionResult("balanceOf", [balance]);
      }
      if (selector === erc20.getFunction("totalSupply")!.selector) {
        return erc20.encodeFunctionResult("totalSupply", [SUPPLY_BEFORE]);
      }
      throw new Error(`unexpected call ${req.to} ${selector}`);
    },
    async getCode() { return "0x60006000"; },
    async getStorageAt() { return ethers.ZeroHash; },
    async getLogs() { return []; },
    async getTransactionReceipt() {
      return { status: 1, logs: observedLogs() };
    },
    async traceTransaction() { throw new Error("unexpected trace read"); },
    async createAccessList() {
      return [{ address: TOKEN_IN, storageKeys: [BALANCE_SLOT] }];
    },
    async simulateCalls(req) {
      if (req.calls.length === 1) {
        const stateDiff = req.stateOverrides?.[TOKEN_IN]?.stateDiff ?? {};
        const probeValue = BigInt(Object.values(stateDiff)[0] ?? "0x0");
        return [{
          status: 1,
          returnData: erc20.encodeFunctionResult("balanceOf", [probeValue]),
          logs: [],
        }];
      }
      assert(req.calls.length === 6, `active probe call count ${req.calls.length}`);
      const deposit = eigenpieIface.decodeFunctionData(
        "depositAsset",
        req.calls[1].data,
      );
      const amountIn = BigInt(deposit[1]);
      const amountOut = amountIn * 9n / 10n;
      return [
        { status: 1, returnData: erc20.encodeFunctionResult("approve", [true]), logs: [] },
        {
          status: 1,
          returnData: "0x",
          logs: [
            transferLog(TOKEN_IN, DEPOSITOR, TARGET, amountIn),
            transferLog(TOKEN_OUT, ethers.ZeroAddress, DEPOSITOR, amountOut),
            depositLog(
              DEPOSITOR,
              TOKEN_IN,
              amountIn,
              amountOut,
            ),
          ],
        },
        { status: 1, returnData: erc20.encodeFunctionResult("balanceOf", [0n]), logs: [] },
        {
          status: 1,
          returnData: erc20.encodeFunctionResult("balanceOf", [HOLDER_OUTPUT_BEFORE + amountOut]),
          logs: [],
        },
        {
          status: 1,
          returnData: erc20.encodeFunctionResult("totalSupply", [
            SUPPLY_BEFORE + amountOut + (options.corruptSupply ? 1n : 0n),
          ]),
          logs: [],
        },
        {
          status: 1,
          returnData: erc20.encodeFunctionResult("balanceOf", [TARGET_INPUT_BEFORE + amountIn]),
          logs: [],
        },
      ];
    },
  };
  return {
    backend,
    blockNumber: 123,
    fromBlock: 100,
    toBlock: 123,
    chainId: "1",
    graphTokens: [TOKEN_IN, TOKEN_OUT],
    probeExecutor: DEPOSITOR,
    retainedInstances: [],
  };
}

const matcher = eigenpieAdapter.discovery!.candidateFromObservedCall!;
const context = makeContext();
const candidate = await matcher({
  target: TARGET,
  selector: observedInput.slice(0, 10),
  input: observedInput,
  from: DEPOSITOR,
  txHash: ethers.keccak256(ethers.toUtf8Bytes("observed-deposit")),
  receipt: { status: 1, logs: observedLogs() },
  trace: causalTrace(),
}, context);
assert(candidate !== null, "receipt + causal trace must produce a candidate");
assert(candidate.pool.logicalInstanceId === pairInstanceId(TOKEN_IN, TOKEN_OUT), "pair instance id");
const ordinaryIntake = await attestPoolIdentities(context.backend, [candidate.pool], {
  // F8: production identity policy machinery is strict-only; this fixture
  // rebuilds the legacy Eigenpie seed policy locally.
  identityRegistry: new IdentityResolverRegistry(
    Object.freeze([{
      poolAdapter: EIGENPIE_POOL_ADAPTER,
      policy: "trusted-singleton-seed" as const,
    }]),
    (poolAdapter) => poolAdapter === EIGENPIE_POOL_ADAPTER,
  ),
});
assert(
  ordinaryIntake.accepted.length === 0 &&
    ordinaryIntake.rejected[0]?.reason === "untrusted_seed",
  "ordinary pool intake must not bypass observed evidence + active probe",
);
const scannerObserved = await scanObservedProtocolTrace({
  adapters: [eigenpieAdapter],
  context,
  txHash: ethers.keccak256(ethers.toUtf8Bytes("observed-deposit-through-scanner")),
  receipt: { status: 1, logs: observedLogs() },
  trace: causalTrace(),
});
const scannerCandidate = scannerObserved.candidatesByAdapter
  .get(eigenpieAdapter.id)?.[0];
assert(
  scannerCandidate?.pool.logicalInstanceId === pairInstanceId(TOKEN_IN, TOKEN_OUT),
  "shared scanner must preserve full calldata/from into the pair matcher",
);

const falseCandidate = await matcher({
  target: TARGET,
  selector: observedInput.slice(0, 10),
  input: observedInput,
  from: DEPOSITOR,
  txHash: ethers.keccak256(ethers.toUtf8Bytes("false-deposit")),
  receipt: { status: 1, logs: observedLogs() },
  trace: causalTrace(AMOUNT_OUT - 1n),
}, context);
assert(falseCandidate === null, "same selector/topic without causal exact mint must fail closed");
console.log("[eigenpie-deposit] observed behavior classification: PASS");

const eigenpieFixtureSimulator: StrictSimulationTransport = {
  async simulate({ request }) {
    if (request.kind !== "effect-delta-simulation") {
      throw new Error("eigenpie fixture simulator requires effect-delta-simulation");
    }
    const call = request.call as { readonly to: string; readonly data: string };
    const decoded = eigenpieIface.decodeFunctionData("depositAsset", call.data);
    const tokenIn = ethers.getAddress(String(decoded[0])).toLowerCase();
    const amountIn = BigInt(decoded[1]);
    const actor = DEPOSITOR.toLowerCase();
    const tokenOut = TOKEN_OUT.toLowerCase();
    const amountOut = AMOUNT_OUT;
    return {
      data: "0x",
      effects: {
        tokenDeltas: [
          { token: tokenIn, account: actor, delta: -amountIn },
          { token: tokenOut, account: actor, delta: amountOut },
        ],
        totalSupplyDeltas: [{ token: tokenOut, delta: amountOut }],
        logs: [{
          address: depositLog().address,
          topics: depositLog().topics,
          data: depositLog().data,
        }],
      },
    };
  },
};
const eigenpieIdentityRuntime: CentralAdapterRuntime =
  createStrictCentralAdapterRuntime({
    provider: context.backend as never,
    simulator: eigenpieFixtureSimulator,
    generationFence: Object.freeze({
      kind: "catalog-relative" as const,
      assertCurrent: () => undefined,
      verifyCanonicalSource: () => true,
    }),
    verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
    executor: DEPOSITOR,
  });
const candidateWithTx = {
  ...candidate,
  pool: {
    ...candidate.pool,
    ...({
      transactionHash: ethers.keccak256(ethers.toUtf8Bytes("observed-deposit")),
    } as unknown as Record<string, never>),
  } as never,
} as never;
const discoveryResult = await runProtocolDiscovery({
  adapters: [eigenpieAdapter],
  context,
  protocolEdgesEnabled: true,
  attestIdentity: createCanonicalProtocolIdentityAttester({
    identityRuntime: eigenpieIdentityRuntime,
  }),
  candidatesByAdapter: new Map([[eigenpieAdapter.id, [candidateWithTx]]]),
});
assert(discoveryResult.wouldAdmit.length === 1, "identity + active probe admission");
assert(discoveryResult.wouldAdmit[0].edges.length === 1, "one exact verified route");

const projection = prepareProtocolDiscoveryProjection({
  currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  result: discoveryResult,
  currentBackrunPools: [],
  currentBackrunGraph: [],
  currentBlockscanGraph: [],
  buildStrategyViews: (pools) => buildStrategyViews(pools, [], [], {
    blockscanMaxPools: 100,
    poolUniverseGeneratedAt: "test",
  }),
});
const projectedPool = projection.strategyViews.backrun[0];
assert(projectedPool?.verifiedRoutes?.length === 1, "projection stamps exact verified route");
const rebuilt = await eigenpieAdapter.buildEdges(projectedPool, {
  call: (req) => context.backend.call(req),
});
assert(rebuilt.length === 1 && rebuilt[0].tokenOut.toLowerCase() === TOKEN_OUT.toLowerCase(), "exact-set rebuild");
console.log("[eigenpie-deposit] identity/probe/projection: PASS");

let corruptRejected = false;
try {
  await probeEigenpieDepositCandidate(
    discoveryResult.wouldAdmit[0].instance,
    makeContext({ corruptSupply: true }),
  );
} catch {
  corruptRejected = true;
}
assert(corruptRejected, "supply delta mismatch must reject active probe");
console.log("[eigenpie-deposit] active-delta fail closed: PASS");

let slotBudgetRejected = false;
try {
  await discoverErc20BalanceStorageSlot({
    context,
    token: TOKEN_IN,
    holder: DEPOSITOR,
    codeHash: ethers.keccak256("0x6000"),
    probeValue: AMOUNT_IN,
    deadlineAtMs: 0,
  });
} catch (error) {
  slotBudgetRejected = (error as { code?: unknown }).code === "TIMEOUT";
}
assert(slotBudgetRejected, "slot discovery budget exhaustion must be retryable TIMEOUT");
let transientVerifyPropagated = false;
try {
  await discoverErc20BalanceStorageSlot({
    context: {
      ...context,
      backend: {
        ...context.backend,
        async createAccessList() {
          return [{ address: TOKEN_OUT_2, storageKeys: [BALANCE_SLOT] }];
        },
        async simulateCalls() {
          throw Object.assign(new Error("temporary RPC timeout"), { code: "TIMEOUT" });
        },
      },
    },
    token: TOKEN_OUT_2,
    holder: DEPOSITOR,
    codeHash: ethers.keccak256("0x6001"),
    probeValue: AMOUNT_IN,
  });
} catch (error) {
  transientVerifyPropagated = (error as { code?: unknown }).code === "TIMEOUT";
}
assert(
  transientVerifyPropagated,
  "access-list verification transport failures must stay retryable",
);

const retryableAccessListFailures: ReadonlyArray<{
  readonly label: string;
  readonly error: unknown;
}> = [
  ...[429, 502, 503, 504].map((status) => ({
    label: `HTTP ${status}`,
    error: Object.assign(new Error("upstream RPC failed"), { status }),
  })),
  {
    label: "undici nested cause",
    error: Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
    }),
  },
  {
    label: "nested ECONN code",
    error: Object.assign(new Error("request failed"), {
      cause: { code: "ECONNABORTED" },
    }),
  },
];
for (const [index, failure] of retryableAccessListFailures.entries()) {
  let propagated = false;
  try {
    await discoverErc20BalanceStorageSlot({
      context: {
        ...context,
        backend: {
          ...context.backend,
          async createAccessList() { throw failure.error; },
          async simulateCalls() { throw new Error("must not fall back after a retryable RPC failure"); },
        },
      },
      token: TOKEN_OUT_2,
      holder: DEPOSITOR,
      codeHash: ethers.keccak256(ethers.toUtf8Bytes(`retryable-access-list-${index}`)),
      probeValue: AMOUNT_IN,
    });
  } catch (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    propagated = code === "NETWORK_ERROR" || code === "TIMEOUT";
  }
  assert(propagated, `${failure.label} must remain retryable instead of becoming unsupported`);
}

const lateAccessListSlot = ethers.toBeHex(12n, 32);
const accessListKeys = Array.from(
  { length: 12 },
  (_, index) => ethers.toBeHex(BigInt(index + 1), 32),
);
let lateSlotAttempts = 0;
const discoveredLateSlot = await discoverErc20BalanceStorageSlot({
  context: {
    ...context,
    backend: {
      ...context.backend,
      async createAccessList() {
        return [{ address: TOKEN_OUT_2, storageKeys: accessListKeys }];
      },
      async simulateCalls(req) {
        lateSlotAttempts++;
        const stateDiff = Object.values(req.stateOverrides ?? {})[0]?.stateDiff ?? {};
        const slotKey = Object.keys(stateDiff)[0]?.toLowerCase();
        return [{
          status: 1,
          returnData: erc20.encodeFunctionResult("balanceOf", [
            slotKey === lateAccessListSlot.toLowerCase() ? AMOUNT_IN : 0n,
          ]),
          logs: [],
        }];
      },
    },
  },
  token: TOKEN_OUT_2,
  holder: DEPOSITOR,
  codeHash: ethers.keccak256(ethers.toUtf8Bytes("late-access-list-slot")),
  probeValue: AMOUNT_IN,
});
assert(discoveredLateSlot === lateAccessListSlot, "access-list key after the old first-eight cutoff must verify");
assert(lateSlotAttempts === 12, "all bounded access-list keys through the matching slot must be checked");

let oversizedAccessListRejected = false;
let oversizedAccessListSimulations = 0;
try {
  await discoverErc20BalanceStorageSlot({
    context: {
      ...context,
      backend: {
        ...context.backend,
        async createAccessList() {
          return [{
            address: TOKEN_OUT_2,
            storageKeys: Array.from(
              { length: 65 },
              (_, index) => ethers.toBeHex(BigInt(index + 1), 32),
            ),
          }];
        },
        async simulateCalls() {
          oversizedAccessListSimulations++;
          return [];
        },
      },
    },
    token: TOKEN_OUT_2,
    holder: DEPOSITOR,
    codeHash: ethers.keccak256(ethers.toUtf8Bytes("oversized-access-list")),
    probeValue: AMOUNT_IN,
  });
} catch (error) {
  const value = error as { code?: unknown; reason?: unknown; retryable?: unknown };
  oversizedAccessListRejected = value.code === "TIMEOUT" &&
    value.reason === "PROBE_BUDGET_CENSORED" &&
    value.retryable === true;
}
assert(oversizedAccessListRejected, "oversized access lists must be explicit retryable budget censorship");
assert(oversizedAccessListSimulations === 0, "oversized access lists must not be silently prefix-truncated");
console.log("[eigenpie-deposit] bounded slot discovery: PASS");

const quoted = await eigenpieAdapter.quoteExact({
  state: context.backend as never,
  target: TARGET,
  edgeAdapterId: "eigenpie-deposit-asset",
  amountIn: AMOUNT_IN,
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  edge: rebuilt[0],
});
assert(quoted === AMOUNT_OUT, "exact quote amount");
const fragment = await eigenpieAdapter.buildPlanFragment({
  edge: rebuilt[0],
  amountIn: AMOUNT_IN,
  amountOut: 850n,
  executor: DEPOSITOR,
  state: context.backend as never,
});
assert(fragment.requirements[0]?.kind === "approve", "plan requires approval");
assert(fragment.requirements[0]?.amount === AMOUNT_IN, "plan approval matches the probed exact amount");
assert(fragment.nodes[0]?.params.minAmountOut === 850n, "plan uses haircut amount as minRec");
const action = get("eigenpie-deposit-asset");
const encoded = action.encode(fragment.nodes[0], DEPOSITOR, new Uint8Array());
const calldata = bytesToHex(encoded.slice(24));
const decodedPlan = eigenpieIface.decodeFunctionData("depositAsset", calldata);
assert(BigInt(decodedPlan[1]) === AMOUNT_IN, "encoded input amount");
assert(BigInt(decodedPlan[2]) === 850n, "encoded minRec");
assert(ethers.getAddress(String(decodedPlan[3])) === ethers.ZeroAddress, "encoded zero referral");
console.log("[eigenpie-deposit] quote + plan + action encoding: PASS");

let resolverCalls = 0;
const pairRegistry = new IdentityResolverRegistry([{
  poolAdapter: EIGENPIE_POOL_ADAPTER,
  policy: "onchain-resolver",
  async resolve({ candidate: identityCandidate }) {
    resolverCalls++;
    if (identityCandidate.fixedTokenOut?.toLowerCase() !== TOKEN_OUT.toLowerCase()) {
      return { ok: false, reason: "behavior_mismatch" };
    }
    return {
      ok: true,
      adapter: EIGENPIE_POOL_ADAPTER,
      venueId: "unknown",
      identitySource: "eigenpie-compatible-call-surface",
    };
  },
}], () => true);
const sharedCache = createPoolIdentityCache();
const pairPools = [
  candidate.pool,
  {
    ...candidate.pool,
    fixedTokenOut: TOKEN_OUT_2,
    logicalInstanceId: pairInstanceId(TOKEN_IN, TOKEN_OUT_2),
  },
];
const isolated = await attestPoolIdentities(context.backend, pairPools, {
  identityRegistry: pairRegistry,
  cache: sharedCache,
  concurrency: 1,
});
assert(resolverCalls === 2, "different pairs on one target must not share identity cache");
assert(isolated.accepted.length === 1 && isolated.rejected.length === 1, "pair-scoped result isolation");
const duplicate = await attestPoolIdentities(context.backend, [candidate.pool, candidate.pool], {
  identityRegistry: pairRegistry,
  cache: createPoolIdentityCache(),
  concurrency: 2,
});
assert(Number(resolverCalls) === 3, "identical pair candidates must still share identity cache");
assert(duplicate.accepted.length === 2, "identical pair cache preserves both results");
console.log("[eigenpie-deposit] pair-scoped identity cache: PASS");

console.log("eigenpie-deposit PASS (6/6)");

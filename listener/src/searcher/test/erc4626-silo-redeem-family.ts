import { ethers } from "ethers";
import {
  createCanonicalProtocolIdentityAttester,
  runProtocolDiscovery,
} from "../protocol-instance-discovery.js";
import {
  scanObservedProtocolTrace,
  scanProtocolDiscoveryRange,
} from "../observed-protocol-discovery.js";
import {
  withProtocolDiscoveryFamilyContext,
} from "../protocol-discovery-family-guard.js";
import { POOL_REGISTRY } from "../planner/token-graph.js";
import { PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS } from "../venues/production-registry.js";
import { erc4626Adapter } from "../venues/protocols/erc4626.js";
import {
  ERC4626_SILO_PROBE_HOLDER,
  ERC4626_SILO_PROBE_RECEIVER,
  ERC4626_SILO_REDEEM_CANDIDATE_ADDRESS_HINTS,
  erc4626SiloRedeemDiscovery,
} from "../venues/protocols/erc4626-silo-redeem-discovery.js";
import { erc4626SiloRedeemAdapter } from "../venues/protocols/erc4626-silo-redeem.js";
import type {
  ProtocolConversionAdapter,
  ProtocolDiscoveryContext,
  ProtocolDiscoveryLog,
  ProtocolDiscoveryReadBackend,
} from "../venues/route-leg-adapter.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const VAULT = ethers.getAddress(ERC4626_SILO_REDEEM_CANDIDATE_ADDRESS_HINTS[0]);
const UNDERLYING = ethers.getAddress("0x1111111111111111111111111111111111111111");
const PAYOUT = ethers.getAddress("0x2222222222222222222222222222222222222222");
const PAYOUT_2 = ethers.getAddress("0x3333333333333333333333333333333333333333");
const PAYOUT_SOURCE = ethers.getAddress("0x4444444444444444444444444444444444444444");
const CODE = "0x60006000";
const ZERO_WORD = `0x${"0".repeat(64)}`;
const SLOT = ethers.toBeHex(123n, 32);
const SUPPLY = 1_000_000n * 10n ** 18n;
const SHARES = 10n ** 18n;
const ASSETS = SHARES * 5n / 4n;
const AMOUNT_OUT = ASSETS * 4n / 5n;
const SILO = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function redeem(address token,uint256 shares,address receiver,address owner) returns (uint256 amountOut)",
  "event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)",
]);
const RECEIPT = new ethers.Interface([
  "function asset() view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256 shares)",
]);
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

type SimulationMode = "valid" | "wrong-return" | "extra-payout";

function context(input: {
  readonly payoutTokens?: readonly string[];
  readonly simulationMode?: SimulationMode;
  readonly simulation?: boolean;
  readonly includeVaultInGraph?: boolean;
  readonly onActiveSimulation?: () => void;
  readonly onPayoutAssetRead?: () => void;
} = {}): ProtocolDiscoveryContext {
  const payoutTokens = (input.payoutTokens ?? [PAYOUT]).map((token) =>
    ethers.getAddress(token)
  );
  const mode = input.simulationMode ?? "valid";
  const backend: ProtocolDiscoveryReadBackend = {
    async call(req) {
      const target = ethers.getAddress(req.to);
      const selector = req.data.slice(0, 10).toLowerCase();
      if (target.toLowerCase() === VAULT.toLowerCase()) {
        if (selector === SILO.getFunction("asset")!.selector.toLowerCase()) {
          return SILO.encodeFunctionResult("asset", [UNDERLYING]);
        }
        if (selector === SILO.getFunction("totalSupply")!.selector.toLowerCase()) {
          return SILO.encodeFunctionResult("totalSupply", [SUPPLY]);
        }
        if (selector === SILO.getFunction("previewRedeem")!.selector.toLowerCase()) {
          const shares = BigInt(SILO.decodeFunctionData("previewRedeem", req.data)[0]);
          return SILO.encodeFunctionResult("previewRedeem", [shares * 5n / 4n]);
        }
        throw semanticFailure(`unsupported vault selector ${selector}`);
      }
      if (payoutTokens.some((token) => token.toLowerCase() === target.toLowerCase())) {
        if (selector === RECEIPT.getFunction("asset")!.selector.toLowerCase()) {
          input.onPayoutAssetRead?.();
          return RECEIPT.encodeFunctionResult("asset", [UNDERLYING]);
        }
        if (selector === RECEIPT.getFunction("previewWithdraw")!.selector.toLowerCase()) {
          const assets = BigInt(RECEIPT.decodeFunctionData("previewWithdraw", req.data)[0]);
          return RECEIPT.encodeFunctionResult("previewWithdraw", [assets * 4n / 5n]);
        }
        throw semanticFailure(`unsupported payout selector ${selector}`);
      }
      throw semanticFailure(`not a compatible behavior token ${target}`);
    },
    async getCode(address) {
      const normalized = ethers.getAddress(address);
      return [VAULT, UNDERLYING, ...payoutTokens].some(
        (known) => known.toLowerCase() === normalized.toLowerCase(),
      ) ? CODE : "0x";
    },
    async getStorageAt() { return ZERO_WORD; },
    async getLogs() { return []; },
    async getTransactionReceipt() { return null; },
    async traceTransaction() { throw new Error("trace not expected"); },
    async createAccessList() {
      return [{ address: VAULT, storageKeys: [SLOT] }];
    },
  };
  if (input.simulation !== false) {
    backend.simulateCalls = async (req) => {
      if (req.calls.length === 1) {
        const overridden = Object.values(
          req.stateOverrides?.[VAULT]?.stateDiff ?? {},
        )[0];
        return [{
          status: 1,
          returnData: SILO.encodeFunctionResult("balanceOf", [
            overridden === undefined ? 0n : BigInt(overridden),
          ]),
          logs: [],
        }];
      }
      assert(req.calls.length === 7, "active proof must use the bounded seven-call sequence");
      input.onActiveSimulation?.();
      const redeemCall = req.calls[3];
      const decoded = SILO.decodeFunctionData("redeem", redeemCall.data);
      const payoutToken = ethers.getAddress(String(decoded[0]));
      const shares = BigInt(decoded[1]);
      const receiver = ethers.getAddress(String(decoded[2]));
      const holder = ethers.getAddress(String(decoded[3]));
      if (
        !payoutTokens.some((token) => token.toLowerCase() === payoutToken.toLowerCase())
      ) {
        return req.calls.map(() => ({
          status: 0,
          returnData: "0x",
          logs: [],
        }));
      }
      const assets = shares * 5n / 4n;
      const amountOut = assets * 4n / 5n;
      const logs: ProtocolDiscoveryLog[] = [
        transferLog(VAULT, holder, ethers.ZeroAddress, shares),
        transferLog(payoutToken, PAYOUT_SOURCE, receiver, amountOut),
        withdrawLog(holder, receiver, holder, assets, shares),
      ];
      if (mode === "extra-payout") {
        logs.push(transferLog(UNDERLYING, PAYOUT_SOURCE, receiver, 1n));
      }
      return [
        result(SILO, "balanceOf", shares),
        result(SILO, "totalSupply", SUPPLY),
        result(RECEIPT, "balanceOf", 0n),
        {
          status: 1,
          returnData: SILO.encodeFunctionResult("redeem", [
            mode === "wrong-return" ? amountOut - 1n : amountOut,
          ]),
          logs,
        },
        result(SILO, "balanceOf", 0n),
        result(SILO, "totalSupply", SUPPLY - shares),
        result(RECEIPT, "balanceOf", amountOut),
      ];
    };
  }
  return {
    blockNumber: 1_000,
    fromBlock: 1_000,
    toBlock: 1_000,
    chainId: "1",
    graphTokens: [
      ...(input.includeVaultInGraph === false ? [] : [VAULT]),
      UNDERLYING,
      ...payoutTokens,
    ],
    retainedInstances: [],
    backend,
  };
}

function result(
  iface: ethers.Interface,
  fn: string,
  value: bigint,
) {
  return {
    status: 1,
    returnData: iface.encodeFunctionResult(fn, [value]),
    logs: [],
  };
}

function transferLog(
  token: string,
  from: string,
  to: string,
  amount: bigint,
): ProtocolDiscoveryLog {
  return {
    address: token,
    topics: [
      TRANSFER_TOPIC,
      ethers.zeroPadValue(from, 32),
      ethers.zeroPadValue(to, 32),
    ],
    data: ethers.toBeHex(amount, 32),
    blockNumber: 1_000,
  };
}

function withdrawLog(
  sender: string,
  receiver: string,
  owner: string,
  assets: bigint,
  shares: bigint,
): ProtocolDiscoveryLog {
  const encoded = SILO.encodeEventLog(
    SILO.getEvent("Withdraw")!,
    [sender, receiver, owner, assets, shares],
  );
  return {
    address: VAULT,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 1_000,
  };
}

function semanticFailure(message: string): Error {
  return Object.assign(new Error(message), { code: "CALL_EXCEPTION" });
}

async function discover(
  discoveryContext: ProtocolDiscoveryContext,
  adapter: ProtocolConversionAdapter = erc4626SiloRedeemAdapter,
) {
  const scan = await scanProtocolDiscoveryRange({
    adapters: [adapter],
    context: discoveryContext,
    candidateAddresses: [VAULT],
  });
  const result = await runProtocolDiscovery({
    adapters: [adapter],
    context: discoveryContext,
    protocolEdgesEnabled: true,
    attestIdentity: createCanonicalProtocolIdentityAttester({
      identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
    }),
    candidatesByAdapter: scan.candidatesByAdapter,
    sourceComplete: scan.sourceComplete,
    sourceErrors: scan.sourceErrors,
  });
  return { scan, result };
}

assert(
  !POOL_REGISTRY.some(
    (pool) => pool.address.toLowerCase() === VAULT.toLowerCase(),
  ),
  "legacy srUSDe static executable row must be removed",
);
assert(
  erc4626Adapter.edgeAdapterIds.every((id) => id !== "erc4626-redeem-silo") &&
    erc4626Adapter.ownedActionAdapterIds.every((id) => id !== "erc4626-redeem-silo"),
  "standard ERC4626 family must not own silo execution",
);

let standardMatcherCalls = 0;
const standardDiscovery = erc4626Adapter.discovery!;
const instrumentedStandard = {
  ...erc4626Adapter,
  discovery: {
    ...standardDiscovery,
    async candidateFromAddress(candidate, candidateContext) {
      standardMatcherCalls++;
      return standardDiscovery.candidateFromAddress!(candidate, candidateContext);
    },
  },
} satisfies ProtocolConversionAdapter;
const ownerScoped = await scanProtocolDiscoveryRange({
  adapters: [instrumentedStandard, erc4626SiloRedeemAdapter],
  context: context({ includeVaultInGraph: false }),
  candidateAddresses: [VAULT],
});
assert(
  standardMatcherCalls === 0,
  "a hint-only Strata address must not be dispatched to the standard ERC4626 matcher",
);
assert(
  ownerScoped.candidatesByAdapter.get(erc4626SiloRedeemAdapter.id)?.length === 1,
  "the Strata provenance hint must reach its owner family",
);

let payoutAssetReads = 0;
const indexedContext = context({
  onPayoutAssetRead: () => payoutAssetReads++,
});
const familyControl = {
  deadlineAtMs: Date.now() + 60_000,
  signal: new AbortController().signal,
};
const addressSurface = {
  target: VAULT,
  codeHash: ethers.keccak256(CODE),
  implementationWord: ZERO_WORD,
};
await erc4626SiloRedeemDiscovery.candidateFromAddress!(
  addressSurface,
  withProtocolDiscoveryFamilyContext(indexedContext, familyControl),
);
await erc4626SiloRedeemDiscovery.candidateFromAddress!(
  addressSurface,
  withProtocolDiscoveryFamilyContext(indexedContext, familyControl),
);
assert(
  payoutAssetReads === 1,
  "payout-token asset relation must be indexed once across live family guard wrappers",
);

const valid = await discover(context());
assert(valid.scan.sourceComplete, "valid address scan must complete");
assert(
  valid.result.wouldAdmit.length === 1,
  `valid behavior proof must admit one instance: ${JSON.stringify(valid.result.events)}`,
);
assert(
  valid.result.wouldAdmit[0].instance.pool.identitySource ===
    "erc4626-silo-redeem-behavior",
  "admission must carry the family behavior identity",
);
assert(
  valid.result.wouldAdmit[0].edges.length === 1 &&
    valid.result.wouldAdmit[0].edges[0].adapterId === "erc4626-redeem-silo" &&
    valid.result.wouldAdmit[0].edges[0].tokenIn.toLowerCase() === VAULT.toLowerCase() &&
    valid.result.wouldAdmit[0].edges[0].tokenOut.toLowerCase() === PAYOUT.toLowerCase(),
  "valid proof must emit exactly the derived share-to-payout edge",
);
const rebuilt = await erc4626SiloRedeemAdapter.buildEdges({
  ...valid.result.wouldAdmit[0].instance.pool,
  verifiedRoutes: valid.result.wouldAdmit[0].edges.map((edge) => ({
    edgeAdapterId: edge.adapterId,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    slotKind: edge.slotKind,
    protocolAction: edge.protocolAction,
  })),
}, {
  call: context().backend.call,
});
assert(
  rebuilt.length === 1 &&
    rebuilt[0].tokenOut.toLowerCase() === PAYOUT.toLowerCase(),
  "graph rebuild must preserve only the probe-verified silo route",
);

const observedReceipt = {
  status: 1,
  logs: [
    transferLog(VAULT, ERC4626_SILO_PROBE_HOLDER, ethers.ZeroAddress, SHARES),
    transferLog(PAYOUT, PAYOUT_SOURCE, ERC4626_SILO_PROBE_RECEIVER, AMOUNT_OUT),
    withdrawLog(
      ERC4626_SILO_PROBE_HOLDER,
      ERC4626_SILO_PROBE_RECEIVER,
      ERC4626_SILO_PROBE_HOLDER,
      ASSETS,
      SHARES,
    ),
  ],
};
const observedTrace = {
  from: ERC4626_SILO_PROBE_HOLDER,
  to: VAULT,
  input: SILO.encodeFunctionData("redeem", [
    PAYOUT,
    SHARES,
    ERC4626_SILO_PROBE_RECEIVER,
    ERC4626_SILO_PROBE_HOLDER,
  ]),
};
let observedActiveSimulations = 0;
const observedContext = context({
  onActiveSimulation: () => observedActiveSimulations++,
});
const observed = await scanObservedProtocolTrace({
  adapters: [erc4626SiloRedeemAdapter],
  context: observedContext,
  txHash: `0x${"12".repeat(32)}`,
  receipt: observedReceipt,
  trace: observedTrace,
});
assert(
  observed.candidatesByAdapter.get(erc4626SiloRedeemAdapter.id)?.length === 1,
  "observed exact-in call must produce candidate evidence only",
);
assert(
  observedActiveSimulations === 0,
  "observed matcher must not execute or admit the route itself",
);
const observedAdmission = await runProtocolDiscovery({
  adapters: [erc4626SiloRedeemAdapter],
  context: observedContext,
  protocolEdgesEnabled: true,
  attestIdentity: createCanonicalProtocolIdentityAttester({
    identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
  }),
  candidatesByAdapter: observed.candidatesByAdapter,
});
assert(
  observedAdmission.wouldAdmit.length === 1 &&
    observedActiveSimulations > 0,
  "observed candidate must still pass the active exact-in simulation before edge admission",
);
const observedWithoutSimulationContext = context({ simulation: false });
const observedWithoutSimulation = await scanObservedProtocolTrace({
  adapters: [erc4626SiloRedeemAdapter],
  context: observedWithoutSimulationContext,
  txHash: `0x${"34".repeat(32)}`,
  receipt: observedReceipt,
  trace: observedTrace,
});
const observedRejected = await runProtocolDiscovery({
  adapters: [erc4626SiloRedeemAdapter],
  context: observedWithoutSimulationContext,
  protocolEdgesEnabled: true,
  attestIdentity: createCanonicalProtocolIdentityAttester({
    identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
  }),
  candidatesByAdapter: observedWithoutSimulation.candidatesByAdapter,
});
assert(
  observedRejected.wouldAdmit.length === 0,
  "observed receipt/trace evidence without active simulation must fail closed",
);

const noSimulation = await discover(context({ simulation: false }));
assert(
  noSimulation.result.wouldAdmit.length === 0 &&
    noSimulation.result.events.some((event) =>
      event.stage === "probe" &&
      event.reason?.includes("state-override simulation")
    ),
  "absence of nonzero simulation must fail closed",
);

for (const simulationMode of ["wrong-return", "extra-payout"] as const) {
  const rejected = await discover(context({ simulationMode }));
  assert(
    rejected.result.wouldAdmit.length === 0,
    `${simulationMode} proof must fail closed`,
  );
}

const ambiguous = await discover(context({
  payoutTokens: [PAYOUT, PAYOUT_2],
}));
assert(
  ambiguous.result.wouldAdmit.length === 0 &&
    ambiguous.result.events.some((event) =>
      event.stage === "probe" &&
      event.reason?.includes("must be unique")
    ),
  "two independently executable payout tokens must be quarantined as ambiguous",
);

assert(
  erc4626SiloRedeemDiscovery.callSelectors.includes("0xfea53be1") &&
    erc4626SiloRedeemDiscovery.callSelectors.includes("0xdfcd412e"),
  "observed provenance must recognize exact-in and exact-out silo calls",
);
assert(
  ERC4626_SILO_PROBE_HOLDER !== ERC4626_SILO_PROBE_RECEIVER &&
    ASSETS > 0n &&
    AMOUNT_OUT === SHARES,
  "test vectors must retain a nonzero burn/payout relation",
);

console.log(
  "erc4626-silo-redeem-family PASS — owner-scoped provenance, current-block identity, " +
    "nonzero exact-in payout proof, single verified edge, and fail-closed negatives",
);

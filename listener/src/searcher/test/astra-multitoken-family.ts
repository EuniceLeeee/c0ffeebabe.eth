import "../../shared/adapters/index.js";

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { bytesToHex } from "../../encoder.js";
import { get } from "../../adapters/registry.js";
import {
  assertPureSynchronousDeriveMids,
  blockScanEdgeKey,
  createAmbientIoPoisonHarness,
  type StateReadResult,
} from "../venues/blockscan-state-capability.js";
import {
  createCanonicalProtocolIdentityAttester,
  projectVerifiedProtocolPool,
  runProtocolDiscovery,
} from "../protocol-instance-discovery.js";
import { scanObservedProtocolTrace } from "../observed-protocol-discovery.js";
import {
  PRODUCTION_ADAPTER_FAMILIES,
  PRODUCTION_FAMILY_LOAD_ISSUES,
  PRODUCTION_FAMILY_MODULES,
  PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
} from "../venues/production-registry.js";
import {
  ASTRA_MULTITOKEN_CHANGE_SELECTOR,
  ASTRA_MULTITOKEN_EDGE_ADAPTER,
  astraMultiTokenIface,
  astraMultiTokenInstanceId,
} from "../venues/protocols/astra-multitoken-discovery.js";
import { astraMultiTokenAdapter } from "../venues/protocols/astra-multitoken.js";
import type {
  ProtocolDiscoveryContext,
  ProtocolDiscoveryLog,
  ProtocolDiscoveryReadBackend,
} from "../venues/route-leg-adapter.js";

const TARGET_A = "0x00000000000000000000000000000000000000A1";
const TARGET_B = "0x00000000000000000000000000000000000000A2";
const TOKEN_A = "0x00000000000000000000000000000000000000B1";
const TOKEN_B = "0x00000000000000000000000000000000000000B2";
const TOKEN_C = "0x00000000000000000000000000000000000000B3";
const TOKEN_D = "0x00000000000000000000000000000000000000B4";
const FOREIGN_TOKEN = "0x00000000000000000000000000000000000000B5";
const CHANGER = "0x00000000000000000000000000000000000000C1";
const BALANCE_SLOT = ethers.toBeHex(19n, 32);
const TARGET_TOKENS = new Map<string, readonly string[]>([
  [TARGET_A.toLowerCase(), [TOKEN_A, TOKEN_B, TOKEN_C]],
  [TARGET_B.toLowerCase(), [TOKEN_C, TOKEN_D]],
]);

assert.deepEqual(
  PRODUCTION_FAMILY_LOAD_ISSUES,
  [],
  "Astra production entry must load without an isolated failure",
);
assert.equal(
  PRODUCTION_ADAPTER_FAMILIES.forFamily(astraMultiTokenAdapter.id),
  astraMultiTokenAdapter,
  "Astra must be active through the production registry",
);
assert(
  PRODUCTION_FAMILY_MODULES.some((module) =>
    module.sourceFile === "astra-multitoken.production.ts" &&
    module.family.id === astraMultiTokenAdapter.id
  ),
  "Astra must be discovered from its family-owned production entry",
);

const erc20Iface = new ethers.Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 amount)",
]);
const decimalsIface = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);

function quote(target: string, amountIn: bigint): bigint {
  return amountIn * (target.toLowerCase() === TARGET_A.toLowerCase() ? 2n : 3n);
}

function transferLog(
  token: string,
  from: string,
  to: string,
  amount: bigint,
): ProtocolDiscoveryLog {
  const encoded = erc20Iface.encodeEventLog(
    erc20Iface.getEvent("Transfer")!,
    [from, to, amount],
  );
  return {
    address: token,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 456,
  };
}

function changeLog(
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOut: bigint,
  changer = CHANGER,
): ProtocolDiscoveryLog {
  const encoded = astraMultiTokenIface.encodeEventLog(
    astraMultiTokenIface.getEvent("Change")!,
    [tokenIn, tokenOut, changer, amountIn, amountOut],
  );
  return {
    address: target,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 456,
  };
}

function observedCall(
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): { readonly input: string; readonly logs: readonly ProtocolDiscoveryLog[] } {
  const amountOut = quote(target, amountIn);
  return {
    input: astraMultiTokenIface.encodeFunctionData("change", [
      tokenIn,
      tokenOut,
      amountIn,
      0n,
    ]),
    logs: [
      transferLog(tokenIn, CHANGER, target, amountIn),
      transferLog(tokenOut, target, CHANGER, amountOut),
      changeLog(target, tokenIn, tokenOut, amountIn, amountOut),
    ],
  };
}

const first = observedCall(TARGET_A, TOKEN_A, TOKEN_B, 100n);
const second = observedCall(TARGET_B, TOKEN_C, TOKEN_D, 200n);
const receiptLogs = [...first.logs, ...second.logs];

const backend: ProtocolDiscoveryReadBackend = {
  async call(req) {
    const selector = req.data.slice(0, 10).toLowerCase();
    const tokens = TARGET_TOKENS.get(req.to.toLowerCase());
    if (!tokens) throw new Error(`unexpected call target ${req.to}`);
    if (
      selector ===
        astraMultiTokenIface.getFunction("supportsInterface")!.selector
          .toLowerCase()
    ) {
      return astraMultiTokenIface.encodeFunctionResult(
        "supportsInterface",
        [true],
      );
    }
    if (
      selector ===
        astraMultiTokenIface.getFunction("tokensCount")!.selector.toLowerCase()
    ) {
      return astraMultiTokenIface.encodeFunctionResult(
        "tokensCount",
        [tokens.length],
      );
    }
    if (
      selector ===
        astraMultiTokenIface.getFunction("tokens")!.selector.toLowerCase()
    ) {
      const [index] = astraMultiTokenIface.decodeFunctionData(
        "tokens",
        req.data,
      );
      return astraMultiTokenIface.encodeFunctionResult(
        "tokens",
        [tokens[Number(index)]],
      );
    }
    if (
      selector ===
        astraMultiTokenIface.getFunction("weights")!.selector.toLowerCase()
    ) {
      return astraMultiTokenIface.encodeFunctionResult("weights", [1n]);
    }
    if (
      selector ===
        astraMultiTokenIface.getFunction("changesEnabled")!.selector
          .toLowerCase()
    ) {
      return astraMultiTokenIface.encodeFunctionResult(
        "changesEnabled",
        [true],
      );
    }
    if (
      selector ===
        astraMultiTokenIface.getFunction("inLendingMode")!.selector
          .toLowerCase()
    ) {
      return astraMultiTokenIface.encodeFunctionResult(
        "inLendingMode",
        [req.to.toLowerCase() === TARGET_B.toLowerCase() ? 1n : 0n],
      );
    }
    if (
      selector ===
        astraMultiTokenIface.getFunction("changeFee")!.selector.toLowerCase()
    ) {
      return astraMultiTokenIface.encodeFunctionResult(
        "changeFee",
        [req.to.toLowerCase() === TARGET_A.toLowerCase() ? 123n : 0n],
      );
    }
    if (
      selector ===
        astraMultiTokenIface.getFunction("TOTAL_PERCRENTS")!.selector
          .toLowerCase()
    ) {
      return astraMultiTokenIface.encodeFunctionResult(
        "TOTAL_PERCRENTS",
        [1_000_000n],
      );
    }
    if (
      selector ===
        astraMultiTokenIface.getFunction("getReturn")!.selector.toLowerCase()
    ) {
      const [, , amountIn] = astraMultiTokenIface.decodeFunctionData(
        "getReturn",
        req.data,
      );
      return astraMultiTokenIface.encodeFunctionResult(
        "getReturn",
        [quote(req.to, BigInt(amountIn))],
      );
    }
    throw new Error(`unexpected Astra selector ${selector}`);
  },
  async getCode() {
    return "0x60006000";
  },
  async getStorageAt() {
    return ethers.ZeroHash;
  },
  async getLogs() {
    return [];
  },
  async getTransactionReceipt() {
    return null;
  },
  async traceTransaction() {
    throw new Error("unexpected trace read");
  },
  async createAccessList(req) {
    return [{ address: req.to, storageKeys: [BALANCE_SLOT] }];
  },
  async simulateCalls(req) {
    if (req.calls.length === 1) {
      const stateDiff = Object.values(req.stateOverrides ?? {})[0]?.stateDiff;
      const probeValue = BigInt(Object.values(stateDiff ?? {})[0] ?? "0x0");
      return [{
        status: 1,
        returnData: erc20Iface.encodeFunctionResult(
          "balanceOf",
          [probeValue],
        ),
        logs: [],
      }];
    }
    assert.equal(req.calls.length, 6, "active probe call count");
    const changeCall = req.calls[3];
    const [tokenIn, tokenOut, rawAmountIn, minAmountOut] =
      astraMultiTokenIface.decodeFunctionData("change", changeCall.data);
    const amountIn = BigInt(rawAmountIn);
    const amountOut = quote(changeCall.to, amountIn);
    assert.equal(BigInt(minAmountOut), amountOut, "active probe exact floor");
    const target = ethers.getAddress(changeCall.to);
    const caller = ethers.getAddress(changeCall.from);
    const tokenInAddress = ethers.getAddress(String(tokenIn));
    const tokenOutAddress = ethers.getAddress(String(tokenOut));
    const outputBefore = 77n;
    return [
      {
        status: 1,
        returnData: erc20Iface.encodeFunctionResult("approve", [true]),
        logs: [],
      },
      {
        status: 1,
        returnData: erc20Iface.encodeFunctionResult(
          "balanceOf",
          [amountIn],
        ),
        logs: [],
      },
      {
        status: 1,
        returnData: erc20Iface.encodeFunctionResult(
          "balanceOf",
          [outputBefore],
        ),
        logs: [],
      },
      {
        status: 1,
        returnData: astraMultiTokenIface.encodeFunctionResult(
          "change",
          [amountOut],
        ),
        logs: [
          transferLog(tokenInAddress, caller, target, amountIn),
          transferLog(tokenOutAddress, target, caller, amountOut),
          changeLog(
            target,
            tokenInAddress,
            tokenOutAddress,
            amountIn,
            amountOut,
            caller,
          ),
        ],
      },
      {
        status: 1,
        returnData: erc20Iface.encodeFunctionResult("balanceOf", [0n]),
        logs: [],
      },
      {
        status: 1,
        returnData: erc20Iface.encodeFunctionResult(
          "balanceOf",
          [outputBefore + amountOut],
        ),
        logs: [],
      },
    ];
  },
};

const context: ProtocolDiscoveryContext = {
  backend,
  blockNumber: 456,
  fromBlock: 400,
  toBlock: 456,
  chainId: "1",
  // Deliberately excludes TARGET_B's pair. Sibling protocol candidates must
  // not require one another's edges to pre-exist in this immutable pass view.
  graphTokens: [TOKEN_A],
  probeExecutor: CHANGER,
  retainedInstances: [],
};

const trace = {
  from: CHANGER,
  to: "0x00000000000000000000000000000000000000D1",
  input: "0x12345678",
  calls: [
    { from: CHANGER, to: TARGET_A, input: first.input },
    {
      from: CHANGER,
      to: "0x00000000000000000000000000000000000000D2",
      input: "0x87654321",
      calls: [{ from: CHANGER, to: TARGET_B, input: second.input }],
    },
  ],
};
const observed = await scanObservedProtocolTrace({
  adapters: [astraMultiTokenAdapter],
  context,
  txHash: ethers.keccak256(ethers.toUtf8Bytes("astra-two-instance")),
  receipt: { status: 1, logs: receiptLogs },
  trace,
});
const candidates = observed.candidatesByAdapter.get(
  astraMultiTokenAdapter.id,
) ?? [];
assert.equal(candidates.length, 2, "nested trace must nominate both targets");
assert.deepEqual(
  candidates.map((candidate) => candidate.pool.logicalInstanceId),
  [
    astraMultiTokenInstanceId(TARGET_A),
    astraMultiTokenInstanceId(TARGET_B),
  ],
  "one target must remain one dynamic Astra instance",
);

const discovery = await runProtocolDiscovery({
  adapters: [astraMultiTokenAdapter],
  context,
  protocolEdgesEnabled: true,
  attestIdentity: createCanonicalProtocolIdentityAttester({
    identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
  }),
  candidatesByAdapter: new Map([
    [astraMultiTokenAdapter.id, candidates],
  ]),
});
assert.equal(discovery.wouldAdmit.length, 2, "both sibling instances admitted");
assert.deepEqual(
  discovery.wouldAdmit.map((admission) => admission.edges.length),
  [6, 2],
  "all directed registry pairs must be materialized",
);
assert(
  discovery.wouldAdmit.flatMap((admission) => admission.edges).every(
    (edge) =>
      edge.adapterId === ASTRA_MULTITOKEN_EDGE_ADAPTER &&
      edge.edgeKind === "protocol" &&
      edge.protocolAction === "convert" &&
      !edge.leavesStandingPosition,
  ),
  "Astra edges must be standing-safe protocol conversions",
);

for (const admission of discovery.wouldAdmit) {
  const pool = projectVerifiedProtocolPool(admission);
  const rebuilt = await astraMultiTokenAdapter.buildEdges(pool, {
    call: (req) => backend.call(req),
  });
  assert.equal(
    rebuilt.length,
    admission.edges.length,
    "verified projection must rebuild the exact current registry",
  );
}

const routePinnedPool = projectVerifiedProtocolPool(
  discovery.wouldAdmit[0],
);
routePinnedPool.verifiedRoutes = routePinnedPool.verifiedRoutes!.slice(0, 1);
const routePinnedEdges = await astraMultiTokenAdapter.buildEdges(
  routePinnedPool,
  { call: (req) => backend.call(req) },
);
assert.deepEqual(
  routePinnedEdges.map((edge) => [
    edge.adapterId,
    edge.tokenIn,
    edge.tokenOut,
  ]),
  discovery.wouldAdmit[0].edges.slice(0, 1).map((edge) => [
    edge.adapterId,
    edge.tokenIn,
    edge.tokenOut,
  ]),
  "route-pinned replay must emit only its registry-revalidated verified subset",
);

await assert.rejects(
  astraMultiTokenAdapter.buildEdges(
    {
      ...routePinnedPool,
      verifiedRoutes: [{
        ...routePinnedPool.verifiedRoutes![0],
        tokenOut: FOREIGN_TOKEN,
      }],
    },
    { call: (req) => backend.call(req) },
  ),
  /routes differ from its current token registry/,
  "a route-pinned subset may not introduce a non-registry pair",
);

const selectedEdge = discovery.wouldAdmit[0].edges[0];
const amountIn = 11n;
const amountOut = await astraMultiTokenAdapter.quoteExact({
  state: backend as never,
  target: selectedEdge.target,
  edgeAdapterId: selectedEdge.adapterId,
  tokenIn: selectedEdge.tokenIn,
  tokenOut: selectedEdge.tokenOut,
  amountIn,
});
assert.equal(amountOut, 22n, "exact three-argument quote");

const sourceBlock = 456;
const sourceBlockHash = `0x${"11".repeat(32)}`;
const pricingAbort = new AbortController();
let pricingSchema = await astraMultiTokenAdapter.pricingState.compileStaticSchema({
  edges: [selectedEdge],
  deadlineAtMs: Date.now() + 10_000,
  signal: pricingAbort.signal,
});
const staticPricingReads = astraMultiTokenAdapter.pricingState
  .buildStaticSchemaReads?.({
    sourceBlock,
    sourceBlockHash,
    schema: pricingSchema,
    edges: [selectedEdge],
  }) ?? [];
pricingSchema = astraMultiTokenAdapter.pricingState.hydrateStaticSchema!(
  pricingSchema,
  staticPricingReads.map((read): StateReadResult => ({
    id: read.id,
    ok: true,
    sourceBlock,
    sourceBlockHash,
    provenance: {
      kind: "eip1898",
      source: { number: sourceBlock, hash: sourceBlockHash, generation: 1 },
      requireCanonical: true,
    },
    data: decimalsIface.encodeFunctionResult("decimals", [18]),
  })),
);
const currentPricingReads = astraMultiTokenAdapter.pricingState
  .buildCurrentBlockReads({
    sourceBlock,
    sourceBlockHash,
    schema: pricingSchema,
    edges: [selectedEdge],
  });
assert.equal(currentPricingReads.length, 1, "one exact current-block quote read");
const pricingAmountIn = BigInt(
  astraMultiTokenIface.decodeFunctionData(
    "getReturn",
    currentPricingReads[0].data,
  )[2],
);
const pricingResults: StateReadResult[] = currentPricingReads.map((read) => ({
  id: read.id,
  ok: true,
  sourceBlock,
  sourceBlockHash,
  provenance: {
    kind: "eip1898",
    source: { number: sourceBlock, hash: sourceBlockHash, generation: 1 },
    requireCanonical: true,
  },
  data: astraMultiTokenIface.encodeFunctionResult(
    "getReturn",
    [quote(read.to, pricingAmountIn)],
  ),
}));
const pricingSnapshot = astraMultiTokenAdapter.pricingState.decodeState(
  pricingSchema,
  pricingResults,
);
const pricingMids = astraMultiTokenAdapter.pricingState.deriveMids(
  pricingSnapshot,
  [selectedEdge],
);
assert.deepEqual(
  [...pricingMids.keys()],
  [blockScanEdgeKey(selectedEdge)],
  "pricing state covers the exact Astra edge",
);
assert(
  [...pricingMids.values()].every((mid) => Number.isFinite(mid.mid) && mid.mid > 0),
  "pricing state emits a positive finite mid",
);
assertPureSynchronousDeriveMids({
  capability: astraMultiTokenAdapter.pricingState,
  snapshot: pricingSnapshot,
  edges: [selectedEdge],
  harness: createAmbientIoPoisonHarness(),
});

const preparedQuote = await astraMultiTokenAdapter.prepared!.quote!({
  request: {
    adapterId: selectedEdge.adapterId,
    target: selectedEdge.target,
    tokenIn: selectedEdge.tokenIn,
    tokenOut: selectedEdge.tokenOut,
    amountIn,
  },
  edge: selectedEdge,
  async callPrepared(to, data) {
    return {
      output: await backend.call({ to, data }),
      latencyMs: 4,
      cacheStats: { warmHits: 1, coldMisses: 0 },
    };
  },
  readChain: (req) => backend.call(req),
});
assert.equal(preparedQuote.amountOut, amountOut, "prepared exact quote");
assert.equal(
  astraMultiTokenAdapter.prepared!.allowanceSpender!({
    adapterId: selectedEdge.adapterId,
    target: selectedEdge.target,
    tokenIn: selectedEdge.tokenIn,
    tokenOut: selectedEdge.tokenOut,
    amountIn,
  }),
  selectedEdge.target,
  "prepared allowance spender",
);
const fragment = await astraMultiTokenAdapter.buildPlanFragment({
  edge: selectedEdge,
  amountIn,
  amountOut,
  executor: CHANGER,
  state: backend as never,
});
assert.deepEqual(fragment.requirements, [{
  kind: "approve",
  token: selectedEdge.tokenIn,
  spender: selectedEdge.target,
  amount: amountIn,
}], "exact approval");
assert.equal(
  fragment.nodes[0]?.params.minAmountOut,
  amountOut,
  "plan binds the exact quote as minReturn",
);

const action = get(ASTRA_MULTITOKEN_EDGE_ADAPTER);
const encoded = action.encode(fragment.nodes[0], CHANGER, new Uint8Array());
const calldata = bytesToHex(encoded.slice(24));
assert.equal(calldata.slice(0, 10), ASTRA_MULTITOKEN_CHANGE_SELECTOR);
const decoded = astraMultiTokenIface.decodeFunctionData("change", calldata);
assert.equal(ethers.getAddress(String(decoded[0])), selectedEdge.tokenIn);
assert.equal(ethers.getAddress(String(decoded[1])), selectedEdge.tokenOut);
assert.equal(BigInt(decoded[2]), amountIn);
assert.equal(BigInt(decoded[3]), amountOut);

const malformed = await astraMultiTokenAdapter.discovery!
  .candidateFromObservedCall!({
    target: TARGET_A,
    selector: ASTRA_MULTITOKEN_CHANGE_SELECTOR,
    input: first.input,
    from: CHANGER,
    txHash: ethers.keccak256(ethers.toUtf8Bytes("astra-missing-output")),
    receipt: {
      status: 1,
      logs: first.logs.filter((log) =>
        log.address.toLowerCase() !== TOKEN_B.toLowerCase()),
    },
    trace,
  });
assert.equal(
  malformed,
  null,
  "selector + Change without exact output transfer must fail closed",
);

console.log("astra-multitoken-family PASS");

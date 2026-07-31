import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { etherTokenNativeRedeemActionAdapter } from "../../adapters/ethertoken-native-redeem.js";
import { ADDR } from "../../shared/constants/addresses.js";
import type {
  StateBackend,
  TokenToNativeDeltaRequest,
} from "../../shared/state/state-backend.js";
import type { PoolEntry, TokenEdge } from "../planner/token-graph.js";
import {
  assertPureSynchronousDeriveMids,
  createAmbientIoPoisonHarness,
} from "../venues/blockscan-state-capability.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import {
  ETHERTOKEN_DESTRUCTION_EVENT_TOPIC,
  ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER,
  ETHERTOKEN_NATIVE_REDEEM_POOL_ADAPTER,
  ETHERTOKEN_WITHDRAW_SELECTOR,
  etherTokenNativeRedeemDiscovery,
  etherTokenNativeRedeemIdentityResolver,
  etherTokenNativeRedeemInstanceId,
} from "../venues/protocols/ethertoken-native-redeem-discovery.js";
import { etherTokenNativeRedeemAdapter } from "../venues/protocols/ethertoken-native-redeem.js";

const iface = new ethers.Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function withdraw(uint256 amount)",
]);
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const SYNTHETIC_NATIVE_TRANSFER_EMITTER =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const caller = "0x0000000000000000000000000000000000000E72";
const instances = [
  "0x0000000000000000000000000000000000000201",
  "0x0000000000000000000000000000000000000202",
];
const amountIn = 123_456n;
const balanceSlot = ethers.keccak256("0xe7e2");
const totalSupply = 10n ** 30n;
const edges: TokenEdge[] = [];

for (const token of instances) {
  const input = iface.encodeFunctionData("withdraw", [amountIn]);
  const candidate =
    await etherTokenNativeRedeemDiscovery.candidateFromObservedCall!({
      target: token,
      selector: ETHERTOKEN_WITHDRAW_SELECTOR,
      input,
      from: caller,
      txHash: `0x${token.slice(2).padStart(64, "0")}`,
      receipt: {
        status: 1,
        logs: [
          {
            address: token,
            topics: [
              TRANSFER_TOPIC,
              addressTopic(caller),
              addressTopic(token),
            ],
            data: ethers.toBeHex(amountIn, 32),
            blockNumber: 123,
          },
          {
            address: token,
            topics: [ETHERTOKEN_DESTRUCTION_EVENT_TOPIC],
            data: ethers.toBeHex(amountIn, 32),
            blockNumber: 123,
          },
        ],
      },
      trace: {
        from: caller,
        to: token,
        input,
        calls: [{
          from: token,
          to: caller,
          input: "0x",
          value: ethers.toBeHex(amountIn),
        }],
      },
    });
  assert(candidate, "observed exact withdrawal must nominate an instance");
  assert.equal(candidate.pool.address.toLowerCase(), token.toLowerCase());
  assert.equal(
    candidate.pool.fixedTokenOut?.toLowerCase(),
    ADDR.WETH.toLowerCase(),
  );

  const context = discoveryContext(token);
  const identity = await etherTokenNativeRedeemIdentityResolver({
    backend: context.backend,
    pool: token,
    poolAdapter: ETHERTOKEN_NATIVE_REDEEM_POOL_ADAPTER,
    candidate: candidate.pool,
    admissionPolicy: {
      unknownFactory: "reject",
      unregisteredCurveUnderlying: "reject",
    },
    isPoolAdapterSupported: () => true,
  });
  assert(identity.ok, "ERC20 surface must pass before active behavior probing");

  const attestedPool: PoolEntry = {
    ...candidate.pool,
    venueId: identity.ok ? identity.venueId : undefined,
    identitySource: identity.ok ? identity.identitySource : undefined,
  };
  const discovered = await etherTokenNativeRedeemDiscovery.probeCandidate({
    pool: attestedPool as never,
    sources: [candidate.source],
    selectors: [candidate.selector!],
    evidence: candidate.evidence ?? [],
    ownerAdapterId: etherTokenNativeRedeemAdapter.id,
  }, context);
  assert.equal(discovered.length, 1);
  assert.equal(
    discovered[0].adapterId,
    ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER,
  );
  assert.equal(discovered[0].tokenIn.toLowerCase(), token.toLowerCase());
  assert.equal(discovered[0].tokenOut.toLowerCase(), ADDR.WETH.toLowerCase());
  assert.equal(
    discovered[0].leavesStandingPosition,
    false,
    "exact redemption must not create a standing position",
  );

  const verifiedPool: PoolEntry = {
    ...attestedPool,
    logicalInstanceId: etherTokenNativeRedeemInstanceId(token),
    verifiedRoutes: [{
      edgeAdapterId: ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER,
      tokenIn: token,
      tokenOut: ADDR.WETH,
      slotKind: "protocol",
      protocolAction: "redeem",
    }],
  };
  const [edge] = await etherTokenNativeRedeemAdapter.buildEdges(
    verifiedPool,
    { call: context.backend.call },
  );
  assert(edge);
  edges.push(edge);

  const quoted = await etherTokenNativeRedeemAdapter.quoteExact({
    state: {
      simulateTokenToNativeDelta: async (
        request: TokenToNativeDeltaRequest,
      ) => {
        assert.equal(request.token.toLowerCase(), token.toLowerCase());
        assert.equal(request.caller.toLowerCase(), caller.toLowerCase());
        assert.equal(
          request.callData,
          iface.encodeFunctionData("withdraw", [amountIn]),
        );
        return {
          tokenInSpent: amountIn,
          totalSupplyBurned: amountIn,
          nativeOut: amountIn,
        };
      },
    } as unknown as StateBackend,
    executor: caller,
    target: token,
    edgeAdapterId: ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER,
    tokenIn: token,
    tokenOut: ADDR.WETH,
    amountIn,
  });
  assert.equal(quoted, amountIn);

  const fragment = await etherTokenNativeRedeemAdapter.buildPlanFragment({
    edge,
    amountIn,
    amountOut: amountIn,
    executor: caller,
    state: {} as StateBackend,
  });
  assert.deepEqual(
    fragment.nodes.map((node) => node.adapterId),
    [ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER, "weth-deposit-value"],
  );
  assert.equal(fragment.nodes[0].target.toLowerCase(), token.toLowerCase());
  assert.equal(fragment.nodes[1].amount, amountIn);

  const encoded = etherTokenNativeRedeemActionAdapter.encode(
    fragment.nodes[0],
    caller,
    new Uint8Array(),
  );
  assert.equal(encoded[0], 0x00, "route root must use zero-value CALL");
  assert.equal(
    ethers.getAddress(ethers.hexlify(encoded.slice(1, 21))).toLowerCase(),
    token.toLowerCase(),
    "action target must be the discovered instance, not canonical WETH",
  );
  const payload = ethers.hexlify(encoded.slice(24));
  assert.equal(payload.slice(0, 10), ETHERTOKEN_WITHDRAW_SELECTOR);
  assert.equal(
    BigInt(iface.decodeFunctionData("withdraw", payload)[0]),
    amountIn,
  );
}

const pricingSchema =
  await etherTokenNativeRedeemAdapter.pricingState.compileStaticSchema({
    edges,
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 1_000,
  });
const staticReads =
  etherTokenNativeRedeemAdapter.pricingState.buildStaticSchemaReads!(
    {
      sourceBlock: 123,
      sourceBlockHash: ethers.ZeroHash,
      schema: pricingSchema,
      edges,
    },
  );
const hydrated =
  etherTokenNativeRedeemAdapter.pricingState.hydrateStaticSchema!(
    pricingSchema,
    staticReads.map((read) => ({
      id: read.id,
      ok: true,
      sourceBlock: 123,
      sourceBlockHash: ethers.ZeroHash,
      provenance: {
        kind: "eip1898",
        source: { number: 123, hash: ethers.ZeroHash, generation: 1 },
        requireCanonical: true,
      },
      data: iface.encodeFunctionResult("decimals", [18]),
    })),
  );
const currentReads =
  etherTokenNativeRedeemAdapter.pricingState.buildCurrentBlockReads({
    sourceBlock: 123,
    sourceBlockHash: ethers.ZeroHash,
    schema: hydrated,
    edges,
  });
const snapshot = etherTokenNativeRedeemAdapter.pricingState.decodeState(
  hydrated,
  currentReads.map((read) => ({
    id: read.id,
    ok: true,
    sourceBlock: 123,
    sourceBlockHash: ethers.ZeroHash,
    provenance: {
      kind: "eip1898",
      source: { number: 123, hash: ethers.ZeroHash, generation: 1 },
      requireCanonical: true,
    },
    data: iface.encodeFunctionResult("totalSupply", [totalSupply]),
  })),
);
assertPureSynchronousDeriveMids({
  capability: etherTokenNativeRedeemAdapter.pricingState,
  snapshot,
  edges,
  harness: createAmbientIoPoisonHarness(),
});
assert.equal(
  etherTokenNativeRedeemAdapter.pricingState.deriveMids(snapshot, edges).size,
  instances.length,
  "current-block pricing must isolate every dynamic instance",
);

assert.equal(
  PRODUCTION_ADAPTER_FAMILIES.routes().forEdge(
    ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER,
  ).id,
  etherTokenNativeRedeemAdapter.id,
);
assert(
  !etherTokenNativeRedeemActionAdapter.matchTrace(
    instances[0],
    "0xdeadbeef",
  ),
);
assert(
  !etherTokenNativeRedeemActionAdapter.matchTrace(
    ADDR.WETH,
    ETHERTOKEN_WITHDRAW_SELECTOR,
  ),
  "dynamic family trace matching must not steal canonical WETH withdraw",
);

const wrongTransfer =
  await etherTokenNativeRedeemDiscovery.candidateFromObservedCall!({
    target: instances[0],
    selector: ETHERTOKEN_WITHDRAW_SELECTOR,
    input: iface.encodeFunctionData("withdraw", [amountIn]),
    from: caller,
    txHash: ethers.ZeroHash,
    receipt: {
      status: 1,
      logs: [{
        address: instances[0],
        topics: [
          TRANSFER_TOPIC,
          addressTopic(caller),
          ethers.ZeroHash,
        ],
        data: ethers.toBeHex(amountIn, 32),
        blockNumber: 123,
      }, {
        address: instances[0],
        topics: [ETHERTOKEN_DESTRUCTION_EVENT_TOPIC],
        data: ethers.toBeHex(amountIn, 32),
        blockNumber: 123,
      }],
    },
    trace: {},
  });
assert.equal(
  wrongTransfer,
  null,
  "a WETH-like burn event shape must not enter this execution family",
);

await assert.rejects(
  etherTokenNativeRedeemAdapter.quoteExact({
    state: {
      simulateTokenToNativeDelta: async () => ({
        tokenInSpent: amountIn,
        totalSupplyBurned: amountIn,
        nativeOut: amountIn - 1n,
      }),
    } as unknown as StateBackend,
    executor: caller,
    target: instances[0],
    edgeAdapterId: ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER,
    tokenIn: instances[0],
    tokenOut: ADDR.WETH,
    amountIn,
  }),
  /exact quote invariants failed/,
);

const productionSource = [
  readFileSync(new URL(
    "../venues/protocols/ethertoken-native-redeem.ts",
    import.meta.url,
  ), "utf8"),
  readFileSync(new URL(
    "../venues/protocols/ethertoken-native-redeem-discovery.ts",
    import.meta.url,
  ), "utf8"),
].join("\n").toLowerCase();
assert(
  !productionSource.includes(
    "0xc0829421c1d260bd3cb3e0f06cfe2d52db2ce315",
  ),
  "production admission must not hardcode the historical instance",
);

console.log(
  "ethertoken-native-redeem-family PASS (observed discovery + two instances)",
);

function discoveryContext(token: string) {
  return {
    backend: {
      async call(req: { to: string; data: string }) {
        if (req.data.startsWith(iface.getFunction("balanceOf")!.selector)) {
          return iface.encodeFunctionResult("balanceOf", [0n]);
        }
        if (req.data.startsWith(iface.getFunction("totalSupply")!.selector)) {
          return iface.encodeFunctionResult("totalSupply", [totalSupply]);
        }
        if (req.data.startsWith(iface.getFunction("decimals")!.selector)) {
          return iface.encodeFunctionResult("decimals", [18]);
        }
        throw new Error("unexpected call");
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
        return {};
      },
      async createAccessList() {
        return [{ address: token, storageKeys: [balanceSlot] }];
      },
      async simulateCalls(req: {
        readonly calls: readonly { readonly data: string }[];
        readonly stateOverrides?: Readonly<Record<string, {
          readonly stateDiff?: Readonly<Record<string, string>>;
        }>>;
      }) {
        const overridden = Object.values(
          req.stateOverrides?.[token]?.stateDiff ?? {},
        )[0];
        const funded = overridden ? BigInt(overridden) : amountIn;
        if (req.calls.length === 1) {
          return [{
            status: 1,
            returnData: iface.encodeFunctionResult("balanceOf", [funded]),
            logs: [],
          }];
        }
        return [
          {
            status: 1,
            returnData: iface.encodeFunctionResult("balanceOf", [funded]),
            logs: [],
          },
          {
            status: 1,
            returnData: iface.encodeFunctionResult("totalSupply", [
              totalSupply,
            ]),
            logs: [],
          },
          {
            status: 1,
            returnData: "0x",
            logs: [{
              address: SYNTHETIC_NATIVE_TRANSFER_EMITTER,
              topics: [
                TRANSFER_TOPIC,
                addressTopic(token),
                addressTopic(caller),
              ],
              data: ethers.toBeHex(funded, 32),
            }],
          },
          {
            status: 1,
            returnData: iface.encodeFunctionResult("balanceOf", [0n]),
            logs: [],
          },
          {
            status: 1,
            returnData: iface.encodeFunctionResult("totalSupply", [
              totalSupply - funded,
            ]),
            logs: [],
          },
        ];
      },
    },
    blockNumber: 123,
    fromBlock: 123,
    toBlock: 123,
    chainId: "1",
    // The observed token may itself be introduced by a preceding new family
    // edge. Only the canonical WETH anchor is required at first admission.
    graphTokens: [ADDR.WETH],
    probeExecutor: caller,
    retainedInstances: [],
  } as const;
}

function addressTopic(address: string): string {
  return ethers.zeroPadValue(address, 32);
}

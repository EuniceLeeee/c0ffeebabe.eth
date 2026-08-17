import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { PoolEntry, TokenEdge } from "../planner/token-graph.js";
import { STRICT_PROJECTED_FAMILY_TEST_REGISTRY } from "./strict-family-test-compat.js";
import {
  SELF_BURN_NATIVE_EDGE_ADAPTER,
  SELF_BURN_NATIVE_POOL_ADAPTER,
  SYNTHETIC_NATIVE_TRANSFER_EMITTER,
  selfBurnNativeDiscovery,
  selfBurnNativeIdentityResolver,
  selfBurnNativeInstanceId,
} from "../venues/protocols/self-burn-native-discovery.js";
import { selfBurnNativeAdapter } from "../venues/protocols/self-burn-native.js";

const erc20 = new ethers.Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);
const transferTopic = ethers.id("Transfer(address,address,uint256)");
const caller = "0x0000000000000000000000000000000000000B07";
const instances = [
  "0x0000000000000000000000000000000000000101",
  "0x0000000000000000000000000000000000000102",
];
const amountIn = 123_456n;
const nativeOut = 120_000n;
const balanceSlot = ethers.keccak256("0x1234");
const totalSupply = 10n ** 30n;
const instanceEdges: TokenEdge[] = [];

for (const token of instances) {
  const proactive = await selfBurnNativeDiscovery.candidateFromAddress!({
    target: token,
    codeHash: ethers.keccak256("0x60006000"),
    implementationWord: ethers.zeroPadValue(token, 32),
  });
  assert(proactive, "a proxy token in the DEX domain must enter behavior probing");
  const proactiveIdentity = await selfBurnNativeIdentityResolver({
    backend: discoveryContext(token).backend,
    pool: token,
    poolAdapter: SELF_BURN_NATIVE_POOL_ADAPTER,
    candidate: proactive.pool,
    admissionPolicy: {
      unknownFactory: "reject",
      unregisteredCurveUnderlying: "reject",
    },
    isPoolAdapterSupported: () => true,
  });
  assert(proactiveIdentity.ok, "proactive ERC20 surface must pass identity");
  const proactiveEdges = await selfBurnNativeDiscovery.probeCandidate({
    pool: {
      ...proactive.pool,
      venueId: proactiveIdentity.ok ? proactiveIdentity.venueId : undefined,
      identitySource: proactiveIdentity.ok
        ? proactiveIdentity.identitySource
        : undefined,
    } as never,
    sources: [proactive.source],
    selectors: [],
    evidence: [],
    ownerAdapterId: selfBurnNativeAdapter.id,
  }, discoveryContext(token));
  assert.equal(
    proactiveEdges.length,
    1,
    "behavior proof must instantiate each compatible address without a fixture",
  );

  const input = erc20.encodeFunctionData("transfer", [token, amountIn]);
  const candidate = await selfBurnNativeDiscovery.candidateFromObservedCall!({
    target: token,
    selector: erc20.getFunction("transfer")!.selector,
    input,
    from: caller,
    txHash: `0x${token.slice(2).padStart(64, "0")}`,
    receipt: {
      status: 1,
      logs: [{
        address: token,
        topics: [
          ethers.id("Transfer(address,address,uint256)"),
          ethers.zeroPadValue(token, 32),
          ethers.ZeroHash,
        ],
        data: ethers.toBeHex(amountIn, 32),
        blockNumber: 123,
      }],
    },
    trace: {
      from: caller,
      to: token,
      input,
      calls: [{
        from: token,
        to: caller,
        input: "0x",
        value: ethers.toBeHex(nativeOut),
      }],
    },
  });
  assert(candidate, "observed self-transfer must nominate a candidate");
  assert.equal(candidate.pool.address.toLowerCase(), token.toLowerCase());
  assert.equal(candidate.pool.fixedTokenOut?.toLowerCase(), ADDR.WETH.toLowerCase());

  const identity = await selfBurnNativeIdentityResolver({
    backend: discoveryContext(token).backend,
    pool: token,
    poolAdapter: SELF_BURN_NATIVE_POOL_ADAPTER,
    candidate: candidate.pool,
    admissionPolicy: {
      unknownFactory: "reject",
      unregisteredCurveUnderlying: "reject",
    },
    isPoolAdapterSupported: () => true,
  });
  assert(identity.ok, "ERC20 surface must pass identity before behavior probe");

  const attestedPool: PoolEntry = {
    ...candidate.pool,
    venueId: identity.ok ? identity.venueId : undefined,
    identitySource: identity.ok ? identity.identitySource : undefined,
  };
  const edges = await selfBurnNativeDiscovery.probeCandidate({
    pool: attestedPool as never,
    sources: [candidate.source],
    selectors: [candidate.selector!],
    evidence: candidate.evidence ?? [],
    ownerAdapterId: selfBurnNativeAdapter.id,
  }, discoveryContext(token));
  assert.equal(edges.length, 1);
  assert.equal(edges[0].adapterId, SELF_BURN_NATIVE_EDGE_ADAPTER);
  assert.equal(edges[0].tokenIn.toLowerCase(), token.toLowerCase());
  assert.equal(edges[0].tokenOut.toLowerCase(), ADDR.WETH.toLowerCase());

  const verifiedPool: PoolEntry = {
    ...attestedPool,
    logicalInstanceId: selfBurnNativeInstanceId(token),
    verifiedRoutes: [{
      edgeAdapterId: SELF_BURN_NATIVE_EDGE_ADAPTER,
      tokenIn: token,
      tokenOut: ADDR.WETH,
      slotKind: "protocol",
      protocolAction: "redeem",
    }],
  };
  const rebuilt = await selfBurnNativeAdapter.buildEdges(verifiedPool, {
    call: discoveryContext(token).backend.call,
  });
  assert.equal(rebuilt.length, 1);
  instanceEdges.push(rebuilt[0]);
  const pricingSchema = await selfBurnNativeAdapter.pricingState.compileStaticSchema({
    // Runtime graph projection may present the same semantic edge in both
    // strategy views. One instance key must tolerate those duplicates.
    edges: [rebuilt[0], { ...rebuilt[0] }],
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 1_000,
  });
  assert.equal(pricingSchema.instances.length, 1);
  assert.equal(
    pricingSchema.instances[0].token.toLowerCase(),
    token.toLowerCase(),
  );

  const quoted = await selfBurnNativeAdapter.quoteExact({
    state: {
      simulateTokenToNativeDelta: async () => ({
        tokenInSpent: amountIn,
        totalSupplyBurned: amountIn,
        nativeOut,
      }),
    } as unknown as StateBackend,
    executor: caller,
    target: token,
    edgeAdapterId: SELF_BURN_NATIVE_EDGE_ADAPTER,
    tokenIn: token,
    tokenOut: ADDR.WETH,
    amountIn,
  });
  assert.equal(quoted, nativeOut);

  const fragment = await selfBurnNativeAdapter.buildPlanFragment({
    edge: rebuilt[0],
    amountIn,
    amountOut: nativeOut,
    executor: caller,
    state: {} as StateBackend,
  });
  assert.deepEqual(
    fragment.nodes.map((node) => node.adapterId),
    [SELF_BURN_NATIVE_EDGE_ADAPTER, "weth-deposit-value"],
  );
  assert.equal(fragment.nodes[0].target.toLowerCase(), token.toLowerCase());
  assert.equal(fragment.nodes[1].amount, nativeOut);
}

const multiInstanceSchema =
  await selfBurnNativeAdapter.pricingState.compileStaticSchema({
    edges: instanceEdges,
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 1_000,
  });
assert.equal(
  multiInstanceSchema.instances.length,
  instances.length,
  "one family schema must isolate every instance state key",
);
const staticResults = instances.flatMap((token, index) => [
  {
    id: `decimals:${token.toLowerCase()}`,
    ok: true,
    sourceBlock: 123,
    sourceBlockHash: ethers.ZeroHash,
    provenance: {},
    data: erc20.encodeFunctionResult("decimals", [18]),
  },
  index === 0
    ? {
        id: `balance-access-list:${token.toLowerCase()}`,
        ok: true,
        sourceBlock: 123,
        sourceBlockHash: ethers.ZeroHash,
        provenance: {},
        data: ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify({
          accessList: [{ address: token, storageKeys: [balanceSlot] }],
        }))),
      }
    : {
        id: `balance-access-list:${token.toLowerCase()}`,
        ok: false,
        sourceBlock: 123,
        sourceBlockHash: ethers.ZeroHash,
        kind: "rpc",
        error: "instance-local failure",
      },
]);
const hydratedMultiSchema =
  selfBurnNativeAdapter.pricingState.hydrateStaticSchema!(
    multiInstanceSchema,
    staticResults as never,
  );
assert.equal(hydratedMultiSchema.instances[0].staticIssue, undefined);
assert.match(
  hydratedMultiSchema.instances[1].staticIssue ?? "",
  /instance-local failure/,
);
assert.doesNotThrow(() =>
  selfBurnNativeAdapter.pricingState.buildCurrentBlockReads({
    sourceBlock: 123,
    sourceBlockHash: ethers.ZeroHash,
    schema: hydratedMultiSchema,
    edges: [instanceEdges[0]],
  })
);
const balanceProofReads =
  selfBurnNativeAdapter.pricingState.buildCurrentBlockReads({
    sourceBlock: 123,
    sourceBlockHash: ethers.ZeroHash,
    schema: hydratedMultiSchema,
    edges: [instanceEdges[0]],
  });
assert.equal(balanceProofReads.length, 1);
const pricingReads =
  selfBurnNativeAdapter.pricingState.buildDependentBlockReads!({
    sourceBlock: 123,
    sourceBlockHash: ethers.ZeroHash,
    schema: hydratedMultiSchema,
    edges: [instanceEdges[0]],
    completedRound: 0,
    priorResults: [{
      id: balanceProofReads[0].id,
      ok: true,
      sourceBlock: 123,
      sourceBlockHash: ethers.ZeroHash,
      provenance: {
        kind: "eip1898",
        source: { number: 123, hash: ethers.ZeroHash, generation: 1 },
        requireCanonical: true,
      },
      data: ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify([{
        calls: [{
          status: "0x1",
          returnData: ethers.toBeHex(0x51f_ba11n, 32),
        }],
      }]))),
    }],
  });
assert.equal(
  pricingReads.length,
  4,
  "the production eth_simulateV1 shape must advance slot proof to pricing",
);
assert.throws(() =>
  selfBurnNativeAdapter.pricingState.buildCurrentBlockReads({
    sourceBlock: 123,
    sourceBlockHash: ethers.ZeroHash,
    schema: hydratedMultiSchema,
    edges: [instanceEdges[1]],
  }),
  /instance static schema failed/,
);

assert.equal(
  STRICT_PROJECTED_FAMILY_TEST_REGISTRY.routes().forEdge(
    SELF_BURN_NATIVE_EDGE_ADAPTER,
  ).id,
  selfBurnNativeAdapter.id,
);
const incompatibleIdentity = await selfBurnNativeIdentityResolver({
  backend: {
    ...discoveryContext(instances[0]).backend,
    async call() {
      throw Object.assign(new Error("incompatible ABI"), { code: "BAD_DATA" });
    },
  },
  pool: instances[0],
  poolAdapter: SELF_BURN_NATIVE_POOL_ADAPTER,
  candidate: {
    address: instances[0],
    adapter: SELF_BURN_NATIVE_POOL_ADAPTER,
    fixedTokenIn: instances[0],
    fixedTokenOut: ADDR.WETH,
    logicalInstanceId: selfBurnNativeInstanceId(instances[0]),
  },
  admissionPolicy: {
    unknownFactory: "reject",
    unregisteredCurveUnderlying: "reject",
  },
  isPoolAdapterSupported: () => true,
});
assert(
  !incompatibleIdentity.ok &&
    incompatibleIdentity.reason === "behavior_mismatch",
  "deterministic ABI mismatch must be a settled negative, not retryable",
);
const productionSource = [
  readFileSync(new URL(
    "../venues/protocols/self-burn-native.ts",
    import.meta.url,
  ), "utf8"),
  readFileSync(new URL(
    "../venues/protocols/self-burn-native-discovery.ts",
    import.meta.url,
  ), "utf8"),
].join("\n").toLowerCase();
for (const forbidden of [
  "rueth",
  "kgeth",
  "mreth",
  "0x292a477e521230fe230c13c93374adde8ddec1c1",
  "0xc6a9851def913016074ac089e194f65945343462",
]) {
  assert(!productionSource.includes(forbidden), `production source leaked ${forbidden}`);
}

console.log("self-burn-native-family PASS (two independent instances)");

function discoveryContext(token: string) {
  return {
    backend: {
      async call(req: { to: string; data: string }) {
        if (req.data.startsWith(erc20.getFunction("balanceOf")!.selector)) {
          return erc20.encodeFunctionResult("balanceOf", [0n]);
        }
        if (req.data.startsWith(erc20.getFunction("totalSupply")!.selector)) {
          return erc20.encodeFunctionResult("totalSupply", [totalSupply]);
        }
        if (req.data.startsWith(erc20.getFunction("decimals")!.selector)) {
          return erc20.encodeFunctionResult("decimals", [18]);
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
            returnData: erc20.encodeFunctionResult("balanceOf", [funded]),
            logs: [],
          }];
        }
        return [
          {
            status: 1,
            returnData: erc20.encodeFunctionResult("balanceOf", [funded]),
            logs: [],
          },
          {
            status: 1,
            returnData: erc20.encodeFunctionResult("totalSupply", [
              totalSupply,
            ]),
            logs: [],
          },
          {
            status: 1,
            returnData: erc20.encodeFunctionResult("transfer", [true]),
            logs: [{
              address: SYNTHETIC_NATIVE_TRANSFER_EMITTER,
              topics: [
                transferTopic,
                addressTopic(token),
                addressTopic(caller),
              ],
              data: ethers.toBeHex(nativeOut, 32),
            }],
          },
          {
            status: 1,
            returnData: erc20.encodeFunctionResult("balanceOf", [0n]),
            logs: [],
          },
          {
            status: 1,
            returnData: erc20.encodeFunctionResult("totalSupply", [
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
    graphTokens: [token, ADDR.WETH],
    probeExecutor: caller,
    retainedInstances: [],
  } as const;
}

function addressTopic(address: string): string {
  return ethers.zeroPadValue(address, 32);
}

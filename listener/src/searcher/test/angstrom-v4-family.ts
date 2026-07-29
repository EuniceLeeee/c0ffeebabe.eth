import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanMulticallIface,
} from "../blockscan-multicall.js";
import {
  PRODUCTION_ADAPTER_FAMILIES,
} from "../venues/production-registry.js";
import {
  STRICT_IDENTITY_ADMISSION,
} from "../venues/admission.js";
import {
  ANGSTROM_ADAPTER_SWAP_ABI,
  ANGSTROM_MAINNET_ADAPTER,
  ANGSTROM_MAINNET_CHAIN_ID,
  ANGSTROM_MAINNET_HOOK,
} from "../venues/swaps/angstrom-attestation.js";
import { angstromV4Adapter } from "../venues/swaps/angstrom-v4.js";
import {
  uniV4QuoterIface,
  univ4Adapter,
} from "../venues/swaps/univ4.js";
import {
  UNIV4_INITIALIZE_TOPIC,
  UNIV4_SWAP_TOPIC,
} from "../venues/landed-event-registry.js";
import {
  v4PoolId,
} from "../venues/swaps/univ4-common.js";

const signer = new ethers.Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412e5b41436b2d59d",
);
const token0 = "0x1111111111111111111111111111111111111111";
const token1 = "0x2222222222222222222222222222222222222222";
const sourceBlock = 25_635_365;
const key = Object.freeze({
  currency0: token0,
  currency1: token1,
  fee: 0x80_0000,
  tickSpacing: 10,
  hooks: ANGSTROM_MAINNET_HOOK,
});
const poolId = v4PoolId(key);
const adapterIface = new ethers.Interface(ANGSTROM_ADAPTER_SWAP_ABI);
const hookStateIface = new ethers.Interface([
  "function extsload(uint256 slot) view returns (uint256 value)",
]);
const controllerIface = new ethers.Interface([
  "function ANGSTROM() view returns (address)",
]);
const controller = "0x4444444444444444444444444444444444444444";
const contractValidator =
  "0x5555555555555555555555555555555555555555";
const initializeIface = new ethers.Interface([
  "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)",
]);

async function signedUnlockData(blockNumber: bigint): Promise<string> {
  const signature = await signer.signTypedData(
    {
      name: "Angstrom",
      version: "v1",
      chainId: ANGSTROM_MAINNET_CHAIN_ID,
      verifyingContract: ANGSTROM_MAINNET_HOOK,
    },
    {
      AttestAngstromBlockEmpty: [{
        name: "block_number",
        type: "uint64",
      }],
    },
    { block_number: blockNumber },
  );
  return ethers.concat([signer.address, signature]);
}

async function main(): Promise<void> {
  const unlockData = await signedUnlockData(BigInt(sourceBlock));
  const evidenceCall = adapterIface.encodeFunctionData("swap", [
    key,
    true,
    1_000_000n,
    900_000n,
    [{ blockNumber: BigInt(sourceBlock), unlockData }],
    "0x3333333333333333333333333333333333333333",
    (1n << 256n) - 1n,
  ]);
  let observerReads = 0;
  const evidenceContext = Object.freeze({
    head: Object.freeze({
      number: sourceBlock,
      hash: `0x${"ab".repeat(32)}`,
    }),
    async call(read: { to: string; data: string }) {
      observerReads++;
      if (
        ethers.getAddress(read.to) ===
          ethers.getAddress(ANGSTROM_MAINNET_HOOK)
      ) {
        assert.equal(
          read.data.slice(0, 10),
          hookStateIface.getFunction("extsload")!.selector,
          "the deployed hook exposes only its custom single-slot extsload",
        );
        const [slot] = hookStateIface.decodeFunctionData(
          "extsload",
          read.data,
        );
        assert.equal(BigInt(slot), 0n);
        return hookStateIface.encodeFunctionResult(
          "extsload",
          [BigInt(controller)],
        );
      }
      if (ethers.getAddress(read.to) === ethers.getAddress(controller)) {
        assert.equal(
          read.data.slice(0, 10),
          controllerIface.getFunction("ANGSTROM")!.selector,
        );
        return controllerIface.encodeFunctionResult(
          "ANGSTROM",
          [ANGSTROM_MAINNET_HOOK],
        );
      }
      assert.equal(
        ethers.getAddress(read.to),
        ethers.getAddress(BLOCKSCAN_MULTICALL3),
      );
      const calls = blockScanMulticallIface.decodeFunctionData(
        "aggregate3",
        read.data,
      )[0] as readonly {
        target: string;
        allowFailure: boolean;
        callData: string;
      }[];
      return blockScanMulticallIface.encodeFunctionResult("aggregate3", [[
        ...calls.map((call) => {
          if (
            ethers.getAddress(call.target) ===
              ethers.getAddress(ANGSTROM_MAINNET_HOOK)
          ) {
            const [slot] = hookStateIface.decodeFunctionData(
              "extsload",
              call.callData,
            );
            const signerSlot = BigInt(ethers.keccak256(
              ethers.AbiCoder.defaultAbiCoder().encode(
                ["address", "uint256"],
                [signer.address, 1n],
              ),
            ));
            const contractSlot = BigInt(ethers.keccak256(
              ethers.AbiCoder.defaultAbiCoder().encode(
                ["address", "uint256"],
                [contractValidator, 1n],
              ),
            ));
            assert(
              BigInt(slot) === signerSlot || BigInt(slot) === contractSlot,
              "observer must read the authoritative hook node mapping",
            );
            return {
              success: true,
              returnData: hookStateIface.encodeFunctionResult(
                "extsload",
                [1n],
              ),
            };
          }
          assert.fail("authority batch must only read the hook node mapping");
        }),
      ]]);
    },
  });
  assert.equal(
    angstromV4Adapter.pendingTransactionEvidence!.mightMatch({
      hash: ethers.keccak256(evidenceCall),
      to: ANGSTROM_MAINNET_ADAPTER,
      data: evidenceCall,
    }),
    true,
  );
  assert.equal(
    angstromV4Adapter.pendingTransactionEvidence!.routeActivation,
    "current-head-block-scan",
  );
  assert.deepEqual(
    angstromV4Adapter.pendingTransactionEvidence!.routeActivationScope,
    { kind: "family" },
    "an empty-block attestation authorizes the current-head Angstrom family",
  );
  const observed = await PRODUCTION_ADAPTER_FAMILIES
    .pendingTransactionEvidence()
    .observe(
      {
        hash: ethers.keccak256(evidenceCall),
        to: ANGSTROM_MAINNET_ADAPTER,
        data: evidenceCall,
      },
      {
        head: evidenceContext.head,
        call: (read) => evidenceContext.call(read),
      },
      {
        familyIds: [angstromV4Adapter.id],
        timeoutMs: 1_000,
        maxReadsPerFamily: 3,
      },
    );
  assert.equal(observed.matched, true, "valid family evidence must promote intake");
  assert.equal(observerReads, 3, "Angstrom observation must use three reads");
  const executionEvidence = observed.evidence[0]!;
  assert.equal(executionEvidence.familyId, angstromV4Adapter.id);
  assert(Object.isFrozen(executionEvidence));
  assert.equal(
    executionEvidence.payloadHash,
    ethers.keccak256(executionEvidence.canonicalPayload),
  );

  const contractUnlockData = ethers.concat([
    contractValidator,
    `0x${"cd".repeat(103)}`,
  ]);
  const contractEvidenceCall = adapterIface.encodeFunctionData("swap", [
    key,
    true,
    1_000_000n,
    900_000n,
    [{
      blockNumber: BigInt(sourceBlock),
      unlockData: contractUnlockData,
    }],
    "0x3333333333333333333333333333333333333333",
    (1n << 256n) - 1n,
  ]);
  observerReads = 0;
  const contractObserved = await PRODUCTION_ADAPTER_FAMILIES
    .pendingTransactionEvidence()
    .observe(
      {
        hash: ethers.keccak256(contractEvidenceCall),
        to: ANGSTROM_MAINNET_ADAPTER,
        data: contractEvidenceCall,
      },
      {
        head: evidenceContext.head,
        call: (read) => evidenceContext.call(read),
      },
      {
        familyIds: [angstromV4Adapter.id],
        timeoutMs: 1_000,
        maxReadsPerFamily: 3,
      },
    );
  assert.equal(
    contractObserved.matched,
    false,
    "contract-node evidence must fail closed without Hook-caller simulation",
  );
  assert.equal(observerReads, 3);

  const init = initializeIface.encodeEventLog(
    initializeIface.getEvent("Initialize")!,
    [
      poolId,
      token0,
      token1,
      key.fee,
      key.tickSpacing,
      key.hooks,
      1n << 96n,
      0,
    ],
  );
  const swapLog = {
    address: ADDR.UNISWAP_V4_POOL_MANAGER,
    topics: [UNIV4_SWAP_TOPIC, poolId],
    data: "0x",
    blockNumber: sourceBlock,
  };
  const materialized = await angstromV4Adapter.poolDiscovery!.materialize({
    familyId: angstromV4Adapter.id,
    event: PRODUCTION_ADAPTER_FAMILIES
      .landedEvents()
      .eventsForFamily(angstromV4Adapter.id)[0]!,
    logs: [swapLog],
    retainedPools: [],
    retryablePools: [],
    isKnownPool: () => false,
    fromBlock: sourceBlock,
    toBlock: sourceBlock,
    minSwaps: 1,
    admissionPolicy: STRICT_IDENTITY_ADMISSION,
    historicalResolution: "complete",
    backend: {
      async getLogs() { return []; },
      async call() { throw new Error("unexpected materializer call"); },
    },
    async scanLogs(filter) {
      return {
        logs: filter.topics[0] === UNIV4_INITIALIZE_TOPIC
          ? [{
              address: ADDR.UNISWAP_V4_POOL_MANAGER,
              topics: init.topics,
              data: init.data,
              blockNumber: sourceBlock,
            }]
          : [],
        complete: true,
        issues: [],
      };
    },
  });
  assert.equal(materialized.complete, true);
  assert.equal(materialized.pools.length, 1);
  const pool = materialized.pools[0]!;
  assert.equal(pool.adapter, "angstrom-v4");
  assert.equal(pool.poolId, poolId);
  assert.equal(pool.logicalInstanceId, poolId);

  const edges = await PRODUCTION_ADAPTER_FAMILIES.routes().buildEdges(
    pool,
    { async call() { throw new Error("inline PoolKey must require no RPC"); } },
  );
  assert.equal(edges.length, 2);
  assert(edges.every((edge) => edge.adapterId === "angstrom-v4-swap"));
  await assert.rejects(
    () => univ4Adapter.buildEdges(
      { ...pool, adapter: "univ4" },
      { async call() { throw new Error("inline PoolKey must require no RPC"); } },
    ),
    /excludes swap-affecting hooks/,
    "standard univ4 must remain fail-closed for Angstrom",
  );

  const amountOut = 987_654n;
  const quoteState = {
    async call(req: { to: string; data: string }) {
      assert.equal(
        ethers.getAddress(req.to),
        ethers.getAddress(BLOCKSCAN_MULTICALL3),
      );
      const calls = blockScanMulticallIface.decodeFunctionData(
        "aggregate3",
        req.data,
      )[0] as readonly { target: string; allowFailure: boolean; callData: string }[];
      for (const call of calls) {
        const quote = uniV4QuoterIface.decodeFunctionData(
          "quoteExactInputSingle",
          call.callData,
        )[0];
        assert.equal(quote.hookData, unlockData);
      }
      return blockScanMulticallIface.encodeFunctionResult("aggregate3", [[
        ...calls.map(() => ({
          success: true,
          returnData: uniV4QuoterIface.encodeFunctionResult(
            "quoteExactInputSingle",
            [amountOut, 100_000n],
          ),
        })),
      ]]);
    },
  } as unknown as StateBackend;
  const exact = await angstromV4Adapter.quoteExact({
    state: quoteState,
    target: edges[0]!.target,
    edgeAdapterId: edges[0]!.adapterId,
    amountIn: 1_000_000n,
    tokenIn: edges[0]!.tokenIn,
    tokenOut: edges[0]!.tokenOut,
    v4PoolKey: edges[0]!.v4PoolKey,
    executionEvidence,
  });
  assert.equal(exact, amountOut);
  await assert.rejects(
    () => angstromV4Adapter.quoteExact({
      state: quoteState,
      target: edges[0]!.target,
      edgeAdapterId: edges[0]!.adapterId,
      amountIn: 1_000_000n,
      tokenIn: edges[0]!.tokenIn,
      tokenOut: edges[0]!.tokenOut,
      v4PoolKey: edges[0]!.v4PoolKey,
    }),
    /requires tx-bound family execution evidence/,
  );

  const fragment = await angstromV4Adapter.buildPlanFragment({
    edge: edges[0]!,
    amountIn: 1_000_000n,
    amountOut: 900_000n,
    executor: "0x3333333333333333333333333333333333333333",
    state: quoteState,
    executionEvidence,
  });
  assert.equal(fragment.nodes.length, 1);
  assert.equal(fragment.nodes[0]!.adapterId, "angstrom-v4-swap");
  assert.equal(fragment.nodes[0]!.target, ANGSTROM_MAINNET_ADAPTER);
  assert.equal(fragment.requirements[0]?.kind, "approve");
  assert.equal(
    fragment.nodes[0]!.params.attestationBlockNumbers instanceof Array,
    true,
  );
  await assert.rejects(
    () => angstromV4Adapter.buildPlanFragment({
      edge: edges[0]!,
      amountIn: 1_000_000n,
      amountOut: 900_000n,
      executor: "0x3333333333333333333333333333333333333333",
      state: quoteState,
    }),
    /requires tx-bound family execution evidence/,
  );

  const observation = await angstromV4Adapter.observation.decodeReceiptImpacts({
    logs: [{
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      topics: [UNIV4_SWAP_TOPIC, poolId],
      data: ethers.AbiCoder.defaultAbiCoder().encode(
        ["int128", "int128", "uint160", "uint128", "int24", "uint24"],
        [-1_000_000n, amountOut, 1n << 96n, 1_000_000n, 0, key.fee],
      ),
    }],
    graph: edges,
    edgesByTarget: new Map([
      [ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(), edges],
    ]),
    tokenQuery: null,
    sourceGeneration: {
      id: ethers.ZeroHash,
      sourceBlock: sourceBlock - 1,
      sourceBlockHash: null,
      receiptId: "fixture",
      receiptBlockNumber: sourceBlock,
      receiptBlockHash: null,
      receiptParentBlockHash: null,
      receiptTransactionHash: null,
      logsCompleteness: "complete-receipt",
    },
    matchedOwnedTriggers: [{
      triggerId: "angstrom-trigger",
      logIndex: 0,
      emitter: ADDR.UNISWAP_V4_POOL_MANAGER,
      topic0: UNIV4_SWAP_TOPIC,
    }],
    control: {
      deadlineAtMs: Date.now() + 1_000,
      signal: new AbortController().signal,
    },
  });
  assert.equal(observation.status, "resolved");
  if (observation.status === "resolved") {
    assert.equal(
      observation.impacts[0]!.impact.amountOut,
      undefined,
      "hook-adjusted output must not reuse PoolManager's pre-afterSwap delta",
    );
  }

  console.log("angstrom-v4-family PASS");
}

await main();

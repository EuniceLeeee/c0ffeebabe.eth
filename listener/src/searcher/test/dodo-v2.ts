import { ethers } from "ethers";
import type { TokenQueryBackend } from "../planner/token-graph.js";
import type {
  StateRead,
  StateReadResult,
} from "../venues/blockscan-state-capability.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { STRICT_IDENTITY_ADMISSION } from "../venues/admission.js";
import { dodoV2IdentityResolver } from "../venues/identity.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import {
  dodoV2BlockScanState,
  dodoV2PoolIface,
  selectDodoBlockScanProbeInput,
} from "../venues/swaps/dodo-v2.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanMulticallIface,
} from "../venues/swaps/blockscan-state-shared.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const POOL = "0x0000000000000000000000000000000000000D02";
const BASE = "0x00000000000000000000000000000000000000B0";
const QUOTE = "0x00000000000000000000000000000000000000C0";
const REGISTRY = "0x5336edE8F971339F6c0e304c66ba16F1296A2Fbe";
const QUOTE_ACTOR = "0x0000000000000000000000000000000000000a11";
const erc20Iface = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const factoryIface = new ethers.Interface([
  "function getDODOPool(address baseToken,address quoteToken) view returns (address[] pools)",
]);

interface BackendOptions {
  readonly baseBalance?: bigint;
  readonly quoteBalance?: bigint;
  readonly baseReserve?: bigint;
  readonly quoteReserve?: bigint;
  readonly baseInput?: bigint;
  readonly quoteInput?: bigint;
  readonly baseInputReverts?: boolean;
  readonly quoteInputReverts?: boolean;
  readonly queryReverts?: boolean;
  readonly exactQueryInput?: bigint;
  readonly queryAmountOut?: bigint;
  readonly queryReturnsZero?: boolean;
  readonly mtFeeTotal?: readonly [bigint, bigint];
  readonly pmm?: readonly [bigint, bigint, bigint, bigint, bigint, bigint, number];
}

class Backend implements TokenQueryBackend {
  balanceCalls = 0;
  queryCalls = 0;
  lastBaseQueryInput: bigint | null = null;
  lastFeeActor: string | null = null;
  lastQueryActor: string | null = null;

  constructor(private readonly options: BackendOptions = {}) {}

  async call(req: { to: string; data: string }): Promise<string> {
    const selector = req.data.slice(0, 10);
    if (
      req.to.toLowerCase() === BLOCKSCAN_MULTICALL3.toLowerCase() &&
      selector === blockScanMulticallIface.getFunction("aggregate3")!.selector
    ) {
      const calls = blockScanMulticallIface.decodeFunctionData(
        "aggregate3",
        req.data,
      )[0] as readonly {
        readonly target: string;
        readonly allowFailure: boolean;
        readonly callData: string;
      }[];
      const responses = [];
      for (const call of calls) {
        try {
          responses.push({
            success: true,
            returnData: await this.call({
              to: String(call.target),
              data: String(call.callData),
            }),
          });
        } catch (error) {
          if (!call.allowFailure) throw error;
          responses.push({ success: false, returnData: "0x" });
        }
      }
      return blockScanMulticallIface.encodeFunctionResult(
        "aggregate3",
        [responses],
      );
    }
    if (req.to.toLowerCase() === POOL.toLowerCase()) {
      if (selector === dodoV2PoolIface.getFunction("_BASE_TOKEN_")!.selector) {
        return dodoV2PoolIface.encodeFunctionResult("_BASE_TOKEN_", [BASE]);
      }
      if (selector === dodoV2PoolIface.getFunction("_QUOTE_TOKEN_")!.selector) {
        return dodoV2PoolIface.encodeFunctionResult("_QUOTE_TOKEN_", [QUOTE]);
      }
      if (selector === dodoV2PoolIface.getFunction("_BASE_RESERVE_")!.selector) {
        return dodoV2PoolIface.encodeFunctionResult(
          "_BASE_RESERVE_",
          [this.options.baseReserve ?? 1_000n],
        );
      }
      if (selector === dodoV2PoolIface.getFunction("_QUOTE_RESERVE_")!.selector) {
        return dodoV2PoolIface.encodeFunctionResult(
          "_QUOTE_RESERVE_",
          [this.options.quoteReserve ?? 2_000n],
        );
      }
      if (selector === dodoV2PoolIface.getFunction("getPMMStateForCall")!.selector) {
        return dodoV2PoolIface.encodeFunctionResult(
          "getPMMStateForCall",
          this.options.pmm ??
            [2n * 10n ** 18n, 0n, 1_000n, 2_000n, 1_000n, 2_000n, 0],
        );
      }
      if (selector === dodoV2PoolIface.getFunction("getUserFeeRate")!.selector) {
        const actor = String(
          dodoV2PoolIface.decodeFunctionData("getUserFeeRate", req.data)[0],
        );
        this.lastFeeActor = ethers.getAddress(actor);
        return dodoV2PoolIface.encodeFunctionResult(
          "getUserFeeRate",
          [0n, 0n],
        );
      }
      if (selector === dodoV2PoolIface.getFunction("getBaseInput")!.selector) {
        if (this.options.baseInputReverts) {
          throw new Error("execution reverted: SUB_UNDERFLOW");
        }
        return dodoV2PoolIface.encodeFunctionResult(
          "getBaseInput",
          [this.options.baseInput ?? 0n],
        );
      }
      if (selector === dodoV2PoolIface.getFunction("getQuoteInput")!.selector) {
        if (this.options.quoteInputReverts) {
          throw new Error("execution reverted: SUB_UNDERFLOW");
        }
        return dodoV2PoolIface.encodeFunctionResult(
          "getQuoteInput",
          [this.options.quoteInput ?? 0n],
        );
      }
      if (selector === dodoV2PoolIface.getFunction("getMtFeeTotal")!.selector) {
        if (!this.options.mtFeeTotal) {
          throw new Error("execution reverted: selector not implemented");
        }
        return dodoV2PoolIface.encodeFunctionResult(
          "getMtFeeTotal",
          this.options.mtFeeTotal,
        );
      }
      if (selector === dodoV2PoolIface.getFunction("querySellBase")!.selector) {
        const decoded = dodoV2PoolIface.decodeFunctionData("querySellBase", req.data);
        const amount = BigInt(decoded[1]);
        if (
          this.options.queryReverts ||
          (
            this.options.exactQueryInput !== undefined &&
            amount !== this.options.exactQueryInput
          )
        ) {
          throw new Error("execution reverted: no positive DODO probe");
        }
        this.lastQueryActor = ethers.getAddress(String(decoded[0]));
        this.queryCalls++;
        this.lastBaseQueryInput = amount;
        return ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256"],
          [
            this.options.queryReturnsZero
              ? 0n
              : this.options.queryAmountOut ?? amount * 2n,
            0n,
          ],
        );
      }
      if (selector === dodoV2PoolIface.getFunction("querySellQuote")!.selector) {
        const decoded = dodoV2PoolIface.decodeFunctionData("querySellQuote", req.data);
        const amount = BigInt(decoded[1]);
        if (
          this.options.queryReverts ||
          (
            this.options.exactQueryInput !== undefined &&
            amount !== this.options.exactQueryInput
          )
        ) {
          throw new Error("execution reverted: no positive DODO probe");
        }
        this.lastQueryActor = ethers.getAddress(String(decoded[0]));
        this.queryCalls++;
        return ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256", "uint256", "uint256"],
          [
            this.options.queryReturnsZero
              ? 0n
              : this.options.queryAmountOut ?? amount / 2n,
            0n,
            0n,
            0n,
          ],
        );
      }
    }
    if (req.to.toLowerCase() === BASE.toLowerCase() && selector === erc20Iface.getFunction("balanceOf")!.selector) {
      this.balanceCalls++;
      return erc20Iface.encodeFunctionResult(
        "balanceOf",
        [this.options.baseBalance ?? 1_000n],
      );
    }
    if (req.to.toLowerCase() === QUOTE.toLowerCase() && selector === erc20Iface.getFunction("balanceOf")!.selector) {
      this.balanceCalls++;
      return erc20Iface.encodeFunctionResult(
        "balanceOf",
        [this.options.quoteBalance ?? 2_000n],
      );
    }
    if (
      (req.to.toLowerCase() === BASE.toLowerCase() ||
        req.to.toLowerCase() === QUOTE.toLowerCase()) &&
      selector === erc20Iface.getFunction("decimals")!.selector
    ) {
      return erc20Iface.encodeFunctionResult("decimals", [2]);
    }
    if (selector === factoryIface.getFunction("getDODOPool")!.selector) {
      return factoryIface.encodeFunctionResult(
        "getDODOPool",
        [req.to.toLowerCase() === REGISTRY.toLowerCase() ? [POOL] : []],
      );
    }
    throw new Error(`unexpected call ${req.to} ${selector}`);
  }
}

const previousQuoteActor = process.env.BOTVM_OWNER;
process.env.BOTVM_OWNER = QUOTE_ACTOR;
const backend = new Backend();
const adapter = PRODUCTION_ADAPTER_FAMILIES.routes().forFamily("custom-swap:dodo-v2");
const edges = await PRODUCTION_ADAPTER_FAMILIES.routes().buildEdges(
  { address: POOL, adapter: "dodo-v2", score: 9 },
  backend,
);
assert(edges.length === 2, `edge count ${edges.length}`);
assert(edges[0].tokenIn === ethers.getAddress(BASE), "base direction");
assert(edges[1].tokenIn === ethers.getAddress(QUOTE), "quote direction");
assert(edges.every((edge) => edge.score === 9), "score propagation");

for (const proofBoundary of [
  {
    label: "sell-base zero reserve only",
    sellBase: true,
    pmm: [100n, 0n, 100n, 0n, 100n, 100n, 0] as const,
  },
  {
    label: "sell-base zero target only",
    sellBase: true,
    pmm: [100n, 0n, 100n, 100n, 100n, 0n, 0] as const,
  },
  {
    label: "sell-quote zero reserve only",
    sellBase: false,
    pmm: [100n, 0n, 0n, 100n, 100n, 100n, 0] as const,
  },
  {
    label: "sell-quote zero target only",
    sellBase: false,
    pmm: [100n, 0n, 100n, 100n, 0n, 100n, 0] as const,
  },
]) {
  const [i, K, B, Q, B0, Q0, R] = proofBoundary.pmm;
  const selected = selectDodoBlockScanProbeInput({
    oneToken: 1n,
    currentInput: 0n,
    reserve: proofBoundary.sellBase ? B : Q,
    pmm: { i, K, B, Q, B0, Q0, R },
    sellBase: proofBoundary.sellBase,
    pool: POOL,
  });
  assert(
    typeof selected === "bigint" ||
      selected.kind !== "provably-unavailable",
    `${proofBoundary.label} is not a whole-domain proof`,
  );
}

for (const R of [0, 1, 2] as const) {
  for (const sellBase of [true, false]) {
    const selected = selectDodoBlockScanProbeInput({
      oneToken: 1n,
      currentInput: 0n,
      reserve: 0n,
      pmm: {
        i: 10n ** 18n,
        K: 10n ** 18n / 2n,
        B: 0n,
        Q: 0n,
        B0: 0n,
        Q0: 0n,
        R,
      },
      sellBase,
      pool: POOL,
    });
    assert(
      typeof selected !== "bigint" &&
        selected.kind === "provably-unavailable",
      `R=${R} ${sellBase ? "sell-base" : "sell-quote"} double-zero output proof`,
    );
  }
}

const amountOut = await adapter.quoteExact({
  state: backend as never,
  target: POOL,
  edgeAdapterId: "dodo-v2-swap",
  tokenIn: BASE,
  tokenOut: QUOTE,
  amountIn: 200n,
  edge: edges[0],
});
assert(amountOut === 400n, `getBaseInput-aware amountOut ${amountOut}`);
assert(
  backend.lastBaseQueryInput === 200n,
  `GSP-compatible query input ${String(backend.lastBaseQueryInput)}`,
);
assert(backend.balanceCalls === 2, "exact quote proves both input ledgers");
assert(
  backend.lastQueryActor === ethers.getAddress(QUOTE_ACTOR),
  "exact quote uses the runtime quote actor",
);

const prepared = await adapter.prepared!.quote!({
  request: {
    adapterId: "dodo-v2-swap",
    target: POOL,
    tokenIn: BASE,
    tokenOut: QUOTE,
    amountIn: 200n,
  },
  edge: edges[0],
  async callPrepared(to, data) {
    return { output: await backend.call({ to, data }), latencyMs: 1 };
  },
  readChain: (req) => backend.call(req),
});
assert(prepared.amountOut === amountOut, `prepared quote ${prepared.amountOut}`);
assert(
  backend.lastBaseQueryInput === 200n,
  `prepared GSP-compatible query input ${String(backend.lastBaseQueryInput)}`,
);
assert(
  Number(backend.balanceCalls) === 4,
  "prepared quote proves both input ledgers",
);
assert(
  backend.lastQueryActor === ethers.getAddress(QUOTE_ACTOR),
  "prepared quote uses the runtime quote actor",
);

const legacyDeficitBackend = new Backend({
  baseBalance: 900n,
  baseInputReverts: true,
});
const legacyDeficitOut = await adapter.quoteExact({
  state: legacyDeficitBackend as never,
  target: POOL,
  edgeAdapterId: "dodo-v2-swap",
  tokenIn: BASE,
  tokenOut: QUOTE,
  amountIn: 200n,
  edge: edges[0],
});
assert(legacyDeficitOut === 200n, `legacy deficit amountOut ${legacyDeficitOut}`);
assert(
  legacyDeficitBackend.lastBaseQueryInput === 100n,
  `legacy post-transfer input ${String(legacyDeficitBackend.lastBaseQueryInput)}`,
);
const legacyDeficitPrepared = await adapter.prepared!.quote!({
  request: {
    adapterId: "dodo-v2-swap",
    target: POOL,
    tokenIn: BASE,
    tokenOut: QUOTE,
    amountIn: 200n,
  },
  edge: edges[0],
  async callPrepared(to, data) {
    return {
      output: await legacyDeficitBackend.call({ to, data }),
      latencyMs: 1,
    };
  },
  readChain: (req) => legacyDeficitBackend.call(req),
});
assert(
  legacyDeficitPrepared.amountOut === 200n,
  `prepared legacy deficit amountOut ${legacyDeficitPrepared.amountOut}`,
);
assert(
  legacyDeficitBackend.lastBaseQueryInput === 100n,
  `prepared legacy post-transfer input ${
    String(legacyDeficitBackend.lastBaseQueryInput)
  }`,
);

let unprovenGetterFailureRejected = false;
try {
  await adapter.quoteExact({
    state: new Backend({ baseInputReverts: true }) as never,
    target: POOL,
    edgeAdapterId: "dodo-v2-swap",
    tokenIn: BASE,
    tokenOut: QUOTE,
    amountIn: 200n,
    edge: edges[0],
  });
} catch (error) {
  unprovenGetterFailureRejected =
    error instanceof Error &&
    error.message.includes("without a proven deficit");
}
assert(
  unprovenGetterFailureRejected,
  "an allow-failure input getter is never interpreted as zero",
);

const gspDeficitBackend = new Backend({
  baseBalance: 1_050n,
  baseInputReverts: true,
  mtFeeTotal: [100n, 0n],
});
const gspDeficitOut = await adapter.quoteExact({
  state: gspDeficitBackend as never,
  target: POOL,
  edgeAdapterId: "dodo-v2-swap",
  tokenIn: BASE,
  tokenOut: QUOTE,
  amountIn: 200n,
  edge: edges[0],
});
assert(gspDeficitOut === 300n, `GSP MT-fee deficit amountOut ${gspDeficitOut}`);
assert(
  gspDeficitBackend.lastBaseQueryInput === 150n,
  `GSP post-transfer input deducts MT fee ${String(gspDeficitBackend.lastBaseQueryInput)}`,
);

const sourceBlock = 22_000_000;
const sourceBlockHash = `0x${"11".repeat(32)}`;
const signal = new AbortController().signal;
let schema = await dodoV2BlockScanState.compileStaticSchema({
  edges,
  deadlineAtMs: Date.now() + 10_000,
  signal,
});
const staticReads = dodoV2BlockScanState.buildStaticSchemaReads({
  sourceBlock,
  sourceBlockHash,
  schema,
  edges,
});
const staticResults = await readState(staticReads, backend);
schema = dodoV2BlockScanState.hydrateStaticSchema(schema, staticResults);
const currentReads = dodoV2BlockScanState.buildCurrentBlockReads({
  sourceBlock,
  sourceBlockHash,
  schema,
  edges,
});
const queryCallsBeforeBlockScan = backend.queryCalls;
const currentResults = await readState(currentReads, backend);
assert(
  backend.lastFeeActor === ethers.getAddress(QUOTE_ACTOR),
  "block-scan fee read uses the runtime quote actor",
);
const dependent = dodoV2BlockScanState.buildDependentBlockReads({
  sourceBlock,
  sourceBlockHash,
  schema,
  edges,
  completedRound: 0,
  priorResults: currentResults,
});
assert(dependent.length === 0, `ordinary PMM emitted ${dependent.length} query reads`);
assert(
  backend.queryCalls === queryCallsBeforeBlockScan,
  "ordinary block-scan PMM state performs no querySell call",
);
const snapshot = dodoV2BlockScanState.decodeState(schema, currentResults);
const mids = dodoV2BlockScanState.deriveMids(snapshot, edges);
assert(mids.size === 2, `locally derived DODO mids ${mids.size}/2`);

const ambiguityBackend = new Backend({
  baseBalance: 1_001n,
  quoteBalance: 2_001n,
  baseInput: 1n,
  quoteInput: 1n,
  pmm: [10n ** 18n, 1n, 100n, 100n, 1n, 1n, 0],
});
const ambiguityResults = await readState(currentReads, ambiguityBackend);
const ambiguityReads = dodoV2BlockScanState.buildDependentBlockReads({
  sourceBlock,
  sourceBlockHash,
  schema,
  edges,
  completedRound: 0,
  priorResults: ambiguityResults,
});
assert(
  ambiguityReads.length === 2,
  `bytecode-dependent PMM branches emitted ${ambiguityReads.length}/2 fallbacks`,
);
const ambiguityFallbacks = await readState(ambiguityReads, ambiguityBackend);
const ambiguitySnapshot = dodoV2BlockScanState.decodeState(
  schema,
  Object.freeze([...ambiguityResults, ...ambiguityFallbacks]),
);
assert(
  dodoV2BlockScanState.deriveMids(ambiguitySnapshot, edges).size === 2,
  "bytecode-dependent PMM branches decode real query fallbacks",
);

const zeroInputAboveOneBackend = new Backend({
  baseBalance: 0n,
  quoteBalance: 200n,
  baseReserve: 0n,
  quoteReserve: 200n,
  exactQueryInput: 100n,
  queryAmountOut: 100n,
  pmm: [
    10n ** 18n,
    10n ** 18n / 2n,
    0n,
    200n,
    100n,
    100n,
    1,
  ],
});
const zeroInputResults = await readState(
  currentReads,
  zeroInputAboveOneBackend,
);
const zeroInputDependent = dodoV2BlockScanState.buildDependentBlockReads({
  sourceBlock,
  sourceBlockHash,
  schema,
  edges,
  completedRound: 0,
  priorResults: zeroInputResults,
});
const zeroInputSnapshot = dodoV2BlockScanState.decodeState(
  schema,
  Object.freeze([
    ...zeroInputResults,
    ...await readState(zeroInputDependent, zeroInputAboveOneBackend),
  ]),
);
const zeroInputMids = dodoV2BlockScanState.deriveMids(
  zeroInputSnapshot,
  edges,
);
assert(
  zeroInputMids.has(blockScanEdgeKey(edges[0])),
  "zero input-side reserve remains a positively quoted sell-base edge",
);
const zeroInputBaseMid = zeroInputMids.get(blockScanEdgeKey(edges[0]))!;
assert(
  zeroInputAboveOneBackend.lastBaseQueryInput === 100n,
  "bounded probe reaches the exact PMM crossing after smaller candidates revert",
);
assert(
  zeroInputBaseMid.reserveA === 1_000_000n &&
    zeroInputBaseMid.reserveB === 1_000_000n,
  "bounded probe publishes the crossing transfer/output pair",
);

for (const failure of [
  { label: "revert", options: { queryReverts: true } },
  { label: "zero", options: { queryReturnsZero: true } },
] as const) {
  const unresolvedZeroInputBackend = new Backend({
    ...failure.options,
    baseBalance: 0n,
    quoteBalance: 200n,
    baseReserve: 0n,
    quoteReserve: 200n,
    pmm: [
      10n ** 18n,
      10n ** 18n / 2n,
      0n,
      200n,
      100n,
      100n,
      1,
    ],
  });
  const unresolvedZeroInputResults = await readState(
    currentReads,
    unresolvedZeroInputBackend,
  );
  const unresolvedZeroInputDependent =
    dodoV2BlockScanState.buildDependentBlockReads({
      sourceBlock,
      sourceBlockHash,
      schema,
      edges,
      completedRound: 0,
      priorResults: unresolvedZeroInputResults,
    });
  let unresolvedProbeRejected = false;
  try {
    dodoV2BlockScanState.decodeState(
      schema,
      Object.freeze([
        ...unresolvedZeroInputResults,
        ...await readState(
          unresolvedZeroInputDependent,
          unresolvedZeroInputBackend,
        ),
      ]),
    );
  } catch (error) {
    unresolvedProbeRejected = /found no positive quote/.test(String(error));
  }
  assert(
    unresolvedProbeRejected,
    `${failure.label} bounded probes remain unresolved instead of deleting the edge`,
  );
}

const zeroOutputDomainBackend = new Backend({
  baseBalance: 0n,
  quoteBalance: 0n,
  baseReserve: 0n,
  quoteReserve: 0n,
  pmm: [
    10n ** 17n,
    10n ** 18n,
    0n,
    0n,
    0n,
    0n,
    0,
  ],
});
const zeroOutputDomainResults = await readState(
  currentReads,
  zeroOutputDomainBackend,
);
assert(
  dodoV2BlockScanState.buildDependentBlockReads({
    sourceBlock,
    sourceBlockHash,
    schema,
    edges,
    completedRound: 0,
    priorResults: zeroOutputDomainResults,
  }).length === 0,
  "zero output reserve+target needs no heuristic quote proof",
);
const zeroOutputDomainSnapshot = dodoV2BlockScanState.decodeState(
  schema,
  zeroOutputDomainResults,
);
assert(
  dodoV2BlockScanState.deriveMids(
    zeroOutputDomainSnapshot,
    edges,
  ).size === 0,
  "zero output reserve+target publishes no false mid",
);
assert(
  dodoV2BlockScanState.behaviorProvenUnavailableEdges(
    zeroOutputDomainSnapshot,
    edges,
  ).size === 2,
  "zero output reserve+target proves both directions unavailable",
);

const oneSidedOutputDomainBackend = new Backend({
  baseBalance: 100n,
  quoteBalance: 0n,
  baseReserve: 100n,
  quoteReserve: 0n,
  pmm: [
    10n ** 18n,
    0n,
    100n,
    0n,
    100n,
    0n,
    0,
  ],
});
const oneSidedOutputResults = await readState(
  currentReads,
  oneSidedOutputDomainBackend,
);
const oneSidedOutputDependent =
  dodoV2BlockScanState.buildDependentBlockReads({
    sourceBlock,
    sourceBlockHash,
    schema,
    edges,
    completedRound: 0,
    priorResults: oneSidedOutputResults,
  });
const oneSidedOutputSnapshot = dodoV2BlockScanState.decodeState(
  schema,
  Object.freeze([
    ...oneSidedOutputResults,
    ...await readState(
      oneSidedOutputDependent,
      oneSidedOutputDomainBackend,
    ),
  ]),
);
assert(
  dodoV2BlockScanState.behaviorProvenUnavailableEdges(
    oneSidedOutputSnapshot,
    edges,
  ).size === 1,
  "one-sided zero output domain isolates one unavailable edge",
);
assert(
  dodoV2BlockScanState.deriveMids(
    oneSidedOutputSnapshot,
    edges,
  ).has(blockScanEdgeKey(edges[1])),
  "opposite DODO direction remains resolved",
);

const deficitCurrentResults = await readState(currentReads, legacyDeficitBackend);
const deficitDependent = dodoV2BlockScanState.buildDependentBlockReads({
  sourceBlock,
  sourceBlockHash,
  schema,
  edges,
  completedRound: 0,
  priorResults: deficitCurrentResults,
});
const deficitSnapshot = dodoV2BlockScanState.decodeState(
  schema,
  Object.freeze([
    ...deficitCurrentResults,
    ...await readState(deficitDependent, legacyDeficitBackend),
  ]),
);
assert(
  dodoV2BlockScanState.deriveMids(deficitSnapshot, edges).size === 2,
  "block-scan clears a proven pre-transfer deficit before local PMM quote",
);

const fragment = await adapter.buildPlanFragment({
  edge: edges[0],
  amountIn: 200n,
  amountOut,
  executor: ethers.ZeroAddress,
  state: backend as never,
});
assert(fragment.requirements[0]?.kind === "transfer-to-pool", "input transfer requirement");
assert(fragment.nodes[0]?.adapterId === "dodo-v2-swap", "DODO action node");
assert(fragment.nodes[0]?.params.sellBase === true, "sellBase direction");

const identity = await dodoV2IdentityResolver({
  backend,
  pool: ethers.getAddress(POOL),
  poolAdapter: "dodo-v2",
  candidate: { address: ethers.getAddress(POOL), adapter: "dodo-v2" },
  admissionPolicy: STRICT_IDENTITY_ADMISSION,
  isPoolAdapterSupported: (candidate) => candidate === "dodo-v2",
});
assert(identity.ok, "canonical registry identity");
assert(identity.ok && identity.factory === ethers.getAddress(REGISTRY), "registry provenance");
const unsupportedIdentity = await dodoV2IdentityResolver({
  backend,
  pool: ethers.getAddress(POOL),
  poolAdapter: "dodo-v2",
  candidate: { address: ethers.getAddress(POOL), adapter: "dodo-v2" },
  admissionPolicy: STRICT_IDENTITY_ADMISSION,
  isPoolAdapterSupported: () => false,
});
assert(
  !unsupportedIdentity.ok && unsupportedIdentity.reason === "unsupported_venue",
  "DODO registry identity must not imply runtime family support",
);

if (previousQuoteActor === undefined) {
  delete process.env.BOTVM_OWNER;
} else {
  process.env.BOTVM_OWNER = previousQuoteActor;
}

console.log(
  "dodo-v2 PASS (identity + graph + GSP-safe exact/prepared + local PMM/ambiguous-query fallback + plan)",
);

async function readState(
  reads: readonly StateRead[],
  state: Backend,
): Promise<readonly StateReadResult[]> {
  return Object.freeze(await Promise.all(reads.map(async (read) =>
    Object.freeze({
      id: read.id,
      ok: true as const,
      sourceBlock: read.sourceBlock,
      sourceBlockHash: read.sourceBlockHash,
      provenance: Object.freeze({
        kind: "eip1898" as const,
        source: Object.freeze({
          number: read.sourceBlock,
          hash: read.sourceBlockHash,
          generation: 1,
        }),
        requireCanonical: true as const,
      }),
      data: await state.call({ to: read.to, data: read.data }),
    })
  )));
}

import { ethers } from "ethers";
import type { TokenQueryBackend } from "../planner/token-graph.js";
import type {
  StateRead,
  StateReadResult,
} from "../venues/blockscan-state-capability.js";
import { STRICT_IDENTITY_ADMISSION } from "../venues/admission.js";
import { dodoV2IdentityResolver } from "../venues/identity.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import {
  dodoV2BlockScanState,
  dodoV2PoolIface,
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
  readonly baseInput?: bigint;
  readonly quoteInput?: bigint;
  readonly baseInputReverts?: boolean;
  readonly quoteInputReverts?: boolean;
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
        return dodoV2PoolIface.encodeFunctionResult("_BASE_RESERVE_", [1_000n]);
      }
      if (selector === dodoV2PoolIface.getFunction("_QUOTE_RESERVE_")!.selector) {
        return dodoV2PoolIface.encodeFunctionResult("_QUOTE_RESERVE_", [2_000n]);
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
        this.lastQueryActor = ethers.getAddress(String(decoded[0]));
        this.queryCalls++;
        this.lastBaseQueryInput = amount;
        return ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256"],
          [amount * 2n, 0n],
        );
      }
      if (selector === dodoV2PoolIface.getFunction("querySellQuote")!.selector) {
        const decoded = dodoV2PoolIface.decodeFunctionData("querySellQuote", req.data);
        const amount = BigInt(decoded[1]);
        this.lastQueryActor = ethers.getAddress(String(decoded[0]));
        this.queryCalls++;
        return ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256", "uint256", "uint256"],
          [amount / 2n, 0n, 0n, 0n],
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

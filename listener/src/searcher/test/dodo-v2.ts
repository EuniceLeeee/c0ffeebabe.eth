import { ethers } from "ethers";
import type { TokenQueryBackend } from "../planner/token-graph.js";
import { STRICT_IDENTITY_ADMISSION } from "../venues/admission.js";
import { dodoV2IdentityResolver } from "../venues/identity.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import { dodoV2PoolIface } from "../venues/swaps/dodo-v2.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const POOL = "0x0000000000000000000000000000000000000D02";
const BASE = "0x00000000000000000000000000000000000000B0";
const QUOTE = "0x00000000000000000000000000000000000000C0";
const REGISTRY = "0x5336edE8F971339F6c0e304c66ba16F1296A2Fbe";
const erc20Iface = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);
const factoryIface = new ethers.Interface([
  "function getDODOPool(address baseToken,address quoteToken) view returns (address[] pools)",
]);

class Backend implements TokenQueryBackend {
  async call(req: { to: string; data: string }): Promise<string> {
    const selector = req.data.slice(0, 10);
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
      if (selector === dodoV2PoolIface.getFunction("querySellBase")!.selector) {
        const amount = BigInt(dodoV2PoolIface.decodeFunctionData("querySellBase", req.data)[1]);
        return ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256"],
          [amount * 2n, 0n],
        );
      }
      if (selector === dodoV2PoolIface.getFunction("querySellQuote")!.selector) {
        const amount = BigInt(dodoV2PoolIface.decodeFunctionData("querySellQuote", req.data)[1]);
        return ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256", "uint256", "uint256"],
          [amount / 2n, 0n, 0n, 0n],
        );
      }
    }
    if (req.to.toLowerCase() === BASE.toLowerCase() && selector === erc20Iface.getFunction("balanceOf")!.selector) {
      return erc20Iface.encodeFunctionResult("balanceOf", [900n]);
    }
    if (req.to.toLowerCase() === QUOTE.toLowerCase() && selector === erc20Iface.getFunction("balanceOf")!.selector) {
      return erc20Iface.encodeFunctionResult("balanceOf", [2_000n]);
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
assert(amountOut === 200n, `donation/deficit-aware amountOut ${amountOut}`);

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

console.log("dodo-v2 PASS (identity + graph + exact/prepared quote + plan)");

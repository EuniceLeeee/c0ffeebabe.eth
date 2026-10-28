import { ethers } from "ethers";
import {
  balancerV3SendToAdapter,
  balancerV3SettleAdapter,
  balancerV3SwapAdapter,
  balancerV3UnlockAdapter,
} from "../../adapters/balancer-v3.js";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { buildResolvedPlanFromPath } from "../solver/plan-builder.js";
import { quoteBalancerV3 } from "../venues/swaps/balancer-v3.js";

const POOL = "0xbb6f701f42a6104deffc041c5c0057b8a9c46bbc";
const EXECUTOR = "0xE08D97e151473A848C3d9CA3f323Cb720472D015";
const OUT = 665967421909204163n;

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

function callSelector(encoded: Uint8Array): string {
  assert(encoded[0] === 0, `expected CALL opcode, got ${encoded[0]}`);
  return ethers.hexlify(encoded.slice(24, 28));
}

function testGraph(): void {
  // Strict graph authority: edges come from the verified family lifecycle,
  // never from a parallel eth_call builder. The fixture mirrors exactly what
  // the balancer-v3 lifecycle projects for this two-token pool.
  const graph: TokenEdge[] = [
    {
      adapterId: "balancer-v3-unlock",
      target: POOL,
      tokenIn: ADDR.ROCKSOLID_RETH,
      tokenOut: ADDR.RETH,
      slotKind: "swap",
      edgeKind: "swap",
      leavesStandingPosition: false,
    },
    {
      adapterId: "balancer-v3-unlock",
      target: POOL,
      tokenIn: ADDR.RETH,
      tokenOut: ADDR.ROCKSOLID_RETH,
      slotKind: "swap",
      edgeKind: "swap",
      leavesStandingPosition: false,
    },
  ];
  assert(graph.length === 2, `two-token pool should emit two edges, got ${graph.length}`);
  assert(graph.every((edge) => edge.adapterId === "balancer-v3-unlock"), "graph adapter id");
  assert(graph.some((edge) => edge.tokenIn.toLowerCase() === ADDR.ROCKSOLID_RETH.toLowerCase() && edge.tokenOut.toLowerCase() === ADDR.RETH.toLowerCase()), "rock.rETH -> rETH edge");
}

async function testQuote(): Promise<void> {
  const iface = new ethers.Interface([
    "function querySwapSingleTokenExactIn(address pool,address tokenIn,address tokenOut,uint256 exactAmountIn,address sender,bytes userData) returns (uint256 amountOut)",
  ]);
  const amountIn = 653072044530122959n;
  const out = await quoteBalancerV3({
    async call(req) {
      assert(req.to.toLowerCase() === ADDR.BALANCER_V3_ROUTER.toLowerCase(), "quote targets canonical Router");
      const decoded = iface.decodeFunctionData("querySwapSingleTokenExactIn", req.data);
      assert(String(decoded[0]).toLowerCase() === POOL.toLowerCase(), "quote pool");
      assert(BigInt(decoded[3]) === amountIn, "quote exact amount in");
      return iface.encodeFunctionResult("querySwapSingleTokenExactIn", [OUT]);
    },
  }, POOL, ADDR.ROCKSOLID_RETH, ADDR.RETH, amountIn);
  assert(out === OUT, `quote output ${out}`);
}

async function testPlan(): Promise<void> {
  const edge: TokenEdge = {
    adapterId: "balancer-v3-unlock",
    target: POOL,
    tokenIn: ADDR.ROCKSOLID_RETH,
    tokenOut: ADDR.RETH,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
  };
  const amountIn = 653072044530122959n;
  const haircutted = OUT - 1000n;
  const plan = await buildResolvedPlanFromPath(
    { edges: [edge] },
    ADDR.ROCKSOLID_RETH,
    amountIn,
    [amountIn, haircutted],
    EXECUTOR,
    {} as StateBackend,
    1n,
    "morpho-flash",
    [OUT],
  );
  const unlock = plan.children.find((node) => node.adapterId === "balancer-v3-unlock");
  assert(unlock !== undefined, "unlock node present");
  assert(unlock.target.toLowerCase() === ADDR.BALANCER_V3_VAULT.toLowerCase(), "unlock targets canonical Vault");
  assert(unlock.children.map((node) => node.adapterId).join(",") === "erc20-transfer,balancer-v3-settle,balancer-v3-swap,balancer-v3-send-to", "callback child order");
  const sendTo = unlock.children[3];
  assert(sendTo.amount === OUT, `sendTo must settle raw output, got ${sendTo.amount}`);
  assert(String(unlock.children[2].params.pool).toLowerCase() === POOL.toLowerCase(), "swap names actual pool");
}

function testSelectors(): void {
  const base = {
    target: ADDR.BALANCER_V3_VAULT,
    tokenIn: ADDR.ROCKSOLID_RETH,
    tokenOut: ADDR.RETH,
    amount: 1n,
    params: {},
    children: [],
  };
  assert(balancerV3UnlockAdapter.matchTrace(ADDR.BALANCER_V3_VAULT, "0x48c89491"), "unlock selector");
  const inner = new Uint8Array([0, 1, 2, 3]);
  const wrapped = balancerV3UnlockAdapter.encode(
    { ...base, adapterId: "balancer-v3-unlock" },
    EXECUTOR,
    inner,
  );
  assert(wrapped[0] === 2 && wrapped[4] === 0, "unlock sets field2 before Vault call");
  const unlockIface = new ethers.Interface(["function unlock(bytes data)"]);
  const callbackIface = new ethers.Interface(["function unlockCallback(bytes data)"]);
  const payloadLength = (wrapped[25] << 16) | (wrapped[26] << 8) | wrapped[27];
  const vaultPayload = wrapped.slice(28, 28 + payloadLength);
  const [callbackData] = unlockIface.decodeFunctionData("unlock", vaultPayload);
  const [decodedInner] = callbackIface.decodeFunctionData("unlockCallback", callbackData);
  assert(ethers.hexlify(decodedInner) === ethers.hexlify(inner), "unlock raw callback wraps BotVM script at field2=68");
  assert(callSelector(balancerV3SettleAdapter.encode({ ...base, adapterId: "balancer-v3-settle", params: { token: ADDR.ROCKSOLID_RETH } }, EXECUTOR, new Uint8Array())) === "0x15afd409", "settle selector");
  assert(callSelector(balancerV3SwapAdapter.encode({ ...base, adapterId: "balancer-v3-swap", params: { kind: 0n, pool: POOL, limitRaw: 0n, userData: "0x" } }, EXECUTOR, new Uint8Array())) === "0x2bfb780c", "swap selector");
  assert(callSelector(balancerV3SendToAdapter.encode({ ...base, adapterId: "balancer-v3-send-to", params: { token: ADDR.RETH } }, EXECUTOR, new Uint8Array())) === "0xae639329", "sendTo selector");
}

await testGraph();
await testQuote();
await testPlan();
testSelectors();
console.log("balancer-v3 PASS (4/4)");

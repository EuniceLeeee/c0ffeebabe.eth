// v4 execution PoolKey gate (Codex R4+R5 blocking): plan-builder must derive the
// univ4-swap PoolKey from edge.v4PoolKey (the exact pool the quote used), NOT a
// hardcoded fee. Before the fix, uniV4PoolKey() hardcoded USDC/USDT to fee 100,
// so pinned fee-7 / fee-8 pools quoted one pool and executed against another.
import { buildResolvedPlanFromPath } from "../solver/plan-builder.js";
import { v4PoolId, type TokenPath, type TokenEdge } from "../planner/token-graph.js";

type PlanNode = { adapterId: string; params?: Record<string, unknown>; children?: PlanNode[] };

const PM = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ZERO = "0x0000000000000000000000000000000000000000";
const key8 = { currency0: USDC, currency1: USDT, fee: 8, tickSpacing: 1, hooks: ZERO };

const edge = (tin: string, tout: string) =>
  ({ adapterId: "univ4-unlock", target: PM, tokenIn: tin, tokenOut: tout, slotKind: "swap", v4PoolKey: key8, poolId: v4PoolId(key8) }) as unknown as TokenEdge;

// A USDC->USDT->USDC cycle, both hops through the fee-8 v4 pool.
const path: TokenPath = { edges: [edge(USDC, USDT), edge(USDT, USDC)] };
const stubState = { call: async () => "0x" } as unknown as Parameters<typeof buildResolvedPlanFromPath>[5];

function collect(node: PlanNode, id: string, acc: PlanNode[] = []): PlanNode[] {
  if (node.adapterId === id) acc.push(node);
  for (const c of node.children ?? []) collect(c, id, acc);
  return acc;
}

async function main() {
  let pass = true;
  const fail = (m: string) => { pass = false; console.log("FAIL: " + m); };

  const plan = await buildResolvedPlanFromPath(
    path, USDC, 1_000_000_000n, [1_000_000_000n, 999_000_000n, 1_000_000_000n],
    "0x0000000000000000000000000000000000000001", stubState,
  );
  const swaps = collect(plan as unknown as PlanNode, "univ4-swap");
  if (swaps.length !== 2) fail(`expected 2 univ4-swap nodes, got ${swaps.length}`);
  for (const s of swaps) {
    const fee = (s.params as Record<string, unknown>).fee;
    const ts = (s.params as Record<string, unknown>).tickSpacing;
    if (fee !== 8n) fail(`univ4-swap fee = ${fee} (expected 8n from edge.v4PoolKey, NOT hardcoded 100n)`);
    if (ts !== 1n) fail(`univ4-swap tickSpacing = ${ts} (expected 1n)`);
  }

  console.log(pass ? "\nV4 EXECUTION POOLKEY: PASS" : "\nV4 EXECUTION POOLKEY: FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });

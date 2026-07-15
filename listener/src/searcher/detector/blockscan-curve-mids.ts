import { ethers } from "ethers";
import type { TokenEdge } from "../planner/token-graph.js";
import type { PoolStateCache } from "../solver/pool-state-cache.js";
import type { ProtocolMid } from "./blockscan-scanner.js";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_CHUNK = 256;
const multicallIface = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)",
]);
const curveIntIface = new ethers.Interface([
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const curveUintIface = new ethers.Interface([
  "function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)",
]);

const LOCALLY_MODELLED_CURVE = new Set([
  "curve-exchange",
  "curve-exchange-nr",
  "curve-exchange-plain",
  "curve-exchange-received-uint",
]);

export interface BlockTaggedCaller {
  call(req: { to: string; data: string; blockTag: number }): Promise<string>;
}

export interface ExactCurveMidResult {
  mids: Map<string, ProtocolMid>;
  attempted: number;
  quoted: number;
  failed: number;
  deadlineHit: boolean;
}

interface CurveMidJob {
  key: string;
  edge: TokenEdge;
  amountIn: bigint;
  depthIn: bigint;
}

/** Batch exact get_dy probes for regular Curve routes at a pinned block. */
export async function buildExactBlockScanCurveMids(
  provider: BlockTaggedCaller,
  blockNumber: number,
  cache: PoolStateCache,
  edges: readonly TokenEdge[],
  deadlineAtMs: number,
): Promise<ExactCurveMidResult> {
  const jobs = collectJobs(cache, blockNumber, edges);
  const mids = new Map<string, ProtocolMid>();
  const pending = await runPass(provider, blockNumber, jobs, curveIntIface, mids, deadlineAtMs);
  const unresolved = Date.now() >= deadlineAtMs
    ? pending
    : await runPass(provider, blockNumber, pending, curveUintIface, mids, deadlineAtMs);
  return {
    mids,
    attempted: jobs.length,
    quoted: mids.size,
    failed: unresolved.length,
    deadlineHit: Date.now() >= deadlineAtMs,
  };
}

function collectJobs(
  cache: PoolStateCache,
  blockNumber: number,
  edges: readonly TokenEdge[],
): CurveMidJob[] {
  const jobs = new Map<string, CurveMidJob>();
  for (const edge of edges) {
    if (edge.slotKind !== "swap" || !LOCALLY_MODELLED_CURVE.has(edge.adapterId)) continue;
    if (edge.curveI === undefined || edge.curveJ === undefined) continue;
    const key = protocolKey(edge);
    if (jobs.has(key)) continue;
    const snapshot = cache.snapshotCurve(edge.target, blockNumber);
    if (!snapshot) continue;
    const reserveIn = snapshot.kind === "plain"
      ? snapshot.plain?.balances[edge.curveI]
      : snapshot.ng?.balances[edge.curveI];
    if (reserveIn === undefined || reserveIn <= 0n) continue;
    const amountIn = reserveIn / 1_000_000n > 0n ? reserveIn / 1_000_000n : 1n;
    jobs.set(key, { key, edge, amountIn, depthIn: reserveIn });
  }
  return [...jobs.values()];
}

async function runPass(
  provider: BlockTaggedCaller,
  blockNumber: number,
  jobs: CurveMidJob[],
  iface: ethers.Interface,
  mids: Map<string, ProtocolMid>,
  deadlineAtMs: number,
): Promise<CurveMidJob[]> {
  const unresolved: CurveMidJob[] = [];
  for (let offset = 0; offset < jobs.length; offset += MULTICALL_CHUNK) {
    const chunk = jobs.slice(offset, offset + MULTICALL_CHUNK);
    if (Date.now() >= deadlineAtMs) {
      unresolved.push(...jobs.slice(offset));
      break;
    }
    const data = multicallIface.encodeFunctionData("aggregate3", [
      chunk.map((job) => ({
        target: job.edge.target,
        allowFailure: true,
        callData: iface.encodeFunctionData("get_dy", [
          job.edge.curveI!,
          job.edge.curveJ!,
          job.amountIn,
        ]),
      })),
    ]);
    let decoded: Array<{ success: boolean; returnData: string }>;
    try {
      const raw = await provider.call({ to: MULTICALL3, data, blockTag: blockNumber });
      decoded = multicallIface.decodeFunctionResult("aggregate3", raw)[0] as Array<{
        success: boolean;
        returnData: string;
      }>;
    } catch {
      unresolved.push(...chunk);
      continue;
    }
    for (let i = 0; i < chunk.length; i++) {
      const result = decoded[i];
      if (!result?.success || result.returnData === "0x") {
        unresolved.push(chunk[i]);
        continue;
      }
      const amountOut = BigInt(result.returnData);
      const mid = Number(amountOut) / Number(chunk[i].amountIn);
      if (!Number.isFinite(mid) || mid <= 0) {
        unresolved.push(chunk[i]);
        continue;
      }
      mids.set(chunk[i].key, { mid, feeBps: 0, depthIn: chunk[i].depthIn });
    }
  }
  return unresolved;
}

function protocolKey(edge: TokenEdge): string {
  return `${edge.target.toLowerCase()}|${edge.tokenIn.toLowerCase()}|${edge.tokenOut.toLowerCase()}`;
}

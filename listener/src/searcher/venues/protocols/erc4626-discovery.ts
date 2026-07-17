import { ethers } from "ethers";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { TokenEdge } from "../../planner/token-graph.js";
import type {
  AttestedProtocolInstance,
  ProtocolCandidate,
  ProtocolDiscoveryCapability,
  ProtocolDiscoveryContext,
  ProtocolDiscoveryLog,
  ProtocolDiscoveryReceipt,
} from "../route-leg-adapter.js";

const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)",
]);
const WITHDRAW_TOPIC = ERC4626.getEvent("Withdraw")!.topicHash.toLowerCase();
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)").toLowerCase();
const REDEEM_SELECTOR = ethers.id("redeem(uint256,address,address)").slice(0, 10).toLowerCase();
const WITHDRAW_SELECTOR = ethers.id("withdraw(uint256,address,address)").slice(0, 10).toLowerCase();
const IMPLEMENTATION_SLOT = BigInt(
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
);
const LOG_BATCH = 2_000;

export interface Erc4626PayoutEvidence {
  readonly kind: "erc4626-withdraw-payout";
  readonly txHash: string;
  readonly blockNumber: number;
  readonly asset: string;
  readonly receiver: string;
  readonly assets: bigint;
  readonly shares: bigint;
  readonly codeHash: string;
  readonly implementationWord: string;
}

export const erc4626Discovery: ProtocolDiscoveryCapability = Object.freeze({
  async discoverCandidates(ctx) {
    const targets = new Map<string, { target: string; sources: Set<string>; logs: ProtocolDiscoveryLog[] }>();
    for (const token of ctx.candidateTokens) {
      try {
        const target = ethers.getAddress(token);
        targets.set(target.toLowerCase(), {
          target,
          sources: new Set(["graph-token"]),
          logs: [],
        });
      } catch {
        // Invalid graph metadata is not a protocol candidate.
      }
    }

    for (let start = ctx.fromBlock; start <= ctx.toBlock; start += LOG_BATCH) {
      const end = Math.min(ctx.toBlock, start + LOG_BATCH - 1);
      const logs = await ctx.backend.getLogs({
        topics: [WITHDRAW_TOPIC],
        fromBlock: start,
        toBlock: end,
      });
      for (const log of logs) {
        let target: string;
        try {
          target = ethers.getAddress(log.address);
        } catch {
          continue;
        }
        const key = target.toLowerCase();
        const current = targets.get(key) ?? {
          target,
          sources: new Set<string>(),
          logs: [],
        };
        current.sources.add("erc4626-withdraw-event");
        current.logs.push(log);
        targets.set(key, current);
      }
    }

    const values = [...targets.values()];
    const eventTargets = values.filter((item) => item.sources.has("erc4626-withdraw-event"));
    const graphOnlyTargets = values.filter((item) => !item.sources.has("erc4626-withdraw-event"));
    const candidates = await mapLimit(
      [
        ...eventTargets,
        ...graphOnlyTargets,
      ],
      24,
      async (item): Promise<ProtocolCandidate | null> => {
        const eventDerived = item.sources.has("erc4626-withdraw-event");
        let asset: string | null;
        try {
          asset = await readAsset(ctx, item.target);
        } catch (error) {
          // A graph token is only a speculative address candidate, so a missing
          // asset() is an ordinary negative. An event-derived target was already
          // enumerated from chain: losing it to a transient RPC failure and then
          // advancing the event cursor would be a permanent false negative.
          if (eventDerived && isRetryableSourceFailure(error)) throw error;
          asset = null;
        }
        if (!asset) return null;
        const evidence: Erc4626PayoutEvidence[] = [];
        for (const log of item.logs.slice(-3).reverse()) {
          // Receipt/trace/archive read failures must abort the source pass so the
          // caller retries the same block range. Semantic mismatches return null.
          const verified = await verifyWithdrawPayout(ctx, item.target, asset, log);
          if (verified) {
            evidence.push(verified);
            break;
          }
        }
        return {
          pool: { address: item.target, adapter: "erc4626", fixedTokenIn: asset },
          source: [...item.sources].sort().join("+"),
          evidence,
        };
      },
    );
    return candidates.filter((item): item is ProtocolCandidate => item !== null);
  },

  async probeCandidate(instance, ctx) {
    return probeErc4626Candidate(instance, ctx);
  },

  async candidateFromObservedCall(call, ctx) {
    const target = ethers.getAddress(call.target);
    const asset = await readAsset(ctx, target).catch(() => null);
    if (!asset) return null;
    const evidence = await erc4626EvidenceFromReceipt({
      context: ctx,
      target,
      receipt: call.receipt,
      txHash: call.txHash,
    });
    return {
      pool: { address: target, adapter: "erc4626" as const, fixedTokenIn: asset },
      source: "observed-calltrace",
      selector: call.selector,
      evidence: evidence ? [evidence] : [],
    };
  },
} satisfies ProtocolDiscoveryCapability);

export async function probeErc4626Candidate(
  instance: AttestedProtocolInstance,
  ctx: ProtocolDiscoveryContext,
): Promise<readonly TokenEdge[]> {
  const target = ethers.getAddress(instance.pool.address);
  const expectedAsset = ethers.getAddress(instance.pool.fixedTokenIn ?? ethers.ZeroAddress);
  if (expectedAsset === ethers.ZeroAddress) throw new Error("erc4626 candidate missing asset");
  const asset = await readAsset(ctx, target);
  if (asset.toLowerCase() !== expectedAsset.toLowerCase()) {
    throw new Error("erc4626 asset changed after identity attestation");
  }

  const graphTokens = new Set(ctx.graphTokens.map((token) => token.toLowerCase()));
  if (!graphTokens.has(target.toLowerCase()) && !graphTokens.has(asset.toLowerCase())) {
    throw new Error("erc4626 route is not loop-closable from the current graph");
  }

  const currentCodeHash = ethers.keccak256(await ctx.backend.getCode(target));
  const currentImplementationWord = (await ctx.backend.getStorageAt(target, IMPLEMENTATION_SLOT)).toLowerCase();
  const payoutEvidence = instance.evidence.find((item): item is Erc4626PayoutEvidence =>
    isPayoutEvidence(item) &&
    item.asset.toLowerCase() === asset.toLowerCase() &&
    item.codeHash.toLowerCase() === currentCodeHash.toLowerCase() &&
    item.implementationWord.toLowerCase() === currentImplementationWord
  );
  if (!payoutEvidence) {
    throw new Error("erc4626 redeem payout token lacks receipt evidence for current implementation");
  }

  const sampleAssets = payoutEvidence.assets > 0n ? payoutEvidence.assets : 1n;
  const sampleShares = payoutEvidence.shares > 0n ? payoutEvidence.shares : 1n;
  const previewDeposit = await callUint(ctx, target, "previewDeposit", [sampleAssets]);
  const previewRedeem = await callUint(ctx, target, "previewRedeem", [sampleShares]);
  if (previewDeposit <= 0n || previewRedeem <= 0n) {
    throw new Error("erc4626 preview returned zero for receipt-derived sample");
  }

  return [
    protocolEdge("erc4626-deposit", target, asset, target, "wrap", instance.pool.score),
    protocolEdge("erc4626-redeem", target, target, asset, "redeem", instance.pool.score),
  ];
}

export async function erc4626EvidenceFromReceipt(input: {
  context: ProtocolDiscoveryContext;
  target: string;
  receipt: ProtocolDiscoveryReceipt;
  txHash: string;
}): Promise<Erc4626PayoutEvidence | null> {
  const target = ethers.getAddress(input.target);
  const asset = await readAsset(input.context, target).catch(() => null);
  if (!asset) return null;
  const withdraw = [...input.receipt.logs].reverse().find((log) =>
    log.address.toLowerCase() === target.toLowerCase() &&
    log.topics[0]?.toLowerCase() === WITHDRAW_TOPIC
  );
  if (!withdraw) return null;
  return verifyWithdrawPayout(
    input.context,
    target,
    asset,
    { ...withdraw, transactionHash: input.txHash },
    input.receipt,
  );
}

async function verifyWithdrawPayout(
  ctx: ProtocolDiscoveryContext,
  target: string,
  asset: string,
  log: ProtocolDiscoveryLog,
  knownReceipt?: ProtocolDiscoveryReceipt,
): Promise<Erc4626PayoutEvidence | null> {
  if (log.topics[0]?.toLowerCase() !== WITHDRAW_TOPIC || log.topics.length < 4) return null;
  const txHash = log.transactionHash;
  if (!txHash) return null;
  const receiver = ethers.getAddress(`0x${log.topics[2].slice(-40)}`);
  const [assets, shares] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], log.data);
  const receipt = knownReceipt ?? await ctx.backend.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) return null;
  const paid = receipt.logs.some((item) => {
    if (item.address.toLowerCase() !== asset.toLowerCase()) return false;
    if (item.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || item.topics.length < 3) return false;
    const from = `0x${item.topics[1].slice(-40)}`.toLowerCase();
    if (from !== target.toLowerCase()) return false;
    const to = `0x${item.topics[2].slice(-40)}`.toLowerCase();
    if (to !== receiver.toLowerCase()) return false;
    try {
      return BigInt(item.data) >= BigInt(assets);
    } catch {
      return false;
    }
  });
  if (!paid) return null;
  const trace = await ctx.backend.traceTransaction(txHash);
  if (!trace || !traceHasCausalExit(trace, target, receiver, BigInt(assets), BigInt(shares))) {
    return null;
  }
  const evidenceBlock = log.blockNumber;
  if (!Number.isSafeInteger(evidenceBlock) || evidenceBlock === undefined || evidenceBlock < 0) return null;
  const code = await ctx.backend.getCodeAt(target, evidenceBlock);
  if (code === "0x") return null;
  return {
    kind: "erc4626-withdraw-payout",
    txHash,
    blockNumber: evidenceBlock,
    asset,
    receiver,
    assets: BigInt(assets),
    shares: BigInt(shares),
    codeHash: ethers.keccak256(code),
    implementationWord: (
      await ctx.backend.getStorageAtBlock(target, IMPLEMENTATION_SLOT, evidenceBlock)
    ).toLowerCase(),
  };
}

async function readAsset(ctx: ProtocolDiscoveryContext, target: string): Promise<string> {
  const raw = await ctx.backend.call({ to: target, data: ERC4626.encodeFunctionData("asset") });
  return ethers.getAddress(String(ERC4626.decodeFunctionResult("asset", raw)[0]));
}

async function callUint(
  ctx: ProtocolDiscoveryContext,
  target: string,
  fn: "previewDeposit" | "previewRedeem",
  args: readonly bigint[],
): Promise<bigint> {
  const raw = await ctx.backend.call({ to: target, data: ERC4626.encodeFunctionData(fn, args) });
  return BigInt(ERC4626.decodeFunctionResult(fn, raw)[0]);
}

function protocolEdge(
  adapterId: "erc4626-deposit" | "erc4626-redeem",
  target: string,
  tokenIn: string,
  tokenOut: string,
  protocolAction: "wrap" | "redeem",
  score?: number,
): TokenEdge {
  return {
    adapterId,
    target,
    tokenIn,
    tokenOut,
    slotKind: "protocol",
    protocolAction,
    score,
    ...deriveEdgeTaxonomy("protocol", protocolAction),
  };
}

function isPayoutEvidence(value: unknown): value is Erc4626PayoutEvidence {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Erc4626PayoutEvidence>;
  return item.kind === "erc4626-withdraw-payout" &&
    typeof item.asset === "string" &&
    typeof item.codeHash === "string" &&
    typeof item.implementationWord === "string" &&
    typeof item.assets === "bigint" &&
    typeof item.shares === "bigint";
}

function traceHasCausalExit(
  trace: unknown,
  target: string,
  receiver: string,
  assets: bigint,
  shares: bigint,
): boolean {
  const visit = (node: unknown, ancestorFailed: boolean): boolean => {
    if (!node || typeof node !== "object") return false;
    const call = node as { to?: unknown; input?: unknown; error?: unknown; calls?: unknown };
    const failed = ancestorFailed || Boolean(call.error);
    if (!failed && typeof call.to === "string" && typeof call.input === "string") {
      const input = call.input.toLowerCase();
      if (call.to.toLowerCase() === target.toLowerCase() && input.length >= 10 + 64 * 3) {
        const selector = input.slice(0, 10);
        const amount = BigInt(`0x${input.slice(10, 74)}`);
        const decodedReceiver = `0x${input.slice(74, 138).slice(-40)}`;
        if (
          decodedReceiver.toLowerCase() === receiver.toLowerCase() &&
          ((selector === REDEEM_SELECTOR && amount === shares) ||
            (selector === WITHDRAW_SELECTOR && amount === assets))
        ) return true;
      }
    }
    return Array.isArray(call.calls) && call.calls.some((child) => visit(child, failed));
  };
  return visit(trace, false);
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await work(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function isRetryableSourceFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  // Contract-level negatives are ordinary candidate rejection. Transport,
  // timeout and server failures must leave the source cursor retryable.
  return code !== "CALL_EXCEPTION" && code !== "BAD_DATA" && code !== "INVALID_ARGUMENT";
}

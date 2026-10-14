import type { DiscoverySemantics, UnifiedObservation } from "../../adapter-family-plugin.js";
import { ABI, AQUA, address, binding, decodeOrder, key, order, encodeOrder } from "./codec.js";
import type { Candidate } from "./types.js";
export const SHIP = "aqua-ship-call", SWAP = "aqua-swap-call", SHIPPED = "aqua-shipped-log", SWAPPED = "aqua-swapped-log";
function candidate(router: string, o: Parameters<typeof order>[0], tokens: readonly string[]): Candidate {
  return { candidateKind: "aqua-registered-strategy", ...binding(router, order(o), tokens) };
}
export function decodeSwapLog(o: { topics: readonly string[]; data: string }) {
  try {
    if (o.topics.length !== 1 || o.topics[0].toLowerCase() !== ABI.getEvent("Swapped")!.topicHash) return null;
    const a = ABI.decodeEventLog("Swapped", o.data, [...o.topics]);
    if (ABI.encodeEventLog(ABI.getEvent("Swapped")!, a).data.toLowerCase() !== o.data.toLowerCase()) return null;
    const tokenIn = address(a.tokenIn), tokenOut = address(a.tokenOut);
    if (tokenIn === tokenOut || a.amountIn <= 0n || a.amountOut <= 0n) return null;
    return { orderHash: a.orderHash.toLowerCase(), maker: address(a.maker), taker: address(a.taker), tokenIn, tokenOut,
      amountIn: BigInt(a.amountIn), amountOut: BigInt(a.amountOut) };
  } catch { return null; }
}
function decodeCall(o: UnifiedObservation, id: string): Candidate | null {
  if (o.kind !== "call") return null;
  try {
    if (id === SHIP && address(o.target) === AQUA) {
      const a = ABI.decodeFunctionData("ship", o.data), value = decodeOrder(a.strategy);
      if (ABI.encodeFunctionData("ship", a).toLowerCase() !== o.data.toLowerCase() ||
          (o.sender && address(o.sender) !== value.maker) || a.tokens.length !== 2 || a.amounts.length !== 2) return null;
      return candidate(a.app, value, [...a.tokens]);
    }
    if (id === SWAP) {
      const a = ABI.decodeFunctionData("swap", o.data);
      if (ABI.encodeFunctionData("swap", a).toLowerCase() !== o.data.toLowerCase() || a.amount <= 0n) return null;
      return candidate(o.target, { maker: a[0].maker, traits: a[0].traits.toString(), data: a[0].data }, [a.tokenIn, a.tokenOut]);
    }
  } catch { return null; } return null;
}
export const discovery = {
  evidenceChannel: "nominate", txSeedNominations: true, sources: ["landed-log", "observed-call"],
  logPatterns: [SHIPPED, SWAPPED].map((id, i) => { const e = ABI.getEvent(i === 0 ? "Shipped" : "Swapped")!;
    return { id, topic: e.topicHash as `0x${string}`, signature: e.format("sighash") }; }),
  callPatterns: [{ id: SHIP, selector: ABI.getFunction("ship")!.selector as `0x${string}`, signature: ABI.getFunction("ship")!.format("sighash"), candidateAddress: { from: "argument", index: 0 } },
    { id: SWAP, selector: ABI.getFunction("swap")!.selector as `0x${string}`, signature: ABI.getFunction("swap")!.format("sighash"), candidateAddress: { from: "call-target" } }],
  decodeCandidate: ({ observation, matchedPatternId }) => decodeCall(observation, matchedPatternId),
  candidateKey: (c: Candidate) => key(c), instanceNominationKey: c => key(c as Candidate),
  nominate: { async nominate({ nominations, source, provider }) {
    const out: UnifiedObservation[] = [], seen = new Set<string>();
    const receipts = new Map<string, Awaited<ReturnType<typeof provider.getTransactionReceipt>>>(), traces = new Map<string, unknown>();
    for (const n of nominations) {
      const opaque = n.opaque && typeof n.opaque === "object" && !Array.isArray(n.opaque) ? n.opaque as Readonly<Record<string, unknown>> : {};
      const tx = n.evidence?.transactionHash ?? opaque.transactionHash;
      if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx) || !provider.traceTransaction) continue;
      const hash = tx.toLowerCase(); if (!receipts.has(hash)) receipts.set(hash, await provider.getTransactionReceipt(hash));
      const receipt = receipts.get(hash), block = n.evidence?.blockNumber ?? opaque.blockNumber;
      if (!receipt || receipt.blockNumber === undefined || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber > source.number ||
          (block !== undefined && block !== receipt.blockNumber)) continue;
      if (!receipt.logs.some(l => l.topics[0]?.toLowerCase() === ABI.getEvent("Swapped")!.topicHash ||
          (l.address.toLowerCase() === AQUA && l.topics[0]?.toLowerCase() === ABI.getEvent("Shipped")!.topicHash))) continue;
      if (!traces.has(hash)) traces.set(hash, await provider.traceTransaction(hash));
      const raw = traces.get(hash) as { result?: unknown } | null;
      const stack: unknown[] = [raw && typeof raw === "object" && "result" in raw ? raw.result : raw]; let count = 0;
      while (stack.length) {
        if (++count > 10000) throw new Error("aqua trace frame limit");
        const f = stack.pop() as { type?: string; to?: string; from?: string; input?: string; error?: unknown; reverted?: boolean; calls?: unknown[] } | null;
        if (!f || typeof f !== "object" || f.error || f.reverted) continue;
        if (Array.isArray(f.calls)) stack.push(...f.calls);
        if (f.type?.toUpperCase() !== "CALL" || typeof f.to !== "string" || typeof f.input !== "string" || typeof f.from !== "string") continue;
        const observation: UnifiedObservation = { kind: "call", source, target: f.to, sender: f.from, data: f.input, transactionHash: hash };
        const id = f.input.slice(0, 10).toLowerCase() === ABI.getFunction("ship")!.selector ? SHIP : SWAP;
        const c = decodeCall(observation, id); if (!c || ![c.router, AQUA].includes(address(n.address))) continue;
        const confirmed = receipt.logs.some(l => {
          if (id === SWAP) { const v = decodeSwapLog(l); return l.address.toLowerCase() === c.router && v?.orderHash === c.strategyHash && v.maker === c.order.maker && c.tokens.includes(v.tokenIn) && c.tokens.includes(v.tokenOut); }
          try { const a = ABI.parseLog(l)?.args; return l.address.toLowerCase() === AQUA && l.topics[0]?.toLowerCase() === ABI.getEvent("Shipped")!.topicHash &&
            a?.app.toLowerCase() === c.router && a.maker.toLowerCase() === c.order.maker && a.strategyHash.toLowerCase() === c.strategyHash && a.strategy.toLowerCase() === encodeOrder(c.order).toLowerCase(); } catch { return false; }
        });
        const k = hash + ":" + key(c);
        if (confirmed && !seen.has(k)) { seen.add(k); out.push(observation); }
      }
    } return out;
  } },
  reverseBinding: { kind: "explicitly-unsupported", reason: "A cold router/registry address does not identify a strategy. Real registered order calldata nominates; identity reverse-checks its hash and both Aqua token registrations." },
} satisfies DiscoverySemantics<Candidate>;

import type { DiscoverySemantics, UnifiedObservation } from "../../adapter-family-plugin.js";
import { ABI, address, pair, key } from "./codec.js";
import type { Candidate } from "./types.js";
export const LOG = "vault-spot-swap-log", CALL = "vault-spot-swap-call";
export function decodeSwapLog(o: { topics: readonly string[]; data: string }) {
  try {
    if (o.topics.length !== 1 || o.topics[0].toLowerCase() !== ABI.getEvent("Swap")!.topicHash) return null;
    const a = ABI.decodeEventLog("Swap", o.data, [...o.topics]);
    if (ABI.encodeEventLog(ABI.getEvent("Swap")!, a).data.toLowerCase() !== o.data.toLowerCase()) return null;
    const account = address(a.account), tokenIn = address(a.tokenIn), tokenOut = address(a.tokenOut);
    if (tokenIn === tokenOut || a.amountIn <= 0n || a.amountOutAfterFees <= 0n || a.feeBasisPoints >= 10000n ||
        a.amountOutAfterFees !== a.amountOut * (10000n - a.feeBasisPoints) / 10000n) return null;
    return { account, tokenIn, tokenOut, amountIn: BigInt(a.amountIn), amountOut: BigInt(a.amountOutAfterFees),
      gross: BigInt(a.amountOut), feeBasisPoints: BigInt(a.feeBasisPoints) };
  } catch { return null; }
}
function candidate(vault: string, a: string, b: string): Candidate {
  const p = pair(vault, [a, b]);
  return { candidateKind: "vault-spot-pair", vault: p.vault, tokens: p.tokens };
}
export const discovery = {
  evidenceChannel: "nominate", txSeedNominations: true, sources: ["landed-log", "observed-call"],
  logPatterns: [{ id: LOG, topic: ABI.getEvent("Swap")!.topicHash as `0x${string}`, signature: ABI.getEvent("Swap")!.format("sighash") }],
  callPatterns: [{ id: CALL, selector: ABI.getFunction("swap")!.selector as `0x${string}`,
    signature: ABI.getFunction("swap")!.format("sighash"), candidateAddress: { from: "call-target" } }],
  decodeCandidate({ observation: o, matchedPatternId: id }) {
    try {
      if (o.kind === "log" && id === LOG) {
        const s = decodeSwapLog(o); return s ? candidate(o.address, s.tokenIn, s.tokenOut) : null;
      }
      if (o.kind === "call" && id === CALL) {
        const a = ABI.decodeFunctionData("swap", o.data); address(a.receiver);
        return ABI.encodeFunctionData("swap", a).toLowerCase() === o.data.toLowerCase() ? candidate(o.target, a.tokenIn, a.tokenOut) : null;
      }
    } catch { return null; }
    return null;
  },
  candidateKey: c => key(pair(c.vault, c.tokens)),
  instanceNominationKey: c => { const value = c as Candidate; return key(pair(value.vault, value.tokens)); },
  nominate: { async nominate({ nominations, source, provider }) {
    const out: UnifiedObservation[] = [];
    const receipts = new Map<string, Awaited<ReturnType<typeof provider.getTransactionReceipt>>>();
    for (const n of nominations) {
      // Startup strict passes the source candidate as opaque; direct capture
      // may also supply the optional observation coordinates separately.
      const opaque = n.opaque && typeof n.opaque === "object" && !Array.isArray(n.opaque)
        ? n.opaque as Readonly<Record<string, unknown>> : {};
      const tx = n.evidence?.transactionHash ?? opaque.transactionHash;
      if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx)) continue;
      const hash = tx.toLowerCase();
      if (!receipts.has(hash)) receipts.set(hash, await provider.getTransactionReceipt(hash));
      const receipt = receipts.get(hash);
      if (!receipt || receipt.blockNumber === undefined || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber > source.number) continue;
      const expectedBlock = n.evidence?.blockNumber ?? opaque.blockNumber;
      if (expectedBlock !== undefined && expectedBlock !== receipt.blockNumber) continue;
      for (const log of receipt.logs) {
        const swap = decodeSwapLog(log);
        if (!swap || address(log.address) !== address(n.address)) continue;
        if (opaque.tokens !== undefined) {
          if (!Array.isArray(opaque.tokens) || opaque.tokens.some(t => typeof t !== "string")) continue;
          if (key(pair(log.address, opaque.tokens as string[])) !== key(pair(log.address, [swap.tokenIn, swap.tokenOut]))) continue;
        }
        out.push({ kind: "log", source, ...log, transactionHash: hash });
      }
    }
    return out;
  } },
  reverseBinding: { kind: "explicitly-unsupported", reason: "A cold Vault address does not identify a market; real pair observations nominate, and identity reverse-checks each token and Vault registration." },
} satisfies DiscoverySemantics<Candidate>;

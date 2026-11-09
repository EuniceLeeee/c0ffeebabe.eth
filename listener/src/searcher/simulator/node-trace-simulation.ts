import { toBeHex, toQuantity } from "ethers";
import type { NodeObservation } from "./node-program-quote.js";
import type { PinnedNodeRpc } from "./node-input-funding.js";

const bytes = (s: unknown): s is string => typeof s === "string" && /^0x(?:[a-f0-9]{2})*$/i.test(s);
const address = (s: unknown): s is string => typeof s === "string" && /^0x[a-f0-9]{40}$/i.test(s);
export function successfulTraceLogs(trace: any): { address: string; topics: string[]; data: string }[] {
  if (trace.error) return [];
  const logs = [], children = trace.calls ?? [];
  for (let i = 0; i <= children.length; i++) {
    for (const l of trace.logs ?? []) if (Number(l.position ?? children.length) === i) {
      if (!address(l.address) || !Array.isArray(l.topics) || !l.topics.every((t: unknown) => typeof t === "string" && /^0x[a-f0-9]{64}$/i.test(t)) || !bytes(l.data))
        throw new Error("invalid node trace log");
      logs.push({ address: l.address.toLowerCase(), topics: l.topics, data: l.data });
    }
    if (i < children.length) logs.push(...successfulTraceLogs(children[i]));
  }
  return logs;
}
export function nodeNestedHalt(trace: any): string | null {
  if (!trace || typeof trace !== "object" || trace.calls !== undefined && !Array.isArray(trace.calls)) return "node trace incomplete";
  if (trace.error && !/^execution reverted$/i.test(trace.error)) return "node child did not complete";
  for (const child of trace.calls ?? []) { const halt = nodeNestedHalt(child); if (halt) return halt; }
  return null;
}
export function assertCallTrace(trace: any, tx: { from: string; to: string; data: string }) {
  if (!trace || trace.from?.toLowerCase() !== tx.from.toLowerCase() || trace.to?.toLowerCase() !== tx.to.toLowerCase() ||
      trace.input?.toLowerCase() !== tx.data.toLowerCase() || !bytes(trace.output ?? "0x") ||
      typeof trace.gasUsed !== "string" || !/^0x[0-9a-f]+$/i.test(trace.gasUsed)) throw new Error("node call trace mismatched request");
}

/** Apply only node-reported post-state. Omitted changed slots are deletions,
 * not old values. Destruction is deliberately unavailable: merging a deleted
 * account with an earlier stateDiff could revive code/storage accidentally.
 */
export function applyNodeStateDiff(overrides: Record<string, any>, diff: any) {
  if (!diff || typeof diff.pre !== "object" || typeof diff.post !== "object" || !diff.pre || !diff.post)
    throw new Error("invalid node state diff");
  for (const a of Object.keys(diff.pre)) if (!Object.keys(diff.post).some(p => p.toLowerCase() === a.toLowerCase()))
    throw new Error("node state diff account deletion unsupported");
  for (const [raw, value] of Object.entries(diff.post)) {
    if (!address(raw) || !value || typeof value !== "object") throw new Error("invalid node state diff account");
    const a = raw.toLowerCase(), post = value as any;
    const pre = diff.pre[raw] ?? diff.pre[a] ?? {};
    const row = overrides[a] ??= {};
    for (const key of ["balance", "nonce", "code"]) if (post[key] !== undefined) {
      if (key === "code" ? !bytes(post[key]) : !(typeof post[key] === "string" && /^0x[0-9a-f]+$/i.test(post[key]) || key === "nonce" && Number.isSafeInteger(post[key]) && post[key] >= 0))
        throw new Error("invalid node state diff field");
      row[key] = typeof post[key] === "number" ? toQuantity(post[key]) : post[key];
    }
    const storage = row.stateDiff ??= {};
    for (const slot of new Set([...Object.keys(pre.storage ?? {}), ...Object.keys(post.storage ?? {})])) {
      if (!/^0x[0-9a-f]{64}$/i.test(slot)) throw new Error("invalid node storage slot");
      const v = post.storage?.[slot] ?? toBeHex(0n, 32);
      if (!/^0x[0-9a-f]{64}$/i.test(v)) throw new Error("invalid node storage value");
      storage[slot] = v;
    }
  }
}

/** Compatibility path for genuine top-level calls. Uses standard node tracers,
 * never changes caller code and never turns a contract frame into an EOA.
 * Separate top-level pre-calls retain post-state but reset transient state, as
 * the existing request semantics require. Canonical runtime quotes do not use
 * this more expensive path.
 */
export async function traceNodeTopLevel(input: {
  rpc: PinnedNodeRpc; block: unknown; from: string; calls: readonly { to: string; data: string }[];
  observations: readonly NodeObservation[]; overrides: Record<string, any>; gas: number;
}) {
  const { rpc, block, from, observations, gas } = input;
  const overrides = structuredClone(input.overrides);
  const balances = () => Promise.all(observations.map(async o => {
    if (o.kind === "native") return BigInt(overrides[o.account]?.balance ?? await rpc("eth_getBalance", [o.account, block]));
    const data = o.kind === "token" ? "0x70a08231" + o.account.slice(2).padStart(64, "0") : "0x18160ddd";
    const r = await rpc("eth_call", [{ from, to: o.token, data, gas: "0x30d40" }, block, overrides]);
    if (typeof r !== "string" || !/^0x[0-9a-f]{64}$/i.test(r)) throw new Error("node balance observation malformed");
    return BigInt(r);
  }));
  const before = await balances();
  let gasUsed = 0n, output = "0x";
  const logs = [];
  for (let i = 0; i < input.calls.length; i++) {
    const tx = { from, ...input.calls[i]!, gas: toQuantity(gas), gasPrice: "0x0" };
    const trace = await rpc("debug_traceCall", [tx, block, { tracer: "callTracer", tracerConfig: { withLog: true }, stateOverrides: overrides }]);
    assertCallTrace(trace, tx);
    gasUsed += BigInt(trace.gasUsed); output = trace.output ?? "0x";
    if (trace.error) return { before, after: before, output, gasUsed, logs: [], failure: {
      index: i, nestedHalt: nodeNestedHalt(trace) } };
    logs.push(...successfulTraceLogs(trace));
    const diff = await rpc("debug_traceCall", [tx, block, { tracer: "prestateTracer", tracerConfig: { diffMode: true }, stateOverrides: overrides }]);
    applyNodeStateDiff(overrides, diff);
  }
  return { before, after: await balances(), output, gasUsed, logs };
}

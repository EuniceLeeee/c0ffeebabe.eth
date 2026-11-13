import { Interface, toBeHex } from "ethers";
import type { InputFundingOverrides } from "../revm-sim-client.js";

export type PinnedNodeRpc = (method: string, params: readonly unknown[]) => Promise<any>;
const ERC20 = new Interface(["function balanceOf(address) view returns(uint256)"]);
const UINT = 1n << 256n;
const SENTINEL = (1n << 255n) | 0x314159265358979323846264338327950288419716939937510n;
const CACHE_LIMIT = 4096;
// Bounds on observed trace data, not guesses about storage layout. The supplied
// RPC retains its existing scheduler, request budget, deadline and cancellation.
const TRACE_LIMIT = 128;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function tracedSlots(trace: unknown, token: string): ReadonlyMap<string, bigint> {
  if (!record(trace)) throw new Error("invalid node input funding prestate trace");
  const accounts = Object.entries(trace), seen = new Set<string>();
  if (accounts.length > TRACE_LIMIT) throw new Error("node input funding trace account limit");
  let storage: Record<string, unknown> = {};
  for (const [address, account] of accounts) {
    const normalized = address.toLowerCase();
    if (!ADDRESS.test(address) || seen.has(normalized) || !record(account))
      throw new Error("invalid node input funding prestate account");
    seen.add(normalized);
    if (normalized !== token) continue;
    if (account.storage !== undefined && !record(account.storage))
      throw new Error("invalid node input funding prestate storage");
    storage = account.storage as Record<string, unknown> | undefined ?? {};
  }
  const entries = Object.entries(storage), slots = new Map<string, bigint>();
  if (entries.length > TRACE_LIMIT) throw new Error("node input funding trace slot limit");
  for (const [slot, value] of entries) {
    const normalized = slot.toLowerCase();
    if (!WORD.test(slot) || typeof value !== "string" || !WORD.test(value) || slots.has(normalized))
      throw new Error("invalid node input funding prestate slot");
    slots.set(normalized, BigInt(value));
  }
  return slots;
}
export type NodeFundingProof = { slot: string; balance: bigint };
export type NodeFundingProofResolver = (key: string,
  prove: (rpc: PinnedNodeRpc) => Promise<NodeFundingProof>) => Promise<NodeFundingProof>;
export interface NodeFundingCache {
  /** Hints only. Every new source must re-trace and re-prove account isolation. */
  readonly slots: Map<string, string>;
}
export function createNodeFundingCache(): NodeFundingCache { return { slots: new Map() }; }
function uint(data: unknown): bigint {
  if (typeof data !== "string" || !WORD.test(data)) throw new Error("node input balance unavailable");
  return BigInt(data);
}

/** No transfers from pools/holders, allowance writes, code replacement or local
 * EVM. Only a proven direct balance slot is changed in the isolated RPC call.
 * Trace the actual funded account, never transplant a historical pool's slot.
 * Only a single full-word balance with an independent account witness is supported;
 * packed, shared, external-ledger and nonlinear layouts are not guessed.
 * Existing input inventory is retained: initialization adds the requested input.
 */
export class NodeInputFunding {
  private readonly proofs = new Map<string, Promise<NodeFundingProof>>();
  constructor(private readonly rpc: PinnedNodeRpc, private readonly block: unknown,
    private readonly cache: NodeFundingCache = createNodeFundingCache(),
    private readonly completed = new Map<string, NodeFundingProof>(),
    private readonly resolveProof?: NodeFundingProofResolver) {}

  async prepare(deals: readonly { token: string; to: string; amount: string }[]) {
    const writes: Record<string, { stateDiff: Record<string, string> }> = {};
    const expected: { token: string; account: string; balance: bigint }[] = [];
    for (const deal of deals) {
      const token = deal.token.toLowerCase(), account = deal.to.toLowerCase(), amount = BigInt(deal.amount);
      if (!ADDRESS.test(token) || !ADDRESS.test(account) || amount < 0n || amount >= UINT || token === account)
        throw new Error("invalid node input funding");
      const key = `${token}:${account}`;
      let proof = this.proofs.get(key);
      if (!proof) {
        proof = this.completed.has(key) ? Promise.resolve(this.completed.get(key)!)
          : this.resolveProof ? this.resolveProof(key, rpc => this.prove(token, account, key, rpc))
          : this.prove(token, account, key);
        this.proofs.set(key, proof);
        void proof.catch(() => { if (this.proofs.get(key) === proof) this.proofs.delete(key); });
      }
      const { slot, balance } = await proof;
      this.completed.set(key, { slot, balance });
      const funded = balance + amount;
      if (funded >= UINT) throw new Error("node input funding overflow");
      const row = writes[token] ??= { stateDiff: {} };
      if (row.stateDiff[slot] !== undefined) throw new Error("duplicate node input funding slot");
      row.stateDiff[slot] = toBeHex(funded, 32);
      expected.push({ token, account, balance: funded });
    }
    return { overrides: writes as InputFundingOverrides, expected };
  }

  private async prove(token: string, account: string, key: string, rpc = this.rpc) {
    const call = (owner: string) => ({ to: token, data: ERC20.encodeFunctionData("balanceOf", [owner]), gas: "0x30d40" });
    const read = async (owner: string, stateDiff?: Record<string, string>) => uint(await rpc("eth_call",
      stateDiff ? [call(owner), this.block, { [token]: { stateDiff } }] : [call(owner), this.block]));
    const trace = async (owner: string) => tracedSlots(await rpc("debug_traceCall", [call(owner), this.block, {
      tracer: "prestateTracer", tracerConfig: { diffMode: false, disableCode: true, disableStorage: false }, timeout: "5s",
    }]), token);
    // balanceOf(token) observes a different account without protocol/pool lists.
    // Shared scalar/configuration/proxy slots are excluded before any write.
    // This witness is a direct-slot contract check, not a proof about arbitrary
    // adversarial getter code. Execution still independently checks the balance.
    const witness = token, hint = this.cache.slots.get(key);
    this.cache.slots.delete(key);
    const balance = await read(account), witnessBalance = await read(witness);
    const accessed = await trace(account), shared = await trace(witness);
    const slots = [...accessed].filter(([slot, value]) => value === balance && !shared.has(slot)).map(([slot]) => slot);
    if (hint && slots.includes(hint)) slots.splice(0, 0, ...slots.splice(slots.indexOf(hint), 1));
    const verify = async (slot: string) => {
      // Isolated writes only: changing all traced keys together can corrupt a
      // proxy or a global parameter. Bit 255 also rejects narrower packed fields.
      for (const value of [SENTINEL, SENTINEL + 0x123456789abcdefn]) {
        const stateDiff = { [slot]: toBeHex(value, 32) };
        if (await read(account, stateDiff) !== value || await read(witness, stateDiff) !== witnessBalance) return false;
      }
      return true;
    };
    const proven: string[] = [];
    for (const slot of slots) {
      // RPC failures, cancellations and reverts remain failures of this proof;
      // they are never swallowed or converted into guessed storage candidates.
      if (await verify(slot)) proven.push(slot);
      if (proven.length > 1) throw new Error("node input funding ambiguous balance layout");
    }
    if (proven.length !== 1) throw new Error("node input funding unsupported balance layout");
    const slot = proven[0]!;
    this.cache.slots.set(key, slot);
    if (this.cache.slots.size > CACHE_LIMIT) this.cache.slots.delete(this.cache.slots.keys().next().value!);
    return { slot, balance };
  }
}

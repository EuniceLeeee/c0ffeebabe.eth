import { AbiCoder, Interface, keccak256, toBeHex } from "ethers";
import type { InputFundingOverrides } from "../revm-sim-client.js";

export type PinnedNodeRpc = (method: string, params: readonly unknown[]) => Promise<any>;
const ABI = AbiCoder.defaultAbiCoder();
const ERC20 = new Interface(["function balanceOf(address) view returns(uint256)"]);
const UINT = 1n << 256n;
const SENTINEL = 0x314159265358979323846264338327950288419716939937510n;
const CACHE_LIMIT = 4096;
// These keys depend only on the account, never on a token, source or observed
// layout. Keep the expensive ABI/keccak derivation out of repeated discoveries.
const candidateSlots = new Map<string, readonly string[]>();
function slotsFor(account: string): readonly string[] {
  let slots = candidateSlots.get(account);
  if (!slots) {
    slots = Object.freeze([...new Set(Array.from({ length: 32 }, (_, i) => [
      keccak256(ABI.encode(["address", "uint256"], [account, i])),
      keccak256(ABI.encode(["uint256", "address"], [i, account])),
    ]).flat())]);
    candidateSlots.set(account, slots);
    if (candidateSlots.size > 256) candidateSlots.delete(candidateSlots.keys().next().value!);
  }
  return slots;
}
export type NodeFundingProof = { slot: string; balance: bigint };
export type NodeFundingProofResolver = (key: string,
  prove: (rpc: PinnedNodeRpc) => Promise<NodeFundingProof>) => Promise<NodeFundingProof>;
export interface NodeFundingCache {
  /** Hints only. Every new source must re-prove an isolated write. */
  readonly slots: Map<string, string>;
}
export function createNodeFundingCache(): NodeFundingCache { return { slots: new Map() }; }
function uint(data: unknown): bigint {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(data)) throw new Error("node input balance unavailable");
  return BigInt(data);
}

/** No transfers from pools/holders, allowance writes, code replacement or local
 * EVM. Only a proven direct balance slot is changed in the isolated RPC call.
 * Nonlinear/share balances are explicitly unsupported instead of guessed.
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
      if (amount < 0n || amount >= UINT || token === account) throw new Error("invalid node input funding");
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
    const call = { to: token, data: ERC20.encodeFunctionData("balanceOf", [account]), gas: "0x30d40" };
    const read = async (stateDiff?: Record<string, string>) => uint(await rpc("eth_call",
      stateDiff ? [call, this.block, { [token]: { stateDiff } }] : [call, this.block]));
    const balance = await read();
    const verify = async (slot: string) => {
      // Two distinct nonzero values, including a high word, reject a cached
      // proxy layout or a read that merely happens to equal one probe value.
      for (const value of [SENTINEL, SENTINEL + 0x123456789abcdefn]) {
        if (await read({ [slot]: toBeHex(value, 32) }) !== value) return false;
      }
      return true;
    };
    const hint = this.cache.slots.get(key);
    if (hint && await verify(hint)) return { slot: hint, balance };
    this.cache.slots.delete(key);
    const slots = slotsFor(account);
    // One bounded discovery request instead of 64 serial RPCs. This combined
    // probe is only a nomination: two isolated single-slot proofs follow it.
    const result = await read(Object.fromEntries(slots.map((slot, i) => [slot, toBeHex(SENTINEL + BigInt(i), 32)])));
    const index = result - SENTINEL;
    if (index < 0n || index >= BigInt(slots.length) || !await verify(slots[Number(index)]!)) {
      throw new Error("node input funding unsupported balance layout");
    }
    const slot = slots[Number(index)]!;
    this.cache.slots.set(key, slot);
    if (this.cache.slots.size > CACHE_LIMIT) this.cache.slots.delete(this.cache.slots.keys().next().value!);
    return { slot, balance };
  }
}

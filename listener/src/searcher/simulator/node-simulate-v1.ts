import { isDeepStrictEqual } from "node:util";
import { hexlify, randomBytes } from "ethers";
import { RevmFatalError, RevmStrictError } from "../revm-sim-client.js";
import type { PinnedNodeRpc } from "./node-input-funding.js";
import { buildNodeProgramQuote, isCanonicalNodeRuntimeCall, type NodeObservation } from "./node-program-quote.js";
import { assertCallTrace, nodeNestedHalt, successfulTraceLogs, traceNodeTopLevel } from "./node-trace-simulation.js";
import { checkedEthSimulateV1Block, checkedEthSimulateV1Call } from "./eth-simulate-v1.js";

const ZERO = "0x" + "00".repeat(20), ZERO_HASH = "0x" + "00".repeat(32);
const END = "0x00000002", hex = (value: bigint | number) => `0x${value.toString(16)}`;
const bytes = (v: unknown): v is string => typeof v === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(v);
const address = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
const quantity = (value: unknown): bigint => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) return BigInt(value);
  throw new RevmStrictError("validation", "invalid simulateV1 header quantity");
};
export interface NodeSimulateV1Header {
  readonly number: number | string; readonly hash: string; readonly parentHash: string;
  readonly stateRoot: string; readonly timestamp: number | string; readonly gasLimit: bigint | string;
}
/** N identifies immutable state. BOTH quote reads and execution run in this
 * explicit virtual N+1 context; the old N execution environment is not reused. */
export function nodeSimulateV1Environment(header: NodeSimulateV1Header) {
  const n = quantity(header.number), time = quantity(header.timestamp), gas = quantity(header.gasLimit);
  if (n >= BigInt(Number.MAX_SAFE_INTEGER) || time >= BigInt(Number.MAX_SAFE_INTEGER - 12) || gas <= 0n ||
      !hash(header.hash) || !hash(header.parentHash) || !hash(header.stateRoot))
    throw new RevmStrictError("validation", "invalid simulateV1 source header");
  return Object.freeze({ method: "eth_simulateV1" as const,
    base: Object.freeze({ number: Number(n), hash: header.hash.toLowerCase(),
      parentHash: header.parentHash.toLowerCase(), stateRoot: header.stateRoot.toLowerCase() }),
    blockOverrides: Object.freeze({ number: hex(n + 1n), time: hex(time + 12n), gasLimit: hex(gas),
      baseFeePerGas: "0x0", blobBaseFee: "0x0", feeRecipient: ZERO, prevRandao: ZERO_HASH }) });
}
export type NodeSimulateV1Environment = ReturnType<typeof nodeSimulateV1Environment>;
export class NodeSimulateV1CallRevert extends Error {
  readonly code = 3;
  constructor(readonly data: string) { super("execution reverted"); }
}
function pinned(block: unknown, env: NodeSimulateV1Environment): void {
  const b = block as { blockHash?: string; requireCanonical?: boolean } | null;
  if (typeof block === "string" && (block.toLowerCase() === env.base.hash || block.toLowerCase() === hex(env.base.number))) return;
  if (b?.blockHash?.toLowerCase() === env.base.hash && b.requireCanonical === true) return;
  throw new RevmStrictError("validation", "simulateV1 request does not bind the source");
}
async function canonical(rpc: PinnedNodeRpc, env: NodeSimulateV1Environment) {
  const h = await rpc("eth_getBlockByNumber", [hex(env.base.number), false]);
  if (!h || h.hash?.toLowerCase() !== env.base.hash || h.parentHash?.toLowerCase() !== env.base.parentHash ||
      h.stateRoot?.toLowerCase() !== env.base.stateRoot || quantity(h.number) !== BigInt(env.base.number) ||
      quantity(h.timestamp) + 12n !== quantity(env.blockOverrides.time) || quantity(h.gasLimit) !== quantity(env.blockOverrides.gasLimit))
    throw new RevmFatalError({ kind: "source-fault" });
}
async function atSource<T>(rpc: PinnedNodeRpc, env: NodeSimulateV1Environment, run: () => Promise<T>): Promise<T> {
  await canonical(rpc, env);
  try { return await run(); } finally { await canonical(rpc, env); }
}
async function callsAt(rpc: PinnedNodeRpc, env: NodeSimulateV1Environment,
  calls: readonly Record<string, unknown>[], overrides: Record<string, unknown>) {
  return atSource(rpc, env, async () => {
    const result = await rpc("eth_simulateV1", [{ blockStateCalls: [{ blockOverrides: env.blockOverrides,
      stateOverrides: overrides, calls }], validation: false, traceTransfers: false },
    // The standard V1 schema accepts quantity/tag/hash strings. Numeric N is
    // portable to providers that reject EIP-1898 objects; fences above/below
    // and the returned parentHash independently bind its canonical identity.
    hex(env.base.number)]);
    const block = checkedEthSimulateV1Block(result, env.base.hash, env.blockOverrides, calls.length);
    const raw = result[0];
    for (const [key, expected] of [["miner", ZERO], ["feeRecipient", ZERO], ["mixHash", ZERO_HASH], ["prevRandao", ZERO_HASH]] as const)
      if (raw[key] !== undefined && raw[key].toLowerCase() !== expected) throw new Error("simulateV1 environment mismatch");
    if (raw.blobBaseFee !== undefined && quantity(raw.blobBaseFee) !== 0n) throw new Error("simulateV1 blob fee mismatch");
    return block.calls.map((value, i) => {
      const call = checkedEthSimulateV1Call(value, quantity(calls[i]!.gas));
      const error = call.error as { code?: number; data?: unknown } | undefined;
      if (call.status !== "0x0" || error?.code !== 3 || error.data === undefined) return call;
      // Providers may put completed EVM revert bytes in error.data instead of
      // returnData. Normalize the wire representation, retaining trace parity.
      if (!bytes(error.data)) throw new Error("invalid simulateV1 revert data");
      if (call.returnData !== "0x" && (call.returnData as string).toLowerCase() !== error.data.toLowerCase())
        throw new Error("conflicting simulateV1 revert data");
      return { ...call, returnData: error.data };
    });
  });
}
/** Wrap only execution RPCs. Canonical code/storage reads retain state N.
 * The caller retains scheduling, deadlines, cancellation and JSON-RPC parsing. */
export function createNodeSimulateV1Rpc(rpc: PinnedNodeRpc, header: NodeSimulateV1Header): PinnedNodeRpc {
  const env = nodeSimulateV1Environment(header);
  return async (method, params) => {
    if (method === "eth_call") {
      if (params.length < 2 || params.length > 3) throw new Error("simulateV1 eth_call arity");
      pinned(params[1], env);
      const tx = { ...(params[0] as Record<string, unknown>) };
      if (!address(tx.to) || tx.data !== undefined && !bytes(tx.data) || tx.from !== undefined && !address(tx.from))
        throw new Error("simulateV1 eth_call shape");
      tx.gas ??= "0x1000000"; tx.gasPrice ??= "0x0";
      const call = (await callsAt(rpc, env, [tx], (params[2] ?? {}) as Record<string, unknown>))[0]!;
      if (call.status === "0x0") {
        if ((call.error as { code?: number }).code !== 3) throw new Error("simulateV1 call did not complete");
        throw new NodeSimulateV1CallRevert(call.returnData as string);
      }
      return call.returnData;
    }
    if (method === "debug_traceCall") {
      pinned(params[1], env);
      const options = (params[2] ?? {}) as Record<string, unknown>;
      if (options.blockOverrides !== undefined && !isDeepStrictEqual(options.blockOverrides, env.blockOverrides))
        throw new Error("simulateV1 trace environment mismatch");
      return atSource(rpc, env, () => rpc(method, [params[0], params[1], { ...options, blockOverrides: env.blockOverrides }]));
    }
    return rpc(method, params);
  };
}
function logs(value: unknown): { address: string; topics: string[]; data: string }[] {
  if (!Array.isArray(value)) throw new Error("simulateV1 logs missing");
  return value.map(l => {
    if (!address(l?.address) || !Array.isArray(l.topics) || !l.topics.every(hash) || !bytes(l.data)) throw new Error("invalid simulateV1 log");
    return { address: l.address.toLowerCase(), topics: l.topics.map((x: string) => x.toLowerCase()), data: l.data.toLowerCase() };
  });
}
type Receipt = { before: bigint[]; after: bigint[]; output: string; gasUsed: bigint;
  logs: { address: string; topics: string[]; data: string }[]; failure?: { index: number; nestedHalt: string | null } };
type Input = {
  rpc: PinnedNodeRpc; header: NodeSimulateV1Header; from: string; origin: string;
  calls: readonly { to: string; data: string }[]; observations: readonly NodeObservation[];
  overrides: Record<string, any>; gas: number; baselineAfterPrefix?: boolean;
  codeAt: (address: string, reuse?: boolean) => Promise<string>;
};
/** Execute the existing BotVM observation program, then read its isolated
 * recorder in the same simulated block. Receipts contain EVM-read values only. */
export async function simulateNodeProgramV1(input: Input): Promise<Receipt> {
  const { rpc, from, origin, calls, observations } = input;
  const env = nodeSimulateV1Environment(input.header), block = { blockHash: env.base.hash, requireCanonical: true };
  const traceRpc = createNodeSimulateV1Rpc(rpc, input.header);
  const canonicalReturn = calls.at(-1)?.to.toLowerCase() === from && isCanonicalNodeRuntimeCall(calls.at(-1)!.data);
  const used = new Set([from, origin, ...Object.keys(input.overrides).map(x => x.toLowerCase()), ...calls.map(c => c.to.toLowerCase()),
    ...observations.flatMap(o => o.kind === "supply" ? [o.token] : o.kind === "native" ? [o.account] : [o.token, o.account])]);
  const make = async (words: number) => {
    const quote = buildNodeProgramQuote({ executor: from, calls, observations,
      baselineAfterPrefix: input.baselineAfterPrefix, terminalRevert: false, persistent: true, outputWords: words });
    if (used.has(quote.recorder) || await input.codeAt(quote.recorder, false) !== "0x") throw new Error("simulateV1 recorder occupied");
    const overrides = { ...input.overrides, [quote.recorder]: { code: quote.code, state: {} },
      [from]: { ...input.overrides[from], stateDiff: { ...input.overrides[from]?.stateDiff, [quote.diagnosticSlot]: quote.key } } };
    const tx = { from: origin, to: from, data: quote.data, gas: hex(input.gas), gasPrice: "0x0" };
    return { quote, overrides, tx, words };
  };
  const trace = async (p: Awaited<ReturnType<typeof make>>) => {
    const result = await traceRpc("debug_traceCall", [p.tx, block,
      { tracer: "callTracer", tracerConfig: { withLog: true }, stateOverrides: p.overrides }]);
    assertCallTrace(result, p.tx);
    const probes = observations.reduce((n, o) => n + (o.kind === "native" ? 1 : 2), 0);
    let at = input.baselineAfterPrefix ? 0 : probes;
    const main = [];
    for (let i = 0; i < calls.length; i++) {
      const child = result.calls?.[at++]; assertCallTrace(child, { from, ...calls[i]! }); main.push(child);
      if (child.error) {
        if (!result.error) throw new Error("simulateV1 trace failed child without outer revert");
        return { result, main, failed: i, receipt: undefined };
      }
      if (i === 0 && input.baselineAfterPrefix) at += probes;
      if (i === calls.length - 1) at += p.words;
    }
    const terminal = result.calls?.[at + probes];
    if (result.error || result.calls?.length !== at + probes + 1 || terminal?.from?.toLowerCase() !== from ||
        terminal?.to?.toLowerCase() !== p.quote.recorder || terminal.input !== END || terminal.error)
      throw new Error("simulateV1 trace terminal receipt missing");
    return { result, main, failed: -1, receipt: p.quote.read(terminal.output) };
  };
  let program = await make(0);
  if (!canonicalReturn) {
    const hint = await trace(program);
    if (hint.failed < 0) {
      const output = hint.main.at(-1)?.output ?? "0x", words = (output.length - 2) / 64;
      if (!Number.isInteger(words) || words < 0 || words > 15)
        throw new RevmStrictError("observation", "simulateV1 direct return must contain 0 to 15 complete words");
      if (words) program = await make(words);
    }
  }
  const result = await callsAt(rpc, env, [program.tx,
    { from, to: program.quote.recorder, data: END, gas: "0x100000", gasPrice: "0x0" }], program.overrides);
  const main = result[0]!;
  if (main.status === "0x0") {
    if ((main.error as { code?: number }).code !== 3) throw new Error("simulateV1 execution did not complete");
    const witness = await trace(program);
    if (witness.failed < 0 || (witness.result.output ?? "0x").toLowerCase() !== (main.returnData as string).toLowerCase())
      throw new Error("simulateV1 revert trace mismatch");
    const failed = witness.main[witness.failed]!;
    return { before: [], after: [], output: failed.output ?? "0x", gasUsed: quantity(main.gasUsed), logs: [],
      failure: { index: witness.failed, nestedHalt: nodeNestedHalt(failed) } };
  }
  if (result[1]!.status !== "0x1") throw new Error("simulateV1 recorder read reverted");
  const measured = program.quote.read(result[1]!.returnData as string);
  let observedLogs = logs(main.logs);
  if (!canonicalReturn || input.baselineAfterPrefix) {
    const witness = await trace(program);
    if (witness.failed >= 0 || !isDeepStrictEqual(measured, witness.receipt) ||
        (witness.main.at(-1)?.output ?? "0x").toLowerCase() !== measured.output?.toLowerCase() ||
        !isDeepStrictEqual(observedLogs, logs(successfulTraceLogs(witness.result))))
      throw new Error("simulateV1 return or effects trace mismatch");
    if (input.baselineAfterPrefix) observedLogs = logs(witness.main.slice(1).flatMap(successfulTraceLogs));
  }
  return { before: measured.before, after: measured.after, output: measured.output ?? "0x",
    gasUsed: quantity(main.gasUsed), logs: observedLogs };
}

/** Genuine top-level calls retain their caller and independent transaction
 * boundaries. A read-only probe measures state before/after the full sequence. */
export async function simulateNodeTopLevelV1(input: Input): Promise<Receipt> {
  const env = nodeSimulateV1Environment(input.header), block = { blockHash: env.base.hash, requireCanonical: true };
  const observer = hexlify(randomBytes(20)), sender = hexlify(randomBytes(20));
  const used = new Set([input.from, ...Object.keys(input.overrides), ...input.calls.map(c => c.to),
    ...input.observations.flatMap(o => o.kind === "supply" ? [o.token] : o.kind === "native" ? [o.account] : [o.token, o.account])].map(x => x.toLowerCase()));
  if (observer === sender || used.has(observer) || used.has(sender) || await input.codeAt(observer, false) !== "0x" || await input.codeAt(sender, false) !== "0x")
    throw new Error("simulateV1 observer occupied");
  const push = (n: number) => "61" + n.toString(16).padStart(4, "0");
  let code = "";
  for (let i = 0; i < input.observations.length; i++) {
    const o = input.observations[i]!;
    if (o.kind === "native") code += `73${o.account.slice(2)}31${push(i * 32 + 4096)}52`;
    else {
      const data = o.kind === "token" ? "70a08231" + o.account.slice(2).padStart(64, "0") : "18160ddd";
      code += `63${data.slice(0, 8)}60e01b600052`;
      if (o.kind === "token") code += `73${o.account.slice(2)}600452`;
      code += `${push(32)}${push(i * 32 + 4096)}${push(data.length / 2)}600073${o.token.slice(2)}5afa3d60201416`;
      const next = code.length / 2 + 9;
      code += `${push(next)}5760006000fd5b`;
    }
  }
  code += push(input.observations.length * 32) + push(4096) + "f3";
  const probe = { from: sender, to: observer, data: "0x", gas: "0x200000", gasPrice: "0x0" };
  const calls = input.calls.map(c => ({ from: input.from, ...c, gas: hex(input.gas), gasPrice: "0x0" }));
  const result = await callsAt(input.rpc, env, [probe, ...calls, probe], { ...input.overrides, [observer]: { code: "0x" + code } });
  const read = (c: Record<string, unknown>) => {
    if (c.status !== "0x1" || !bytes(c.returnData) || c.returnData.length !== 2 + input.observations.length * 64)
      throw new Error("simulateV1 balance probe unavailable");
    return input.observations.map((_, i) => BigInt("0x" + (c.returnData as string).slice(2 + i * 64, 66 + i * 64)));
  };
  const before = read(result[0]!), mains = result.slice(1, -1), failed = mains.findIndex(c => c.status === "0x0");
  if (failed >= 0) {
    const witness = await traceNodeTopLevel({ ...input, rpc: createNodeSimulateV1Rpc(input.rpc, input.header), block });
    if ((mains[failed]!.error as { code?: number }).code !== 3 || witness.failure?.index !== failed ||
        witness.output.toLowerCase() !== (mains[failed]!.returnData as string).toLowerCase()) throw new Error("simulateV1 top-level revert mismatch");
    return { ...witness, gasUsed: mains.slice(0, failed + 1).reduce((n, c) => n + quantity(c.gasUsed), 0n) };
  }
  return { before, after: read(result.at(-1)!), output: mains.at(-1)!.returnData as string,
    gasUsed: mains.reduce((n, c) => n + quantity(c.gasUsed), 0n), logs: mains.flatMap(c => logs(c.logs)) };
}

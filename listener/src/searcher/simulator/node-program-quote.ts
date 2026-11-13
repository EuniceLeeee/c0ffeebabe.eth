import { AbiCoder, Interface, getBytes, hexlify, keccak256, randomBytes, toUtf8Bytes } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { concatBytes, encodeCall } from "../../encoder.js";
import { buildExecuteCalldata } from "../../shared/executor/botvm-executor.js";
import { assertSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { HOP_DIAGNOSTIC_SLOT } from "./direct-revert-hop.js";

export type NodeObservation = { kind: "token"; token: string; account: string } |
  { kind: "supply"; token: string } | { kind: "native"; account: string };
const ABI = AbiCoder.defaultAbiCoder();
const TAG = keccak256(toUtf8Bytes("mev.node-program-quote.receipt.v2"));
const ERROR = new Interface(["error RuntimeHopFailed(uint256 hop,address target,bytes32 flowHash,bytes reason,bytes32 proof)"]);
const WORD = (x: string | number) => (typeof x === "string" ? x.replace(/^0x/, "") : x.toString(16)).padStart(64, "0");
const SAVE = "0x00000001", END = "0x00000002";
const push = (x: number) => "61" + x.toString(16).padStart(4, "0");

/** Stores only values read by the ORIGINAL executor, without substituting its
 * code. Recorder slots are isolated to this RPC; simulateV1 can keep them across
 * its calls. A protocol cannot write a receipt on the executor's behalf.
 */
function recorderCode(executor: string, count: number, terminalRevert: boolean, persistent = false): string {
  const read = persistent ? "54" : "5c", write = persistent ? "55" : "5d";
  let s = "";
  const patches: [number, string][] = [], labels = new Map<string, number>();
  const jump = (name: string) => { s += "61"; patches.push([s.length, name]); s += "000057"; };
  const label = (name: string) => { labels.set(name, s.length / 2); s += "5b"; };
  s += `3373${executor.slice(2)}1415`; jump("bad");
  s += "60003560e01c600114"; jump("save");
  s += "600435"; // discarded after exact end calldata validation
  s += "506004361460003560e01c6002141615"; jump("bad");
  s += "6000" + read + push(count) + "1415"; jump("bad");
  s += "7f" + TAG.slice(2) + "600052";
  for (let i = 0; i < count; i++) s += push(i + 1) + read + push((i + 1) * 32) + "52";
  s += push((count + 1) * 32) + "6000" + (terminalRevert ? "fd" : "f3");
  label("save");
  s += "6044361415"; jump("bad");
  // A strictly sequential write index makes incomplete/duplicate snapshots fail.
  s += "6004356000" + read + "1415"; jump("bad");
  s += push(count) + "6004351015"; jump("bad");
  s += "602435600435600101" + write + "6004356001016000" + write + "00";
  label("bad"); s += "60006000fd";
  for (const [at, name] of patches) s = s.slice(0, at) + labels.get(name)!.toString(16).padStart(4, "0") + s.slice(at + 4);
  return "0x" + s;
}

export function isCanonicalNodeRuntimeCall(calldata: string): boolean {
  try {
    assertSubscriptCalldata(calldata);
    const [raw] = ABI.decode(["bytes"], "0x" + calldata.slice(10));
    const script = getBytes(raw);
    return script[0] === 0x0e && script.length >= 36 &&
      script.length === 36 + script[33]! * 65536 + script[34]! * 256 + script[35]!;
  } catch { return false; }
}

/** Wrap actual calls with observations through the deployed BotVM. Reverting
 * terminal receipts support trace-free canonical Exact; returning receipts let
 * callTracer independently measure successful quoted/runtime execution, logs,
 * main returndata and failures. The RPC backend selects the common state and
 * block environment for quote and execution.
 */
export function buildNodeProgramQuote(input: {
  executor: string; calls: readonly { to: string; data: string }[];
  observations: readonly NodeObservation[]; baselineAfterPrefix?: boolean; terminalRevert: boolean;
  /** Isolated RPC recorder storage can be read by a following simulateV1 call. */
  persistent?: boolean;
  /** Copy the actual final CALL return words before any balance probe overwrites them. */
  outputWords?: number;
}) {
  if (!input.calls.length || input.calls.length > 64 || input.observations.length > 64)
    throw new Error("node receipt bounds");
  const outputWords = input.outputWords ?? 0;
  if (!Number.isInteger(outputWords) || outputWords < 0 || outputWords > 15 ||
      input.persistent && input.terminalRevert) throw new Error("node receipt output bounds");
  const key = hexlify(randomBytes(32));
  const flowHash = keccak256(toUtf8Bytes(JSON.stringify(input.calls)));
  const recorder = `0x${keccak256(toUtf8Bytes(`node-program-quote:${input.executor}:${key}`)).slice(-40)}`;
  const segments: Uint8Array[] = [];
  let program = new RuntimeAmountProgram();
  let pending = false;
  const flush = () => {
    if (pending) segments.push(runtimeProgramScript(program.bytes()));
    program = new RuntimeAmountProgram();
    pending = false;
  };
  const snapshot = (after: boolean) => {
    for (let first = 0; first < input.observations.length; first += 16) {
      const part = new RuntimeAmountProgram();
      for (let i = first; i < Math.min(first + 16, input.observations.length); i++) {
        const o = input.observations[i]!;
        if (o.kind === "native") {
          if (o.account.toLowerCase() !== input.executor.toLowerCase()) throw new Error("node runtime native observation requires executor account");
          part.nativeBalance(1);
        } else {
          const data = o.kind === "token" ? "0x70a08231" + WORD(o.account) : "0x18160ddd";
          part.call(o.token, data, { static: true }).load(1, 0);
        }
        part.call(recorder, SAVE + WORD(i + (after ? input.observations.length + outputWords : 0)) + WORD(0), { patches: [{ offset: 36, reg: 1 }] });
      }
      program.run(part.bytes());
      pending = true;
    }
  };
  if (!input.baselineAfterPrefix) snapshot(false);
  input.calls.forEach((call, i) => {
    // A trusted legacy BotVM script must enter with its original callback
    // state. A runtime CALL installs a no-callback sentinel, which would make
    // legacy SET_FIELD2 reject its lender/router's callback. Only canonical
    // self-entry bytes use this path; external calls retain runtime guards.
    let legacySelf = false;
    // Explicit return-word capture keeps the existing runtime buffer path.
    // ABI-void legacy scripts may still use the VM RETURN opcode; do not
    // reject or invent those bytes. Callback + return-word capture remains a
    // separate capability (callTracer can already read its actual returndata).
    if (!(i === input.calls.length - 1 && outputWords) &&
        call.to.toLowerCase() === input.executor.toLowerCase() && !isCanonicalNodeRuntimeCall(call.data)) {
      try { assertSubscriptCalldata(call.data); legacySelf = true; } catch { /* Ordinary call. */ }
    }
    if (legacySelf) {
      flush();
      segments.push(encodeCall(call.to, getBytes(call.data)));
    } else { program.call(call.to, call.data); pending = true; }
    if (i === 0 && input.baselineAfterPrefix) snapshot(false);
    if (i === input.calls.length - 1 && outputWords) {
      // Load every word BEFORE calling the recorder, whose return overwrites
      // the VM's last-call buffer. No expected output enters this program.
      for (let word = 0; word < outputWords; word++) program.load(word + 1, word * 32);
      for (let word = 0; word < outputWords; word++) program.call(recorder,
        SAVE + WORD(input.observations.length + word) + WORD(0), { patches: [{ offset: 36, reg: word + 1 }] });
    }
  });
  snapshot(true);
  // Inner scripts may set diagnostic context; reset it only for our recorder.
  program.diagnosticHop(0, flowHash).call(recorder, END);
  pending = true;
  flush();
  const read = (reason: string) => {
    const result = getBytes(reason), n = input.observations.length;
    if (result.length !== 32 + n * 64 + outputWords * 32 || hexlify(result.slice(0, 32)) !== TAG) throw new Error("node receipt shape");
    const word = (i: number) => BigInt(hexlify(result.slice(32 + i * 32, 64 + i * 32)));
    return { before: input.observations.map((_, i) => word(i)), after: input.observations.map((_, i) => word(n + outputWords + i)),
      ...(input.outputWords === undefined ? {} : { output: hexlify(result.slice(32 + n * 32, 32 + (n + outputWords) * 32)) }) };
  };
  return { recorder, code: recorderCode(input.executor, input.observations.length * 2 + outputWords, input.terminalRevert, input.persistent), key, flowHash,
    diagnosticSlot: HOP_DIAGNOSTIC_SLOT, data: buildExecuteCalldata(concatBytes(...segments)),
    read,
    decode(data: string) {
      const decoded = ERROR.parseError(data);
      if (!decoded || decoded.name !== "RuntimeHopFailed" ||
          ERROR.encodeErrorResult(decoded.fragment, decoded.args).toLowerCase() !== data.toLowerCase()) throw new Error("node quote missing authenticated receipt");
      const [hop, target, flow, reason, proof] = decoded.args;
      const expected = keccak256(ABI.encode(["bytes32", "uint256", "address", "bytes32", "bytes32"],
        [key, 0n, recorder, flowHash, keccak256(reason)]));
      if (hop !== 0n || target.toLowerCase() !== recorder || flow.toLowerCase() !== flowHash || proof.toLowerCase() !== expected)
        throw new Error("node quote receipt authentication failed");
      return read(reason);
    } };
}

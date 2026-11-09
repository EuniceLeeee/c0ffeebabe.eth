import { AbiCoder, Interface, getBytes, hexlify, keccak256, randomBytes, toUtf8Bytes } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
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

/** Stores only values read by the ORIGINAL executor. No protocol calls, storage
 * writes or caller code substitution. Slots and execution count are transient,
 * confined to this RPC. A protocol cannot write a receipt on the executor's behalf.
 */
function recorderCode(executor: string, count: number, terminalRevert: boolean): string {
  let s = "";
  const patches: [number, string][] = [], labels = new Map<string, number>();
  const jump = (name: string) => { s += "61"; patches.push([s.length, name]); s += "000057"; };
  const label = (name: string) => { labels.set(name, s.length / 2); s += "5b"; };
  s += `3373${executor.slice(2)}1415`; jump("bad");
  s += "60003560e01c600114"; jump("save");
  s += "600435"; // discarded after exact end calldata validation
  s += "506004361460003560e01c6002141615"; jump("bad");
  s += "60005c" + push(count * 2) + "1415"; jump("bad");
  s += "7f" + TAG.slice(2) + "600052";
  for (let i = 0; i < count * 2; i++) s += push(i + 1) + "5c" + push((i + 1) * 32) + "52";
  s += push((count * 2 + 1) * 32) + "6000" + (terminalRevert ? "fd" : "f3");
  label("save");
  s += "6044361415"; jump("bad");
  // A strictly sequential write index makes incomplete/duplicate snapshots fail.
  s += "60043560005c1415"; jump("bad");
  s += push(count * 2) + "6004351015"; jump("bad");
  s += "6024356004356001015d60043560010160005d00";
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
 * main returndata and failures. Both use state AND block environment N.
 */
export function buildNodeProgramQuote(input: {
  executor: string; calls: readonly { to: string; data: string }[];
  observations: readonly NodeObservation[]; baselineAfterPrefix?: boolean; terminalRevert: boolean;
}) {
  if (!input.calls.length || input.calls.length > 64 || input.observations.length > 64)
    throw new Error("node receipt bounds");
  const key = hexlify(randomBytes(32));
  const flowHash = keccak256(toUtf8Bytes(JSON.stringify(input.calls)));
  const recorder = `0x${keccak256(toUtf8Bytes(`node-program-quote:${input.executor}:${key}`)).slice(-40)}`;
  const program = new RuntimeAmountProgram();
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
        part.call(recorder, SAVE + WORD(i + (after ? input.observations.length : 0)) + WORD(0), { patches: [{ offset: 36, reg: 1 }] });
      }
      program.run(part.bytes());
    }
  };
  if (!input.baselineAfterPrefix) snapshot(false);
  input.calls.forEach((call, i) => {
    program.call(call.to, call.data);
    if (i === 0 && input.baselineAfterPrefix) snapshot(false);
  });
  snapshot(true);
  // Inner scripts may set diagnostic context; reset it only for our recorder.
  program.diagnosticHop(0, flowHash).call(recorder, END);
  const read = (reason: string) => {
    const result = getBytes(reason), n = input.observations.length;
    if (result.length !== 32 + n * 64 || hexlify(result.slice(0, 32)) !== TAG) throw new Error("node receipt shape");
    const word = (i: number) => BigInt(hexlify(result.slice(32 + i * 32, 64 + i * 32)));
    return { before: input.observations.map((_, i) => word(i)), after: input.observations.map((_, i) => word(n + i)) };
  };
  return { recorder, code: recorderCode(input.executor, input.observations.length, input.terminalRevert), key, flowHash,
    diagnosticSlot: HOP_DIAGNOSTIC_SLOT, data: buildExecuteCalldata(runtimeProgramScript(program.bytes())),
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

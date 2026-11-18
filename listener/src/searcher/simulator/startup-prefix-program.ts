import { AbiCoder, Interface, MaxUint256, getAddress, getBytes, hexlify, keccak256, toUtf8Bytes } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript, runtimeSettlementFlowHash,
  withRuntimeHopContext } from "../../adapters/runtime-amount-program.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { RUNTIME_ERC20, RUNTIME_WRAP } from "../venues/runtime-execution.js";
import { effectiveInputPathHops } from "../effective-input-path-policy.js";

export interface StartupPrefixLeg {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly program: string;
}
export interface StartupPrefixInput {
  readonly amount: bigint;
  /** The price snapshot's input preparation policy, not a separate funding cap. */
  readonly maxInputPathHops?: number;
  /** Original recorded input prefix, followed by the target operation. */
  readonly legs: readonly StartupPrefixLeg[];
}
export interface StartupPrefixReceipt {
  /** -1 is the initial native -> WETH seed; other indices identify actual legs. */
  readonly hop: number;
  readonly amountIn: bigint;
  /** Actual input-token debit; amountIn remains the available input budget. */
  readonly amountSpent: bigint;
  readonly amountOut: bigint;
}
export const STARTUP_RECEIPT_TOPIC = keccak256(toUtf8Bytes("StartupPrefixReceipt(uint256,uint256,uint256,uint256)"));
const RECORD = new Interface(["function record(uint256 hop,uint256 amountIn,uint256 amountOut,uint256 amountSpent)"]);
const FAILURE = new Interface(["error RuntimeHopFailed(uint256 hop,address target,bytes32 flowHash,bytes reason,bytes32 proof)"]);
const ABI = AbiCoder.defaultAbiCoder();

/** Code-only observation overlay. Only the executor may emit a 4-word receipt.
 * No storage, balances, token calls or persistent contracts are introduced. */
function recorderCode(executor: string): string {
  const check = `3373${executor.slice(2)}146084361416`;
  const success = check.length / 2 + 9;
  return `0x${check}61${success.toString(16).padStart(4, "0")}5760006000fd` +
    `5b608060046000377f${STARTUP_RECEIPT_TOPIC.slice(2)}60806000a100`;
}

/** One transaction, using the same Family-issued runtime legs and compiler as
 * live. Each next input is an actual receipt delta, never a quoted amount or
 * the executor's whole token balance. The independent old price table is not
 * mutated. This is an open-path diagnostic, not a profitable closed-loop plan. */
export function compileStartupPrefix(input: StartupPrefixInput, executor: string) {
  const actor = getAddress(executor), weth = getAddress(ADDR.WETH);
  const maxInputPathHops = effectiveInputPathHops(input.maxInputPathHops);
  const fundingContext = input.legs.length;
  if (actor === weth || actor === "0x0000000000000000000000000000000000000000" ||
      typeof input.amount !== "bigint" || input.amount <= 0n || input.amount > MaxUint256 ||
      input.legs.length > maxInputPathHops + 1) throw new Error("invalid startup prefix input");
  const legs = input.legs.map(leg => Object.freeze({ tokenIn: getAddress(leg.tokenIn),
    tokenOut: getAddress(leg.tokenOut), program: hexlify(getBytes(leg.program)) }));
  for (const [i, leg] of legs.entries()) {
    if (leg.tokenIn !== (i ? legs[i - 1]!.tokenOut : weth) || leg.tokenIn === leg.tokenOut ||
        [leg.tokenIn, leg.tokenOut].includes(actor) ||
        getBytes(leg.program)[0] !== 1 || getBytes(leg.program).length < 2) {
      throw new Error("invalid startup prefix continuity or program");
    }
  }
  const flowHash = runtimeSettlementFlowHash(input.amount, 0n, legs);
  // Existing deployed executors accept a bounded diagnostic tag. Keep tag zero
  // and authenticate each logical hop with a distinct flow hash instead of
  // requiring new executor code when the price-path policy changes.
  const diagnosticFlowHashes = Object.freeze([-1, ...legs.map((_, index) => index)]
    .map(index => keccak256(ABI.encode(["bytes32", "uint256"], [flowHash, index < 0 ? MaxUint256 : BigInt(index)]))));
  const recorder = getAddress(`0x${keccak256(toUtf8Bytes(`startup-prefix-receipt:${actor}:${flowHash}`)).slice(-40)}`);
  if ([actor, weth, ...legs.flatMap(leg => [leg.tokenIn, leg.tokenOut])].includes(recorder)) {
    throw new Error("startup prefix recorder collision");
  }
  const balance = RUNTIME_ERC20.encodeFunctionData("balanceOf", [actor]);
  const emit = (p: RuntimeAmountProgram, hop: number, inputReg: number, outputReg: number, spentReg: number) => p.call(recorder,
    RECORD.encodeFunctionData("record", [hop, 0n, 0n, 0n]),
    { patches: [{ offset: 36, reg: inputReg }, { offset: 68, reg: outputReg }, { offset: 100, reg: spentReg }] });
  const program = new RuntimeAmountProgram().diagnosticHop(0, diagnosticFlowHashes[0]!)
    .call(weth, balance, { static: true }).load(1, 0)
    .call(weth, RUNTIME_WRAP.encodeFunctionData("deposit"), { valueReg: 0 })
    .call(weth, balance, { static: true }).load(2, 0).math("sub", 2, 2, 1).equal(2, 0);
  emit(program, fundingContext, 0, 2, 0);
  legs.forEach((leg, index) => {
    const diagnosticFlowHash = diagnosticFlowHashes[index + 1]!;
    const p = new RuntimeAmountProgram().diagnosticHop(0, diagnosticFlowHash)
      .call(leg.tokenIn, balance, { static: true }).load(1, 0).math("sub", 1, 1, 0)
      .call(leg.tokenOut, balance, { static: true }).load(2, 0)
      .constant(7, 0n).math("add", 7, 0, 7)
      .run(withRuntimeHopContext(0, diagnosticFlowHash, leg.program), 0, 3)
      .call(leg.tokenIn, balance, { static: true }).load(4, 0).math("sub", 4, 4, 1)
      .math("sub", 5, 7, 4)
      .call(leg.tokenOut, balance, { static: true }).load(4, 0).math("sub", 0, 4, 2);
    emit(p, index, 7, 0, 5);
    program.run(p.bytes(), 0, 0);
  });
  return Object.freeze({ amount: input.amount, maxInputPathHops, fundingContext, legs: Object.freeze(legs), flowHash,
    diagnosticFlowHashes, recorder,
    recorderCode: recorderCode(actor), scriptHex: hexlify(runtimeProgramScript(program.bytes(), input.amount)) });
}

export function startupPrefixReceipts(logs: unknown, compiled: ReturnType<typeof compileStartupPrefix>): readonly StartupPrefixReceipt[] {
  if (!Array.isArray(logs)) throw new Error("startup prefix receipts missing");
  const receipts: StartupPrefixReceipt[] = [];
  for (const log of logs) {
    if (!log || typeof log.address !== "string" || log.address.toLowerCase() !== compiled.recorder.toLowerCase()) continue;
    if (!Array.isArray(log.topics) || log.topics.length !== 1 || log.topics[0]?.toLowerCase() !== STARTUP_RECEIPT_TOPIC ||
        typeof log.data !== "string" || !/^0x[0-9a-fA-F]{256}$/.test(log.data)) throw new Error("invalid startup prefix receipt");
    const [hop, amountIn, amountOut, amountSpent] = ABI.decode(["uint256", "uint256", "uint256", "uint256"], log.data) as unknown as bigint[];
    const expectedHop = receipts.length === 0 ? compiled.fundingContext : receipts.length - 1;
    const expectedIn = receipts.at(-1)?.amountOut ?? compiled.amount;
    if (hop !== BigInt(expectedHop) || amountIn !== expectedIn || amountSpent! > amountIn! ||
        receipts.length === 0 && (amountOut !== compiled.amount || amountSpent !== compiled.amount)) {
      throw new Error("startup prefix receipt continuity mismatch");
    }
    receipts.push(Object.freeze({ hop: receipts.length === 0 ? -1 : expectedHop,
      amountIn: amountIn!, amountSpent: amountSpent!, amountOut: amountOut! }));
  }
  if (receipts.length !== compiled.legs.length + 1) throw new Error("startup prefix receipt coverage mismatch");
  return Object.freeze(receipts);
}

/** Same authenticated production hop envelope. No guessed hop from strings,
 * selectors or an unauthenticated pool-supplied error. */
export function startupPrefixFailure(raw: string, errorData: unknown, key: string,
  compiled: ReturnType<typeof compileStartupPrefix>): { hop: number; callTarget: string; reason: string } | undefined {
  if (typeof errorData === "string" && errorData !== "0x" && raw !== "0x" && errorData.toLowerCase() !== raw.toLowerCase()) return;
  let data = raw === "0x" && typeof errorData === "string" ? errorData : raw;
  let result: { hop: number; callTarget: string; reason: string } | undefined;
  for (let depth = 0; depth < 8; depth++) {
    let decoded;
    try { decoded = FAILURE.parseError(data); } catch { break; }
    // ethers also recognizes built-in Error/Panic, even when they were not
    // declared on this Interface. They are not authenticated hop envelopes.
    if (!decoded || decoded.name !== "RuntimeHopFailed" ||
        FAILURE.encodeErrorResult(decoded.fragment, decoded.args).toLowerCase() !== data.toLowerCase()) break;
    const [hop, target, flow, reason, proof] = decoded.args;
    const logicalHop = compiled.diagnosticFlowHashes.indexOf(flow.toLowerCase()) - 1;
    if (hop !== 0n || logicalHop < -1 || logicalHop >= compiled.legs.length) break;
    const expected = keccak256(ABI.encode(["bytes32", "uint256", "address", "bytes32", "bytes32"],
      [key, hop, target, flow, keccak256(reason)]));
    if (proof.toLowerCase() !== expected) break;
    result = { hop: logicalHop, callTarget: target.toLowerCase(), reason };
    data = reason;
  }
  return result;
}

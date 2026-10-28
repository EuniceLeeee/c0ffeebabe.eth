import assert from "node:assert/strict";
import { ethers } from "ethers";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { MULTICALL, NATIVE, normalizedToken, POOL, TOKEN, WETH, WRAP } from "../codec.js";
const ERC20 = new ethers.Interface([
  "function approve(address,uint256) returns(bool)", "function allowance(address,address) view returns(uint256)",
  "function transfer(address,uint256) returns(bool)",
]);
const SUBSCRIPT = new ethers.Interface(["function execSubscript(bytes)"]);
const word = (n: bigint) => ethers.toBeHex(n, 32);
const lower = (s: string) => s.toLowerCase();

// Synthetic effects through the existing independent bytecode interpreter.
// No EVM, rollback, admission or historical-execution claim is made by this model.
// It has no success postconditions: rejection tests must fail inside the program.
export function runProgram(bytes: Uint8Array, i: {
  pool: string; executor: string; rawIn: string; rawOut: string; amountIn: bigint; amountOut: bigint;
  nativeBaseline: bigint; oldOutput: bigint; wrapped?: boolean; recipient?: string; spent?: bigint;
  nativeResidue?: bigint; deliveredOut?: bigint; wrongRecipient?: boolean; actorOutputChange?: bigint;
  recipientInputChange?: bigint; recipientNativeChange?: bigint; wrapLoss?: bigint; transferLoss?: bigint;
  ignoreApprovalClear?: boolean; hook?: bigint; creatorFee?: bigint; unfunded?: boolean;
}) {
  const actor = lower(i.executor), receiver = lower(i.recipient ?? actor), tokenIn = normalizedToken(i.rawIn), tokenOut = normalizedToken(i.rawOut);
  const key = (token: string, account: string) => lower(token) + ":" + lower(account);
  const balances = new Map<string, bigint>();
  const get = (token: string, account: string) => balances.get(key(token, account)) ?? 0n;
  const put = (token: string, account: string, amount: bigint) => { assert(amount >= 0n, "model balance underflow"); balances.set(key(token, account), amount); };
  const oldInput = 888n, oldReceiverInput = 333n, oldReceiverOutput = 444n, oldReceiverNative = 555n;
  put(tokenIn, actor, i.unfunded ? 0n : (i.wrapped || i.rawIn !== ethers.ZeroAddress ? i.amountIn : 0n) + oldInput);
  put(tokenOut, actor, i.oldOutput);
  if (receiver !== actor) { put(tokenIn, receiver, oldReceiverInput); put(tokenOut, receiver, oldReceiverOutput); }
  let native = i.nativeBaseline + (!i.wrapped && i.rawIn === ethers.ZeroAddress && !i.unfunded ? i.amountIn : 0n);
  let recipientNative = oldReceiverNative, allowance = 0n, allowances = 0, swapInput = 0n;
  const initialInput = i.wrapped || i.rawIn !== ethers.ZeroAddress ? get(tokenIn, actor) : native;
  const outputBefore = get(tokenOut, receiver), approvalAmounts: bigint[] = [];
  const calls: { target: string; data: string; value: bigint }[] = [];
  const execute = (program: string, amount: bigint) => inspectRuntime(program, amount, {
    nativeBalance: () => native,
    allowance(grant) {
      assert.equal(lower(grant.token), i.rawIn); assert.equal(lower(grant.spender), i.pool);
      assert.equal(grant.minimum, amount); allowance = grant.grant; allowances++;
    },
    call(call) {
      calls.push(call);
      const target = lower(call.target), selector = call.data.slice(0, 10);
      if (target === actor && selector === SUBSCRIPT.getFunction("execSubscript")!.selector) {
        const script = ethers.getBytes(SUBSCRIPT.decodeFunctionData("execSubscript", call.data)[0]);
        assert.equal(script[0], 0x0e); assert.equal(Number(BigInt(ethers.hexlify(script.slice(33, 36)))), script.length - 36);
        execute(ethers.hexlify(script.slice(36)), BigInt(ethers.hexlify(script.slice(1, 33)))); return "0x";
      }
      if (target === MULTICALL) {
        const account = lower(NATIVE.decodeFunctionData("getEthBalance", call.data)[0]);
        assert(account === actor || account === receiver); return word(account === actor ? native : recipientNative);
      }
      if (selector === TOKEN.getFunction("balanceOf")!.selector)
        return word(get(target, TOKEN.decodeFunctionData("balanceOf", call.data)[0]));
      if (selector === ERC20.getFunction("allowance")!.selector) {
        const [owner, spender] = ERC20.decodeFunctionData("allowance", call.data);
        assert.equal(lower(owner), actor); assert.equal(lower(spender), i.pool); return word(allowance);
      }
      if (selector === ERC20.getFunction("approve")!.selector) {
        const [spender, approved] = ERC20.decodeFunctionData("approve", call.data);
        assert.equal(target, i.rawIn); assert.equal(lower(spender), i.pool); approvalAmounts.push(approved);
        if (!i.ignoreApprovalClear || approved !== 0n || swapInput === 0n) allowance = approved;
        return word(1n);
      }
      if (target === WETH && selector === WRAP.getFunction("withdraw")!.selector) {
        const value = WRAP.decodeFunctionData("withdraw", call.data)[0];
        put(WETH, actor, get(WETH, actor) - value); native += value; return "0x";
      }
      if (target === WETH && selector === WRAP.getFunction("deposit")!.selector) {
        native -= call.value; assert(native >= 0n, "model native underflow");
        put(WETH, actor, get(WETH, actor) + call.value - (i.wrapLoss ?? 0n)); return "0x";
      }
      if (selector === ERC20.getFunction("transfer")!.selector) {
        const [to, value] = ERC20.decodeFunctionData("transfer", call.data);
        put(target, actor, get(target, actor) - value); put(target, to, get(target, to) + value - (i.transferLoss ?? 0n)); return word(1n);
      }
      if (target === i.pool && selector === POOL.getFunction("hook")!.selector) return word(i.hook ?? 0n);
      if (target === i.pool && selector === POOL.getFunction("creatorFeeBps")!.selector) return word(i.creatorFee ?? 0n);
      if (target === i.pool && selector === POOL.getFunction("swapExactIn")!.selector) {
        const [rawIn, input, minimum, to] = POOL.decodeFunctionData("swapExactIn", call.data);
        assert.equal(lower(rawIn), i.rawIn); assert.equal(input, i.amountIn); swapInput = input;
        assert(i.amountOut >= minimum, "swap minimum");
        const spent = i.spent ?? input;
        if (i.rawIn === ethers.ZeroAddress) {
          assert.equal(call.value, input); native -= spent; assert(native >= 0n, "model native underflow");
        } else {
          assert.equal(call.value, 0n); assert(allowance >= input, "model missing allowance");
          put(tokenIn, actor, get(tokenIn, actor) - spent);
          // Keep a residual in the faulty approval case to exercise the cleanup
          // guard independently of the token's transferFrom allowance policy.
          if (allowance !== ethers.MaxUint256 && !i.ignoreApprovalClear) allowance -= input;
        }
        const receipt = i.deliveredOut ?? i.amountOut, actualTo = i.wrongRecipient ? actor : lower(to);
        if (i.rawOut === ethers.ZeroAddress) { assert.equal(actualTo, actor); native += receipt; }
        else put(tokenOut, actualTo, get(tokenOut, actualTo) + receipt);
        if (receiver !== actor) {
          put(tokenOut, actor, get(tokenOut, actor) + (i.actorOutputChange ?? 0n));
          put(tokenIn, receiver, get(tokenIn, receiver) + (i.recipientInputChange ?? 0n));
          recipientNative += i.recipientNativeChange ?? 0n;
        }
        native += i.nativeResidue ?? 0n; return word(i.amountOut);
      }
      throw Error("unexpected model call: " + target + " " + selector);
    },
  });
  const inspected = execute(ethers.hexlify(bytes), i.amountIn);
  return {
    outputDelta: (i.wrapped || i.rawOut !== ethers.ZeroAddress ? get(tokenOut, receiver) - outputBefore : native - i.nativeBaseline),
    nativeBalance: native, allowances, allowance, approvalAmounts, swapInput,
    spent: initialInput - (i.wrapped || i.rawIn !== ethers.ZeroAddress ? get(tokenIn, actor) : native),
    actorOutput: get(tokenOut, actor), recipientInput: get(tokenIn, receiver), recipientNative,
    oldInput, oldReceiverInput, oldReceiverOutput, oldReceiverNative, calls, inspected,
  };
}

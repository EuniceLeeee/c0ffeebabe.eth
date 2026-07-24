import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { quote } from "../solver/quoter.js";
import { quoteProtocolLeg } from "../venues/protocols/protocol-quote.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const wstETHIface = new ethers.Interface([
  "function getWstETHByStETH(uint256 _stETHAmount) view returns (uint256)",
  "function getStETHByWstETH(uint256 _wstETHAmount) view returns (uint256)",
]);

const WRAP_RATE_SELECTOR = wstETHIface.encodeFunctionData("getWstETHByStETH", [0n]).slice(0, 10);
const UNWRAP_RATE_SELECTOR = wstETHIface.encodeFunctionData("getStETHByWstETH", [0n]).slice(0, 10);

interface MockCall {
  fn: "getWstETHByStETH" | "getStETHByWstETH";
  amount: bigint;
}

interface MockState {
  state: StateBackend;
  calls: MockCall[];
}

function mockState(wrapOut: bigint, unwrapOut: bigint): MockState {
  const calls: MockCall[] = [];
  const state = {
    async call(req: { to: string; data: string }): Promise<string> {
      if (req.to.toLowerCase() !== ADDR.WSTETH.toLowerCase()) {
        throw new Error(`unexpected wstETH target ${req.to}`);
      }
      const selector = req.data.slice(0, 10);
      if (selector === WRAP_RATE_SELECTOR) {
        const decoded = wstETHIface.decodeFunctionData("getWstETHByStETH", req.data);
        calls.push({ fn: "getWstETHByStETH", amount: BigInt(decoded[0]) });
        return wstETHIface.encodeFunctionResult("getWstETHByStETH", [wrapOut]);
      }
      if (selector === UNWRAP_RATE_SELECTOR) {
        const decoded = wstETHIface.decodeFunctionData("getStETHByWstETH", req.data);
        calls.push({ fn: "getStETHByWstETH", amount: BigInt(decoded[0]) });
        return wstETHIface.encodeFunctionResult("getStETHByWstETH", [unwrapOut]);
      }
      throw new Error(`unexpected wstETH calldata ${req.data}`);
    },
  } as unknown as StateBackend;
  return { state, calls };
}

async function quoteWstETH(
  adapterId: "wsteth-wrap" | "wsteth-unwrap",
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  state: StateBackend,
): Promise<bigint> {
  return quote(adapterId, ADDR.WSTETH, tokenIn, tokenOut, amountIn, state);
}

async function testWrapUsesGetWstETHByStETH(): Promise<void> {
  const expected = 987_654_321n;
  const { state, calls } = mockState(expected, 0n);
  const amountIn = 1_234_567_890n;

  const out = await quoteWstETH("wsteth-wrap", ADDR.STETH, ADDR.WSTETH, amountIn, state);

  assert(out === expected, `wrap output expected ${expected}, got ${out}`);
  assert(calls.length === 1, `wrap should make one call, got ${calls.length}`);
  assert(calls[0].fn === "getWstETHByStETH", `wrap called ${calls[0].fn}`);
  assert(calls[0].amount === amountIn, `wrap amount expected ${amountIn}, got ${calls[0].amount}`);
  console.log("[wsteth-quote] wrap uses getWstETHByStETH: PASS");
}

async function testUnwrapUsesGetStETHByWstETH(): Promise<void> {
  const expected = 1_234_567_890n;
  const { state, calls } = mockState(0n, expected);
  const amountIn = 987_654_321n;

  const out = await quoteWstETH("wsteth-unwrap", ADDR.WSTETH, ADDR.STETH, amountIn, state);

  assert(out === expected, `unwrap output expected ${expected}, got ${out}`);
  assert(calls.length === 1, `unwrap should make one call, got ${calls.length}`);
  assert(calls[0].fn === "getStETHByWstETH", `unwrap called ${calls[0].fn}`);
  assert(calls[0].amount === amountIn, `unwrap amount expected ${amountIn}, got ${calls[0].amount}`);
  console.log("[wsteth-quote] unwrap uses getStETHByWstETH: PASS");
}

async function testUnknownAdapterIdThrows(): Promise<void> {
  const { state, calls } = mockState(0n, 0n);
  let threw = false;
  try {
    await quoteProtocolLeg(state, ADDR.WSTETH, "wsteth-bogus", 1n);
  } catch (err) {
    threw = err instanceof Error && err.message.includes("protocol leg quote descriptor not found");
  }

  assert(threw, "unknown adapterId should throw descriptor lookup error");
  assert(calls.length === 0, `unknown adapterId should not call rate view, got ${calls.length} calls`);
  console.log("[wsteth-quote] unknown adapterId rejected: PASS");
}

async function main(): Promise<void> {
  const tests = [
    testWrapUsesGetWstETHByStETH,
    testUnwrapUsesGetStETHByWstETH,
    testUnknownAdapterIdThrows,
  ];
  let passed = 0;
  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err) {
      console.error(`[wsteth-quote] ${test.name}: FAIL`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
  console.log(`wsteth-quote PASS (${passed}/${tests.length})`);
}

main().catch((err) => {
  console.error(`[wsteth-quote] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

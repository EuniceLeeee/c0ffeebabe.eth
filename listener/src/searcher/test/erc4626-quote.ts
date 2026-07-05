import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { quote } from "../solver/quoter.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const erc4626Iface = new ethers.Interface([
  "function previewDeposit(uint256 assets) view returns (uint256 shares)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
]);

const PREVIEW_DEPOSIT_SELECTOR = erc4626Iface.encodeFunctionData("previewDeposit", [0n]).slice(0, 10);
const PREVIEW_REDEEM_SELECTOR = erc4626Iface.encodeFunctionData("previewRedeem", [0n]).slice(0, 10);

interface MockCall {
  fn: "previewDeposit" | "previewRedeem";
  amount: bigint;
}

interface MockState {
  state: StateBackend;
  calls: MockCall[];
}

function mockState(depositOut: bigint, redeemOut: bigint): MockState {
  const calls: MockCall[] = [];
  const state = {
    async call(req: { to: string; data: string }): Promise<string> {
      if (req.to.toLowerCase() !== ADDR.SUSDS.toLowerCase()) {
        throw new Error(`unexpected ERC4626 target ${req.to}`);
      }
      const selector = req.data.slice(0, 10);
      if (selector === PREVIEW_DEPOSIT_SELECTOR) {
        const decoded = erc4626Iface.decodeFunctionData("previewDeposit", req.data);
        calls.push({ fn: "previewDeposit", amount: BigInt(decoded[0]) });
        return erc4626Iface.encodeFunctionResult("previewDeposit", [depositOut]);
      }
      if (selector === PREVIEW_REDEEM_SELECTOR) {
        const decoded = erc4626Iface.decodeFunctionData("previewRedeem", req.data);
        calls.push({ fn: "previewRedeem", amount: BigInt(decoded[0]) });
        return erc4626Iface.encodeFunctionResult("previewRedeem", [redeemOut]);
      }
      throw new Error(`unexpected ERC4626 calldata ${req.data}`);
    },
  } as unknown as StateBackend;
  return { state, calls };
}

async function quoteErc4626(
  adapterId: "erc4626-deposit" | "erc4626-redeem",
  amountIn: bigint,
  state: StateBackend,
): Promise<bigint> {
  return quote(adapterId, ADDR.SUSDS, ADDR.USDS, ADDR.SUSDS, amountIn, state);
}

async function testDepositUsesPreviewDeposit(): Promise<void> {
  const expected = 987_654_321n;
  const { state, calls } = mockState(expected, 0n);
  const amountIn = 1_234_567_890n;

  const out = await quoteErc4626("erc4626-deposit", amountIn, state);

  assert(out === expected, `deposit output expected ${expected}, got ${out}`);
  assert(calls.length === 1, `deposit should make one call, got ${calls.length}`);
  assert(calls[0].fn === "previewDeposit", `deposit called ${calls[0].fn}`);
  assert(calls[0].amount === amountIn, `deposit amount expected ${amountIn}, got ${calls[0].amount}`);
  console.log("[erc4626-quote] deposit uses previewDeposit: PASS");
}

async function testRedeemUsesPreviewRedeem(): Promise<void> {
  const expected = 1_234_567_890n;
  const { state, calls } = mockState(0n, expected);
  const amountIn = 987_654_321n;

  const out = await quoteErc4626("erc4626-redeem", amountIn, state);

  assert(out === expected, `redeem output expected ${expected}, got ${out}`);
  assert(calls.length === 1, `redeem should make one call, got ${calls.length}`);
  assert(calls[0].fn === "previewRedeem", `redeem called ${calls[0].fn}`);
  assert(calls[0].amount === amountIn, `redeem amount expected ${amountIn}, got ${calls[0].amount}`);
  console.log("[erc4626-quote] redeem uses previewRedeem: PASS");
}

async function testZeroAmountShortCircuitsBeforePreview(): Promise<void> {
  const { state, calls } = mockState(1n, 1n);

  const out = await quoteErc4626("erc4626-deposit", 0n, state);

  assert(out === 0n, `zero amount expected 0, got ${out}`);
  assert(calls.length === 0, `zero amount should not call preview, got ${calls.length} calls`);
  console.log("[erc4626-quote] dispatch zero-amount short circuit: PASS");
}

async function main(): Promise<void> {
  const tests = [
    testDepositUsesPreviewDeposit,
    testRedeemUsesPreviewRedeem,
    testZeroAmountShortCircuitsBeforePreview,
  ];
  let passed = 0;
  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err) {
      console.error(`[erc4626-quote] ${test.name}: FAIL`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
  console.log(`erc4626-quote PASS (${passed}/${tests.length})`);
}

main().catch((err) => {
  console.error(`[erc4626-quote] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

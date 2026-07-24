import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { quote } from "../solver/quoter.js";
import { quoteProtocolLeg } from "../venues/protocols/protocol-quote.js";

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

const SRUSDE = "0x3d7d6fdf07EE548B939A80edbc9B2256d0cdc003";
const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
const siloIface = new ethers.Interface([
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function previewWithdraw(uint256 assets) view returns (uint256 shares)",
]);
const SILO_PREVIEW_REDEEM_SELECTOR = siloIface.encodeFunctionData("previewRedeem", [0n]).slice(0, 10);
const SILO_PREVIEW_WITHDRAW_SELECTOR = siloIface.encodeFunctionData("previewWithdraw", [0n]).slice(0, 10);

// The non-standard silo redeem quote is a two-CONTRACT composition:
// out = sUSDe.previewWithdraw( srUSDe.previewRedeem(shares) ) — byte-exact to the on-chain payout.
async function testSiloRedeemComposesTwoCalls(): Promise<void> {
  const shares = 934_460_889_828_731_878_592n;          // exact srUSDe burned in 0xf391d0
  const assetsValue = 958_150_733_475_481_205_886n;      // srUSDe.previewRedeem -> USDe-denominated value
  const expectedOut = 773_988_354_296_524_711_820n;      // sUSDe.previewWithdraw(value) -> sUSDe paid
  const seenCalls: Array<{ to: string; fn: string; amount: bigint }> = [];
  const state = {
    async call(req: { to: string; data: string }): Promise<string> {
      const selector = req.data.slice(0, 10);
      if (req.to.toLowerCase() === SRUSDE.toLowerCase() && selector === SILO_PREVIEW_REDEEM_SELECTOR) {
        const decoded = siloIface.decodeFunctionData("previewRedeem", req.data);
        seenCalls.push({ to: "srUSDe", fn: "previewRedeem", amount: BigInt(decoded[0]) });
        return siloIface.encodeFunctionResult("previewRedeem", [assetsValue]);
      }
      if (req.to.toLowerCase() === SUSDE.toLowerCase() && selector === SILO_PREVIEW_WITHDRAW_SELECTOR) {
        const decoded = siloIface.decodeFunctionData("previewWithdraw", req.data);
        seenCalls.push({ to: "sUSDe", fn: "previewWithdraw", amount: BigInt(decoded[0]) });
        return siloIface.encodeFunctionResult("previewWithdraw", [expectedOut]);
      }
      throw new Error(`unexpected silo call to ${req.to} selector ${selector}`);
    },
  } as unknown as StateBackend;

  const out = await quote("erc4626-redeem-silo", SRUSDE, SRUSDE, SUSDE, shares, state);

  assert(out === expectedOut, `silo redeem output expected ${expectedOut}, got ${out}`);
  assert(seenCalls.length === 2, `silo redeem should make two calls, got ${seenCalls.length}`);
  assert(seenCalls[0].to === "srUSDe" && seenCalls[0].fn === "previewRedeem", `first call must be srUSDe.previewRedeem, got ${seenCalls[0].to}.${seenCalls[0].fn}`);
  assert(seenCalls[0].amount === shares, `previewRedeem amount expected ${shares}, got ${seenCalls[0].amount}`);
  assert(seenCalls[1].to === "sUSDe" && seenCalls[1].fn === "previewWithdraw", `second call must be sUSDe.previewWithdraw, got ${seenCalls[1].to}.${seenCalls[1].fn}`);
  assert(seenCalls[1].amount === assetsValue, `previewWithdraw fed the previewRedeem value ${assetsValue}, got ${seenCalls[1].amount}`);
  console.log("[erc4626-quote] silo redeem composes previewRedeem->previewWithdraw across two contracts: PASS");
}

async function testUnknownAdapterIdThrows(): Promise<void> {
  const { state, calls } = mockState(0n, 0n);
  let threw = false;
  try {
    await quoteProtocolLeg(state, ADDR.SUSDS, "erc4626-bogus", 1n);
  } catch (err) {
    threw = err instanceof Error && err.message.includes("protocol leg quote descriptor not found");
  }

  assert(threw, "unknown adapterId should throw descriptor lookup error");
  assert(calls.length === 0, `unknown adapterId should not call preview, got ${calls.length} calls`);
  console.log("[erc4626-quote] unknown adapterId rejected: PASS");
}

async function main(): Promise<void> {
  const tests = [
    testDepositUsesPreviewDeposit,
    testRedeemUsesPreviewRedeem,
    testSiloRedeemComposesTwoCalls,
    testZeroAmountShortCircuitsBeforePreview,
    testUnknownAdapterIdThrows,
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

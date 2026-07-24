import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { quote } from "../solver/quoter.js";
import { psmAdapter } from "../venues/protocols/psm.js";
import type { PreparedRouteContext } from "../venues/route-leg-adapter.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const psmIface = new ethers.Interface([
  "function tin() view returns (uint256)",
  "function tout() view returns (uint256)",
]);
const WAD = 10n ** 18n;
const PSM_TO18 = 10n ** 12n;

interface MockState {
  state: StateBackend;
  calls: string[];
}

function mockState(tin: bigint, tout: bigint, failReads = false): MockState {
  const calls: string[] = [];
  const state = {
    async call(req: { to: string; data: string }): Promise<string> {
      calls.push(req.data);
      if (failReads) throw new Error("mock fee read failed");
      if (req.to.toLowerCase() !== ADDR.SKY_PSM_LITE.toLowerCase()) {
        throw new Error(`unexpected PSM target ${req.to}`);
      }
      if (req.data === psmIface.encodeFunctionData("tin")) {
        return psmIface.encodeFunctionResult("tin", [tin]);
      }
      if (req.data === psmIface.encodeFunctionData("tout")) {
        return psmIface.encodeFunctionResult("tout", [tout]);
      }
      throw new Error(`unexpected PSM calldata ${req.data}`);
    },
  } as unknown as StateBackend;
  return { state, calls };
}

async function quotePsm(tokenIn: string, tokenOut: string, amountIn: bigint, state: StateBackend): Promise<bigint> {
  return quote("psm", ADDR.SKY_PSM_LITE, tokenIn, tokenOut, amountIn, state);
}

async function testZeroFeeMatchesOldScaling(): Promise<void> {
  const { state } = mockState(0n, 0n);
  const usdcIn = 1_234_567n;
  const daiIn = 1_234_567n * PSM_TO18;

  const daiOut = await quotePsm(ADDR.USDC, ADDR.DAI, usdcIn, state);
  const usdcOut = await quotePsm(ADDR.DAI, ADDR.USDC, daiIn, state);

  assert(daiOut === usdcIn * PSM_TO18, `zero fee USDC->DAI ${daiOut}`);
  assert(usdcOut === daiIn / PSM_TO18, `zero fee DAI->USDC ${usdcOut}`);
  console.log("[psm-quote] zero-fee scaling matches old behavior: PASS");
}

async function testSellGemAppliesTin(): Promise<void> {
  const tin = 10n ** 15n;
  const { state } = mockState(tin, 0n);
  const usdcIn = 1_000_000n;
  const scaled = usdcIn * PSM_TO18;
  const expected = scaled - scaled * tin / WAD;

  const out = await quotePsm(ADDR.USDC, ADDR.DAI, usdcIn, state);

  assert(out === expected, `tin fee expected ${expected}, got ${out}`);
  assert(out < scaled, "tin fee should reduce USDC->DAI output");
  console.log("[psm-quote] tin sellGem fee applied: PASS");
}

async function testBuyGemAppliesTout(): Promise<void> {
  const tout = 10n ** 15n;
  const { state } = mockState(0n, tout);
  const daiIn = 1_000_000_000_000_000_000n;
  const zeroFeeOut = daiIn / PSM_TO18;
  const expected = (daiIn * WAD / (WAD + tout)) / PSM_TO18;

  const out = await quotePsm(ADDR.DAI, ADDR.USDC, daiIn, state);

  assert(out === expected, `tout fee expected ${expected}, got ${out}`);
  assert(out < zeroFeeOut, "tout fee should reduce DAI->USDC output");
  console.log("[psm-quote] tout buyGem fee applied: PASS");
}

async function testFeeReadFailureIsUnresolved(): Promise<void> {
  const { state } = mockState(123n, 456n, true);
  const usdcIn = 42_000_000n;
  let rejected = false;
  try {
    await quotePsm(ADDR.USDC, ADDR.DAI, usdcIn, state);
  } catch (error) {
    rejected = error instanceof Error &&
      error.message.includes("PSM fee unresolved");
  }
  assert(rejected, "fee read failure must fail closed, not assume zero fee");
  console.log("[psm-quote] fee read failure is unresolved: PASS");
}

async function testPreparedQuoteReadsCurrentFee(): Promise<void> {
  const tin = 5n * 10n ** 15n;
  const amountIn = 2_000_000n;
  const scaled = amountIn * PSM_TO18;
  const expected = scaled - scaled * tin / WAD;
  const calls: string[] = [];
  const context = {
    request: {
      adapterId: "psm",
      target: ADDR.SKY_PSM_LITE,
      tokenIn: ADDR.USDC,
      tokenOut: ADDR.DAI,
      amountIn,
    },
    async callPrepared(to: string, data: string) {
      assert(
        to.toLowerCase() === ADDR.SKY_PSM_LITE.toLowerCase(),
        `prepared PSM target ${to}`,
      );
      calls.push(data);
      if (data !== psmIface.encodeFunctionData("tin")) {
        throw new Error(`unexpected prepared PSM calldata ${data}`);
      }
      return {
        output: psmIface.encodeFunctionResult("tin", [tin]),
        latencyMs: 1,
      };
    },
  } as unknown as PreparedRouteContext;
  const result = await psmAdapter.prepared!.quote!(context);
  const prewarm = await psmAdapter.prepared!.encodeQuotePrewarm!(context);
  assert(result.amountOut === expected, `prepared current fee expected ${expected}, got ${result.amountOut}`);
  assert(calls.length === 1, `prepared PSM quote should read one directional fee, got ${calls.length}`);
  assert(
    prewarm.length === 1 &&
      prewarm[0].calldata === psmIface.encodeFunctionData("tin"),
    "prepared PSM prewarm must cover the current directional fee read",
  );
  console.log("[psm-quote] prepared quote reads current directional fee: PASS");
}

async function testRejectsNonPsmPair(): Promise<void> {
  const { state, calls } = mockState(0n, 0n);
  let threw = false;
  try {
    await quotePsm(ADDR.USDC, ADDR.WETH, 1n, state);
  } catch (err) {
    threw = err instanceof Error && err.message.includes("PSM only supports USDC<->DAI");
  }

  assert(threw, "non-USDC/DAI pair should throw PSM support error");
  assert(calls.length === 0, `unsupported pair should not read fees, got ${calls.length} calls`);
  console.log("[psm-quote] non-USDC/DAI pair rejected: PASS");
}

async function main(): Promise<void> {
  const tests = [
    testZeroFeeMatchesOldScaling,
    testSellGemAppliesTin,
    testBuyGemAppliesTout,
    testFeeReadFailureIsUnresolved,
    testPreparedQuoteReadsCurrentFee,
    testRejectsNonPsmPair,
  ];
  let passed = 0;
  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err) {
      console.error(`[psm-quote] ${test.name}: FAIL`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
  console.log(`psm-quote PASS (${passed}/${tests.length})`);
}

main().catch((err) => {
  console.error(`[psm-quote] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

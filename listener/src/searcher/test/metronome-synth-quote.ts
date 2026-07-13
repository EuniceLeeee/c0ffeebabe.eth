import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { metronomeSynthPoolIface, quote } from "../solver/quoter.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

interface MockCall {
  synthIn: string;
  synthOut: string;
  amountIn: bigint;
}

interface MockState {
  state: StateBackend;
  calls: MockCall[];
}

function mockState(amountOut: bigint, fee: bigint): MockState {
  const calls: MockCall[] = [];
  const state = {
    async call(req: { to: string; data: string }): Promise<string> {
      if (req.to.toLowerCase() !== ADDR.METRONOME_SYNTH_POOL.toLowerCase()) {
        throw new Error(`unexpected Metronome pool ${req.to}`);
      }
      const decoded = metronomeSynthPoolIface.decodeFunctionData("quoteSwapOut", req.data);
      calls.push({
        synthIn: ethers.getAddress(String(decoded[0])),
        synthOut: ethers.getAddress(String(decoded[1])),
        amountIn: BigInt(decoded[2]),
      });
      return metronomeSynthPoolIface.encodeFunctionResult("quoteSwapOut", [amountOut, fee]);
    },
  } as unknown as StateBackend;
  return { state, calls };
}

async function testQuoteSwapOutUsesPoolView(): Promise<void> {
  const amountIn = 10n ** 18n;
  const amountOut = 28_299_263_936_885_873n;
  const fee = 70_923_969_767_154n;
  const { state, calls } = mockState(amountOut, fee);

  const out = await quote(
    "metronome-synth-swap",
    ADDR.METRONOME_SYNTH_POOL,
    ADDR.MSETH,
    ADDR.MSBTC,
    amountIn,
    state,
  );

  assert(out === amountOut, `amountOut expected ${amountOut}, got ${out}`);
  assert(calls.length === 1, `quote should make one call, got ${calls.length}`);
  assert(calls[0].synthIn.toLowerCase() === ADDR.MSETH.toLowerCase(), `synthIn ${calls[0].synthIn}`);
  assert(calls[0].synthOut.toLowerCase() === ADDR.MSBTC.toLowerCase(), `synthOut ${calls[0].synthOut}`);
  assert(calls[0].amountIn === amountIn, `amountIn ${calls[0].amountIn}`);
  console.log("[metronome-synth-quote] quoteSwapOut amountOut selected: PASS");
}

async function main(): Promise<void> {
  const tests = [testQuoteSwapOutUsesPoolView];
  let passed = 0;
  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err) {
      console.error(`[metronome-synth-quote] ${test.name}: FAIL`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
  console.log(`metronome-synth-quote PASS (${passed}/${tests.length})`);
}

main().catch((err) => {
  console.error(`[metronome-synth-quote] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

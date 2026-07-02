import { tmpdir } from "node:os";

const WETH_ADDR = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const FRAX_ADDR = "0x853d955acef822db058eb8505911ed77f175b99e";
const UNKNOWN_ADDR = "0x0000000000000000000000000000000000000001";
const ONE_ETH = 1_000_000_000_000_000_000n;

type ValueInEth = (token: string, amount: bigint, ethUsd: number) => bigint;

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function loadValueInEth(): Promise<ValueInEth> {
  const originalExit = process.exit;
  const originalError = console.error;
  const originalCwd = process.cwd();
  const env: Record<string, string> = {
    SEARCHER_LIVE_RPC_URL: "http://127.0.0.1:0",
    MAINNET_RPC_URL: "http://127.0.0.1:0",
    PRIVATE_KEY: "0x00",
    BOTVM_ADDRESS: UNKNOWN_ADDR,
  };
  const previousEnv = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(env)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  process.exit = (() => undefined as never) as typeof process.exit;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[searcher/live] fatal:")) return;
    originalError(...args);
  };

  try {
    process.chdir(tmpdir());
    const mod = await import("../main.js");
    await new Promise<void>((resolve) => setImmediate(resolve));
    return mod.valueInEth;
  } finally {
    process.chdir(originalCwd);
    process.exit = originalExit;
    console.error = originalError;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

async function main(): Promise<void> {
  const valueInEth = await loadValueInEth();

  const weth = valueInEth(WETH_ADDR, ONE_ETH, 3500);
  assert(weth === ONE_ETH, `WETH should value 1:1, got ${weth}`);
  console.log("[value-in-eth] PASS WETH passthrough");

  const frax = valueInEth(FRAX_ADDR, ONE_ETH, 3500);
  const expectedFrax = ONE_ETH / 3500n;
  assert(frax > 0n, "FRAX should value as a stable, not zero");
  assert(
    absDiff(frax, expectedFrax) <= 1n,
    `FRAX should be close to ${expectedFrax}, got ${frax}`,
  );
  console.log(`[value-in-eth] PASS FRAX stable valuation: ${frax}`);

  const unknown = valueInEth(UNKNOWN_ADDR, ONE_ETH, 3500);
  assert(unknown === 0n, `unknown token should remain unvalued, got ${unknown}`);
  console.log("[value-in-eth] PASS unknown token remains zero");

  console.log("value-in-eth PASS (3/3)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

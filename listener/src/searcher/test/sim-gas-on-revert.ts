import { RevmLiveBackend } from "../live-backends/revm-live-backend.js";
import type {
  DaemonResponse,
  RevmSimClient,
  SimulatePreparedRequest,
} from "../revm-sim-client.js";
import type { ResolvedPlan } from "../solver/solver.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const OWNER = "0x1000000000000000000000000000000000000001";
const EXECUTOR = "0x00000000000000000000000000000000b07c0de5";

type SimResponse = Pick<
  DaemonResponse,
  "success" | "profit" | "gasUsed" | "revertReason" | "missingStateKeys"
>;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

class MockRevmSimClient {
  lastRequest: SimulatePreparedRequest | null = null;

  constructor(private readonly response: SimResponse) {}

  async simulatePrepared(req: SimulatePreparedRequest): Promise<DaemonResponse> {
    this.lastRequest = req;
    return {
      ok: true,
      latencyMs: 0,
      ...this.response,
    };
  }
}

function minimalPlan(): ResolvedPlan {
  return {
    root: {
      adapterId: "skip",
      target: ZERO,
      tokenIn: ZERO,
      tokenOut: ZERO,
      amount: 0n,
      params: {},
      children: [],
    },
    netProfit: 0n,
    profitToken: ZERO,
    flashAmount: 0n,
    templateName: "sim-gas-on-revert",
  };
}

function backendWith(response: SimResponse): RevmLiveBackend {
  const client = new MockRevmSimClient(response);
  const backend = new RevmLiveBackend(
    client as unknown as RevmSimClient,
    EXECUTOR,
    OWNER,
    {} as any,
    [],
    "mock://rpc",
  );
  (backend as unknown as { preparedBlock: number | null }).preparedBlock = 1;
  return backend;
}

async function testRevertReportsZeroGas(): Promise<void> {
  const backend = backendWith({
    success: false,
    gasUsed: "15527131",
    profit: "0",
    revertReason: "revert: 0x08c379a0",
  });
  const result = await backend.simulate(minimalPlan());
  assert(result.success === false, `revert: success=${result.success}`);
  assert(result.gasUsed === 0n, `revert: expected gasUsed 0n, got ${result.gasUsed}`);
  console.log("[sim-gas-on-revert] revert => gasUsed 0n: PASS");
}

async function testSuccessPassesThroughGas(): Promise<void> {
  const backend = backendWith({
    success: true,
    gasUsed: "407000",
    profit: "1000",
  });
  const result = await backend.simulate(minimalPlan());
  assert(result.success === true, `success: success=${result.success}`);
  assert(result.gasUsed === 407000n, `success: expected gasUsed 407000n, got ${result.gasUsed}`);
  console.log("[sim-gas-on-revert] success => gasUsed passthrough: PASS");
}

async function main(): Promise<void> {
  const tests = [
    testRevertReportsZeroGas,
    testSuccessPassesThroughGas,
  ];
  let passed = 0;
  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err) {
      console.error(`[sim-gas-on-revert] ${test.name}: FAIL`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
  console.log(`sim-gas-on-revert PASS (${passed}/${tests.length})`);
}

main().catch((err) => {
  console.error(`[sim-gas-on-revert] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

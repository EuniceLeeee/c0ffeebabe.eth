import {
  createBundleRouter,
  DryRunBundleRouter,
  productionEconomicsSafetyReject,
  standingPositionSafetyReject,
  type BundleSubmission,
} from "../execution/bundle-router.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function minimalBundle(safety?: BundleSubmission["safety"]): BundleSubmission {
  const bundle: BundleSubmission = {
    victimTxHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    backrunCalldata: "0x",
    targetBlock: 1,
    expectedProfit: 0n,
  };
  if (safety) bundle.safety = safety;
  return bundle;
}

function assertSafetyReject(result: ReturnType<typeof standingPositionSafetyReject>, label: string): void {
  assert(result !== null, `${label}: expected safety reject`);
  assert(result.builder === "safety-reject", `${label}: builder ${result.builder}`);
  assert(result.accepted === false, `${label}: accepted ${result.accepted}`);
  assert(result.error === "standing_position_unauthorized", `${label}: error ${result.error}`);
}

const tests: Array<{ name: string; run: () => void | Promise<void> }> = [];

function test(name: string, run: () => void | Promise<void>): void {
  tests.push({ name, run });
}

test("pure helper rejects unauthorized standing-position safety", () => {
  const reject = standingPositionSafetyReject(minimalBundle({
    leavesStandingPosition: true,
    authorized: false,
  }));
  assertSafetyReject(reject, "unauthorized standing-position");
});

test("pure helper allows absent, non-standing, and authorized safety", () => {
  assert(standingPositionSafetyReject(minimalBundle()) === null, "absent safety should not reject");
  assert(
    standingPositionSafetyReject(minimalBundle({
      leavesStandingPosition: false,
      authorized: false,
    })) === null,
    "non-standing safety should not reject",
  );
  assert(
    standingPositionSafetyReject(minimalBundle({
      leavesStandingPosition: true,
      authorized: true,
    })) === null,
    "authorized standing-position safety should not reject",
  );
});

test("production economics boundary requires pinned EV inputs", () => {
  const missing = minimalBundle();
  assert(
    productionEconomicsSafetyReject(missing)?.error === "missing_measured_gas",
    "missing measured gas must reject",
  );
  const withGas = { ...missing, gasUsed: 100n };
  assert(
    productionEconomicsSafetyReject(withGas)?.error === "missing_target_base_fee",
    "missing target base fee must reject",
  );
  const withFee = { ...withGas, maxBaseFeePerGas: 20n };
  assert(
    productionEconomicsSafetyReject(withFee)?.error === "missing_absolute_bribe_budget",
    "missing absolute bribe budget must reject",
  );
  const withBid = { ...withFee, bribeWei: 0n };
  assert(
    productionEconomicsSafetyReject(withBid)?.error === "missing_expected_profit_eth",
    "missing expected profit must reject",
  );
  assert(
    productionEconomicsSafetyReject({
      ...withBid,
      expectedProfitEth: 2_000n,
    })?.error === "non_positive_ev_budget",
    "zero retained EV must reject",
  );
  assert(
    productionEconomicsSafetyReject({
      ...withBid,
      expectedProfitEth: 2_001n,
    }) === null,
    "complete positive pinned economics must pass",
  );
});

test("dry-run router rejects unauthorized standing-position before recording", async () => {
  const router = new DryRunBundleRouter();
  const results = await router.submit(minimalBundle({
    leavesStandingPosition: true,
    authorized: false,
  }));
  assert(results.length === 1, `unauthorized dry-run: expected one result, got ${results.length}`);
  assertSafetyReject(results[0], "unauthorized dry-run");
  assert(router.submissions.length === 0, `unauthorized dry-run: recorded ${router.submissions.length}`);
});

test("dry-run router records normal bundles with unsigned diagnostics", async () => {
  for (const [label, safety] of [
    ["authorized", { leavesStandingPosition: true, authorized: true }],
    ["absent", undefined],
  ] as const) {
    const router = new DryRunBundleRouter();
    const results = await router.submit(minimalBundle(safety));
    assert(results.length === 1, `${label}: expected one diagnostic result, got ${results.length}`);
    assert(results[0].builder === "dry-run", `${label}: builder ${results[0].builder}`);
    assert(results[0].accepted === false, `${label}: dry-run must not report accepted`);
    assert(results[0].error === "dry-run-unsigned", `${label}: error ${results[0].error}`);
    assert(/^0x[0-9a-f]{64}$/.test(results[0].backrunTxHash ?? ""), `${label}: diagnostic ID`);
    assert(router.submissions.length === 1, `${label}: recorded ${router.submissions.length}`);
  }
});

test("production dry-run construction never signs or probes provider", async () => {
  let signCalls = 0;
  let providerCalls = 0;
  const wallet = {
    address: "0x0000000000000000000000000000000000000001",
    async signTransaction() {
      signCalls++;
      throw new Error("dry-run must not sign");
    },
  };
  const provider = new Proxy({}, {
    get() {
      providerCalls++;
      throw new Error("dry-run must not probe provider");
    },
  });
  const router = createBundleRouter({
    dryRun: true,
    wallet: wallet as never,
    provider: provider as never,
    botvmAddress: "0x0000000000000000000000000000000000000002",
    defaultGasUsed: 100_000,
  });
  const bundle = minimalBundle();
  const first = await router.submit(bundle);
  const second = await router.submit(bundle);
  assert(signCalls === 0, `dry-run sign calls ${signCalls}`);
  assert(providerCalls === 0, `dry-run provider calls ${providerCalls}`);
  assert(first[0].backrunTxHash === second[0].backrunTxHash, "diagnostic ID must be stable");
  assert(first[0].error === "dry-run-unsigned", `diagnostic error ${first[0].error}`);
});

let passed = 0;
for (const { name, run } of tests) {
  try {
    await run();
    passed++;
    console.log(`[bundle-router-safety] ${name}: PASS`);
  } catch (err) {
    console.error(`[bundle-router-safety] ${name}: FAIL`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

console.log(`bundle-router-safety PASS (${passed}/${tests.length})`);

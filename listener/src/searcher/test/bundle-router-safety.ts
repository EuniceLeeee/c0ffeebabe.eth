import {
  DryRunBundleRouter,
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

test("dry-run router records normal bundles in no-wallet path", async () => {
  for (const [label, safety] of [
    ["authorized", { leavesStandingPosition: true, authorized: true }],
    ["absent", undefined],
  ] as const) {
    const router = new DryRunBundleRouter();
    const results = await router.submit(minimalBundle(safety));
    assert(results.length === 0, `${label}: expected no-wallet [] result, got ${results.length}`);
    assert(router.submissions.length === 1, `${label}: recorded ${router.submissions.length}`);
  }
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

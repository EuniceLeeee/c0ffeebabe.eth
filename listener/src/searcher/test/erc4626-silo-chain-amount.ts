import assert from "node:assert/strict";
import test from "node:test";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import {
  captureErc4626SiloRedeemFixtureCase,
  erc4626SiloFixtureRuntime,
  ERC4626_SILO_FIXTURE_VAULT as VAULT,
  ERC4626_SILO_FIXTURE_PAYOUT as PAYOUT,
} from "../architecture-migration-fixture-replay.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../strict-family-lifecycle-runner.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { ERC4626_SILO_REDEEM_FAMILY_ID as FAMILY } from "../venues/protocols/erc4626-silo-redeem-family/manifest.js";
import {
  ERC4626_SILO_INTERFACE as VAULT_ABI,
  ERC4626_SILO_PAYOUT_INTERFACE as PAYOUT_ABI,
} from "../venues/protocols/erc4626-silo-redeem-family/shared.js";

// Offline integration through the production issueExact entry, not chain evidence.
const SOURCE: CanonicalSource = { number: 25_800_100, hash: `0x${"31".repeat(32)}`, generation: 3 };
const EXECUTOR = `0x${"41".repeat(20)}`;
const publication = await runStrictFamilyLifecycle({
  catalog, familyId: FAMILY, source: SOURCE, runtime: erc4626SiloFixtureRuntime(),
  observations: [{ kind: "call", source: SOURCE, target: VAULT,
    data: VAULT_ABI.encodeFunctionData("redeem", [PAYOUT, 1_000n, EXECUTOR, EXECUTOR]) }],
});
assert.equal(publication.instances.length, 1);
const family = catalog.forFamily(FAMILY);
const view = buildFamilyRouteGraphView({ routes: publication.instances.flatMap(instance =>
  instance.routes.map((route, index) => ({ family, descriptor: instance.descriptor,
    route, handle: instance.routeHandles[index]! }))) });
const root = new StrictProductionRuntimeRoot({ catalog, readySource: SOURCE,
  readyGraph: view.edges, readyInstances: publication.instances, readyFundingAssets: [] });

for (const amountIn of [1n, 137n, (1n << 100n) + 37n]) {
  for (const requireChainAmountQuote of [false, true]) {
    test(`issueExact ${amountIn}, chain=${requireChainAmountQuote}: two calls and no simulation`, async () => {
      const previewAssets = amountIn * 2n + 7n, amountOut = amountIn / 3n + 19n;
      const reads: string[] = [];
      const runtime = createStrictCentralAdapterRuntime({ executor: EXECUTOR,
        // Intentionally no transactionOrigin or simulation transport: queries need neither.
        generationFence: { assertCurrent(g, s) { assert.equal(g, SOURCE.generation); assert.deepEqual(s, SOURCE); } },
        provider: {
          getCode: async () => assert.fail("unexpected code read"),
          getStorage: async () => assert.fail("unexpected storage read"),
          call: async (request, block) => {
            assert.equal(block, SOURCE.number);
            if (request.to.toLowerCase() === VAULT) {
              reads.push("previewRedeem");
              assert.deepEqual([...VAULT_ABI.decodeFunctionData("previewRedeem", request.data)], [amountIn]);
              return VAULT_ABI.encodeFunctionResult("previewRedeem", [previewAssets]);
            }
            assert.equal(request.to.toLowerCase(), PAYOUT);
            reads.push("previewWithdraw");
            assert.deepEqual([...PAYOUT_ABI.decodeFunctionData("previewWithdraw", request.data)], [previewAssets]);
            return PAYOUT_ABI.encodeFunctionResult("previewWithdraw", [amountOut]);
          },
        },
      });
      const session = await root.createSession({ source: SOURCE, runtime, kind: "exact", fundingAssets: [] });
      assert.equal(reads.length, 0, "preparing an Exact session needs no current/raw repricing");
      const edge = session.edges[0]!;
      const exact = await session.issueExact({ edge, amountIn, executor: EXECUTOR,
        runtimeEvidence: [], requireChainAmountQuote });
      assert.equal(exact.amountOut, amountOut);
      assert.deepEqual(exact.source, SOURCE);
      assert.deepEqual(reads, ["previewRedeem", "previewWithdraw"]);
      const execution = session.buildExecution({ edge, exact, minAmountOut: amountOut, executor: EXECUTOR });
      assert.equal(execution.status, "resolved");
    });
  }
}

for (const failedLeg of ["previewRedeem", "previewWithdraw"] as const) {
  test(`issueExact fails closed if ${failedLeg} reverts; no local or simulated fallback`, async () => {
    let calls = 0;
    const runtime = createStrictCentralAdapterRuntime({ executor: EXECUTOR,
      generationFence: { assertCurrent() {} },
      provider: {
        getCode: async () => assert.fail("unexpected code read"),
        getStorage: async () => assert.fail("unexpected storage read"),
        call: async request => {
          calls++;
          const first = request.to.toLowerCase() === VAULT;
          if (first === (failedLeg === "previewRedeem")) {
            throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", data: "0x" });
          }
          return VAULT_ABI.encodeFunctionResult("previewRedeem", [99n]);
        },
      },
    });
    const session = await root.createSession({ source: SOURCE, runtime, kind: "exact", fundingAssets: [] });
    await assert.rejects(session.issueExact({ edge: session.edges[0]!, amountIn: 137n,
      executor: EXECUTOR, runtimeEvidence: [], requireChainAmountQuote: true }), /unresolved/);
    assert.equal(calls, failedLeg === "previewRedeem" ? 1 : 2);
  });
}

test("migration fixture still carries the two-preview output into normal execution", async () => {
  const capture = await captureErc4626SiloRedeemFixtureCase({ source: SOURCE });
  assert(capture.stages.exactQuotes);
  assert(capture.stages.executionFragments);
  assert.equal(capture.stages.exactQuotes.items.length, 1);
  assert.equal(capture.stages.executionFragments.items.length, 1);
  assert.equal((capture.stages.exactQuotes.items[0]!.value as { amountOut: string }).amountOut, "1000000");
});

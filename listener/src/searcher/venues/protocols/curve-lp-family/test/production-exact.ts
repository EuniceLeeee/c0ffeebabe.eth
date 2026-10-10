import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import { executeFamilyExactQuote } from "../../../adapter-family-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { ABI, DECIMALS } from "../codec.js";
import { FAMILY } from "../manifest.js";
import { mintQuote } from "../model.js";
import { source, actor, fixture, setup, behavior, reads, mockWithdraw } from "./fixtures.js";
import type { Route } from "../types.js";
test("production lifecycle and Exact execute code/storage guards for all four LP directions", async () => {
  assert.equal(process.env.SEARCHER_FAMILY_CURVE_LP_ENABLED, "1");
  const f = fixture(), d = setup(f).d;
  const provider = {
    async getCode(address: string) { const r = reads(f, [{ id: "code", kind: "get-code", address }])[0]; assert(r.ok); return r.data; },
    async getStorage(address: string, slot: string) { const r = reads(f, [{ id: "storage", kind: "get-storage", address, slot }])[0]; assert(r.ok); return r.data; },
    async call(tx: { to: string; data: string }) { const r = reads(f, [{ id: "call", kind: "eth-call", ...tx, completion: "return-data" }])[0]; assert(r.ok); return r.data; },
  };
  const runtime = createStrictCentralAdapterRuntime({ provider, executor: actor, transactionOrigin: ethers.toBeHex(72, 20),
    generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); } },
    simulator: { async simulate({ request }) {
      const r = behavior(f, { phase: "behavior", binding: d, state: { ...f, source } }, request); assert(r.ok); return { data: r.data, effects: r.effects };
    } } });
  const event = ABI.encodeEventLog(ABI.getEvent("AddLiquidity")!, [actor, [0n, 10n], [0n, 0n], 10n, 99n]);
  const publication = await runStrictFamilyLifecycle({ catalog, familyId: FAMILY, source, runtime,
    observations: [{ kind: "log", source, address: f.pool, ...event }] });
  assert.equal(publication.instances.length, 1); const instance = publication.instances[0], family = asPricedFamily(catalog.forFamily(FAMILY));
  assert.equal(instance.routes.length, 4);
  for (const [index, route] of (instance.routes as Route[]).entries()) for (const n of [1n, 37n]) {
    const amountIn = n * 10n ** BigInt(route.direction === "mint" ? DECIMALS[route.index] : 18);
    const q = await executeFamilyExactQuote({ family, route: instance.routeHandles[index], amountIn, source, generation: source.generation,
      executor: actor, runtimeEvidence: [], runtime });
    assert.equal(q.status, "resolved", JSON.stringify(q, (_k,v) => typeof v === "bigint" ? v.toString() : v));
    assert(q.status === "resolved"); assert.equal(q.amountOut, route.direction === "mint" ? mintQuote(f, route.index, amountIn) : mockWithdraw(amountIn, route.index));
  }
});

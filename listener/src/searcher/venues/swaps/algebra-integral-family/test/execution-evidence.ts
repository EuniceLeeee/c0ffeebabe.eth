// Execution admission only: synthetic evidence is not a Quoter/identity proof.
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { algebraIntegralExecution } from "../execution.js";
import { algebraIntegralRoutes } from "../routes.js";
import type { AlgebraIntegralDescriptor, AlgebraIntegralExactEvidence } from "../types.js";
import { descriptor, EXECUTOR, FOREIGN_POOL, SOURCE } from "./fixtures.js";

const ORIGIN = "0x0000000000000000000000000000000000000009";
const QUOTER = "0x0000000000000000000000000000000000000008";
const PLUGIN = "0x0000000000000000000000000000000000000007";
type ExecutionInput = Parameters<typeof algebraIntegralExecution.buildFragment>[0];

function inputFor(dynamic: boolean, direction = 0): ExecutionInput {
  const base = descriptor();
  const d: AlgebraIntegralDescriptor = dynamic ? { ...base, executedFee: {
    ...base.executedFee, kind: "cypher-bound-quoter", plugin: PLUGIN,
    quoterBinding: { quoter: QUOTER, quoterCodeHash: `0x${"11".repeat(32)}`,
      poolDeployer: FOREIGN_POOL, pluginCodeHash: `0x${"22".repeat(32)}`, pluginFactory: FOREIGN_POOL },
  } } : base;
  const route = algebraIntegralRoutes.project({ descriptor: d })[direction]!;
  const common = { source: SOURCE, pool: d.pool, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
    tickSpacing: d.tickSpacing, amountIn: 11n, amountOut: 22n, declinedReason: null };
  const evidence: AlgebraIntegralExactEvidence = dynamic ? {
    ...common, kind: "algebra-integral-bound-quoter", binding: route.bindingRef.fingerprint,
    routeKey: route.routeKey, executor: EXECUTOR, transactionOrigin: ORIGIN,
    quoter: QUOTER, plugin: PLUGIN, reportedLastFee: 999n,
  } : { ...common, kind: "algebra-integral-single-range", executedFee: d.executedFee.fee + 1n,
    pluginConfig: d.executedFee.pluginConfig ^ 4, feeProvenance: "algebra-static-last-fee",
    pluginFeeProvenance: "structurally-zero-without-dynamic-fee-flag", sqrtPriceX96Before: 1n << 96n,
    sqrtPriceX96After: 1n << 96n, rangeBoundTick: 0, rangeBoundSqrtPriceX96: 1n << 96n };
  return { descriptor: d, route, amountIn: 11n, quotedAmountOut: 22n, minAmountOut: 21n,
    exactEvidence: evidence, executor: EXECUTOR, transactionOrigin: ORIGIN, runtimeEvidence: [] };
}

test("both evidence kinds accept matching bindings in both directions without old Ready fee equality", () => {
  for (const dynamic of [false, true]) for (const direction of [0, 1]) {
    const input = inputFor(dynamic, direction);
    assert.doesNotThrow(() => algebraIntegralExecution.buildFragment(input));
  }
});

test("Quoter reportedLastFee is diagnostic only, never an executed fee", () => {
  const input = inputFor(true);
  assert.equal(input.exactEvidence.kind, "algebra-integral-bound-quoter");
  if (input.exactEvidence.kind !== "algebra-integral-bound-quoter") return;
  const first = algebraIntegralExecution.buildFragment(input);
  const changed = algebraIntegralExecution.buildFragment({ ...input,
    exactEvidence: { ...input.exactEvidence, reportedLastFee: 0n } });
  assert.deepEqual(first, changed);
});

test("Quoter evidence rejects each mismatched route/binding/caller/quoter/plugin field", () => {
  for (const direction of [0, 1]) {
    const input = inputFor(true, direction);
    for (const [field, value] of Object.entries({ binding: "wrong-binding", routeKey: "wrong-route",
      executor: FOREIGN_POOL, transactionOrigin: FOREIGN_POOL, quoter: FOREIGN_POOL, plugin: FOREIGN_POOL })) {
      assert.throws(() => algebraIntegralExecution.buildFragment({ ...input,
        exactEvidence: { ...input.exactEvidence, [field]: value } } as ExecutionInput),
      /incompatible exact evidence/, field);
    }
    assert.throws(() => algebraIntegralExecution.buildFragment({ ...input, transactionOrigin: undefined }),
      /incompatible exact evidence/, "missing immutable origin");
    assert.throws(() => algebraIntegralExecution.buildFragment({ ...input, executor: FOREIGN_POOL }),
      /incompatible exact evidence/, "changed execution caller");
    assert.throws(() => algebraIntegralExecution.buildFragment({ ...input, transactionOrigin: FOREIGN_POOL }),
      /incompatible exact evidence/, "changed execution origin");
  }
});

test("both evidence kinds retain pool/token/amount/tick and nondeclined positive-output guards", () => {
  for (const dynamic of [false, true]) {
    const input = inputFor(dynamic);
    for (const [field, value] of Object.entries({ pool: FOREIGN_POOL, tokenIn: FOREIGN_POOL,
      tokenOut: FOREIGN_POOL, tickSpacing: 123456, amountIn: 10n, amountOut: 21n,
      declinedReason: "not executable", kind: "unknown-evidence" })) {
      assert.throws(() => algebraIntegralExecution.buildFragment({ ...input,
        exactEvidence: { ...input.exactEvidence, [field]: value } } as ExecutionInput),
      /incompatible exact evidence/, field);
    }
    for (const change of [{ amountIn: 0n }, { amountIn: 1n << 255n }, { minAmountOut: -1n },
      { minAmountOut: 23n }, { minAmountOut: ethers.MaxUint256 + 1n },
      { quotedAmountOut: 0n, minAmountOut: 0n, exactEvidence: { ...input.exactEvidence, amountOut: 0n } }]) {
      assert.throws(() => algebraIntegralExecution.buildFragment({ ...input, ...change }),
        /incompatible exact evidence/);
    }
  }
});

test("static and Quoter evidence cannot substitute for the other admitted fee model", () => {
  for (const dynamic of [false, true]) {
    const input = inputFor(dynamic);
    assert.throws(() => algebraIntegralExecution.buildFragment({ ...input,
      exactEvidence: inputFor(!dynamic).exactEvidence }), /incompatible exact evidence/);
  }
});

test("runtime for either model remains quote-free and retains route authority", () => {
  for (const dynamic of [false, true]) {
    const quoted = inputFor(dynamic);
    const input = { descriptor: quoted.descriptor, route: quoted.route,
      executor: EXECUTOR, transactionOrigin: ORIGIN, runtimeEvidence: [] };
    for (const key of ["amountIn", "quotedAmountOut", "minAmountOut", "exactEvidence"])
      Object.defineProperty(input, key, { get() { throw new Error(`runtime accessed ${key}`); } });
    assert.doesNotThrow(() => algebraIntegralExecution.buildRuntimeLeg(input));
    assert.throws(() => algebraIntegralExecution.buildRuntimeLeg({ ...input,
      route: { ...input.route, bindingRef: { ...input.route.bindingRef, fingerprint: "forged" } } }),
      /route binding mismatch/);
  }
});

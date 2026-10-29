import assert from "node:assert/strict";
import test from "node:test";
import { toBeHex } from "ethers";
import { createDeclarativeProtocolRuntime } from "../venues/declarative-protocol.js";
import { createDeclarativeMathRegistry } from "../venues/declarative-math.js";
import root from "../venues/protocols/erc4626-family/erc4626.json";
import custodian from "../venues/protocols/erc4626-family/custodian.json";
import infinifi from "../venues/protocols/erc4626-family/infinifi.json";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const op = (op: string, ...args: any[]) => ({ op, args });
function fixture(document: any) {
  const runtime = createDeclarativeProtocolRuntime(document, [clone(custodian), clone(infinifi)]);
  const descriptor: any = { familyId: root.scope.family, lineageId: runtime.variants[0]!.document.lineageId,
    instanceKey: toBeHex(1, 20), vault: toBeHex(1, 20), asset: toBeHex(2, 20), share: toBeHex(1, 20),
    verifiedDirections: { deposit: true, redeem: true }, runtimeRequirements: [] };
  return { runtime, descriptor, routes: runtime.definition.routes.project({ descriptor }) };
}

test("indexed and fallback invalidations preserve opaque state-key case and distinct groups", () => {
  const document: any = clone(root);
  document.pricing.stateKey = op("if", op("eq", "$route.direction", "deposit"), "Mixed:State", "mixed:state");
  const { runtime, descriptor, routes } = fixture(document), pricing = runtime.definition.pricing;
  const entries = routes.map(route => ({ descriptor, routes: [route], stateKey: pricing.stateKey(route), dependencies: [descriptor.vault] }));
  const compiled = pricing.mutation!.compile!({ entries });
  const observation: any = { kind: "log", address: descriptor.vault };
  const indexed = compiled.affectedStateKeys({ observation });
  const fallback = pricing.mutation!.affectedStateKeys({ descriptor, routes, observation });
  assert.deepEqual(indexed, ["Mixed:State", "mixed:state"]);
  assert.deepEqual(indexed, fallback);
  assert.deepEqual(compiled.affectedStateKeys({ observation: { kind: "log", address: toBeHex(3, 20) } as any }), []);
});

test("trial-state transitions cannot register unsupported retained source-read execution proofs", () => {
  const document: any = clone(root);
  document.standard.exact.retainReadEvidence = true;
  const ref = { key: "fixture:reserve", schema: "fixture:v1", binding: "$route.bindingRef.fingerprint", dependencies: [] };
  document.standard.modules = {
    math: { version: 1, entries: { transition: { model: "fixture:state", version: 1 } } },
    quoteFlow: { version: 1, sourceKind: "local-math", steps: [{ id: "reserve", requirements: { transports: ["eth-call"] },
      requests: [{ id: "state", kind: "eth-call", to: "$target", data: "0x12345678", completion: "return-data" }],
      result: { reserve: op("word", op("get", op("returned", "state"), "data")) } }], result: "$steps.reserve" },
    trialState: { version: 1, reads: [{ id: "reserve", refs: [ref], initial: ["$prepared"] }], model: "transition",
      input: { reserve: "$stateReads.reserve.0.reserve", amount: "$amountIn" }, amountOut: "$modelResult.amountOut",
      stateChanges: [{ ref: "$stateRefs.reserve.0", value: "$modelResult.state" }], stateEffects: [] },
  };
  const math = createDeclarativeMathRegistry([{ id: "fixture:state", version: 1, validateInput() {},
    evaluate(value: any) { return { amountOut: value.amount, state: { reserve: (value.reserve as bigint) - (value.amount as bigint) } }; },
    validateOutput() {} }]);
  assert.throws(() => createDeclarativeProtocolRuntime(document, [clone(custodian), clone(infinifi)], { math }), /retained|retain|trial/i);
  delete document.standard.exact.retainReadEvidence;
  assert.doesNotThrow(() => createDeclarativeProtocolRuntime(document, [clone(custodian), clone(infinifi)], { math }));
});

test("route caching requires deeply frozen descriptors and cannot retain a revoked mutable direction", () => {
  const mutable = fixture(clone(root));
  Object.freeze(mutable.descriptor);
  const previous = mutable.runtime.definition.routes.project({ descriptor: mutable.descriptor });
  mutable.descriptor.verifiedDirections.deposit = false;
  const updated = mutable.runtime.definition.routes.project({ descriptor: mutable.descriptor });
  assert.equal(previous.length, 2);
  assert.equal(updated.length, 1);
  assert.throws(() => mutable.runtime.assertInvocation(mutable.descriptor, previous[0]!));

  const immutable = fixture(clone(root));
  Object.freeze(immutable.descriptor.verifiedDirections);
  Object.freeze(immutable.descriptor.runtimeRequirements);
  Object.freeze(immutable.descriptor);
  const first = immutable.runtime.definition.routes.project({ descriptor: immutable.descriptor });
  const second = immutable.runtime.definition.routes.project({ descriptor: immutable.descriptor });
  assert.equal(first, second, "deeply immutable descriptor reuses its compiled route projection");
  for (const route of first) immutable.runtime.assertInvocation(immutable.descriptor, route);
});

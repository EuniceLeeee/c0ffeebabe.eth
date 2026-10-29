import assert from "node:assert/strict";
import test from "node:test";
import { toBeHex } from "ethers";
import { compileDeclarativeReadFlow } from "../venues/declarative-read-flow.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { createDeclarativeMathRegistry } from "../venues/declarative-math.js";
import { applyExactTrialState, emptyExactTrialState } from "../exact-trial-state.js";
import type { AdapterRequestResult } from "../venues/adapter-request-program.js";

test("source-read flow retains Map math output without weakening source or required-result checks", () => {
  const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
  let evaluated = 0;
  const models = createDeclarativeMathRegistry([{ id: "fixture:state", version: 1, validateInput(value) { assert.equal(typeof value, "bigint"); },
    evaluate(value) { evaluated++; return { balances: new Map([["asset", value]]), metadata: { decimals: 18, discount: null } }; },
    validateOutput(value: any) { assert(value.balances instanceof Map); } }])
    .bind({ version: 1, entries: { state: { model: "fixture:state", version: 1 } } });
  const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} }, {}, models);
  const flow = compileDeclarativeReadFlow({ version: 1, steps: [{ id: "state", requirements: { transports: ["eth-call"] },
    requests: [{ id: "read", kind: "eth-call", to: toBeHex(1, 20), data: "0x12345678", completion: "return-data" }],
    result: { op: "model", args: ["state", { op: "word", args: [{ op: "get", args: [{ op: "returned", args: ["read"] }, "data"] }] }] } }],
    result: "$steps.state" }, values);
  const observed: AdapterRequestResult = { id: "read", ok: true, source, completion: "returned", data: toBeHex(100, 32),
    provenance: { kind: "fixture", fingerprint: "fixture" } };
  const decode = (row: AdapterRequestResult) => flow.program.decode({ programInput: { source }, initialResults: [row], dependentEvidence: [] }) as any;
  const output = decode(observed);
  assert(output.balances instanceof Map);
  assert.equal(output.balances.get("asset"), 100n);
  assert.throws(() => output.balances.clear(), /immutable/);
  const ref = { key: "fixture:state", schema: "fixture:v1", binding: "bound" };
  const committed = applyExactTrialState(emptyExactTrialState(), [{ ref, value: output }]);
  assert.equal((committed.view.get(ref) as any).balances.get("asset"), 100n);
  const beforeFailure = evaluated;
  assert.throws(() => decode({ ...observed, source: { ...source, number: 101 } }), /source/);
  assert.throws(() => decode({ id: "read", ok: false, source, failure: "rpc" }));
  assert.equal(evaluated, beforeFailure, "unproven source reads cannot run the state math");
});

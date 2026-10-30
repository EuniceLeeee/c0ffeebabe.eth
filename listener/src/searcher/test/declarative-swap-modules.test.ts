import assert from "node:assert/strict";
import test from "node:test";
import { Interface, toBeHex } from "ethers";
import { compileDeclarativeEventCodec } from "../venues/declarative-event-codec.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { compileInstanceEvidence, executionProjection } from "../venues/declarative-instance-evidence.js";
import { projectDeclarativePrices } from "../venues/declarative-pricing-projection.js";
import { familyModuleCatalog } from "../venues/declarative-family-modules.js";
const target = toBeHex(1, 20), token = toBeHex(2, 20), poolId = toBeHex(3, 32);
const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
const source = { number: 123, hash: toBeHex(123, 32), generation: 1 };

test("new Family modules remain uniform and empty without admitting capabilities", () => {
  const modules = familyModuleCatalog().read({});
  for (const key of ["pricingProjection", "instanceEvidence", "executionProjection", "liveStateProjection"]) {
    assert.deepEqual(modules.blocks[key], {});
    assert.equal(modules.coverage.find(row => row.key === key)?.state, "undefined");
  }
});
test("canonical event codec rejects trailing bytes/topics and wrong event topics", () => {
  const signature = "event Swap(address indexed who,uint256 amount)", abi = new Interface([signature]);
  const codec = compileDeclarativeEventCodec({ signature });
  const event = abi.encodeEventLog(abi.getEvent("Swap")!, [target, 12n]);
  assert.equal(codec.decode({ address: target, ...event }).amount, 12n);
  assert.throws(() => codec.decode({ address: target, ...event, data: event.data + "00" }));
  assert.throws(() => codec.decode({ address: target, ...event, topics: [...event.topics, toBeHex(0, 32)] }));
  assert.equal(codec.matches({ address: target, ...event, topics: [toBeHex(0, 32)] }), false);
});
const packed = { address: target, dataLengthBytes: 116, identityOffsetBytes: 20, fields: [
  { name: "locker", offsetBytes: 0, lengthBytes: 20, encoding: "address" },
  { name: "poolId", offsetBytes: 20, lengthBytes: 32, encoding: "bytes" },
  { name: "delta0", offsetBytes: 52, lengthBytes: 16, encoding: "int" },
  { name: "delta1", offsetBytes: 68, lengthBytes: 16, encoding: "int" },
  { name: "stateAfter", offsetBytes: 84, lengthBytes: 32, encoding: "bytes" },
] };
test("bounded packed anonymous codec preserves signed token order and singleton identity", () => {
  const codec = compileDeclarativeEventCodec({ packed });
  const data = target + poolId.slice(2) + toBeHex(11n, 16).slice(2) + toBeHex((1n << 128n) - 7n, 16).slice(2) + toBeHex(0, 32).slice(2);
  const log = { address: target, topics: [], data };
  assert.deepEqual(codec.decode(log), { locker: target, poolId, delta0: 11n, delta1: -7n, stateAfter: toBeHex(0, 32) });
  assert(codec.matches(log));
  for (const changed of [{ ...log, address: token }, { ...log, topics: [poolId] }, { ...log, data: data + "00" }]) {
    assert.equal(codec.matches(changed), false); assert.throws(() => codec.decode(changed));
  }
  assert.throws(() => compileDeclarativeEventCodec({ packed: { ...packed, fields: packed.fields.slice(1) } }), /every byte/);
  assert.throws(() => compileDeclarativeEventCodec({ packed: { ...packed, fields: [...packed.fields, packed.fields[0]] } }), /invalid|overlapping/);
});
test("instance static evidence requires exact observed result coverage and same source", () => {
  const block = { version: 1, reuse: { kind: "source-local" }, requirements: { transports: ["get-code"] },
    requests: [{ id: "code", kind: "get-code", address: "$draft.target" }],
    decode: [{ return: { op: "code", args: ["code"] } }], checks: [], finalize: "$draft" };
  const program = compileInstanceEvidence(block, values), draft = { target };
  assert.deepEqual(program.buildRequests(draft), [{ id: "code", kind: "get-code", address: target }]);
  const result: any = { id: "code", ok: true, source, completion: "returned", data: "0x6000", provenance: { transport: "get-code" } };
  assert.equal(program.decode({ programInput: draft, results: [result] }), "0x6000");
  for (const results of [[], [result, result], [{ ...result, id: "foreign" }], [{ ...result, source: { ...source, hash: "bad" } }],
    [{ id: "code", ok: false, source, failure: "rpc" }]]) assert.throws(() => program.decode({ programInput: draft, results: results as any }));
});
test("execution projection declares metadata only and rejects invalid calls", () => {
  const value = executionProjection({ allowanceSpender: target, prewarmQuoteCalls: [] });
  assert.equal(value.allowanceSpender?.toLowerCase(), target); assert.deepEqual(value.prewarmQuoteCalls, []);
  assert.throws(() => executionProjection({ allowanceSpender: target, prewarmQuoteCalls: [], runtime: true }));
  assert.throws(() => executionProjection({ allowanceSpender: null, prewarmQuoteCalls: [{ from: target, to: "", calldata: "0x", gasLimit: 0 }] }));
});
test("raw-state mids bind complete route coverage and never supply an amount quote", () => {
  const route: any = { routeKey: "r", instanceKey: target, adapterId: "x", target, tokenIn: target, tokenOut: token, taxonomy: { slotKind: "swap" } };
  const row = { routeKey: "r", numerator: 9n, denominator: 4n, depth: 100n };
  const project = (rows: unknown, unavailable = new Map()) => projectDeclarativePrices({ domain: "swap", routes: [route], rows, unavailable });
  const mid: any = project([row]).get("r" as any);
  assert.equal(mid.mid, 2.25); assert.equal(mid.edges[0].tokenOut, token); assert.equal(mid.kind, "external-swap");
  for (const rows of [[], [row, row], [{ ...row, routeKey: "other" }], [{ ...row, denominator: 0n }], [{ ...row, numerator: 9 }]]) assert.throws(() => project(rows));
  assert.equal(project([], new Map([["r", "empty balances"]])).size, 0);
  assert.throws(() => project([row], new Map([["r", "empty balances"]])));
});

import { createDeclarativeProtocolRuntime } from "../venues/declarative-protocol.js";
import erc4626 from "../venues/protocols/erc4626-family/erc4626.json";
const standard = () => ({ ...JSON.parse(JSON.stringify(erc4626)), variantFiles: [] });
test("declared instance evidence missing its math dependency never becomes absent proof", () => {
  const definition = standard();
  definition.modules = { instanceEvidence: { version: 1, reuse: { kind: "source-local" },
    requirements: { transports: ["get-code"] }, requests: [], decode: [], checks: [],
    finalize: { op: "model", args: ["missing", "$draft"] } } };
  assert.throws(() => createDeclarativeProtocolRuntime(definition), /instanceEvidence.*blocked|module.*instanceEvidence/);
});
test("declared raw-state pricing missing dependencies never falls back to quote sampling", () => {
  const definition = standard();
  definition.modules = { pricingProjection: { version: 1, checks: [], rows: { op: "model", args: ["missing", "$snapshot"] } } };
  const runtime = createDeclarativeProtocolRuntime(definition);
  assert.equal(runtime.moduleCoverage[0].modules.find((row: any) => row.key === "pricingProjection")?.state, "blocked");
  const pricing = runtime.definition.pricing;
  for (const operation of [() => pricing.current.requirements({ descriptor: {} } as any),
    () => pricing.current.buildRequests({ descriptor: {} } as any),
    () => pricing.current.deriveMids({ descriptor: {}, snapshot: {}, routes: [] } as any)]) assert.throws(operation, /pricingProjection/);
});

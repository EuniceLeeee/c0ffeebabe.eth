import assert from "node:assert/strict";
import test from "node:test";
import { FunctionFragment, Interface, toBeHex } from "ethers";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { assertReadySelectorEdgeObservation, readySelectorEdgesFromCensus, readySelectorEdgeFingerprint, readySelectorEdgeKey } from "../ready-selector-edges.js";
import { normalizeSelectorNativeExecutionDefinition, selectorNativeFamilyId } from "../venues/selector-native-definition.js";
import { selectorNativeCandidateFromCensus } from "../venues/selector-native-discovery.js";

const a = (value: number) => toBeHex(value, 20), h = (value: number) => toBeHex(value, 32);
const signature = "function trade(string pool,address input,uint256 inputId,address output,uint256 outputId,uint256 amount,address receiver) returns(uint256)";
const fn = FunctionFragment.from(signature), abi = new Interface([fn]);
const parameters = ["poolId", "tokenIn", "tokenInId", "tokenOut", "tokenOutId", "amountIn", "recipient"].map((role, index) => ({ path: [index], role }));
const raw = { selector: fn.selector, signature, parameters, payment: { kind: "none" }, domain: "protocol" };
const definition = normalizeSelectorNativeExecutionDefinition(raw), familyId = selectorNativeFamilyId(definition);

function source(options: { pool?: string; input?: string; output?: string; id?: bigint; amount?: bigint; receiver?: string; block?: number; selector?: string; status?: number } = {}) {
  const block = options.block ?? 100;
  let input = abi.encodeFunctionData(fn, [options.pool ?? "PoolA", options.input ?? a(3), options.id ?? 2n ** 200n,
    options.output ?? a(4), 9n, options.amount ?? 10n, options.receiver ?? a(1)]);
  if (options.selector) input = options.selector + input.slice(10);
  return readySelectorCensusFromTransaction({ chainId: 1, transactionHash: h(block), blockHash: h(block + 1), blockNumber: block,
    status: options.status ?? 1, from: a(1), to: a(2), input, logs: [] });
}
function projected(options: Parameters<typeof source>[0] = {}) {
  const census = source(options), candidate = selectorNativeCandidateFromCensus(definition, census, "transaction");
  assert(candidate);
  const rows = readySelectorEdgesFromCensus(census, [{ familyId, signature, candidate }]);
  assert.equal(rows.length, 1); assertReadySelectorEdgeObservation(rows[0]);
  return rows[0]!;
}

test("pre-admission edge keys retain direction, pool namespace, typed ids and immutable resources", () => {
  const first = projected();
  assert.equal(first.status, "unverified"); assert.equal(first.completeness, "complete");
  assert.equal(first.scope.tokenInId, String(2n ** 200n)); assert.equal(first.scope.poolId, "PoolA");
  const mutable = projected({ amount: 990n, receiver: a(9), block: 101 });
  assert.equal(readySelectorEdgeKey(first), readySelectorEdgeKey(mutable));
  assert.notEqual(readySelectorEdgeFingerprint(first), readySelectorEdgeFingerprint(mutable));
  for (const change of [{ pool: "poola" }, { pool: "PoolB" }, { id: 2n ** 200n + 1n }, { input: a(4), output: a(3) }])
    assert.notEqual(readySelectorEdgeKey(first), readySelectorEdgeKey(projected(change)));
  assert.notEqual(readySelectorEdgeKey(first), readySelectorEdgeKey({ ...first, scope: { ...first.scope, poolNamespace: "another-manager-domain" } }));
});

test("every execution program and unrecognized source call remains visible before admission", () => {
  const def = normalizeSelectorNativeExecutionDefinition({ selector: fn.selector, signature, domain: "protocol",
    programs: [{ parameters, payment: { kind: "none" } }, { parameters, payment: { kind: "approval" } }] });
  const census = source();
  // The program keys come from each declared pattern, not from an admitted subset.
  const { programs } = def;
  const nominations = programs.map(program => {
    const single = normalizeSelectorNativeExecutionDefinition({ ...def, programs: [program] });
    return { familyId, signature, candidate: selectorNativeCandidateFromCensus(single, census, "transaction")! };
  });
  const rows = readySelectorEdgesFromCensus(census, nominations);
  assert.equal(new Set(rows.map(readySelectorEdgeKey)).size, 2);
  const unknown = readySelectorEdgesFromCensus(source({ selector: "0xdeadbeef" }));
  assert.equal(unknown.length, 1); assert.equal(unknown[0]!.selector, "0xdeadbeef");
  assert.equal(unknown[0]!.signature, null); assert.equal(unknown[0]!.completeness, "incomplete");
  assert(unknown[0]!.issues.includes("abi-unavailable")); assert.equal(unknown[0]!.calldata?.slice(0, 10), "0xdeadbeef");
  assert.notEqual(readySelectorEdgeKey(unknown[0]!), readySelectorEdgeKey(readySelectorEdgesFromCensus(source({ selector: "0xdeadbeef", amount: 11n }))[0]!));
  const reverted = readySelectorEdgesFromCensus(source({ status: 0 }));
  assert.equal(reverted.length, 1); assert(reverted[0]!.issues.includes("source-call-not-successful"));
  assert.throws(() => assertReadySelectorEdgeObservation({ ...rows[0], status: "verified" }), /authority/);
});

test("an observed-only ABI cannot erase unresolved parameters even when both token flows are known", () => {
  const signature = "function convert(uint256 mode,uint256 amount) returns(uint256)", call = new Interface([signature]);
  const def = normalizeSelectorNativeExecutionDefinition({ selector: call.getFunction("convert")!.selector, signature,
    domain: "protocol", programs: [], unsupportedReason: "Parameter execution roles are not adapted" });
  const transfer = new Interface(["event Transfer(address indexed from,address indexed to,uint256 amount)"]);
  const edgeFor = (mode: bigint) => {
    const logs = [[a(3), a(1), a(2)], [a(4), a(2), a(1)]].map(([token, from, to], index) => ({
      address: token!, logIndex: index, ...transfer.encodeEventLog("Transfer", [from, to, 10n]),
    }));
    const census = readySelectorCensusFromTransaction({ chainId: 1, transactionHash: h(100 + Number(mode)), blockHash: h(200),
      blockNumber: 100, status: 1, from: a(1), to: a(2), input: call.encodeFunctionData("convert", [mode, 10n]), logs });
    const candidate = selectorNativeCandidateFromCensus(def, census, "transaction"); assert(candidate);
    const edge = readySelectorEdgesFromCensus(census, [{ familyId: selectorNativeFamilyId(def), signature, candidate }])[0]!;
    assertReadySelectorEdgeObservation(edge);
    assert.equal(edge.scope.tokenIn, a(3)); assert.equal(edge.scope.tokenOut, a(4));
    assert.equal(edge.programKey, "observed"); assert.equal(edge.completeness, "incomplete");
    assert(edge.issues.includes("execution-program-unbound"));
    assert.throws(() => assertReadySelectorEdgeObservation({ ...edge, completeness: "complete", issues: [] }), /binding/);
    return edge;
  };
  assert.notEqual(readySelectorEdgeKey(edgeFor(1n)), readySelectorEdgeKey(edgeFor(2n)));
});

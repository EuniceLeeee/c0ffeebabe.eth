import assert from "node:assert/strict";
import test from "node:test";
import { Interface, MaxUint256, keccak256, toBeHex } from "ethers";
import { compileDeclarativeOracleVictim, validateDeclarativeOracleVictim } from "../venues/declarative-oracle-victim.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { hashCanonical } from "../venues/canonical-value.js";
import { readProtocolModules } from "../venues/declarative-protocol-modules.js";
import { metronomeSynthOracleVictim } from "../venues/protocols/metronome-synth-family/victim.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { matchOracleVictimEffect, type StrictOracleVictimDescriptor } from "../detector/victim-effect.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";

const op = (op: string, ...args: any[]) => ({ op, args });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const source = { number: 1, hash: toBeHex(1, 32), generation: 0 };
const forwarder = toBeHex(101, 20), oracle = toBeHex(102, 20), pool = toBeHex(103, 20);
const payload = "0x12345678aabb", selector = payload.slice(0, 10);
const abi = new Interface(["function forward(address oracle, bytes payload)"]);

function fixture() {
  const definition: any = {
    version: 1,
    callPatterns: [{
      id: "fixture-forward", signature: "forward(address,bytes)", candidateAddress: { from: "call-target" },
      argumentProjection: [{ index: 0, type: "address", name: "oracle" }, { index: 1, type: "bytes", name: "payload" }],
      targets: [forwarder],
      when: op("and", op("sameAddress", "$args.0", "$constants.oracle"),
        op("eq", op("bytes", "$args.1", 0, 4), "$constants.selector")),
      result: {
        forwarder: op("lower", "$observation.target"), oracle: op("lower", "$args.0"),
        selector: op("bytes", "$args.1", 0, 4), payloadHash: op("codeHash", "$args.1"),
        oracleBinding: op("hash", { forwarder: op("lower", "$observation.target"),
          oracle: op("lower", "$args.0"), selector: op("bytes", "$args.1", 0, 4) }),
      },
    }],
    resultChecks: [
      op("sameAddress", "$result.forwarder", "$observation.target"),
      op("sameAddress", "$result.oracle", "$args.0"),
      op("eq", "$result.selector", op("bytes", "$args.1", 0, 4)),
      op("eq", "$result.payloadHash", op("codeHash", "$args.1")),
      op("matches", "$result.oracleBinding", "^[0-9a-f]{64}$"),
    ],
    canonicalIntakeTargets: [forwarder],
    runtimeDetection: {
      id: "fixture-oracle", affectedEdges: [{ adapterId: "fixture-swap", target: pool }],
      priceProbe: { signature: "quote(address,address,uint256) view returns (uint256,uint256)",
        functionName: "quote", amountIn: "1000000000000000000", outputIndex: 0 }, maxSearchHops: 8,
    },
  };
  const valuesDocument = { abi: {}, constants: { oracle, selector }, expressions: {} };
  const values = compileDeclarativeValues(valuesDocument);
  const observation = { kind: "call" as const, source, target: forwarder, data: abi.encodeFunctionData("forward", [oracle, payload]) };
  return { definition, valuesDocument, values, observation };
}

test("optional oracle-victim definitions leave old documents unsupported and reject partial declarations", () => {
  for (const root of [{}, { oracleVictim: {} }]) {
    const modules = readProtocolModules(root);
    assert.equal(modules.get("oracleVictim"), undefined);
    assert.equal(modules.coverage.find(row => row.key === "oracleVictim")?.state, "undefined");
  }
  assert.throws(() => readProtocolModules({ oracleVictim: { version: 1 } }), /missing|invalid/);
  assert.throws(() => readProtocolModules({}, { oracleVictim: {} }), /root|variant/);
});

test("ABI metadata and declaration results reach the existing synchronous oracle-victim interface", () => {
  const f = fixture(), victim = compileDeclarativeOracleVictim(f.definition, f.values);
  assert.deepEqual(victim.callPatterns, [{ id: "fixture-forward", signature: "forward(address,bytes)",
    selector: abi.getFunction("forward")!.selector, candidateAddress: { from: "call-target" },
    argumentProjection: f.definition.callPatterns[0].argumentProjection }]);
  assert.equal(victim.runtimeDetection.priceProbe.amountIn, 10n ** 18n);
  assert.deepEqual(victim.canonicalIntakeTargets, [forwarder]);
  const result = victim.decode({ observation: f.observation });
  assert.deepEqual(result, { forwarder, oracle, selector, payloadHash: keccak256(payload),
    oracleBinding: hashCanonical({ forwarder, oracle, selector }) });
  assert.ok(!(result instanceof Promise));
  assert.ok(Object.isFrozen(result));
  assert.equal(Object.isFrozen(f.observation), false);
  assert.equal(Object.isFrozen(f.observation.source), false);
});

test("target, selector and malformed calldata reject before expression evaluation", () => {
  const f = fixture(); let evaluations = 0, calldataReads = 0;
  const victim = compileDeclarativeOracleVictim(f.definition, { evaluate(value, env) { evaluations++; return f.values.evaluate(value, env); } });
  const unrelated: any = { ...f.observation, target: pool, get data() { calldataReads++; throw new Error("must not read unrelated calldata"); } };
  assert.equal(victim.decode({ observation: unrelated }), null);
  assert.equal(calldataReads, 0);
  for (const observation of [
    { ...f.observation, kind: "log" },
    { ...f.observation, data: "0x12345678" },
    { ...f.observation, data: abi.getFunction("forward")!.selector },
    { ...f.observation, selector: "0x12345678" },
  ]) assert.equal(victim.decode({ observation: observation as any }), null);
  assert.equal(evaluations, 0);
  assert.notEqual(victim.decode({ observation: { ...f.observation, selector: abi.getFunction("forward")!.selector.toUpperCase() } as any }), null);
});

test("false predicates are normal misses while configuration and result errors are explicit", () => {
  const f = fixture(), victim = compileDeclarativeOracleVictim(f.definition, f.values);
  for (const args of [[pool, payload], [oracle, "0x12345679aabb"], [oracle, "0x"]])
    assert.equal(victim.decode({ observation: { ...f.observation, data: abi.encodeFunctionData("forward", args) } }), null);
  for (const when of [1, "true", {}, "$unbound"]) {
    const definition = clone(f.definition); definition.callPatterns[0].when = when;
    assert.throws(() => compileDeclarativeOracleVictim(definition, f.values).decode({ observation: f.observation }), /boolean|unbound/);
  }
  for (const result of [null, false, [], {}, "a binding", { oracle: "$missing.field" }]) {
    const definition = clone(f.definition); definition.callPatterns[0].result = result;
    assert.throws(() => compileDeclarativeOracleVictim(definition, f.values).decode({ observation: f.observation }), /record|unbound/);
  }
  for (const bad of [false, 1, "true"]) {
    const definition = clone(f.definition); definition.resultChecks = [bad];
    assert.throws(() => compileDeclarativeOracleVictim(definition, f.values).decode({ observation: f.observation }), /result check/);
  }
  const wrongBinding = clone(f.definition); wrongBinding.callPatterns[0].result.oracleBinding = "";
  assert.throws(() => compileDeclarativeOracleVictim(wrongBinding, f.values).decode({ observation: f.observation }), /result check/);
  const wrongTarget = clone(f.definition); wrongTarget.callPatterns[0].result.forwarder = pool;
  assert.throws(() => compileDeclarativeOracleVictim(wrongTarget, f.values).decode({ observation: f.observation }), /result check/);
});

test("result schemas are declared by the family and returned objects cannot mutate caller input", () => {
  const f = fixture();
  f.definition.callPatterns[0].result = { evidence: "$observation.source", input: "$args.1" };
  f.definition.resultChecks = [op("eq", "$result.evidence.hash", "$observation.source.hash"), op("eq", "$result.input", "$args.1")];
  const victim = compileDeclarativeOracleVictim(f.definition, f.values), observation = { ...f.observation, source: { ...source } };
  const first: any = victim.decode({ observation });
  assert.notEqual(first.evidence, observation.source);
  assert.throws(() => { first.evidence.number = 2; }, /read only|Cannot assign/);
  observation.source.number = 3;
  assert.equal(first.evidence.number, 1);
  assert.equal((victim.decode({ observation }) as any).evidence.number, 3);
  f.definition.callPatterns[0].targets[0] = pool;
  f.definition.callPatterns[0].result = false;
  assert.equal((victim.decode({ observation }) as any).evidence.number, 3, "compiled definition owns its snapshot");
});

test("invalid or ambiguous definitions fail registration instead of disabling silently", () => {
  const changes: ((d: any) => void)[] = [
    d => { d.version = 2; }, d => { d.callPatterns = []; }, d => { d.resultChecks = []; },
    d => { d.callPatterns[0].targets = []; }, d => { d.callPatterns[0].targets = ["bad"]; },
    d => { d.callPatterns[0].targets.push(forwarder); },
    d => { d.callPatterns.push({ ...d.callPatterns[0], id: "another-id", when: false }); },
    d => { d.callPatterns[0].candidateAddress = { from: "argument", index: 1 }; },
    d => { d.callPatterns[0].argumentProjection[0].type = "bytes"; },
    d => { d.runtimeDetection.id = ""; }, d => { d.runtimeDetection.maxSearchHops = 0; },
    d => { d.runtimeDetection.priceProbe.functionName = "wrong"; }, d => { d.runtimeDetection.priceProbe.outputIndex = 2; },
    d => { d.runtimeDetection.priceProbe.amountIn = "0"; }, d => { d.runtimeDetection.priceProbe.amountIn = String(MaxUint256 + 1n); },
    d => { d.runtimeDetection.priceProbe.signature = "quote(uint256) view returns (uint256)"; },
    d => { d.runtimeDetection.priceProbe.signature = "quote(address,address,uint128) view returns (uint256)"; },
    d => { d.runtimeDetection.priceProbe.signature = "quote(uint256,address,address) view returns (uint256)"; },
    d => { d.runtimeDetection.priceProbe.signature = "quote(address,address,uint256) returns (uint256)"; },
    d => { d.runtimeDetection.priceProbe.signature = "quote(address,address,uint256) payable returns (uint256)"; },
    d => { d.callPatterns[0].when = { op: "rpc", args: [] }; },
    d => { d.decode = () => true; },
  ];
  for (const change of changes) { const f = fixture(); change(f.definition); assert.throws(() => validateDeclarativeOracleVictim(f.definition)); }
});

test("the production oracle detector consumes canonical full/short probes and reports only changed edges", async () => {
  const f = fixture(), tokenIn = toBeHex(201, 20), tokenOut = toBeHex(202, 20);
  const graph = [{ adapterId: "fixture-swap", target: pool, tokenIn, tokenOut,
    slotKind: "protocol" as const, protocolAction: "convert" as const, ...deriveEdgeTaxonomy("protocol", "convert") }];
  for (const signature of [
    "function quote(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256 fee, uint256 amountOut)",
    "quote(address,address,uint256) pure returns (uint256,uint256)",
  ]) {
    const definition = clone(f.definition);
    definition.runtimeDetection.priceProbe.signature = signature;
    definition.runtimeDetection.priceProbe.outputIndex = 1;
    definition.runtimeDetection.priceProbe.amountIn = String(MaxUint256);
    const victim = compileDeclarativeOracleVictim(definition, f.values);
    assert.equal(victim.runtimeDetection.priceProbe.signature.startsWith("function "), false);
    const probe = new Interface([`function ${victim.runtimeDetection.priceProbe.signature}`]);
    const descriptor: StrictOracleVictimDescriptor = { ...victim.runtimeDetection,
      matches: input => input.to !== null && victim.decode({ observation: {
        kind: "call", source: { ...source, number: input.blockNumber }, target: input.to, data: input.data,
      } }) !== null };
    const calls: unknown[] = [];
    function backend(output: bigint, block?: number) {
      return { async call(request: { to: string; data: string; blockTag?: unknown }) {
        assert.equal(request.to, pool); assert.equal(request.blockTag, block);
        const decoded = probe.decodeFunctionData("quote", request.data);
        assert.deepEqual([String(decoded[0]).toLowerCase(), String(decoded[1]).toLowerCase(), decoded[2]], [tokenIn, tokenOut, MaxUint256]);
        calls.push(request);
        return probe.encodeFunctionResult("quote", [7n, output]);
      } };
    }
    const effect = await matchOracleVictimEffect(forwarder, f.observation.data, graph, backend(100n, 99), 99,
      backend(101n), [descriptor]);
    assert.equal(calls.length, 2);
    assert.equal(effect?.priceChanges.length, 1);
    assert.equal(effect?.priceChanges[0]?.beforeAmountOut, 100n);
    assert.equal(effect?.priceChanges[0]?.afterAmountOut, 101n);
    assert.equal(effect?.priceChanges[0]?.probeAmountIn, MaxUint256);
    assert.equal(await matchOracleVictimEffect(forwarder, f.observation.data, graph, backend(100n, 99), 99,
      backend(100n), [descriptor]), null);
    const count = calls.length;
    assert.equal(await matchOracleVictimEffect(pool, f.observation.data, graph, backend(100n, 99), 99,
      backend(101n), [descriptor]), null);
    assert.equal(calls.length, count, "unrelated target performs no price probe");
  }
});

test("same target can declare different selectors without ambiguous pattern order", () => {
  const f = fixture();
  f.definition.callPatterns.push({ ...clone(f.definition.callPatterns[0]), id: "second-call", signature: "forwardAgain(address,bytes)" });
  const second = new Interface(["function forwardAgain(address,bytes)"]);
  const victim = compileDeclarativeOracleVictim(f.definition, f.values);
  assert.deepEqual(victim.decode({ observation: { ...f.observation, data: second.encodeFunctionData("forwardAgain", [oracle, payload]) } }),
    victim.decode({ observation: f.observation }));
});

test("existing Metronome victim metadata and positive/negative decoding remain equivalent", () => {
  const f = fixture(), original = metronomeSynthOracleVictim, originalPattern = original.callPatterns[0]!;
  f.definition.callPatterns[0] = { ...f.definition.callPatterns[0], ...originalPattern, targets: [ADDR.METRONOME_ORACLE_FORWARDER] };
  delete f.definition.callPatterns[0].selector;
  f.definition.canonicalIntakeTargets = original.canonicalIntakeTargets;
  f.definition.runtimeDetection = { ...original.runtimeDetection,
    priceProbe: { ...original.runtimeDetection.priceProbe, amountIn: String(original.runtimeDetection.priceProbe.amountIn) } };
  const values = compileDeclarativeValues({ ...f.valuesDocument, constants: { oracle: ADDR.METRONOME_ORACLE, selector: "0xb1dc65a4" } });
  const victim = compileDeclarativeOracleVictim(f.definition, values);
  assert.deepEqual(victim.callPatterns, original.callPatterns);
  assert.deepEqual(victim.runtimeDetection, original.runtimeDetection);
  assert.deepEqual(victim.canonicalIntakeTargets, original.canonicalIntakeTargets);
  for (const [target, address, data] of [
    [ADDR.METRONOME_ORACLE_FORWARDER, ADDR.METRONOME_ORACLE, "0xb1dc65a4"],
    [ADDR.METRONOME_ORACLE_FORWARDER, ADDR.METRONOME_ORACLE, "0xb1dc65a4aabb"],
    [ADDR.METRONOME_ORACLE_FORWARDER, pool, "0xb1dc65a4"],
    [ADDR.METRONOME_ORACLE_FORWARDER, ADDR.METRONOME_ORACLE, "0x12345678"],
    [pool, ADDR.METRONOME_ORACLE, "0xb1dc65a4"],
  ]) {
    const observation = { ...f.observation, target: target!, data: abi.encodeFunctionData("forward", [address, data]) };
    assert.deepEqual(victim.decode({ observation }), original.decode({ observation }));
  }
});

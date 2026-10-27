import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { compileDeclarativeIdentity } from "../venues/declarative-identity.js";
import { expandConversionDefinition } from "../venues/declarative-definition.js";
import { compileDeclarativeDiscovery } from "../venues/declarative-discovery.js";
import familyDefinition from "../venues/protocols/erc4626-family/erc4626.json";
import { familyId, lineageId } from "../venues/adapter-family-identifiers.js";
const definition = familyDefinition.identity.definition;
const profile = { id: "test", familyId: familyId("protocol:erc4626"), lineageId: lineageId("erc4626:standalone-standard-behavior"),
  parameters: { excludeSpecialized: true, hasEventMath: false } };
const candidate = { candidateKind: "erc4626-vault", vault: "0x1111111111111111111111111111111111111111" };
const step = { candidate, evidence: undefined } as any;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const compile = (d = definition) => compileDeclarativeIdentity(expandConversionDefinition(d), profile);
const O = (op: string, ...args: any[]) => ({ op, args });

test("one JSON sample declaration controls both requested amount and decoded active amount", () => {
  const d = clone(definition); d.parameters.constants.samples = ["9007199254740993", "1000000000000000001"];
  const variant = compile(d), iface = new Interface(d.abi.vault);
  const calls = variant.buildRequests(step);
  const request = calls.find(x => x.id === "base-convert-shares:0") as any;
  assert.equal(iface.decodeFunctionData("convertToShares", request.data)[0], 9007199254740993n);
  const source = { number: 100, hash: `0x${"a".repeat(64)}`, generation: 1 };
  const results = calls.map((request: any) => {
    let data = "0x6000";
    if (request.kind === "eth-call") {
      const parsed = iface.parseTransaction({ data: request.data })!;
      const value = parsed.name === "asset" ? "0x2222222222222222222222222222222222222222" :
        parsed.name === "totalSupply" || parsed.name === "totalAssets" ? 10n ** 24n : parsed.args[0];
      data = iface.encodeFunctionResult(parsed.name, [value]);
    }
    return { id: request.id, ok: true, completion: "returned", data, source };
  });
  const evidence: any = variant.decode({ step, results } as any);
  assert.equal(evidence.sampleAssets, 9007199254740993n);
  assert.equal(evidence.alternateDepositSample.amount, 1000000000000000001n);
  const active = variant.buildRequests({ ...step, evidence });
  assert.equal(iface.decodeFunctionData("deposit", (active.find(x => x.id === "active-deposit") as any).call.data)[0], 9007199254740993n);
});

test("definitions are snapshotted and ordinary views cannot directly verify a candidate", () => {
  const d = clone(definition), v = compile(d), before = v.buildRequests(step);
  d.parameters.constants.samples[0] = "7";
  assert.deepEqual(v.buildRequests(step), before);
  assert.equal(v.decide(step).status, "continue");
  assert.equal(v.decide({ ...step, evidence: { phase: "base", baseValid: true } }).status, "continue");
  const frozen: any = v.requirements(step); assert(Object.isFrozen(frozen));
  assert.throws(() => frozen.transports.push("fake"));
});

test("unknown operations, unsafe numbers, callbacks, bad bindings and cycles are rejected", () => {
  const mutate = (f: (doc: any) => void) => { const d = expandConversionDefinition(definition); f(d); assert.throws(() => compileDeclarativeIdentity(d, profile)); };
  mutate(d => d.identity.decide = [{ return: O("eval", "return true") }]);
  mutate(d => d.constants.bad = 9007199254740993);
  mutate(d => d.constants.callback = () => true);
  mutate(d => d.identity.decide = [{ let: "candidate", value: true }, { return: true }]);
  mutate(d => d.identity.decide = [{ return: O("add", 1) }]);
  mutate(d => d.identity.decide = [{ return: "$typo.value" }]);
  mutate(d => d.identity.decide = [{ return: true, ignored: "field" }]);
  mutate(d => d.expressions.cycle = O("expression", "cycle", {}));
  mutate(d => d.version = 2);
});

test("a variable from a different stage cannot silently become undefined", () => {
  const d = expandConversionDefinition(definition);
  d.identity.decide = [{ return: "$asset" }];
  const variant = compileDeclarativeIdentity(d, profile);
  assert.throws(() => variant.decide(step), /unbound/);
});

test("a different ABI definition uses the same flow without a new handler", () => {
  const d = clone(definition);
  d.abi.vault = d.abi.vault.map(s => s.replace("function asset()", "function underlyingToken()"));
  d.parameters.calls.inputAsset = "underlyingToken";
  const request: any = compile(d).buildRequests(step).find(r => r.id === "base-asset");
  assert.equal(request.data, new Interface(d.abi.vault).encodeFunctionData("underlyingToken"));
  delete (d.parameters.calls as any).inputAsset;
  assert.throws(() => compile(d), /parameter/);
});

test("duplicate requests, unknown stages and malformed discovery definitions fail closed", () => {
  const d = expandConversionDefinition(definition);
  d.identity.stages.base.requests = [{ id: "same" }, { id: "same" }];
  assert.throws(() => compileDeclarativeIdentity(d, profile).buildRequests(step), /duplicate/);
  const v = compile();
  assert.throws(() => v.buildRequests({ ...step, evidence: { phase: "invented" } }));
  const discovery = clone(familyDefinition.discovery.definition); discovery.calls.push(discovery.calls[0]);
  assert.throws(() => compileDeclarativeDiscovery(discovery), /duplicate/);
});

test("constant paths are checked before admission, including the specialized exclusion hash", () => {
  const d = expandConversionDefinition(definition);
  delete d.constants.maskedImplementationHash;
  assert.throws(() => compileDeclarativeIdentity(d, profile), /unknown declarative constant.*maskedImplementationHash/);
  const bad = expandConversionDefinition(definition);
  bad.identity.decide = [{ return: "$constants.getterBindings.0.missing" }];
  assert.throws(() => compileDeclarativeIdentity(bad, profile), /unknown declarative constant/);
});

test("parameter expansion rejects silent key collisions, unfinished text and lossy JSON", () => {
  const duplicate = clone(definition); duplicate.parameters.events.shareField = duplicate.parameters.events.assetField;
  assert.throws(() => compile(duplicate), /duplicate/);
  const unfinished = clone(definition); unfinished.parameters.calls.inputAsset = "{{unfinished";
  assert.throws(() => compile(unfinished), /parameter/);
  for (const bad of [() => true, 1n, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    const d = clone(definition); (d.parameters.constants as any).bad = bad;
    assert.throws(() => compile(d), /lossless JSON/);
  }
});

test("call argument order and event field names come from the Family definition", () => {
  const d = clone(definition);
  d.abi.vault = d.abi.vault.map(s => s.replace("deposit(uint256 assets,address receiver)", "deposit(address receiver,uint256 assets)")
    .replace("uint256 assets,uint256 shares)", "uint256 unitsIn,uint256 unitsOut)"));
  d.parameters.execution.forwardArgs.reverse();
  d.parameters.events.assetField = "unitsIn"; d.parameters.events.shareField = "unitsOut";
  const iface = new Interface(d.abi.vault), actor = d.parameters.constants.actor;
  const base = { phase: "base", vault: candidate.vault, asset: "0x2222222222222222222222222222222222222222",
    sampleAssets: 10n, sampleShares: 5n, previewDeposit: 20n, baseValid: true };
  const request: any = compile(d).buildRequests({ ...step, evidence: base }).find(r => r.id === "active-deposit");
  assert.equal(iface.decodeFunctionData("deposit", request.call.data)[1], 10n);
  assert.equal(iface.decodeFunctionData("deposit", request.call.data)[0].toLowerCase(), actor);
  const log = iface.encodeEventLog(iface.getEvent("Deposit")!, [actor, actor, 10n, 20n]);
  const deposit = { ok: true, completion: "returned", data: iface.encodeFunctionResult("deposit", [20n]), effects: {
    tokenDeltas: [{ token: base.asset, account: actor, delta: -10n }, { token: base.vault, account: actor, delta: 20n }],
    totalSupplyDeltas: [{ token: base.vault, delta: 20n }], logs: [{ address: base.vault, ...log }],
  } };
  const document = expandConversionDefinition(d);
  document.identity.decide = [{ return: O("expression", "depositProof", { base: "$evidence.base", deposit: "$evidence.deposit",
    eventAssets: "$evidence.base.sampleAssets", roundTrip: "$evidence.base.sampleAssets", depositValue: "$evidence.base.previewDeposit" }) }];
  const v = compileDeclarativeIdentity(document, profile);
  assert.equal(v.decide({ ...step, evidence: { base, deposit } }), true);
  const wrongLog = iface.encodeEventLog(iface.getEvent("Deposit")!, [actor, actor, 11n, 20n]);
  assert.equal(v.decide({ ...step, evidence: { base, deposit: { ...deposit, effects: { ...deposit.effects, logs: [{ address: base.vault, ...wrongLog }] } } } }), false);
});

test("specialized reverse binding requests follow the declared list length and getters", () => {
  const d = clone(definition);
  d.parameters.constants.getterBindings.push({ offsets: [32], getter: "asset", requestId: "extra-binding" });
  const evidence = { phase: "base", stakedUsdatCheck: { implementation: candidate.vault, implementationMatched: true } };
  const requests = compile(d).buildRequests({ ...step, evidence });
  assert.equal(requests.length, 5);
  assert.equal((requests[4] as any).data, new Interface(d.abi.specialized).encodeFunctionData("asset"));
  assert.equal(requests[4].id, "extra-binding");
});

test("source evidence alias is consumed independently of the class-stage field alias", () => {
  const d = clone(definition); d.parameters.fields.maskedSource = "classSource";
  const v = compile(d), source = { number: 100, hash: `0x${"a".repeat(64)}`, generation: 1 };
  const input = { ...step, evidence: { phase: "base", custodianCheck: "slot", classSource: source } };
  const data = `0x${"0".repeat(24)}${candidate.vault.slice(2)}`;
  const results = [{ id: "standard-implementation", ok: true, completion: "returned", data, source }];
  const evidence: any = v.decode({ step: input, results } as any);
  assert.equal(evidence.custodianCheck, "code");
  assert.equal(evidence.custodianImplementation, candidate.vault);
  assert.deepEqual(evidence.classSource, source);
  assert.throws(() => v.decode({ step: input, results: [{ ...results[0], source: { ...source, number: 101 } }] } as any));
});

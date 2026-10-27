import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { Interface } from "ethers";
import { normalizeDeclarativeChecks, normalizeDeclarativeFieldModel,
  normalizeDeclarativeReadProgram, normalizeDeclarativeVariant } from "../venues/declarative-variant.js";
import { compileDeclarativeIdentity } from "../venues/declarative-identity.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import custodian from "../venues/protocols/erc4626-family/custodian.json";
import infinifi from "../venues/protocols/erc4626-family/infinifi.json";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const visit = (value: any, fn: (value: any) => void): void => {
  fn(value); if (value && typeof value === "object") Object.values(value).forEach(item => visit(item, fn));
};

for (const definition of [custodian, infinifi]) {
  test(`${definition.id}: authored definitions contain fields/reads, shared layer supplies the admission program`, () => {
    visit(definition, value => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const key of ["let", "return", "attempt", "try", "evaluate", "assert", "programs"])
          assert.equal(Object.hasOwn(value, key), false, `authored instruction ${key}`);
      }
    });
    const raw = clone(definition), expanded = normalizeDeclarativeVariant(raw);
    const firstHash = hash(expanded);
    assert.equal(firstHash, hash(normalizeDeclarativeVariant(raw)));
    assert.deepEqual(Object.keys(expanded.identity.stages), ["base", raw.admission.match.phase, "surface", "probe"]);
    assert(expanded.programs.exactTokenDelta);
    assert(expanded.programs.verifyEffects);
    raw.constants.actor = "0x1111111111111111111111111111111111111111";
    assert.equal(hash(expanded), firstHash);
  });
}

test("unknown controls, shadowed shared proofs and incomplete observed effects fail registration", () => {
  const change = (mutate: (definition: any) => void) => {
    const raw: any = clone(custodian); mutate(raw); assert.throws(() => normalizeDeclarativeVariant(raw));
  };
  change(raw => raw.admission.match.phase = "surface");
  change(raw => raw.admission.active.sourceFailure = "ignore");
  change(raw => raw.admission.active.tokenDeltas = []);
  change(raw => raw.admission.active.events = []);
  change(raw => raw.admission.surface.allowWithoutProof = true);
  change(raw => raw.models.exactTokenDelta = { fields: [], output: true });
  change(raw => raw.readPrograms.guard.decode = [{ return: true }]);
  change(raw => raw.programs = {});
  change(raw => raw.requestSets.surfaceRequests.push({ id: "bad", storage: { slot: "0x00" } }));
  change(raw => raw.models.word.fields.push({ name: "data", value: "0x" }));
});

test("typed view definitions control the request without a new Family handler", () => {
  const raw: any = clone(infinifi);
  raw.abi.vault = raw.abi.vault.map((signature: string) => signature.replace("function getAddress(string)", "function lookupAddress(string)"));
  raw.admission.match.reads[1].call.function = "lookupAddress";
  raw.admission.match.function = "lookupAddress";
  const expanded = normalizeDeclarativeVariant(raw);
  const variant = compileDeclarativeIdentity({ version: 1, inputs: expanded.inputs, abi: expanded.abi,
    constants: expanded.constants, expressions: expanded.expressions, programs: expanded.programs, identity: expanded.identity },
    { id: expanded.id, familyId: "protocol:test" as any, lineageId: expanded.lineageId as any });
  const requests = variant.buildRequests({ candidate: { candidateKind: "vault", vault: "0x1111111111111111111111111111111111111111" }, step: 0 } as any);
  const request = requests.find(row => row.id === "infinifi-registry");
  assert(request?.kind === "eth-call");
  assert.equal(new Interface(expanded.abi.vault).parseTransaction({ data: request.data })?.name, "lookupAddress");
});

test("common active proof still requires a unique exact token delta", () => {
  const expanded = normalizeDeclarativeVariant(custodian);
  const values = compileDeclarativeValues({ inputs: expanded.inputs, abi: expanded.abi, constants: expanded.constants,
    expressions: expanded.expressions, programs: expanded.programs });
  const token = "0x1111111111111111111111111111111111111111", account = "0x2222222222222222222222222222222222222222";
  const check = (rows: any[]) => values.evaluate({ op: "program", args: ["exactTokenDelta", {}] }, {
    token, account, delta: -10n, result: { effects: { tokenDeltas: rows } },
  });
  assert.equal(check([{ token, account, delta: -10n }]), true);
  assert.throws(() => check([{ token, account, delta: 0n }]), /effect mismatch/);
  assert.throws(() => check([{ token, account, delta: -9n }]), /effect mismatch/);
  assert.throws(() => check([{ token, account, delta: -10n }, { token, account, delta: 0n }]), /effect mismatch/);
});

test("public field and constraint models preserve legacy decode values and rejection boundaries", () => {
  const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
  const checks = [{ condition: { $gt: ["$amount", 0] }, error: "empty amount", when: "$enabled" }];
  const expandedChecks = [{ assert: { op: "gt", args: ["$amount", 0] }, error: "empty amount", when: "$enabled" }];
  assert.deepEqual(normalizeDeclarativeChecks(checks), expandedChecks);
  assert.deepEqual(normalizeDeclarativeChecks(expandedChecks), expandedChecks);
  assert.doesNotThrow(() => values.run(normalizeDeclarativeChecks(checks), { enabled: false, amount: 0 }));
  assert.throws(() => values.run(normalizeDeclarativeChecks(checks), { enabled: true, amount: 0 }), /empty amount/);

  const model = { fields: [{ name: "amount", value: { $number: ["$raw"] }, checks }], output: { amount: "$amount" } };
  const expanded = [
    { let: "amount", value: { op: "number", args: ["$raw"] } }, ...expandedChecks,
    { return: { amount: "$amount" } },
  ];
  assert.deepEqual(normalizeDeclarativeFieldModel(model), expanded);
  assert.deepEqual(normalizeDeclarativeFieldModel(expanded), expanded);
  assert.deepEqual(values.run(normalizeDeclarativeFieldModel(model), { raw: "12", enabled: true }), { amount: 12 });
  assert.throws(() => values.run(normalizeDeclarativeFieldModel(model), { raw: "0", enabled: true }), /empty amount/);
});

test("public read program normalization supports results and validated legacy decoders", () => {
  const authored = { requests: [{ id: "quote", kind: "eth-call", to: "$vault" }], result: { $number: ["$response"] } };
  const expected = { requests: authored.requests, decode: [{ return: { op: "number", args: ["$response"] } }] };
  assert.deepEqual(normalizeDeclarativeReadProgram(authored), expected);
  assert.deepEqual(normalizeDeclarativeReadProgram(expected), expected);
  assert.deepEqual(normalizeDeclarativeReadProgram({ requests: [], decode: { fields: [], output: true } }),
    { requests: [], decode: [{ return: true }] });
  const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
  assert.equal(values.run(normalizeDeclarativeReadProgram(authored).decode, { response: "17" }), 17);
});

test("variant normalization covers shared pricing and exact constraints without an admission program", () => {
  const check = { condition: { $gt: ["$amount", 0] }, error: "empty amount" };
  const expected = { assert: { op: "gt", args: ["$amount", 0] }, error: "empty amount" };
  const original = {
    id: "example", execution: { untouched: true }, assertions: [check],
    pricing: { finalizeChecks: [check], static: { decode: { fields: [], output: "$amount" } } },
    exact: { checks: [check], outputChecks: [check] },
    readPrograms: { quote: { requests: [], result: "$amount" } },
  };
  const result = normalizeDeclarativeVariant(original);
  assert.deepEqual(result.assertions, [expected]);
  assert.deepEqual(result.pricing.finalizeChecks, [expected]);
  assert.deepEqual(result.pricing.static.decode, [{ return: "$amount" }]);
  assert.deepEqual(result.exact.checks, [expected]);
  assert.deepEqual(result.exact.outputChecks, [expected]);
  assert.deepEqual(result.readPrograms.quote, { requests: [], decode: [{ return: "$amount" }] });
  assert.deepEqual(result.execution, original.execution);
  assert.equal(Object.hasOwn(result, "identity"), false);
  assert.equal(Object.hasOwn(result, "programs"), false);
  assert.deepEqual(normalizeDeclarativeVariant(result), result);
  assert.equal(Object.hasOwn(original.assertions[0], "assert"), false);
});

test("public model normalization rejects ambiguous and executable author shapes", () => {
  for (const bad of [null, [{ condition: true }], [{ condition: true, assert: true, error: "bad" }],
    [{ return: true }], [{ condition: true, error: "bad", handler: "custom" }]]) {
    assert.throws(() => normalizeDeclarativeChecks(bad as any));
  }
  assert.throws(() => normalizeDeclarativeFieldModel([{ return: true, assert: true }]));
  assert.throws(() => normalizeDeclarativeFieldModel({ fields: [], output: () => true }));
  assert.throws(() => normalizeDeclarativeFieldModel({ fields: [], output: { $unknown: [] } }));
  assert.throws(() => normalizeDeclarativeFieldModel({ fields: [], handler: "custom" }));
  for (const bad of [{ requests: [], result: true, decode: [{ return: true }] },
    { requests: [] }, { result: true }, { requests: [], decode: [{ handler: "custom" }] }]) {
    assert.throws(() => normalizeDeclarativeReadProgram(bad));
  }
});

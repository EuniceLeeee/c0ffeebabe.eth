import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, Interface, getAddress, getCreate2Address, keccak256, toBeHex } from "ethers";
import { createDeclarativeFamilyRuntime } from "../venues/declarative-family.js";
import { defineProtocolFamily } from "../venues/adapter-family-plugin.js";
import { compileDeclarativeIdentity } from "../venues/declarative-identity.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { createIdentityAssetMetadataPlan } from "../identity-asset-metadata.js";
import root from "../venues/protocols/erc4626-family/erc4626.json";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const op = (op: string, ...args: unknown[]) => ({ op, args });
const a = (n: number) => getAddress(toBeHex(n, 20));

function models() {
  const doc: any = clone(root), lineage = doc.standard.lineageId;
  doc.manifest.supportedLineages = [lineage];
  doc.variantFiles = ["./second.json"];
  const second = { ...clone(doc.standard), version: 1, id: "second", identity: {
    select: [{ return: "probe" }], stages: { probe: { requirements: { transports: [] }, requests: [], decode: [{ return: {} }] } },
    decide: [{ return: { status: "retryable", reasonCode: "fixture" } }],
  } };
  doc.standard.match = op("and", op("eq", "$descriptor.lineageId", lineage), op("eq", "$descriptor.model", "first"));
  second.match = op("and", op("eq", "$descriptor.lineageId", lineage), op("eq", "$descriptor.model", "second"));
  second.pricing.refreshPolicy = "each-block";
  return { doc, second, lineage };
}

test("one lineage can retain distinct descriptor-bound models without changing lineage identity", () => {
  const { doc, second, lineage } = models();
  const runtime = createDeclarativeFamilyRuntime(doc, [second]);
  assert.equal(defineProtocolFamily(runtime.definition as any).identity.variants.length, 2);
  assert.equal(runtime.select({ lineageId: lineage, model: "first" }).document.id, doc.standard.id);
  assert.equal(runtime.select({ lineageId: lineage, model: "second" }).document.id, second.id);
  assert.equal(runtime.definition.identity.variants.length, 2);
  assert.equal(runtime.variants[0]!.document.pricing.refreshPolicy, "on-touch");
  assert.equal(runtime.variants[1]!.document.pricing.refreshPolicy, "each-block");
  assert.throws(() => runtime.select({ lineageId: "foreign", model: "first" }), /exactly one/);
  assert.throws(() => runtime.select({ lineageId: lineage, model: "missing" }), /exactly one/);
});

test("duplicate, ambiguous, missing and nonboolean model bindings remain rejected", () => {
  const { doc, second, lineage } = models();
  second.match = true; doc.standard.match = true;
  assert.throws(() => createDeclarativeFamilyRuntime(doc, [second]).select({ lineageId: lineage }), /exactly one/);
  second.match = false; doc.standard.match = 1;
  assert.throws(() => createDeclarativeFamilyRuntime(doc, [second]).select({ lineageId: lineage }), /exactly one/);
  second.id = doc.standard.id;
  assert.throws(() => createDeclarativeFamilyRuntime(doc, [second]), /duplicate/);
  second.id = "second"; second.lineageId = "foreign";
  assert.throws(() => createDeclarativeFamilyRuntime(doc, [second]), /lineage coverage/);

});

test("optional identity assets use the existing metadata authority and add no reads when absent", () => {
  const doc: any = { version: 1, abi: {}, constants: {}, expressions: {}, identity: {
    select: [{ return: "probe" }], stages: { probe: { requirements: { transports: [] }, requests: [],
      decode: [{ let: "assets", value: [] }, { return: "$assets" }] } }, decide: [{ return: { status: "retryable", reasonCode: "fixture" } }],
  } };
  const profile = { id: "fixture", familyId: "protocol:fixture" as any, lineageId: "fixture" as any };
  const plain = compileDeclarativeIdentity(doc, profile);
  assert.equal(plain.assets, undefined);
  assert.deepEqual(plain.decode({ step: { candidate: {}, step: 0 } as any, results: [] }), [],
    "legacy local variables are not reserved by an undeclared optional capability");
  doc.identity.stages.probe.decode = [{ return: "$assets" }];
  doc.identity.assets = [{ key: "input", kind: "erc20", address: "$candidate.asset" }, { key: "output", kind: "native" }];
  const variant = compileDeclarativeIdentity(doc, profile), source = { number: 10, hash: toBeHex(10, 32), generation: 1 };
  const step: any = { candidate: { asset: a(1) }, step: 0, source };
  const plan = createIdentityAssetMetadataPlan(variant.assets!(step), source);
  assert.equal(plan.append([]).length, 2, "only ERC20 metadata adds requests; native uses central metadata");
  const assets: any[] = [{ key: "input", kind: "erc20", token: a(1), code: "0x6000", decimals: 6 }];
  assert.deepEqual(variant.decode({ step, results: [], assets }), assets);
  assert.deepEqual(variant.buildRequests(step), []);
  doc.identity.assets.push(doc.identity.assets[0]);
  assert.throws(() => createIdentityAssetMetadataPlan(compileDeclarativeIdentity(doc, profile).assets!(step), source), /duplicate/);
});

test("CREATE2 and canonical error codecs are pure generic operations with no admission shortcut", () => {
  const error = new Interface(["error Quote(uint256 output)"]);
  const values = compileDeclarativeValues({ abi: { response: ["error Quote(uint256 output)"] }, constants: {}, expressions: {} });
  const types = ["address", "address"], tokens = [a(1), a(2)];
  const encoded = values.evaluate(op("abiEncode", types, tokens), {});
  assert.equal(encoded, AbiCoder.defaultAbiCoder().encode(types, tokens));
  const salt = keccak256(encoded), initCodeHash = keccak256("0x6000");
  assert.equal(values.evaluate(op("create2Address", a(3), salt, initCodeHash), {}), getCreate2Address(a(3), salt, initCodeHash));
  const payload = error.encodeErrorResult("Quote", [11n]);
  assert.deepEqual(values.evaluate(op("decodeErrorCanonical", "response", "Quote", payload), {}), [11n]);
  assert.throws(() => values.evaluate(op("decodeErrorCanonical", "response", "Quote", payload + "00"), {}), /noncanonical/);
  assert.throws(() => values.evaluate(op("decodeErrorCanonical", "response", "Quote", "0xdeadbeef" + payload.slice(10)), {}));
  assert.throws(() => values.evaluate(op("create2Address", a(3), "0x12", initCodeHash), {}));
  assert.throws(() => values.evaluate(op("abiEncode", ["uint8"], [256]), {}));
  assert.throws(() => values.evaluate(op("abiEncode", types, [a(1)]), {}), /types/);
});

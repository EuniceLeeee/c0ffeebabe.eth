import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { toBeHex, Interface } from "ethers";
import { inspectRuntime } from "./runtime-program-testkit.js";
import { createDeclarativeProtocolRuntime } from "../venues/declarative-protocol.js";
import { defineProtocolFamily, definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash } from "../venues/family-capability-catalog.js";
import { StrictProductionFamilyDeclarations } from "../strict-production-family-declarations.js";
import definition from "../venues/protocols/erc4626-family/erc4626.json";
import custodian from "../venues/protocols/erc4626-family/custodian.json";
import infinifi from "../venues/protocols/erc4626-family/infinifi.json";
import { oracleModuleFixture, oracleFixtureTarget, oracleFixtureArgument, oracleFixtureData } from "./declarative-optional-modules-fixture.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function runtime(doc: any = clone(definition), children = [clone(custodian), clone(infinifi)]) {
  return createDeclarativeProtocolRuntime(doc, children);
}
function declarations(compiled: ReturnType<typeof runtime>) {
  const plugin = defineProtocolFamily(compiled.definition);
  // Synthetic catalogue identities only. Manifest source hashing is checked in
  // declarative-production.test.ts; this exercises the actual strict consumer.
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({
    familyId: plugin.manifest.familyId, capability, contractVersion: "s1-v1" as const,
    contentHash: createHash("sha256").update(`fixture/${capability}`).digest("hex"),
    semanticDependencies: ["fixture:optional-modules"], provenanceCommit: null,
  }));
  const catalog = new FamilyCapabilityCatalog({
    modules: [{ plugin, sourceFile: "fixture.production.ts",
      definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) },
  });
  return new StrictProductionFamilyDeclarations(catalog);
}

test("old JSON exposes uniform empty modules without claiming new capabilities or changing source data", () => {
  const old = clone(definition), before = JSON.stringify(old), compiled = runtime(old);
  assert.equal(JSON.stringify(old), before);
  for (const variant of compiled.moduleViews) {
    assert.deepEqual(variant.modules.oracleVictim, {});
    assert.deepEqual(variant.modules.quoteOutput, {});
  }
  for (const variant of compiled.moduleCoverage) for (const key of ["oracleVictim", "quoteOutput"])
    assert.equal(variant.modules.find(row => row.key === key)!.state, "undefined");
  assert.equal(compiled.definition.protocol.oracleVictim, undefined);
  assert.deepEqual(declarations(compiled).oracleVictims, []);
  old.modules = { ...(old as any).modules, oracleVictim: {}, quoteOutput: {} };
  const explicit = runtime(old);
  assert.deepEqual(explicit.moduleViews, compiled.moduleViews);
  assert.deepEqual(explicit.moduleCoverage, compiled.moduleCoverage);
});

test("root oracle JSON reaches strict registration and existing detector projection without a custom production entry", () => {
  const doc: any = clone(definition);
  doc.modules = { ...doc.modules, oracleVictim: oracleModuleFixture(doc.manifest.ownedActionAdapterIds[0]) };
  const compiled = runtime(doc), projected = declarations(compiled);
  assert.equal(projected.oracleVictims.length, 1);
  assert(projected.canonicalIntakeTargets.some(target => target.toLowerCase() === oracleFixtureTarget));
  const matcher = projected.oracleVictims[0]!;
  assert.equal(matcher.priceProbe.amountIn, 100n);
  assert(matcher.matches({ to: oracleFixtureTarget, data: oracleFixtureData, blockNumber: 100 }));
  assert(!matcher.matches({ to: oracleFixtureArgument, data: oracleFixtureData, blockNumber: 100 }));
  assert(!matcher.matches({ to: oracleFixtureTarget, data: "0xdeadbeef", blockNumber: 100 }));
  const result = compiled.definition.protocol.oracleVictim!.decode({ observation: {
    kind: "call", target: oracleFixtureTarget, data: oracleFixtureData,
    source: { number: 100, hash: toBeHex(100, 32), generation: 1 },
  } });
  assert.equal((result as any).oracle.toLowerCase(), oracleFixtureArgument);
});

test("variant overrides and incomplete or falsely owned victim modules fail closed", () => {
  const doc: any = clone(definition);
  doc.modules = { ...doc.modules, oracleVictim: oracleModuleFixture(doc.manifest.ownedActionAdapterIds[0]) };
  const child: any = clone(custodian); child.modules = { oracleVictim: {} };
  assert.throws(() => runtime(doc, [child, clone(infinifi)]), /root-only/);
  doc.standard.modules = { oracleVictim: {} };
  assert.throws(() => runtime(doc), /root-only/);
  delete doc.standard.modules;
  doc.modules.oracleVictim.runtimeDetection.affectedEdges[0].adapterId = "unowned-action";
  assert.throws(() => declarations(runtime(doc)), /Family-owned/);
  doc.modules.oracleVictim = { version: 1 };
  assert.throws(() => runtime(doc), /missing|invalid/);
  doc.modules = {}; doc.protocol.oracleVictim = {};
  assert.throws(() => runtime(doc), /root modules/);
});

test("quoteOutput module is optional, visible, and consumed by the shared runtime emitter", () => {
  const doc: any = clone(definition), prior = doc.standard.execution;
  const { call, approval, ...shared } = prior;
  doc.standard.execution = { ...shared, version: 2, steps: [{ id: "convert", call, approval }] };
  const quote = { version: 1, steps: [{ id: "preview", static: true,
    call: { target: "$descriptor.vault", signature: "function previewDeposit(uint256) view returns(uint256)",
      args: [{ runtime: "amountIn" }], save: { previewed: 0 } } }], result: { runtime: "previewed" } };
  const descriptor: any = { familyId: doc.scope.family, lineageId: doc.standard.lineageId,
    instanceKey: toBeHex(1, 20), vault: toBeHex(1, 20), share: toBeHex(1, 20), asset: toBeHex(2, 20),
    verifiedDirections: { deposit: true, redeem: true }, runtimeRequirements: [] };
  const invocation = (compiled: ReturnType<typeof runtime>, settlement?: any) => {
    const route = compiled.definition.routes.project({ descriptor }).find((r: any) => r.direction === "deposit")!;
    return { descriptor, route, executor: toBeHex(91, 20), runtimeEvidence: [],
      source: { number: 100, hash: toBeHex(100, 32), generation: 1 }, ...(settlement ? { settlement } : {}) };
  };
  const old = runtime(doc), defaultLeg = old.definition.execution.buildRuntimeLeg!(invocation(old))!;
  assert.equal(defaultLeg.settlement?.quoteOutput, undefined);
  const request = { kind: "quote-output", recipient: toBeHex(92, 20) };
  assert.equal(old.definition.execution.buildRuntimeLeg!(invocation(old, request)), null);
  doc.standard.modules = { quoteOutput: quote };
  const withQuote = runtime(doc);
  assert.equal(withQuote.moduleCoverage[0]!.modules.find(row => row.key === "quoteOutput")!.state, "compiled");
  const newDefault = withQuote.definition.execution.buildRuntimeLeg!(invocation(withQuote))!;
  assert.equal(newDefault.program, defaultLeg.program, "unused optional quote adds no default execution work");
  assert.equal(newDefault.settlement?.quoteOutput, true);
  const emitter = withQuote.definition.execution.buildRuntimeLeg!(invocation(withQuote, request))!;
  const abi = new Interface(["function previewDeposit(uint256) view returns(uint256)"]);
  const inspected = inspectRuntime(emitter.program, 17n, { call(c) {
    assert.equal(c.static, true); assert.equal(c.target.toLowerCase(), descriptor.vault);
    assert.equal(abi.decodeFunctionData("previewDeposit", c.data)[0], 17n);
    return abi.encodeFunctionResult("previewDeposit", [34n]);
  } }, { output: true, readOnly: true });
  assert.equal(inspected.registers[0], 34n);
  assert.equal(inspected.calls.length, 1);
  doc.standard.execution.quoteOutput = quote;
  assert.throws(() => runtime(doc), /must be declared in modules/);
});

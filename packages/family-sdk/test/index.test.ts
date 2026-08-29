import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { asCapabilityId, asCapabilityVersion, asSchemaRef } from "../../capability-contracts/src/index.ts";
import { conformFamilyDefinition } from "../conformance/index.ts";
import {
  defineFamily,
  familyAuthoringDigest,
  type FamilyAuthoringDefinitionV1,
} from "../authoring/index.ts";
import { assertStageCapabilityRef } from "../runtime-refs/index.ts";

const h = (value: string): Hash => hashDomain("test/family-sdk", value);

type CoreKind = "nomination" | "identity" | "materialization" | "projection" | "rehydration";
const moduleRef = <K extends CoreKind>(kind: K) => ({
  modulePath: `families/demo/${kind}.ts`,
  exportName: `${kind}Capability`,
  artifactKind: kind,
  capabilityIds: [],
  schemaRefs: [asSchemaRef(h(`${kind}-schema`))],
}) as { readonly modulePath: string; readonly exportName: string; readonly artifactKind: K; readonly capabilityIds: readonly never[]; readonly schemaRefs: readonly ReturnType<typeof asSchemaRef>[] };

const definition = (): FamilyAuthoringDefinitionV1 => ({
  manifest: {
    familyId: "demo-family",
    version: "1.0.0",
    pluginCodeHash: h("plugin"),
    authorityDeclarationHash: h("authority"),
    sourcePlans: [{
      sourcePlanId: "fixed-cutoff-50-block",
      completeness: "nomination-only",
      historyStartBlock: null,
      schemaHash: asSchemaRef(h("source-plan-schema")),
      modulePath: "families/demo/source-plan.ts",
      exportName: "sourcePlan",
      nominationProgram: { kind: "absent", reason: "not-in-release" },
    }],
  },
  core: {
    nomination: { ...moduleRef("nomination"), sourcePlanIds: ["fixed-cutoff-50-block"] },
    identity: moduleRef("identity"),
    materialization: moduleRef("materialization"),
    projection: moduleRef("projection"),
    rehydration: moduleRef("rehydration"),
  },
  extensions: {
    "demo.quote": {
      kind: "present",
      module: {
        capabilityId: asCapabilityId("demo.quote"),
        version: asCapabilityVersion("1.0.0"),
        schemaHash: asSchemaRef(h("quote-schema")),
        interpreterHash: h("quote-interpreter"),
        dependencyIds: [],
        artifactKinds: ["exact"],
        modulePath: "families/demo/quote.ts",
        exportName: "quoteCapability",
      },
    },
    "demo.lp": { kind: "absent", reason: "requires-future-extension" },
  },
  actionOwners: [{
    ownerId: "demo.swap-action",
    version: asCapabilityVersion("1.0.0"),
    schemaHash: asSchemaRef(h("action-schema")),
    implementationHash: h("action-implementation"),
    actionKinds: ["execute"],
    modulePath: "families/demo/action.ts",
    exportName: "actionOwner",
  }],
  acceptanceDeclarations: [{ factContractId: "demo.identity-facts", version: asCapabilityVersion("1.0.0"), schemaHash: asSchemaRef(h("facts")) }],
});

test("big template normalizes without runtime callbacks or domain central unions", () => {
  const first = defineFamily(definition());
  const second = defineFamily(definition());
  assert.deepEqual(first, second);
  assert.equal(familyAuthoringDigest(first), familyAuthoringDigest(second));
  assert.equal(first.extensions["demo.lp"]?.kind, "absent");
  assert.equal(Object.isFrozen(first), true);
});

test("authoring template rejects unknown fields, slot mismatch, duplicate refs, and callbacks", () => {
  assert.throws(() => defineFamily({ ...definition(), unexpected: true } as never), /non-exact keys/);
  const quoteModule = definition().extensions["demo.quote"];
  assert.equal(quoteModule?.kind, "present");
  assert.throws(() => defineFamily({ ...definition(), extensions: {
    bad: {
      kind: "present",
      module: { ...(quoteModule?.kind === "present" ? quoteModule.module : {}), capabilityId: "different" },
    },
  } } as never), /extension key\/module mismatch/);
  assert.throws(() => defineFamily({ ...definition(), actionOwners: [definition().actionOwners[0]!, definition().actionOwners[0]!] } as never), /duplicate action owner/);
  assert.throws(() => defineFamily({ ...definition(), core: { ...definition().core, identity: { ...definition().core.identity, modulePath: "families/demo/identity.ts", exportName: (() => "identity") as never } } } as never), /canonical|invalid|accessor|function|non-empty string/);
});

test("conformance is fail-closed for unknown and mismatched capability contracts", () => {
  const normalized = defineFamily(definition());
  const index = [{
    capabilityId: asCapabilityId("demo.quote"),
    version: asCapabilityVersion("1.0.0"),
    schemaHash: asSchemaRef(h("quote-schema")),
    interpreterHash: h("quote-interpreter"),
    dependencyIds: [],
    modulePath: "families/demo/quote.ts",
    exportName: "quoteCapability",
  }];
  const result = conformFamilyDefinition(normalized, index);
  assert.deepEqual(result.declaredCapabilityIds, ["demo.quote"]);
  assert.throws(() => conformFamilyDefinition(normalized, [{ ...index[0]!, interpreterHash: h("changed") }]), /contract mismatch/);
  assert.throws(() => conformFamilyDefinition(normalized, []), /unknown capability/);
});

test("runtime stage ref rejects forged or widened objects", () => {
  const ref = {
    familyId: "demo-family",
    familyDefinitionHash: h("definition"),
    stage: "identity",
    capabilityId: "demo.identity",
    version: "1.0.0",
    schemaHash: h("schema"),
    interpreterHash: h("interpreter"),
    ownerRef: h("owner"),
  };
  assertStageCapabilityRef(ref);
  assert.throws(() => assertStageCapabilityRef({ ...ref, extra: true }), /non-exact|unknown/);
  const proxy = new Proxy(ref, { get: () => { throw new Error("proxy trap"); } });
  assert.throws(() => assertStageCapabilityRef(proxy), /Proxy/);
});

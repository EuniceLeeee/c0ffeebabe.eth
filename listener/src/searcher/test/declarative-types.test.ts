import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { renderDeclarativeFamilyTypes, validateDeclarativeTypeMetadata } from "../venues/declarative-types.js";
import { syncDeclarativeProductionEntries } from "../build-declarative-production.js";
import root from "../venues/protocols/erc4626-family/erc4626.json";
import custodian from "../venues/protocols/erc4626-family/custodian.json";
import infinifi from "../venues/protocols/erc4626-family/infinifi.json";

const simple = {
  version: 1,
  definitions: {
    Sample: { type: "object", fields: {
      amount: { type: "bigint" }, side: { union: [{ literal: "in" }, { literal: "out" }] },
      receipt: { type: "string" },
    }, optional: ["receipt"] },
    Samples: { array: { ref: "Sample" } },
  },
  contracts: { descriptor: "Sample" },
};

test("declared Family types preserve required, optional, readonly and literal boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "declarative-types-"));
  try {
    const generated = join(dir, "types.ts"), consumer = join(dir, "consumer.ts");
    await writeFile(generated, renderDeclarativeFamilyTypes(simple));
    await writeFile(consumer, `import type { Sample, Samples, FamilyTypes } from "./types.js";
const good: Sample = { amount: 1n, side: "in" };
const batch: Samples = [good];
const same: FamilyTypes["descriptor"] = good;
// @ts-expect-error input amount cannot become a string
const wrong: Sample = { amount: "1", side: "in" };
// @ts-expect-error required amount cannot be omitted
const missing: Sample = { side: "out" };
// @ts-expect-error direction remains a literal union
const direction: Sample = { amount: 1n, side: "other" };
// @ts-expect-error generated fields remain readonly
good.amount = 2n;
// @ts-expect-error arrays remain readonly
batch.push(good);
void same;
`);
    const program = ts.createProgram([generated, consumer], { strict: true, noEmit: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16, types: [], skipLibCheck: true });
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("type metadata rejects executable text, type escapes and invalid references", () => {
  for (const bad of [{ type: "any" }, { type: "unknown" }, { type: "string; process.exit()" },
    { type: "object", fields: {}, handler: "old" }, { ref: "../family/types" }, { literal: () => true },
    { type: "object", fields: {}, optional: ["missing"] }, { type: "object", fields: {}, extends: ["FamilyId"] }]) {
    assert.throws(() => renderDeclarativeFamilyTypes({ version: 1, definitions: { Sample: bad } }));
  }
  assert.throws(() => renderDeclarativeFamilyTypes({ version: 1, definitions: { Sample: { ref: "Missing" } } }), /unknown/);
  assert.throws(() => renderDeclarativeFamilyTypes({ version: 1, definitions: { Sample: { array: { ref: "Sample" } } } }), /cyclic/);
  assert.throws(() => renderDeclarativeFamilyTypes({ version: 1, definitions: { FamilyId: { type: "string" } } }), /brand/);
  assert.throws(() => renderDeclarativeFamilyTypes(simple, [simple]), /type document fields/);
  assert.throws(() => renderDeclarativeFamilyTypes(simple, [{ version: 1, definitions: { Sample: { type: "string" } } }]), /duplicate/);
  assert.throws(() => validateDeclarativeTypeMetadata({ ...simple, contracts: { customHandler: "Sample" } }), /contract/);
});

test("root and child type metadata generate the complete ERC contract without Staked coupling", async () => {
  const rendered = renderDeclarativeFamilyTypes(root.types, [custodian.types, infinifi.types]);
  const saved = await readFile(new URL("../generated/declarative-family-types/erc4626.generated.ts", import.meta.url), "utf8");
  assert.equal(rendered, saved);
  for (const name of ["Erc4626Candidate", "Erc4626BaseEvidence", "Erc4626ActiveEvidence", "Erc4626IdentityEvidence",
    "Erc4626Identity", "Erc4626Descriptor", "Erc4626Route", "Erc4626PricingDraft", "Erc4626PricingDescriptor",
    "Erc4626PricingStatic", "Erc4626ExactEvidence", "CustodianBinding", "CustodianSurface", "InfiniFiBinding", "InfiniFiSurface", "FamilyTypes"])
    assert.match(rendered, new RegExp(`export type ${name} =`));
  assert.doesNotMatch(rendered, /\b(?:any|unknown)\b|\bstakedUsdat\b|Staked|staked-usdat|protocols\//);
  // Standard identity still records the negative class check. That intermediate
  // evidence is independent data, not the separately owned Family's binding.
  assert.match(rendered, /readonly stakedUsdatCheck\?: Erc4626ImplementationExclusionEvidence/);
  assert.deepEqual(root.types.definitions.Erc4626ImplementationExclusionEvidence, {
    type: "object", fields: { source: { ref: "CanonicalSource" }, proxyCodeHash: { type: "string" },
      implementation: { type: "string" }, implementationMatched: { literal: true } },
    optional: ["implementation", "implementationMatched"],
  });
  const updated = structuredClone(custodian.types);
  updated.definitions.CustodianBinding.fields.asset.type = "boolean";
  assert.notEqual(renderDeclarativeFamilyTypes(root.types, [updated, infinifi.types]), saved);
});

test("isolated production generation checks typed output, stale data, orphan files and symlink escapes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "declared-type-entry-"));
  const listener = join(dir, "listener"), venues = join(listener, "src/searcher/venues");
  try {
    await mkdir(join(venues, "protocols/erc4626-family"), { recursive: true });
    await mkdir(join(venues, "production-families"), { recursive: true });
    for (const [name, data] of [["erc4626", root], ["custodian", custodian], ["infinifi", infinifi]] as const)
      await writeFile(join(venues, `protocols/erc4626-family/${name}.json`), JSON.stringify(data));
    for (const path of ["src/searcher/venues/declarative-protocol.ts", "src/searcher/venues/declarative-types.ts", "src/searcher/build-declarative-production.ts"])
      await writeFile(join(listener, path), "// isolated generation dependency\n");
    await syncDeclarativeProductionEntries({ rootDirectory: listener, mode: "write" });
    await syncDeclarativeProductionEntries({ rootDirectory: listener, mode: "check" });
    const entry = await readFile(join(venues, "production-families/erc4626.production.ts"), "utf8");
    assert.match(entry, /import type \{ FamilyTypes \}/);
    assert.match(entry, /compileDeclarativeProtocol<FamilyTypes>/);
    const typesDir = join(listener, "src/searcher/generated/declarative-family-types");
    const output = join(typesDir, "erc4626.generated.ts");
    const original = await readFile(output, "utf8");
    await writeFile(output, original + "\n");
    await assert.rejects(syncDeclarativeProductionEntries({ rootDirectory: listener, mode: "check" }), /types are missing or stale/);
    await writeFile(output, original);
    await writeFile(join(typesDir, "orphan.generated.ts"), original);
    await assert.rejects(syncDeclarativeProductionEntries({ rootDirectory: listener, mode: "write" }), /orphaned/);
    await rm(typesDir, { recursive: true });
    const outside = join(dir, "outside"); await mkdir(outside);
    await symlink(outside, typesDir, "dir");
    await assert.rejects(syncDeclarativeProductionEntries({ rootDirectory: listener, mode: "write" }), /symlink/);
    await assert.rejects(readFile(join(outside, "erc4626.generated.ts")), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

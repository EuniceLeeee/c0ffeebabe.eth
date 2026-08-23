import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  artifactDependencyRoot,
  catalogLeafDigest,
  computeCatalogImpact,
  definitionCatalogRoot,
  dependencyCatalogRoot,
  dependencyLeafDigest,
  type CatalogLeafV1,
  type DependencyLeafV1,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/artifact-fingerprint", value);
const capability = (id: string, dependencyIds: readonly string[] = []): DependencyLeafV1 => ({
  id,
  version: "1.0.0",
  schemaHash: h(`${id}:schema`),
  interpreterHash: h(`${id}:interpreter`),
  dependencyIds,
  implementationClosureRoot: h(`${id}:implementation`),
});
const leaf = (id: string, dependencies: readonly string[] = []): CatalogLeafV1 => ({
  leafId: id,
  definitionHash: h(`${id}:definition`),
  requestedDependencyClosure: dependencies,
  implementationClosureRoot: h(`${id}:implementation`),
});

test("dependency and definition roots are sorted and exact", () => {
  const a = capability("a");
  const b = capability("b", ["a"]);
  assert.equal(dependencyLeafDigest(a), dependencyLeafDigest({ ...a, dependencyIds: [] }));
  assert.equal(dependencyCatalogRoot([a, b]), dependencyCatalogRoot([b, a]));
  assert.equal(definitionCatalogRoot([leaf("b"), leaf("a")]), definitionCatalogRoot([leaf("a"), leaf("b")]));
  assert.throws(() => dependencyCatalogRoot([a, a]), /duplicate/);
  assert.throws(() => artifactDependencyRoot(["missing"], [a]), /unknown/);
});

test("adding unrelated family/capability leaves changes aggregate root but preserves reusable leaf", () => {
  const before = [leaf("family:swap", ["swap.quote"]), leaf("family:protocol", ["protocol.identity"])];
  const after = [...before, leaf("family:future-credit", ["credit.position"])];
  const impact = computeCatalogImpact(before, after);
  assert.notEqual(impact.beforeRoot, impact.afterRoot);
  assert.deepEqual(impact.changedLeafIds, ["family:future-credit"]);
  assert.deepEqual(impact.affectedLeafIds, ["family:future-credit"]);
  assert.deepEqual(impact.reusableLeafIds, ["family:protocol", "family:swap"]);
  assert.equal(catalogLeafDigest(before[0]!), catalogLeafDigest(after[0]!));
});

test("declared dependency mutation affects only dependent artifacts", () => {
  const before = [leaf("family:swap", ["swap.quote"]), leaf("family:protocol", ["protocol.identity"])];
  const after = [leaf("family:swap", ["swap.quote", "shared.core"]), before[1]!];
  const impact = computeCatalogImpact(before, after);
  assert.deepEqual(impact.changedLeafIds, ["family:swap"]);
  assert.deepEqual(impact.affectedLeafIds, ["family:swap"]);
  assert.deepEqual(impact.reusableLeafIds, ["family:protocol"]);
});

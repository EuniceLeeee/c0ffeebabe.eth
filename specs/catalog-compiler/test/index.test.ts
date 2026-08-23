import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { decodeCatalogCompilerClosureFacts, sealCatalogCompilerClosureFacts } from "../src/index.ts";

const h = (value: string) => hashDomain("test/catalog-compiler", value);
const fact = () => ({
  modulePath: "families/demo/public.ts",
  exportName: "PUBLIC_ENTRY",
  entrypointId: "families/demo/public.ts#PUBLIC_ENTRY",
  closureDigest: h("closure"),
  programInputSetRoot: h("inputs"),
});
test("compiler facts are exact, immutable, and duplicate bindings fail closed", () => {
  const sealed = sealCatalogCompilerClosureFacts([fact()]);
  assert.deepEqual(decodeCatalogCompilerClosureFacts(sealed), sealed);
  assert.equal(Object.isFrozen(sealed), true);
  assert.throws(() => sealCatalogCompilerClosureFacts([fact(), fact()]), /duplicate/);
  assert.throws(() => decodeCatalogCompilerClosureFacts([{ ...fact(), unknown: true }]), /unknown field/);
  assert.throws(() => decodeCatalogCompilerClosureFacts([{ ...fact(), modulePath: "../escape.ts" }]), /static/);
});

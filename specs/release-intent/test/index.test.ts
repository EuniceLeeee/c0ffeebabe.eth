import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { decodeReleaseIntent, sealReleaseIntent } from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/release-intent", value);
const family = (familyId: string) => ({ familyId, manifestRoot: h(`${familyId}:manifest`), modulePath: `families/${familyId}/public.ts`, exportName: "PUBLIC_ENTRY" });
const strategy = (strategyId: string) => ({ strategyId, manifestRoot: h(`${strategyId}:manifest`), modulePath: `strategies/${strategyId}/public.ts`, exportName: "PUBLIC_ENTRY" });

test("release-intent is an independently sorted exact BOM", () => {
  const first = sealReleaseIntent([family("z-family"), family("a-family")], [strategy("main")]);
  const second = sealReleaseIntent([family("a-family"), family("z-family")], [strategy("main")]);
  assert.equal(first.releaseIntentRoot, second.releaseIntentRoot);
  assert.deepEqual(first.families.map(item => item.familyId), ["a-family", "z-family"]);
  assert.equal(decodeReleaseIntent(first).releaseIntentRoot, first.releaseIntentRoot);
});

test("unknown static paths, duplicate ids, and forged roots fail closed", () => {
  assert.throws(() => sealReleaseIntent([family("a-family"), family("a-family")], []), /duplicate/);
  assert.throws(() => sealReleaseIntent([{ ...family("a-family"), modulePath: "../outside.ts" }], []), /static module path/);
  assert.throws(() => sealReleaseIntent([{ ...family("a-family"), exportName: "not-an-export" }], []), /static export/);
  const sealed = sealReleaseIntent([family("a-family")], []);
  assert.throws(() => decodeReleaseIntent({ ...sealed, releaseIntentRoot: h("forged") }), /root mismatch/);
  assert.throws(() => decodeReleaseIntent({ ...sealed, families: [{ ...sealed.families[0]!, extra: true }] }), /unknown field/);
});

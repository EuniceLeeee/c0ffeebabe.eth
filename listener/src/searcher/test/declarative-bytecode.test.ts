import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { keccak256, MaxUint256 } from "ethers";
import { classifyDeclarativeBytecodeGetter as classify, validateDeclarativeBytecodeGetter as validate } from "../venues/declarative-bytecode.js";
import { classifyUniV3SwapAccess as prior } from "../venues/swaps/univ3-family/swap-access.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/declarative-bytecode.json", import.meta.url), "utf8"));
const definition = fixture.definition;
const cases = fixture.cases as { id: string; expected: "getter" | "absent"; code: string; labels: Record<string, number> }[];
const supported = cases.find(row => row.id === "flat-0")!;
const ordinary = cases.find(row => row.id === "absent")!;
const at = (label: string) => supported.labels[label]!;
const word = (n: number) => n.toString(16).padStart(4, "0");
function patch(code: string, pc: number, bytes: string): string {
  assert.match(bytes, /^(?:[a-f0-9]{2})+$/);
  assert(pc >= 0 && 2 + pc * 2 + bytes.length <= code.length);
  return code.slice(0, 2 + pc * 2) + bytes + code.slice(2 + pc * 2 + bytes.length);
}
for (const row of cases) test(`bytecode proof preserves reachable-dispatch parity: ${row.id}`, () => {
  const result = classify(row.code, definition), old = prior(row.code);
  assert.deepEqual(result, { kind: row.expected, codeHash: keccak256(row.code) });
  assert.equal(old.kind, row.expected === "getter" ? "is-swapper" : "no-is-swapper-getter");
  assert.equal(result.codeHash, old.codeHash);
  assert(Object.isFrozen(result));
});

test("definition supplies selector and storage slot without importing protocol logic", () => {
  const selectorDefinition = { ...definition, signature: undefined, selector: "0xb64230ba" };
  delete selectorDefinition.signature;
  assert.equal(classify(supported.code, selectorDefinition).kind, "getter");
  assert.equal(classify(supported.code, { ...selectorDefinition, selector: "0x00000001" }).kind, "absent");
  // Alter only the verified dispatcher selector in a flat dispatch.
  const renamed = supported.code.replace("63b64230ba", "6312345678");
  assert.equal(classify(renamed, { ...selectorDefinition, selector: "0x12345678" }).kind, "getter");
  assert.equal(classify(renamed, selectorDefinition).kind, "absent");
  const slotOne = patch(supported.code, at("mappingSlot") + 1, "01");
  assert.equal(classify(slotOne, definition).kind, "unsupported");
  assert.equal(classify(slotOne, { ...definition, storageSlot: "1" }).kind, "getter");
  // The leaf is last; changing its literal PUSH width does not relocate any
  // dispatcher, wrapper, argument or return target. The same full leaf matches.
  const slotPc = 2 + at("mappingSlot") * 2;
  const wide = supported.code.slice(0, slotPc) + "610100" + supported.code.slice(slotPc + 4);
  assert.equal(classify(wide, { ...definition, storageSlot: "256" }).kind, "getter");
  assert.equal(classify(wide, { ...definition, storageSlot: "1" }).kind, "unsupported");
});

test("absence requires a complete recognized dispatcher, never a selector substring", () => {
  for (const suffix of [`7f${"00".repeat(8)}b64230ba${"00".repeat(20)}`, "8063b64230ba1461000057", "61ff"]) {
    const code = ordinary.code + suffix;
    assert.equal(classify(code, definition).kind, "absent");
    assert.equal(prior(code).kind, "no-is-swapper-getter");
  }
});

for (const [name, pc, bytes] of [
  ["caller-dependent getter", at("storageRead"), "33"],
  ["state-writing getter", at("storageRead"), "55"],
  ["external-call getter", at("storageRead"), "fa"],
  ["delegatecall proxy", at("storageRead"), "f4"],
  ["callcode proxy", at("storageRead"), "f2"],
  ["undeclared mapping slot", at("mappingSlot") + 1, "01"],
  ["noncanonical bool encoder", at("boolNormalize"), "33"],
  ["selector points to fake getter", at("getterTarget") + 1, word(at("other"))],
  ["selector jumps inside PUSH", at("getterTarget") + 1, word(at("getter") + 2)],
  ["argument check jumps to encoder", at("argumentTarget") + 1, word(at("returned"))],
  ["wrong return continuation", at("returnTarget") + 1, word(at("returned") + 1)],
  ["getter loops into wrapper", at("bodyTarget") + 1, word(at("getter"))],
  ["nonreverting fallback", at("fallbackRevert"), "00"],
  ["unknown dispatcher instruction", at("dispatcher"), "81"],
  ["duplicate selector", at("dispatcher") + 2, "b64230ba"],
] as const) test(`bytecode proof rejects ${name}`, () => {
  const code = patch(supported.code, pc, bytes);
  assert.equal(classify(code, definition).kind, "unsupported");
  assert.equal(prior(code).kind, "unsupported");
});

test("dispatcher rejects cycles and contradictory reachable intervals", () => {
  const tree = cases.find(row => row.id === "getter-high-0")!;
  for (const code of [patch(tree.code, tree.labels.treeTarget! + 1, word(tree.labels.dispatcher!)),
    patch(tree.code, tree.labels.low! + 3, "b64230ba")]) {
    assert.equal(classify(code, definition).kind, "unsupported");
    assert.equal(prior(code).kind, "unsupported");
  }
});

for (const [name, code] of [
  ["empty", "0x"], ["truncated PUSH", "0x61ff"], ["truncated getter leaf", supported.code.slice(0, -4)],
  ["selector literal", "0x63b64230ba00"], ["unreachable selector", "0x008063b64230ba1461000057"],
  ["minimal delegate proxy", `0x363d3d373d3d3d363d73${"11".repeat(20)}5af43d82803e903d91602b57fd5bf3`],
  ["delegation designator", `0xef0100${"11".repeat(20)}`], ["oversized code", `0x${"00".repeat(24_577)}`],
] as const) test(`bytecode profile is fail closed for ${name}`, () => {
  assert.equal(classify(code, definition).kind, "unsupported");
  assert.equal(prior(code).kind, "unsupported");
});

test("invalid code and executable, ambiguous or unsupported definitions are rejected", () => {
  for (const code of ["6000", "0x600", "0xzz"]) assert.throws(() => classify(code, definition), /invalid runtime bytecode/);
  for (const raw of [null, [], {}, { ...definition, version: 2 }, { ...definition, compilerProfile: "arbitrary" },
    { ...definition, storageSlot: -1 }, { ...definition, storageSlot: "01" }, { ...definition, storageSlot: "-1" },
    { ...definition, storageSlot: (MaxUint256 + 1n).toString() }, { ...definition, selector: "0xb64230ba" },
    { ...definition, signature: "function f(uint256) view returns(bool)" },
    { ...definition, signature: "function f(address) view returns(uint256)" },
    { ...definition, signature: "function f(address) returns(bool)" },
    { ...definition, handler: "arbitrary" }, Object.defineProperty({ ...definition }, "signature", { get() { throw Error("must not read accessor"); } })]) {
    assert.throws(() => validate(raw));
  }
});

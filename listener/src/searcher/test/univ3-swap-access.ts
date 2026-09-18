import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { familyId, instanceKey, lineageId } from "../venues/adapter-family-identifiers.js";
import type { AdapterRequestResult, CanonicalSource } from "../venues/adapter-request-program.js";
import {
  assertUniV3SwapAccess,
  classifyUniV3SwapAccess,
  UNIV3_SWAPPER_INTERFACE,
  uniV3SwapAccessRequest,
} from "../venues/swaps/univ3-family/swap-access.js";
import type { UniV3Descriptor } from "../venues/swaps/univ3-family/types.js";

// Tiny synthetic runtimes only: no deployed bytecode, saved logs, RPC, or pool
// identity is needed. Labels keep relocation and invalid-jump tests explicit.
function assemble(assembly: string) {
  const bytes: number[] = [];
  const labels = new Map<string, number>();
  const references: { offset: number; label: string }[] = [];
  for (const token of assembly.trim().split(/\s+/)) {
    if (token.endsWith(":")) {
      const label = token.slice(0, -1);
      assert(!labels.has(label), `duplicate fixture label ${label}`);
      labels.set(label, bytes.length);
    } else if (token.startsWith("@")) {
      bytes.push(0x61, 0, 0); // PUSH2 label
      references.push({ offset: bytes.length - 2, label: token.slice(1) });
    } else {
      assert.match(token, /^(?:[0-9a-f]{2})+$/i);
      bytes.push(...ethers.getBytes(`0x${token}`));
    }
  }
  for (const { offset, label } of references) {
    const pc = labels.get(label);
    assert(pc !== undefined && pc < 0x1_0000, `unresolved fixture label ${label}`);
    bytes[offset] = pc >> 8;
    bytes[offset + 1] = pc & 255;
  }
  return { code: ethers.hexlify(Uint8Array.from(bytes)), labels };
}

function fixture(options: {
  getter?: boolean;
  tree?: "flat" | "getter-low" | "getter-high";
  padding?: number;
} = {}) {
  const getter = options.getter ?? true;
  const getterBranch = getter ? "80 63b64230ba 14 getterTarget: @getter 57" : "";
  const otherBranch = "80 63128acb08 14 @other 57";
  const tree = options.tree ?? "flat";
  const dispatch = tree === "flat"
    ? `${otherBranch} ${getterBranch} @fallback 56`
    : tree === "getter-high"
      ? `80 6380000000 11 treeTarget: @low 57 ${getterBranch} @fallback 56
         low: 5b ${otherBranch} @fallback 56`
      : `80 63c0000000 11 treeTarget: @low 57 80 63eeeeeeee 14 @other 57 @fallback 56
         low: 5b ${otherBranch} ${getterBranch} @fallback 56`;
  return assemble(`
    6080 6040 52 34 80 15 @nonpayable 57 6000 80 fd
    nonpayable: 5b 50 6004 36 10 @fallback 57 6000 35 60e0 1c
    dispatcher: ${dispatch}
    fallback: 5b 6000 80 fallbackRevert: fd
    other: 5b 6000 80 fd
    ${getter ? `
      getter: 5b returnTarget: @returned 6004 80 36 03 6020 81 10 15
      argumentTarget: @argument 57 6000 80 fd
      argument: 5b 50 35 6001 6001 60a0 1b 03 16 bodyTarget: @body 56
      returned: 5b 6040 80 51 91 boolNormalize: 15 15 82 52 51 90 81 90 03 6020 01 90 f3
      ${"00 ".repeat(options.padding ?? 0)}
      body: 5b mappingSlot: 6000 6020 81 90 52 90 81 52 6040 90 20
      storageRead: 54 60ff 16 81 56
    ` : ""}
  `);
}

function patch(code: string, pc: number, replacement: string): string {
  assert.match(replacement, /^(?:[0-9a-f]{2})+$/i);
  assert(pc >= 0 && 2 + pc * 2 + replacement.length <= code.length);
  return code.slice(0, 2 + pc * 2) + replacement + code.slice(2 + pc * 2 + replacement.length);
}

const SUPPORTED = fixture();
const ORDINARY = fixture({ getter: false });
const SOURCE: CanonicalSource = { number: 100, hash: `0x${"ab".repeat(32)}`, generation: 7 };
const address = (byte: string) => ethers.getAddress(`0x${byte.repeat(20)}`);
const DESCRIPTOR: UniV3Descriptor = {
  familyId: familyId("univ3-standard"),
  lineageId: lineageId("univ3:factory-child"),
  instanceKey: instanceKey(address("11")),
  provenance: [],
  runtimeRequirements: [],
  pool: address("11"),
  token0: address("22"),
  token1: address("33"),
  fee: 500n,
  tickSpacing: 10,
  factoryBinding: { factory: address("44"), reversePool: address("11") },
  quoterBinding: { quoter: null, router: null, provenance: "unavailable" },
  swapAccess: classifyUniV3SwapAccess(SUPPORTED.code),
};
const INPUT = { descriptor: DESCRIPTOR, executor: address("aa"), source: SOURCE };
type SuccessfulResult = Extract<AdapterRequestResult, { ok: true }>;
const TRUE_WORD = `0x${"0".repeat(63)}1`;
const FALSE_WORD = `0x${"0".repeat(64)}`;
function returned(overrides: Partial<SuccessfulResult> = {}): SuccessfulResult {
  return {
    id: uniV3SwapAccessRequest(INPUT)!.id,
    ok: true,
    source: SOURCE,
    provenance: { kind: "fixture", fingerprint: "synthetic-swap-access" },
    completion: "returned",
    data: TRUE_WORD,
    ...overrides,
  };
}

for (const tree of ["flat", "getter-low", "getter-high"] as const) {
  for (const padding of [0, 256]) {
    test(`classifier recognizes reachable getter: ${tree}, relocated by ${padding}`, () => {
      const { code } = fixture({ tree, padding });
      const access = classifyUniV3SwapAccess(code);
      assert.deepEqual(access, { kind: "is-swapper", codeHash: ethers.keccak256(code) });
      assert(Object.isFrozen(access));
    });
  }
}

test("ordinary dispatcher proves getter absence, including fake selector in PUSH data/dead code", () => {
  const data = `7f${"00".repeat(8)}b64230ba${"00".repeat(20)}`;
  const deadSelector = "8063b64230ba1461000057";
  for (const code of [ORDINARY.code, ORDINARY.code + data, ORDINARY.code + deadSelector]) {
    assert.deepEqual(classifyUniV3SwapAccess(code), {
      kind: "no-is-swapper-getter", codeHash: ethers.keccak256(code),
    });
  }
});

for (const [name, code] of [
  ["empty", "0x"],
  ["truncated PUSH", "0x61ff"],
  ["selector literal without dispatcher", "0x63b64230ba00"],
  ["unreachable selector without dispatcher", "0x008063b64230ba1461000057"],
  ["minimal delegate proxy", `0x363d3d373d3d3d363d73${"11".repeat(20)}5af43d82803e903d91602b57fd5bf3`],
  ["delegation designator", `0xef0100${"11".repeat(20)}`],
  ["oversized runtime", `0x${"00".repeat(24_577)}`],
] as const) {
  test(`classifier rejects ${name}`, () => {
    assert.equal(classifyUniV3SwapAccess(code).kind, "unsupported");
  });
}

for (const code of ["6000", "0x600", "0xzz"]) {
  test(`classifier rejects malformed hex ${code}`, () => {
    assert.throws(() => classifyUniV3SwapAccess(code), /invalid runtime bytecode/);
  });
}

const at = (label: string) => {
  const pc = SUPPORTED.labels.get(label);
  assert(pc !== undefined, label);
  return pc;
};
const word = (pc: number) => pc.toString(16).padStart(4, "0");
for (const [name, pc, bytes] of [
  ["caller-dependent getter", at("storageRead"), "33"],
  ["state-writing getter", at("storageRead"), "55"],
  ["external-call getter", at("storageRead"), "fa"],
  ["delegatecall proxy", at("storageRead"), "f4"],
  ["callcode proxy", at("storageRead"), "f2"],
  ["unknown mapping shape", at("mappingSlot") + 1, "01"],
  ["noncanonical bool encoder", at("boolNormalize"), "33"],
  ["selector points to fake getter", at("getterTarget") + 1, word(at("other"))],
  ["selector jumps inside PUSH", at("getterTarget") + 1, word(at("getter") + 2)],
  ["argument check jumps to encoder", at("argumentTarget") + 1, word(at("returned"))],
  ["wrong return continuation", at("returnTarget") + 1, word(at("returned") + 1)],
  ["getter loops into wrapper", at("bodyTarget") + 1, word(at("getter"))],
  ["nonreverting fallback", at("fallbackRevert"), "00"],
  ["unknown dispatcher instruction", at("dispatcher"), "81"],
  ["duplicate selector", at("dispatcher") + 2, "b64230ba"],
] as const) {
  test(`classifier fails closed for ${name}`, () => {
    assert.equal(classifyUniV3SwapAccess(patch(SUPPORTED.code, pc, bytes)).kind, "unsupported");
  });
}

test("dispatcher rejects cycles and selectors outside their reachable interval", () => {
  const { code, labels } = fixture({ tree: "getter-high" });
  const cycle = patch(code, labels.get("treeTarget")! + 1, word(labels.get("dispatcher")!));
  const impossibleSelector = patch(code, labels.get("low")! + 3, "b64230ba");
  assert.equal(classifyUniV3SwapAccess(cycle).kind, "unsupported");
  assert.equal(classifyUniV3SwapAccess(impossibleSelector).kind, "unsupported");
});

test("request calls the pool getter for the actual executor, without a caller", () => {
  const request = uniV3SwapAccessRequest(INPUT);
  assert(request !== null);
  assert.equal(UNIV3_SWAPPER_INTERFACE.getFunction("isSwapper")!.selector, "0xb64230ba");
  assert.equal(request.to, DESCRIPTOR.pool);
  assert.equal(request.kind, "eth-call");
  assert.equal(request.completion, "return-data");
  assert.equal("caller" in request, false);
  assert.notEqual(request.required, false);
  assert.equal(UNIV3_SWAPPER_INTERFACE.decodeFunctionData("isSwapper", request.data)[0], INPUT.executor);
  assert(Object.isFrozen(request));
  assert.deepEqual(uniV3SwapAccessRequest(INPUT), request);
});

for (const [name, source] of [
  ["block number", { ...SOURCE, number: SOURCE.number + 1 }],
  ["block hash", { ...SOURCE, hash: `0x${"cd".repeat(32)}` }],
  ["generation", { ...SOURCE, generation: SOURCE.generation + 1 }],
] as const) {
  test(`request and result bind ${name} independently`, () => {
    const changed = { ...INPUT, source };
    assert.notEqual(uniV3SwapAccessRequest(changed)!.id, uniV3SwapAccessRequest(INPUT)!.id);
    assert.throws(() => assertUniV3SwapAccess(INPUT, [returned({ source })]), /foreign source/);
    assert.throws(() => assertUniV3SwapAccess(changed, [returned()]), /missing or duplicate/);
  });
}

test("request/result bind executor and pool; address/hash casing is canonical", () => {
  const request = uniV3SwapAccessRequest(INPUT)!;
  for (const changed of [
    { ...INPUT, executor: address("bb") },
    { ...INPUT, descriptor: { ...DESCRIPTOR, pool: address("cc") } },
  ]) {
    assert.notEqual(uniV3SwapAccessRequest(changed)!.id, request.id);
    assert.throws(() => assertUniV3SwapAccess(changed, [returned()]), /missing or duplicate/);
  }
  const source = { ...SOURCE, hash: `0x${"AB".repeat(32)}` };
  assert.deepEqual(uniV3SwapAccessRequest({ ...INPUT, source, executor: INPUT.executor.toLowerCase() }), request);
  assert.doesNotThrow(() => assertUniV3SwapAccess(INPUT, [returned({ source })]));
});

test("known absence skips the getter; unsupported or missing metadata never skips", () => {
  const absent = { ...INPUT, descriptor: { ...DESCRIPTOR, swapAccess: classifyUniV3SwapAccess(ORDINARY.code) } };
  assert.equal(uniV3SwapAccessRequest(absent), null);
  assert.doesNotThrow(() => assertUniV3SwapAccess(absent, []));
  const { swapAccess: _omitted, ...legacyDescriptor } = DESCRIPTOR;
  for (const descriptor of [
    { ...DESCRIPTOR, swapAccess: classifyUniV3SwapAccess("0x") },
    legacyDescriptor as UniV3Descriptor, // Exercise an old persisted descriptor at the boundary.
  ]) {
    assert.throws(() => uniV3SwapAccessRequest({ ...INPUT, descriptor }), /unsupported swap access/);
    assert.throws(() => assertUniV3SwapAccess({ ...INPUT, descriptor }, [returned()]), /unsupported swap access/);
  }
});

test("helper requires exactly one matching result and explicit canonical true", () => {
  const result = returned();
  assert.doesNotThrow(() => assertUniV3SwapAccess(INPUT, [result]));
  assert.doesNotThrow(() => assertUniV3SwapAccess(INPUT, [{ ...result, id: "tick-state" }, result]));
  for (const results of [[], [result, result], [{ ...result, id: "foreign-request" }]]) {
    assert.throws(() => assertUniV3SwapAccess(INPUT, results), /missing or duplicate/);
  }
  assert.throws(() => assertUniV3SwapAccess(INPUT, [returned({ data: FALSE_WORD })]), {
    message: "univ3 executor is not an allowed swapper",
  });
});

for (const data of ["0x", "0x01", `0x${"0".repeat(63)}2`, `0x${"ff".repeat(32)}`, TRUE_WORD + "00", TRUE_WORD.slice(2)]) {
  test(`helper rejects malformed boolean of length ${data.length}: ${data.slice(-4)}`, () => {
    assert.throws(() => assertUniV3SwapAccess(INPUT, [returned({ data })]), /malformed swap access result/);
  });
}

test("failed/reverted getter is never interpreted as absence or permission", () => {
  for (const failure of ["rpc", "deadline", "aborted", "resource-limited"] as const) {
    assert.throws(() => assertUniV3SwapAccess(INPUT, [{
      id: returned().id, source: SOURCE, ok: false, failure,
    }]), /swap access request failed/);
  }
  for (const data of ["0x", TRUE_WORD]) {
    assert.throws(() => assertUniV3SwapAccess(INPUT, [returned({ completion: "reverted-as-declared", data })]), /malformed/);
  }
});

test("request rejects malformed source and executor/pool addresses", () => {
  for (const source of [
    { ...SOURCE, number: -1 }, { ...SOURCE, number: 1.5 },
    { ...SOURCE, generation: -1 }, { ...SOURCE, generation: NaN },
    { ...SOURCE, hash: "0x12" },
  ]) assert.throws(() => uniV3SwapAccessRequest({ ...INPUT, source }), /invalid swap access source/);
  assert.throws(() => uniV3SwapAccessRequest({ ...INPUT, executor: "0x12" }));
  assert.throws(() => uniV3SwapAccessRequest({ ...INPUT, descriptor: { ...DESCRIPTOR, pool: "0x12" } }));
});

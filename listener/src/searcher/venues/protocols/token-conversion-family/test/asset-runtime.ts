import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { keccak256, TypedDataEncoder, zeroPadValue } from "ethers";
import { proveConversionAssetRuntime } from "../asset-runtime.js";
import { proveLocalAssetRuntime } from "../variants.js";
import { identity } from "../identity.js";
import { ABI } from "../variants.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";

const directory = process.env.TOKEN_CONVERSION_ASSET_EVIDENCE;
assert(directory, "TOKEN_CONVERSION_ASSET_EVIDENCE must name saved source/compiler evidence");
const html = readFileSync(join(directory, "asset-etherscan.html"), "utf8");
const code = html.slice(html.indexOf("Deployed Bytecode</h6>")).match(/<div>(0x[0-9a-fA-F]+)<\/div>/)![1]!;
const raw = readFileSync(join(directory, "compiler-output.json"), "utf8");
const compiled = JSON.parse(raw.slice(raw.indexOf("{")));
const bytecode = compiled.contracts["src/BTBFinance.sol"].BTBFinance.evm.deployedBytecode;
const asset = "0x88888888c90cd71b35830dabfd24743dbc135b51";
const other = "0x0000000000000000000000000000000000000017";
function patch(runtime: string, start: number, value: string): string {
  return runtime.slice(0, 2 + start * 2) + value.slice(2).toLowerCase() + runtime.slice(2 + (start + 32) * 2);
}

test("verified source compiler output equals every nonimmutable runtime byte, including metadata", () => {
  assert(!compiled.errors?.some((e: { severity: string }) => e.severity === "error"));
  const refs = Object.values(bytecode.immutableReferences).flat() as { start: number; length: number }[];
  assert.deepEqual(refs.map(r => r.start).sort((a, b) => a - b), [2457, 2499, 2541, 2622, 2662, 3082, 3127]);
  let normalized = code;
  for (const r of refs) { assert.equal(r.length, 32); normalized = patch(normalized, r.start, zeroPadValue("0x00", 32)); }
  assert.equal(normalized, `0x${bytecode.object}`);
  assert.equal(keccak256(normalized), "0x581d62bab0a23c4cd262927b8fb4e6985f11192c7c357017d60d951b674f2215");
  assert.throws(() => proveLocalAssetRuntime(code), /opcode 0x46/);
  assert.equal(proveConversionAssetRuntime(code, asset), keccak256(code));
});

test("asset proof binds constructor operands, not a deployment address allowlist", () => {
  assert.throws(() => proveConversionAssetRuntime(code, other), /immutable binding/);
  let relocated = patch(code, 2457, zeroPadValue(other, 32));
  relocated = patch(relocated, 2541, TypedDataEncoder.hashDomain({ name: "BTB Finance", version: "1", chainId: 1, verifyingContract: other }));
  assert.equal(proveConversionAssetRuntime(relocated, other), keccak256(relocated));
  for (const offset of [2457, 2499, 2541, 2622, 2662, 3082, 3127]) {
    assert.throws(() => proveConversionAssetRuntime(patch(code, offset, zeroPadValue("0xff", 32)), asset), /immutable binding/);
  }
});

test("nonimmutable code, metadata and PUSH changes cannot borrow the proof", () => {
  for (const offset of [0, 260, 1674, 1867, 2456, 2753, 2858, 3279, 4363, 5937]) {
    const start = 2 + offset * 2;
    const changed = code.slice(0, start) + (code.slice(start, start + 2) === "ff" ? "00" : "ff") + code.slice(start + 2);
    assert.throws(() => proveConversionAssetRuntime(changed, asset), /closure unproven/);
  }
  for (const bad of ["0x6000f1", "0x6000f4", "0x600042", "0x600046", code + "00", code.slice(0, -2)])
    assert.throws(() => proveConversionAssetRuntime(bad, asset), /closure unproven/);
  assert.equal(proveConversionAssetRuntime("0x604360fa00", asset), keccak256("0x604360fa00"));
});

test("production identity still requires getter/backing/active execution after the asset code proof", () => {
  const target = "0x88888880d5ca13018d2dc11e2e4744bd91a5656f";
  const source = { number: 26029369, hash: `0x${"51".repeat(32)}`, generation: 1 };
  const returned = (id: string, data: string): AdapterRequestResult => ({ id, data, ok: true, completion: "returned", source,
    provenance: { kind: "offline-fixture", fingerprint: "fixture" } });
  const step = { candidate: { candidateKind: "token-conversion" as const, target }, step: 1,
    evidence: { phase: "code", asset, codeHash: keccak256("0x00") } };
  const results = [returned("identity-asset-code", code), returned("identity-asset", ABI.encodeFunctionResult("BTB_TOKEN", [asset])),
    returned("identity-supply", ABI.encodeFunctionResult("totalSupply", [10n ** 22n])),
    returned("identity-backing", ABI.encodeFunctionResult("balanceOf", [10n ** 22n]))];
  const evidence = identity.variants[0].decode({ step, results });
  assert.equal(identity.variants[0].decide({ ...step, evidence }).status, "continue");
  assert.equal(identity.variants[0].buildRequests({ ...step, evidence }).length, 2);
  assert.throws(() => identity.variants[0].decode({ step, results: results.map(r => r.id === "identity-asset" ?
    returned(r.id, ABI.encodeFunctionResult("BTB_TOKEN", [other])) : r) }), /getter\/code mismatch/);
});

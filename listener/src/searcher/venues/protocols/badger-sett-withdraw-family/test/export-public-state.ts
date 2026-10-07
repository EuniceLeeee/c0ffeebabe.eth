// Offline, explicit extraction only. Never copies request/response envelopes,
// endpoint URLs or arbitrary archive fields; no network fallback exists.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { CODE, VAULT, STRATEGY, TOKEN, LOCKER } from "../codec.js";

// Existing retained-source commitments, unchanged from the original test.
export const ARCHIVE_SHA256 = {
  "design.txt": "48f898f489d0d76444939e3e2729ef84ae493783742b4b39247be78b5a5a9f18",
  "provenance.json": "65e6e4ae8a1542d8a1cf17f823ce8c7579f93a6acb4a2650f2324d0a6a1fe979",
  "0xba485b556399123261a5f9c95d413b4f93107407.source-0.sol": "3df03e3cd1f1e97ce0d870facf42606bc0670b83e0f1bbc6ee4f181496bdca36",
  "0x60c796acb2e0949178086294f03a44c450511784.source-0.sol": "73d9fc5f0c1a7c1f23d22f8a6788fdf899606958906047e2da7ba7a06e93ed4e",
  "0x7c2a951d062cc7b7c6f9c7aa7e80a6f20eaa8cab.source-0.sol": "09db2e6af321627f6a1fd596517336d7f1a522bdaf4a8de9fd4a5dbafa8cecc9",
  "0xc0c293ce456ff0ed870add98a0828dd4d2903dbf.source-0.sol": "a409d03cdbd50063e5d52dc79ee8040007f1e8faf7956dd2acdada89e5345c47",
  "0x3fa73f1e5d8a792c80f426fc8f84fbf7ce9bbcac.source-0.sol": "4a9e11d25f8a9297c1764cb0072affebfd34a0e38c9c5137a50e0150bf068d3a",
} as const;
export const RUNTIME_FILES = {
  proxy: "rpc-003-wrapper-code.json", vault: "rpc-004-impl-code.json",
  strategy: "rpc-006-strategyImpl-code.json", asset: "rpc-035-token-code.json", locker: "rpc-034-locker-code.json",
} as const;
export const RESULT_FILES = [
  "rpc-013-vault-totalSupply.json", "rpc-015-vault-getPricePerFullShare.json",
  "rpc-016-vault-withdrawalFee.json", "rpc-021-vault-treasury.json",
  "rpc-031-token-balance-wrapper.json", "rpc-032-token-balance-strategy.json", "rpc-042-locker-balances.json",
] as const;
export const ABI_SELECTIONS = [
  ["0x60c796acb2e0949178086294f03a44c450511784.abi.json", VAULT],
  ["0x7c2a951d062cc7b7c6f9c7aa7e80a6f20eaa8cab.abi.json", STRATEGY],
  ["0xc0c293ce456ff0ed870add98a0828dd4d2903dbf.abi.json", TOKEN],
  ["0x3fa73f1e5d8a792c80f426fc8f84fbf7ce9bbcac.abi.json", LOCKER],
] as const;
export interface PublicState {
  format: "badger-sett-public-state-v1";
  source: { number: number; hash: string };
  archiveSha256: Record<string, string>;
  runtimeKeccak256: Record<keyof typeof CODE, string>;
  runtimes: Record<keyof typeof CODE, string>;
  rpcResults: Record<string, string>;
  abis: Record<string, readonly string[]>;
}
export function extractPublicState(directory: string): PublicState {
  assert(directory.trim(), "BADGER_SETT_PREFLIGHT must explicitly name the retained archive");
  const bytes = (file: string) => readFileSync(resolve(directory, file));
  const json = (file: string) => JSON.parse(bytes(file).toString("utf8"));
  const sha256 = (file: string) => createHash("sha256").update(bytes(file)).digest("hex");
  const hex = (file: string): string => {
    const result: unknown = json(file).response?.result;
    assert(typeof result === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(result), "invalid public hex result " + file);
    return result;
  };
  const archiveSha256: Record<string, string> = {};
  for (const [file, expected] of Object.entries(ARCHIVE_SHA256)) {
    archiveSha256[file] = sha256(file); assert.equal(archiveSha256[file], expected, file);
  }
  const state = json("state-01.json");
  const source = { number: state.blockNumber as number, hash: state.block.hash as string };
  assert.deepEqual(source, { number: 26138511, hash: "0xffdbdda6829f743dc05ad148586e96dc671f31ee30968f07d91963b9de22e771" });
  const runtimes = Object.fromEntries(Object.entries(RUNTIME_FILES).map(([kind, file]) => [kind, hex(file)])) as PublicState["runtimes"];
  for (const kind of Object.keys(CODE) as (keyof typeof CODE)[]) assert.equal(ethers.keccak256(runtimes[kind]), CODE[kind], kind);
  assert.equal(hex("rpc-005-strategy-code.json"), runtimes.proxy, "both deployed proxies have the same runtime");
  const rpcResults = Object.fromEntries(RESULT_FILES.map(file => {
    const result = hex(file);
    assert(ethers.isHexString(result, file === "rpc-042-locker-balances.json" ? 64 : 32), "invalid ABI result length " + file);
    return [file, result];
  }));
  const abis: PublicState["abis"] = {};
  for (const [file, declared] of ABI_SELECTIONS) {
    archiveSha256[file] = sha256(file);
    const verified = new ethers.Interface(json(file));
    abis[file] = declared.fragments.filter(f => f.type === "function").map(f => {
      const selector = declared.getFunction(f.format("sighash"))!.selector;
      const actual = verified.getFunction(selector); assert(actual, "missing public ABI function " + selector);
      // Extract the verified fragment, not our declared fragment: return types
      // and mutability remain independent inputs to the existing contract test.
      return actual.format("full");
    });
  }
  return { format: "badger-sett-public-state-v1", source, archiveSha256, runtimeKeccak256: { ...CODE }, runtimes, rpcResults, abis };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.env.BADGER_SETT_PREFLIGHT;
  assert(directory !== undefined, "set BADGER_SETT_PREFLIGHT explicitly; no default archive or network fallback");
  const output = JSON.stringify(extractPublicState(directory), null, 2) + "\n";
  writeFileSync(new URL("./public-state.json", import.meta.url), output);
  console.log(JSON.stringify({ file: "public-state.json", bytes: Buffer.byteLength(output), sha256: createHash("sha256").update(output).digest("hex") }));
}

// Explicit offline evidence verifier, no RPC. Registration and decimals below
// are SYNTHETIC controls; this cannot issue historical strict admission.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/ekubo.production.js";
import { EKUBO_CORE, EKUBO_ROUTER } from "../../ekubo/abi.js";
import { candidate, decodeMultihopCall } from "../codec.js";
import { validateExtensionProof, EKUBO_SUPPORTED_CORE_HASH, EKUBO_SUPPORTED_ROUTER_HASH, EKUBO_SUPPORTED_TWAMM_HASH } from "../extension.js";
import { result, word } from "./fixtures.js";

const [readsFile, proofFile, rawFile] = process.argv.slice(2);
assert(readsFile && proofFile && rawFile, "usage: cached-source-proof.ts rpc-usage.json compile-proof.json raw-tx.json");
const reads = JSON.parse(readFileSync(readsFile, "utf8"));
const proof = JSON.parse(readFileSync(proofFile, "utf8"));
const raw = JSON.parse(readFileSync(rawFile, "utf8"));
const source = { number: Number(raw.receipt.blockNumber), hash: raw.receipt.blockHash, generation: Number(raw.receipt.blockNumber) };
assert.equal(source.number, 26029876);
assert.equal(raw.receipt.status, "0x1");
const codes = Object.fromEntries(reads.results.filter((r: any) => r.method === "eth_getCode").map((r: any) => [r.label, r.result]));
for (const contract of proof.contracts) {
  assert.equal(contract.compiledRuntimeMatches, true);
  assert.equal(contract.pageRuntimeMatches, true);
  assert.equal(ethers.keccak256(codes[contract.label + "-code"]), contract.codeHash);
  for (const immutable of contract.immutables) for (const ref of immutable.refs) {
    const address = ethers.getAddress("0x" + ref.value.slice(-40)).toLowerCase();
    assert(address === EKUBO_CORE || (contract.label === "router" && address === "0x5555ff9ff2757500bf4ee020dcfd0210cffa41be"));
  }
}
assert.equal(validateExtensionProof(EKUBO_SUPPORTED_CORE_HASH, EKUBO_SUPPORTED_ROUTER_HASH, codes["extension-code"], word(1n)), EKUBO_SUPPORTED_TWAMM_HASH);
for (const registration of [word(0n), word(2n), "0x"]) assert.throws(() =>
  validateExtensionProof(EKUBO_SUPPORTED_CORE_HASH, EKUBO_SUPPORTED_ROUTER_HASH, codes["extension-code"], registration));
assert.throws(() => validateExtensionProof(ethers.ZeroHash, EKUBO_SUPPORTED_ROUTER_HASH, codes["extension-code"], word(1n)));
assert.throws(() => validateExtensionProof(EKUBO_SUPPORTED_CORE_HASH, ethers.ZeroHash, codes["extension-code"], word(1n)));
assert.throws(() => validateExtensionProof(EKUBO_SUPPORTED_CORE_HASH, EKUBO_SUPPORTED_ROUTER_HASH, codes["extension-code"] + "00", word(1n)));
const queue = [raw.trace]; let found: ReturnType<typeof decodeMultihopCall> = null;
while (queue.length) {
  const frame = queue.pop(); if (frame.error) continue;
  if (frame.type === "CALL" && frame.to.toLowerCase() === EKUBO_ROUTER && frame.input.startsWith("0x6d0cb613")) {
    assert.equal(found, null);
    found = decodeMultihopCall({ kind: "call", source, target: frame.to, data: frame.input });
  }
  queue.push(...(frame.calls ?? []));
}
assert.equal(found?.length, 2);
const variant = plugin.identity.variants[0];
const c = candidate(found![0].poolKey);
const initial = { candidate: c, step: 0 };
const structure = variant.buildRequests(initial).map(r => result(r.id,
  r.kind === "get-code" ? codes[r.id] : r.kind === "get-storage" ? word(1n) : word(r.id === "decimals:0" ? 18n : 6n), source));
const evidence = variant.decode({ step: initial, results: structure });
const next = { candidate: c, step: 1, evidence };
const quotes = variant.buildRequests(next).map(request => {
  assert(request.kind === "eth-call");
  const cached = reads.results.find((r: any) => r.method === "eth_call" && r.params[0].data === request.data);
  assert(cached, "identity quote bytes must be cached at the exact requested amount");
  assert.equal(Number(BigInt(cached.params[1])), source.number);
  return result(request.id, cached.result, source);
});
const quoted = variant.decode({ step: next, results: quotes });
assert.equal(variant.decide({ ...next, step: 2, evidence: quoted }).status, "verified");
const rejected = variant.decode({ step: initial, results: structure.map(r => r.id === "extension-registration" ? result(r.id, word(0n), source) : r) });
assert.equal(variant.decide({ ...next, evidence: rejected }).status, "chain-proven-rejected");
assert.throws(() => variant.decode({ step: initial, results: structure.map(r => ({ ...r, source: r.id === "extension-code" ? { ...source, hash: word(2n) } : source })) }));
console.log(JSON.stringify({ status: "offline-source-and-identity-controls-pass", poolIds: found!.map(c => c.poolId),
  compiler: proof.compiler, runtimeMatches: proof.contracts.length, cachedNQuotes: quotes.length,
  registrationAndDecimals: "synthetic, NOT historical strict", rpcRequests: 0 }));

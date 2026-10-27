import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";

const erc4626Identity = erc4626Plugin.identity;
const erc4626Discovery = erc4626Plugin.discovery;

const vault = ethers.getAddress("0x1111111111111111111111111111111111111111");
const asset = ethers.getAddress("0x2222222222222222222222222222222222222222");
const source = { number: 25778225, hash: "0x" + "ab".repeat(32), generation: 1 };
const candidate = { candidateKind: "erc4626-vault", vault };
const base = { phase: "base", vault, vaultCodeHash: ethers.keccak256("0x6001"), asset,
  assetCodeHash: ethers.keccak256("0x6002"), totalAssets: 2000n, totalSupply: 1000n,
  sampleAssets: 1000n, sampleShares: 500n, previewDeposit: 500n, previewRedeem: 1000n, baseValid: true };
const variant = erc4626Identity.variants[0]!;
export const stageSteps = [
  { candidate, step: 0 },
  { candidate, step: 1, evidence: base },
  ...[undefined, false, true].map(matched => ({ candidate, step: 2, evidence: { ...base,
    stakedUsdatCheck: { source, proxyCodeHash: base.vaultCodeHash,
      ...(matched === undefined ? {} : { implementation: asset, implementationMatched: matched }) } } })),
  { candidate, step: 2, evidence: { ...base, custodianCheck: "slot", custodianCheckSource: source } },
  { candidate, step: 3, evidence: { ...base, custodianCheck: "code", custodianCheckSource: source, custodianImplementation: asset } },
  { candidate, step: 2, evidence: { ...base, phase: "active", erc20SurfacesValid: true,
    depositRetry: { amount: 10n, preview: 5n, source } } },
];

test("ERC4626 declares each dependent round with unchanged transport and caller requirements", () => {
  const expected = [ ["get-code", "eth-call"], ["get-code", "eth-call", "effect-delta-simulation"],
    ["get-storage"], ["get-code"], ["get-code", "eth-call"], ["get-storage"], ["get-code"],
    ["eth-call", "effect-delta-simulation"] ];
  stageSteps.forEach((step, i) => {
    assert.deepEqual(variant.requirements(step).transports, expected[i]);
    const requests = variant.buildRequests(step);
    assert(requests.length > 0); assert.equal(new Set(requests.map(r => r.id)).size, requests.length);
    if (i === 1 || i === 7) assert.equal(variant.requirements(step).caller, "verified-actor");
  });
  assert.deepEqual(variant.buildRequests(stageSteps[7]!).map(r => r.id), ["fallback-roundtrip", "fallback-deposit"]);
});

test("malformed or conflicting stages cannot silently become active proof", () => {
  for (const evidence of [ { ...base, phase: "unknown" },
    { ...base, depositRetry: { amount: 1n, preview: 1n, source } },
    { ...base, custodianCheck: "unknown" },
    { ...base, stakedUsdatCheck: { source, implementationMatched: true } },
    { ...base, custodianCheck: "slot", stakedUsdatCheck: { source } } ]) {
    const step = { candidate, step: 2, evidence };
    assert.throws(() => variant.requirements(step));
    assert.throws(() => variant.buildRequests(step));
    assert.throws(() => variant.decode({ step, results: [] }));
  }
});

import { compileAddressDiscovery } from "../venues/address-discovery.js";

import { plugin as erc4626Plugin } from "../venues/production-families/erc4626.production.js";


test("address discovery uses declared selectors, topics and surfaces without admitting an identity", () => {
  const observations = [
    { kind: "call" as const, source, target: vault, data: "0x" },
    { kind: "log" as const, source, address: vault, topics: [], data: "0x" },
    { kind: "address-surface" as const, source, address: vault, codeHash: base.vaultCodeHash },
  ];
  const patterns = [erc4626Discovery.callPatterns!, erc4626Discovery.logPatterns!, erc4626Discovery.addressSurfaces!];
  observations.forEach((observation, i) => {
    for (const pattern of patterns[i]!) {
      assert.deepEqual(erc4626Discovery.decodeCandidate({ observation, matchedPatternId: pattern.id }), candidate);
      assert.equal(erc4626Discovery.decodeCandidate({ observation: observations[(i + 1) % 3]!, matchedPatternId: pattern.id }), null);
    }
    assert.equal(erc4626Discovery.decodeCandidate({ observation, matchedPatternId: "undeclared" }), null);
  });
  assert.equal(erc4626Discovery.decodeCandidate({ observation: { ...observations[0]!, kind: "call", target: "bad-address", data: "0x" }, matchedPatternId: erc4626Discovery.callPatterns![0]!.id }), null);
  assert.throws(() => compileAddressDiscovery({ ...erc4626Discovery, candidate: (vault: string) => ({ candidateKind: "erc4626-vault", vault }),
    callPatterns: [{ ...erc4626Discovery.callPatterns![0]!, candidateAddress: { from: "argument", index: 0 } }],
  }), /call-target projection/);
  assert.throws(() => compileAddressDiscovery({ ...erc4626Discovery, candidate: (vault: string) => ({ candidateKind: "erc4626-vault", vault }),
    logPatterns: [{ ...erc4626Discovery.logPatterns![0]!, emitter: { mode: "singleton-indexed-address", address: vault, topicIndex: 1, fromBlock: 0 } }],
  }), /emitter-address projection/);
});

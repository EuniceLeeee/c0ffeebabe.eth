import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { attestPoolIdentitiesStrict, centralAddressSurfaceFallback, type StrictIdentityProvider } from "../strict-identity-attestation.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { attestationPoolFromCandidate, candidatesFromCall, createRebuildWiring } from "../universe-rebuild-production.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import type { UnifiedObservation } from "../venues/adapter-family-plugin.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { plugin } from "../venues/production-families/erc4626-silo-redeem.production.js";
import {
  ERC4626_SILO_INTERFACE as VAULT_ABI,
  ERC4626_SILO_PAYOUT_INTERFACE as PAYOUT_ABI,
  ERC4626_SILO_PROBE_ACTOR,
  ERC4626_SILO_PROBE_ACTOR_EVIDENCE_ID,
} from "../venues/protocols/erc4626-silo-redeem-family/shared.js";

// Offline regression for the B25462190 candidate shape. The actual production
// durable codec, fallback, catalog and attestation entry run against mocks;
// this is not historical source evidence or a production acceptance receipt.
const SOURCE: CanonicalSource = Object.freeze({ number: 25_462_190,
  hash: "0x3b02e4d1911cefa4a6e5cef387db42da16821da9d48196421156ae63ab1bac13",
  generation: 25_462_190 });
const VAULT = "0x3d7d6fdf07EE548B939A80edbc9B2256d0cdc003";
const PAYOUT = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
const TX = "0xf391d02add5e6cbbd98836d9eacdb66de3e5d76ef3874134145a6563a126ee86";
const AMOUNT = 773988351883794733939n;
const UNDERLYING = `0x${"aa".repeat(20)}`;
const EXECUTOR = `0x${"bb".repeat(20)}`;
const ORIGIN = `0x${"cc".repeat(20)}`;
const PATTERN = "silo-redeem-vault-surface";
const wiring = createRebuildWiring({ rpcUrl: "http://offline.invalid" });
const discovery = plugin.discovery;
type Surface = Extract<UnifiedObservation, { readonly kind: "address-surface" }>;

function candidate(mode: "withdraw" | "redeem" = "withdraw") {
  const candidates = candidatesFromCall({ kind: "call", target: VAULT,
    data: VAULT_ABI.encodeFunctionData(mode, [PAYOUT, AMOUNT, EXECUTOR, EXECUTOR]),
    transactionHash: TX, blockNumber: SOURCE.number, blockHash: SOURCE.hash,
    traceAddress: [0],
  });
  const nominated = candidates.find(item => item.familyId === plugin.manifest.familyId);
  assert(nominated);
  const saved = wiring.encodeCandidateSnapshot!(nominated);
  return wiring.decodeCandidateSnapshot!(saved) as Readonly<Record<string, unknown>>;
}
function provider(reads: string[] = [], previewAssets = 150n): StrictIdentityProvider {
  return {
    getCode: async (_address, block) => { assert.equal(block, SOURCE.number); return "0x6000"; },
    getStorage: async (_address, _slot, block) => { assert.equal(block, SOURCE.number); return ethers.ZeroHash; },
    call: async (tx, block) => {
      assert.equal(block, SOURCE.number);
      const abi = tx.to.toLowerCase() === PAYOUT.toLowerCase() ? PAYOUT_ABI : VAULT_ABI;
      const fn = abi.getFunction(tx.data.slice(0, 10))!;
      reads.push(`${tx.to.toLowerCase()}:${fn.name}`);
      if (fn.name === "asset") return abi.encodeFunctionResult(fn, [UNDERLYING]);
      if (fn.name === "totalSupply") return abi.encodeFunctionResult(fn, [200n]);
      if (fn.name === "previewRedeem") {
        assert.equal(abi.decodeFunctionData(fn, tx.data)[0], 100n);
        return abi.encodeFunctionResult(fn, [previewAssets]);
      }
      if (fn.name === "previewWithdraw") {
        assert.equal(abi.decodeFunctionData(fn, tx.data)[0], 150n);
        return abi.encodeFunctionResult(fn, [110n]);
      }
      return assert.fail(`unexpected read ${fn.name}`);
    },
  };
}
async function surface(nominated = candidate()): Promise<Surface> {
  const pool = attestationPoolFromCandidate(nominated);
  // The original attestation entry's generic envelope omits address and adds
  // the adapterId alias. The full original entry is exercised separately below.
  const { address, adapter, ...fields } = pool;
  const opaque = Object.freeze({ ...fields, adapter, adapterId: adapter });
  const p = provider();
  const observations = await discovery.nominate!.nominate({
    nominations: [{ address, opaque: opaque as never }], source: SOURCE,
    provider: { ...p, getLogs: async () => [], getTransactionReceipt: async () => null },
  });
  assert.equal(observations.length, 0, "typed candidate has no legacy behavior evidence");
  const observation = await centralAddressSurfaceFallback(catalog, p, SOURCE, address, adapter, opaque);
  assert(observation?.kind === "address-surface");
  assert(catalog.matches(observation).some(match => match.familyId === plugin.manifest.familyId && match.patternId === PATTERN));
  return observation;
}
function decode(observation: Surface) {
  return discovery.decodeCandidate({ observation, matchedPatternId: PATTERN });
}

for (const mode of ["withdraw", "redeem"] as const) test(`${mode} production durable/address-surface round trip`, async () => {
  const nominated = candidate(mode);
  assert.equal(nominated.observedAmount, AMOUNT);
  for (const key of ["sampleShares", "sampleAssets", "evidence", "candidateEvidence"]) {
    assert.equal(nominated[key], undefined);
  }
  const decoded = decode(await surface(nominated));
  assert(decoded, "own durable candidate must survive the existing address surface");
  assert.equal(decoded.candidateKind, "erc4626-silo-payout");
  assert.equal(decoded.vault, VAULT); assert.equal(decoded.payoutToken, PAYOUT);
  assert.equal(decoded.observedMode, mode); assert.equal(decoded.observedAmount, AMOUNT);
  const provenance = decoded as unknown as Readonly<Record<string, unknown>>;
  assert.equal(provenance.transactionHash, TX);
  assert.equal(provenance.blockNumber, SOURCE.number); assert.equal(provenance.blockHash, SOURCE.hash);
  assert.equal(discovery.candidateKey(decoded), nominated.pluginCandidateKey);
  assert.equal(provenance.sampleShares, undefined); assert.equal(provenance.sampleAssets, undefined);
  assert(Object.isFrozen(decoded));
});

for (const mode of ["withdraw", "redeem"] as const) test(`${mode} original attestation reaches fresh active proof and rejects missing effects`, async () => {
  const reads: string[] = [], p = provider(reads);
  let simulations = 0;
  const runtime = createStrictCentralAdapterRuntime({ provider: p,
    executor: EXECUTOR, transactionOrigin: ORIGIN,
    verifiedActors: { [ERC4626_SILO_PROBE_ACTOR_EVIDENCE_ID]: ERC4626_SILO_PROBE_ACTOR },
    generationFence: { assertCurrent(generation, source) {
      assert.equal(generation, SOURCE.generation); assert.deepEqual(source, SOURCE);
    } },
    simulator: { simulate: async input => {
      simulations++;
      assert.deepEqual(input.source, SOURCE);
      assert.equal(input.request.id, "identity-active-redeem");
      assert.equal(input.request.call.executionMode, "impersonated-call-frame");
      assert.equal(input.request.call.data, VAULT_ABI.encodeFunctionData("redeem", [
        PAYOUT, 100n, ERC4626_SILO_PROBE_ACTOR, ERC4626_SILO_PROBE_ACTOR,
      ]));
      assert.equal(input.request.overrideIntent.tokenBalances![0]!.amount, 100n,
        "fresh supply/preview determines shares, not observedAmount or cached proof");
      return { data: VAULT_ABI.encodeFunctionResult("redeem", [110n]),
        effects: { tokenDeltas: [], totalSupplyDeltas: [], logs: [] } };
    } },
  });
  const result = await attestPoolIdentitiesStrict({ catalog, provider: p, runtime, source: SOURCE,
    pools: [attestationPoolFromCandidate({ ...candidate(mode),
      // Untrusted stale metadata must not become lifecycle evidence.
      verifiedIdentity: { status: "verified" }, behaviorProofHash: "cached-not-authority",
    })],
  });
  assert.equal(simulations, 1, result.rejected.map(item => item.reason).join(","));
  assert(reads.includes(`${VAULT.toLowerCase()}:previewRedeem`));
  assert(reads.includes(`${PAYOUT.toLowerCase()}:previewWithdraw`));
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0]!.reason, /identity_rejected:/);
  assert(result.publications.every(publication => publication === null || publication.instances.length === 0));
});

test("earlier candidate provenance is preserved, not rewritten to the current source", async () => {
  const nominated = { ...candidate(), blockNumber: SOURCE.number - 1, blockHash: `0x${"dd".repeat(32)}` };
  const decoded = decode(await surface(nominated)) as unknown as Readonly<Record<string, unknown>>;
  assert(decoded); assert.equal(decoded.blockNumber, nominated.blockNumber);
  assert.equal(decoded.blockHash, nominated.blockHash); assert.equal(decoded.transactionHash, TX);
});

const malformed: readonly [string, Readonly<Record<string, unknown>>][] = [
  ["wrong kind", { candidateKind: "erc4626-vault" }],
  ["missing kind", { candidateKind: undefined }],
  ["missing vault", { vault: undefined }], ["bad vault", { vault: "0x1234" }],
  ["foreign vault", { vault: UNDERLYING }], ["zero vault", { vault: ethers.ZeroAddress }],
  ["missing payout", { payoutToken: undefined }], ["bad payout", { payoutToken: "not-address" }],
  ["same-token payout", { payoutToken: VAULT }], ["zero payout", { payoutToken: ethers.ZeroAddress }],
  ["missing mode", { observedMode: undefined }], ["wrong mode", { observedMode: "deposit" }],
  ["missing amount", { observedAmount: undefined }], ["zero amount", { observedAmount: 0n }],
  ["negative amount", { observedAmount: -1n }], ["overflow amount", { observedAmount: 1n << 256n }],
  ["number amount", { observedAmount: 100 }], ["string amount", { observedAmount: "100" }],
  ["undecoded durable amount", { observedAmount: { $durableType: "bigint", value: "100" } }],
  ["bad transaction hash", { transactionHash: "0x1234" }],
  ["bad block hash", { blockHash: "0x1234" }], ["negative block", { blockNumber: -1 }],
  ["fractional block", { blockNumber: 1.5 }], ["unsafe block", { blockNumber: Number.MAX_SAFE_INTEGER + 1 }],
];
for (const [name, patch] of malformed) test(`malformed ${name} is null and never falls back to legacy samples`, async () => {
  const observation = await surface();
  const opaque = { ...observation.opaque as Readonly<Record<string, unknown>>, ...patch,
    sampleShares: "100", sampleAssets: "150" };
  assert.equal(decode({ ...observation, opaque: opaque as never }), null);
});

test("legacy behavior-sample address surfaces remain compatible and malformed ones fail closed", async () => {
  const observation = await surface();
  const legacy = { payoutToken: PAYOUT, sampleShares: "100", sampleAssets: "150" };
  const decoded = decode({ ...observation, opaque: legacy });
  assert(decoded); assert.equal(decoded.observedMode, "redeem"); assert.equal(decoded.observedAmount, 100n);
  for (const opaque of [undefined, null, [], {}, { ...legacy, sampleShares: "NaN" },
    { ...legacy, sampleAssets: "not-bigint" }, { ...legacy, payoutToken: "0x1234" },
    { ...legacy, sampleShares: "0" }, { ...legacy, sampleAssets: "-1" }]) {
    assert.equal(decode({ ...observation, opaque }), null);
  }
});

test("invalid call inputs and unrelated surface pattern stay rejected", async () => {
  for (const mode of ["withdraw", "redeem"] as const) {
    for (const data of ["0x", VAULT_ABI.encodeFunctionData(mode, [PAYOUT, 0n, EXECUTOR, EXECUTOR]),
      VAULT_ABI.encodeFunctionData(mode, [VAULT, AMOUNT, EXECUTOR, EXECUTOR]),
      VAULT_ABI.encodeFunctionData(mode, [ethers.ZeroAddress, AMOUNT, EXECUTOR, EXECUTOR])]) {
      assert.equal(discovery.decodeCandidate({ matchedPatternId: `silo-${mode}-call`,
        observation: { kind: "call", source: SOURCE, target: VAULT, data } }), null);
    }
  }
  assert.equal(discovery.decodeCandidate({ observation: await surface(), matchedPatternId: "foreign" }), null);
});

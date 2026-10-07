import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ethers } from "ethers";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { definedFamilyPluginContractSummary } from "../../../adapter-family-plugin.js";
import { capabilityManifestHash, FAMILY_CAPABILITY_NAMES, FamilyCapabilityCatalog } from "../../../family-capability-catalog.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { plugin } from "../../../production-families/badger-sett-withdraw.production.js";
import { CODE, VAULT, STRATEGY, TOKEN, LOCKER, ADMIN_SLOT, IMPLEMENTATION_SLOT, address } from "../codec.js";
import { FAMILY, LINEAGE } from "../manifest.js";
import { program } from "../exact.js";
import type { Binding, Descriptor, State } from "../types.js";
import type { PublicState } from "./export-public-state.js";
// Only committed, allowlisted public fields are loaded here. The optional raw
// archive is read by provenance.ts, never by ordinary fixture/test imports.
export const publicState = JSON.parse(readFileSync(new URL("./public-state.json", import.meta.url), "utf8")) as PublicState;
export const saved = (file: string): readonly string[] => {
  assert(Object.hasOwn(publicState.abis, file), "unknown public ABI fixture " + file);
  return publicState.abis[file];
};
export const rpc = (file: string): string => {
  assert(Object.hasOwn(publicState.rpcResults, file), "unknown public result fixture " + file);
  return publicState.rpcResults[file];
};
export const original: Binding = {
  vault: "0xba485b556399123261a5f9c95d413b4f93107407", vaultImplementation: "0x60c796acb2e0949178086294f03a44c450511784",
  strategy: "0x3c0989ef27e3e3fab87a2d7c38b35880c90e63b5", strategyImplementation: "0x7c2a951d062cc7b7c6f9c7aa7e80a6f20eaa8cab",
  asset: "0xc0c293ce456ff0ed870add98a0828dd4d2903dbf", locker: "0x3fa73f1e5d8a792c80f426fc8f84fbf7ce9bbcac",
  vaultAdmin: "0x20dce41acca85e8222d6861aa6d23b6c941777bf", strategyAdmin: "0x20dce41acca85e8222d6861aa6d23b6c941777bf",
};
export const actor = "0x1000000000000000000000000000000000000099";
export const source = (number = 100): CanonicalSource => ({ number, hash: ethers.toBeHex(number, 32), generation: number });
export const historicalSource: CanonicalSource = { number: 26138511, hash: "0xffdbdda6829f743dc05ad148586e96dc671f31ee30968f07d91963b9de22e771", generation: 1 };
export const runtimes = publicState.runtimes;
for (const k of Object.keys(CODE) as (keyof typeof CODE)[]) assert.equal(ethers.keccak256(runtimes[k]), CODE[k]);
export function baseline(at = source()): State {
  return { source: at, binding: { ...original }, supply: BigInt(rpc("rpc-013-vault-totalSupply.json")),
    vaultIdle: BigInt(rpc("rpc-031-token-balance-wrapper.json")), strategyIdle: BigInt(rpc("rpc-032-token-balance-strategy.json")),
    locked: LOCKER.decodeFunctionResult("balances", rpc("rpc-042-locker-balances.json"))[0],
    feeBps: BigInt(rpc("rpc-016-vault-withdrawalFee.json")), treasury: VAULT.decodeFunctionResult("treasury", rpc("rpc-021-vault-treasury.json"))[0].toLowerCase(),
    vaultPaused: false, strategyPaused: false, safetyCheck: true, deviationBps: 50n };
}
export interface Fixture {
  state: State; binding: Binding; codes: Partial<Record<keyof typeof CODE, string>>;
  wrongWant?: string; wrongVault?: string; wrongLockerToken?: string; backingError?: bigint; failure?: boolean;
  shares: bigint; aura: bigint;
}
export function fixture(at = source()): Fixture { return { state: baseline(at), binding: { ...original }, codes: {}, shares: 10n ** 30n, aura: 123456789n }; }
export function descriptor(f = fixture()): Descriptor {
  return { familyId: FAMILY, lineageId: LINEAGE, instanceKey: instanceKey(f.binding.vault), ...f.binding, provenance: [], runtimeRequirements: [] };
}
export function dataFor(f: Fixture, to: string, data: string): string {
  const b = f.binding, s = f.state, a = address(to);
  const abi = a === b.vault ? VAULT : a === b.strategy ? STRATEGY : a === b.locker ? LOCKER : a === b.asset ? TOKEN : undefined;
  assert(abi, "unknown fixture target " + a);
  const parsed = abi.parseTransaction({ data }); assert(parsed, "unknown fixture selector");
  let value: unknown;
  switch (parsed.name) {
    case "token": value = b.asset; break;
    case "strategy": value = b.strategy; break;
    case "vault": value = f.wrongVault ?? b.vault; break;
    case "want": value = f.wrongWant ?? b.asset; break;
    case "LOCKER": value = b.locker; break;
    case "stakingToken": value = f.wrongLockerToken ?? b.asset; break;
    case "decimals": value = 18n; break;
    case "totalSupply": value = s.supply; break;
    case "balance": value = s.vaultIdle + s.strategyIdle + s.locked + (f.backingError ?? 0n); break;
    case "paused": value = a === b.vault ? s.vaultPaused : s.strategyPaused; break;
    case "withdrawalFee": value = s.feeBps; break;
    case "treasury": value = s.treasury; break;
    case "withdrawalSafetyCheck": value = s.safetyCheck; break;
    case "withdrawalMaxDeviationThreshold": value = s.deviationBps; break;
    case "balances": assert.equal(address(parsed.args[0]), b.strategy); return abi.encodeFunctionResult(parsed.name, [s.locked, 51]);
    case "balanceOf":
      if (a === b.strategy) value = s.strategyIdle + s.locked;
      else if (a === b.vault) { assert.equal(address(parsed.args[0]), actor); value = f.shares; }
      else { const owner = address(parsed.args[0]); value = owner === b.vault ? s.vaultIdle : owner === b.strategy ? s.strategyIdle : owner === actor ? f.aura : undefined; }
      break;
    default: throw new Error("unexpected fixture getter " + parsed.name);
  }
  assert.notEqual(value, undefined); return abi.encodeFunctionResult(parsed.name, [value]);
}
export function provider(f: Fixture, at: CanonicalSource, reads: string[] = []) {
  const check = (block?: number) => { assert.equal(block, at.number); if (f.failure) throw new Error("synthetic transport unavailable"); };
  return {
    async getCode(a: string, block?: number) {
      check(block); a = address(a); reads.push("code:" + a); const b = f.binding;
      const kind = a === b.vault || a === b.strategy ? "proxy" : a === b.vaultImplementation ? "vault" :
        a === b.strategyImplementation ? "strategy" : a === b.asset ? "asset" : a === b.locker ? "locker" : undefined;
      assert(kind, "unknown fixture code"); return f.codes[kind] ?? runtimes[kind];
    },
    async getStorage(a: string, slot: string, block?: number) {
      check(block); a = address(a); reads.push("storage:" + a + ":" + slot); const b = f.binding;
      assert([b.vault, b.strategy].includes(a)); assert([ADMIN_SLOT, IMPLEMENTATION_SLOT].includes(slot));
      const value = a === b.vault ? slot === ADMIN_SLOT ? b.vaultAdmin : b.vaultImplementation : slot === ADMIN_SLOT ? b.strategyAdmin : b.strategyImplementation;
      return ethers.zeroPadValue(value, 32);
    },
    async call(req: { to: string; data: string }, block?: number) { check(block); reads.push("call:" + req.to + ":" + req.data); return dataFor(f, req.to, req.data); },
  };
}
export const row = (at: CanonicalSource, id: string, data: string): AdapterRequestResult =>
  ({ id, data, source: at, ok: true, completion: "returned", provenance: { kind: "offline-fixture", fingerprint: "synthetic-not-chain-execution" } });
export async function read(f: Fixture, reqs: readonly AdapterRequest[], at = source()) {
  const p = provider(f, at);
  return Promise.all(reqs.map(async r => row(at, r.id, r.kind === "get-code" ? await p.getCode(r.address, at.number) :
    r.kind === "get-storage" ? await p.getStorage(r.address, r.slot, at.number) :
    r.kind === "eth-call" ? await p.call(r, at.number) : (() => { throw new Error("unexpected simulation request"); })())));
}
export function runtime(f: Fixture, at: CanonicalSource, reads: string[] = []) {
  return createStrictCentralAdapterRuntime({ executor: actor, provider: provider(f, at, reads),
    generationFence: { assertCurrent(g, s) { assert.equal(g, at.generation); assert.deepEqual(s, at); } } });
}
export const input = (f = fixture(), amountIn = 10n ** 18n, at = source()) => {
  const d = descriptor(f), r = plugin.routes.project({ descriptor: d })[0];
  return { descriptor: d, route: r, amountIn, source: at, executor: actor, runtimeEvidence: [] };
};
export async function collect(f = fixture(), i = input(f)) {
  const initialResults = await read(f, program.buildRequests(i), i.source), dependentEvidence: unknown[] = [];
  for (let completedRound = 0; completedRound < 4; completedRound++) {
    const round = program.buildDependentProgram!({ programInput: i, completedRound, initialResults, priorEvidence: dependentEvidence });
    if (!round) return { initialResults, dependentEvidence };
    dependentEvidence.push(round.decode(await read(f, round.requests, i.source)));
  }
  throw new Error("too many rounds");
}
export async function attest(f = fixture(), at = source()) {
  const v = plugin.identity.variants[0]; let evidence: unknown;
  for (let step = 0; step < 4; step++) {
    const i = { candidate: { candidateKind: "badger-sett-withdraw" as const, vault: f.binding.vault }, evidence, step };
    evidence = v.decode({ step: i, results: await read(f, v.buildRequests(i), at) });
    const decision = v.decide({ ...i, evidence }); if (decision.status !== "continue") return decision;
  }
  throw new Error("identity did not terminate");
}
// In-memory TEST catalog only. Hashes below are fixture labels, never saved
// production manifest/Ready authority; lifecycle/Graph/session issuers are real.
export function testCatalog() {
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: FAMILY, capability, contractVersion: "s1-v1",
    contentHash: createHash("sha256").update("offline-badger-contract:" + capability).digest("hex"),
    semanticDependencies: ["contract:" + capability], provenanceCommit: null }));
  return new FamilyCapabilityCatalog({ modules: [{ plugin, sourceFile: "badger-sett-withdraw.production.ts",
    definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) }, requireCapture: true });
}

import { ethers } from "ethers";
import type { IdentitySemantics, UnifiedObservation } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { address, call, code, decode, members, rows, TOKEN, uint, WAD } from "./codec.js";
import { FAMILY, LEGACY_LINEAGE } from "./manifest.js";
import type { Binding, Candidate, Descriptor, Identity, LegacyBinding, State } from "./types.js";
import { binding } from "./instance.js";

// Behavioral runtime identities, not an instance/factory allowlist. Core must
// additionally register each Set; the Set's factory points back to Core. The
// current factory-creation enable flag does not control existing redemption.
// These direct runtimes and the two linked libraries were bound at N=26132613.
export const CORE_HASH = "0x8159dc42b5019900fe368cb03886b102050d59058cda357f7575df7007389816";
export const LEGACY_SET_HASH = "0x9d4668618d68fdec2838b5eae4676d5576e90dbf415f34456cbbb626ef93a961";
export const REBALANCING_V3_HASH = "0xd18acd8832e87c8db17449e7e8da7d0c3687826b9141f1b43f92ba8de31c2699";
export const VAULT_HASH = "0x53e69a2d96ca092f3333fd2f6ab8ce112100a2f5f86642c7f1cbff32389a77a0";
export const CORE_LIBRARIES = [
  { address: "0xdc733ec262f32882f7c05525cc2d09f2c04d86ac", codeHash: "0x12d9463ad434b0a328cde285d72068e87efef9f2174a8e2b4f2c3b334d320990" },
  { address: "0x5f3f534d0c5ea126150ec8078d404464339503ca", codeHash: "0x71095eb57277c279adceabb318ac683f4f08665d97c0a4cad8858dafdb4e5c73" },
] as const;
export const CORE = new ethers.Interface([
  "function vault() view returns(address)", "function validSets(address) view returns(bool)",
  "function transferProxy() view returns(address)", "function operationState() view returns(uint8)",
  "function issue(address,uint256)", "function issueTo(address,address,uint256)", "function redeem(address,uint256)",
  "function redeemTo(address,address,uint256)", "function redeemAndWithdrawTo(address,address,uint256,uint256)",
  "event SetIssued(address,uint256)", "event SetRedeemed(address,uint256)",
]);
export const LEGACY_SET = new ethers.Interface([
  "function factory() view returns(address)", "function getComponents() view returns(address[])", "function getUnits() view returns(uint256[])",
  "function naturalUnit() view returns(uint256)", "function totalSupply() view returns(uint256)",
  "function core() view returns(address)", "function vault() view returns(address)", "function rebalanceState() view returns(uint8)",
  "function entryFee() view returns(uint256)", "function feeRecipient() view returns(address)",
]);
export const FACTORY = new ethers.Interface(["function core() view returns(address)"]);
export const VAULT = new ethers.Interface(["function getOwnerBalance(address,address) view returns(uint256)", "function authorized(address) view returns(bool)"]);
export const legacyLogPatterns = ["SetIssued", "SetRedeemed"].map(name => ({ id: "legacy-" + name,
  topic: CORE.getEvent(name)!.topicHash as `0x${string}`, signature: CORE.getEvent(name)!.format("sighash") }));
export const legacyCallPatterns = ["issue", "issueTo", "redeem", "redeemTo", "redeemAndWithdrawTo"].map(name => ({
  id: "legacy-" + name, selector: CORE.getFunction(name)!.selector as `0x${string}`,
  signature: CORE.getFunction(name)!.format("sighash"), candidateAddress: { from: "call-target" as const },
}));
export function decodeLegacyCandidate(o: UnifiedObservation, id: string): Candidate | null {
  try {
    let set: string, core: string;
    if (o.kind === "log" && legacyLogPatterns.some(p => p.id === id)) {
      const ev = CORE.getEvent(id.slice(7))!, args = CORE.decodeEventLog(ev, o.data, [...o.topics]), encoded = CORE.encodeEventLog(ev, args);
      if (encoded.data.toLowerCase() !== o.data.toLowerCase() || encoded.topics.length !== o.topics.length ||
          encoded.topics.some((t, i) => t.toLowerCase() !== o.topics[i].toLowerCase()) || !uint(args[1])) return null;
      set = address(args[0]); core = address(o.address);
    } else if (o.kind === "call" && legacyCallPatterns.some(p => p.id === id)) {
      const name = id.slice(7), args = CORE.decodeFunctionData(name, o.data);
      if (CORE.encodeFunctionData(name, args).toLowerCase() !== o.data.toLowerCase()) return null;
      const setIndex = name === "issueTo" || name === "redeemTo" ? 1 : 0;
      if (!uint(args[name === "issue" || name === "redeem" ? 1 : 2])) return null;
      set = address(args[setIndex]); core = address(o.target);
    } else return null;
    return set === core ? null : { candidateKind: "set-redemption", set, module: core, legacyCore: true };
  } catch { return null; }
}
interface Proof {
  phase: "code" | "binding" | "complete"; source: CanonicalSource; ids: readonly string[];
  setCodeHash?: string; kind?: LegacyBinding["kind"]; binding?: Binding; rejection?: string; unavailable?: string;
}
const libraryRequests = () => CORE_LIBRARIES.map((l, i) => code("legacy-library-" + i, l.address));
function checkLibraries(get: (id: string) => string) {
  for (const [i, l] of CORE_LIBRARIES.entries()) if (ethers.keccak256(get("legacy-library-" + i)) !== l.codeHash)
    throw new Error("set-legacy linked library runtime changed");
}
function identityRequests(c: Candidate, p?: Proof) {
  if (!p) return [code("set-code", c.set), code("core-code", c.module)];
  if (p.phase === "code") return [call("factory", c.set, LEGACY_SET.encodeFunctionData("factory")),
    call("getComponents", c.set, LEGACY_SET.encodeFunctionData("getComponents")), call("vault", c.module, CORE.encodeFunctionData("vault")),
    call("transfer-proxy", c.module, CORE.encodeFunctionData("transferProxy"))];
  if (p.phase !== "binding" || !p.binding?.legacy) return [];
  const d = p.binding, l = d.legacy!;
  return [code("factory-code", l.factory), code("vault-code", l.vault), ...libraryRequests(),
    ...(l.issuance ? [code("transfer-proxy-code", l.issuance.transferProxy)] : []),
    call("factory-core", l.factory, FACTORY.encodeFunctionData("core")),
    call("registered-set", d.module, CORE.encodeFunctionData("validSets", [d.set])),
    call("vault-authorized", l.vault, VAULT.encodeFunctionData("authorized", [d.module])),
    ...d.components.flatMap((t, i) => [code("component-code-" + i, t), call("decimals-" + i, t, TOKEN.encodeFunctionData("decimals"))]),
    ...(l.kind === "rebalancing-v3" ? ["core", "vault", "rebalanceState"].map(k => call("set-" + k, d.set, LEGACY_SET.encodeFunctionData(k))) : [])];
}
export const legacyIdentity = {
  id: "legacy-core-registered-direct-set-runtime", kind: "standalone-contract", lineageId: LEGACY_LINEAGE,
  applies: c => c.candidateKind === "set-redemption" && c.legacyCore === true,
  requirements: ({ evidence }) => ({ transports: !evidence ? ["get-code"] : (evidence as Proof).phase === "code" ? ["eth-call"] : ["get-code", "eth-call"] }),
  buildRequests: ({ candidate, evidence }) => identityRequests(candidate, evidence as Proof | undefined),
  decode({ step, results }): Proof {
    const p = step.evidence as Proof | undefined, c = step.candidate, ids = identityRequests(c, p).map(r => r.id), r = rows(results, ids, p?.source);
    if (!p) {
      const setCodeHash = ethers.keccak256(r.get("set-code")), kind = setCodeHash === LEGACY_SET_HASH ? "set-token" : "rebalancing-v3";
      return { phase: "code", source: r.source, ids, setCodeHash, kind,
        ...(ethers.keccak256(r.get("core-code")) === CORE_HASH && [LEGACY_SET_HASH, REBALANCING_V3_HASH].includes(setCodeHash)
          ? {} : { rejection: "unsupported-legacy-core-or-set-runtime" }) };
    }
    if (p.phase === "code") {
      const set = address(c.set), module = address(c.module), factory = address(decode(LEGACY_SET, "factory", r.get("factory"))[0]);
      const vault = address(decode(CORE, "vault", r.get("vault"))[0]);
      const transferProxy = address(decode(CORE, "transferProxy", r.get("transfer-proxy"))[0]);
      if (new Set([set, module, factory, vault, transferProxy]).size !== 5) throw new Error("set-legacy aliased identity");
      const components = members(decode(LEGACY_SET, "getComponents", r.get("getComponents"))[0], [set, module, factory, vault, transferProxy]);
      return { ...p, phase: "binding", ids, binding: { set, module, controller: module, controllerCodeHash: CORE_HASH,
        components, legacy: { kind: p.kind!, setCodeHash: p.setCodeHash!, factory, factoryCodeHash: "", vault,
          ...(components.length === 1 ? { issuance: { transferProxy, codeHash: "" } } : {}) } } };
    }
    if (p.phase !== "binding" || !p.binding?.legacy) throw new Error("set-legacy invalid identity phase");
    const d = p.binding, l = d.legacy!;
    checkLibraries(r.get);
    if (ethers.keccak256(r.get("vault-code")) !== VAULT_HASH || r.get("factory-code") === "0x" ||
        address(decode(FACTORY, "core", r.get("factory-core"))[0]) !== d.module ||
        (l.kind === "rebalancing-v3" && (d.components.length !== 1 || address(decode(LEGACY_SET, "core", r.get("set-core"))[0]) !== d.module ||
          address(decode(LEGACY_SET, "vault", r.get("set-vault"))[0]) !== l.vault))) return { ...p, ids, rejection: "legacy-core-factory-vault-binding-mismatch" };
    if (d.components.some((_, i) => r.get("component-code-" + i) === "0x" || decode(TOKEN, "decimals", r.get("decimals-" + i))[0] > 77n))
      throw new Error("set-legacy component code or decimals unavailable");
    const eligible = decode(CORE, "validSets", r.get("registered-set"))[0] &&
      decode(VAULT, "authorized", r.get("vault-authorized"))[0] && (l.kind !== "rebalancing-v3" || decode(LEGACY_SET, "rebalanceState", r.get("set-rebalanceState"))[0] === 0n);
    if (l.issuance && r.get("transfer-proxy-code") === "0x") throw new Error("set-legacy transfer proxy code unavailable");
    return { ...p, phase: "complete", ids, binding: { ...d, legacy: { ...l, factoryCodeHash: ethers.keccak256(r.get("factory-code")),
      ...(l.issuance ? { issuance: { ...l.issuance, codeHash: ethers.keccak256(r.get("transfer-proxy-code")) } } : {}) } },
      ...(eligible ? {} : { unavailable: "legacy-set-disabled-or-rebalancing-or-vault-unauthorized" }) };
  },
  decide({ evidence }) {
    const p = evidence as Proof | undefined;
    if (p?.rejection) return { status: "chain-proven-rejected", reasonCode: p.rejection, evidenceRequestIds: p.ids };
    if (p?.unavailable) return { status: "retryable", reasonCode: p.unavailable };
    if (p?.phase !== "complete" || !p.binding) return { status: "continue" };
    return { status: "verified", identity: { familyId: FAMILY, lineageId: LEGACY_LINEAGE, subject: p.binding.set, binding: p.binding,
      provenance: [{ kind: "source-bound-legacy-runtimes-and-core-registration", subject: p.binding.module,
        evidenceHash: hashCanonical({ ...binding(p.binding), source: { ...p.source }, libraries: CORE_LIBRARIES }) }] } };
  },
} satisfies IdentitySemantics<Candidate, Identity>["variants"][number];

export function legacyStateRequests(d: Descriptor) {
  const l = d.legacy!;
  return [code("set-code", d.set), code("core-code", d.module), code("factory-code", l.factory), code("vault-code", l.vault), ...libraryRequests(),
    ...(l.issuance ? [code("transfer-proxy-code", l.issuance.transferProxy), call("transfer-proxy", d.module, CORE.encodeFunctionData("transferProxy")),
      call("operation-state", d.module, CORE.encodeFunctionData("operationState")),
      call("transfer-authorized", l.issuance.transferProxy, VAULT.encodeFunctionData("authorized", [d.module])),
      ...(l.kind === "rebalancing-v3" ? ["entryFee", "feeRecipient"].map(k => call("set-" + k, d.set, LEGACY_SET.encodeFunctionData(k))) : [])] : []),
    ...["factory", "getComponents", "getUnits", "naturalUnit", "totalSupply"].map(k => call(k, d.set, LEGACY_SET.encodeFunctionData(k))),
    call("vault", d.module, CORE.encodeFunctionData("vault")), call("factory-core", l.factory, FACTORY.encodeFunctionData("core")),
    call("registered-set", d.module, CORE.encodeFunctionData("validSets", [d.set])),
    call("vault-authorized", l.vault, VAULT.encodeFunctionData("authorized", [d.module])),
    ...d.components.flatMap((t, i) => [call("owner-balance-" + i, l.vault, VAULT.encodeFunctionData("getOwnerBalance", [t, d.set])),
      call("vault-balance-" + i, t, TOKEN.encodeFunctionData("balanceOf", [l.vault]))]),
    ...(l.kind === "rebalancing-v3" ? ["core", "vault", "rebalanceState"].map(k => call("set-" + k, d.set, LEGACY_SET.encodeFunctionData(k))) : [])];
}
export function decodeLegacyState(d: Descriptor, results: readonly AdapterRequestResult[], source?: CanonicalSource): State {
  const l = d.legacy!, r = rows(results, legacyStateRequests(d).map(q => q.id), source);
  checkLibraries(r.get);
  if (ethers.keccak256(r.get("set-code")) !== l.setCodeHash || ethers.keccak256(r.get("core-code")) !== CORE_HASH ||
      ethers.keccak256(r.get("factory-code")) !== l.factoryCodeHash || ethers.keccak256(r.get("vault-code")) !== VAULT_HASH ||
      address(decode(LEGACY_SET, "factory", r.get("factory"))[0]) !== l.factory || address(decode(CORE, "vault", r.get("vault"))[0]) !== l.vault ||
      address(decode(FACTORY, "core", r.get("factory-core"))[0]) !== d.module)
    throw new Error("set-legacy runtime or identity binding changed; new Ready required");
  const components = members(decode(LEGACY_SET, "getComponents", r.get("getComponents"))[0]);
  if (components.length !== d.components.length || components.some((c, i) => c !== d.components[i])) throw new Error("set-legacy basket changed; new Ready required");
  if (!decode(CORE, "validSets", r.get("registered-set"))[0] ||
      !decode(VAULT, "authorized", r.get("vault-authorized"))[0] || (l.kind === "rebalancing-v3" &&
      (address(decode(LEGACY_SET, "core", r.get("set-core"))[0]) !== d.module || address(decode(LEGACY_SET, "vault", r.get("set-vault"))[0]) !== l.vault ||
      decode(LEGACY_SET, "rebalanceState", r.get("set-rebalanceState"))[0] !== 0n))) throw new Error("set-legacy currently ineligible");
  const units = [...decode(LEGACY_SET, "getUnits", r.get("getUnits"))[0]].map(uint), naturalUnit = uint(decode(LEGACY_SET, "naturalUnit", r.get("naturalUnit"))[0]);
  if (!naturalUnit || units.length !== components.length || units.some(u => !u)) throw new Error("set-legacy invalid units");
  if (l.issuance && (address(decode(CORE, "transferProxy", r.get("transfer-proxy"))[0]) !== l.issuance.transferProxy ||
      ethers.keccak256(r.get("transfer-proxy-code")) !== l.issuance.codeHash)) throw new Error("set-legacy transfer proxy changed; new Ready required");
  const entryFee = l.issuance && l.kind === "rebalancing-v3" ? uint(decode(LEGACY_SET, "entryFee", r.get("set-entryFee"))[0]) : 0n;
  return { source: r.source, multiplier: WAD, naturalUnit, units, supply: uint(decode(LEGACY_SET, "totalSupply", r.get("totalSupply"))[0]),
    ...(l.issuance ? { issuance: {
      operational: decode(CORE, "operationState", r.get("operation-state"))[0] === 0n && decode(VAULT, "authorized", r.get("transfer-authorized"))[0] === true && entryFee < WAD,
      // The deployed setter permits zero. It blocks only a positive fee mint,
      // not redemption, and not an issuance whose fee rounds to zero.
      entryFee, ...(l.kind === "rebalancing-v3" ? { feeRecipient: ethers.getAddress(decode(LEGACY_SET, "feeRecipient", r.get("set-feeRecipient"))[0]).toLowerCase() } : {}) } } : {}),
    balances: components.map((_, i) => { const owned = uint(decode(VAULT, "getOwnerBalance", r.get("owner-balance-" + i))[0]),
      available = uint(decode(TOKEN, "balanceOf", r.get("vault-balance-" + i))[0]); return owned < available ? owned : available; }) };
}

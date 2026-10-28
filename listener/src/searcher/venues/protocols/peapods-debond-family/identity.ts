import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { hashCanonical } from "../../canonical-value.js";
import { ABI, WAD, address, assertSource, call, code, decode, rows, uint } from "./codec.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import { proveRuntime } from "./runtime-shape.js";
import { debond } from "./math.js";
import type { Binding, Candidate, Identity, State } from "./types.js";
interface Root { readonly pod: string; readonly asset: string; readonly codeHash: string; readonly staking: string; readonly feeBps: bigint }
interface Proof {
  readonly phase: "root" | "dependencies" | "complete" | "unavailable"; readonly source?: CanonicalSource;
  readonly root?: Root; readonly binding?: Binding; readonly state?: State; readonly amountIn?: bigint; readonly reason?: string;
  readonly behaviorHash?: string;
}
const caller = { kind: "executor" as const };
export const rootRequests = (pod: string) => [code("identity-pod-code", pod),
  ...["getAllAssets", "indexType", "decimals", "lpStakingPool", "DEBOND_FEE"].map(name => call("identity-" + name, pod, ABI.encodeFunctionData(name)))];
export const dependencyRequests = (r: Root) => [code("identity-asset-code", r.asset), code("identity-staking-code", r.staking),
  call("identity-indexFund", r.staking, ABI.encodeFunctionData("indexFund")),
  call("identity-asset-decimals", r.asset, ABI.encodeFunctionData("decimals")),
  call("identity-supply", r.pod, ABI.encodeFunctionData("totalSupply")),
  call("identity-backing", r.asset, ABI.encodeFunctionData("balanceOf", [r.pod])),
  call("identity-isAsset", r.pod, ABI.encodeFunctionData("isAsset", [r.asset]))];
export function behaviorRequest(p: Proof): AdapterRequest {
  if (!p.binding || !p.amountIn || !p.state) throw new Error("peapods missing behavior binding");
  const { pod, asset } = p.binding;
  return { id: "peapods-active-debond", kind: "effect-delta-simulation",
    call: { caller, executionMode: "impersonated-call-frame", to: pod, data: ABI.encodeFunctionData("debond", [p.amountIn, [], []]) },
    overrideIntent: { caller, tokenBalances: [{ token: pod, amount: p.amountIn }] },
    observeTokenBalances: [{ token: pod, account: caller }, { token: pod, account: pod },
      { token: asset, account: caller }, { token: asset, account: pod }],
    observe: ["return-data", "revert-data", "token-delta", "total-supply-delta", "logs"] };
}
export function verifyBehavior(p: Proof, r: Extract<AdapterRequestResult, { ok: true }>): void {
  if (!p.binding || !p.amountIn || !p.state || !p.source) throw new Error("peapods missing behavior state");
  assertSource(r.source, p.source);
  if (r.completion !== "returned" || r.data !== "0x") throw new Error("peapods debond not returned");
  const { pod, asset, staking } = p.binding, q = debond(p.state, p.amountIn), deltas = r.effects?.tokenDeltas;
  const actorRows = deltas?.filter(d => d.token.toLowerCase() === pod && d.account.toLowerCase() !== pod);
  if (!q.amountOut || !deltas || deltas.length !== 4 || actorRows?.length !== 1) throw new Error("peapods missing scoped deltas");
  const actor = address(actorRows[0].account);
  if ([pod, asset, staking].includes(actor)) throw new Error("peapods invalid behavior caller");
  for (const [token, account, delta] of [[pod, actor, -p.amountIn], [pod, pod, q.feeShares], [asset, actor, q.amountOut], [asset, pod, -q.amountOut]] as const) {
    const found = deltas.filter(d => d.token.toLowerCase() === token && d.account.toLowerCase() === account);
    if (found.length !== 1 || found[0].delta !== delta) throw new Error("peapods debit/receipt mismatch");
  }
  const supply = r.effects?.totalSupplyDeltas;
  if (!supply || supply.filter(d => d.token.toLowerCase() === pod).length !== 1 ||
      supply.find(d => d.token.toLowerCase() === pod)?.delta !== -q.burned ||
      supply.some(d => d.token.toLowerCase() !== pod && d.delta !== 0n)) throw new Error("peapods burn mismatch");
  const events = (r.effects?.logs ?? []).filter(e => e.address.toLowerCase() === pod && e.topics[0]?.toLowerCase() === ABI.getEvent("Debond")!.topicHash.toLowerCase());
  if (events.length !== 1) throw new Error("peapods missing debond event");
  const e = ABI.decodeEventLog("Debond", events[0].data, [...events[0].topics]);
  if (address(e.wallet) !== actor || e.amountDebonded !== p.amountIn) throw new Error("peapods event/caller mismatch");
}
export const identity = {
  identityKey: i => i.binding.pod,
  variants: [{ id: "source-weighted-single-asset-effects", kind: "standalone-contract", lineageId: LINEAGE,
    applies: c => c.candidateKind === "peapods-debond",
    requirements({ evidence }) { return (evidence as Proof | undefined)?.phase === "dependencies"
      ? { transports: ["effect-delta-simulation"], caller: "executor", effects: ["return-data", "revert-data", "token-delta", "total-supply-delta", "logs"] }
      : { transports: ["get-code", "eth-call"] }; },
    buildRequests({ candidate, evidence }) {
      const p = evidence as Proof | undefined;
      if (!p) return rootRequests(candidate.pod);
      if (p.phase === "root" && p.root) return dependencyRequests(p.root);
      if (p.phase === "dependencies") return [behaviorRequest(p)];
      return [];
    },
    decode({ step, results }): Proof {
      const p = step.evidence as Proof | undefined;
      try {
        if (!p) {
          const pod = address(step.candidate.pod), r = rows(results, rootRequests(pod)), runtime = proveRuntime(r.get("identity-pod-code"));
          const assets = decode("getAllAssets", r.get("identity-getAllAssets"))[0];
          if (assets.length !== 1 || decode("indexType", r.get("identity-indexType"))[0] !== 0n ||
              decode("decimals", r.get("identity-decimals"))[0] !== 18n || decode("DEBOND_FEE", r.get("identity-DEBOND_FEE"))[0] !== runtime.feeBps)
            throw new Error("peapods unsupported topology/variant");
          const asset = address(assets[0].token), staking = address(decode("lpStakingPool", r.get("identity-lpStakingPool"))[0]);
          if (new Set([pod, asset, staking]).size !== 3) throw new Error("peapods aliased dependencies");
          return { phase: "root", source: r.source, root: { pod, asset, staking, ...runtime } };
        }
        if (p.phase === "root" && p.root && p.source) {
          const r = rows(results, dependencyRequests(p.root), p.source), root = p.root;
          if (r.get("identity-asset-code") === "0x" || r.get("identity-staking-code") === "0x" ||
              address(decode("indexFund", r.get("identity-indexFund"))[0]) !== root.pod || decode("isAsset", r.get("identity-isAsset"))[0] !== true)
            throw new Error("peapods reciprocal identity mismatch");
          const decimals = Number(decode("decimals", r.get("identity-asset-decimals"))[0]);
          if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("peapods unsupported asset decimals");
          const binding: Binding = { ...root, decimals, assetCodeHash: ethers.keccak256(r.get("identity-asset-code")), stakingCodeHash: ethers.keccak256(r.get("identity-staking-code")) };
          const state: State = { source: p.source, feeBps: root.feeBps, supply: uint(decode("totalSupply", r.get("identity-supply"))[0]),
            backing: uint(decode("balanceOf", r.get("identity-backing"))[0]) };
          const amountIn = state.supply < WAD ? state.supply : WAD;
          if (!amountIn || !debond(state, amountIn).amountOut) throw new Error("peapods no positive liquid behavior sample");
          return { ...p, phase: "dependencies", binding, state, amountIn };
        }
        if (p.phase !== "dependencies" || results.length !== 1 || results[0].id !== "peapods-active-debond") throw new Error("peapods invalid identity phase");
        if (!results[0].ok) throw new RequiredAdapterRequestError(results[0]);
        verifyBehavior(p, results[0]);
        return { ...p, phase: "complete", behaviorHash: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(results[0], (_k,v) => typeof v === "bigint" ? v.toString() : v))) };
      } catch (error) {
        if (error instanceof RequiredAdapterRequestError) throw error;
        return { phase: "unavailable", reason: error instanceof Error ? error.message : "peapods identity unavailable" };
      }
    },
    decide({ evidence }) {
      const p = evidence as Proof | undefined;
      if (p?.phase === "unavailable") return { status: "retryable", reasonCode: p.reason! };
      if (p?.phase !== "complete" || !p.binding || !p.source || !p.behaviorHash) return { status: "continue" };
      return { status: "verified", identity: { familyId: FAMILY, lineageId: LINEAGE, subject: p.binding.pod, binding: p.binding,
        provenance: [{ kind: "source-runtime-reciprocal-staking-and-positive-debond-effects-not-factory", subject: p.binding.pod,
          evidenceHash: hashCanonical({ ...p.binding, source: { ...p.source }, behavior: p.behaviorHash }) }] } };
    },
  }],
} satisfies IdentitySemantics<Candidate, Identity>;

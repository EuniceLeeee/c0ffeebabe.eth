import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { ABI, NEED, PROBE_RECEIVER, WAD, scales } from "../codec.js";
import { instance } from "../instance.js";
import { identity, samples } from "../identity.js";
import { routes } from "../routes.js";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import { declareRequestProgram } from "../../../adapter-request-program.js";
export const addr = (n: number) => ethers.toBeHex(n, 20), actor = addr(71);
export const source = { number: 26152335, hash: ethers.id("yearn-fixture"), generation: 1 };
const template = JSON.parse(readFileSync(new URL("source-runtime.json", import.meta.url), "utf8"));
export function fixture() { return { target: addr(81), implementation: addr(82), want: addr(83), sold: addr(84), receiver: addr(85),
  code: template.implementation as string, wantCode: "0x6000", soldCode: "0x6001", wantDecimals: 18, soldDecimals: 18,
  rawPrice: 2517039516660451874n, available: 772943155644044667101n, version: "1.0.4",
  mutate: (_r: any) => {} }; }
export type Fixture = ReturnType<typeof fixture>;
export const cloneCode = (f: Fixture) => "0x363d3d373d3d3d363d73" + f.implementation.slice(2) + "5af43d82803e903d91602b57fd5bf3";
export const returned = (id: string, data: string): AdapterRequestResult => ({ id, ok: true, source, completion: "returned", data,
  provenance: { kind: "synthetic", fingerprint: "yearn-auction-contract" } });
export function contractCost(f: Fixture, amount: bigint) {
  const scaled = amount * 10n ** BigInt(18 - f.soldDecimals) * f.rawPrice;
  if (scaled > ethers.MaxUint256) throw new Error("source arithmetic overflow");
  return scaled / WAD / (10n ** BigInt(18 - f.wantDecimals));
}
export function reads(f: Fixture, requests: readonly AdapterRequest[]): AdapterRequestResult[] { return requests.map(r => {
  if (r.kind === "get-code") return returned(r.id, r.address.toLowerCase() === f.target ? cloneCode(f) : r.address.toLowerCase() === f.implementation ? f.code : r.address.toLowerCase() === f.want ? f.wantCode : f.soldCode);
  if (r.kind !== "eth-call") throw new Error("unexpected fixture request");
  const c = ABI.parseTransaction({ data: r.data })!; let values: unknown[];
  switch (c.name) {
    case "want": values = [f.want]; break; case "version": values = [f.version]; break; case "receiver": values = [f.receiver]; break;
    case "auctions": values = [1791514943n, scales(f).sold, f.available]; break;
    case "getAmountNeeded": values = [contractCost(f, c.args[1])]; break;
    case "available": values = [f.rawPrice / scales(f).want > 0n ? f.available : 0n]; break;
    case "getAllEnabledAuctions": values = [[f.sold]]; break;
    case "decimals": values = [r.to.toLowerCase() === f.want ? f.wantDecimals : f.soldDecimals]; break;
    default: throw new Error("unexpected fixture call " + c.name);
  }
  return returned(r.id, ABI.encodeFunctionResult(c.signature, values));
}); }
function effects(f: Fixture, p: any, request: AdapterRequest): AdapterRequestResult {
  const index = Number(request.id.slice(request.id.lastIndexOf("-") + 1)), q = samples(p)[index];
  const program = p.phase === "program";
  const r: any = { ...returned(request.id, program ? "0x" : ABI.encodeFunctionResult("take(address,uint256,address)", [q.amountOut])), effects: {
    tokenDeltas: [{ token: f.want, account: actor, delta: -q.spent }, { token: f.want, account: f.receiver, delta: q.spent },
      { token: f.sold, account: program ? actor : PROBE_RECEIVER, delta: q.amountOut }, { token: f.sold, account: f.target, delta: -q.amountOut }],
    nativeDeltas: [{ account: actor, delta: 0n }], logs: [] } };
  f.mutate(r); return r;
}
export function attest(f = fixture()) {
  let step: any = { candidate: { candidateKind: "yearn-auction", target: f.target, sold: f.sold }, step: 0 }; const v = identity.variants[0];
  for (let n = 0; n < 5; n++) {
    const declared = declareRequestProgram({ requirements: v.requirements, buildRequests: v.buildRequests, decode: () => null }, step);
    const results = declared.requests.map(r => r.kind === "effect-delta-simulation" ? effects(f, step.evidence, r) : reads(f, [r])[0]);
    step = { ...step, step: n + 1, evidence: v.decode({ step, results }) }; const decision = v.decide(step);
    if (decision.status !== "continue") return { decision, step };
  }
  throw new Error("Yearn auction identity did not finish");
}
export function setup(f = fixture()) {
  const { decision } = attest(f); if (decision.status !== "verified") throw new Error("fixture identity not verified");
  const d = instance.compileDraft(decision.identity), rs = routes.project({ descriptor: d });
  return { d, rs, input: (amountIn: bigint): any => ({ descriptor: d, route: rs[0], amountIn, executor: actor, source, runtimeEvidence: [] }) };
}

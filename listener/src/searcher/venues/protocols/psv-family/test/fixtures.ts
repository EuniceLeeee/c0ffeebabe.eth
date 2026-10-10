import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { ABI, PROBE_RECEIVER, WAD } from "../codec.js";
import { instance } from "../instance.js";
import { identity, probes } from "../identity.js";
import { routes } from "../routes.js";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import { declareRequestProgram } from "../../../adapter-request-program.js";
export const addr = (n: number) => ethers.toBeHex(n, 20), actor = addr(71);
export const source = { number: 26152596, hash: ethers.id("psv-fixture"), generation: 1 };
const template = JSON.parse(readFileSync(new URL("source-runtime.json", import.meta.url), "utf8"));
export function implementationCode(implementation = addr(83)) {
  let code: string = template.implementation;
  for (const offset of [4253, 4473]) code = code.slice(0, 2 + offset * 2) + "0".repeat(24) + implementation.slice(2) + code.slice(2 + (offset + 32) * 2);
  return code;
}
export function fixture() { return { target: addr(81), implementation: addr(83), gem: addr(84), stable: addr(85), treasury: addr(86),
  proxyCode: template.proxy as string, code: implementationCode(), gemCode: "0x6000", stableCode: "0x6001",
  gemDecimals: 6, stableDecimals: 6, paused: false, tin: WAD / 1000n, tout: WAD / 2000n,
  maxPerTransaction: 0n, maxPerBlock: 0n, remaining: ethers.MaxUint256, gemReserve: 10n ** 15n, stableReserve: 10n ** 15n,
  exempt: false, mutate: (_r: any) => {} }; }
export type Fixture = ReturnType<typeof fixture>;
export const returned = (id: string, data: string): AdapterRequestResult => ({ id, ok: true, source, completion: "returned", data,
  provenance: { kind: "synthetic", fingerprint: "psv-contract" } });
export function reads(f: Fixture, requests: readonly AdapterRequest[]): AdapterRequestResult[] { return requests.map(r => {
  if (r.kind === "get-code") return returned(r.id, r.address.toLowerCase() === f.target ? f.proxyCode : r.address.toLowerCase() === f.implementation ? f.code : r.address.toLowerCase() === f.gem ? f.gemCode : f.stableCode);
  if (r.kind === "get-storage") return returned(r.id, ethers.zeroPadValue(f.implementation, 32));
  if (r.kind !== "eth-call") throw Error("unexpected fixture request");
  const c = ABI.parseTransaction({ data: r.data })!; let v: unknown[];
  switch (c.name) {
    case "GEM": v = [f.gem]; break; case "STABLE": v = [f.stable]; break;
    case "gemToWad": v = [10n ** BigInt(18 - f.gemDecimals)]; break;
    case "stableToWad": v = [10n ** BigInt(18 - f.stableDecimals)]; break;
    case "decimals": v = [r.to.toLowerCase() === f.gem ? f.gemDecimals : f.stableDecimals]; break;
    case "paused": case "tin": case "tout": case "treasury": case "maxPerTransaction": case "maxPerBlock": v = [f[c.name]]; break;
    case "getRemainingBlockCapacity": v = [f.remaining]; break;
    case "getReserves": v = [f.stableReserve, f.gemReserve]; break;
    case "whitelist": v = [f.exempt]; break;
    case "previewSellGem": case "previewBuyGem": {
      const sell = c.name === "previewSellGem", wad = c.args[0] * 10n ** BigInt(18 - (sell ? f.gemDecimals : f.stableDecimals));
      const scale = 10n ** BigInt(18 - (sell ? f.stableDecimals : f.gemDecimals));
      const fee = f.exempt ? 0n : wad * (sell ? f.tout : f.tin) / WAD / scale; v = [wad / scale - fee, fee]; break;
    }
    default: throw Error("unexpected fixture call " + c.name);
  }
  return returned(r.id, ABI.encodeFunctionResult(c.name, v));
}); }
function effects(f: Fixture, p: any, request: AdapterRequest): AdapterRequestResult {
  const sample = probes(p).find(x => x.request.id === request.id)!;
  const event = ABI.encodeEventLog(ABI.getEvent("Swap")!, [actor, PROBE_RECEIVER, sample.tokenIn, sample.tokenOut, sample.amount, sample.amountOut, sample.fee]);
  const r: any = { ...returned(request.id, ABI.encodeFunctionResult(sample.fn, [sample.amountOut])), effects: { tokenDeltas: [
    { token: sample.tokenIn, account: actor, delta: -sample.amount }, { token: sample.tokenIn, account: f.target, delta: sample.amount },
    { token: sample.tokenOut, account: PROBE_RECEIVER, delta: sample.amountOut }, { token: sample.tokenOut, account: f.target, delta: -sample.amountOut - sample.fee },
    { token: sample.tokenOut, account: f.treasury, delta: sample.fee }], logs: [{ address: f.target, ...event }] } };
  f.mutate(r); return r;
}
export function attest(f = fixture()) {
  let step: any = { candidate: { candidateKind: "psv", target: f.target }, step: 0 }; const v = identity.variants[0];
  for (let n = 0; n < 4; n++) {
    const declared = declareRequestProgram({ requirements: v.requirements, buildRequests: v.buildRequests, decode: () => null }, step);
    const results = declared.requests.map(r => r.kind === "effect-delta-simulation" ? effects(f, step.evidence, r) : reads(f, [r])[0]);
    step = { ...step, step: n + 1, evidence: v.decode({ step, results }) }; const decision = v.decide(step);
    if (decision.status !== "continue") return { decision, step };
  }
  throw Error("PSV identity did not finish");
}
export function setup(f = fixture()) {
  const { decision } = attest(f); if (decision.status !== "verified") throw Error("fixture identity not verified");
  const d = instance.compileDraft(decision.identity), rs = routes.project({ descriptor: d });
  return { d, rs, input: (amountIn: bigint, index = 0): any => ({ descriptor: d, route: rs[index], amountIn, executor: actor, source, runtimeEvidence: [] }) };
}

import fs from "node:fs";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/vault-spot.production.js";
import { ABI, pair, address } from "../codec.js";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import type { Descriptor, Route } from "../types.js";
export const V = "0x2d0aff409bde00451334011d55c141aff2103744", A = "0x4d224452801aced8b2f0aebe155379bb5d594381", B = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const E = "0x1000000000000000000000000000000000000002", OTHER = "0x1000000000000000000000000000000000000003";
export const ROUTER = "0x13cec16f5a479e6cf28c82fc28183565caad72a9", USDG = "0x790275ef6bdb0142c4068e9343bca9747de2998f";
export const UTILS = "0x73d258969b084bb2c4cffaaee3ebda58fac49305", FEED = "0xfb12632365c6b8dd26ac9aa676d8285a93190d45";
export const SOURCE = { number: 26182689, hash: "0xeb0d092ce871b19f4071115a4816a282864c7adf6e6d9c1971e30c61596aa09c", generation: 1 };
const code = JSON.parse(fs.readFileSync(new URL("./runtime-code.json", import.meta.url), "utf8")).runtime as string;
export const returned = (id: string, data: string): AdapterRequestResult => ({ id, data, ok: true, completion: "returned", source: SOURCE,
  provenance: { kind: "fixture", fingerprint: "0x"+"1".repeat(64) } });
export function answer(r: AdapterRequest, vault=V): AdapterRequestResult {
  if (r.kind === "get-code") return returned(r.id, r.id === "vault-code" ? code : "0x60006000");
  if (r.kind !== "eth-call") throw new Error("fixture unsupported transport");
  const p = ABI.parseTransaction({ data: r.data })!;
  const values: Record<string, unknown> = { isInitialized: true, isSwapEnabled: true, router: ROUTER, usdg: USDG, vaultUtils: UTILS,
    priceFeed: FEED, includeAmmPrice: true, whitelistedTokens: true, tokenDecimals: 18n, decimals: 18n, vault, vaults: true,
    poolAmounts: 1000000n, reservedAmounts: 100n, bufferAmounts: 500n, getPrice: p.args.length > 0 && p.args[0].toString().toLowerCase() === A ? 2n*10n**30n : 4n*10n**30n,
    getSwapFeeBasisPoints: 30n };
  if (!(p.name in values)) throw new Error("fixture unknown function " + p.name);
  return returned(r.id, ABI.encodeFunctionResult(p.name, [values[p.name]]));
}
export function descriptor(vault=V, mutate: (r: AdapterRequestResult)=>AdapterRequestResult = x=>x): Descriptor {
  const p=pair(vault,[A,B]), candidate={ candidateKind: "vault-spot-pair" as const, vault: p.vault, tokens: p.tokens };
  const v=plugin.identity.variants[0]; let evidence: unknown;
  for (let step=0;step<3;step++) {
    const i={candidate,step,evidence}; evidence=v.decode({step:i,results:v.buildRequests(i).map(r=>mutate(answer(r,vault)))});
  }
  const result=v.decide({candidate,step:3,evidence});
  if(result.status!=="verified") throw new Error("fixture identity not verified: "+result.status);
  const draft=plugin.instance.compileDraft(result.identity);
  return plugin.instance.finalizeDescriptor({identity:result.identity,draft,sharedBindings:[]});
}
export function inputFor(d=descriptor(), r?: Route, value=91n) {
  return { descriptor:d,route:r??plugin.routes.project({descriptor:d})[0],amountIn:value,source:SOURCE,executor:E,runtimeEvidence:[] };
}
export function receipt(d:Descriptor,r:Route,value:bigint,out=97n):AdapterRequestResult {
  const log=ABI.encodeEventLog(ABI.getEvent("Swap")!,[E,r.tokenIn,r.tokenOut,value,out,out,0n]);
  return { ...returned("spot-exact","0x"), ok:true, completion:"returned", data:"0x", source:SOURCE,
    provenance:{kind:"fixture",fingerprint:"0x"+"1".repeat(64)},effects:{
      tokenDeltas:[{token:r.tokenIn,account:E,delta:-value},{token:r.tokenIn,account:d.vault,delta:value},
        {token:r.tokenOut,account:E,delta:out},{token:r.tokenOut,account:d.vault,delta:-out}],
      totalSupplyDeltas:[{token:r.tokenIn,delta:0n},{token:r.tokenOut,delta:0n}],nativeDeltas:[{account:E,delta:0n}],
      logs:[{address:d.vault,...log}],
    } };
}

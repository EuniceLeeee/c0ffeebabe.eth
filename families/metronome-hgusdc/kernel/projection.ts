import type { Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { MetronomeHgUsdcProjectionV1 } from "../src/types.ts";
const a=(v:string)=>{if(!/^0x[0-9a-fA-F]{40}$/.test(v))throw new TypeError("invalid address");return v.toLowerCase()};
export function metronomeHgUsdcProjection(i:{router:string;curve:string;vault:string;tokenIn:string;curveIntermediate:string;tokenOut:string;pathHash:Hash}): MetronomeHgUsdcProjectionV1 { return Object.freeze({router:a(i.router),curve:a(i.curve),vault:a(i.vault),tokenIn:a(i.tokenIn),curveIntermediate:a(i.curveIntermediate),tokenOut:a(i.tokenOut),curveDirection:Object.freeze([1,0] as const),pathHash:i.pathHash,quoteChain:"curve-get-dy->vault-preview-redeem-v1"}); }

import { ethers } from "ethers";
import { explicitReverseBindingUnsupported, type DiscoverySemantics, type CaptureNominationSemantics, type UnifiedObservation } from "../../adapter-family-plugin.js";
import { ABI, FUNCTIONS, address } from "./codec.js";
import { FAMILY, ACTION } from "./manifest.js";
import { POOL_HASH, proveCode } from "./model.js";
import type { Candidate } from "./types.js";
const SURFACE = "curve-lp:stableswap2-source";
const EVENTS = ["AddLiquidity", "RemoveLiquidityOne", "TokenExchange"] as const;
const nominate: CaptureNominationSemantics = { async nominate({ nominations, provider, source }) {
  const out: UnifiedObservation[] = [];
  for (const n of nominations) { const o = n.opaque as Record<string, unknown> | undefined;
    if (!o || ![o.familyId, o.adapter, o.adapterId].some(v => [FAMILY, ACTION].includes(String(v)))) continue;
    const pool = address(n.address), code = await provider.getCode(pool, source.number); proveCode(code, POOL_HASH);
    out.push({ kind: "address-surface", source, address: pool, codeHash: ethers.keccak256(code), implementationWord: ethers.ZeroHash, interfaceFingerprints: [SURFACE] });
  } return out;
} };
export const discovery = { evidenceChannel: "nominate", txSeedNominations: true,
  sources: ["observed-call", "landed-log", "address-surface"],
  callPatterns: FUNCTIONS.map(fn => ({ id: `curve-lp-${fn}`, selector: ABI.getFunction(fn)!.selector as `0x${string}`,
    signature: ABI.getFunction(fn)!.format("sighash"), candidateAddress: { from: "call-target" as const } })),
  logPatterns: EVENTS.map(fn => ({ id: `curve-lp-${fn}`, topic: ABI.getEvent(fn)!.topicHash as `0x${string}`, signature: ABI.getEvent(fn)!.format("sighash") })),
  addressSurfaces: [{ id: "curve-lp-source", kind: "interface", fingerprint: SURFACE }],
  decodeCandidate({ observation: o, matchedPatternId: id }) {
    try {
      let pool: string;
      if (o.kind === "call" && FUNCTIONS.some(fn => id === `curve-lp-${fn}`)) { const fn = id.slice(9), args = ABI.decodeFunctionData(fn, o.data);
        if (ABI.encodeFunctionData(fn, args).toLowerCase() !== o.data.toLowerCase()) return null; pool = address(o.target);
      } else if (o.kind === "log" && EVENTS.some(fn => id === `curve-lp-${fn}`)) { const fn = id.slice(9), args = ABI.decodeEventLog(fn, o.data, [...o.topics]);
        const e = ABI.encodeEventLog(ABI.getEvent(fn)!, args);
        if (e.data.toLowerCase() !== o.data.toLowerCase() || e.topics.length !== o.topics.length || e.topics.some((v, i) => v.toLowerCase() !== o.topics[i].toLowerCase())) return null;
        pool = address(o.address);
      } else if (o.kind === "address-surface" && id === "curve-lp-source") pool = address(o.address);
      else return null;
      return { candidateKind: "curve-lp" as const, pool };
    } catch { return null; }
  }, candidateKey: c => address(c.pool), instanceNominationKey: c => address((c as Candidate).pool), nominate,
  reverseBinding: explicitReverseBindingUnsupported("direct pool logs/calls nominate; identity reverse-verifies registry and LP minter, no factory creation claim"),
} satisfies DiscoverySemantics<Candidate>;

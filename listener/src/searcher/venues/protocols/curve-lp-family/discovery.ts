import { GENERIC_CALLS, GENERIC_EVENTS } from "./generic.js";
import { ethers } from "ethers";
import { explicitReverseBindingUnsupported, type DiscoverySemantics, type CaptureNominationSemantics, type UnifiedObservation } from "../../adapter-family-plugin.js";
import { ABI, FUNCTIONS, address } from "./codec.js";
import { FAMILY, ACTION } from "./manifest.js";
import { NG_CALLS, NG_EVENTS } from "./ng.js";
import type { Candidate } from "./types.js";
const SURFACE = "curve-lp:stableswap2-source";
const EVENTS = ["AddLiquidity", "RemoveLiquidityOne", "TokenExchange"] as const;
const nominate: CaptureNominationSemantics = { async nominate({ nominations, provider, source }) {
  const out: UnifiedObservation[] = [];
  for (const n of nominations) { const o = n.opaque as Record<string, unknown> | undefined;
    if (!o || ![o.familyId, o.adapter, o.adapterId].some(v => [FAMILY, ACTION].includes(String(v)))) continue;
    const pool = address(n.address), code = await provider.getCode(pool, source.number);
    out.push({ kind: "address-surface", source, address: pool, codeHash: ethers.keccak256(code), implementationWord: ethers.ZeroHash, interfaceFingerprints: [SURFACE] });
  } return out;
} };
export const discovery = { evidenceChannel: "nominate", txSeedNominations: true,
  sources: ["observed-call", "landed-log", "address-surface"],
  callPatterns: [...GENERIC_CALLS.map(({ id, abi, fn }) => ({ id: `curve-lp-g-${id}`, selector: abi.getFunction(fn)!.selector as `0x${string}`,
    signature: abi.getFunction(fn)!.format("sighash"), candidateAddress: { from: "call-target" as const } })),...NG_CALLS.map(({ id, abi, fn }) => ({ id: `curve-lp-ng-${id}`, selector: abi.getFunction(fn)!.selector as `0x${string}`,
    signature: abi.getFunction(fn)!.format("sighash"), candidateAddress: { from: "call-target" as const } })), ...FUNCTIONS.map(fn => ({ id: `curve-lp-${fn}`, selector: ABI.getFunction(fn)!.selector as `0x${string}`,
    signature: ABI.getFunction(fn)!.format("sighash"), candidateAddress: { from: "call-target" as const } }))],
  logPatterns: [...GENERIC_EVENTS.map(({ id, abi, fn }) => ({ id: `curve-lp-g-${id}`, topic: abi.getEvent(fn)!.topicHash as `0x${string}`, signature: abi.getEvent(fn)!.format("sighash") })),...["AddLiquidity", "RemoveLiquidityOne"].map(fn => ({ id: `curve-lp-ng-${fn}`, topic: NG_EVENTS.getEvent(fn)!.topicHash as `0x${string}`, signature: NG_EVENTS.getEvent(fn)!.format("sighash") })), ...EVENTS.map(fn => ({ id: `curve-lp-${fn}`, topic: ABI.getEvent(fn)!.topicHash as `0x${string}`, signature: ABI.getEvent(fn)!.format("sighash") }))],
  addressSurfaces: [{ id: "curve-lp-source", kind: "interface", fingerprint: SURFACE }],
  decodeCandidate({ observation: o, matchedPatternId: id }) {
    try {
      let pool: string;
      if (o.kind === "call" && GENERIC_CALLS.some(v => id === `curve-lp-g-${v.id}`)) { const v = GENERIC_CALLS.find(v => id === `curve-lp-g-${v.id}`)!, args = v.abi.decodeFunctionData(v.fn, o.data);
        if (v.abi.encodeFunctionData(v.fn, args).toLowerCase() !== o.data.toLowerCase()) return null; pool = address(o.target);
      } else if (o.kind === "log" && GENERIC_EVENTS.some(v => id === `curve-lp-g-${v.id}`)) { const v = GENERIC_EVENTS.find(v => id === `curve-lp-g-${v.id}`)!, args = v.abi.decodeEventLog(v.fn, o.data, [...o.topics]), e = v.abi.encodeEventLog(v.abi.getEvent(v.fn)!, args);
        if (e.data.toLowerCase() !== o.data.toLowerCase() || e.topics.length !== o.topics.length || e.topics.some((t, i) => t.toLowerCase() !== o.topics[i].toLowerCase())) return null; pool = address(o.address);
      } else if (o.kind === "call" && NG_CALLS.some(v => id === `curve-lp-ng-${v.id}`)) { const v = NG_CALLS.find(v => id === `curve-lp-ng-${v.id}`)!, args = v.abi.decodeFunctionData(v.fn, o.data);
        if (v.abi.encodeFunctionData(v.fn, args).toLowerCase() !== o.data.toLowerCase()) return null; pool = address(o.target);
      } else if (o.kind === "call" && FUNCTIONS.some(fn => id === `curve-lp-${fn}`)) { const fn = id.slice(9), args = ABI.decodeFunctionData(fn, o.data);
        if (ABI.encodeFunctionData(fn, args).toLowerCase() !== o.data.toLowerCase()) return null; pool = address(o.target);
      } else if (o.kind === "log" && ["AddLiquidity", "RemoveLiquidityOne"].some(fn => id === `curve-lp-ng-${fn}`)) { const fn = id.slice(12), args = NG_EVENTS.decodeEventLog(fn, o.data, [...o.topics]);
        const e = NG_EVENTS.encodeEventLog(NG_EVENTS.getEvent(fn)!, args);
        if (e.data.toLowerCase() !== o.data.toLowerCase() || e.topics.length !== o.topics.length || e.topics.some((v, i) => v.toLowerCase() !== o.topics[i].toLowerCase())) return null; pool = address(o.address);
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

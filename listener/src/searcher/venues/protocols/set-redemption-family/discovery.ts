import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { MODULE, MODULE_CODE_HASH, address, uint } from "./codec.js";
import { bindingObservation, nomination, SURFACE } from "./nomination.js";
import type { Candidate } from "./types.js";
import { decodeLegacyCandidate, legacyCallPatterns, legacyLogPatterns } from "./legacy.js";
export const discovery = {
  evidenceChannel: "nominate", sources: ["landed-log", "observed-call", "address-surface"],
  addressSurfaces: [{ id: "set-binding", kind: "interface", fingerprint: SURFACE }],
  logPatterns: [{ id: "set-redeemed", topic: MODULE.getEvent("SetTokenRedeemed")!.topicHash as `0x${string}`, signature: "SetTokenRedeemed(address,address,address,uint256)" }, ...legacyLogPatterns],
  callPatterns: [{ id: "set-redeem-call", selector: MODULE.getFunction("redeem")!.selector as `0x${string}`,
    signature: "redeem(address,uint256,address)", candidateAddress: { from: "call-target" } }, ...legacyCallPatterns],
  decodeCandidate({ observation: o, matchedPatternId: id }) {
    if (id.startsWith("legacy-")) return decodeLegacyCandidate(o, id);
    try {
      let set: string, module: string;
      if (o.kind === "call" && id === "set-redeem-call") {
        const v = MODULE.decodeFunctionData("redeem", o.data);
        if (MODULE.encodeFunctionData("redeem", v).toLowerCase() !== o.data.toLowerCase() || uint(v[1]) === 0n) return null;
        set = address(v[0]); module = address(o.target); address(v[2]);
      } else if (o.kind === "log" && id === "set-redeemed") {
        const e = MODULE.getEvent("SetTokenRedeemed")!, v = MODULE.decodeEventLog(e, o.data, [...o.topics]);
        const encoded = MODULE.encodeEventLog(e, v);
        if (encoded.data.toLowerCase() !== o.data.toLowerCase() || encoded.topics.length !== o.topics.length ||
          encoded.topics.some((t, i) => t.toLowerCase() !== o.topics[i].toLowerCase()) || uint(v[3]) === 0n) return null;
        set = address(v[0]); module = address(o.address); address(v[1]); address(v[2]);
      } else if (o.kind === "address-surface" && id === "set-binding" && o.codeHash.toLowerCase() === MODULE_CODE_HASH) {
        const b = o.opaque as { set?: string; module?: string } | undefined;
        if (!b?.set || !b.module) return null;
        set = address(b.set); module = address(b.module); if (module !== address(o.address)) return null;
      } else return null;
      return set === module ? null : { candidateKind: "set-redemption", set, module };
    } catch { return null; }
  },
  candidateKey: c => `${address(c.set)}:${address(c.module)}`,
  instanceNominationKey: c => { const v = c as Candidate; return `${address(v.set)}:${address(v.module)}`; },
  nominate: nomination,
  reverseBinding: { kind: "implementation", async reverseBinding({ nominations, provider, source }) {
    return Promise.all(nominations.map(async n => { try { const observation = await bindingObservation(n, provider, source);
      return observation ? { status: "verified" as const, observation } : { status: "unsupported" as const, reason: "Set/module binding not established" };
    } catch { return { status: "failed" as const, reason: "Set/module binding read unavailable" }; } }));
  } },
} satisfies DiscoverySemantics<Candidate>;

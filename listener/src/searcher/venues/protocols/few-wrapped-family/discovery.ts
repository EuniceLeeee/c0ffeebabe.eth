import { explicitReverseBindingUnsupported,type DiscoverySemantics } from "../../adapter-family-plugin.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";
import { ABI,address,amount } from "./codec.js";
import type { Candidate } from "./types.js";
const calls=["wrap","unwrap","wrapTo","unwrapTo"] as const;
export const discovery = {
  evidenceChannel:"nominate",txSeedNominations:true,sources:["observed-call","landed-log","address-surface"],
  callPatterns:calls.map(fn=>({id:`few-${fn}-call`,selector:ABI.getFunction(fn)!.selector as `0x${string}`,
    signature:`${fn}(uint256${fn.endsWith("To")?",address":""})`,candidateAddress:{from:"call-target" as const}})),
  logPatterns:["Wrap","Unwrap"].map(fn=>({id:`few-${fn}-log`,topic:ABI.getEvent(fn)!.topicHash as `0x${string}`,signature:`${fn}(address,uint256,address)`})),
  addressSurfaces:[{id:"few-wrapper-surface",kind:"interface",fingerprint:"few-factory-wrapper-v1"}],
  decodeCandidate({observation:o,matchedPatternId:id}) {
    try {
      if(o.kind==="call") {
        const fn=calls.find(fn=>id===`few-${fn}-call`);if(!fn)return null;
        const args=ABI.decodeFunctionData(fn,o.data);amount(BigInt(args[0]));if(fn.endsWith("To"))address(args[1]);
        if(ABI.encodeFunctionData(fn,args).toLowerCase()!==o.data.toLowerCase())return null;
        return {candidateKind:"few-wrapper" as const,target:address(o.target)};
      }
      if(o.kind==="log") {
        const fn=["Wrap","Unwrap"].find(fn=>id===`few-${fn}-log`);if(!fn)return null;
        const e=ABI.decodeEventLog(fn,o.data,[...o.topics]);amount(BigInt(e.amount));address(e.sender);address(e.to);
        return {candidateKind:"few-wrapper" as const,target:address(o.address)};
      }
      return o.kind==="address-surface"&&id==="few-wrapper-surface"?{candidateKind:"few-wrapper" as const,target:address(o.address)}:null;
    } catch{return null;}
  },
  candidateKey:c=>c.target.toLowerCase(),
  nominate:createAddressSurfaceNomination({opaqueLabels:["few-wrapped","protocol:few-wrapped"],interfaceFingerprints:["few-factory-wrapper-v1"]}),
  reverseBinding:explicitReverseBindingUnsupported("Fresh address nomination re-runs the factory reverse membership proof; no separate retained creation lookup."),
} satisfies DiscoverySemantics<Candidate>;

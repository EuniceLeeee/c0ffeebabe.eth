import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import { assertSameSource,callRequest,codeRequest,decodeAddress,returnedResult } from "../standard-family/common.js";
import { ABI,address,WRAPPER_CODE_HASH,currentRequests,decodeBinding,probeAmount } from "./codec.js";
import { conversionRequest,decodeReceipt,simulationRequirements } from "./simulation.js";
import { FAMILY,LINEAGE } from "./manifest.js";
import type { Candidate,Identity,Binding } from "./types.js";
type State = {phase:"unsupported"}|{phase:"code"}|{phase:"surface";target:string;asset:string;factory:string}|
  {phase:"binding";binding:Binding;sample:bigint}|{phase:"verified";binding:Binding;proofHash:string};
export const identity = {
  memoReuse:"recheck-identity",
  variants:[{
    id:"factory-wrapper-effects",kind:"factory-child",lineageId:LINEAGE,
    applies:c=>c.candidateKind==="few-wrapper",
    requirements({evidence}) {
      const p=evidence as State|undefined;
      if(!p)return {transports:["get-code"]};
      if(p.phase==="code")return {transports:["eth-call"]};
      if(p.phase==="surface")return {transports:["get-code","eth-call"]};
      return simulationRequirements;
    },
    buildRequests({candidate,evidence}) {
      const p=evidence as State|undefined;
      if(!p)return [codeRequest("few-code",candidate.target)];
      if(p.phase==="code")return [callRequest("few-factory",candidate.target,ABI.encodeFunctionData("factory")),
        callRequest("few-asset",candidate.target,ABI.encodeFunctionData("token"))];
      if(p.phase==="surface")return currentRequests(p);
      if(p.phase==="binding"&&p.sample>0n)return [conversionRequest("few-probe-wrap",p.binding,"wrap",p.sample),conversionRequest("few-probe-unwrap",p.binding,"unwrap",p.sample)];
      return [];
    },
    decode({step,results}):State {
      const p=step.evidence as State|undefined;
      assertSameSource(results.map(r=>returnedResult(results,r.id)));
      if(!p)return ethers.keccak256(returnedResult(results,"few-code").data)===WRAPPER_CODE_HASH?{phase:"code"}:{phase:"unsupported"};
      if(p.phase==="code")return {phase:"surface",target:address(step.candidate.target),
        asset:address(decodeAddress(ABI,"token",results,"few-asset")),factory:address(decodeAddress(ABI,"factory",results,"few-factory"))};
      if(p.phase==="surface")return {phase:"binding",binding:decodeBinding(p,results),sample:probeAmount(results)};
      if(p.phase!=="binding")throw new Error("few unexpected identity state");
      const wrap=decodeReceipt(results,"few-probe-wrap",p.binding,"wrap",p.sample);
      const unwrap=decodeReceipt(results,"few-probe-unwrap",p.binding,"unwrap",p.sample,wrap.actor);
      return {phase:"verified",binding:p.binding,proofHash:hashCanonical({binding:{...p.binding},sample:p.sample,wrap:{...wrap,source:{...wrap.source}},unwrap:{...unwrap,source:{...unwrap.source}}})};
    },
    decide({evidence}) {
      const p=evidence as State|undefined;
      if(p?.phase==="unsupported")return {status:"chain-proven-rejected",reasonCode:"few_wrapper_runtime_unsupported",evidenceRequestIds:["few-code"]};
      if(p?.phase==="binding"&&p.sample===0n)return {status:"retryable",reasonCode:"few_no_backed_probe_capacity"};
      if(p?.phase!=="verified")return {status:"continue"};
      return {status:"verified",identity:{...p.binding,familyId:FAMILY,lineageId:LINEAGE,subject:p.binding.target,
        provenance:[{kind:"factory-wrapper-reverse-binding-and-effects",subject:p.binding.factory,evidenceHash:p.proofHash}]}};
    },
  }],
  identityKey:i=>i.target.toLowerCase(),
} satisfies IdentitySemantics<Candidate,Identity>;

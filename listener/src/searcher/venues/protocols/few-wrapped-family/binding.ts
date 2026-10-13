import { hashCanonical } from "../../canonical-value.js";
import { assertRouteBound,sameAddress } from "../standard-family/common.js";
import { address,WRAPPER_CODE_HASH } from "./codec.js";
import { FAMILY,LINEAGE } from "./manifest.js";
import type { Descriptor,Route } from "./types.js";
export function projection(d:Descriptor) {
  return {target:address(d.target).toLowerCase(),asset:address(d.asset).toLowerCase(),factory:address(d.factory).toLowerCase(),
    codeHash:d.codeHash,assetCodeHash:d.assetCodeHash,factoryCodeHash:d.factoryCodeHash,semantics:"few-backed-wrap-v1"};
}
export function assertInvocation(d:Descriptor,r:Route) {
  assertRouteBound({descriptorInstanceKey:d.instanceKey,descriptorTarget:d.target,route:r,bindingFingerprint:hashCanonical(projection(d))});
  if(d.familyId!==FAMILY||r.familyId!==FAMILY||d.lineageId!==LINEAGE||r.lineageId!==LINEAGE||d.codeHash!==WRAPPER_CODE_HASH||
    !["wrap","unwrap"].includes(r.direction)||r.adapterId!==`few-${r.direction}`||
    !sameAddress(r.tokenIn,r.direction==="wrap"?d.asset:d.target)||!sameAddress(r.tokenOut,r.direction==="wrap"?d.target:d.asset))
    throw new Error("few route binding mismatch");
}

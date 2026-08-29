import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { canonicalAddress, type UniV3ActionV1, type UniV3ExecutionIntentV1, type UniV3IdentityV1 } from "./types.ts";

export function compileUniV3Execution(input: { readonly identity: UniV3IdentityV1; readonly action: UniV3ActionV1 }): UniV3ExecutionIntentV1 {
  if (input.action.target !== canonicalAddress(input.identity.instanceKey)) throw new TypeError("univ3 execution target mismatch");
  if (input.action.cutoff.number !== input.identity.cutoff.number) throw new TypeError("univ3 execution cutoff mismatch");
  return Object.freeze({ kind: "univ3-execution-intent", cutoff: input.action.cutoff, target: input.action.target, calldata: input.action.calldata, actionHash: input.action.actionHash, exactQuoteHash: input.action.exactQuoteHash });
}

export function executionIntentHash(intent: UniV3ExecutionIntentV1): Hash {
  return hashDomain("aloha/univ3-standard/execution-intent/v1", intent);
}

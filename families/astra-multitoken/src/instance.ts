import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { instanceNominationKey } from "./discovery.ts";
import type { AstraIdentityV1, AstraInstanceV1 } from "./types.ts";

export function compileAstraInstance(identity: AstraIdentityV1): AstraInstanceV1 {
  if (instanceNominationKey(identity) !== identity.instanceKey) throw new TypeError("astra identity nomination key mismatch");
  return Object.freeze({
    familyId: "astra-multitoken",
    instanceKey: identity.instanceKey,
    target: identity.target,
    identity,
    runtimeRequirements: Object.freeze(["pinned-cutoff-source", "observed-sender-inner-call", "return-data", "token-delta", "logs"]),
  });
}

export function rehydrateAstraInstance(instance: AstraInstanceV1): AstraInstanceV1 {
  if (instance.familyId !== "astra-multitoken" || instanceNominationKey(instance) !== instance.instanceKey || instance.identity.instanceKey !== instance.instanceKey || instance.identity.target !== instance.target) {
    throw new TypeError("astra instance rehydration binding mismatch");
  }
  return compileAstraInstance(instance.identity);
}

export function astraInstanceDescriptorHash(instance: AstraInstanceV1): Hash {
  return hashDomain("aloha/astra-multitoken/instance-descriptor/v1", { target: instance.target, factsHash: instance.identity.factsHash, runtimeRequirements: instance.runtimeRequirements });
}

import { types as nodeTypes } from "node:util";
import { CANONICAL_LIMITS } from "../../../../packages/canonical-codec/src/index.ts";
import type { PredicateDomainMaterialCapabilityV1 } from "../material-provider.ts";
import {
  registerPredicateDomainMaterialCapabilityV1,
  type PredicateDomainMaterialStateV1,
} from "./predicate-domain-material-state.ts";

export function issuePredicateDomainMaterialCapabilityV1(
  state: PredicateDomainMaterialStateV1,
): PredicateDomainMaterialCapabilityV1 {
  let storedState: PredicateDomainMaterialStateV1;
  if (state.status === "available") {
    const facts = state.predicateFacts;
    if (facts !== null && typeof facts === "object" && nodeTypes.isProxy(facts)) {
      throw new TypeError("predicate domain material facts must not be a Proxy");
    }
    if (!Array.isArray(facts)) throw new TypeError("predicate domain material facts must be an array");
    const length = Object.getOwnPropertyDescriptor(facts, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > CANONICAL_LIMITS.maxArrayItems) {
      throw new TypeError("predicate domain material facts array length invalid");
    }
    const keys = Reflect.ownKeys(facts);
    if (keys.length !== length + 1
      || keys.some(key => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
      throw new TypeError("predicate domain material facts must be a dense exact array");
    }
    const copiedFacts: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(facts, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`predicate domain material fact ${index} must be an enumerable data property`);
      }
      copiedFacts.push(descriptor.value);
    }
    storedState = Object.freeze({
      status: "available",
      predicateId: state.predicateId,
      candidateReleaseCommit: state.candidateReleaseCommit,
      artifactRefs: Object.freeze([...state.artifactRefs]),
      artifactClaims: Object.freeze([...state.artifactClaims]),
      resolverPolicies: Object.freeze([...state.resolverPolicies]),
      retentionLeases: Object.freeze([...state.retentionLeases]),
      predicateFacts: Object.freeze(copiedFacts),
    });
  } else {
    storedState = Object.freeze({
      status: state.status,
      predicateId: state.predicateId,
      code: state.code,
      evidenceRoot: state.evidenceRoot,
    });
  }
  return registerPredicateDomainMaterialCapabilityV1(storedState);
}

import {
  assertHash,
  assertNonEmptyString,
} from "../../../canonical-codec/src/index.ts";
import type {
  FinalSimulationSchedulerJoinSeedV1,
  SearchSchedulerResourceJoinCapabilityV1,
  SearchSchedulerResourceJoinV1,
  UnsignedDryRunReceiptV1,
} from "../index.ts";

const issued = new WeakMap<object, SearchSchedulerResourceJoinV1>();

/** Search-pipeline owner only: issue after the unsigned lineage was validated. */
export function issueSearchSchedulerResourceJoin(
  seed: FinalSimulationSchedulerJoinSeedV1,
  receipt: UnsignedDryRunReceiptV1,
): SearchSchedulerResourceJoinCapabilityV1 {
  if (seed.schedulerCompletion === null || typeof seed.schedulerCompletion !== "object") {
    throw new TypeError("final simulation scheduler completion handle is invalid");
  }
  const value = Object.freeze({
    correlationId: assertHash(seed.correlationId, "schedulerResourceJoin.correlationId"),
    generationId: assertNonEmptyString(seed.generationId, "schedulerResourceJoin.generationId"),
    source: Object.freeze({ ...seed.source }),
    programHash: assertHash(seed.programHash, "schedulerResourceJoin.programHash"),
    finalSimulationReceiptHash: assertHash(seed.finalSimulationReceiptHash, "schedulerResourceJoin.finalSimulationReceiptHash"),
    unsignedDryRunCandidateId: assertHash(receipt.candidateId, "schedulerResourceJoin.unsignedDryRunCandidateId"),
    unsignedDryRunLineageHash: assertHash(receipt.lineageHash, "schedulerResourceJoin.unsignedDryRunLineageHash"),
    schedulerCompletion: seed.schedulerCompletion,
  });
  const capability = Object.freeze(Object.create(null)) as SearchSchedulerResourceJoinCapabilityV1;
  issued.set(capability, value);
  return capability;
}

/** Route-terminal owner only: public consumers must use the terminal-bound reader. */
export function readSearchSchedulerResourceJoin(
  capability: SearchSchedulerResourceJoinCapabilityV1,
): SearchSchedulerResourceJoinV1 {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("search scheduler resource join capability is required");
  }
  const value = issued.get(capability);
  if (value === undefined) throw new TypeError("search scheduler resource join capability was not issued");
  return value;
}

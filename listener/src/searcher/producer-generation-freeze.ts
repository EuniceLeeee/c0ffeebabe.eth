/**
 * A producer may consume current-source pricing for the immutable startup-ready
 * topology, but it can never publish discovery, backfill, trace or topology.
 */
export function assertProducerGenerationPublicationAllowed(
  producerGenerationFrozen: boolean,
): void {
  if (producerGenerationFrozen) {
    throw new Error(
      "producer generation freeze forbids discovery/topology publication",
    );
  }
}

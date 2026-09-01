import type { CheckpointSixStepArtifactPortV1 } from "../index.ts";

const issued = new WeakSet<object>();

export function issueCheckpointSixStepArtifactPortV1(
  port: CheckpointSixStepArtifactPortV1,
): CheckpointSixStepArtifactPortV1 {
  if (port === null || typeof port !== "object"
    || typeof port.emitVerifiedOutcome !== "function"
    || typeof port.emitReadyEdge !== "function") {
    throw new TypeError("checkpoint Six-Step artifact port is incomplete");
  }
  issued.add(port);
  return port;
}

export function assertCheckpointSixStepArtifactPortV1(
  value: unknown,
): asserts value is CheckpointSixStepArtifactPortV1 {
  if (value === null || typeof value !== "object" || !issued.has(value)) {
    throw new TypeError("checkpoint Six-Step artifact port is not runtime-owner-issued");
  }
}

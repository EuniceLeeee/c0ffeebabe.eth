import type { CanonicalJsonObject, Hash } from "../../../../packages/canonical-codec/src/index.ts";
import {
  createPerformanceEvent,
  createPerformanceFactEnvelope,
  encodePerformanceEvent,
  encodeProductionPerformanceProfile,
  PERFORMANCE_EVENT_SCHEMA_MANIFEST,
  PERFORMANCE_PROFILE_SCHEMA_MANIFEST,
  type PerformanceEventV1,
  type PerformanceFactBundleV1,
} from "../../../performance-facts/src/schema.ts";
import { readProductionPredicateMaterialSourceStateV1 } from "../internal/predicate-material-source-owner.ts";
import type { ObservedContentArtifactV1 } from "../content-addressed-sink.ts";
import { available, defineProvider, unavailable } from "./shared.ts";

const PREDICATE_ID = "aloha.performance.facts";

function events(bundle: PerformanceFactBundleV1): readonly PerformanceEventV1[] {
  const entries: Array<Readonly<{ readonly eventType: PerformanceEventV1["eventType"]; readonly payload: object }>> = [
    { eventType: "window-commitment", payload: bundle.commitment },
    ...bundle.heads.map(payload => ({ eventType: "eligible-head" as const, payload })),
    ...bundle.lineages.map(payload => ({ eventType: "orphan-replacement" as const, payload })),
    ...bundle.candidateSets.map(payload => ({ eventType: "candidate-set" as const, payload })),
    ...bundle.candidateTerminals.map(payload => ({ eventType: "candidate-terminal" as const, payload })),
    ...bundle.metrics.map(payload => ({ eventType: "metric-sample" as const, payload })),
    ...bundle.terminals.map(payload => ({ eventType: "head-terminal" as const, payload })),
    ...bundle.generationSegments.map(payload => ({ eventType: "generation-segment" as const, payload })),
    { eventType: "window-receipt", payload: bundle.windowReceipt },
  ];
  return Object.freeze(entries.map((entry, index) => createPerformanceEvent({
    eventType: entry.eventType,
    sequence: index.toString(),
    windowId: bundle.commitment.windowId,
    payload: entry.payload as unknown as CanonicalJsonObject,
  })));
}

export const PERFORMANCE_MATERIAL_PROVIDER = defineProvider(PREDICATE_ID, async source => {
  const state = readProductionPredicateMaterialSourceStateV1(source);
  if (state.observePerformance === null) {
    return unavailable(PREDICATE_ID, "missing", "owner-port-missing", "performance-readonly-sqlite");
  }
  const observed = state.observePerformance() as Readonly<
    | {
      readonly status: "available";
      readonly qualifiedObservationId: Hash;
      readonly observation: unknown;
    }
    | {
      readonly status: "missing";
      readonly qualification: "unqualified";
      readonly reasons?: readonly string[];
    }
    | {
      readonly status: "invalid";
      readonly reasons?: readonly string[];
    }
  >;
  if (observed === null || typeof observed !== "object") {
    return unavailable(PREDICATE_ID, "invalid", "owner-material-invalid", "qualified-observation-read");
  }
  if (observed.status === "missing" && observed.qualification === "unqualified") {
    return unavailable(PREDICATE_ID, "missing", "owner-material-missing", observed.reasons ?? "qualified-performance-observation-missing");
  }
  if (observed.status === "invalid") {
    return unavailable(PREDICATE_ID, "invalid", "owner-material-invalid", observed.reasons ?? "qualified-observation-invalid");
  }
  if (observed.status !== "available"
    || typeof observed.qualifiedObservationId !== "string"
    || !/^0x[0-9a-f]{64}$/.test(observed.qualifiedObservationId)) {
    return unavailable(PREDICATE_ID, "invalid", "owner-material-invalid", "qualified-observation-id");
  }
  const raw = observed.observation as Readonly<{
    readonly status: "raw-complete" | "incomplete" | "invalid";
    readonly reasons: readonly string[];
    readonly release: Readonly<{ readonly candidateReleaseCommit: string }> | null;
    readonly bundle: PerformanceFactBundleV1 | null;
  }>;
  if (raw === null || typeof raw !== "object") {
    return unavailable(PREDICATE_ID, "invalid", "owner-material-invalid", "performance-observation");
  }
  if (raw.status !== "raw-complete" || raw.bundle === null || raw.release === null) {
    return unavailable(PREDICATE_ID, raw.status === "invalid" ? "invalid" : "missing", raw.status === "invalid" ? "owner-material-invalid" : "owner-material-missing", raw.reasons);
  }
  try {
    const profile = await state.sink.write({
      bytes: encodeProductionPerformanceProfile(raw.bundle.profile),
      mediaType: "application/json",
      schema: PERFORMANCE_PROFILE_SCHEMA_MANIFEST,
    });
    const eventArtifacts: Array<Readonly<{ readonly event: PerformanceEventV1; readonly artifact: ObservedContentArtifactV1 }>> = [];
    for (const event of events(raw.bundle)) {
      eventArtifacts.push(Object.freeze({
        event,
        artifact: await state.sink.write({
          bytes: encodePerformanceEvent(event),
          mediaType: "application/json",
          schema: PERFORMANCE_EVENT_SCHEMA_MANIFEST,
        }),
      }));
    }
    const artifacts = [profile, ...eventArtifacts.map(value => value.artifact)];
    return available(
      PREDICATE_ID,
      raw.release.candidateReleaseCommit,
      artifacts,
      [state.sink.resolverPolicy],
      Object.freeze([
        createPerformanceFactEnvelope({
          factType: "profile",
          sequence: null,
          artifactRefId: profile.ref.artifactRefId,
          claimId: profile.claim.claimId,
          observationId: observed.qualifiedObservationId,
          contentSha256: profile.contentSha256,
          byteLength: profile.ref.byteLength,
        }),
        ...eventArtifacts.map(({ event, artifact }) => createPerformanceFactEnvelope({
          factType: "event",
          sequence: event.sequence,
          artifactRefId: artifact.ref.artifactRefId,
          claimId: artifact.claim.claimId,
          observationId: observed.qualifiedObservationId,
          contentSha256: artifact.contentSha256,
          byteLength: artifact.ref.byteLength,
        })),
      ]),
    );
  } catch (error) {
    return unavailable(PREDICATE_ID, "invalid", "owner-material-invalid", error instanceof Error ? error.message : "performance-artifact-write");
  }
});

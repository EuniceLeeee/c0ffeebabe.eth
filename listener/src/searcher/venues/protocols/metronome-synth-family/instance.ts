import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import {
  METRONOME_SYNTH_FAMILY_ID,
  METRONOME_SYNTH_LINEAGE_ID,
} from "./manifest.js";
import {
  METRONOME_SYNTH_ORACLE_BINDING,
  metronomeSynthStaticProjection,
} from "./shared.js";
import type {
  MetronomeSynthDescriptor,
  MetronomeSynthIdentity,
} from "./types.js";

export const metronomeSynthInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.pool)),
  compileDraft: (identity) => Object.freeze({
    familyId: METRONOME_SYNTH_FAMILY_ID,
    lineageId: METRONOME_SYNTH_LINEAGE_ID,
    instanceKey: instanceKey(lowerAddress(identity.pool)),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([
      { kind: "source-state" as const, freshness: "pinned-block" as const },
      {
        kind: "oracle-state" as const,
        oracleBinding: METRONOME_SYNTH_ORACLE_BINDING,
        maxSourceLagBlocks: 0,
      },
    ]),
    pool: canonicalAddress(identity.pool),
    tokens: Object.freeze([...identity.tokens]),
    directions: Object.freeze(
      identity.directions.map((direction) => Object.freeze({ ...direction })),
    ),
    oracleBinding: METRONOME_SYNTH_ORACLE_BINDING,
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: metronomeSynthStaticProjection,
} satisfies InstanceSemantics<MetronomeSynthIdentity, MetronomeSynthDescriptor>;

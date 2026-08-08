import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import {
  METRONOME_HGUSDC_FAMILY_ID,
  METRONOME_HGUSDC_LINEAGE_ID,
} from "./manifest.js";
import {
  METRONOME_HGUSDC_BINDINGS,
  METRONOME_HGUSDC_PATH_HASH,
  metronomeHgUsdcStaticProjection,
} from "./shared.js";
import type {
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcIdentity,
} from "./types.js";

export const metronomeHgUsdcInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.router)),
  compileDraft: (identity) => Object.freeze({
    familyId: METRONOME_HGUSDC_FAMILY_ID,
    lineageId: METRONOME_HGUSDC_LINEAGE_ID,
    instanceKey: instanceKey(lowerAddress(identity.router)),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([
      { kind: "source-state" as const, freshness: "pinned-block" as const },
      { kind: "quote-completion" as const, mode: "return-data" as const },
    ]),
    router: canonicalAddress(identity.router),
    curve: canonicalAddress(METRONOME_HGUSDC_BINDINGS.curve),
    vault: canonicalAddress(METRONOME_HGUSDC_BINDINGS.vault),
    tokenIn: canonicalAddress(METRONOME_HGUSDC_BINDINGS.tokenIn),
    curveIntermediate: canonicalAddress(
      METRONOME_HGUSDC_BINDINGS.curveIntermediate,
    ),
    tokenOut: canonicalAddress(METRONOME_HGUSDC_BINDINGS.tokenOut),
    pathHash: METRONOME_HGUSDC_PATH_HASH,
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: metronomeHgUsdcStaticProjection,
} satisfies InstanceSemantics<
  MetronomeHgUsdcIdentity,
  MetronomeHgUsdcDescriptor
>;

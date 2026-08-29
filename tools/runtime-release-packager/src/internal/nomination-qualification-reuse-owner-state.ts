import type { CurrentCatalogImpactAnalysisCapabilityV1 } from "../../../catalog-generator/src/current-impact-analysis-owner.ts";
import { encodeCanonicalBytes } from "../../../../packages/canonical-codec/src/index.ts";
import {
  decodeNominationQualificationDeploymentFactV1,
  decodeRuntimeReleaseBindingV1,
  decodeRuntimeReleaseSignerPinV1,
  type NominationQualificationDeploymentFactV1,
  type RuntimeReleaseBindingV1,
  type RuntimeReleaseSignerPinV1,
} from "../../../../specs/release-authority/src/index.ts";
declare const nominationQualificationReuseOwnerCompositionBrand: unique symbol;

export interface NominationQualificationReuseOwnerCompositionV1 {
  readonly [nominationQualificationReuseOwnerCompositionBrand]: true;
}

export interface NominationQualificationReuseOwnerCompositionStateV1 {
  readonly currentCatalogImpact: CurrentCatalogImpactAnalysisCapabilityV1;
  readonly priorRuntimeBinding: RuntimeReleaseBindingV1;
  readonly priorDeploymentFact: NominationQualificationDeploymentFactV1;
  readonly currentRuntimeBinding: RuntimeReleaseBindingV1;
  readonly currentDeploymentFact: NominationQualificationDeploymentFactV1;
  readonly priorRuntimeSignerPin: RuntimeReleaseSignerPinV1;
  readonly currentRuntimeSignerPin: RuntimeReleaseSignerPinV1;
  readonly priorDeploymentFactSignerPin: RuntimeReleaseSignerPinV1;
  readonly currentDeploymentFactSignerPin: RuntimeReleaseSignerPinV1;
}

const states = new WeakMap<object, NominationQualificationReuseOwnerCompositionStateV1>();

/** Process-local opaque mint used only after the release owner has observed
 * and verified the fixed deployment inputs. Nested signed values are decoded
 * again here so later caller mutation cannot alter registered provenance. */
export function registerNominationQualificationReuseOwnerCompositionV1(
  state: NominationQualificationReuseOwnerCompositionStateV1,
): NominationQualificationReuseOwnerCompositionV1 {
  const priorRuntimeSignerPin = decodeRuntimeReleaseSignerPinV1(state.priorRuntimeSignerPin);
  const currentRuntimeSignerPin = decodeRuntimeReleaseSignerPinV1(state.currentRuntimeSignerPin);
  if (!Buffer.from(encodeCanonicalBytes(priorRuntimeSignerPin)).equals(
    Buffer.from(encodeCanonicalBytes(currentRuntimeSignerPin)),
  )) throw new TypeError("runtime signer pin continuity mismatch");
  const composition = Object.freeze({});
  states.set(composition, Object.freeze({
    currentCatalogImpact: state.currentCatalogImpact,
    priorRuntimeBinding: decodeRuntimeReleaseBindingV1(state.priorRuntimeBinding),
    priorDeploymentFact: decodeNominationQualificationDeploymentFactV1(state.priorDeploymentFact),
    currentRuntimeBinding: decodeRuntimeReleaseBindingV1(state.currentRuntimeBinding),
    currentDeploymentFact: decodeNominationQualificationDeploymentFactV1(state.currentDeploymentFact),
    priorRuntimeSignerPin,
    currentRuntimeSignerPin,
    priorDeploymentFactSignerPin: decodeRuntimeReleaseSignerPinV1(state.priorDeploymentFactSignerPin),
    currentDeploymentFactSignerPin: decodeRuntimeReleaseSignerPinV1(state.currentDeploymentFactSignerPin),
  }));
  return composition as NominationQualificationReuseOwnerCompositionV1;
}

export function readNominationQualificationReuseOwnerCompositionV1(
  composition: NominationQualificationReuseOwnerCompositionV1,
): NominationQualificationReuseOwnerCompositionStateV1 {
  const state = states.get(composition as object);
  if (state === undefined) throw new TypeError("nomination qualification reuse composition is not release-owner-issued");
  return state;
}

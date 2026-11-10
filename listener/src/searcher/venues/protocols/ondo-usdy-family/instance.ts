import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { lowerAddress } from "../standard-family/common.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import type { OndoDescriptor, OndoIdentity } from "./types.js";

export function ondoStaticProjection(d: OndoDescriptor) {
  return {
    manager: lowerAddress(d.manager), rwa: lowerAddress(d.rwa), receive: lowerAddress(d.receive),
    selector: "0xd8780161", normalizer: d.normalizer.toString(), minimumRwaPrice: d.minimumRwaPrice.toString(),
    feeFlat: d.feeFlat.toString(), feeBps: d.feeBps.toString(), feePrecision: d.feePrecision.toString(),
  };
}

export const ondoInstance = {
  instanceKey: (i) => instanceKey(lowerAddress(i.subject)),
  compileDraft: (identity) => Object.freeze({ ...((i0) => { const i = i0 as OndoIdentity; return { manager: i.manager, rwa: i.rwa, receive: i.receive, oracle: i.oracle, fees: i.fees, normalizer: i.normalizer, rwaDecimals: i.rwaDecimals, receiveDecimals: i.receiveDecimals, minimumRwaPrice: i.minimumRwaPrice, feeFlat: i.feeFlat, feeBps: i.feeBps, feePrecision: i.feePrecision, managerCodeHash: i.managerCodeHash, provenance: i.provenance }; })(identity),
    familyId: FAMILY, lineageId: LINEAGE, instanceKey: instanceKey(lowerAddress(identity.subject)),
    runtimeRequirements: Object.freeze([
      { kind: "source-state" as const, freshness: "pinned-block" as const },
      { kind: "execution-actor" as const, role: "executor" as const },
      { kind: "effect-observation" as const, effects: Object.freeze(["token-delta" as const, "logs" as const]) },
    ]),



  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: ondoStaticProjection,
} satisfies InstanceSemantics<OndoIdentity, OndoDescriptor>;

import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import type { Binding, Descriptor, Identity } from "./types.js";
import { isZap, zapProjection } from "./zap.js";
export const binding = (d: Binding) => ({ pool: d.pool, lp: d.lp, coins: [...d.coins], poolCodeHash: d.poolCodeHash,
  lpCodeHash: d.lpCodeHash, coinCodeHashes: [...d.coinCodeHashes], ...(isZap(d) ? { zap: zapProjection(d) } : {}), ...(d.generic ? { generic: { ...d.generic, decimals: [...d.generic.decimals], directions: d.generic.directions.map(v => ({ ...v })) } } : {}), ...(d.ng ? { ng: { ...d.ng, decimals: [...d.ng.decimals], directions: d.ng.directions.map(v => ({ ...v })) } } : {}) });
export const instance = { instanceKey: i => instanceKey(i.binding.pool), compileDraft: i => ({ familyId: i.familyId, lineageId: i.lineageId,
  instanceKey: instanceKey(i.binding.pool), ...i.binding, provenance: i.provenance, runtimeRequirements: [{ kind: "source-state", freshness: "pinned-block" }] }),
  finalizeDescriptor: ({ draft }) => draft, staticBindingProjection: (d: Descriptor) => binding(d),
} satisfies InstanceSemantics<Identity, Descriptor>;

// Offline ABI fixture only. This does not issue admission, Ready or runtime handles.
import { readFileSync } from "node:fs";
import { plugin } from "../../../production-families/aqua-swapvm.production.js";
import { binding } from "../codec.js";
import { ID, LINEAGE } from "../manifest.js";
import type { Descriptor } from "../types.js";
export function descriptor(sampleIndex = 0): Descriptor {
  const sample=JSON.parse(readFileSync(new URL("./historical-fixtures.json",import.meta.url),"utf8")).samples[sampleIndex];
  if (!sample) throw new Error("Aqua offline fixture index");
  const facts=binding(sample.app,sample.order,sample.tokens);
  const identity={familyId:ID,lineageId:LINEAGE,subject:facts.router,facts,provenance:[]};
  return plugin.instance.finalizeDescriptor({identity,draft:plugin.instance.compileDraft(identity),sharedBindings:[]}) as Descriptor;
}

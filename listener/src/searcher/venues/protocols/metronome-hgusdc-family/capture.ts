import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { metronomeHgUsdcDiscovery } from "./discovery.js";
import { METRONOME_HGUSDC_FAMILY_ID } from "./manifest.js";

export const metronomeHgUsdcCapture = createRouteCaptureMaterialization({ familyId: METRONOME_HGUSDC_FAMILY_ID, discovery: metronomeHgUsdcDiscovery });

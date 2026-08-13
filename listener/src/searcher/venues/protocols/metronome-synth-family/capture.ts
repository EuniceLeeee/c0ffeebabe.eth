import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { metronomeSynthDiscovery } from "./discovery.js";
import { METRONOME_SYNTH_FAMILY_ID } from "./manifest.js";

export const metronomeSynthCapture = createRouteCaptureMaterialization({ familyId: METRONOME_SYNTH_FAMILY_ID, discovery: metronomeSynthDiscovery });

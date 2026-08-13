import { createCreditCaptureMaterialization } from "../../capture-materialization.js";
import { fluidCreditDiscovery } from "./discovery.js";
import { FLUID_CREDIT_FAMILY_ID } from "./manifest.js";

export const fluidCreditCapture = createCreditCaptureMaterialization({ familyId: FLUID_CREDIT_FAMILY_ID, discovery: fluidCreditDiscovery });

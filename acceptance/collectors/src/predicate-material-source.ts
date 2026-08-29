import type { PredicateMaterialSourcePortV1 } from "../../gate-core/src/material-provider.ts";
import { assertProductionPredicateMaterialSourcePortV1 } from "./internal/predicate-material-source-owner.ts";

export type { PredicateMaterialSourcePortV1 };

/** Public consumers may validate a release-owned port but cannot mint one. */
export { assertProductionPredicateMaterialSourcePortV1 };

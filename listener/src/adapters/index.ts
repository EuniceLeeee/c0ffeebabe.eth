/** Register exactly the actions issued by the strict production composition. */
import { register } from "./registry.js";
import {
  PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS,
} from "../searcher/venues/production-family-composition.js";

for (const action of PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS) {
  register(action);
}

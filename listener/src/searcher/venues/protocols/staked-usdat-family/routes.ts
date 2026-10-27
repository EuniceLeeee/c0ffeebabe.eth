import { standardFamily } from "./standard-base.js";
import type { RouteProjectionSemantics } from "../../adapter-family-plugin.js";
import type { StakedUsdatDescriptor, StakedUsdatRoute } from "./types.js";

export const stakedUsdatRoutes: RouteProjectionSemantics<StakedUsdatDescriptor, StakedUsdatRoute> = {
  ...standardFamily.routes as unknown as RouteProjectionSemantics<StakedUsdatDescriptor, StakedUsdatRoute>,
};

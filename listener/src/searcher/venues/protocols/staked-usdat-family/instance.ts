import { standardFamily } from "./standard-base.js";
import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import type { StakedUsdatIdentity, StakedUsdatDescriptor } from "./types.js";

export const stakedUsdatInstance: InstanceSemantics<StakedUsdatIdentity, StakedUsdatDescriptor> = {
  ...standardFamily.instance as unknown as InstanceSemantics<StakedUsdatIdentity, StakedUsdatDescriptor>,
};

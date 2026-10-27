import { standardFamily } from "./standard-base.js";
import type { erc4626Instance as OriginalShared } from "../erc4626-family/instance.js";
const erc4626Instance = standardFamily.instance as unknown as typeof OriginalShared;

export const stakedUsdatInstance: typeof erc4626Instance = { ...erc4626Instance };

import { standardFamily } from "./standard-base.js";
import type { erc4626Routes as OriginalShared } from "../erc4626-family/routes.js";
const erc4626Routes = standardFamily.routes as unknown as typeof OriginalShared;

export const stakedUsdatRoutes: typeof erc4626Routes = { ...erc4626Routes };

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Constants} from "../../src/Constants.sol";
import {ActionModule, ActionType} from "./Types.sol";

library ModuleRegistry {
    function getModules() internal pure returns (ActionModule[] memory modules) {
        modules = new ActionModule[](8);

        modules[0] = ActionModule({
            actionType: ActionType.FLASH_LOAN,
            protocol: Constants.MORPHO,
            tokenIn: Constants.WSTUSER,
            tokenOut: Constants.WSTUSER,
            moduleId: keccak256("morpho-flash-wstUSR")
        });

        modules[1] = ActionModule({
            actionType: ActionType.BORROW,
            protocol: Constants.FLUID_VAULT_WSTUSER_USDC,
            tokenIn: Constants.WSTUSER,
            tokenOut: Constants.USDC,
            moduleId: keccak256("fluid-borrow-wstUSR-USDC")
        });

        modules[2] = ActionModule({
            actionType: ActionType.SWAP,
            protocol: Constants.SKY_PSM_LITE,
            tokenIn: Constants.USDC,
            tokenOut: Constants.DAI,
            moduleId: keccak256("sky-psm-USDC-DAI")
        });

        modules[3] = ActionModule({
            actionType: ActionType.SWAP,
            protocol: Constants.UNISWAP_V4_POOL_MANAGER,
            tokenIn: Constants.DAI,
            tokenOut: Constants.USDT,
            moduleId: keccak256("univ4-DAI-USDT")
        });

        modules[4] = ActionModule({
            actionType: ActionType.SWAP,
            protocol: Constants.UNISWAP_V3_USDT_WETH,
            tokenIn: Constants.USDT,
            tokenOut: Constants.WETH,
            moduleId: keccak256("univ3-USDT-WETH")
        });

        modules[5] = ActionModule({
            actionType: ActionType.SWAP,
            protocol: Constants.UNISWAP_V3_USDT_WETH,
            tokenIn: Constants.WETH,
            tokenOut: Constants.USDT,
            moduleId: keccak256("univ3-WETH-USDT")
        });

        modules[6] = ActionModule({
            actionType: ActionType.SWAP,
            protocol: Constants.CURVE_SUSDS_USDT,
            tokenIn: Constants.USDT,
            tokenOut: Constants.DOLA,
            moduleId: keccak256("curve-USDT-sUSDS-DOLA")
        });

        modules[7] = ActionModule({
            actionType: ActionType.SWAP,
            protocol: Constants.CURVE_DOLA_WSTUSR,
            tokenIn: Constants.DOLA,
            tokenOut: Constants.WSTUSER,
            moduleId: keccak256("curve-DOLA-wstUSR")
        });
    }
}

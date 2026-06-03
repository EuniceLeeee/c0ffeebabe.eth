// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BotVMScriptBuilder, WstUsrArbParams} from "../../src/BotVMScriptBuilder.sol";
import {CandidatePath} from "./Types.sol";

library CompilerAdapter {
    bytes32 private constant MID_FLASH = keccak256("morpho-flash-wstUSR");
    bytes32 private constant MID_BORROW = keccak256("fluid-borrow-wstUSR-USDC");
    bytes32 private constant MID_PSM = keccak256("sky-psm-USDC-DAI");
    bytes32 private constant MID_V4 = keccak256("univ4-DAI-USDT");
    bytes32 private constant MID_V3_FWD = keccak256("univ3-USDT-WETH");
    bytes32 private constant MID_V3_REV = keccak256("univ3-WETH-USDT");
    bytes32 private constant MID_CURVE1 = keccak256("curve-USDT-sUSDS-DOLA");
    bytes32 private constant MID_CURVE2 = keccak256("curve-DOLA-wstUSR");

    function isSupportedShape(CandidatePath memory path) internal pure returns (bool) {
        if (path.steps.length != 8) return false;

        bytes32[8] memory expected =
            [MID_FLASH, MID_BORROW, MID_PSM, MID_V4, MID_V3_FWD, MID_V3_REV, MID_CURVE1, MID_CURVE2];

        for (uint256 i = 0; i < 8; i++) {
            if (path.steps[i].moduleId != expected[i]) return false;
        }
        return true;
    }

    function compile(CandidatePath memory path, WstUsrArbParams memory params, address executor)
        internal
        pure
        returns (bytes memory script)
    {
        require(isSupportedShape(path), "unsupported shape");
        script = BotVMScriptBuilder.buildWstUsrArbScript(params, executor);
    }

    function filterSupported(CandidatePath[] memory raw, uint256 rawCount)
        internal
        pure
        returns (CandidatePath[] memory supported, uint256 supportedCount)
    {
        for (uint256 i = 0; i < rawCount; i++) {
            if (isSupportedShape(raw[i])) supportedCount++;
        }

        supported = new CandidatePath[](supportedCount);
        uint256 idx;
        for (uint256 i = 0; i < rawCount; i++) {
            if (isSupportedShape(raw[i])) {
                raw[i].rawIndex = i;
                supported[idx] = raw[i];
                idx++;
            }
        }
    }
}

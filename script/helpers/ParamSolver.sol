// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CandidatePath} from "./Types.sol";

library ParamSolver {
    uint256 private constant BASE_FLASH = 3_533_486761808775726594;
    uint256 private constant BASE_DEBT1 = 1_839_929_197;
    uint256 private constant BASE_DEBT2 = 1_839_929_197;
    uint256 private constant BASE_V4_TAKE = 3679935364;
    uint256 private constant BASE_V3_EXACT = 3513427987;

    function fillParams(CandidatePath memory path, uint256 flashAmount)
        internal
        pure
        returns (CandidatePath memory)
    {
        path.flashAmount = flashAmount;
        path.debtAmount1 = BASE_DEBT1 * flashAmount / BASE_FLASH;
        path.debtAmount2 = BASE_DEBT2 * flashAmount / BASE_FLASH;
        path.v4TakeAmount = BASE_V4_TAKE * flashAmount / BASE_FLASH;
        path.v3ExactOutput = BASE_V3_EXACT * flashAmount / BASE_FLASH;
        return path;
    }
}

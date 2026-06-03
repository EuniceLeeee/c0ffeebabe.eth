// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Constants} from "../../src/Constants.sol";
import {ICurvePool} from "../../src/interfaces/ISwap.sol";
import {TriggerInfo} from "./Types.sol";

library Detector {
    uint256 private constant QUOTE_AMOUNT = 1e18; // 1 DOLA
    uint256 private constant FAIR_QUOTE = 1e18;   // 1 DOLA should get ~1 wstUSR at fair

    function buildTriggerInfo() internal view returns (TriggerInfo memory info) {
        info.pool = Constants.CURVE_DOLA_WSTUSR;
        // coin[0] = DOLA, coin[1] = wstUSR
        info.spotQuote = ICurvePool(Constants.CURVE_DOLA_WSTUSR).get_dy(0, 1, QUOTE_AMOUNT);
        info.fairQuote = FAIR_QUOTE;
        if (info.spotQuote > info.fairQuote) {
            info.gapBps = (info.spotQuote - info.fairQuote) * 10000 / info.fairQuote;
        }
    }

    function isOpportunity(TriggerInfo memory info, uint256 minGapBps)
        internal
        pure
        returns (bool)
    {
        return info.gapBps >= minGapBps;
    }
}

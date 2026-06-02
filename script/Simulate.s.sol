// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {FlashArb, ArbParams} from "../src/FlashArb.sol";
import {Constants} from "../src/Constants.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @notice Fork simulation script. Will NOT broadcast unless you pass --broadcast explicitly.
contract Simulate is Script {
    function run() external {
        // Usage: forge script script/Simulate.s.sol --fork-url $MAINNET_RPC_URL --fork-block-number 24710787

        vm.startBroadcast();

        FlashArb arb = new FlashArb();
        arb.execute(
            3_533_486761808775726594,
            ArbParams({
                debtAmount1: 1839929197,
                debtAmount2: 1839929197,
                v4TakeAmount: 3679935364,
                v3ExactOutput: 3513427987,
                curveMinWstUsr: 0,
                minProfitWstUsr: 0
            })
        );

        console.log("wstUSR profit:", IERC20(Constants.WSTUSER).balanceOf(address(arb)));
        console.log("WETH profit:", IERC20(Constants.WETH).balanceOf(address(arb)));

        vm.stopBroadcast();
    }
}

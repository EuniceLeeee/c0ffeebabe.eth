// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {BotVMScriptBuilder, WstUsrArbParams} from "../src/BotVMScriptBuilder.sol";
import {CaptureArbSim} from "./helpers/CaptureArbSim.sol";
import {Constants} from "../src/Constants.sol";

/// @notice Dumps raw BotVM script bytes and all params for TS equivalence test.
contract DumpScript is Script {
    function run() external {
        // Same params as AutoBackrun trigger mode
        uint256 flashAmount = 3_533_486761808775726594;
        uint256 debtAmount1 = 1_839_929_197;
        uint256 debtAmount2 = 1_839_929_197;
        uint256 v4TakeAmount = 3679935364;
        uint256 v3ExactOutput = 3513427987;

        // Replay victim tx to get correct state
        bytes32 TX0 = 0xc52bc6f4d29a96bc18efa09708636e9d37109918d28c52d585a5f3df1609bb22;
        vm.rollFork(Constants.TARGET_BLOCK);
        vm.transact(TX0);

        // Capture intermediate values (in snapshot — CaptureArbSim modifies state)
        uint256 snap = vm.snapshotState();
        CaptureArbSim capturer = new CaptureArbSim();
        capturer.capture(flashAmount, debtAmount1, debtAmount2, v4TakeAmount, v3ExactOutput);
        uint256 daiAmount = capturer.daiAmount();
        uint256 usdtReceived = capturer.usdtReceivedPhase2();
        uint256 wethOwed = capturer.wethOwed();
        uint256 susdsOut = capturer.susdsOut();
        uint256 dolaAmount = capturer.dolaAmount();
        vm.revertToState(snap);

        // Build script with a known executor address
        address executor = address(0xDEAD);
        WstUsrArbParams memory p = WstUsrArbParams({
            flashAmount: flashAmount,
            debtAmount1: debtAmount1,
            debtAmount2: debtAmount2,
            v4TakeAmount: v4TakeAmount,
            v3ExactOutput: v3ExactOutput,
            daiAmount: daiAmount,
            usdtReceived: usdtReceived,
            wethOwed: wethOwed,
            susdsOut: susdsOut,
            dolaAmount: dolaAmount,
            minProfit: 0
        });

        bytes memory script = BotVMScriptBuilder.buildWstUsrArbScript(p, executor);

        console.log("=== PARAMS ===");
        console.log("flashAmount:", flashAmount);
        console.log("debtAmount1:", debtAmount1);
        console.log("debtAmount2:", debtAmount2);
        console.log("v4TakeAmount:", v4TakeAmount);
        console.log("v3ExactOutput:", v3ExactOutput);
        console.log("daiAmount:", daiAmount);
        console.log("usdtReceived:", usdtReceived);
        console.log("wethOwed:", wethOwed);
        console.log("susdsOut:", susdsOut);
        console.log("dolaAmount:", dolaAmount);
        console.log("executor:", executor);
        console.log("scriptLen:", script.length);
        console.log("=== SCRIPT ===");
        console.logBytes(script);
    }
}

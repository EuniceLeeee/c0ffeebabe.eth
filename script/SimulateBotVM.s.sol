// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {BotVM} from "../src/BotVM.sol";
import {BotVMScriptBuilder, WstUsrArbParams} from "../src/BotVMScriptBuilder.sol";
import {Constants} from "../src/Constants.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {CaptureArbSim} from "./helpers/CaptureArbSim.sol"; // # codex修改

// ── SimulateBotVM ──────────────────────────────────────────────────
/// @notice Fork simulation script for the BotVM wstUSR arb.
///
/// 4-phase flow:
///   Phase 1 — Capture: run CaptureArb to get intermediate values
///   Phase 2 — Build:   construct VM script via BotVMScriptBuilder
///   Phase 3 — Execute: run BotVM.execute(script) on fork
///   Phase 4 — Report:  log profits, script size, and full calldata
///
/// Usage:
///   source .env && forge script script/SimulateBotVM.s.sol:SimulateBotVM \
///     --fork-url $MAINNET_RPC_URL -vvvv

contract SimulateBotVM is Script {
    uint256 constant FLASH_AMOUNT = 3_533_486761808775726594;
    uint256 constant DEBT_AMOUNT_1 = 1_839_929_197;
    uint256 constant DEBT_AMOUNT_2 = 1_839_929_197;
    uint256 constant V4_TAKE_AMOUNT = 3679935364;
    uint256 constant V3_EXACT_OUTPUT = 3513427987;
    uint256 constant MIN_PROFIT = 100e18; // 100 wstUSR floor; real arb yields ~273

    function run() external {
        // ── Phase 1: Capture intermediate values ──
        vm.rollFork(Constants.ORIGINAL_TX_HASH);
        uint256 snap = vm.snapshot();

        CaptureArbSim capturer = new CaptureArbSim();
        capturer.capture(FLASH_AMOUNT, DEBT_AMOUNT_1, DEBT_AMOUNT_2, V4_TAKE_AMOUNT, V3_EXACT_OUTPUT);

        uint256 capDaiAmount = capturer.daiAmount();
        uint256 capUsdtReceived = capturer.usdtReceivedPhase2();
        uint256 capWethOwed = capturer.wethOwed();
        uint256 capSusdsOut = capturer.susdsOut();
        uint256 capDolaAmount = capturer.dolaAmount();

        console.log("=== Phase 1: Capture ===");
        console.log("  daiAmount:     ", capDaiAmount);
        console.log("  usdtReceived:  ", capUsdtReceived);
        console.log("  wethOwed:      ", capWethOwed);
        console.log("  susdsOut:      ", capSusdsOut);
        console.log("  dolaAmount:    ", capDolaAmount);

        vm.revertTo(snap);

        // ── Phase 2: Build script ──
        WstUsrArbParams memory params = WstUsrArbParams({
            flashAmount: FLASH_AMOUNT,
            debtAmount1: DEBT_AMOUNT_1,
            debtAmount2: DEBT_AMOUNT_2,
            v4TakeAmount: V4_TAKE_AMOUNT,
            v3ExactOutput: V3_EXACT_OUTPUT,
            daiAmount: capDaiAmount,
            usdtReceived: capUsdtReceived,
            wethOwed: capWethOwed,
            susdsOut: capSusdsOut,
            dolaAmount: capDolaAmount,
            minProfit: MIN_PROFIT
        });

        BotVM botvm = new BotVM(); // # codex修改
        bytes memory script = BotVMScriptBuilder.buildWstUsrArbScript(params, address(botvm));

        console.log("");
        console.log("=== Phase 2: Build ===");
        console.log("  BotVM address: ", address(botvm));
        console.log("  Script length: ", script.length, "bytes");

        // ── Phase 3: Execute ──
        botvm.execute(script);

        // ── Phase 4: Report ──
        uint256 wstUsrProfit = IERC20(Constants.WSTUSER).balanceOf(address(botvm));
        uint256 wethProfit = IERC20(Constants.WETH).balanceOf(address(botvm));

        console.log("");
        console.log("=== Phase 4: Report ===");
        console.log("  wstUSR profit: ", wstUsrProfit);
        console.log("  WETH profit:   ", wethProfit);

        // Output the actual tx calldata
        bytes memory txCalldata = abi.encodeWithSelector(BotVM.execute.selector, script);
        console.log("  Calldata length:", txCalldata.length, "bytes");
        console.log("");
        console.log("=== Execute Calldata (hex) ===");
        console.logBytes(txCalldata);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {BotVM} from "../src/BotVM.sol";
import {BotVMScriptBuilder, WstUsrArbParams} from "../src/BotVMScriptBuilder.sol";
import {Constants} from "../src/Constants.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {CaptureArbSim} from "./helpers/CaptureArbSim.sol";

/// @notice Replay historical trigger transactions, then simulate our BotVM backrun.
///
/// Modes:
///   REPLAY_MODE=trigger  replay only tx index 0, then run BotVM.
///   REPLAY_MODE=exact    replay tx index 0 through 7, then run BotVM at tx8 pre-state.
///
/// Usage:
///   source .env && REPLAY_MODE=trigger forge script script/BackrunReplay.s.sol:BackrunReplay \
///     --fork-url $MAINNET_RPC_URL -vv
///
///   source .env && REPLAY_MODE=exact forge script script/BackrunReplay.s.sol:BackrunReplay \
///     --fork-url $MAINNET_RPC_URL -vv
contract BackrunReplay is Script { // # codex修改
    uint256 private constant FLASH_AMOUNT = 3_533_486761808775726594;
    uint256 private constant DEBT_AMOUNT_1 = 1_839_929_197;
    uint256 private constant DEBT_AMOUNT_2 = 1_839_929_197;
    uint256 private constant V4_TAKE_AMOUNT = 3679935364;
    uint256 private constant V3_EXACT_OUTPUT = 3513427987;
    uint256 private constant MIN_PROFIT = 100e18; // 100 wstUSR floor; real arb yields ~273

    uint256 private constant TARGET_BLOCK_TIMESTAMP = 1_774_155_527;

    bytes32 private constant TX0 = 0xc52bc6f4d29a96bc18efa09708636e9d37109918d28c52d585a5f3df1609bb22;
    bytes32 private constant TX1 = 0x63db40c3ff6c68b439fd036de364420b96c2a36e6b55152554993c27c949bf73;
    bytes32 private constant TX2 = 0x2ce7283e8391664d2b42130a675a10478dee26ddeeeb5d958c168b1ea08c7c4e;
    bytes32 private constant TX3 = 0x3b2d4ab1e260d1314a763d446955eea1da2283fd2aff31d14cbafc9241e830d9;
    bytes32 private constant TX4 = 0xc7d8cba4cc619e1bde71ed5fb912d19b84aa99a7cc7485b30a80942a7bb03610;
    bytes32 private constant TX5 = 0x0906d8e68028f0241c31cac423f1f089eff853dd5e3de5fd91a40162e0cb5b65;
    bytes32 private constant TX6 = 0x34cec7c06c5c5e66c7c3e500fca025b7c03616e3a67a4efd1e721b476fe4a572;
    bytes32 private constant TX7 = 0x565990e0b963a97be74ce03b8ddc222648521befebc570ba6664f669b5e0ae2a;

    function run() external {
        string memory mode = vm.envOr("REPLAY_MODE", string("trigger"));
        bool exactMode = _eq(mode, "exact");
        bool triggerMode = _eq(mode, "trigger");
        require(exactMode || triggerMode, "REPLAY_MODE must be trigger or exact");

        vm.rollFork(Constants.FORK_BLOCK);
        vm.roll(Constants.TARGET_BLOCK);
        vm.warp(TARGET_BLOCK_TIMESTAMP);

        uint256 replayCount = exactMode ? 8 : 1;

        console.log("=== Phase 1: Historical Replay ===");
        console.log("  mode:          ", mode);
        console.log("  fork block:    ", Constants.FORK_BLOCK);
        console.log("  replay count:  ", replayCount);

        _replayPrefix(replayCount);

        uint256 snap = vm.snapshot();

        CaptureArbSim capturer = new CaptureArbSim();
        capturer.capture(FLASH_AMOUNT, DEBT_AMOUNT_1, DEBT_AMOUNT_2, V4_TAKE_AMOUNT, V3_EXACT_OUTPUT);

        uint256 capDaiAmount = capturer.daiAmount();
        uint256 capUsdtReceived = capturer.usdtReceivedPhase2();
        uint256 capWethOwed = capturer.wethOwed();
        uint256 capSusdsOut = capturer.susdsOut();
        uint256 capDolaAmount = capturer.dolaAmount();

        console.log("");
        console.log("=== Phase 2: Capture ===");
        console.log("  daiAmount:     ", capDaiAmount);
        console.log("  usdtReceived:  ", capUsdtReceived);
        console.log("  wethOwed:      ", capWethOwed);
        console.log("  susdsOut:      ", capSusdsOut);
        console.log("  dolaAmount:    ", capDolaAmount);

        vm.revertTo(snap);

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

        BotVM botvm = new BotVM();
        bytes memory script = BotVMScriptBuilder.buildWstUsrArbScript(params, address(botvm));
        bytes memory txCalldata = abi.encodeWithSelector(BotVM.execute.selector, script);

        console.log("");
        console.log("=== Phase 3: Build ===");
        console.log("  BotVM address: ", address(botvm));
        console.log("  script length: ", script.length, "bytes");
        console.log("  calldata len:  ", txCalldata.length, "bytes");

        bool ok = true;
        bytes memory revertData;
        try botvm.execute(script) {}
        catch (bytes memory err) {
            ok = false;
            revertData = err;
        }

        console.log("");
        console.log("=== Phase 4: Backrun Result ===");
        console.log("  success:       ", ok);

        if (ok) {
            uint256 wstUsrProfit = IERC20(Constants.WSTUSER).balanceOf(address(botvm));
            uint256 wethProfit = IERC20(Constants.WETH).balanceOf(address(botvm));
            console.log("  wstUSR profit: ", wstUsrProfit);
            console.log("  WETH profit:   ", wethProfit);
            console.log("");
            console.log("=== Execute Calldata (hex) ===");
            console.logBytes(txCalldata);
        } else {
            console.log("  revert bytes:");
            console.logBytes(revertData);
        }
    }

    function _replayPrefix(uint256 count) private {
        if (count >= 1) vm.transact(TX0);
        if (count >= 2) vm.transact(TX1);
        if (count >= 3) vm.transact(TX2);
        if (count >= 4) vm.transact(TX3);
        if (count >= 5) vm.transact(TX4);
        if (count >= 6) vm.transact(TX5);
        if (count >= 7) vm.transact(TX6);
        if (count >= 8) vm.transact(TX7);
    }

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {Constants} from "../src/Constants.sol";

import {CompilerAdapter} from "./helpers/CompilerAdapter.sol";
import {Detector} from "./helpers/Detector.sol";
import {ModuleRegistry} from "./helpers/ModuleRegistry.sol";
import {ParamSolver} from "./helpers/ParamSolver.sol";
import {PathComposer} from "./helpers/PathComposer.sol";
import {SimulatorBase} from "./helpers/Simulator.sol";
import {ActionModule, ActionType, CandidatePath, ReplayMode, SimResult, TriggerInfo} from "./helpers/Types.sol";

contract AutoBackrun is Script, SimulatorBase {
    uint256 private constant TARGET_BLOCK_TIMESTAMP = 1_774_155_527;
    uint256 private constant MIN_GAP_BPS = 100;
    uint256 private constant MIN_PROFIT = 50e18;
    uint256 private constant BASE_FLASH = 3_533_486761808775726594;

    bytes32 private constant TX0 = 0xc52bc6f4d29a96bc18efa09708636e9d37109918d28c52d585a5f3df1609bb22;
    bytes32 private constant TX1 = 0x63db40c3ff6c68b439fd036de364420b96c2a36e6b55152554993c27c949bf73;
    bytes32 private constant TX2 = 0x2ce7283e8391664d2b42130a675a10478dee26ddeeeb5d958c168b1ea08c7c4e;
    bytes32 private constant TX3 = 0x3b2d4ab1e260d1314a763d446955eea1da2283fd2aff31d14cbafc9241e830d9;
    bytes32 private constant TX4 = 0xc7d8cba4cc619e1bde71ed5fb912d19b84aa99a7cc7485b30a80942a7bb03610;
    bytes32 private constant TX5 = 0x0906d8e68028f0241c31cac423f1f089eff853dd5e3de5fd91a40162e0cb5b65;
    bytes32 private constant TX6 = 0x34cec7c06c5c5e66c7c3e500fca025b7c03616e3a67a4efd1e721b476fe4a572;
    bytes32 private constant TX7 = 0x565990e0b963a97be74ce03b8ddc222648521befebc570ba6664f669b5e0ae2a;

    function run() external {
        // ═══════════════════════════════════════════════════════════════
        // Phase 1: Replay
        // ═══════════════════════════════════════════════════════════════
        vm.rollFork(Constants.FORK_BLOCK);
        vm.roll(Constants.TARGET_BLOCK);
        vm.warp(TARGET_BLOCK_TIMESTAMP);

        ReplayMode mode = _readReplayMode();
        vm.transact(TX0);

        if (mode == ReplayMode.EXACT) {
            vm.transact(TX1);
            vm.transact(TX2);
            vm.transact(TX3);
            vm.transact(TX4);
            vm.transact(TX5);
            vm.transact(TX6);
            vm.transact(TX7);
        }

        console.log("=== Phase 1: Replay (%s) ===", mode == ReplayMode.TRIGGER ? "trigger" : "exact");
        console.log("  block:", Constants.TARGET_BLOCK);

        // ═══════════════════════════════════════════════════════════════
        // Phase 2-3: Detector
        // ═══════════════════════════════════════════════════════════════
        TriggerInfo memory info = Detector.buildTriggerInfo();
        bool hasOpportunity = Detector.isOpportunity(info, MIN_GAP_BPS);

        console.log("");
        console.log("=== Phase 2-3: Detector ===");
        console.log("  spotQuote:", info.spotQuote);
        console.log("  gapBps:   ", info.gapBps);
        console.log("  opportunity:", hasOpportunity);

        if (!hasOpportunity) {
            console.log("  SKIP: gap too small");
            return;
        }

        // ═══════════════════════════════════════════════════════════════
        // Phase 4: PathComposer — DFS raw candidates
        // ═══════════════════════════════════════════════════════════════
        ActionModule[] memory modules = ModuleRegistry.getModules();
        (CandidatePath[] memory raw, uint256 rawCount) = PathComposer.composeCandidates(modules, MIN_PROFIT);

        console.log("");
        console.log("=== Phase 4: PathComposer ===");
        console.log("  Raw DFS candidates:", rawCount);
        for (uint256 i = 0; i < rawCount; i++) {
            console.log("  Raw #%d (%d steps):", i, raw[i].steps.length);
            for (uint256 j = 0; j < raw[i].steps.length; j++) {
                _logStep(j, raw[i].steps[j]);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Phase 5: CompilerAdapter filter → ParamSolver fill
        // ═══════════════════════════════════════════════════════════════
        (CandidatePath[] memory supported, uint256 supCount) = CompilerAdapter.filterSupported(raw, rawCount);

        console.log("");
        console.log("=== Phase 5: Filter + Fill ===");
        console.log("  Supported candidates:", supCount);

        if (supCount == 0) {
            console.log("  SKIP: no supported shape");
            return;
        }

        for (uint256 i = 0; i < supCount; i++) {
            supported[i] = ParamSolver.fillParams(supported[i], BASE_FLASH);
            console.log("  Candidate sup#%d (raw#%d):", i, supported[i].rawIndex);
            for (uint256 j = 0; j < supported[i].steps.length; j++) {
                _logStep(j, supported[i].steps[j]);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Phase 6: Simulate each supported candidate
        // ═══════════════════════════════════════════════════════════════
        SimResult[] memory results = new SimResult[](supCount);

        console.log("");
        console.log("=== Phase 6: Simulate ===");

        for (uint256 i = 0; i < supCount; i++) {
            results[i] = _simulate(supported[i], i);
            if (results[i].success) {
                console.log("  sup#%d (raw#%d): SUCCESS", i, results[i].rawIndex);
                console.log("    wstUSR:", results[i].wstUsrProfit);
                console.log("    WETH:  ", results[i].wethProfit);
            } else {
                console.log("  sup#%d (raw#%d): REVERTED", i, results[i].rawIndex);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Phase 7: Score — pick max profit >= minProfit
        // ═══════════════════════════════════════════════════════════════
        uint256 bestIdx;
        uint256 bestProfit;
        for (uint256 i = 0; i < supCount; i++) {
            if (results[i].success && results[i].wstUsrProfit > bestProfit) {
                bestProfit = results[i].wstUsrProfit;
                bestIdx = i;
            }
        }

        console.log("");
        console.log("=== Phase 7: Score ===");
        console.log("  bestIdx:   ", bestIdx);
        console.log("  bestProfit:", bestProfit);

        if (bestProfit < MIN_PROFIT) {
            console.log("  SKIP: profit below minimum");
            return;
        }

        // ═══════════════════════════════════════════════════════════════
        // Phase 8: Report (calldata already captured in SimResult)
        // ═══════════════════════════════════════════════════════════════
        SimResult memory best = results[bestIdx];

        console.log("");
        console.log("=== Phase 8: Report ===");
        console.log("  wstUSR profit:", best.wstUsrProfit);
        console.log("  WETH profit:  ", best.wethProfit);
        console.log("  scriptLen:    ", best.scriptLength, "bytes");
        console.log("  calldataLen:  ", best.calldataLength, "bytes");
        console.log("  rawIndex:     ", best.rawIndex);
        console.log("  supportedIdx: ", best.supportedIndex);
        console.log("");
        console.log("=== Calldata (hex) ===");
        console.logBytes(best.txCalldata);
    }

    function _readReplayMode() private view returns (ReplayMode) {
        string memory modeStr = vm.envOr("REPLAY_MODE", string("exact"));
        if (keccak256(bytes(modeStr)) == keccak256("trigger")) {
            return ReplayMode.TRIGGER;
        }
        return ReplayMode.EXACT;
    }

    function _logStep(uint256 idx, ActionModule memory step) private pure {
        string memory typeName;
        if (step.actionType == ActionType.FLASH_LOAN) typeName = "FLASH_LOAN";
        else if (step.actionType == ActionType.BORROW) typeName = "BORROW";
        else typeName = "SWAP";

        console.log("    [%d] %s", idx, typeName);
        console.log("         %s -> %s", step.tokenIn, step.tokenOut);
    }
}

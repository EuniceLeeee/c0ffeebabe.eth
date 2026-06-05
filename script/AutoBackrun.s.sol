// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {Constants} from "../src/Constants.sol";
import {ICurvePool} from "../src/interfaces/ISwap.sol";
import {IChainlinkFeed} from "../src/interfaces/ISwap.sol";

import {CompilerAdapter} from "./helpers/CompilerAdapter.sol";
import {Detector} from "./helpers/Detector.sol";
import {ModuleRegistry} from "./helpers/ModuleRegistry.sol";
import {ParamSolver} from "./helpers/ParamSolver.sol";
import {PathComposer} from "./helpers/PathComposer.sol";
import {LocalOrderedReplayBase, OrderedReplayResult} from "./helpers/LocalOrderedReplay.sol"; // # codex修改
import {SimulatorBase} from "./helpers/Simulator.sol";
import {
    ActionModule,
    ActionType,
    CandidatePath,
    ExecutionConfig,
    ReplayMode,
    SimResult,
    TriggerInfo
} from "./helpers/Types.sol";

contract AutoBackrun is Script, SimulatorBase, LocalOrderedReplayBase { // # codex修改
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
        // Setup: read execution config from env
        // ═══════════════════════════════════════════════════════════════
        ExecutionConfig memory execConfig = _readExecutionConfig();

        // ═══════════════════════════════════════════════════════════════
        // Phase 1: Replay
        // ═══════════════════════════════════════════════════════════════
        ReplayMode mode = _readReplayMode();
        bytes32[] memory replayTxs = _historicalReplayTxs(); // # codex修改
        uint256 replayCount; // # codex修改
        uint256 preReplaySnap; // # codex修改

        if (mode == ReplayMode.LIVE) {
            // LIVE mode: victim tx already injected externally (e.g. anvil).
            // No vm.rollFork, no vm.transact — use current fork state as-is.
            // Phase 7.5 ordered replay is skipped (no preReplaySnap).
            preReplaySnap = vm.snapshotState();
            replayCount = 0;
            console.log("=== Phase 1: Replay (live) ===");
            console.log("  external injection -- skip replay");
        } else {
            // Historical replay: roll to reference block
            vm.rollFork(Constants.FORK_BLOCK);
            vm.roll(Constants.TARGET_BLOCK);
            vm.warp(TARGET_BLOCK_TIMESTAMP);
            preReplaySnap = vm.snapshotState(); // # codex修改

            replayCount = mode == ReplayMode.EXACT ? 8 : 1; // # codex修改
            _replayHistoricalPrefix(replayTxs, replayCount); // # codex修改

            string memory modeLabel = mode == ReplayMode.TRIGGER ? "trigger" : "exact";
            console.log("=== Phase 1: Replay (%s) ===", modeLabel);
        }
        console.log("  block:", block.number);

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
            results[i] = _simulate(supported[i], i, execConfig);
            if (results[i].success) {
                console.log("  sup#%d (raw#%d): SUCCESS", i, results[i].rawIndex);
                console.log("    wstUSR:", results[i].wstUsrProfit);
                console.log("    WETH:  ", results[i].wethProfit);
                console.log("    gas:   ", results[i].gasUsed);
                console.log("    wstUSR->WETH:", results[i].wstUsrProfitWethValue); // # codex修改
                console.log("    netTotalWETH:", results[i].netTotalWethProfit); // # codex修改
                console.log("    coversNet:", results[i].coversNetProfit); // # codex修改
            } else {
                console.log("  sup#%d (raw#%d): REVERTED", i, results[i].rawIndex);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Phase 7: Score — pick max profit >= minProfit (gas-aware)
        // ═══════════════════════════════════════════════════════════════
        uint256 bestIdx;
        uint256 bestProfit;
        uint256 bestNetTotalWeth; // # codex修改
        bool hasBest; // # codex修改
        for (uint256 i = 0; i < supCount; i++) {
            if (!results[i].success) continue; // # codex修改
            if (!results[i].coversNetProfit) continue; // # codex修改
            if (results[i].wstUsrProfit < MIN_PROFIT) continue; // # codex修改
            if (
                !hasBest
                    || results[i].wstUsrProfit > bestProfit
                    || (
                        results[i].wstUsrProfit == bestProfit
                            && results[i].netTotalWethProfit > bestNetTotalWeth
                    )
            ) { // # codex修改
                bestProfit = results[i].wstUsrProfit;
                bestNetTotalWeth = results[i].netTotalWethProfit; // # codex修改
                bestIdx = i;
                hasBest = true; // # codex修改
            }
        }

        console.log("");
        console.log("=== Phase 7: Score ===");
        console.log("  gasPrice:  ", execConfig.gasPriceWei, "wei");
        console.log("  builderTip:", execConfig.builderTipWei, "wei");
        console.log("  minNetTotalWETH:", execConfig.minNetProfitWethWei, "wei"); // # codex修改
        console.log("  wstUSRToWETH:", execConfig.wstUsrToWethPriceE18); // # codex修改

        if (!hasBest) { // # codex修改
            console.log("  SKIP: no candidate covers minProfit + total net PnL guard"); // # codex修改
            return;
        }

        console.log("  bestIdx:   ", bestIdx);
        console.log("  bestProfit:", bestProfit);
        console.log("  bestNetTotalWETH:", bestNetTotalWeth); // # codex修改
        console.log("  gasCost:   ", results[bestIdx].gasCostWei, "wei"); // # codex修改

        // ═══════════════════════════════════════════════════════════════
        // Phase 7.5: Local ordered replay — validate historical prefix + our tx
        // ═══════════════════════════════════════════════════════════════
        {
            vm.revertToState(preReplaySnap); // # codex修改
            OrderedReplayResult memory replayResult =
                _simulateHistoricalOrderedReplay(replayTxs, replayCount, supported[bestIdx], execConfig); // # codex修改

            console.log("");
            console.log("=== Phase 7.5: Local Ordered Replay ==="); // # codex修改
            console.log("  replayed:", replayResult.replayedCount); // # codex修改
            console.log("  victimOk:", replayResult.victimSuccess); // # codex修改
            console.log("  ourOk:   ", replayResult.ourSuccess); // # codex修改

            if (!replayResult.victimSuccess || !replayResult.ourSuccess || !replayResult.coversNetProfit) { // # codex修改
                console.log("  SKIP: local ordered replay failed total net PnL check"); // # codex修改
                return;
            }

            console.log("  wstUSR:  ", replayResult.wstUsrProfit); // # codex修改
            console.log("  WETH:    ", replayResult.wethProfit); // # codex修改
            console.log("  wstUSR->WETH:", replayResult.wstUsrProfitWethValue); // # codex修改
            console.log("  gas:     ", replayResult.totalGasUsed); // # codex修改
            console.log("  netTotalWETH:", replayResult.netTotalWethProfit); // # codex修改
        }

        // ═══════════════════════════════════════════════════════════════
        // Phase 8: Report (calldata already captured in SimResult)
        // ═══════════════════════════════════════════════════════════════
        SimResult memory best = results[bestIdx];

        console.log("");
        console.log("=== Phase 8: Report ===");
        console.log("  wstUSR profit:", best.wstUsrProfit);
        console.log("  WETH profit:  ", best.wethProfit);
        console.log("  gasUsed:      ", best.gasUsed);
        console.log("  wstUSR->WETH: ", best.wstUsrProfitWethValue); // # codex修改
        console.log("  netTotalWETH: ", best.netTotalWethProfit); // # codex修改
        console.log("  scriptLen:    ", best.scriptLength, "bytes");
        console.log("  calldataLen:  ", best.calldataLength, "bytes");
        console.log("  rawIndex:     ", best.rawIndex);
        console.log("  supportedIdx: ", best.supportedIndex);

        console.log("");
        console.log("=== Submission Info ===");
        if (execConfig.executor != address(0)) {
            console.log("  to:  ", execConfig.executor);
            console.log("  from:", execConfig.owner);
            console.log("  mode: deployed (calldata uses real BotVM address)");
        } else {
            console.log("  mode: fork-deploy (calldata uses temporary address)");
            console.log("  Set BOTVM_ADDRESS + BOTVM_OWNER env for production calldata");
        }

        console.log("");
        console.log("=== Calldata (hex) ===");
        console.logBytes(best.txCalldata);
    }

    function _readReplayMode() private view returns (ReplayMode) {
        string memory modeStr = vm.envOr("REPLAY_MODE", string("exact"));
        if (keccak256(bytes(modeStr)) == keccak256("trigger")) {
            return ReplayMode.TRIGGER;
        }
        if (keccak256(bytes(modeStr)) == keccak256("live")) {
            return ReplayMode.LIVE;
        }
        return ReplayMode.EXACT;
    }

    function _readExecutionConfig() private view returns (ExecutionConfig memory config) {
        // If BOTVM_ADDRESS is set, use deployed mode; otherwise fork-deploy
        string memory addr = vm.envOr("BOTVM_ADDRESS", string(""));
        if (bytes(addr).length > 0) {
            config.executor = vm.envAddress("BOTVM_ADDRESS");
            config.owner = vm.envAddress("BOTVM_OWNER");
        }
        config.gasPriceWei = vm.envOr("GAS_PRICE_GWEI", uint256(30)) * 1e9;
        config.builderTipWei = vm.envOr("BUILDER_TIP_WEI", uint256(0));
        config.minNetProfitWethWei = vm.envOr("MIN_NET_PROFIT_WETH_WEI", uint256(0));
        config.wstUsrToWethPriceE18 = _resolveWstUsrToWethPrice();
    }

    /// @dev On-chain wstUSR/WETH price: Curve spot (wstUSR→DOLA) + Chainlink ETH/USD.
    ///      Env var WSTUSR_TO_WETH_PRICE_E18 overrides if set (for testing).
    function _resolveWstUsrToWethPrice() private view returns (uint256 priceE18) {
        priceE18 = vm.envOr("WSTUSR_TO_WETH_PRICE_E18", uint256(0));
        if (priceE18 > 0) return priceE18;

        // wstUSR → DOLA spot rate from Curve (18 decimals)
        uint256 dolaPerWstUsr = ICurvePool(Constants.CURVE_DOLA_WSTUSR).get_dy(1, 0, 1e18);

        // ETH/USD from Chainlink (8 decimals)
        (, int256 ethUsdRaw,,,) = IChainlinkFeed(Constants.CHAINLINK_ETH_USD).latestRoundData();
        require(ethUsdRaw > 0, "bad ETH/USD price");

        // priceE18 = dolaPerWstUsr (18 dec) * 1e8 / ethUsdPrice (8 dec)
        // Result: WETH per wstUSR, 18 decimals
        priceE18 = dolaPerWstUsr * 1e8 / uint256(ethUsdRaw);
    }

    function _historicalReplayTxs() private pure returns (bytes32[] memory txs) { // # codex修改
        txs = new bytes32[](8);
        txs[0] = TX0;
        txs[1] = TX1;
        txs[2] = TX2;
        txs[3] = TX3;
        txs[4] = TX4;
        txs[5] = TX5;
        txs[6] = TX6;
        txs[7] = TX7;
    }

    function _replayHistoricalPrefix(bytes32[] memory txs, uint256 count) private { // # codex修改
        for (uint256 i = 0; i < count; i++) {
            vm.transact(txs[i]);
        }
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

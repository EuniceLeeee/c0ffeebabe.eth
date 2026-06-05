// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BotVM} from "../../src/BotVM.sol";
import {Constants} from "../../src/Constants.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";

import {CaptureArbSim} from "./CaptureArbSim.sol";
import {CompilerAdapter} from "./CompilerAdapter.sol";
import {WstUsrArbParams} from "../../src/BotVMScriptBuilder.sol";
import {CandidatePath, ExecutionConfig} from "./Types.sol";

import "forge-std/Vm.sol";

struct OrderedReplayResult {
    bool victimSuccess;
    bool ourSuccess;
    uint256 replayedCount;
    uint256 wstUsrProfit;
    uint256 wethProfit;
    uint256 totalGasUsed;
    uint256 gasCostWei;
    uint256 wstUsrProfitWethValue; // # codex修改
    uint256 netTotalWethProfit; // # codex修改
    bool coversNetProfit; // # codex修改
}

/// @notice Local historical ordered replay only. This is not a real relay/builder
///         bundle simulation because it does not include signed tx validity,
///         nonce, relay acceptance, or coinbase payment rules. // # codex修改
abstract contract LocalOrderedReplayBase {
    Vm private constant _lvm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function _simulateHistoricalOrderedReplay(
        bytes32[] memory replayTxHashes,
        uint256 replayCount,
        CandidatePath memory path,
        ExecutionConfig memory config
    ) internal returns (OrderedReplayResult memory result) {
        uint256 snap = _lvm.snapshotState();

        for (uint256 i = 0; i < replayCount; i++) {
            try _lvm.transact(replayTxHashes[i]) {
                result.replayedCount++;
            } catch {
                result.victimSuccess = false;
                _lvm.revertToState(snap);
                return result;
            }
        }
        result.victimSuccess = true;

        uint256 capDai;
        uint256 capUsdt;
        uint256 capWeth;
        uint256 capSusds;
        uint256 capDola;
        bool captureOk;

        {
            uint256 capSnap = _lvm.snapshotState();
            CaptureArbSim capturer = new CaptureArbSim();
            try capturer.capture(
                path.flashAmount, path.debtAmount1, path.debtAmount2, path.v4TakeAmount, path.v3ExactOutput
            ) {
                capDai = capturer.daiAmount();
                capUsdt = capturer.usdtReceivedPhase2();
                capWeth = capturer.wethOwed();
                capSusds = capturer.susdsOut();
                capDola = capturer.dolaAmount();
                captureOk = true;
            } catch {
                captureOk = false;
            }
            _lvm.revertToState(capSnap);
        }

        if (!captureOk) {
            result.ourSuccess = false;
            _lvm.revertToState(snap);
            return result;
        }

        {
            WstUsrArbParams memory params = WstUsrArbParams({
                flashAmount: path.flashAmount,
                debtAmount1: path.debtAmount1,
                debtAmount2: path.debtAmount2,
                v4TakeAmount: path.v4TakeAmount,
                v3ExactOutput: path.v3ExactOutput,
                daiAmount: capDai,
                usdtReceived: capUsdt,
                wethOwed: capWeth,
                susdsOut: capSusds,
                dolaAmount: capDola,
                minProfit: path.minProfit
            });

            address executor;
            if (config.executor == address(0)) {
                BotVM botvm = new BotVM();
                executor = address(botvm);
            } else {
                executor = config.executor;
            }

            bytes memory script = CompilerAdapter.compile(path, params, executor);

            if (config.executor != address(0)) {
                _lvm.prank(config.owner);
            }

            uint256 gasBefore = gasleft();
            try BotVM(payable(executor)).execute(script) {
                result.ourSuccess = true;
                result.wstUsrProfit = IERC20(Constants.WSTUSER).balanceOf(executor);
                result.wethProfit = IERC20(Constants.WETH).balanceOf(executor);
                result.totalGasUsed = gasBefore - gasleft();
                result.gasCostWei = result.totalGasUsed * config.gasPriceWei;
                result.wstUsrProfitWethValue =
                    result.wstUsrProfit * config.wstUsrToWethPriceE18 / 1e18; // # codex修改
                uint256 grossWethValue = result.wethProfit + result.wstUsrProfitWethValue; // # codex修改
                uint256 requiredWeth =
                    result.gasCostWei + config.builderTipWei + config.minNetProfitWethWei; // # codex修改
                if (grossWethValue >= requiredWeth) { // # codex修改
                    result.coversNetProfit = true; // # codex修改
                    result.netTotalWethProfit = grossWethValue - result.gasCostWei - config.builderTipWei; // # codex修改
                }
            } catch {
                result.ourSuccess = false;
                result.totalGasUsed = gasBefore - gasleft();
                result.gasCostWei = result.totalGasUsed * config.gasPriceWei;
            }
        }

        _lvm.revertToState(snap);
    }
}

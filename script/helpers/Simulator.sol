// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BotVM} from "../../src/BotVM.sol";
import {Constants} from "../../src/Constants.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {WstUsrArbParams} from "../../src/BotVMScriptBuilder.sol";

import {CaptureArbSim} from "./CaptureArbSim.sol";
import {CompilerAdapter} from "./CompilerAdapter.sol";
import {CandidatePath, SimResult} from "./Types.sol";

import "forge-std/Vm.sol";

abstract contract SimulatorBase {
    Vm private constant _svm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function _simulate(CandidatePath memory path, uint256 supportedIndex)
        internal
        returns (SimResult memory result)
    {
        result.supportedIndex = supportedIndex;
        result.rawIndex = path.rawIndex;
        uint256 outerSnap = _svm.snapshotState();

        // Phase A: capture intermediate values (modifies state)
        uint256 capDai;
        uint256 capUsdt;
        uint256 capWeth;
        uint256 capSusds;
        uint256 capDola;
        bool captureOk;

        {
            uint256 capSnap = _svm.snapshotState();
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
            } catch (bytes memory reason) {
                result.success = false;
                result.revertData = reason;
            }
            _svm.revertToState(capSnap);
        }

        if (!captureOk) {
            _svm.revertToState(outerSnap);
            return result;
        }

        // Phase B: compile and execute BotVM on clean state
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

            BotVM botvm = new BotVM();
            bytes memory script = CompilerAdapter.compile(path, params, address(botvm));

            try botvm.execute(script) {
                result.wstUsrProfit = IERC20(Constants.WSTUSER).balanceOf(address(botvm));
                result.wethProfit = IERC20(Constants.WETH).balanceOf(address(botvm));
                result.txCalldata = abi.encodeWithSelector(BotVM.execute.selector, script);
                result.scriptLength = script.length;
                result.calldataLength = result.txCalldata.length;
                result.success = true;
            } catch (bytes memory reason) {
                result.success = false;
                result.revertData = reason;
            }
        }

        // UNCONDITIONAL: restore fork state to opportunity pre-state
        _svm.revertToState(outerSnap);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CaptureArbSim} from "./CaptureArbSim.sol";
import {ParamSolver} from "./ParamSolver.sol";
import {CandidatePath} from "./Types.sol";

import "forge-std/Vm.sol";

/// @notice Two-phase optimizer for flashAmount:
///   Phase A: Grid scan at 10% steps (40%..130% of base) to find profitable region
///   Phase B: Ternary search within the best ±10% band
/// Must be inherited by a Script/Test (needs vm cheatcodes).
abstract contract OptimizerBase {
    Vm private constant _ovm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant GRID_STEPS = 10;
    uint256 private constant GRID_START_PCT = 40;
    uint256 private constant GRID_STEP_PCT = 10;
    uint256 private constant REFINE_ITERATIONS = 10;

    struct OptResult {
        CandidatePath bestPath;
        uint256 bestProfit;
        uint256 iterations;
    }

    function _optimizeFlashAmount(CandidatePath memory basePath, uint256, uint256)
        internal
        returns (OptResult memory result)
    {
        uint256 baseFlash = basePath.flashAmount;
        uint256 bestFlash = baseFlash;
        uint256 bestProfit = 0;
        uint256 totalIter = 0;

        for (uint256 i = 0; i < GRID_STEPS; i++) {
            uint256 pct = GRID_START_PCT + i * GRID_STEP_PCT;
            uint256 testFlash = baseFlash * pct / 100;
            uint256 p = _evaluateFlash(basePath, testFlash);
            totalIter++;
            if (p > bestProfit) {
                bestProfit = p;
                bestFlash = testFlash;
            }
        }

        if (bestProfit > 0) {
            uint256 lo = bestFlash * 90 / 100;
            uint256 hi = bestFlash * 110 / 100;

            for (uint256 i = 0; i < REFINE_ITERATIONS; i++) {
                if (hi - lo < baseFlash / 1000) break;
                uint256 m1 = lo + (hi - lo) / 3;
                uint256 m2 = hi - (hi - lo) / 3;
                uint256 p1 = _evaluateFlash(basePath, m1);
                uint256 p2 = _evaluateFlash(basePath, m2);
                totalIter += 2;

                if (p1 < p2) {
                    lo = m1;
                    if (p2 > bestProfit) {
                        bestProfit = p2;
                        bestFlash = m2;
                    }
                } else {
                    hi = m2;
                    if (p1 > bestProfit) {
                        bestProfit = p1;
                        bestFlash = m1;
                    }
                }
            }
        }

        result.bestPath = ParamSolver.fillParams(basePath, bestFlash);
        result.bestProfit = bestProfit;
        result.iterations = totalIter;
    }

    function _evaluateFlash(CandidatePath memory basePath, uint256 flashAmount)
        internal
        returns (uint256 profit)
    {
        CandidatePath memory scaled = ParamSolver.fillParams(basePath, flashAmount);

        uint256 snap = _ovm.snapshotState();

        CaptureArbSim capturer = new CaptureArbSim();
        try capturer.capture(
            scaled.flashAmount, scaled.debtAmount1, scaled.debtAmount2, scaled.v4TakeAmount, scaled.v3ExactOutput
        ) {
            profit = capturer.wstUsrProfit();
        } catch {
            profit = 0;
        }

        _ovm.revertToState(snap);
    }
}

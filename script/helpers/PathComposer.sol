// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ActionModule, ActionType, CandidatePath} from "./Types.sol";

library PathComposer {
    uint256 private constant MAX_DEPTH = 6;
    uint256 private constant MAX_CANDIDATES = 16;

    function composeCandidates(ActionModule[] memory allModules, uint256 minProfit)
        internal
        pure
        returns (CandidatePath[] memory candidates, uint256 count)
    {
        ActionModule memory flashMod;
        ActionModule memory borrowMod;
        bool foundFlash;
        bool foundBorrow;

        uint256 swapCount;
        for (uint256 i = 0; i < allModules.length; i++) {
            if (allModules[i].actionType == ActionType.FLASH_LOAN && !foundFlash) {
                flashMod = allModules[i];
                foundFlash = true;
            } else if (allModules[i].actionType == ActionType.BORROW && !foundBorrow) {
                borrowMod = allModules[i];
                foundBorrow = true;
            } else if (allModules[i].actionType == ActionType.SWAP) {
                swapCount++;
            }
        }

        require(foundFlash && foundBorrow, "missing flash or borrow module");

        ActionModule[] memory swapMods = new ActionModule[](swapCount);
        uint256 idx;
        for (uint256 i = 0; i < allModules.length; i++) {
            if (allModules[i].actionType == ActionType.SWAP) {
                swapMods[idx++] = allModules[i];
            }
        }

        address startToken = borrowMod.tokenOut;
        address targetToken = flashMod.tokenIn;

        bytes32[] memory usedEdges = new bytes32[](MAX_DEPTH);

        // Pass 1: count paths
        uint256 pathCount = _countPaths(swapMods, usedEdges, 0, startToken, targetToken, 0);
        if (pathCount == 0) {
            candidates = new CandidatePath[](0);
            return (candidates, 0);
        }
        if (pathCount > MAX_CANDIDATES) pathCount = MAX_CANDIDATES;

        // Pass 2: fill paths
        candidates = new CandidatePath[](pathCount);
        ActionModule[] memory currentPath = new ActionModule[](MAX_DEPTH);

        uint256[] memory fillIdx = new uint256[](1);
        _fillPaths(
            candidates, fillIdx, swapMods, flashMod, borrowMod, usedEdges, 0, currentPath, 0, startToken, targetToken,
            0, minProfit
        );
        count = fillIdx[0];
    }

    function _countPaths(
        ActionModule[] memory swapMods,
        bytes32[] memory usedEdges,
        uint256 usedCount,
        address currentToken,
        address targetToken,
        uint256 depth
    ) private pure returns (uint256 pathCount) {
        if (currentToken == targetToken) return 1;
        if (depth >= MAX_DEPTH) return 0;

        for (uint256 i = 0; i < swapMods.length; i++) {
            if (swapMods[i].tokenIn != currentToken) continue;
            if (_isUsed(usedEdges, usedCount, swapMods[i].moduleId)) continue;

            usedEdges[usedCount] = swapMods[i].moduleId;
            pathCount +=
                _countPaths(swapMods, usedEdges, usedCount + 1, swapMods[i].tokenOut, targetToken, depth + 1);
        }
    }

    function _fillPaths(
        CandidatePath[] memory candidates,
        uint256[] memory fillIdx,
        ActionModule[] memory swapMods,
        ActionModule memory flashMod,
        ActionModule memory borrowMod,
        bytes32[] memory usedEdges,
        uint256 usedCount,
        ActionModule[] memory currentPath,
        uint256 pathLen,
        address currentToken,
        address targetToken,
        uint256 depth,
        uint256 minProfit
    ) private pure {
        if (fillIdx[0] >= candidates.length) return;

        if (currentToken == targetToken) {
            uint256 totalSteps = 2 + pathLen;
            ActionModule[] memory steps = new ActionModule[](totalSteps);
            steps[0] = flashMod;
            steps[1] = borrowMod;
            for (uint256 i = 0; i < pathLen; i++) {
                steps[2 + i] = currentPath[i];
            }

            uint256 ci = fillIdx[0];
            candidates[ci].steps = steps;
            candidates[ci].rawIndex = ci;
            candidates[ci].minProfit = minProfit;
            fillIdx[0] = ci + 1;
            return;
        }

        if (depth >= MAX_DEPTH) return;

        for (uint256 i = 0; i < swapMods.length; i++) {
            if (fillIdx[0] >= candidates.length) return;
            if (swapMods[i].tokenIn != currentToken) continue;
            if (_isUsed(usedEdges, usedCount, swapMods[i].moduleId)) continue;

            usedEdges[usedCount] = swapMods[i].moduleId;
            currentPath[pathLen] = swapMods[i];

            _fillPaths(
                candidates, fillIdx, swapMods, flashMod, borrowMod, usedEdges, usedCount + 1, currentPath, pathLen + 1,
                swapMods[i].tokenOut, targetToken, depth + 1, minProfit
            );
        }
    }

    function _isUsed(bytes32[] memory usedEdges, uint256 usedCount, bytes32 moduleId)
        private
        pure
        returns (bool)
    {
        for (uint256 i = 0; i < usedCount; i++) {
            if (usedEdges[i] == moduleId) return true;
        }
        return false;
    }
}

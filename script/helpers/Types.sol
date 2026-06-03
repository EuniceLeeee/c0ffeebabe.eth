// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

enum ActionType {
    FLASH_LOAN,
    BORROW,
    SWAP
}

enum ReplayMode {
    TRIGGER,
    EXACT
}

struct ActionModule {
    ActionType actionType;
    address protocol;
    address tokenIn;
    address tokenOut;
    bytes32 moduleId;
}

struct CandidatePath {
    ActionModule[] steps;
    uint256 rawIndex;
    uint256 flashAmount;
    uint256 debtAmount1;
    uint256 debtAmount2;
    uint256 v4TakeAmount;
    uint256 v3ExactOutput;
    uint256 minProfit;
}

struct SimResult {
    uint256 rawIndex;
    uint256 supportedIndex;
    uint256 wstUsrProfit;
    uint256 wethProfit;
    bool success;
    bytes txCalldata;
    bytes revertData;
    uint256 scriptLength;
    uint256 calldataLength;
}

struct TriggerInfo {
    address pool;
    uint256 spotQuote;
    uint256 fairQuote;
    uint256 gapBps;
}

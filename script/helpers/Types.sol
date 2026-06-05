// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

enum ActionType {
    FLASH_LOAN,
    BORROW,
    SWAP
}

enum ReplayMode {
    TRIGGER,
    EXACT,
    LIVE
}

struct ExecutionConfig {
    address executor; // address(0) = fork-deploy mode
    address owner; // only used when executor != address(0)
    uint256 gasPriceWei; // # codex修改
    uint256 builderTipWei; // # codex修改
    uint256 minNetProfitWethWei; // # codex修改
    uint256 wstUsrToWethPriceE18; // WETH value per 1 wstUSR, scaled 1e18. // # codex修改
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
    uint256 gasUsed;
    uint256 gasCostWei; // # codex修改
    uint256 wstUsrProfitWethValue; // # codex修改
    uint256 netTotalWethProfit; // # codex修改
    bool coversNetProfit; // # codex修改
}

struct TriggerInfo {
    address pool;
    uint256 spotQuote;
    uint256 fairQuote;
    uint256 gapBps;
}

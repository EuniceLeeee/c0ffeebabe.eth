// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFluidVault {
    /// @param nftId_ 0 to create new position, existing ID to modify
    /// @param newCol_ collateral change (positive = deposit, negative = withdraw)
    /// @param newDebt_ debt change (positive = borrow, negative = repay)
    /// @param to_ address to receive borrowed tokens
    function operate(
        uint256 nftId_,
        int256 newCol_,
        int256 newDebt_,
        address to_
    ) external returns (uint256 nftId, int256 colShares, int256 debtShares);
}

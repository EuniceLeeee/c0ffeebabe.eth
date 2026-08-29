// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IEconomicSafetyTokenFixture {
    function transfer(address recipient, uint256 amount) external returns (bool);
}

contract EconomicSafetyTokenFixture {
    mapping(address account => uint256 balance) public balanceOf;

    function transfer(address recipient, uint256 amount) external returns (bool) {
        uint256 senderBalance = balanceOf[msg.sender];
        require(senderBalance >= amount, "insufficient balance");
        unchecked {
            balanceOf[msg.sender] = senderBalance - amount;
        }
        balanceOf[recipient] += amount;
        return true;
    }
}

contract EconomicSafetyPairFixture {
    address public token0;
    address public token1;

    function swap(uint256 amount0Out, uint256 amount1Out, address recipient, bytes calldata callbackData) external {
        require(callbackData.length == 0, "callback unavailable");
        require((amount0Out == 0) != (amount1Out == 0), "one output required");
        if (amount0Out != 0) require(IEconomicSafetyTokenFixture(token0).transfer(recipient, amount0Out), "token0 transfer");
        if (amount1Out != 0) require(IEconomicSafetyTokenFixture(token1).transfer(recipient, amount1Out), "token1 transfer");
    }
}

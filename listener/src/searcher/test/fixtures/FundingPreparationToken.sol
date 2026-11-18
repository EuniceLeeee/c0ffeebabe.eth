// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Local execution fixture only. Existing inventory is deliberately nonzero;
/// preparation must pass actual per-leg deltas rather than whole balances.
contract FundingPreparationToken {
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 amount);

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        emit Transfer(address(0), msg.sender, msg.value);
    }

    function mint(address receiver, uint256 amount) external {
        balanceOf[receiver] += amount;
        emit Transfer(address(0), receiver, amount);
    }

    function burn(address sender, uint256 amount) external {
        balanceOf[sender] -= amount;
        emit Transfer(sender, address(0), amount);
    }
}

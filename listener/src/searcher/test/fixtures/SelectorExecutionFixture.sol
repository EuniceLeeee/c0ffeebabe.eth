// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Local acceptance fixtures only; no production protocol identity is exposed.
contract SelectorExecutionToken {
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function mint(address receiver, uint256 amount) external {
        balanceOf[receiver] += amount;
        emit Transfer(address(0), receiver, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address receiver, uint256 amount) external returns (bool) {
        _transfer(msg.sender, receiver, amount);
        return true;
    }

    function transferFrom(address sender, address receiver, uint256 amount) external returns (bool) {
        allowance[sender][msg.sender] -= amount;
        _transfer(sender, receiver, amount);
        return true;
    }

    function _transfer(address sender, address receiver, uint256 amount) private {
        balanceOf[sender] -= amount;
        balanceOf[receiver] += amount;
        emit Transfer(sender, receiver, amount);
    }
}

contract SelectorExecutionAlpha {
    SelectorExecutionToken private immutable input;
    SelectorExecutionToken private immutable output;
    mapping(bytes32 => uint256) private rates;

    constructor(SelectorExecutionToken input_, SelectorExecutionToken output_) {
        input = input_;
        output = output_;
    }

    function setRate(bytes32 pool, uint256 rate) external { rates[pool] = rate; }

    function convertByShape(bytes32 pool, uint256 amount, address receiver) external returns (uint256) {
        uint256 rate = rates[pool];
        require(rate > 0, "inactive");
        input.transferFrom(msg.sender, address(this), amount);
        output.transfer(receiver, amount * rate + 7);
        // Deliberately false returndata. A quote must use current balances.
        return 1;
    }
}

/// A different implementation with the same selector and static parameter shape.
contract SelectorExecutionBeta {
    SelectorExecutionToken private immutable input;
    SelectorExecutionToken private immutable output;

    constructor(SelectorExecutionToken input_, SelectorExecutionToken output_) {
        input = input_;
        output = output_;
    }

    function convertByShape(bytes32, uint256 amount, address receiver) external returns (uint256 received) {
        received = amount * 5 + 11;
        input.transferFrom(msg.sender, address(this), amount);
        output.transfer(receiver, received);
    }
}

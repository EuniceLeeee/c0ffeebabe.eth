// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SelectorExecutionToken} from "./SelectorExecutionFixture.sol";

/// Local fixtures expose the execution interface, never an identity registry.
contract SelectorDeclarationAlpha {
    SelectorExecutionToken private immutable input;
    SelectorExecutionToken private immutable output;
    mapping(bytes32 => uint256) private rates;

    constructor(SelectorExecutionToken input_, SelectorExecutionToken output_) {
        input = input_; output = output_;
    }

    function setRate(bytes32 pool, uint256 rate) external { rates[pool] = rate; }

    function quoteByShape(bytes32 pool, uint256 amount) external view returns (uint256) {
        require(rates[pool] > 0, "inactive");
        return amount * rates[pool] + 7;
    }

    function convertByShape(bytes32 pool, uint256 amount, address receiver) external returns (uint256) {
        uint256 rate = rates[pool];
        require(rate > 0, "inactive");
        input.transferFrom(msg.sender, address(this), amount);
        output.transfer(receiver, amount * rate + 7);
        return 1; // Execution returndata deliberately disagrees with balances.
    }
}

contract SelectorDeclarationBeta {
    SelectorExecutionToken private immutable input;
    SelectorExecutionToken private immutable output;

    constructor(SelectorExecutionToken input_, SelectorExecutionToken output_) {
        input = input_; output = output_;
    }

    function quoteByShape(bytes32, uint256) external pure returns (uint256) {
        revert("preview unavailable");
    }

    function convertByShape(bytes32, uint256 amount, address receiver) external returns (uint256 received) {
        received = amount * 5 + 11;
        input.transferFrom(msg.sender, address(this), amount);
        output.transfer(receiver, received);
    }
}

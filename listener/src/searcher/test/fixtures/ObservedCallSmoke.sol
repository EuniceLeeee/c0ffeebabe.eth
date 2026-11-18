// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Local-EVM fixtures only. Neither contract is a production adapter.
contract ObservedCallSmokeToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
    function transfer(address recipient, uint256 amount) external returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        allowance[sender][msg.sender] -= amount;
        _transfer(sender, recipient, amount);
        return true;
    }
    function _transfer(address sender, address recipient, uint256 amount) private {
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
        emit Transfer(sender, recipient, amount);
    }
}

contract ObservedCallSmokePool {
    ObservedCallSmokeToken public immutable input;
    ObservedCallSmokeToken public immutable output;
    constructor(ObservedCallSmokeToken input_, ObservedCallSmokeToken output_) {
        input = input_;
        output = output_;
    }
    function unfamiliarConversion(uint256 amount, address receiver, uint256 minimum) external returns (uint256) {
        input.transferFrom(msg.sender, address(this), amount);
        uint256 received = amount * 3 + 7;
        require(received >= minimum, "minimum");
        output.transfer(receiver, received);
        // Deliberately does not report the actual receipt. The generic runtime
        // must measure the recipient balance instead of trusting returndata.
        return 1;
    }
}

/// Direct share mint: there is no output-token transfer call for the extractor
/// to follow. The target itself emits the mint event and updates its balance.
contract ObservedCallSmokeMintVault is ObservedCallSmokeToken {
    ObservedCallSmokeToken public immutable input;
    constructor(ObservedCallSmokeToken input_) {
        input = input_;
    }
    function unfamiliarMint(uint256 amount, address receiver) external returns (uint256 received) {
        input.transferFrom(msg.sender, address(this), amount);
        received = amount * 2 + 1;
        balanceOf[receiver] += received;
        emit Transfer(address(0), receiver, received);
    }
}

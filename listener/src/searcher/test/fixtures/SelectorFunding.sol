// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SelectorFundingToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; emit Transfer(address(0), to, amount); }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= amount;
        _move(from, to, amount); return true;
    }
    function _move(address from, address to, uint256 amount) internal { balanceOf[from] -= amount; balanceOf[to] += amount; emit Transfer(from, to, amount); }
}
contract SelectorFundingRelay {
    function forward(address to, bytes memory data) external { (bool ok, bytes memory out) = to.call(data); if (!ok) assembly { revert(add(out,32),mload(out)) } }
}
contract SelectorFundingProvider {
    uint256 public rate;
    uint256 public mode;
    function configure(uint256 newRate, uint256 newMode) external { rate = newRate; mode = newMode; }
    function getProtocolFeesCollector() external view returns(address) { return address(this); }
    function getFlashLoanFeePercentage() external view returns(uint256) { return rate; }
    function _callback(address to, bytes memory data) internal {
        if (mode == 2) SelectorFundingRelay(address(0xF00D)).forward(to, data);
        else { (bool ok, bytes memory out) = to.call(data); if (!ok) assembly { revert(add(out,32),mload(out)) } }
    }
    function flashLoan(address token, uint256 amount, bytes memory data) external {
        uint256 beforeBalance = SelectorFundingToken(token).balanceOf(address(this));
        SelectorFundingToken(token).transfer(msg.sender, amount);
        if (mode == 3) data = bytes.concat(data, hex"01");
        _callback(msg.sender, abi.encodeWithSignature("onMorphoFlashLoan(uint256,bytes)", mode == 1 ? amount + 1 : amount, data));
        SelectorFundingToken(token).transferFrom(msg.sender, address(this), amount);
        require(SelectorFundingToken(token).balanceOf(address(this)) == beforeBalance, "repayment");
    }
    function flashLoan(address recipient, address[] memory tokens, uint256[] memory amounts, bytes memory data) external {
        require(tokens.length == 1 && amounts.length == 1, "fixture single borrow");
        uint256 beforeBalance = SelectorFundingToken(tokens[0]).balanceOf(address(this));
        uint256[] memory fees = new uint256[](1); fees[0] = (amounts[0] * rate + 1e18 - 1) / 1e18;
        uint256 debt = amounts[0] + fees[0];
        SelectorFundingToken(tokens[0]).transfer(recipient, amounts[0]);
        if (mode == 1) fees[0]++;
        if (mode == 3) data = bytes.concat(data, hex"01");
        _callback(recipient, abi.encodeWithSignature("receiveFlashLoan(address[],uint256[],uint256[],bytes)", tokens, amounts, fees, data));
        require(SelectorFundingToken(tokens[0]).balanceOf(address(this)) >= beforeBalance + debt - amounts[0], "repayment");
    }
}

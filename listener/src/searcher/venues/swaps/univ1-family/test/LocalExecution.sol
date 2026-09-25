// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../../../../../../../src/BotVM.sol";

// Synthetic local execution controls only. This contract is not identity or
// historical acceptance evidence for the verified Vyper implementation.
contract LocalToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public shortTransfer;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setShort(bool value) external { shortTransfer = value; }
    function approve(address to, uint256 amount) external returns (bool) { allowance[msg.sender][to] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount; _move(from, to, amount); return true;
    }
    function _move(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount; balanceOf[to] += shortTransfer && amount > 0 ? amount - 1 : amount;
    }
}
contract LocalWeth is LocalToken {
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external { balanceOf[msg.sender] -= amount; payable(msg.sender).transfer(amount); }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}
contract LocalBalanceReader {
    function getEthBalance(address account) external view returns(uint256) { return account.balance; }
}
contract LocalExchange {
    LocalToken public immutable token;
    address payable public immutable issuer;
    constructor(LocalToken t, address payable i) { token = t; issuer = i; }
    function price(uint256 amount, uint256 reserveIn, uint256 reserveOut) internal pure returns(uint256) {
        require(reserveIn > 0 && reserveOut > 0); uint256 adjusted = amount * 997;
        return adjusted * reserveOut / (reserveIn * 1000 + adjusted);
    }
    function ethToTokenSwapInput(uint256 minimum, uint256 deadline) external payable returns(uint256 out) {
        require(deadline >= block.timestamp && msg.value > 0 && minimum > 0);
        uint256 fee = (msg.value + 999) / 1000;
        uint256 sold = msg.value - fee;
        out = price(sold, address(this).balance - sold, token.balanceOf(address(this)));
        require(out >= minimum); issuer.transfer(fee); require(token.transfer(msg.sender, out));
    }
    function tokenToEthSwapInput(uint256 amount, uint256 minimum, uint256 deadline) external returns(uint256 out) {
        require(deadline >= block.timestamp && amount > 0 && minimum > 0);
        uint256 fee = (amount + 999) / 1000;
        out = price(amount - fee, token.balanceOf(address(this)), address(this).balance);
        require(out >= minimum); payable(msg.sender).transfer(out);
        require(token.transferFrom(msg.sender, issuer, fee)); require(token.transferFrom(msg.sender, address(this), amount - fee));
    }
    receive() external payable {}
}

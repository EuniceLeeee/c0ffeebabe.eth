// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Controlled dependency fixtures only. The tested exchange runtime is the
// hash-verified original public-sample.json bytecode, never a copied formula.
contract EllaTokenFixture {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function seed(address account, uint256 amount) external { balanceOf[account] = amount; }
    function decimals() external pure returns (uint8) { return 18; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }
}
contract EllaFeeFixture {
    uint256 public fee;
    uint256 public cut;
    address public recipient;
    function configure(uint256 f, uint256 c, address r) external { fee = f; cut = c; recipient = r; }
    function getFees() external view returns (uint256) { return fee; }
    function getSystemCut() external view returns (uint256) { return cut; }
    function getFeesAddress() external view returns (address) { return recipient; }
}
contract EllaOracleFixture {
    int256 public answer;
    function configure(int256 value) external { answer = value; }
    function decimals() external pure returns (uint8) { return 18; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
contract EllaTrialDriver {
    event Step(uint256 index, uint256 poolToken, uint256 poolNative, uint256 actorToken,
        uint256 actorNative, uint256 feesToken, uint256 feesNative);
    function run(address pool, EllaTokenFixture token, address fees, bool[] calldata buys, uint256[] calldata amounts) external {
        require(buys.length == amounts.length);
        token.approve(pool, type(uint256).max);
        for (uint256 i = 0; i < buys.length; i++) {
            (bool ok, bytes memory reason) = buys[i]
                ? pool.call{value: amounts[i]}(abi.encodeWithSignature("swapBase1()"))
                : pool.call(abi.encodeWithSignature("swap1(uint256)", amounts[i]));
            if (!ok) assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
            emit Step(i, token.balanceOf(pool), pool.balance, token.balanceOf(address(this)), address(this).balance,
                token.balanceOf(fees), fees.balance);
        }
    }
    receive() external payable {}
}

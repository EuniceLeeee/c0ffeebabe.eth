// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {V4NativeFundingFixture} from "./V4NativeFundingFixture.sol";
contract FixtureToken {
    mapping(address => uint256) public balanceOf;
    uint256 immutable mode;
    constructor(uint256 m) { mode = m; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(mode != 5, "reverted transfer");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += mode == 4 ? amount - 1 : amount;
        if (mode == 1) assembly { return(0, 0) }
        if (mode == 2) return false;
        if (mode == 3) assembly { mstore(0, 1) return(31, 1) }
        return true;
    }
}
contract V4FundingFixtureTest {
    function run(uint256 mode, bool expected) internal {
        V4NativeFundingFixture fixture = new V4NativeFundingFixture();
        FixtureToken input = new FixtureToken(mode);
        FixtureToken output = new FixtureToken(0);
        address recipient = address(0x1234);
        input.mint(address(fixture), 101); input.mint(recipient, 17);
        output.mint(address(fixture), 1);
        (bool ok, bytes memory data) = address(fixture).call(abi.encodeCall(fixture.fund,
            (address(input), address(output), 1, 101, recipient)));
        require(ok == expected, "acceptance boundary");
        require(input.balanceOf(address(fixture)) == (ok ? 0 : 101), "debt conservation/rollback");
        require(input.balanceOf(recipient) == (ok ? 118 : 17), "actual receipt/rollback");
        if (ok) require(abi.decode(data, (uint256)) == 101, "full declared debt");
    }
    function testBooleanSuccess() public { run(0, true); }
    function testEmptySuccess() public { run(1, true); }
    function testFalseRejected() public { run(2, false); }
    function testShortRejected() public { run(3, false); }
    function testShortReceiptRejected() public { run(4, false); }
    function testRevertRejected() public { run(5, false); }
}

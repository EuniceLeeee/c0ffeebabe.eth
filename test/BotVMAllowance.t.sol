// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";
import {BotVMEncoder} from "../src/BotVMEncoder.sol";

contract AllowanceToken {
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public approvals;
    uint256 public zeros;
    uint256 public mode;
    function configure(uint256 m) external { mode = m; }
    function seed(address who, address spender, uint256 value) external { allowance[who][spender] = value; }
    function spend(address who, uint256 value) external { allowance[who][msg.sender] -= value; }
    function approve(address spender, uint256 value) external returns (bool) {
        if (mode == 1 && value != 0 && allowance[msg.sender][spender] != 0) revert("reset required");
        if (mode == 2) return false;
        if (mode == 3) return true; // Lying token, unchanged allowance.
        approvals++; if (value == 0) zeros++;
        allowance[msg.sender][spender] = value;
        if (mode == 4) assembly { return(0, 0) } // Legacy no-return ERC20.
        if (mode == 5) assembly { mstore(0, 2) return(0, 32) }
        return true;
    }
}
contract AllowanceSpender {
    function spend(AllowanceToken token, uint256 amount) external { token.spend(msg.sender, amount); }
}
contract MalformedAllowance {
    fallback() external { assembly { mstore(0, 0) return(0, 1) } }
}

contract BotVMAllowanceTest is Test {
    BotVM bot; AllowanceToken token; AllowanceSpender spender;
    function setUp() public { bot = new BotVM(); token = new AllowanceToken(); spender = new AllowanceSpender(); }
    function ensure(address t, address s, uint256 minimum, uint256 grant) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(10), t, s, minimum, grant);
    }
    function script(uint256 minimum, uint256 grant) internal view returns (bytes memory) {
        return ensure(address(token), address(spender), minimum, grant);
    }
    function testExistingAllowanceSkipsApproveAndKeepsFiniteGrant() public {
        token.seed(address(bot), address(spender), 200);
        bot.execute(script(100, type(uint256).max));
        assertEq(token.approvals(), 0); assertEq(token.allowance(address(bot), address(spender)), 200);
    }
    function testZeroAllowanceApprovesOnceWithoutCleanup() public {
        bot.execute(script(100, 100));
        assertEq(token.approvals(), 1); assertEq(token.zeros(), 0);
        assertEq(token.allowance(address(bot), address(spender)), 100);
    }
    function testInsufficientStandardAllowanceDoesNotReset() public {
        token.seed(address(bot), address(spender), 50); bot.execute(script(100, 120));
        assertEq(token.approvals(), 1); assertEq(token.zeros(), 0);
        assertEq(token.allowance(address(bot), address(spender)), 120);
    }
    function testZeroBeforeNonzeroFallback() public {
        token.configure(1); token.seed(address(bot), address(spender), 50);
        bot.execute(script(100, 100));
        assertEq(token.approvals(), 2); assertEq(token.zeros(), 1);
        assertEq(token.allowance(address(bot), address(spender)), 100);
    }
    function testNoReturnTokenStillChecksActualAllowance() public {
        token.configure(4); bot.execute(script(100, 100)); assertEq(token.approvals(), 1);
    }
    function testFalseReturnReverts() public {
        token.configure(2); vm.expectRevert("allowance reset failed"); bot.execute(script(100, 100));
    }
    function testMalformedBooleanRevertsAndRollsBack() public {
        token.configure(5); vm.expectRevert("allowance reset failed"); bot.execute(script(100, 100));
        assertEq(token.approvals(), 0);
    }
    function testSuccessWithoutSettingAllowanceReverts() public {
        token.configure(3); vm.expectRevert("allowance not set"); bot.execute(script(100, 100));
    }
    function testRepeatedSpenderRechecksAfterConsumption() public {
        bytes memory spend = BotVMEncoder.encodeCall(address(spender), abi.encodeCall(AllowanceSpender.spend, (token, 100)));
        bot.execute(bytes.concat(script(100, 100), spend, script(100, 100), spend));
        assertEq(token.approvals(), 2); assertEq(token.zeros(), 0);
        assertEq(token.allowance(address(bot), address(spender)), 0);
    }
    function testRepeatedSpenderSkipsWhenStillSufficient() public {
        bytes memory spend = BotVMEncoder.encodeCall(address(spender), abi.encodeCall(AllowanceSpender.spend, (token, 100)));
        bot.execute(bytes.concat(script(100, 300), spend, script(100, 300), spend));
        assertEq(token.approvals(), 1); assertEq(token.allowance(address(bot), address(spender)), 100);
    }
    function testMalformedAllowanceReadAndNoCodeFailClosed() public {
        address malformed = address(new MalformedAllowance());
        vm.expectRevert("allowance read failed"); bot.execute(ensure(malformed, address(spender), 1, 1));
        vm.expectRevert("allowance token has no code"); bot.execute(ensure(address(99), address(spender), 1, 1));
        // A precompile may return a 32-byte hash for arbitrary calldata. It
        // must not impersonate an ERC20 with a sufficient allowance.
        vm.expectRevert("allowance token has no code"); bot.execute(ensure(address(2), address(spender), 1, 1));
    }
    function testMalformedBoundsAndGrantRejected() public {
        vm.expectRevert("allowance bounds"); bot.execute(hex"0a00");
        vm.expectRevert("allowance config"); bot.execute(script(100, 99));
        vm.expectRevert("allowance config"); bot.execute(script(0, 100));
        vm.expectRevert("allowance config"); bot.execute(ensure(address(token), address(0), 1, 1));
    }
    function testFuzzNeverWidensDeclaredGrant(uint128 need, uint128 excess) public {
        vm.assume(need > 0); uint256 grant = uint256(need) + excess;
        bot.execute(script(need, grant));
        assertEq(token.allowance(address(bot), address(spender)), grant);
        assertEq(token.approvals(), 1);
    }
}

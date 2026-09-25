// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";
import {BotVMEncoder} from "../src/BotVMEncoder.sol";
import {Constants} from "../src/Constants.sol";

contract NativeWrapWeth {
    mapping(address => uint256) public balanceOf;
    function mint(address account, uint256 amount) external { balanceOf[account] += amount; }
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
}
contract NativeWrapBadWeth {
    function balanceOf(address) external pure returns (uint256) { return 0; }
    function deposit() external payable {}
}
contract NativeWrapRevertingWeth {
    function balanceOf(address) external pure returns (uint256) { return 0; }
    function deposit() external payable { revert("no deposit"); }
}
contract NativePayout {
    function pay(uint256 value) external {
        (bool ok,) = msg.sender.call{value:value}(""); require(ok);
    }
    function fail() external pure { revert("payout failed"); }
    receive() external payable {}
}

contract BotVMNativeWrapTest is Test {
    BotVM private bot;
    NativePayout private payout;
    NativeWrapWeth private weth;
    function setUp() public {
        bot = new BotVM(); payout = new NativePayout();
        vm.etch(Constants.WETH, address(new NativeWrapWeth()).code);
        weth = NativeWrapWeth(Constants.WETH);
        vm.deal(address(bot), 17); vm.deal(address(payout), 1 ether);
        weth.mint(address(bot), 777);
    }
    function action(uint256 received) private view returns (bytes memory) {
        return BotVMEncoder.encodeCall(address(payout), abi.encodeCall(NativePayout.pay, (received)));
    }
    function testWrapExactActualNotQuote() public {
        bot.execute(BotVMEncoder.encodeWrapNativeDelta(action(1001)));
        assertEq(address(bot).balance,17); assertEq(weth.balanceOf(address(bot)),1778);
    }
    function testOneLessAndOneMoreBothUseActual() public {
        bot.execute(BotVMEncoder.encodeWrapNativeDelta(action(999)));
        bot.execute(BotVMEncoder.encodeWrapNativeDelta(action(1001)));
        assertEq(address(bot).balance,17); assertEq(weth.balanceOf(address(bot)),2777);
    }
    function testZeroDoesNotSweepInventory() public {
        bot.execute(BotVMEncoder.encodeWrapNativeDelta(action(0)));
        assertEq(address(bot).balance,17); assertEq(weth.balanceOf(address(bot)),777);
    }
    function testNestedDoesNotDoubleWrap() public {
        bot.execute(BotVMEncoder.encodeWrapNativeDelta(bytes.concat(
            BotVMEncoder.encodeWrapNativeDelta(action(10)),action(20))));
        assertEq(address(bot).balance,17); assertEq(weth.balanceOf(address(bot)),807);
    }
    function testRejectConsumedNativeInventory() public {
        vm.expectRevert("native inventory consumed");
        bot.execute(BotVMEncoder.encodeWrapNativeDelta(BotVMEncoder.encodeCallValue(address(payout),1,"")));
        assertEq(address(bot).balance,17);
    }
    function testRejectIncorrectMint() public {
        vm.etch(Constants.WETH,address(new NativeWrapBadWeth()).code);
        vm.expectRevert("native wrap amount");
        bot.execute(BotVMEncoder.encodeWrapNativeDelta(action(1000)));
        assertEq(address(bot).balance,17); assertEq(address(payout).balance,1 ether);
    }
    function testRejectDepositFailure() public {
        vm.etch(Constants.WETH,address(new NativeWrapRevertingWeth()).code);
        vm.expectRevert("native wrap failed");bot.execute(BotVMEncoder.encodeWrapNativeDelta(action(1000)));
    }
    function testPayoutFailureRollsBack() public {
        vm.expectRevert("native wrap action failed");
        bot.execute(BotVMEncoder.encodeWrapNativeDelta(BotVMEncoder.encodeCall(address(payout),abi.encodeCall(NativePayout.fail,()))));
    }
    function testReturnCannotBypassWrapping() public {
        bot.execute(BotVMEncoder.encodeWrapNativeDelta(bytes.concat(action(10),BotVMEncoder.encodeReturn(""))));
        assertEq(address(bot).balance,17); assertEq(weth.balanceOf(address(bot)),787);
    }
    function testContinuationRemainsExecutable() public {
        bot.execute(bytes.concat(BotVMEncoder.encodeWrapNativeDelta(action(10)),
            BotVMEncoder.encodeAssertBalanceGte(Constants.WETH,787)));
    }
    function testTruncatedHeaderAndBodyReject() public {
        vm.expectRevert("native wrap header");bot.execute(hex"0b0000");
        vm.expectRevert("native wrap bounds");bot.execute(hex"0b00000200");
    }
    function testEncodingVector() public pure {
        assertEq(BotVMEncoder.encodeWrapNativeDelta(hex"001122"),hex"0b000003001122");
    }
}

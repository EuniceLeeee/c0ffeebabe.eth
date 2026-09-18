// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";
import {BotVMEncoder} from "../src/BotVMEncoder.sol";

contract FlowToken {
    mapping(address => uint256) public balanceOf;
    function mint(address who, uint256 amount) external { balanceOf[who] += amount; }
    function burn(address who, uint256 amount) external { balanceOf[who] -= amount; }
}

contract FlowSwap {
    uint256 public received;
    function swap(FlowToken input, FlowToken output, uint256 amount, uint256 result) external {
        received = amount;
        input.burn(msg.sender, amount);
        output.mint(msg.sender, result);
    }
}

contract BotVMAmountFlowTest is Test {
    BotVM private bot;
    FlowToken private a;
    FlowToken private b;
    FlowSwap private first;
    FlowSwap private second;

    function setUp() public {
        bot = new BotVM(); a = new FlowToken(); b = new FlowToken();
        first = new FlowSwap(); second = new FlowSwap();
        a.mint(address(bot), 1100); b.mint(address(bot), 777);
    }

    function variant(FlowSwap pool, FlowToken input, FlowToken output,
        uint256 amount, uint256 quoted, uint256 actual) private pure returns (bytes memory) {
        bytes memory action = BotVMEncoder.encodeCall(address(pool),
            abi.encodeCall(FlowSwap.swap, (input, output, amount, actual)));
        return abi.encodePacked(amount, quoted, uint8(0), uint24(action.length), action);
    }

    function step(FlowToken input, FlowToken output, uint8 cases, bytes memory records)
        private pure returns (bytes memory) {
        bytes memory section = abi.encodePacked(uint24(0), records);
        return abi.encodePacked(address(input), address(output), cases, uint24(section.length), section);
    }

    function script(uint8 tolerance, uint256 firstOut, uint256 finalShortfall) private view returns (bytes memory) {
        bytes memory one = step(a, b, 1, variant(first, a, b, 100, 200, firstOut));
        bytes memory two = step(b, a, 2, bytes.concat(
            variant(second, b, a, 200, 1000, 1000 - finalShortfall),
            variant(second, b, a, 199, 995, 995 - finalShortfall)));
        bytes memory data = abi.encodePacked(uint256(100), tolerance, uint8(2), one, two);
        return abi.encodePacked(uint8(9), uint24(data.length), data);
    }

    function testExactOutputSpendsAllAndLeavesNoNewDust() public {
        bot.execute(script(1, 200, 0));
        assertEq(second.received(), 200); assertEq(b.balanceOf(address(bot)), 777);
        assertEq(a.balanceOf(address(bot)), 2000);
    }
    function testOneUnitShortUsesActualInputNotInventory() public {
        bot.execute(script(1, 199, 0));
        assertEq(second.received(), 199); assertEq(b.balanceOf(address(bot)), 777);
        assertEq(a.balanceOf(address(bot)), 1995);
    }
    function testOffRejectsOneUnitShortDespiteInventory() public {
        vm.expectRevert("flow output shortfall"); bot.execute(script(0, 199, 0));
        assertEq(b.balanceOf(address(bot)), 777);
    }
    function testTwoUnitsShortRejectedDespiteInventory() public {
        vm.expectRevert("flow output shortfall"); bot.execute(script(1, 198, 0));
    }
    function testEachActualInputHasItsOwnQuoteAndOneUnitMinimum() public {
        bot.execute(script(1, 199, 1));
        assertEq(a.balanceOf(address(bot)), 1994);
    }
    function testNoBroadWorstCaseFloorForFullInput() public {
        // 998 exceeds the lower-input quote (995), but is two units below the
        // quote for the actual 200 input (1000). It must still revert.
        vm.expectRevert("flow output shortfall"); bot.execute(script(1, 200, 2));
    }
    function testUnquotedOverdeliveryFailsClosed() public {
        vm.expectRevert("flow unquoted input"); bot.execute(script(1, 201, 0));
    }
    function testRejectMalformedFlow() public {
        vm.expectRevert("flow bounds"); bot.execute(hex"090000ff");
    }
    function compactScript(uint24 patchOffset) private view returns (bytes memory) {
        bytes memory base = BotVMEncoder.encodeCall(address(first),
            abi.encodeCall(FlowSwap.swap, (a, b, 100, 200)));
        bytes memory patch = abi.encodePacked(patchOffset, uint8(1), uint8(199));
        bytes memory records = abi.encodePacked(uint24(base.length), base,
            uint256(100), uint256(200), uint8(1), uint24(patch.length), patch);
        bytes memory one = abi.encodePacked(address(a), address(b), uint8(1), uint24(records.length), records);
        bytes memory two = step(b, a, 1, variant(second, b, a, 199, 995, 995));
        bytes memory data = abi.encodePacked(uint256(100), uint8(1), uint8(2), one, two);
        return abi.encodePacked(uint8(9), uint24(data.length), data);
    }
    function testLosslessPatchForActualInput() public {
        bot.execute(compactScript(155));
        assertEq(second.received(), 199); assertEq(b.balanceOf(address(bot)), 777);
    }
    function testPatchCannotWriteOutsideSelectedScript() public {
        vm.expectRevert("flow patch bounds"); bot.execute(compactScript(156));
    }
    function testOffAndOnHaveSameBalancesWhenNoShortfall() public {
        uint256 snapshot = vm.snapshotState(); bot.execute(script(0, 200, 0));
        uint256 aOff = a.balanceOf(address(bot)); uint256 bOff = b.balanceOf(address(bot));
        vm.revertToState(snapshot); bot.execute(script(1, 200, 0));
        assertEq(a.balanceOf(address(bot)), aOff); assertEq(b.balanceOf(address(bot)), bOff);
    }
}

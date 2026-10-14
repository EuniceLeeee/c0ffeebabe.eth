// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";

contract RuntimeTestToken {
    mapping(address => uint256) public balanceOf;
    function mint(address who, uint256 n) external { balanceOf[who] += n; }
    function burn(address who, uint256 n) external { balanceOf[who] -= n; }
    function transfer(address who, uint256 n) external returns (bool) {
        balanceOf[msg.sender] -= n; balanceOf[who] += n; return true;
    }
}
contract RuntimeTestSwap {
    uint256 public received;
    function swap(RuntimeTestToken a, RuntimeTestToken b, uint256 amount, uint256 output, uint256 extra) external returns(uint256) {
        received = amount; a.burn(msg.sender, amount + extra); b.mint(msg.sender, output); return output;
    }
    function swapWithOtherTokenChange(RuntimeTestToken a, RuntimeTestToken b, uint256 amount, uint256 output, RuntimeTestToken other) external {
        a.burn(msg.sender, amount); b.mint(msg.sender, output); other.burn(msg.sender, 1);
    }
    function swapWithDust(RuntimeTestToken a, RuntimeTestToken b, uint256 amount, uint256 output, uint256 dust) external {
        received = amount; a.burn(msg.sender, amount - dust); b.mint(msg.sender, output);
    }
}
contract RuntimeTestCallback {
    bool public omit;
    bool public corrupt;
    bool public twice;
    function configure(bool a, bool b, bool c) external { omit = a; corrupt = b; twice = c; }
    function run(bytes memory script) external {
        if (omit) return;
        if (corrupt) script[0] = bytes1(uint8(script[0]) ^ 1);
        (bool ok,) = msg.sender.call(abi.encodeWithSignature("callback(bytes)", script));
        require(ok, "callback failed");
        if (twice) {
            (ok,) = msg.sender.call(abi.encodeWithSignature("callback(bytes)", script));
            require(ok, "second callback failed");
        }
    }
}
contract RuntimeTestCallbackRelay {
    function relay(address bot, bytes calldata script) external {
        (bool ok,) = bot.call(abi.encodeWithSignature("callback(bytes)", script));
        require(ok, "relay callback failed");
    }
}
contract RuntimeTestForwardedCallback {
    RuntimeTestCallbackRelay private relay = new RuntimeTestCallbackRelay();
    function run(bytes calldata script) external { relay.relay(msg.sender, script); }
}
contract RuntimeTestDebtCallback {
    RuntimeTestToken public token;
    uint256 public paid;
    constructor(RuntimeTestToken t) { token = t; }
    function run(int256 debt, bytes memory script) external {
        uint256 beforeBalance = token.balanceOf(address(this));
        (bool ok,) = msg.sender.call(abi.encodeWithSignature("settle(int256,bytes)", debt, script));
        require(ok, "debt callback failed");
        paid = token.balanceOf(address(this)) - beforeBalance;
    }
}
contract RuntimeTestNative {
    function pay(uint256 amount) external {
        (bool ok,) = msg.sender.call{value: amount}(""); require(ok, "native receipt");
    }
    function accept() external payable {}
}
contract RuntimeTestWrapped is RuntimeTestToken {
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
}
contract RuntimeTestRevertingProbe {
    RuntimeTestToken immutable token;
    uint256 public calls;
    error ProbeResult(uint256 amount);
    constructor(RuntimeTestToken t) { token = t; }
    function probe(uint256 input, uint8 mode) external {
        calls++;
        token.mint(msg.sender, input); // These writes MUST be rolled back.
        if (mode == 2) revert("different error");
        if (mode == 3) assembly { revert(0, 0) }
        if (mode == 4) {
            (bool ok, bytes memory reason) = msg.sender.call(abi.encodeWithSignature("callback(bytes)", hex"05"));
            require(!ok && keccak256(reason) == keccak256(abi.encodeWithSignature("Error(string)", "runtime callback sender")), "probe callback isolation");
        }
        bytes memory data = abi.encodeWithSelector(ProbeResult.selector, input * 2);
        if (mode == 1) assembly { return(add(data, 32), mload(data)) }
        assembly { revert(add(data, 32), mload(data)) }
    }
}
contract BotVMRuntimeAmountTest is Test {
    BotVM bot;
    RuntimeTestToken a;
    RuntimeTestToken b;
    RuntimeTestSwap pool;
    function setUp() public {
        bot = new BotVM(); a = new RuntimeTestToken(); b = new RuntimeTestToken(); pool = new RuntimeTestSwap();
        a.mint(address(bot), 1100); b.mint(address(bot), 777);
    }
    function callOp(address target, bytes memory payload, bytes memory patches, uint24 incoming, uint24 outgoing) internal pure returns(bytes memory) {
        return abi.encodePacked(uint8(1), target, uint8(0), uint8(255), incoming, outgoing,
            uint8(patches.length / 4), patches, uint24(payload.length), payload);
    }
    function swapProgram(RuntimeTestToken input, RuntimeTestToken output, uint256 result, uint256 extra) internal view returns(bytes memory) {
        return abi.encodePacked(uint8(1), callOp(address(pool), abi.encodeCall(RuntimeTestSwap.swap, (input, output, 0, result, extra)),
            abi.encodePacked(uint24(68), uint8(0)), 0, 0));
    }
    function leg(RuntimeTestToken input, RuntimeTestToken output, uint256 minimum, bytes memory p) internal pure returns(bytes memory) {
        return abi.encodePacked(address(input), address(output), minimum, uint24(p.length), p);
    }
    function flow(uint256 firstOut, uint256 extra, uint256 minOut) internal view returns(bytes memory) {
        bytes memory data = abi.encodePacked(uint256(100), uint8(2),
            leg(a, b, minOut, swapProgram(a, b, firstOut, 0)),
            leg(b, a, 101, swapProgram(b, a, 120, extra)));
        return abi.encodePacked(uint8(12), uint24(data.length), data);
    }
    function script(bytes memory p, uint256 amount) internal pure returns(bytes memory) {
        return abi.encodePacked(uint8(14), amount, uint24(p.length), p);
    }
    function testArbitraryActualReceiptNotJustOneUnit() public {
        bot.execute(flow(312345, 0, 1));
        assertEq(pool.received(), 312345); assertEq(b.balanceOf(address(bot)), 777);
        assertEq(a.balanceOf(address(bot)), 1120);
    }
    function testOneUnitLowerAndHigherUseActualInput() public {
        bot.execute(flow(199, 0, 1)); assertEq(pool.received(), 199);
        bot.execute(flow(201, 0, 1)); assertEq(pool.received(), 201);
        assertEq(b.balanceOf(address(bot)), 777);
    }
    function testInventoryCannotSubsidizeInputShortfall() public {
        vm.expectRevert("runtime input rounding"); bot.execute(flow(200, 1, 1));
        assertEq(a.balanceOf(address(bot)), 1100); assertEq(b.balanceOf(address(bot)), 777);
    }
    function testEarlierRouteTokenInventoryIsPreserved() public {
        RuntimeTestToken c = new RuntimeTestToken();
        bytes memory last = abi.encodePacked(uint8(1), callOp(address(pool),
            abi.encodeCall(RuntimeTestSwap.swapWithOtherTokenChange, (c, a, 0, 120, b)),
            abi.encodePacked(uint24(68), uint8(0)), 0, 0));
        bytes memory data = abi.encodePacked(uint256(100), uint8(3),
            leg(a, b, 1, swapProgram(a, b, 200, 0)),
            leg(b, c, 1, swapProgram(b, c, 300, 0)), leg(c, a, 101, last));
        vm.expectRevert("runtime route inventory");
        bot.execute(abi.encodePacked(uint8(12), uint24(data.length), data));
        assertEq(b.balanceOf(address(bot)), 777);
    }
    function testMinimumOutputAndZeroFailClosed() public {
        vm.expectRevert("runtime minimum output"); bot.execute(flow(200, 0, 201));
        vm.expectRevert("runtime minimum output"); bot.execute(flow(0, 0, 0));
    }
    function testFuzzActualAmount(uint64 value) public {
        uint256 output = bound(value, 1, type(uint64).max);
        bot.execute(flow(output, 0, 1)); assertEq(pool.received(), output);
        assertEq(b.balanceOf(address(bot)), 777);
    }
    function testRepeatedTokenUsesOnlyWorkingAmount() public {
        RuntimeTestToken c = new RuntimeTestToken();
        c.mint(address(bot), 999);
        bytes memory data = abi.encodePacked(uint256(100), uint8(4),
            leg(a, b, 1, swapProgram(a, b, 200, 0)),
            leg(b, a, 1, swapProgram(b, a, 150, 0)),
            leg(a, c, 1, swapProgram(a, c, 300, 0)),
            leg(c, a, 101, swapProgram(c, a, 120, 0)));
        bot.execute(abi.encodePacked(uint8(12), uint24(data.length), data));
        assertEq(pool.received(), 300);
        assertEq(a.balanceOf(address(bot)), 1120);
        assertEq(b.balanceOf(address(bot)), 777);
        assertEq(c.balanceOf(address(bot)), 999);
    }
    function testOneReceiptReadPerHopAndOneInventoryBoundary() public {
        vm.expectCall(address(a), abi.encodeWithSignature("balanceOf(address)", address(bot)), 3);
        vm.expectCall(address(b), abi.encodeWithSignature("balanceOf(address)", address(bot)), 4);
        bot.execute(flow(200, 0, 1));
    }
    function testPatchAndReturnBounds() public {
        bytes memory p = abi.encodePacked(uint8(1), callOp(address(pool), abi.encodeCall(RuntimeTestSwap.swap, (a, b, 0, 10, 0)),
            abi.encodePacked(uint24(163), uint8(0)), 0, 0));
        vm.expectRevert("runtime patch bounds"); bot.execute(script(p, 100));
        vm.expectRevert("runtime word bounds"); bot.execute(script(hex"010601000000", 100));
    }
    function testMathOverflowAndInvalidRegister() public {
        bytes memory p = abi.encodePacked(uint8(1), uint8(0), uint8(1), type(uint256).max, hex"0200020001");
        vm.expectRevert(stdError.arithmeticError); bot.execute(script(p, 1));
        vm.expectRevert(stdError.indexOOBError); bot.execute(script(abi.encodePacked(hex"010010", uint256(1)), 1));
    }
    function testFuzzEqualityProducesBooleanAcrossFullUint256(uint256 left, uint256 right) public {
        bytes memory p = abi.encodePacked(hex"010001", left, hex"0002", right,
            hex"0207030102", hex"0004", uint256(left == right ? 1 : 0), hex"030304");
        bot.execute(script(p, 100));
        // Assert-equal is still a rejecting guard, not the new value operator.
        if (left != right) { vm.expectRevert("runtime amount mismatch"); bot.execute(script(abi.encodePacked(hex"010001", left, hex"0002", right, hex"030102"), 100)); }
    }
    function testEqualityAliasesAndReadonlyNesting() public {
        bytes memory child = abi.encodePacked(hex"010001", type(uint256).max,
            hex"0002", uint256(0), hex"0207000102");
        bytes memory p = abi.encodePacked(hex"0108000301", uint24(child.length), child,
            hex"0004", uint256(0), hex"030304");
        bot.execute(script(p, 100));
        p = abi.encodePacked(hex"010001", type(uint256).max, hex"0207010101",
            hex"0002", uint256(1), hex"030102");
        bot.execute(script(p, 100));
        vm.expectRevert("runtime math opcode"); bot.execute(script(hex"010209010000", 100));
    }
    function testUnsignedMinimumFullRange() public {
        uint256[6] memory left = [uint256(0), type(uint256).max, 0, type(uint256).max, 17, 23];
        uint256[6] memory right = [uint256(0), type(uint256).max, type(uint256).max, 0, 23, 17];
        for (uint256 i; i < left.length; ++i) {
            bytes memory p = abi.encodePacked(hex"010001", left[i], hex"0002", right[i],
                hex"0208030102", hex"0004", uint256(left[i] < right[i] ? left[i] : right[i]), hex"030304");
            bot.execute(script(p, 100));
        }
    }
    function testUnsignedMinimumAliasesAndReadonlyNesting() public {
        bytes memory child = abi.encodePacked(hex"010001", type(uint256).max, hex"0208000001");
        bytes memory p = abi.encodePacked(hex"0108000301", uint24(child.length), child,
            hex"0004", uint256(100), hex"030304");
        bot.execute(script(p, 100));
        p = abi.encodePacked(hex"010001", type(uint256).max, hex"0208010101",
            hex"0002", type(uint256).max, hex"030102");
        bot.execute(script(p, 100));
    }
    function callbackProgram(RuntimeTestCallback cb, bytes memory inner) internal pure returns(bytes memory) {
        return abi.encodePacked(uint8(1), callOp(address(cb), abi.encodeCall(RuntimeTestCallback.run, (inner)), "", 68, 68));
    }
    function testNestedCallbackAmountIsInvocationLocal() public {
        RuntimeTestCallback cb = new RuntimeTestCallback();
        bytes memory nested = script(swapProgram(a, b, 23, 0), 10);
        bytes memory outer = bytes.concat(callbackProgram(cb, nested), swapProgram(a, b, 24, 0));
        // Remove nested program's version byte when appending instructions.
        bytes memory tail = swapProgram(a, b, 24, 0);
        outer = callbackProgram(cb, nested);
        for (uint256 i = 1; i < tail.length; ++i) outer = bytes.concat(outer, tail[i]);
        bot.execute(script(outer, 100));
        assertEq(pool.received(), 100); assertEq(a.balanceOf(address(bot)), 990);
    }
    function testCallbackMissingChangedAndRepeatedRejected() public {
        RuntimeTestCallback cb = new RuntimeTestCallback();
        bytes memory p = callbackProgram(cb, script(swapProgram(a, b, 23, 0), 10));
        cb.configure(true, false, false);
        vm.expectRevert("runtime callback missing"); bot.execute(script(p, 100));
        cb.configure(false, true, false);
        vm.expectRevert("runtime external call"); bot.execute(script(p, 100));
        cb.configure(false, false, true);
        vm.expectRevert("runtime external call"); bot.execute(script(p, 100));
    }
    function testMalformedFlowAndProgramRejected() public {
        vm.expectRevert("runtime program version"); bot.execute(script(hex"02", 1));
        vm.expectRevert("runtime flow config");
        bot.execute(abi.encodePacked(uint8(12), uint24(33), uint256(100), uint8(7)));
    }
    function dustProgram(RuntimeTestToken input, RuntimeTestToken output, uint256 result, uint256 dust) internal view returns(bytes memory) {
        return abi.encodePacked(uint8(1), callOp(address(pool),
            abi.encodeCall(RuntimeTestSwap.swapWithDust, (input, output, 0, result, dust)),
            abi.encodePacked(uint24(68), uint8(0)), 0, 0));
    }
    function dustFlow(uint8 flag, uint256 firstDust, uint256 secondDust, uint256 finalOut) internal view returns(bytes memory) {
        bytes memory data = abi.encodePacked(uint256(100), flag,
            leg(a, b, 1, dustProgram(a, b, 200, firstDust)),
            leg(b, a, 101, dustProgram(b, a, finalOut, secondDust)));
        return abi.encodePacked(uint8(12), uint24(data.length), data);
    }
    function testRoundingOffRejectsFundingAndIntermediateDust() public {
        vm.expectRevert("runtime input rounding"); bot.execute(dustFlow(2, 1, 0, 120));
        vm.expectRevert("runtime input rounding"); bot.execute(dustFlow(2, 0, 1, 120));
        assertEq(a.balanceOf(address(bot)), 1100); assertEq(b.balanceOf(address(bot)), 777);
    }
    function maximumDustFlow(uint8 mask, uint256 firstDust, uint256 secondDust, uint256 finalOut) internal view returns(bytes memory) {
        bytes memory data = abi.encodePacked(uint256(100), uint8(0x42), mask,
            leg(a, b, 1, dustProgram(a, b, 200, firstDust)),
            leg(b, a, 101, dustProgram(b, a, finalOut, secondDust)));
        return abi.encodePacked(uint8(12), uint24(data.length), data);
    }
    function testMaximumInputRetainsFundingAndIntermediateBudget() public {
        bot.execute(maximumDustFlow(3, 7, 19, 120));
        assertEq(pool.received(), 200);
        assertEq(a.balanceOf(address(bot)), 1127);
        assertEq(b.balanceOf(address(bot)), 796);
    }
    function testMaximumInputIsPerLegNotGlobalRounding() public {
        vm.expectRevert("runtime input rounding"); bot.execute(maximumDustFlow(1, 7, 2, 120));
        vm.expectRevert("runtime input rounding"); bot.execute(maximumDustFlow(2, 2, 7, 120));
        // Legacy 1-unit tolerance still cannot accept 2-unit leftovers.
        vm.expectRevert("runtime input rounding"); bot.execute(dustFlow(0x82, 2, 0, 120));
    }
    function testMaximumInputCannotBeFreeOrSpendInventory() public {
        vm.expectRevert("runtime input debit"); bot.execute(maximumDustFlow(3, 100, 0, 120));
        bytes memory data = abi.encodePacked(uint256(100), uint8(0x42), uint8(3),
            leg(a, b, 1, swapProgram(a, b, 200, 1)),
            leg(b, a, 101, swapProgram(b, a, 120, 0)));
        vm.expectRevert("runtime input rounding"); bot.execute(abi.encodePacked(uint8(12), uint24(data.length), data));
        assertEq(a.balanceOf(address(bot)), 1100); assertEq(b.balanceOf(address(bot)), 777);
    }
    function testMaximumInputRefundDoesNotReplaceFinalOutput() public {
        vm.expectRevert("runtime minimum output"); bot.execute(maximumDustFlow(1, 99, 0, 100));
        assertEq(a.balanceOf(address(bot)), 1100); assertEq(b.balanceOf(address(bot)), 777);
    }
    function testMaximumInputRepeatedTokenDoesNotCountRefundAsReceipt() public {
        RuntimeTestToken c = new RuntimeTestToken(); c.mint(address(bot), 999);
        bytes memory data = abi.encodePacked(uint256(100), uint8(0x44), uint8(3),
            leg(a, b, 1, dustProgram(a, b, 200, 7)),
            leg(b, c, 1, dustProgram(b, c, 300, 19)),
            leg(c, b, 1, swapProgram(c, b, 400, 0)),
            leg(b, a, 101, swapProgram(b, a, 120, 0)));
        bot.execute(abi.encodePacked(uint8(12), uint24(data.length), data));
        assertEq(pool.received(), 400, "19 retained units are not the next working receipt");
        assertEq(a.balanceOf(address(bot)), 1127); assertEq(b.balanceOf(address(bot)), 796);
        assertEq(c.balanceOf(address(bot)), 999);
    }
    function testMaximumInputRefundCannotBeSpentByAnotherLeg() public {
        RuntimeTestToken c = new RuntimeTestToken();
        bytes memory last = abi.encodePacked(uint8(1), callOp(address(pool),
            abi.encodeCall(RuntimeTestSwap.swapWithOtherTokenChange, (c, a, 0, 120, b)),
            abi.encodePacked(uint24(68), uint8(0)), 0, 0));
        bytes memory data = abi.encodePacked(uint256(100), uint8(0x43), uint8(2),
            leg(a, b, 1, swapProgram(a, b, 200, 0)),
            leg(b, c, 1, dustProgram(b, c, 300, 19)), leg(c, a, 101, last));
        vm.expectRevert("runtime route inventory");
        bot.execute(abi.encodePacked(uint8(12), uint24(data.length), data));
        assertEq(a.balanceOf(address(bot)), 1100); assertEq(b.balanceOf(address(bot)), 777);
    }
    function testMaximumInputRejectsUnknownFlagsAndMasks() public {
        vm.expectRevert("runtime input policy mask"); bot.execute(maximumDustFlow(0, 0, 0, 120));
        vm.expectRevert("runtime input policy mask"); bot.execute(maximumDustFlow(4, 0, 0, 120));
        vm.expectRevert("runtime input policy bounds");
        bot.execute(abi.encodePacked(uint8(12), uint24(33), uint256(100), uint8(0x42)));
        vm.expectRevert("runtime flow flags");
        bot.execute(abi.encodePacked(uint8(12), uint24(33), uint256(100), uint8(0x0a)));
    }
    function testFuzzMaximumInputRefundsAreIsolated(uint64 first, uint64 second) public {
        uint256 firstDust = bound(first, 0, 99);
        uint256 secondDust = bound(second, 0, 199);
        bot.execute(maximumDustFlow(3, firstDust, secondDust, 120));
        assertEq(pool.received(), 200);
        assertEq(a.balanceOf(address(bot)), 1120 + firstDust);
        assertEq(b.balanceOf(address(bot)), 777 + secondDust);
    }
    function testRoundingOnRetainsOneUnitNeverChangesNextInput() public {
        bot.execute(dustFlow(0x82, 1, 1, 120));
        assertEq(pool.received(), 200); assertEq(a.balanceOf(address(bot)), 1121);
        assertEq(b.balanceOf(address(bot)), 778);
    }
    function testRoundingOnRejectsTwoUnitsAndStillRequiresFinalProfit() public {
        vm.expectRevert("runtime input rounding"); bot.execute(dustFlow(0x82, 2, 0, 120));
        vm.expectRevert("runtime input rounding"); bot.execute(dustFlow(0x82, 0, 2, 120));
        vm.expectRevert("runtime minimum output"); bot.execute(dustFlow(0x82, 0, 1, 100));
        assertEq(a.balanceOf(address(bot)), 1100); assertEq(b.balanceOf(address(bot)), 777);
    }
    function testRoundingOnCannotSpendOneUnitOfInventory() public {
        bytes memory data = abi.encodePacked(uint256(100), uint8(0x82),
            leg(a, b, 1, swapProgram(a, b, 200, 0)), leg(b, a, 101, swapProgram(b, a, 120, 1)));
        vm.expectRevert("runtime input rounding");
        bot.execute(abi.encodePacked(uint8(12), uint24(data.length), data));
    }
    function testRoundingOneCannotMakeOneUnitInputFree() public {
        bytes memory data = abi.encodePacked(uint256(1), uint8(0x82),
            leg(a, b, 1, dustProgram(a, b, 200, 1)), leg(b, a, 2, swapProgram(b, a, 3, 0)));
        vm.expectRevert("runtime input debit");
        bot.execute(abi.encodePacked(uint8(12), uint24(data.length), data));
    }
    function testRoundingOffRepeatedTokenCannotHideDust() public {
        RuntimeTestToken c = new RuntimeTestToken();
        bytes memory data = abi.encodePacked(uint256(100), uint8(4),
            leg(a, b, 1, swapProgram(a, b, 200, 0)),
            leg(b, a, 1, dustProgram(b, a, 150, 1)),
            leg(a, c, 1, swapProgram(a, c, 300, 0)),
            leg(c, a, 101, swapProgram(c, a, 120, 0)));
        vm.expectRevert("runtime input rounding");
        bot.execute(abi.encodePacked(uint8(12), uint24(data.length), data));
    }
    function repeatedDustFlow(uint8 flag, uint256 dust) internal returns(bytes memory) {
        RuntimeTestToken c = new RuntimeTestToken();
        bytes memory data = abi.encodePacked(uint256(100), flag,
            leg(a, b, 1, swapProgram(a, b, 200, 0)),
            leg(b, c, 1, dustProgram(b, c, 300, dust)),
            leg(c, b, 1, swapProgram(c, b, 400, 0)),
            leg(b, a, 101, swapProgram(b, a, 120, 0)));
        return abi.encodePacked(uint8(12), uint24(data.length), data);
    }
    function testRepeatedDustTokenUsesOnlyThisFlowsAccumulatedReceipt() public {
        bytes memory exact = repeatedDustFlow(4, 1);
        vm.expectRevert("runtime input rounding"); bot.execute(exact);
        bytes memory two = repeatedDustFlow(0x84, 2);
        vm.expectRevert("runtime input rounding"); bot.execute(two);
        bot.execute(repeatedDustFlow(0x84, 1));
        // Both 400 newly received units and the earlier 1-unit residue belong
        // to this flow; the pre-existing 777 units cannot enter the next input.
        assertEq(pool.received(), 401); assertEq(b.balanceOf(address(bot)), 777);
    }
    function testRoundingCannotHideNativeInventoryChange() public {
        RuntimeTestNative sender = new RuntimeTestNative(); vm.deal(address(sender), 1 ether);
        vm.deal(address(bot), 777);
        bytes memory first = swapProgram(a, b, 200, 0);
        first = bytes.concat(first, callOp(address(sender), abi.encodeCall(RuntimeTestNative.pay, (1)), "", 0, 0));
        bytes memory data = abi.encodePacked(uint256(100), uint8(0x82),
            leg(a, b, 1, first), leg(b, a, 101, swapProgram(b, a, 120, 0)));
        vm.expectRevert("runtime native inventory");
        bot.execute(abi.encodePacked(uint8(12), uint24(data.length), data));
        assertEq(address(bot).balance, 777);
    }
    function testUnknownRoundingFlagsFailClosed() public {
        for (uint256 flag; flag <= 255; ++flag) {
            if (flag == 2 || flag == 0x82) continue;
            vm.expectRevert(); bot.execute(dustFlow(uint8(flag), 0, 0, 120));
        }
    }
    function valueCall(address target, bytes memory payload, uint8 valueReg) internal pure returns(bytes memory) {
        return abi.encodePacked(uint8(1), target, uint8(0), valueReg, uint24(0), uint24(0), uint8(0), uint24(payload.length), payload);
    }
    function testNativeReceiptWrapsOnlyThisLegNotExistingInventory() public {
        RuntimeTestNative sender = new RuntimeTestNative();
        RuntimeTestWrapped wrapped = new RuntimeTestWrapped();
        vm.deal(address(sender), 1 ether); vm.deal(address(bot), 777);
        bytes memory p = abi.encodePacked(hex"01050d", // native baseline r13
            callOp(address(sender), abi.encodeCall(RuntimeTestNative.pay, (123)), "", 0, 0),
            hex"050e02010e0e0d", // r14 = current native - baseline
            valueCall(address(wrapped), abi.encodeCall(RuntimeTestWrapped.deposit, ()), 14));
        bot.execute(script(p, 1));
        assertEq(address(bot).balance, 777); assertEq(wrapped.balanceOf(address(bot)), 123);
    }
    function testNativeReceiptCannotHideNativeInventoryLoss() public {
        RuntimeTestNative sink = new RuntimeTestNative(); vm.deal(address(bot), 777);
        bytes memory p = abi.encodePacked(hex"01050d",
            valueCall(address(sink), abi.encodeCall(RuntimeTestNative.accept, ()), 0),
            hex"050e02010e0e0d");
        vm.expectRevert(stdError.arithmeticError); bot.execute(script(p, 1));
        assertEq(address(bot).balance, 777);
    }
    function testNativeBalanceInstructionBounds() public {
        vm.expectRevert("runtime native balance bounds"); bot.execute(script(hex"0105", 1));
        vm.expectRevert(stdError.indexOOBError); bot.execute(script(hex"010510", 1));
    }
    function debtProgram(RuntimeTestDebtCallback cb, int256 debt, uint256 cap, uint24 offset) internal view returns(bytes memory) {
        bytes memory payment = abi.encodePacked(uint8(1), uint8(7), uint8(1), offset,
            hex"0201020001", // r2 = cap - actual debt, checked before transfer
            callOp(address(a), abi.encodeCall(RuntimeTestToken.transfer, (address(cb), 0)),
                abi.encodePacked(uint24(36), uint8(1)), 0, 0));
        return abi.encodePacked(uint8(1), callOp(address(cb),
            abi.encodeCall(RuntimeTestDebtCallback.run, (debt, script(payment, cap))), "", 100, 100));
    }
    function testCallbackPartialAndFullPaymentUseActualDebt() public {
        RuntimeTestDebtCallback cb = new RuntimeTestDebtCallback(a);
        bot.execute(script(debtProgram(cb, 30, 100, 4), 100));
        assertEq(cb.paid(), 30); assertEq(a.balanceOf(address(bot)), 1070);
        bot.execute(script(debtProgram(cb, 100, 100, 4), 100));
        assertEq(cb.paid(), 100); assertEq(a.balanceOf(address(bot)), 970);
        bot.execute(script(debtProgram(cb, 0, 100, 4), 100));
        assertEq(cb.paid(), 0); assertEq(a.balanceOf(address(bot)), 970);
    }
    function testCallbackDebtCannotExceedCapOrConsumeInventory() public {
        RuntimeTestDebtCallback cb = new RuntimeTestDebtCallback(a);
        vm.expectRevert("runtime external call"); bot.execute(script(debtProgram(cb, 101, 100, 4), 100));
        vm.expectRevert("runtime external call"); bot.execute(script(debtProgram(cb, -1, 100, 4), 100));
        assertEq(a.balanceOf(address(bot)), 1100); assertEq(cb.paid(), 0);
    }
    function testCallbackCalldataBoundsFailClosed() public {
        RuntimeTestDebtCallback cb = new RuntimeTestDebtCallback(a);
        vm.expectRevert("runtime external call"); bot.execute(script(debtProgram(cb, 1, 100, 4096), 100));
        vm.expectRevert("runtime calldata instruction bounds"); bot.execute(script(hex"01070100", 100));
    }
    function testFuzzCallbackPaysDebtNotCap(uint128 cap, uint128 owed) public {
        uint256 available = bound(cap, 1, 1100);
        uint256 debt = bound(owed, 0, available);
        RuntimeTestDebtCallback cb = new RuntimeTestDebtCallback(a);
        bot.execute(script(debtProgram(cb, int256(debt), available, 4), available));
        assertEq(cb.paid(), debt); assertEq(a.balanceOf(address(bot)), 1100 - debt);
    }
    function runOp(bytes memory child, uint8 inputReg, uint8 outputReg, uint8 mode) internal pure returns(bytes memory) {
        return abi.encodePacked(uint8(8), inputReg, outputReg, mode, uint24(child.length), child);
    }
    function testSubprogramRegistersAreLocalAndOnlySelectedResultReturns() public {
        bytes memory child = abi.encodePacked(hex"010001", uint256(333), hex"0200000001");
        bytes memory p = abi.encodePacked(hex"010001", uint256(7), runOp(child, 0, 2, 0),
            hex"0003", uint256(433), hex"030203", hex"0003", uint256(7), hex"030103",
            hex"0003", uint256(100), hex"030003");
        bot.execute(script(p, 100));
    }
    function testReadonlySubprogramAllowsStaticReads() public {
        bytes memory data = abi.encodeWithSignature("balanceOf(address)", address(bot));
        bytes memory child = abi.encodePacked(hex"0101", address(a), uint8(1), uint8(255),
            uint24(0), uint24(0), uint8(0), uint24(data.length), data, hex"0600000000");
        bytes memory p = abi.encodePacked(uint8(1), runOp(child, 0, 2, 1),
            hex"0003", uint256(1100), hex"030203");
        bot.execute(script(p, 100));
    }
    function testReadonlySubprogramRejectsCallsAndAllowanceTransitively() public {
        bytes memory child = swapProgram(a, b, 20, 0);
        bytes memory nested = abi.encodePacked(uint8(1), runOp(child, 0, 0, 0));
        vm.expectRevert("runtime readonly call");
        bot.execute(script(abi.encodePacked(uint8(1), runOp(nested, 0, 0, 1)), 10));
        child = abi.encodePacked(hex"0104", address(a), address(pool), uint8(0), uint256(100));
        vm.expectRevert("runtime readonly allowance");
        bot.execute(script(abi.encodePacked(uint8(1), runOp(child, 0, 0, 1)), 10));
        assertEq(a.balanceOf(address(bot)), 1100);
    }
    function testSubprogramDepthAndInputBounds() public {
        bytes memory nested = abi.encodePacked(hex"010001", uint256(1));
        for (uint256 i; i < 8; ++i) nested = abi.encodePacked(uint8(1), runOp(nested, 0, 0, 0));
        bot.execute(script(nested, 1));
        vm.expectRevert("runtime nesting limit");
        bot.execute(script(abi.encodePacked(uint8(1), runOp(nested, 0, 0, 0)), 1));
        vm.expectRevert("runtime subprogram header"); bot.execute(script(hex"0108", 1));
        vm.expectRevert("runtime subprogram mode"); bot.execute(script(hex"0108000002000002", 1));
        vm.expectRevert("runtime slice bounds"); bot.execute(script(hex"0108000000000002", 1));
        vm.expectRevert(stdError.indexOOBError);
        bot.execute(script(abi.encodePacked(uint8(1), runOp(hex"01030000", 16, 0, 0)), 1));
    }
    function testChildRevertRollsBackAllEarlierCalls() public {
        bytes memory p = bytes.concat(swapProgram(a, b, 20, 0), runOp(hex"0108", 0, 1, 0));
        vm.expectRevert("runtime subprogram header"); bot.execute(script(p, 10));
        assertEq(a.balanceOf(address(bot)), 1100); assertEq(b.balanceOf(address(bot)), 777);
        assertEq(pool.received(), 0);
    }
    function testSubprogramCallbackScopeAndRegistersRemainIsolated() public {
        RuntimeTestCallback first = new RuntimeTestCallback();
        RuntimeTestCallback second = new RuntimeTestCallback();
        bytes memory child = callbackProgram(first, script(swapProgram(a, b, 23, 0), 10));
        bytes memory p = abi.encodePacked(hex"010001", uint256(7), runOp(child, 0, 2, 0),
            hex"0003", uint256(100), hex"030203", hex"0003", uint256(7), hex"030103");
        bytes memory tail = callbackProgram(second, script(swapProgram(a, b, 24, 0), 20));
        for (uint256 i = 1; i < tail.length; ++i) p = bytes.concat(p, tail[i]);
        bot.execute(script(p, 100));
        assertEq(a.balanceOf(address(bot)), 1070); assertEq(b.balanceOf(address(bot)), 824);
        assertEq(pool.received(), 20);
        for (uint256 i; i < 3; ++i) {
            first.configure(i == 0, i == 1, i == 2);
            if (i == 0) vm.expectRevert("runtime callback missing");
            else vm.expectRevert("runtime external call");
            bot.execute(script(abi.encodePacked(uint8(1), runOp(child, 0, 2, 0)), 100));
        }
        assertEq(a.balanceOf(address(bot)), 1070); assertEq(b.balanceOf(address(bot)), 824);
    }
    function testReadonlyChildStaticcallCannotWriteThroughExternalContract() public {
        bytes memory payload = abi.encodeCall(RuntimeTestSwap.swap, (a, b, 10, 20, 0));
        bytes memory child = abi.encodePacked(hex"0101", address(pool), uint8(1), uint8(255),
            uint24(0), uint24(0), uint8(0), uint24(payload.length), payload);
        vm.expectRevert("runtime external call");
        bot.execute(script(abi.encodePacked(uint8(1), runOp(child, 0, 2, 1)), 100));
        assertEq(a.balanceOf(address(bot)), 1100); assertEq(b.balanceOf(address(bot)), 777);
        assertEq(pool.received(), 0);
    }
    function testSubprogramCallbackRejectsDifferentCallerAddress() public {
        RuntimeTestForwardedCallback forwarded = new RuntimeTestForwardedCallback();
        bytes memory child = abi.encodePacked(uint8(1), callOp(address(forwarded),
            abi.encodeWithSignature("run(bytes)", script(swapProgram(a, b, 23, 0), 10)), "", 68, 68));
        vm.expectRevert("runtime external call");
        bot.execute(script(abi.encodePacked(uint8(1), runOp(child, 0, 2, 0)), 100));
        assertEq(a.balanceOf(address(bot)), 1100); assertEq(b.balanceOf(address(bot)), 777);
        assertEq(pool.received(), 0);
    }
    function testNormalSelfCallRestoresLegacyCallbackState() public {
        RuntimeTestCallback cb = new RuntimeTestCallback();
        bytes memory clear = abi.encodeWithSelector(BotVM.execSubscript.selector, hex"05");
        bytes memory p = abi.encodePacked(uint8(1), callOp(address(bot), clear, "", 0, 0));
        bytes memory payload = abi.encodeCall(RuntimeTestCallback.run, (script(swapProgram(a, b, 20, 0), 10)));
        bot.execute(abi.encodePacked(hex"02000044", script(p, 1), uint8(0), address(cb), uint24(payload.length), payload));
        assertEq(pool.received(), 10);
    }

    function revertQuote(RuntimeTestRevertingProbe probe, uint8 mode, uint24 expected) internal pure returns(bytes memory) {
        bytes memory payload = abi.encodeCall(RuntimeTestRevertingProbe.probe, (0, mode));
        return abi.encodePacked(hex"0101", address(probe), uint8(2), uint8(255), uint24(0), uint24(0), uint8(1),
            expected, uint24(4), uint8(0), uint24(payload.length), payload,
            hex"0601000000", hex"0002", uint256(224), hex"0204010102",
            hex"0002", uint256(uint32(RuntimeTestRevertingProbe.ProbeResult.selector)), hex"030102", hex"0600000004");
    }
    function testRevertQuoteReadonlyRollbackAndInputPatching() public {
        RuntimeTestRevertingProbe probe = new RuntimeTestRevertingProbe(a);
        for (uint256 amount = 1; amount <= 1000; amount *= 10) {
            bytes memory child = revertQuote(probe, 0, 36);
            bytes memory nested = abi.encodePacked(uint8(1), runOp(child, 0, 0, 0));
            bytes memory p = abi.encodePacked(uint8(1), runOp(nested, 0, 2, 1),
                hex"0003", amount * 2, hex"030203");
            bot.execute(script(p, amount));
            assertEq(probe.calls(), 0); assertEq(a.balanceOf(address(bot)), 1100);
        }
    }
    function testRevertQuoteRejectsSuccessWrongSizeAndEmptyRevert() public {
        RuntimeTestRevertingProbe probe = new RuntimeTestRevertingProbe(a);
        for (uint8 mode = 1; mode <= 3; ++mode) {
            vm.expectRevert("runtime expected revert");
            bot.execute(script(revertQuote(probe, mode, 36), 10));
            assertEq(probe.calls(), 0); assertEq(a.balanceOf(address(bot)), 1100);
        }
        for (uint24 size = 35; size <= 37; size += 2) {
            vm.expectRevert("runtime expected revert"); bot.execute(script(revertQuote(probe, 0, size), 10));
        }
    }
    function testRevertQuoteCannotSpendValueInstallCallbackOrExceedBound() public {
        RuntimeTestRevertingProbe probe = new RuntimeTestRevertingProbe(a);
        bytes memory base = revertQuote(probe, 0, 36);
        // Offsets are in the independently encoded instruction, including version/op.
        bytes memory p = bytes.concat(base); p[23] = bytes1(uint8(0));
        vm.expectRevert("runtime static config"); bot.execute(script(p, 10));
        p = bytes.concat(base); p[26] = bytes1(uint8(1));
        vm.expectRevert("runtime static config"); bot.execute(script(p, 10));
        p = bytes.concat(base); p[29] = bytes1(uint8(1));
        vm.expectRevert("runtime reverted call config"); bot.execute(script(p, 10));
        vm.expectRevert("runtime reverted call config"); bot.execute(script(revertQuote(probe, 0, 65537), 10));
        assertEq(probe.calls(), 0); assertEq(a.balanceOf(address(bot)), 1100);
    }
    function testRevertQuoteBlocksReentryInsideConsumedCallback() public {
        RuntimeTestRevertingProbe probe = new RuntimeTestRevertingProbe(a);
        RuntimeTestCallback cb = new RuntimeTestCallback();
        bytes memory quote = revertQuote(probe, 4, 36);
        bytes memory p = abi.encodePacked(uint8(1), runOp(quote, 0, 2, 1), hex"0003", uint256(20), hex"030203");
        bot.execute(script(callbackProgram(cb, script(p, 10)), 10));
        bot.execute(script(callbackProgram(cb, script(swapProgram(a, b, 25, 0), 10)), 10));
        assertEq(probe.calls(), 0); assertEq(a.balanceOf(address(bot)), 1090); assertEq(b.balanceOf(address(bot)), 802);
    }

    function testRevertQuoteRestoresPendingLegacyCallbackWithoutReinstallation() public {
        RuntimeTestRevertingProbe probe = new RuntimeTestRevertingProbe(a);
        RuntimeTestCallback cb = new RuntimeTestCallback();
        bytes memory p = revertQuote(probe, 4, 36);
        bytes memory payload = abi.encodeCall(RuntimeTestCallback.run, (script(swapProgram(a, b, 20, 0), 10)));
        // Field2 is installed before the quote, and no opcode reinstalls it or
        // clears the quote's CALLBACK_TARGET guard before this legal callback.
        bot.execute(abi.encodePacked(hex"02000044", script(p, 10), uint8(0), address(cb), uint24(payload.length), payload));
        assertEq(pool.received(), 10); assertEq(probe.calls(), 0);
        assertEq(a.balanceOf(address(bot)), 1090); assertEq(b.balanceOf(address(bot)), 797);
    }
}

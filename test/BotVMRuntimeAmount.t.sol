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
        vm.expectRevert("runtime route inventory"); bot.execute(flow(200, 1, 1));
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
        vm.expectCall(address(a), abi.encodeWithSignature("balanceOf(address)", address(bot)), 2);
        vm.expectCall(address(b), abi.encodeWithSignature("balanceOf(address)", address(bot)), 3);
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
}

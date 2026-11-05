// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {BotVM} from "../src/BotVM.sol";

contract CompactReturnTarget {
    function echo(int256 n) external pure returns (int256) { return n; }
    function reject() external pure { revert("compact mock failure"); }
}
contract CompactStateBot is BotVM {
    function transientState() external view returns (uint256 s) { assembly { s := tload(0x1337) } }
}
contract SequenceCallback {
    uint256 public flags;
    function configure(uint256 n) external { flags = n; }
    function run(bytes memory s) external {
        if (flags == 1) return;
        if (flags == 2) s[0] = bytes1(uint8(s[0]) ^ 1);
        (bool ok,) = msg.sender.call(abi.encodeWithSignature("callback(bytes)", s));
        require(ok, "callback rejected");
        if (flags == 3) {
            (ok,) = msg.sender.call(abi.encodeWithSignature("callback(bytes)", s));
            require(ok, "second callback rejected");
        }
    }
}
contract BotVMCompactTest is Test {
    CompactStateBot bot = new CompactStateBot();
    CompactReturnTarget target = new CompactReturnTarget();
    function script(bytes memory program) private pure returns (bytes memory) {
        return abi.encodePacked(uint8(14), uint256(0), uint24(program.length), program);
    }
    function direct(address to, bytes memory data) private pure returns (bytes memory) {
        return abi.encodePacked(uint8(10), to, uint24(data.length), data);
    }
    function floor(uint8 mode, uint24 offset, uint256 n) private pure returns (bytes memory) {
        return abi.encodePacked(uint8(11), mode, offset, n);
    }
    function p(int256 value, uint8 mode, uint256 minimum) private view returns (bytes memory) {
        return abi.encodePacked(uint8(1), direct(address(target), abi.encodeCall(target.echo, (value))), floor(mode, 0, minimum));
    }
    function testDirectCallResultAndSignedFloor() public {
        bot.execute(script(p(-20, 1, 20)));
        bot.execute(script(p(20, 0, 20)));
        bot.execute(script(p(type(int256).min, 1, uint256(1) << 255)));
        vm.expectRevert(stdError.arithmeticError); bot.execute(script(p(-20, 1, 21)));
        vm.expectRevert(stdError.arithmeticError); bot.execute(script(p(20, 1, 20)));
        vm.expectRevert(stdError.arithmeticError); bot.execute(script(p(0, 1, 0)));
    }
    function testFuzzSignedFloorMatchesExistingArithmetic(uint128 n, uint128 threshold) public {
        vm.assume(n > 0);
        if (threshold == 0) return;
        uint256 negated;
        unchecked { negated = 0 - uint256(threshold); }
        bytes memory compact = p(-int256(uint256(n)), 1, threshold);
        bytes memory legacy = abi.encodePacked(uint8(1),
            uint8(1), address(target), hex"00ff00000000000000", uint24(36), abi.encodeCall(target.echo, (-int256(uint256(n)))),
            hex"06010000000002", uint256(1) << 255, hex"02010301020002", negated, hex"0201030201");
        (bool a, bytes memory x) = address(bot).call(abi.encodeCall(BotVM.execute, (script(compact))));
        (bool b, bytes memory y) = address(bot).call(abi.encodeCall(BotVM.execute, (script(legacy))));
        assertEq(a, b); assertEq(x, y); assertEq(a, n >= threshold);
    }
    function testDirectCallRejectsNoCodeTruncationAndReadOnly() public {
        vm.expectRevert("runtime call target"); bot.execute(script(abi.encodePacked(uint8(1), direct(address(0xdead), ""))));
        vm.expectRevert("runtime call header"); bot.execute(script(hex"010a"));
        vm.expectRevert("runtime slice bounds"); bot.execute(script(abi.encodePacked(hex"010a", address(target), uint24(10))));
        bytes memory child = abi.encodePacked(uint8(1), direct(address(target), abi.encodeCall(target.echo, (1))));
        bytes memory readonlyProgram = abi.encodePacked(hex"0108000001", uint24(child.length), child);
        vm.expectRevert("runtime readonly call"); bot.execute(script(readonlyProgram));
    }
    function testReturnFloorValidatesResultLengthAndMode() public {
        vm.expectRevert("runtime word bounds"); bot.execute(script(abi.encodePacked(uint8(1), floor(0, 0, 1))));
        vm.expectRevert("runtime return floor bounds"); bot.execute(script(hex"010b"));
        vm.expectRevert("runtime return floor mode"); bot.execute(script(p(20, 2, 1)));
    }
    function testDirectSelfCallRestoresLegacyFrame() public {
        bot.execute(script(abi.encodePacked(uint8(1), direct(address(bot),
            abi.encodeCall(BotVM.execSubscript, (hex"02123456"))))));
        assertEq(bot.transientState(), 0);
    }
    function testDirectFailurePreservesAuthenticatedHop() public {
        bytes32 key = keccak256("compact test key");
        bytes32 flow = keccak256("compact test flow");
        vm.store(address(bot), keccak256("BotVM.runtime.hop.diagnostic.key.v1"), key);
        bytes memory reason = abi.encodeWithSignature("Error(string)", "compact mock failure");
        bytes32 proof = keccak256(abi.encode(key, uint256(2), address(target), flow, keccak256(reason)));
        vm.expectRevert(abi.encodeWithSignature("RuntimeHopFailed(uint256,address,bytes32,bytes,bytes32)", uint256(2), address(target), flow, reason, proof));
        bot.execute(script(abi.encodePacked(hex"010902", flow, direct(address(target), abi.encodeCall(target.reject, ())))));
    }
    function testFuzzSequenceMatchesRegisterProgram(uint128 n, uint128 threshold) public {
        vm.assume(n > 0);
        bytes memory ordinary = p(-int256(uint256(n)), 1, threshold);
        (bool a, bytes memory x) = address(bot).call(abi.encodeCall(BotVM.execute, (script(ordinary))));
        ordinary[0] = 0x02;
        (bool b, bytes memory y) = address(bot).call(abi.encodeCall(BotVM.execute, (script(ordinary))));
        assertEq(a, b); assertEq(x, y); assertEq(a, n >= threshold);
        (bool c, bytes memory z) = address(bot).call(abi.encodeCall(BotVM.execute, (bytes.concat(hex"0f", ordinary))));
        assertEq(a, c); assertEq(x, z);
    }
    function sequenceCallback(SequenceCallback cb, bytes memory inner) private pure returns (bytes memory) {
        bytes memory data = abi.encodeCall(SequenceCallback.run, (inner));
        return abi.encodePacked(hex"0f020c", address(cb), uint24(68), uint24(68), uint24(data.length), data);
    }
    function testSequenceCallbackAuthenticatesAndConsumesOnce() public {
        SequenceCallback cb = new SequenceCallback();
        bytes memory inner = p(-20, 1, 20); inner[0] = 0x02;
        bytes memory outer = sequenceCallback(cb, script(inner));
        bot.execute(outer);
        cb.configure(1); vm.expectRevert("runtime callback missing"); bot.execute(outer);
        cb.configure(2); vm.expectRevert("runtime external call"); bot.execute(outer);
        cb.configure(3); vm.expectRevert("runtime external call"); bot.execute(outer);
        assertEq(bot.transientState(), 0);
    }
    function testSequenceNestedCallbackAndSelfFrameRestore() public {
        SequenceCallback a = new SequenceCallback(); SequenceCallback b = new SequenceCallback();
        bytes memory inner = p(-20, 1, 20); inner[0] = 0x02;
        bot.execute(sequenceCallback(a, sequenceCallback(b, script(inner))));
        bot.execute(script(abi.encodePacked(uint8(2), direct(address(bot),
            abi.encodeCall(BotVM.execSubscript, (hex"02123456"))))));
        assertEq(bot.transientState(), 0);
    }
    function testSequenceMalformedInstructionsAndEmptyReturnReject() public {
        vm.expectRevert("runtime opcode"); bot.execute(script(hex"0200"));
        vm.expectRevert("runtime call header"); bot.execute(script(hex"020c"));
        vm.expectRevert("runtime word bounds"); bot.execute(script(abi.encodePacked(uint8(2), floor(0, 0, 1))));
        bytes memory data = abi.encodeCall(target.echo, (1));
        vm.expectRevert("runtime callback offset"); bot.execute(script(abi.encodePacked(hex"020c", address(target), uint24(0), uint24(0), uint24(data.length), data)));
        bytes memory earlier = abi.encodePacked(uint8(0), address(target), uint24(data.length), data);
        vm.expectRevert("runtime word bounds"); bot.execute(bytes.concat(earlier, script(abi.encodePacked(uint8(2), floor(0, 0, 1)))));
        vm.expectRevert("runtime sequence version"); bot.execute(hex"0f0100");
        vm.expectRevert("runtime opcode"); bot.execute(hex"0f0200");
        bytes memory trailing = p(-20, 1, 20); trailing[0] = 0x02;
        vm.expectRevert("runtime opcode"); bot.execute(bytes.concat(hex"0f", trailing, hex"ff"));
    }
}

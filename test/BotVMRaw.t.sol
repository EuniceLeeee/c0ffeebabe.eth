// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";

contract BotVMRawTest is Test {
    BotVM private bot = new BotVM();
    function testRawEntryHasOwnerGateAndIdenticalReturn() public {
        bytes memory script = hex"03000001ab";
        (bool abiOk, bytes memory expected) = address(bot).call(abi.encodeCall(BotVM.execute, (script)));
        (bool rawOk, bytes memory actual) = address(bot).call(abi.encodePacked(BotVM.executeRaw.selector, script));
        assertTrue(abiOk && rawOk); assertEq(actual, expected); assertEq(actual, hex"ab");
        vm.prank(address(0xdead));
        (rawOk,) = address(bot).call(abi.encodePacked(BotVM.executeRaw.selector, script)); assertFalse(rawOk);
    }
    function testRawEntryPreservesFailure() public {
        bytes memory script = hex"ff";
        (bool a, bytes memory x) = address(bot).call(abi.encodeCall(BotVM.execute, (script)));
        (bool b, bytes memory y) = address(bot).call(abi.encodePacked(BotVM.executeRaw.selector, script));
        assertFalse(a); assertFalse(b); assertEq(x, y);
    }
}

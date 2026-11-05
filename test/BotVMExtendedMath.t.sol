// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";

// Keep the shared executor's arithmetic dialect aligned with the production
// RuntimeAmountProgram encoder, including recipient-sensitive PSV quotes.
contract BotVMExtendedMathTest is Test {
    BotVM private bot = new BotVM();

    function check(uint8 kind, uint256 a, uint256 b, uint256 expected) private {
        bytes memory program = abi.encodePacked(
            uint8(1), uint8(0), uint8(1), a, uint8(0), uint8(2), b,
            uint8(2), kind, uint8(0), uint8(1), uint8(2),
            uint8(0), uint8(3), expected, uint8(3), uint8(0), uint8(3)
        );
        bytes memory script = abi.encodePacked(uint8(14), uint256(0), uint24(program.length), program);
        bot.execute(script);
        (bool ok, bytes memory reason) = address(bot).call(abi.encodePacked(BotVM.executeRaw.selector, script));
        if (!ok) assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
    }

    function testFuzzEquality(uint256 a, uint256 b) public {
        check(7, a, a, 1);
        check(7, a, b, a == b ? 1 : 0);
    }

    function testFuzzMinimum(uint256 a, uint256 b) public {
        check(8, a, b, a < b ? a : b);
        check(8, b, a, a < b ? a : b);
    }

    function testMathBoundaryValues() public {
        check(7, 0, type(uint256).max, 0);
        check(7, type(uint256).max, type(uint256).max, 1);
        check(8, 0, type(uint256).max, 0);
        check(8, type(uint256).max, type(uint256).max, type(uint256).max);
    }

    function testUnknownMathStillReverts() public {
        bytes memory program = hex"010209000000";
        vm.expectRevert("runtime math opcode");
        bot.execute(abi.encodePacked(uint8(14), uint256(0), uint24(program.length), program));
    }
}

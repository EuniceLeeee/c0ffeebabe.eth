// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {RuntimeAmountVM} from "../src/RuntimeAmountVM.sol";

contract RuntimeCallbackHarness is RuntimeAmountVM {
    function check(bytes calldata payload, uint256 state, bytes32 wantedHash)
        external returns (bytes memory result, uint256 afterState)
    {
        uint256 start;
        assembly ("memory-safe") {
            start := payload.offset
            tstore(0x47dc154350c9d6e1abf71155179ebd00411f54aa0ddb6ff63cbfd2b8ffa351fe, wantedHash)
        }
        result = _checkRuntimeCallback(start, payload.length, state);
        assembly ("memory-safe") { afterState := tload(0x1337) }
    }
    function checkSlice(uint256 start, uint256 size, uint256 state) external returns (bytes memory) {
        return _checkRuntimeCallback(start, size, state);
    }
}

contract BotVMCallbackTest is Test {
    RuntimeCallbackHarness harness = new RuntimeCallbackHarness();
    function testCallbackRejectionStringsAreExact() public {
        vm.expectRevert("runtime callback sender");
        harness.check(hex"010203", uint160(address(0x1234)), bytes32(0));
        vm.expectRevert("runtime callback script");
        harness.check(hex"010203", uint160(address(this)), bytes32(0));
        vm.expectRevert("runtime callback bounds");
        harness.checkSlice(type(uint256).max, 1, uint160(address(this)));
        vm.expectRevert("runtime callback bounds");
        harness.checkSlice(4, type(uint256).max, uint160(address(this)));
    }
    function testFuzzCallbackCopyHashAndOneUseState(bytes memory payload, uint96 highState) public {
        vm.assume(payload.length <= 65536);
        uint256 state = (uint256(highState) << 160) | uint160(address(this));
        (bytes memory result, uint256 afterState) = harness.check(payload, state, keccak256(payload));
        assertEq(result, payload);
        assertEq(afterState, (uint256(highState) << 160) | 1);
    }
    function testLegacyCallbackRetainsZeroFillAndAllocationPanic() public {
        bytes memory result = harness.checkSlice(1000, 33, 0);
        assertEq(result, new bytes(33));
        vm.expectRevert(stdError.memOverflowError);
        harness.checkSlice(0, uint256(type(uint64).max) + 1, 0);
        vm.expectRevert(stdError.memOverflowError);
        harness.checkSlice(0, type(uint256).max, 0);
    }
}

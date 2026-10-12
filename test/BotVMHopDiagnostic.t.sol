// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BotVMRuntimeAmountTest, RuntimeTestToken} from "./BotVMRuntimeAmount.t.sol";
import {BotVM} from "../src/BotVM.sol";
import {RuntimeAmountVM} from "../src/RuntimeAmountVM.sol";

contract HopFailureMock {
    function fail(bytes memory data) external pure {
        assembly { revert(add(data, 32), mload(data)) }
    }
}

contract BotVMHopDiagnosticTest is BotVMRuntimeAmountTest {
    bytes32 constant KEY_SLOT = keccak256("BotVM.runtime.hop.diagnostic.key.v1");
    bytes32 constant KEY = keccak256("local test diagnostic key");

    function diagnostic(uint256 hop, address target, bytes memory payload, bytes memory reason) internal pure returns (bytes memory) {
        bytes32 flowHash = keccak256(payload);
        bytes32 proof = keccak256(abi.encode(KEY, hop, target, flowHash, keccak256(reason)));
        return abi.encodeWithSelector(RuntimeAmountVM.RuntimeHopFailed.selector, hop, target, flowHash, reason, proof);
    }
    function run(bytes memory payload) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(12), uint24(payload.length), payload);
    }
    function failureProgram(HopFailureMock target, bytes memory reason) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(1), callOp(address(target), abi.encodeCall(HopFailureMock.fail, (reason)), "", 0, 0));
    }
    function testFirstHopReportsOwnIndexAndOpaqueForeignError() public {
        HopFailureMock target = new HopFailureMock();
        bytes memory forged = abi.encodeWithSelector(RuntimeAmountVM.RuntimeHopFailed.selector,
            uint256(5), address(123), bytes32(0), bytes("fake"), bytes32(0));
        bytes memory payload = abi.encodePacked(uint256(100), uint8(2),
            leg(a, b, 1, failureProgram(target, forged)), leg(b, a, 101, swapProgram(b, a, 120, 0)));
        vm.store(address(bot), KEY_SLOT, KEY);
        vm.expectRevert(diagnostic(0, address(target), payload, forged));
        bot.execute(run(payload));
    }
    function testFourthHopTokenFailureReportsOnlyFourthHop() public {
        HopFailureMock target = new HopFailureMock();
        RuntimeTestToken c = new RuntimeTestToken();
        bytes memory reason = abi.encodeWithSignature("Error(string)", "token transfer failed");
        bytes memory payload = abi.encodePacked(uint256(100), uint8(4),
            leg(a, b, 1, swapProgram(a, b, 200, 0)),
            leg(b, c, 1, swapProgram(b, c, 300, 0)),
            leg(c, b, 1, swapProgram(c, b, 200, 0)),
            leg(b, a, 101, failureProgram(target, reason)));
        vm.store(address(bot), KEY_SLOT, KEY);
        vm.expectRevert(diagnostic(3, address(target), payload, reason));
        bot.execute(run(payload));
        assertEq(a.balanceOf(address(bot)), 1100);
        assertEq(b.balanceOf(address(bot)), 777);
    }
    function testMinimumReturnCarriesLastHopAndOriginalGuard() public {
        bytes memory payload = abi.encodePacked(uint256(100), uint8(2),
            leg(a, b, 1, swapProgram(a, b, 200, 0)), leg(b, a, 101, swapProgram(b, a, 80, 0)));
        vm.store(address(bot), KEY_SLOT, KEY);
        vm.expectRevert(diagnostic(1, address(pool), payload,
            abi.encodeWithSignature("Error(string)", "runtime minimum output")));
        bot.execute(run(payload));
    }
    function testOuterSubscriptPreservesInnerEnvelope() public {
        HopFailureMock target = new HopFailureMock();
        bytes memory payload = abi.encodePacked(uint256(100), uint8(2),
            leg(a, b, 1, failureProgram(target, hex"abcd")), leg(b, a, 101, swapProgram(b, a, 120, 0)));
        bytes memory child = abi.encodeCall(BotVM.execSubscript, (run(payload)));
        vm.store(address(bot), KEY_SLOT, KEY);
        vm.expectRevert(diagnostic(0, address(target), payload, hex"abcd"));
        bot.execute(abi.encodePacked(uint8(0), address(bot), uint24(child.length), child));
    }
    function testSuccessDoesNotReadDiagnosticStorage() public {
        vm.store(address(bot), KEY_SLOT, KEY);
        vm.record();
        bot.execute(flow(312345, 0, 1));
        (bytes32[] memory reads,) = vm.accesses(address(bot));
        for (uint256 i; i < reads.length; ++i) assertNotEq(reads[i], KEY_SLOT);
        assertEq(pool.received(), 312345);
        assertEq(a.balanceOf(address(bot)), 1120);
        assertEq(b.balanceOf(address(bot)), 777);
    }
}

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

contract HopCallbackBubbleMock {
    function run(bytes memory data) external {
        (bool ok, bytes memory reason) = msg.sender.call(abi.encodeWithSignature("callback(bytes)", data));
        if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
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

    function tagged(uint8 hop, bytes32 witness, bytes memory body) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(1), uint8(9), hop, witness, body);
    }

    function testCompactProgramReportsFailureWithoutBalanceQueries() public {
        HopFailureMock target = new HopFailureMock();
        bytes memory witness = hex"123456";
        bytes memory reason = hex"abcdef";
        bytes memory p = tagged(2, keccak256(witness),
            callOp(address(target), abi.encodeCall(HopFailureMock.fail, (reason)), "", 0, 0));
        vm.store(address(bot), KEY_SLOT, KEY);
        vm.expectRevert(diagnostic(2, address(target), witness, reason));
        bot.execute(script(p, 100));
    }

    function testCompactFailureStillCarriesMetadataWithoutSimOverlay() public {
        HopFailureMock target = new HopFailureMock();
        bytes32 witness = keccak256("compact route");
        bytes memory reason = hex"abcd";
        bytes32 proof = keccak256(abi.encode(bytes32(0), uint256(1), address(target), witness, keccak256(reason)));
        vm.expectRevert(abi.encodeWithSelector(RuntimeAmountVM.RuntimeHopFailed.selector,
            uint256(1), address(target), witness, reason, proof));
        bot.execute(script(tagged(1, witness,
            callOp(address(target), abi.encodeCall(HopFailureMock.fail, (reason)), "", 0, 0)), 100));
    }

    function testCompactSuccessDoesNotReadDiagnosticStorageOrTokenBalances() public {
        vm.store(address(bot), KEY_SLOT, KEY);
        vm.record();
        bot.execute(script(tagged(0, keccak256("route"), abi.encodePacked(uint8(3), uint8(0), uint8(0))), 100));
        (bytes32[] memory reads,) = vm.accesses(address(bot));
        for (uint256 i; i < reads.length; ++i) assertNotEq(reads[i], KEY_SLOT);
        (bytes32[] memory tokenReads,) = vm.accesses(address(a));
        assertEq(tokenReads.length, 0);
    }

    function testCompactDiagnosticContextIsFrameLocal() public {
        HopFailureMock target = new HopFailureMock();
        bytes memory child = tagged(0, keccak256("route"), abi.encodePacked(uint8(3), uint8(0), uint8(0)));
        bytes memory p = abi.encodePacked(uint8(1), uint8(8), uint8(0), uint8(0), uint8(0), uint24(child.length), child,
            callOp(address(target), abi.encodeCall(HopFailureMock.fail, (hex"abcd")), "", 0, 0));
        vm.store(address(bot), KEY_SLOT, KEY);
        vm.expectRevert(bytes("runtime external call"));
        bot.execute(script(p, 100));
    }

    function testCompactCallbackPreservesAuthenticatedInnerHop() public {
        HopFailureMock target = new HopFailureMock();
        HopCallbackBubbleMock opener = new HopCallbackBubbleMock();
        bytes memory witness = hex"123456";
        bytes memory reason = hex"abcdef";
        bytes memory inner = script(tagged(0, keccak256(witness),
            callOp(address(target), abi.encodeCall(HopFailureMock.fail, (reason)), "", 0, 0)), 100);
        bytes memory p = tagged(1, keccak256(witness),
            callOp(address(opener), abi.encodeCall(HopCallbackBubbleMock.run, (inner)), "", 68, 68));
        vm.store(address(bot), KEY_SLOT, KEY);
        vm.expectRevert(diagnostic(1, address(opener), witness, diagnostic(0, address(target), witness, reason)));
        bot.execute(script(p, 100));
    }

    function testCompactDiagnosticRejectsInvalidContext() public {
        vm.expectRevert(bytes("runtime diagnostic context"));
        bot.execute(script(tagged(6, keccak256("route"), ""), 1));
        vm.expectRevert(bytes("runtime diagnostic context"));
        bot.execute(script(tagged(0, bytes32(0), ""), 1));
        vm.expectRevert(bytes("runtime diagnostic bounds"));
        bot.execute(script(hex"010900", 1));
    }
}

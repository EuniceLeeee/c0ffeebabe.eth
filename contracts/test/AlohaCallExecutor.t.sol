// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AlohaCallExecutor} from "../src/AlohaCallExecutor.sol";

interface Vm {
    function prank(address msgSender, address txOrigin) external;
}

contract RecordingTarget {
    uint256 public value;
    uint256 public calls;

    function record(uint256 next) external returns (uint256) {
        value = next;
        calls += 1;
        return next + 1;
    }
}

contract RevertingTarget {
    fallback() external payable {
        revert("target-reverted");
    }
}

contract ExecutorForwarder {
    function invoke(AlohaCallExecutor executor, bytes calldata program) external returns (bool, bytes memory) {
        return address(executor).call(abi.encodeCall(AlohaCallExecutor.execute, (program)));
    }
}

contract AlohaCallExecutorTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OWNER = address(0xA11CE);

    function instruction(address target, bytes memory data) private pure returns (bytes memory) {
        return abi.encodePacked(bytes1(0x01), target, uint256(0), uint32(data.length), data);
    }

    function program(bytes memory instructions, uint16 count) private pure returns (bytes memory) {
        return abi.encodePacked(bytes1(0x01), count, instructions);
    }

    function errorSelector(bytes memory returned) private pure returns (bytes4 selector) {
        if (returned.length < 4) return bytes4(0);
        assembly {
            selector := mload(add(returned, 32))
        }
    }

    function testExecutesOrderedCallsAtTopLevel() external {
        AlohaCallExecutor executor = new AlohaCallExecutor(OWNER);
        RecordingTarget target = new RecordingTarget();
        bytes memory calls = bytes.concat(
            instruction(address(target), abi.encodeCall(RecordingTarget.record, (uint256(41)))),
            instruction(address(target), abi.encodeCall(RecordingTarget.record, (uint256(42))))
        );

        vm.prank(OWNER, OWNER);
        (bool success,) = address(executor).call(
            abi.encodeCall(AlohaCallExecutor.execute, (program(calls, 2)))
        );

        require(success, "executor call failed");
        require(target.calls() == 2, "instruction count mismatch");
        require(target.value() == 42, "instruction order mismatch");
    }

    function testRejectsUnauthorizedCaller() external {
        AlohaCallExecutor executor = new AlohaCallExecutor(OWNER);
        (bool success, bytes memory returned) = address(executor).call(
            abi.encodeCall(AlohaCallExecutor.execute, (program(instruction(address(this), bytes("")), 1)))
        );
        require(!success, "unauthorized call succeeded");
        require(errorSelector(returned) == AlohaCallExecutor.Unauthorized.selector, "wrong unauthorized error");
    }

    function testRejectsOwnerUsedAsNestedCallFrame() external {
        ExecutorForwarder forwarder = new ExecutorForwarder();
        AlohaCallExecutor executor = new AlohaCallExecutor(address(forwarder));
        (bool success, bytes memory returned) = forwarder.invoke(
            executor,
            program(instruction(address(this), bytes("")), 1)
        );
        require(!success, "nested owner call succeeded");
        require(errorSelector(returned) == AlohaCallExecutor.NotTopLevel.selector, "wrong nested-call error");
    }

    function testRejectsTrailingProgramBytes() external {
        AlohaCallExecutor executor = new AlohaCallExecutor(OWNER);
        bytes memory malformed = bytes.concat(
            program(instruction(address(0xBEEF), bytes("")), 1),
            hex"00"
        );
        vm.prank(OWNER, OWNER);
        (bool success, bytes memory returned) = address(executor).call(
            abi.encodeCall(AlohaCallExecutor.execute, (malformed))
        );
        require(!success, "malformed program succeeded");
        require(errorSelector(returned) == AlohaCallExecutor.InvalidProgram.selector, "wrong malformed-program error");
    }

    function testPropagatesInstructionFailureAsIndexedError() external {
        AlohaCallExecutor executor = new AlohaCallExecutor(OWNER);
        RevertingTarget target = new RevertingTarget();
        vm.prank(OWNER, OWNER);
        (bool success, bytes memory returned) = address(executor).call(
            abi.encodeCall(
                AlohaCallExecutor.execute,
                (program(instruction(address(target), hex"deadbeef"), 1))
            )
        );
        require(!success, "reverting instruction succeeded");
        require(errorSelector(returned) == AlohaCallExecutor.CallFailed.selector, "wrong instruction-failure error");
    }
}

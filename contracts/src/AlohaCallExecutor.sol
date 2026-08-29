// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal owner-controlled executor for the generated packed CALL
/// program.  It has no fallback, callback, signer, or legacy decoding path.
contract AlohaCallExecutor {
    error InvalidProgram();
    error Unauthorized();
    error NotTopLevel();
    error CallFailed(uint256 index);

    address public immutable owner;

    constructor(address owner_) {
        if (owner_ == address(0)) revert Unauthorized();
        owner = owner_;
    }

    /// @dev Packed program format is version 1, a big-endian uint16 count,
    /// then CALL records: opcode(1) | target(20) | value(32) |
    /// calldataLength(4) | calldata(bytes).  The TypeScript codec is the
    /// canonical producer; this parser is the fail-closed execution gate.
    function execute(bytes calldata program) external payable returns (bytes memory lastReturn) {
        if (msg.sender != owner) revert Unauthorized();
        if (tx.origin != msg.sender) revert NotTopLevel();
        if (program.length < 3 || uint8(program[0]) != 1) revert InvalidProgram();

        uint256 count = (uint256(uint8(program[1])) << 8) | uint256(uint8(program[2]));
        if (count == 0) revert InvalidProgram();

        uint256 offset = 3;
        for (uint256 index = 0; index < count; index++) {
            if (offset > program.length || program.length - offset < 57) revert InvalidProgram();
            if (uint8(program[offset]) != 1) revert InvalidProgram();

            address target;
            uint256 value;
            uint256 calldataLength;
            assembly {
                target := shr(96, calldataload(add(program.offset, add(offset, 1))))
                value := calldataload(add(program.offset, add(offset, 21)))
                calldataLength := shr(224, calldataload(add(program.offset, add(offset, 53))))
            }

            uint256 dataStart = offset + 57;
            if (dataStart > program.length || calldataLength > program.length - dataStart) revert InvalidProgram();
            (bool success, bytes memory returned) = target.call{value: value}(program[dataStart:dataStart + calldataLength]);
            if (!success) revert CallFailed(index);
            lastReturn = returned;
            offset = dataStart + calldataLength;
        }
        if (offset != program.length) revert InvalidProgram();
    }
}

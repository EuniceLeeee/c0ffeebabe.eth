// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BotVMEncoder — Opcode encoding library for BotVM scripts
/// @notice Constructs packed opcode streams. Route-agnostic: knows nothing about
///         specific arb paths. Each function returns raw bytes for one instruction.
///         Concat to build multi-instruction scripts.
library BotVMEncoder {
    /// @dev Opcode 0x00: CALL (no value)
    ///      Layout: [0x00][addr:20][payload_len:3][payload:N]
    function encodeCall(address target, bytes memory payload) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x00), target, uint24(payload.length), payload);
    }

    /// @dev Opcode 0x01: CALL (with value)
    ///      Layout: [0x01][addr:20][value:12][payload_len:3][payload:N]
    function encodeCallValue(address target, uint96 value, bytes memory payload) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x01), target, value, uint24(payload.length), payload);
    }

    /// @dev Opcode 0x02: SET_FIELD2
    ///      Layout: [0x02][field2:3]
    function encodeSetField2(uint24 offset) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x02), offset);
    }

    /// @dev Opcode 0x03: RETURN
    ///      Layout: [0x03][data_len:3][data:N]
    function encodeReturn(bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x03), uint24(data.length), data);
    }

    /// @dev Opcode 0x04: WETH_UNWRAP
    function encodeWethUnwrap() internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x04));
    }

    /// @dev Opcode 0x05: CLEAR_STATE
    function encodeClearState() internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x05));
    }

    /// @dev Opcode 0x06: SET_FIELD3
    ///      Layout: [0x06][field3:3]
    function encodeSetField3(uint24 offset) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x06), offset);
    }

    /// @dev Opcode 0x07: CLEAR_FIELD1
    function encodeClearField1() internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x07));
    }

    /// @dev Opcode 0x08: ASSERT_BALANCE_GTE
    ///      Layout: [0x08][token:20][threshold:32]
    function encodeAssertBalanceGte(address token, uint256 threshold) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x08), token, threshold);
    }

    /// @dev Opcode 0x0d: REVERT
    ///      Layout: [0x0d][data_len:3][data:N]
    function encodeRevert(bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x0d), uint24(data.length), data);
    }

    /// @dev Concatenate two byte arrays.
    function concat(bytes memory a, bytes memory b) internal pure returns (bytes memory) {
        return abi.encodePacked(a, b);
    }
}

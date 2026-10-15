// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Protocol-neutral call-only backend; no runtime registers or amount formulae.
/// The compiler selects it explicitly only after rejecting dynamic operations.
library RuntimeCallSequence {
    function runSlice(bytes memory program, uint256 sliceOffset, uint256 sliceLength, uint256 hop, bytes32 contextHash)
        internal returns (address lastTarget)
    {
        require(sliceOffset <= program.length && sliceLength <= program.length - sliceOffset, "runtime slice bounds");
        assembly ("memory-safe") {
            function alloc(n) -> p {
                p := mload(0x40)
                mstore(0x40, and(add(add(p, n), 31), not(31)))
            }
            function fail(message) {
                let size := 32
                for { } and(iszero(iszero(size)), iszero(byte(sub(size, 1), message))) { } { size := sub(size, 1) }
                let p := mload(0x40)
                mstore(p, shl(224, 0x08c379a0)) mstore(add(p, 4), 32)
                mstore(add(p, 36), size) mstore(add(p, 68), message)
                revert(p, 100)
            }
            function panic(code) {
                let p := mload(0x40) mstore(p, shl(224, 0x4e487b71)) mstore(add(p, 4), code) revert(p, 36)
            }
            function need(p, end, size, reason) {
                if or(gt(p, end), gt(size, sub(end, p))) { fail(reason) }
            }
            function u8(p) -> v { v := byte(0, mload(p)) }
            function u24(p) -> v { v := shr(232, mload(p)) }
            function addr(p) -> v { v := shr(96, mload(p)) }
            function targetMask() -> m { m := 0xffffffffffffffffffffffffffffffffffffffff }
            function hashSlot() -> s { s := 0x47dc154350c9d6e1abf71155179ebd00411f54aa0ddb6ff63cbfd2b8ffa351fe }
            function checkedCall(target, p, size, hopIndex, flowHash) {
                if iszero(extcodesize(target)) { fail("runtime call target") }
                if iszero(call(gas(), target, 0, p, size, 0, 0)) {
                    let reason := alloc(returndatasize()) returndatacopy(reason, 0, returndatasize())
                    hopFailure(hopIndex, flowHash, target, reason, returndatasize(), "runtime external call")
                }
            }
            function directCall(p, end, hopIndex, flowHash) -> next, target {
                if gt(add(p, 23), end) { fail("runtime call header") }
                let header := mload(p)
                target := shr(96, header)
                let size := and(shr(72, header), 0xffffff)
                p := add(p, 23) next := add(p, size)
                if gt(next, end) { fail("runtime slice bounds") }
                let oldState := tload(0x1337)
                let consumed := eq(and(oldState, targetMask()), 1)
                let self := eq(target, address())
                let oldHash := 0
                if self { oldHash := tload(hashSlot()) }
                if iszero(consumed) { tstore(0x1337, or(and(oldState, not(targetMask())), 1)) }
                checkedCall(target, p, size, hopIndex, flowHash)
                if or(self, iszero(consumed)) { tstore(0x1337, oldState) }
                if self { tstore(hashSlot(), oldHash) }
            }
            function callbackCall(p, end, hopIndex, flowHash) -> next, target {
                if gt(add(p, 29), end) { fail("runtime call header") }
                let header := mload(p)
                target := shr(96, header)
                let incoming := and(shr(72, header), 0xffffff)
                let outgoing := and(shr(48, header), 0xffffff)
                let size := and(shr(24, header), 0xffffff)
                if or(lt(incoming, 32), lt(outgoing, 32)) { fail("runtime callback offset") }
                p := add(p, 29) next := add(p, size)
                if gt(next, end) { fail("runtime slice bounds") }
                if gt(outgoing, size) { fail("runtime word bounds") }
                let scriptSize := mload(add(p, sub(outgoing, 32)))
                need(outgoing, size, scriptSize, "runtime slice bounds")
                let oldState := tload(0x1337)
                let oldHash := tload(hashSlot())
                tstore(hashSlot(), keccak256(add(p, outgoing), scriptSize))
                tstore(0x1337, or(shl(224, incoming), target))
                checkedCall(target, p, size, hopIndex, flowHash)
                if iszero(eq(and(tload(0x1337), targetMask()), 1)) {
                    let reason := alloc(100) mstore(reason, shl(224, 0x08c379a0)) mstore(add(reason, 4), 32)
                    mstore(add(reason, 36), 24) mstore(add(reason, 68), "runtime callback missing")
                    hopFailure(hopIndex, flowHash, target, reason, 100, "runtime callback missing")
                }
                tstore(0x1337, oldState) tstore(hashSlot(), oldHash)
            }
            function hopFailure(hopIndex, flowHash, target, reason, size, legacy) {
                let key := sload(0x9f02c8f7e056b1f289c9dc6de656e967d6b1e1b2eeb210324e2c0f27d2617e73)
                if iszero(flowHash) { fail(legacy) }
                let proofData := alloc(160)
                mstore(proofData, key) mstore(add(proofData, 32), hopIndex)
                mstore(add(proofData, 64), target) mstore(add(proofData, 96), flowHash)
                mstore(add(proofData, 128), keccak256(reason, size))
                let proof := keccak256(proofData, 160)
                let total := add(196, and(add(size, 31), not(31))) let p := alloc(total)
                mstore(p, shl(224, 0x4189e9b0)) mstore(add(p, 4), hopIndex) mstore(add(p, 36), target)
                mstore(add(p, 68), flowHash) mstore(add(p, 100), 160) mstore(add(p, 132), proof)
                mstore(add(p, 164), size) mcopy(add(p, 196), reason, size) revert(p, total)
            }
            // Version 2 is the compiler-proven call-only subset. No register
            // frame, arithmetic interpreter or copied return buffer is needed.
            // Protocol selectors and all economic parameters stay in calldata.
            function sequence(p, end, hopIndex, flowHash) -> targetResult {
                if or(iszero(gt(end, add(p, 1))), gt(sub(end, p), 65536)) { fail("runtime program version") }
                p := add(p, 1)
                let count := 0
                let hasReturn := 0
                for { } lt(p, end) { } {
                    count := add(count, 1) if gt(count, 128) { fail("runtime instruction limit") }
                    let op := u8(p) p := add(p, 1)
                    switch op
                    case 9 {
                        if gt(add(p, 33), end) { fail("runtime diagnostic bounds") }
                        hopIndex := u8(p) flowHash := mload(add(p, 1))
                        if or(gt(hopIndex, 5), iszero(flowHash)) { fail("runtime diagnostic context") }
                        p := add(p, 33)
                    }
                    case 11 {
                        if gt(add(p, 36), end) { fail("runtime return floor bounds") }
                        let mode := u8(p) let offset := u24(add(p, 1))
                        if gt(mode, 1) { fail("runtime return floor mode") }
                        if iszero(hasReturn) { fail("runtime word bounds") }
                        if gt(add(offset, 32), returndatasize()) { fail("runtime word bounds") }
                        returndatacopy(0, offset, 32)
                        let value := mload(0)
                        if mode {
                            if iszero(shr(255, value)) { panic(0x11) }
                            value := sub(0, value)
                        }
                        if lt(value, mload(add(p, 4))) { panic(0x11) }
                        p := add(p, 36)
                    }
                    case 10 { p, targetResult := directCall(p, end, hopIndex, flowHash) hasReturn := 1 }
                    case 12 { p, targetResult := callbackCall(p, end, hopIndex, flowHash) hasReturn := 1 }
                    default { fail("runtime opcode") }
                }
            }
            let start := add(add(program, 32), sliceOffset)
            if iszero(eq(u8(start), 2)) { fail("runtime program version") }
            lastTarget := sequence(start, add(start, sliceLength), hop, contextHash)
        }
    }
}

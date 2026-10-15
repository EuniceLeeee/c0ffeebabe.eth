// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {RuntimeCallSequence} from "./RuntimeCallSequence.sol";

/// Compact interpreter shared by flows and standalone callback programs.
/// Protocol ABIs remain in Family emitters. Per-call diagnostic keys only
/// authenticate a failing hop when the production flow supplies its context.
library RuntimeAmountKernel {
    function run(bytes memory program, uint256 amount, uint256 hop, bytes memory flow)
        internal returns (address lastTarget, uint256 result)
    {
        return runSlice(program, 0, program.length, amount, hop, flow);
    }

    /// Run an already bounded portion of the enclosing script without making
    /// a second allocation/copy. The source bytes are never modified.
    function runSlice(bytes memory program, uint256 sliceOffset, uint256 sliceLength,
        uint256 amount, uint256 hop, bytes memory flow)
        internal returns (address lastTarget, uint256 result)
    {
        require(sliceOffset <= program.length && sliceLength <= program.length - sliceOffset, "runtime slice bounds");
        if (sliceLength != 0 && uint8(program[sliceOffset]) == 2) {
            bytes32 flowHash = flow.length == 0 ? bytes32(0) : keccak256(flow);
            return (RuntimeCallSequence.runSlice(program, sliceOffset, sliceLength, hop, flowHash), amount);
        }
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
            function reg(r, i) -> p {
                if gt(i, 15) { panic(0x32) } p := add(r, shl(5, i))
            }
            function get(r, i) -> v { v := mload(reg(r, i)) }
            function u8(p) -> v { v := byte(0, mload(p)) }
            function u24(p) -> v { v := shr(232, mload(p)) }
            function addr(p) -> v { v := shr(96, mload(p)) }
            function targetMask() -> m { m := 0xffffffffffffffffffffffffffffffffffffffff }
            function hashSlot() -> s { s := 0x47dc154350c9d6e1abf71155179ebd00411f54aa0ddb6ff63cbfd2b8ffa351fe }
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
            function allowance(token, spender) -> v {
                let p := alloc(96)
                mstore(p, shl(224, 0xdd62ed3e)) mstore(add(p, 4), address()) mstore(add(p, 36), spender)
                if iszero(staticcall(gas(), token, p, 68, p, 32)) { fail("allowance read failed") }
                if iszero(eq(returndatasize(), 32)) { fail("allowance read failed") } v := mload(p)
            }
            function approve(token, spender, value) -> ok {
                let p := alloc(96)
                mstore(p, shl(224, 0x095ea7b3)) mstore(add(p, 4), spender) mstore(add(p, 36), value)
                ok := call(gas(), token, 0, p, 68, p, 32)
                if ok { if returndatasize() { ok := and(eq(returndatasize(), 32), eq(mload(p), 1)) } }
            }
            function ensure(token, spender, minimum, grant) {
                if or(or(iszero(token), iszero(spender)), or(iszero(minimum), lt(grant, minimum))) { fail("allowance config") }
                if iszero(extcodesize(token)) { fail("allowance token has no code") }
                if iszero(lt(allowance(token, spender), minimum)) { leave }
                if iszero(approve(token, spender, grant)) {
                    if iszero(approve(token, spender, 0)) { fail("allowance reset failed") }
                    if allowance(token, spender) { fail("allowance not reset") }
                    if iszero(approve(token, spender, grant)) { fail("allowance approve failed") }
                }
                if iszero(eq(allowance(token, spender), grant)) { fail("allowance not set") }
            }
            function invoke(p, end, r, hopIndex, flowHash) -> next, returned, returnedSize, target {
                need(p, end, 29, "runtime call header")
                let header := mload(p)
                target := shr(96, header)
                let mode := byte(20, header) let vr := byte(21, header)
                let incoming := and(shr(56, header), 0xffffff)
                let outgoing := and(shr(32, header), 0xffffff)
                let patches := byte(28, header) let patchStart := add(p, 29)
                p := add(patchStart, shl(2, patches))
                need(p, end, 3, "runtime size bounds")
                let size := u24(p) p := add(p, 3)
                need(p, end, size, "runtime slice bounds")
                // CALL only reads this memory. Unpatched calldata can use the
                // original program slice; patched calls still get a private copy.
                let payload := p
                if patches { payload := alloc(size) mcopy(payload, p, size) }
                next := add(p, size)
                for { let i := 0 } lt(i, patches) { i := add(i, 1) } {
                    let patch := add(patchStart, shl(2, i)) let offset := u24(patch)
                    if or(lt(offset, 4), gt(add(offset, 32), size)) { fail("runtime patch bounds") }
                    mstore(add(payload, offset), get(r, u8(add(patch, 3))))
                }
                if or(iszero(extcodesize(target)), gt(mode, 1)) { fail("runtime call target") }
                if mode { if or(iszero(eq(vr, 255)), incoming) { fail("runtime static config") } }
                let oldTarget := 0 let oldHash := 0 let oldState := 0
                // STATICCALL cannot change transient or persistent state. An
                // ordinary external call only needs the callback sentinel.
                // A self-call can run legacy opcodes that change the VM frame.
                let frame := or(incoming, and(iszero(mode), eq(target, address())))
                if iszero(mode) {
                    oldState := tload(0x1337)
                    oldTarget := and(oldState, targetMask())
                    // A callback call installs its authenticated target below,
                    // before CALL. Do not write an immediately replaced sentinel.
                    if and(iszero(incoming), iszero(eq(oldTarget, 1))) {
                        tstore(0x1337, or(and(oldState, not(targetMask())), 1))
                    }
                }
                if frame {
                    oldHash := tload(hashSlot())
                }
                if incoming {
                    if or(lt(incoming, 32), lt(outgoing, 32)) { fail("runtime callback offset") }
                    need(outgoing, size, 0, "runtime word bounds")
                    let scriptSize := mload(add(payload, sub(outgoing, 32)))
                    need(outgoing, size, scriptSize, "runtime slice bounds")
                    tstore(hashSlot(), keccak256(add(payload, outgoing), scriptSize))
                    tstore(0x1337, or(shl(224, incoming), target))
                }
                let ok := 0
                switch mode
                case 1 { ok := staticcall(gas(), target, payload, size, 0, 0) }
                default {
                    let value := 0 if iszero(eq(vr, 255)) { value := get(r, vr) }
                    ok := call(gas(), target, value, payload, size, 0, 0)
                }
                if iszero(ok) {
                    let reason := alloc(returndatasize()) returndatacopy(reason, 0, returndatasize())
                    hopFailure(hopIndex, flowHash, target, reason, returndatasize(), "runtime external call")
                }
                if incoming { if iszero(eq(and(tload(0x1337), targetMask()), 1)) {
                    let reason := alloc(100) mstore(reason, shl(224, 0x08c379a0)) mstore(add(reason, 4), 32)
                    mstore(add(reason, 36), 24) mstore(add(reason, 68), "runtime callback missing")
                    hopFailure(hopIndex, flowHash, target, reason, 100, "runtime callback missing")
                } }
                if iszero(mode) { if or(frame, iszero(eq(oldTarget, 1))) { tstore(0x1337, oldState) } }
                if frame { tstore(hashSlot(), oldHash) }
                returnedSize := returndatasize() returned := alloc(returnedSize) returndatacopy(returned, 0, returnedSize)
            }
            // The no-value/no-patch/no-callback form avoids decoding options
            // that the compiler has proved absent. Self-call frame protection
            // and authenticated failure metadata are the same as invoke().
            function direct(p, end, hopIndex, flowHash) -> next, returned, returnedSize, target {
                need(p, end, 23, "runtime call header")
                target := addr(p)
                let size := u24(add(p, 20))
                p := add(p, 23) need(p, end, size, "runtime slice bounds")
                next := add(p, size)
                if iszero(extcodesize(target)) { fail("runtime call target") }
                let oldState := tload(0x1337)
                let oldTarget := and(oldState, targetMask())
                let self := eq(target, address())
                let oldHash := 0
                if self { oldHash := tload(hashSlot()) }
                if iszero(eq(oldTarget, 1)) { tstore(0x1337, or(and(oldState, not(targetMask())), 1)) }
                if iszero(call(gas(), target, 0, p, size, 0, 0)) {
                    let reason := alloc(returndatasize()) returndatacopy(reason, 0, returndatasize())
                    hopFailure(hopIndex, flowHash, target, reason, returndatasize(), "runtime external call")
                }
                if or(self, iszero(eq(oldTarget, 1))) { tstore(0x1337, oldState) }
                if self { tstore(hashSlot(), oldHash) }
                returnedSize := returndatasize() returned := alloc(returnedSize) returndatacopy(returned, 0, returnedSize)
            }
            function execute(p, end, amountIn, readonly, depth, hopIndex, flowHash) -> targetResult, output {
                if gt(depth, 8) { fail("runtime nesting limit") }
                if or(or(iszero(gt(end, add(p, 1))), gt(sub(end, p), 65536)), iszero(eq(u8(p), 1))) { fail("runtime program version") }
                p := add(p, 1)
                let r := alloc(512)
                // Solidity may have used free memory as temporary scratch.
                // Invocation-local registers must match a zeroed uint256[16].
                calldatacopy(r, calldatasize(), 512) mstore(r, amountIn)
                let returned := 0 let returnedSize := 0 let count := 0
                for { } lt(p, end) { } {
                    count := add(count, 1) if gt(count, 128) { fail("runtime instruction limit") }
                    let op := u8(p) p := add(p, 1)
                    switch op
                    case 0 {
                        need(p, end, 33, "runtime constant bounds")
                        let dst := byte(0, mload(p)) if gt(dst, 15) { panic(0x32) }
                        mstore(add(r, shl(5, dst)), mload(add(p, 1))) p := add(p, 33)
                    }
                    case 1 {
                        if readonly {
                            need(p, end, 29, "runtime readonly call")
                            if iszero(eq(u8(add(p, 20)), 1)) { fail("runtime readonly call") }
                        }
                        p, returned, returnedSize, targetResult := invoke(p, end, r, hopIndex, flowHash)
                    }
                    case 2 {
                        need(p, end, 4, "runtime math bounds")
                        let header := mload(p)
                        let kind := byte(0, header) let dstIndex := byte(1, header)
                        let aIndex := byte(2, header) let bIndex := byte(3, header)
                        if gt(or(dstIndex, or(aIndex, bIndex)), 15) { panic(0x32) }
                        let dst := add(r, shl(5, dstIndex))
                        let a := mload(add(r, shl(5, aIndex))) let b := mload(add(r, shl(5, bIndex))) let value := 0
                        switch kind
                        case 0 { value := add(a, b) if lt(value, a) { panic(0x11) } }
                        case 1 { if lt(a, b) { panic(0x11) } value := sub(a, b) }
                        case 2 { value := mul(a, b) if a { if iszero(eq(div(value, a), b)) { panic(0x11) } } }
                        case 3 { if iszero(b) { panic(0x12) } value := div(a, b) }
                        case 4 { if gt(b, 255) { fail("runtime shift") } value := shr(b, a) }
                        case 5 { value := and(a, b) }
                        case 6 { if shr(255, a) { fail("runtime signed range") } value := sub(0, a) }
                        default { fail("runtime math opcode") }
                        mstore(dst, value) p := add(p, 4)
                    }
                    case 3 {
                        need(p, end, 2, "runtime equality bounds")
                        let header := mload(p) let a := byte(0, header) let b := byte(1, header)
                        if gt(or(a, b), 15) { panic(0x32) }
                        if iszero(eq(mload(add(r, shl(5, a))), mload(add(r, shl(5, b))))) { fail("runtime amount mismatch") } p := add(p, 2)
                    }
                    case 4 {
                        if readonly { fail("runtime readonly allowance") }
                        need(p, end, 73, "runtime allowance bounds")
                        let oldState := tload(0x1337)
                        tstore(0x1337, or(and(oldState, not(targetMask())), 1))
                        ensure(addr(p), addr(add(p, 20)), get(r, u8(add(p, 40))), mload(add(p, 41)))
                        tstore(0x1337, oldState) p := add(p, 73)
                    }
                    case 5 {
                        need(p, end, 1, "runtime native balance bounds")
                        let dst := byte(0, mload(p)) if gt(dst, 15) { panic(0x32) }
                        mstore(add(r, shl(5, dst)), selfbalance()) p := add(p, 1)
                    }
                    case 6 {
                        need(p, end, 4, "runtime result bounds") let offset := u24(add(p, 1))
                        need(offset, returnedSize, 32, "runtime word bounds")
                        let dst := byte(0, mload(p)) if gt(dst, 15) { panic(0x32) }
                        mstore(add(r, shl(5, dst)), mload(add(returned, offset))) p := add(p, 4)
                    }
                    case 7 {
                        if gt(add(p, 4), end) {
                            let e := mload(0x40) mstore(e, shl(224, 0x08c379a0)) mstore(add(e, 4), 32) mstore(add(e, 36), 35)
                            mstore(add(e, 68), "runtime calldata instruction bou") mstore(add(e, 100), "nds") revert(e, 132)
                        }
                        let offset := u24(add(p, 1)) need(offset, calldatasize(), 32, "runtime calldata bounds")
                        let dst := byte(0, mload(p)) if gt(dst, 15) { panic(0x32) }
                        mstore(add(r, shl(5, dst)), calldataload(offset)) p := add(p, 4)
                    }
                    case 8 {
                        need(p, end, 6, "runtime subprogram header")
                        let header := mload(p)
                        let amountReg := byte(0, header) let outputIndex := byte(1, header) let mode := byte(2, header)
                        if gt(or(amountReg, outputIndex), 15) { panic(0x32) }
                        let outputReg := add(r, shl(5, outputIndex))
                        if gt(mode, 1) { fail("runtime subprogram mode") }
                        let size := u24(add(p, 3)) p := add(p, 6) need(p, end, size, "runtime slice bounds")
                        let childTarget, outputValue := execute(p, add(p, size), mload(add(r, shl(5, amountReg))), or(readonly, mode), add(depth, 1), hopIndex, flowHash)
                        mstore(outputReg, outputValue) if childTarget { targetResult := childTarget } p := add(p, size)
                    }
                    case 9 {
                        need(p, end, 33, "runtime diagnostic bounds")
                        hopIndex := u8(p) flowHash := mload(add(p, 1))
                        if or(gt(hopIndex, 5), iszero(flowHash)) { fail("runtime diagnostic context") }
                        p := add(p, 33)
                    }
                    case 10 {
                        if readonly { fail("runtime readonly call") }
                        p, returned, returnedSize, targetResult := direct(p, end, hopIndex, flowHash)
                    }
                    case 11 {
                        need(p, end, 36, "runtime return floor bounds")
                        let mode := u8(p) let offset := u24(add(p, 1))
                        if gt(mode, 1) { fail("runtime return floor mode") }
                        need(offset, returnedSize, 32, "runtime word bounds")
                        let value := mload(add(returned, offset))
                        if mode {
                            if iszero(shr(255, value)) { panic(0x11) }
                            value := sub(0, value)
                        }
                        if lt(value, mload(add(p, 4))) { panic(0x11) }
                        p := add(p, 36)
                    }
                    default { fail("runtime opcode") }
                }
                output := mload(r)
            }
            let flowHash := 0
            if mload(flow) { flowHash := keccak256(add(flow, 32), mload(flow)) }
            let start := add(add(program, 32), sliceOffset)
            lastTarget, result := execute(start, add(start, sliceLength), amount, 0, 0, hop, flowHash)
        }
    }
}

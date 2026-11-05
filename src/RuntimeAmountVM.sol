// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {RuntimeAmountKernel} from "./RuntimeAmountKernel.sol";
import {RuntimeCallSequence} from "./RuntimeCallSequence.sol";

/// Protocol-neutral, bounded runtime amount programs. Protocol selectors and
/// formulae are emitted by Family encoders, never interpreted by this kernel.
abstract contract RuntimeAmountVM {
    uint256 private constant CALLBACK_HASH = uint256(keccak256("BotVM.runtime.callback.hash"));
    uint256 private constant VM_STATE = 0x1337;
    // Dry-run-only state overlay. Never read on a successful execution. A fresh
    // key per sim authenticates our envelope; external revert bytes stay opaque.
    uint256 private constant DIAGNOSTIC_KEY = uint256(keccak256("BotVM.runtime.hop.diagnostic.key.v1"));
    struct HopContext { uint256 index; bytes flow; address lastTarget; }
    error RuntimeHopFailed(uint256 hop, address target, bytes32 flowHash, bytes reason, bytes32 proof);

    function _checkRuntimeCallback(uint256 start, uint256 size, uint256 state) internal returns (bytes memory script) {
        uint256 callbackHash = CALLBACK_HASH;
        assembly ("memory-safe") {
            function reject(message) {
                let n := 32
                for { } and(iszero(iszero(n)), iszero(byte(sub(n, 1), message))) { } { n := sub(n, 1) }
                let p := mload(0x40)
                mstore(p, shl(224, 0x08c379a0)) mstore(add(p, 4), 32)
                mstore(add(p, 36), n) mstore(add(p, 68), message) revert(p, 100)
            }
            let mask := 0xffffffffffffffffffffffffffffffffffffffff
            let target := and(state, mask)
            if target {
                if iszero(eq(target, caller())) { reject("runtime callback sender") }
                if or(gt(start, calldatasize()), gt(size, sub(calldatasize(), start))) {
                    reject("runtime callback bounds")
                }
            }
            script := mload(0x40)
            let next := and(add(add(script, size), 63), not(31))
            // Match Solidity's checked dynamic-memory allocation, including
            // legacy callbacks whose length is not bounded by msg.data.
            if or(gt(size, 0xffffffffffffffff), or(lt(next, script), gt(next, 0xffffffffffffffff))) {
                mstore(0, shl(224, 0x4e487b71)) mstore(4, 0x41) revert(0, 36)
            }
            mstore(0x40, next) mstore(script, size)
            mstore(sub(next, 32), 0)
            calldatacopy(add(script, 32), start, size)
            if target {
                if iszero(eq(keccak256(add(script, 32), size), tload(callbackHash))) {
                    reject("runtime callback script")
                }
                tstore(VM_STATE, or(and(state, not(mask)), 1))
            }
        }
    }

    function _runRuntimeAmountFlow(bytes memory data) internal {
        require(data.length >= 33, "runtime flow header");
        uint256 amount = _word(data, 0);
        // High bit opts into one raw unit of positive input dust. Existing
        // count-only programs retain exact conservation. No deficit is allowed.
        uint256 flags = uint8(data[32]);
        uint256 tolerance = flags >> 7;
        uint256 count = flags & 0x07;
        require((flags & 0x38) == 0, "runtime flow flags");
        require(amount > 0 && count > 0 && count <= 6, "runtime flow config");
        // Optional per-leg maximum-input semantics, separate from rounding.
        // Old executors reject the 0x40 flag; legacy exact-input bytes are unchanged.
        uint256 start = 33;
        uint256 maximumInputMask;
        if ((flags & 0x40) != 0) {
            require(data.length >= 34, "runtime input policy bounds");
            maximumInputMask = uint8(data[33]);
            require(maximumInputMask > 0 && maximumInputMask < (1 << count), "runtime input policy mask");
            start = 34;
        }
        // Separate existing inventory from the working amount once. Subsequent
        // legs consume only this flow's receipts, not the executor's inventory.
        // End-of-flow conservation catches changes to earlier route tokens.
        uint256[6] memory routeBalances;
        address[6] memory routeTokens;
        uint256 tokenCount;
        uint256 scan = start;
        address previous;
        for (uint256 i; i < count; ++i) {
            require(scan + 75 <= data.length, "runtime flow leg");
            address tokenIn = _address(data, scan);
            address tokenOut = _address(data, scan + 20);
            require(tokenIn != address(0) && tokenOut != address(0) && tokenIn != tokenOut, "runtime flow tokens");
            require(i == 0 || previous == tokenIn, "runtime flow continuity");
            bool found;
            for (uint256 j; j < tokenCount; ++j) {
                if (routeTokens[j] == tokenIn) { found = true; break; }
            }
            if (!found) {
                routeTokens[tokenCount] = tokenIn;
                routeBalances[tokenCount++] = IERC20(tokenIn).balanceOf(address(this));
            }
            previous = tokenOut;
            scan += 75 + _u24(data, scan + 72);
        }
        require(scan == data.length, "runtime flow bounds");
        require(previous == routeTokens[0], "runtime flow closure");
        require(routeBalances[0] >= amount, "runtime input balance");
        uint256 beforeInput = routeBalances[0];
        routeBalances[0] -= amount;
        uint256 beforeNative = address(this).balance;
        uint256 ip = start;
        for (uint256 i; i < count; ++i) {
            address tokenOut = _address(data, ip + 20);
            uint256 size = _u24(data, ip + 72);
            HopContext memory context = HopContext(i, data, address(0));
            _runRuntimeProgram(_slice(data, ip + 75, size), amount, context);
            // beforeInput is the previous hop's already-measured receipt
            // balance (or the initial balance). One additional on-chain read
            // checks this hop's spend, including the funding/repeated token;
            // no extra before read or off-chain quote/RPC is needed.
            uint256 afterInput = IERC20(_address(data, ip)).balanceOf(address(this));
            require(afterInput < beforeInput, "runtime input debit");
            uint256 spent = beforeInput - afterInput;
            require(spent <= amount, "runtime input rounding");
            if ((maximumInputMask & (1 << i)) == 0) {
                require(amount - spent <= tolerance, "runtime input rounding");
            }
            if (spent < amount) {
                // Protect all retained input, including one-unit rounding. Protect it alongside
                // inventory so a later visit cannot mistake it for fresh output.
                address tokenIn = _address(data, ip);
                for (uint256 j; j < tokenCount; ++j) {
                    if (routeTokens[j] == tokenIn) {
                        routeBalances[j] += amount - spent;
                        break;
                    }
                }
            }
            uint256 baseline;
            for (uint256 j; j < tokenCount; ++j) {
                if (routeTokens[j] == tokenOut) { baseline = routeBalances[j]; break; }
            }
            // One receipt read per hop. A pool's returned debit need not equal
            // the credited ERC20 amount (for example, transfer-tax outputs).
            uint256 afterOut = IERC20(tokenOut).balanceOf(address(this));
            if (afterOut < baseline) _runtimeHopGuard(context, context.lastTarget, "runtime output inventory");
            amount = afterOut - baseline;
            beforeInput = afterOut;
            if (amount == 0 || amount < _word(data, ip + 40)) {
                _runtimeHopGuard(context, context.lastTarget, "runtime minimum output");
            }
            ip += 75 + size;
        }
        // The last receipt read already measured the closing token. Check the
        // other distinct route tokens once, after all calls have completed.
        for (uint256 i = 1; i < tokenCount; ++i) {
            uint256 remaining = IERC20(routeTokens[i]).balanceOf(address(this));
            require(remaining >= routeBalances[i] && remaining - routeBalances[i] <= tolerance, "runtime route inventory");
        }
        require(address(this).balance == beforeNative, "runtime native inventory");
    }

    function _runRuntimeProgram(bytes memory data, uint256 amount) internal {
        RuntimeAmountKernel.run(data, amount, 0, new bytes(0));
    }

    function _runRuntimeProgramSlice(bytes memory data, uint256 start, uint256 size, uint256 amount) internal {
        if (start == 1) {
            RuntimeCallSequence.runSlice(data, start, size, 0, bytes32(0));
            return;
        }
        RuntimeAmountKernel.runSlice(data, start, size, amount, 0, new bytes(0));
    }

    function _runRuntimeProgram(bytes memory data, uint256 amount, HopContext memory context)
        private
    {
        (context.lastTarget,) = RuntimeAmountKernel.run(data, amount, context.index, context.flow);
    }

    function _runtimeHopGuard(HopContext memory context, address target, string memory reason) private view {
        _runtimeHopFailure(context, target, abi.encodeWithSignature("Error(string)", reason), reason);
    }

    function _runtimeHopFailure(HopContext memory context, address target, bytes memory reason, string memory legacy)
        private view
    {
        uint256 slot = DIAGNOSTIC_KEY;
        bytes32 key;
        assembly ("memory-safe") { key := sload(slot) }
        if (key == bytes32(0) || context.flow.length == 0) revert(legacy);
        bytes32 flowHash = keccak256(context.flow);
        bytes32 proof = keccak256(abi.encode(key, context.index, target, flowHash, keccak256(reason)));
        revert RuntimeHopFailed(context.index, target, flowHash, reason, proof);
    }

    // Outer VM/flash-loan calls must not discard our inner failure envelope.
    // This only transports bytes: the simulator verifies the per-call proof.
    function _bubbleRuntimeHopFailure(bytes memory result, string memory legacy) internal pure {
        if (result.length >= 4 && bytes4(result) == RuntimeHopFailed.selector) {
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        revert(legacy);
    }
    function _word(bytes memory data, uint256 offset) private pure returns (uint256 value) {
        require(offset <= data.length && data.length - offset >= 32, "runtime word bounds");
        assembly ("memory-safe") { value := mload(add(add(data, 32), offset)) }
    }
    function _u24(bytes memory data, uint256 offset) private pure returns (uint256 value) {
        require(offset <= data.length && data.length - offset >= 3, "runtime size bounds");
        assembly ("memory-safe") { value := shr(232, mload(add(add(data, 32), offset))) }
    }
    function _address(bytes memory data, uint256 offset) private pure returns (address value) {
        require(offset <= data.length && data.length - offset >= 20, "runtime address bounds");
        assembly ("memory-safe") { value := shr(96, mload(add(add(data, 32), offset))) }
    }
    function _slice(bytes memory data, uint256 offset, uint256 size) private pure returns (bytes memory result) {
        require(offset <= data.length && size <= data.length - offset, "runtime slice bounds");
        result = new bytes(size);
        assembly ("memory-safe") {
            mcopy(add(result, 32), add(add(data, 32), offset), size)
        }
    }
}

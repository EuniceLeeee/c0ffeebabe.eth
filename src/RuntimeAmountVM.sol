// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

/// Protocol-neutral, bounded runtime amount programs. Protocol selectors and
/// formulae are emitted by Family encoders, never interpreted by this kernel.
abstract contract RuntimeAmountVM {
    uint256 private constant CALLBACK_TARGET = uint256(keccak256("BotVM.runtime.callback.target"));
    uint256 private constant CALLBACK_HASH = uint256(keccak256("BotVM.runtime.callback.hash"));
    uint256 private constant VM_STATE = 0x1337;

    function _runtimeEnsureAllowance(address token, address spender, uint256 minimum, uint256 grant) internal virtual;

    function _checkRuntimeCallback(uint256 start, uint256 size) internal {
        uint256 target = _getTransient(CALLBACK_TARGET);
        if (target == 0) return; // legacy execution has its separate contract
        require(target == uint160(msg.sender), "runtime callback sender");
        require(start <= msg.data.length && size <= msg.data.length - start, "runtime callback bounds");
        require(keccak256(msg.data[start:start + size]) == bytes32(_getTransient(CALLBACK_HASH)), "runtime callback script");
        _setTransient(CALLBACK_TARGET, 1); // one callback; nested calls install their own scope
    }

    function _runRuntimeAmountFlow(bytes memory data) internal {
        require(data.length >= 33, "runtime flow header");
        uint256 amount = _word(data, 0);
        // High bit opts into one raw unit of positive input dust. Existing
        // count-only programs retain exact conservation. No deficit is allowed.
        uint256 tolerance = uint8(data[32]) >> 7;
        uint256 count = uint8(data[32]) & 0x7f;
        require(amount > 0 && count > 0 && count <= 6, "runtime flow config");
        // Separate existing inventory from the working amount once. Subsequent
        // legs consume only this flow's receipts, not the executor's inventory.
        // End-of-flow conservation catches changes to earlier route tokens.
        uint256[6] memory routeBalances;
        address[6] memory routeTokens;
        uint256 tokenCount;
        uint256 scan = 33;
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
        uint256 ip = 33;
        for (uint256 i; i < count; ++i) {
            address tokenOut = _address(data, ip + 20);
            uint256 floor = _word(data, ip + 40);
            uint256 size = _u24(data, ip + 72);
            _runRuntimeProgram(_slice(data, ip + 75, size), amount);
            // beforeInput is the previous hop's already-measured receipt
            // balance (or the initial balance). One additional on-chain read
            // checks this hop's spend, including the funding/repeated token;
            // no extra before read or off-chain quote/RPC is needed.
            uint256 afterInput = IERC20(_address(data, ip)).balanceOf(address(this));
            require(afterInput < beforeInput, "runtime input debit");
            uint256 spent = beforeInput - afterInput;
            require(spent <= amount && amount - spent <= tolerance, "runtime input rounding");
            uint256 baseline;
            for (uint256 j; j < tokenCount; ++j) {
                if (routeTokens[j] == tokenOut) { baseline = routeBalances[j]; break; }
            }
            // One receipt read per hop. A pool's returned debit need not equal
            // the credited ERC20 amount (for example, transfer-tax outputs).
            uint256 afterOut = IERC20(tokenOut).balanceOf(address(this));
            require(afterOut >= baseline, "runtime output inventory");
            amount = afterOut - baseline;
            beforeInput = afterOut;
            require(amount > 0 && amount >= floor, "runtime minimum output");
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
        require(data.length > 1 && data.length <= 65536 && uint8(data[0]) == 1, "runtime program version");
        uint256[16] memory r;
        r[0] = amount;
        uint256 ip = 1;
        uint256 count;
        bytes memory returned;
        while (ip < data.length) {
            require(++count <= 128, "runtime instruction limit");
            uint8 op = uint8(data[ip++]);
            if (op == 0) {
                require(ip + 33 <= data.length, "runtime constant bounds");
                r[uint8(data[ip])] = _word(data, ip + 1); ip += 33;
            } else if (op == 1) {
                (ip, returned) = _runtimeCall(data, ip, r);
            } else if (op == 2) {
                require(ip + 4 <= data.length, "runtime math bounds");
                uint8 kind = uint8(data[ip]);
                uint256 dst = uint8(data[ip + 1]);
                uint256 a = r[uint8(data[ip + 2])];
                uint256 b = r[uint8(data[ip + 3])];
                if (kind == 0) r[dst] = a + b;
                else if (kind == 1) r[dst] = a - b;
                else if (kind == 2) r[dst] = a * b;
                else if (kind == 3) r[dst] = a / b;
                else if (kind == 4) { require(b < 256, "runtime shift"); r[dst] = a >> b; }
                else if (kind == 5) r[dst] = a & b;
                else if (kind == 6) { require(a < (1 << 255), "runtime signed range"); unchecked { r[dst] = 0 - a; } }
                else revert("runtime math opcode");
                ip += 4;
            } else if (op == 3) {
                require(ip + 2 <= data.length, "runtime equality bounds");
                require(r[uint8(data[ip])] == r[uint8(data[ip + 1])], "runtime amount mismatch"); ip += 2;
            } else if (op == 4) {
                require(ip + 73 <= data.length, "runtime allowance bounds");
                uint256 oldTarget = _getTransient(CALLBACK_TARGET);
                _setTransient(CALLBACK_TARGET, 1);
                _runtimeEnsureAllowance(_address(data, ip), _address(data, ip + 20), r[uint8(data[ip + 40])], _word(data, ip + 41));
                _setTransient(CALLBACK_TARGET, oldTarget);
                ip += 73;
            } else if (op == 5) {
                require(ip < data.length, "runtime native balance bounds");
                r[uint8(data[ip++])] = address(this).balance;
            } else if (op == 6) {
                require(ip + 4 <= data.length, "runtime result bounds");
                r[uint8(data[ip])] = _word(returned, _u24(data, ip + 1)); ip += 4;
            } else if (op == 7) {
                require(ip + 4 <= data.length, "runtime calldata instruction bounds");
                uint256 offset = _u24(data, ip + 1);
                require(offset <= msg.data.length && msg.data.length - offset >= 32, "runtime calldata bounds");
                uint256 value;
                assembly { value := calldataload(offset) }
                r[uint8(data[ip])] = value; ip += 4;
            } else revert("runtime opcode");
        }
    }

    function _runtimeCall(bytes memory data, uint256 ip, uint256[16] memory r)
        private returns (uint256, bytes memory result)
    {
        require(ip + 29 <= data.length, "runtime call header");
        address target = _address(data, ip);
        uint256 mode = uint8(data[ip + 20]);
        uint256 valueReg = uint8(data[ip + 21]);
        uint256 incoming = _u24(data, ip + 22);
        uint256 outgoing = _u24(data, ip + 25);
        uint256 patches = uint8(data[ip + 28]);
        ip += 29;
        uint256 patchStart = ip;
        ip += patches * 4;
        uint256 size = _u24(data, ip);
        bytes memory payload = _slice(data, ip + 3, size);
        ip += 3 + size;
        for (uint256 i; i < patches; ++i) {
            uint256 offset = _u24(data, patchStart + i * 4);
            require(offset >= 4 && offset + 32 <= size, "runtime patch bounds");
            uint256 value = r[uint8(data[patchStart + i * 4 + 3])];
            assembly { mstore(add(add(payload, 32), offset), value) }
        }
        require(target.code.length > 0 && mode <= 1, "runtime call target");
        require(mode == 0 || (valueReg == 255 && incoming == 0), "runtime static config");
        uint256 oldTarget = _getTransient(CALLBACK_TARGET);
        uint256 oldHash = _getTransient(CALLBACK_HASH);
        uint256 oldState = _getTransient(VM_STATE);
        _setTransient(CALLBACK_TARGET, incoming == 0 ? 1 : uint160(target));
        if (incoming != 0) {
            require(incoming >= 32 && outgoing >= 32, "runtime callback offset");
            bytes memory callbackScript = _slice(payload, outgoing, _word(payload, outgoing - 32));
            _setTransient(CALLBACK_HASH, uint256(keccak256(callbackScript)));
            _setTransient(VM_STATE, incoming << 224);
        }
        bool ok;
        if (mode == 1) (ok, result) = target.staticcall(payload);
        else (ok, result) = target.call{value: valueReg == 255 ? 0 : r[valueReg]}(payload);
        require(ok, "runtime external call");
        if (incoming != 0) require(_getTransient(CALLBACK_TARGET) == 1, "runtime callback missing");
        _setTransient(CALLBACK_TARGET, oldTarget);
        _setTransient(CALLBACK_HASH, oldHash);
        _setTransient(VM_STATE, oldState);
        return (ip, result);
    }
    function _getTransient(uint256 slot) private view returns (uint256 value) { assembly { value := tload(slot) } }
    function _setTransient(uint256 slot, uint256 value) private { assembly { tstore(slot, value) } }
    function _word(bytes memory data, uint256 offset) private pure returns (uint256 value) {
        require(offset <= data.length && data.length - offset >= 32, "runtime word bounds");
        assembly { value := mload(add(add(data, 32), offset)) }
    }
    function _u24(bytes memory data, uint256 offset) private pure returns (uint256 value) {
        require(offset <= data.length && data.length - offset >= 3, "runtime size bounds");
        assembly { value := shr(232, mload(add(add(data, 32), offset))) }
    }
    function _address(bytes memory data, uint256 offset) private pure returns (address value) {
        require(offset <= data.length && data.length - offset >= 20, "runtime address bounds");
        assembly { value := shr(96, mload(add(add(data, 32), offset))) }
    }
    function _slice(bytes memory data, uint256 offset, uint256 size) private pure returns (bytes memory result) {
        require(offset <= data.length && size <= data.length - offset, "runtime slice bounds");
        result = new bytes(size);
        assembly {
            let src := add(add(data, 32), offset)
            let dst := add(result, 32)
            for { let i := 0 } lt(i, size) { i := add(i, 32) } {
                mstore(add(dst, i), mload(add(src, i)))
            }
        }
    }
}

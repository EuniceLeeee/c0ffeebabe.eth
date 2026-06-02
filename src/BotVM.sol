// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {Constants} from "./Constants.sol";

/// @title BotVM — Readable replica of MEV bot's action interpreter
/// @notice Implements 9 of the original bot's 15 opcodes, enough to replay the wstUSR arb.
///         See docs/bot-vm-analysis.md for the full reverse engineering.
///
/// Architecture (mirrors original bot):
///   - execute(script)     : owner entry, runs VM loop
///   - execSubscript(script): self-call entry (opcode 0x00 calling self)
///   - fallback()          : protocol callback entry, reads field2 from TSLOT 0x1337
///   - _runVM(script)      : shared VM loop, 9 opcodes
///
/// TSLOT 0x1337 state register — packed 7 bytes:
///   field1 (1B): callback_active flag
///   field2 (3B): resume_offset — calldata offset where sub-script bytes start
///   field3 (3B): auxiliary_offset
contract BotVM {
    address public immutable owner;

    /// @dev Self-call selector: keccak256("execSubscript(bytes)")[:4]
    bytes4 private constant SUBSCRIPT_SELECTOR = bytes4(keccak256("execSubscript(bytes)"));

    /// @dev Transient storage slot for VM state, same as original bot.
    uint256 private constant STATE_SLOT = 0x1337;

    // Sqrt price limits for Uniswap V3
    uint160 private constant MIN_SQRT_PRICE = 4295128740;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ─── Entry Points ─────────────────────────────────────────────

    /// @notice Owner entry: execute a packed opcode script.
    function execute(bytes calldata script) external onlyOwner {
        _runVM(script);
    }

    /// @notice Self-call entry: run a sub-script. Only callable by self.
    ///         Original bot uses selector 0xcabcfc90 for this path.
    function execSubscript(bytes calldata script) external {
        require(msg.sender == address(this), "not self");
        _runVM(script);
    }

    /// @notice Protocol callback entry. Reads field2 from TSLOT 0x1337 to locate
    ///         the sub-script inside the callback's calldata, then runs it.
    ///
    /// How it works (Mode B from bot-vm-analysis.md):
    ///   1. Before calling a protocol (e.g. Morpho.flashLoan), the script sets
    ///      field2 = calldata offset where the nested bytes payload starts.
    ///   2. The protocol calls back (onMorphoFlashLoan, unlockCallback, etc.).
    ///   3. This fallback reads field2, extracts the sub-script from msg.data
    ///      at that offset, and runs the VM on it.
    ///
    /// Offset values (from ABI encoding, pre-computed off-chain):
    ///   - onMorphoFlashLoan(uint256, bytes):            field2 = 100
    ///   - unlockCallback(bytes):                        field2 = 68
    ///   - uniswapV3SwapCallback(int256, int256, bytes): field2 = 132
    fallback() external payable {
        (,uint24 field2,) = _loadState();

        if (field2 == 0) return; // no pending callback — empty return

        // field2 points to start of bytes content in msg.data.
        // The ABI-encoded bytes length sits 32 bytes before that.
        uint256 scriptLen;
        uint256 scriptStart = uint256(field2);
        assembly {
            scriptLen := calldataload(sub(scriptStart, 32))
        }

        // Copy sub-script from calldata to memory
        bytes memory script = new bytes(scriptLen);
        assembly {
            calldatacopy(add(script, 32), scriptStart, scriptLen)
        }

        _runVM(script);
    }

    receive() external payable {}

    // ─── VM Loop ──────────────────────────────────────────────────

    /// @dev Execute packed opcode stream. Each opcode is 1 byte followed by
    ///      variable-length parameters. See docs/bot-vm-analysis.md §4.
    function _runVM(bytes memory script) internal {
        uint256 ip = 0; // instruction pointer (avoid 'pc' — reserved in Yul)
        uint256 end = script.length;

        while (ip < end) {
            uint8 op = uint8(script[ip]);
            ip += 1;

            if (op == 0x00) {
                // ── CALL (no value) ──
                // Layout: [addr:20][payload_len:3][payload:N]
                address target = _readAddress(script, ip);
                uint24 payloadLen = _readUint24(script, ip + 20);
                bytes memory payload = _readBytes(script, ip + 23, payloadLen);

                (bool ok,) = target.call(payload);
                require(ok, "call failed");

                ip += 23 + payloadLen;
            }
            else if (op == 0x01) {
                // ── CALL (with value) ──
                // Layout: [addr:20][value:12][payload_len:3][payload:N]
                address target = _readAddress(script, ip);
                uint96 value = _readUint96(script, ip + 20);
                uint24 payloadLen = _readUint24(script, ip + 32);
                bytes memory payload = _readBytes(script, ip + 35, payloadLen);

                (bool ok,) = target.call{value: value}(payload);
                require(ok, "call+value failed");

                ip += 35 + payloadLen;
            }
            else if (op == 0x02) {
                // ── SET_FIELD2 ──
                // Layout: [new_field2:3]
                uint24 newField2 = _readUint24(script, ip);
                (uint8 f1,,) = _loadState();
                _saveState(f1, newField2, 0); // field3 cleared
                ip += 3;
            }
            else if (op == 0x03) {
                // ── RETURN ──
                // Layout: [data_len:3][data:N]
                uint24 dataLen = _readUint24(script, ip);
                uint256 ipLocal = ip; // shadow for assembly
                // Copy return data and halt
                assembly {
                    let dataStart := add(add(script, 32), add(ipLocal, 3))
                    return(dataStart, dataLen)
                }
                // unreachable
            }
            else if (op == 0x04) {
                // ── WETH_UNWRAP ──
                // No params. Unwrap all WETH balance.
                uint256 bal = IERC20(Constants.WETH).balanceOf(address(this));
                if (bal > 0) {
                    (bool ok,) = Constants.WETH.call(
                        abi.encodeWithSignature("withdraw(uint256)", bal)
                    );
                    require(ok, "weth unwrap failed");
                }
            }
            else if (op == 0x05) {
                // ── CLEAR_STATE ──
                // Clear field2 and field3, preserve field1.
                (uint8 f1,,) = _loadState();
                _saveState(f1, 0, 0);
            }
            else if (op == 0x06) {
                // ── SET_FIELD3 ──
                // Layout: [new_field3:3]
                uint24 newField3 = _readUint24(script, ip);
                (uint8 f1,,) = _loadState();
                _saveState(f1, 0, newField3); // field2 cleared
                ip += 3;
            }
            else if (op == 0x07) {
                // ── CLEAR_FIELD1 ──
                // Clear callback_active flag. Preserve field2/field3.
                (,uint24 f2, uint24 f3) = _loadState();
                _saveState(0, f2, f3);
            }
            else if (op == 0x0d) {
                // ── REVERT ──
                // Layout: [data_len:3][data:N]
                uint24 dataLen = _readUint24(script, ip);
                uint256 ipLocal = ip;
                assembly {
                    let dataStart := add(add(script, 32), add(ipLocal, 3))
                    revert(dataStart, dataLen)
                }
                // unreachable
            }
            else {
                revert("invalid opcode");
            }
        }
    }

    // ─── TSLOT 0x1337 State Management ────────────────────────────

    /// @dev Unpack field1 (1B), field2 (3B), field3 (3B) from TSLOT 0x1337.
    ///      Exact replica of the original bot's bit layout.
    function _loadState() internal view returns (uint8 field1, uint24 field2, uint24 field3) {
        uint256 word;
        assembly {
            word := tload(STATE_SLOT)
        }
        field1 = uint8(word >> 248);
        field2 = uint24((word << 8) >> 232);
        field3 = uint24((word << 32) >> 232);
    }

    /// @dev Pack and store fields into TSLOT 0x1337.
    function _saveState(uint8 f1, uint24 f2, uint24 f3) internal {
        uint256 packed = (uint256(f1) << 248) | (uint256(f2) << 224) | (uint256(f3) << 200);
        assembly {
            tstore(STATE_SLOT, packed)
        }
    }

    // ─── Calldata Parsing Helpers ─────────────────────────────────

    /// @dev Read 20-byte address from script at offset.
    function _readAddress(bytes memory script, uint256 offset) internal pure returns (address addr) {
        assembly {
            addr := shr(96, mload(add(add(script, 32), offset)))
        }
    }

    /// @dev Read 3-byte uint24 from script at offset.
    function _readUint24(bytes memory script, uint256 offset) internal pure returns (uint24 val) {
        assembly {
            val := shr(232, mload(add(add(script, 32), offset)))
        }
    }

    /// @dev Read 12-byte uint96 from script at offset.
    function _readUint96(bytes memory script, uint256 offset) internal pure returns (uint96 val) {
        assembly {
            val := shr(160, mload(add(add(script, 32), offset)))
        }
    }

    /// @dev Read N bytes from script at offset.
    function _readBytes(bytes memory script, uint256 offset, uint256 length)
        internal
        pure
        returns (bytes memory result)
    {
        result = new bytes(length);
        assembly {
            let src := add(add(script, 32), offset)
            let dst := add(result, 32)
            // Copy word by word
            for { let i := 0 } lt(i, length) { i := add(i, 32) } {
                mstore(add(dst, i), mload(add(src, i)))
            }
        }
    }

    // ─── Owner Utilities ──────────────────────────────────────────

    function sweep(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) {
            (bool ok,) = token.call(
                abi.encodeWithSelector(IERC20.transfer.selector, owner, bal)
            );
            require(ok, "sweep failed");
        }
    }
}

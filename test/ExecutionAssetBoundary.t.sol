// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";
import {RuntimePaymentToken} from "./RuntimePaymentMocks.sol";

// Test-only protocol; the TypeScript producer supplies current production
// boundary programs. No replica of the boundary is implemented in Solidity.
contract NativeBoundaryExchange {
    RuntimePaymentToken public immutable token;
    uint256 public debt;
    uint256 public output;
    uint256 public extra;
    uint256 public requested;
    constructor(RuntimePaymentToken t) { token = t; }
    function configure(uint256 d, uint256 o, uint256 x) external { debt = d; output = o; extra = x; }
    function exchange(bool nativeInput, uint256 amount) external payable {
        requested = amount;
        if (nativeInput) {
            require(msg.value == amount && debt <= amount, "native call value");
            if (amount > debt) { (bool ok,) = msg.sender.call{value: amount - debt}(""); require(ok); }
            token.mint(msg.sender, output);
        } else {
            require(msg.value == 0, "erc20 call value");
            token.burn(msg.sender, debt + extra);
            (bool ok,) = msg.sender.call{value: output}(""); require(ok);
        }
    }
    receive() external payable {}
}

contract ExecutionAssetBoundaryTest is Test {
    address constant ACTOR = 0x2222222222222222222222222222222222222222;
    address constant TARGET = 0x3333333333333333333333333333333333333333;
    address constant TOKEN = 0x1111111111111111111111111111111111111111;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint256 constant STOCK = 777;
    uint256 constant INPUT = 100;
    function setUp() public {
        vm.etch(ACTOR, address(new BotVM()).code);
        bytes memory code = address(new RuntimePaymentToken()).code;
        vm.etch(WETH, code); vm.etch(TOKEN, code);
        vm.etch(TARGET, address(new NativeBoundaryExchange(RuntimePaymentToken(payable(TOKEN)))).code);
    }
    function prepare(bool nativeInput, uint256 debt, uint256 output, uint256 extra) internal {
        bytes32 slot = keccak256(abi.encode(ACTOR, uint256(0)));
        vm.store(WETH, slot, bytes32(STOCK + (nativeInput ? INPUT : 0)));
        vm.store(TOKEN, slot, bytes32(STOCK + (nativeInput ? 0 : INPUT)));
        vm.deal(ACTOR, STOCK); vm.deal(WETH, 1_000_000); vm.deal(TARGET, 1_000_000);
        NativeBoundaryExchange(payable(TARGET)).configure(debt, output, extra);
    }
    function program(uint256 mode, bool nativeInput) internal view returns (bytes memory) {
        string memory prefix = mode == 0 ? "NATIVE_BOUNDARY_runtime" : mode == 1 ? "NATIVE_BOUNDARY_quoted" : "NATIVE_BOUNDARY_strict";
        return vm.envBytes(string.concat(prefix, nativeInput ? "Input" : "Output"));
    }
    function balances(bool nativeInput, uint256 remaining, uint256 received) internal view {
        assertEq(ACTOR.balance, STOCK, "old native inventory");
        assertEq(RuntimePaymentToken(payable(nativeInput ? WETH : TOKEN)).balanceOf(ACTOR), STOCK + remaining, "input debit");
        assertEq(RuntimePaymentToken(payable(nativeInput ? TOKEN : WETH)).balanceOf(ACTOR), STOCK + received, "actual receipt");
    }
    function testCurrentProductionProgramsBothDirections() public {
        for (uint256 mode; mode < 3; ++mode) for (uint256 direction; direction < 2; ++direction) {
            bool nativeInput = direction == 0; prepare(nativeInput, INPUT, 200, 0);
            BotVM(payable(ACTOR)).execute(program(mode, nativeInput));
            balances(nativeInput, 0, 200);
            assertEq(NativeBoundaryExchange(payable(TARGET)).requested(), INPUT);
        }
    }
    function testPartialInputRefundPreservesInventory() public {
        for (uint256 mode; mode < 3; ++mode) for (uint256 direction; direction < 2; ++direction) {
            bool nativeInput = direction == 0; prepare(nativeInput, 40, 200, 0);
            BotVM(payable(ACTOR)).execute(program(mode, nativeInput));
            balances(nativeInput, 60, 200);
        }
    }
    function testShortOutputRollsBackBothDirections() public {
        for (uint256 mode; mode < 3; ++mode) for (uint256 direction; direction < 2; ++direction) {
            bool nativeInput = direction == 0; prepare(nativeInput, INPUT, 0, 0);
            bytes memory script = program(mode, nativeInput);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(script);
            balances(nativeInput, INPUT, 0);
        }
    }
    function testOldTokenInventoryCannotPayExtraInput() public {
        for (uint256 mode; mode < 3; ++mode) {
            prepare(false, INPUT, 200, 1); bytes memory script = program(mode, false);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(script);
            balances(false, INPUT, 0);
        }
    }
    function testOldNativeInventoryCannotPayExtraInput() public {
        prepare(true, INPUT + 1, 200, 0);
        bytes memory script = vm.envBytes("NATIVE_BOUNDARY_overspendNative");
        vm.expectRevert(); BotVM(payable(ACTOR)).execute(script);
        balances(true, INPUT, 0);
    }
    function testQuotedLiveInputRoundingOffAndOn() public {
        for (uint256 direction; direction < 2; ++direction) {
            bool nativeInput = direction == 0;
            string memory side = nativeInput ? "Input" : "Output";
            bytes memory exact = vm.envBytes(string.concat("NATIVE_BOUNDARY_quoted", side, "Tolerance0"));
            bytes memory rounded = vm.envBytes(string.concat("NATIVE_BOUNDARY_quoted", side, "Tolerance1"));
            prepare(nativeInput, INPUT - 1, 200, 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(exact);
            balances(nativeInput, INPUT, 0);
            BotVM(payable(ACTOR)).execute(rounded);
            balances(nativeInput, 1, 200);
            prepare(nativeInput, INPUT - 2, 200, 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(rounded);
            balances(nativeInput, INPUT, 0);
            prepare(nativeInput, 0, 200, 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(rounded);
            balances(nativeInput, INPUT, 0);
            prepare(nativeInput, INPUT + 1, 200, 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(rounded);
            balances(nativeInput, INPUT, 0);
        }
    }
    function testQuotedOneUnitCannotHaveZeroDebit() public {
        for (uint256 direction; direction < 2; ++direction) {
            bool nativeInput = direction == 0;
            prepare(nativeInput, 0, 200, 0);
            bytes32 slot = keccak256(abi.encode(ACTOR, uint256(0)));
            vm.store(nativeInput ? WETH : TOKEN, slot, bytes32(STOCK + 1));
            bytes memory script = vm.envBytes(string.concat("NATIVE_BOUNDARY_quotedZeroDebit", nativeInput ? "Input" : "Output"));
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(script);
            balances(nativeInput, 1, 0);
        }
    }
}

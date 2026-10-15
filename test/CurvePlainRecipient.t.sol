// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";

contract CurveRecipientToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public badClear;
    function configure(bool bad) external { badClear = bad; }
    function change(address actor, int256 delta) external { balanceOf[actor] = uint256(int256(balanceOf[actor]) + delta); }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function approve(address to, uint256 amount) external returns (bool) {
        allowance[msg.sender][to] = badClear && amount == 0 ? 1 : amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }
}
contract CurveRecipientPool {
    uint256 public fault;
    uint256 public calls;
    function configure(uint256 value) external { fault = value; calls = 0; }
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy) external returns (uint256) { return swap(uint256(uint128(i)), uint256(uint128(j)), dx, minDy, msg.sender, false); }
    function exchange(uint256 i, uint256 j, uint256 dx, uint256 minDy) external returns (uint256) { return swap(i, j, dx, minDy, msg.sender, false); }
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy, address receiver) external returns (uint256) { return swap(uint256(uint128(i)), uint256(uint128(j)), dx, minDy, receiver, false); }
    function exchange(uint256 i, uint256 j, uint256 dx, uint256 minDy, bool useEth, address receiver) external returns (uint256) {
        require(!useEth, "ERC20 mode"); return swap(i, j, dx, minDy, receiver, false);
    }
    function exchange_received(int128 i, int128 j, uint256 dx, uint256 minDy, address receiver) external returns (uint256) { return swap(uint256(uint128(i)), uint256(uint128(j)), dx, minDy, receiver, true); }
    function exchange_received(uint256 i, uint256 j, uint256 dx, uint256 minDy, address receiver) external returns (uint256) { return swap(i, j, dx, minDy, receiver, true); }
    function swap(uint256 i, uint256 j, uint256 dx, uint256 minDy, address receiver, bool received) internal returns (uint256) {
        require(i < 2 && j == 1 - i && dx > 0); calls++;
        CurveRecipientToken input = CurveRecipientToken(address(uint160(83 + i)));
        CurveRecipientToken output = CurveRecipientToken(address(uint160(83 + j)));
        if (!received) input.transferFrom(msg.sender, address(this), dx);
        if (fault == 1) input.change(msg.sender, int256(dx)); // zero net debit
        if (fault == 2) input.change(msg.sender, 1); // one raw unit under-debit
        if (fault == 3) input.change(msg.sender, -1); // old input consumed
        uint256 dy = dx * 2;
        require(dy >= minDy);
        if (fault != 4) output.transfer(fault == 5 ? address(92) : receiver, dy);
        if (fault == 6) output.change(msg.sender, -1);
        if (fault == 7) input.change(receiver, -1);
        if (fault == 8) { (bool ok,) = msg.sender.call{value: 1}(""); require(ok); }
        if (fault == 9) input.configure(true);
        return fault == 10 ? 0 : fault == 11 ? type(uint256).max : dy;
    }
    receive() external payable {}
}
contract CurvePlainRecipientTest is Test {
    address constant ACTOR = address(71);
    address constant TARGET = address(81);
    address constant RECEIVER = address(91);
    uint256 constant STOCK = 777;
    string[4] modes = ["int", "uint", "received", "receivedUint"];
    function setUp() public {
        vm.etch(ACTOR, address(new BotVM()).code);
        bytes memory code = address(new CurveRecipientToken()).code;
        vm.etch(address(83), code); vm.etch(address(84), code);
        vm.etch(TARGET, address(new CurveRecipientPool()).code);
    }
    function token(uint256 i) internal pure returns (CurveRecipientToken) { return CurveRecipientToken(address(uint160(83 + i))); }
    function setBalance(uint256 i, address actor, uint256 amount) internal { vm.store(address(token(i)), keccak256(abi.encode(actor, uint256(0))), bytes32(amount)); }
    function prepare(uint256 i, uint256 amount, uint256 fault) internal {
        for (uint256 k; k < 2; ++k) {
            setBalance(k, ACTOR, STOCK + (k == i ? amount : 0)); setBalance(k, RECEIVER, 109);
            setBalance(k, TARGET, 10000); setBalance(k, address(92), 0);
            token(k).configure(false);
            vm.prank(ACTOR); token(k).approve(TARGET, 0);
        }
        vm.deal(ACTOR, 17); vm.deal(TARGET, 100); vm.deal(RECEIVER, 23);
        CurveRecipientPool(payable(TARGET)).configure(fault);
    }
    function script(uint256 mode, uint256 i, string memory kind, uint256 amount) internal view returns (bytes memory) {
        return vm.envBytes(string.concat("CURVE_RECIPIENT_", modes[mode], "_", vm.toString(i), "_", kind, "_", vm.toString(amount)));
    }
    function run(uint256 mode, uint256 i, string memory kind, uint256 amount) internal { BotVM(payable(ACTOR)).execute(script(mode, i, kind, amount)); }
    function assertBalances(uint256 i, uint256 amount, bool externalRecipient) internal view {
        assertEq(token(i).balanceOf(ACTOR), STOCK);
        assertEq(token(1 - i).balanceOf(ACTOR), STOCK + (externalRecipient ? 0 : amount * 2));
        assertEq(token(i).balanceOf(RECEIVER), 109);
        assertEq(token(1 - i).balanceOf(RECEIVER), 109 + (externalRecipient ? amount * 2 : 0));
        assertEq(token(i).balanceOf(TARGET), 10000 + amount);
        assertEq(token(1 - i).balanceOf(TARGET), 10000 - amount * 2);
        assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23);
    }
    function testBothDirectionsAllModesDefaultSelfAndExternal() public {
        for (uint256 m; m < 4; ++m) for (uint256 i; i < 2; ++i) for (uint256 k; k < 3; ++k) {
            for (uint256 a; a < 2; ++a) {
                uint256 amount = a == 0 ? 1 : 100;
                prepare(i, amount, 0); run(m, i, k == 0 ? "default" : k == 1 ? "self" : "external", amount);
                assertBalances(i, amount, k == 2);
                assertEq(token(i).allowance(ACTOR, TARGET), m < 2 && k == 0 ? type(uint256).max - amount : 0);
            }
        }
    }
    function testDirectRejectsDebitReceiptInventoryAndNativeFaultsAtomically() public {
        for (uint256 m; m < 4; ++m) for (uint256 i; i < 2; ++i) for (uint256 f = 1; f <= 9; ++f) {
            if (m >= 2 && f == 9) continue; // received mode makes no approval
            prepare(i, 100, f); bytes memory program = script(m, i, "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program);
            assertEq(token(i).balanceOf(ACTOR), STOCK + 100); assertEq(token(1 - i).balanceOf(ACTOR), STOCK);
            assertEq(token(i).balanceOf(RECEIVER), 109); assertEq(token(1 - i).balanceOf(RECEIVER), 109);
            assertEq(token(i).balanceOf(TARGET), 10000); assertEq(token(1 - i).balanceOf(TARGET), 10000);
            assertEq(token(i).allowance(ACTOR, TARGET), 0); assertEq(ACTOR.balance, 17);
            assertEq(TARGET.balance, 100); assertEq(CurveRecipientPool(payable(TARGET)).calls(), 0);
        }
    }
    function testDirectZeroInputCannotUseOldInventory() public {
        for (uint256 m; m < 4; ++m) for (uint256 i; i < 2; ++i) {
            prepare(i, 0, 0); bytes memory program = script(m, i, "external", 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program);
            assertEq(token(i).balanceOf(ACTOR), STOCK); assertEq(CurveRecipientPool(payable(TARGET)).calls(), 0);
        }
    }
    function testReturnDataCannotReplaceActualReceipt() public {
        for (uint256 m; m < 4; ++m) for (uint256 i; i < 2; ++i) for (uint256 f = 10; f <= 11; ++f) {
            prepare(i, 100, f); run(m, i, "external", 100); assertBalances(i, 100, true);
            assertEq(token(i).allowance(ACTOR, TARGET), 0);
        }
    }
}


contract CurveRecipientWrapped is CurveRecipientToken {
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}(""); require(ok);
    }
    receive() external payable {}
}
contract CurveNativeRecipientPool {
    uint256 public fault;
    uint256 public calls;
    address constant TOKEN = address(84);
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    function configure(uint256 value) external { fault = value; calls = 0; }
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy) external payable returns (uint256) { return swap(uint256(uint128(i)), uint256(uint128(j)), dx, minDy, msg.sender); }
    function exchange(uint256 i, uint256 j, uint256 dx, uint256 minDy) external payable returns (uint256) { return swap(i, j, dx, minDy, msg.sender); }
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy, address receiver) external payable returns (uint256) { return swap(uint256(uint128(i)), uint256(uint128(j)), dx, minDy, receiver); }
    function exchange(uint256 i, uint256 j, uint256 dx, uint256 minDy, bool useEth, address receiver) external payable returns (uint256) {
        require(useEth, "native mode"); return swap(i, j, dx, minDy, receiver);
    }
    function send(address to, uint256 amount) internal { (bool ok,) = to.call{value: amount}(""); require(ok); }
    function swap(uint256 i, uint256 j, uint256 dx, uint256 minDy, address receiver) internal returns (uint256) {
        require(i < 2 && j == 1 - i && dx > 0); calls++;
        CurveRecipientToken t = CurveRecipientToken(TOKEN);
        if (i == 0) require(msg.value == dx); else { require(msg.value == 0); t.transferFrom(msg.sender, address(this), dx); }
        if (fault == 1 || fault == 2 || fault == 11) {
            uint256 refund = fault == 1 ? 1 : fault == 11 ? 2 : dx;
            if (i == 0) send(msg.sender, refund); else t.transfer(msg.sender, refund);
        }
        if (fault == 3) CurveRecipientToken(i == 0 ? WETH : TOKEN).change(msg.sender, -1);
        uint256 dy = dx * 2; require(dy >= minDy);
        address dest = fault == 5 ? address(92) : receiver;
        if (fault != 4) { if (i == 0) t.transfer(dest, dy); else send(dest, dy); }
        if (fault == 6) CurveRecipientToken(i == 0 ? TOKEN : WETH).change(msg.sender, -1);
        if (fault == 7) CurveRecipientToken(i == 0 ? WETH : TOKEN).change(address(91), -1);
        if (fault == 8) send(msg.sender, 1);
        if (fault == 9) t.configure(true);
        return fault == 10 ? 0 : dy;
    }
    receive() external payable {}
}
contract CurveNativeRecipientTest is Test {
    address constant ACTOR = address(71);
    address constant TARGET = address(81);
    address constant RECEIVER = address(91);
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint256 constant STOCK = 777;
    string[3] modes = ["nativeInt", "nativeUint", "nativeLegacy"];
    function setUp() public {
        vm.etch(ACTOR, address(new BotVM()).code);
        vm.etch(WETH, address(new CurveRecipientWrapped()).code);
        vm.etch(address(84), address(new CurveRecipientToken()).code);
        vm.etch(TARGET, address(new CurveNativeRecipientPool()).code);
    }
    function token(uint256 i) internal pure returns (CurveRecipientToken) { return CurveRecipientToken(i == 0 ? WETH : address(84)); }
    function setBalance(uint256 i, address actor, uint256 amount) internal { vm.store(address(token(i)), keccak256(abi.encode(actor, uint256(0))), bytes32(amount)); }
    function prepare(uint256 i, uint256 amount, uint256 fault) internal {
        for (uint256 k; k < 2; ++k) {
            setBalance(k, ACTOR, STOCK + (k == i ? amount : 0)); setBalance(k, RECEIVER, 109);
            setBalance(k, TARGET, 10000); setBalance(k, address(92), 0); token(k).configure(false);
            vm.prank(ACTOR); token(k).approve(TARGET, 0);
        }
        vm.deal(ACTOR, 17); vm.deal(TARGET, 10000); vm.deal(RECEIVER, 23); vm.deal(address(92), 0); vm.deal(WETH, 10000);
        CurveNativeRecipientPool(payable(TARGET)).configure(fault);
    }
    function script(uint256 m, uint256 i, string memory kind, uint256 amount) internal view returns (bytes memory) {
        return vm.envBytes(string.concat("CURVE_RECIPIENT_", modes[m], "_", vm.toString(i), "_", kind, "_", vm.toString(amount)));
    }
    function testNativeDefaultSelfExternalAndLegacyOutputUseCommonBoundary() public {
        for (uint256 m; m < 3; ++m) for (uint256 i; i < 2; ++i) for (uint256 k; k < 3; ++k) {
            if (m == 2 && i == 0 && k != 0) continue;
            for (uint256 a; a < 2; ++a) {
                uint256 amount = a == 0 ? 1 : 100; prepare(i, amount, 0);
                BotVM(payable(ACTOR)).execute(script(m, i, k == 0 ? "default" : k == 1 ? "self" : "external", amount));
                assertEq(token(i).balanceOf(ACTOR), STOCK);
                assertEq(token(1 - i).balanceOf(ACTOR), STOCK + (k == 2 ? 0 : amount * 2));
                assertEq(token(i).balanceOf(RECEIVER), 109);
                assertEq(token(1 - i).balanceOf(RECEIVER), 109 + (k == 2 ? amount * 2 : 0));
                assertEq(token(1).allowance(ACTOR, TARGET), 0); assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23);
                assertEq(TARGET.balance, i == 0 ? 10000 + amount : 10000 - amount * 2);
            }
        }
    }
    function testNativeDirectRejectsFaultsAndRollsBack() public {
        for (uint256 m; m < 3; ++m) for (uint256 i; i < 2; ++i) for (uint256 f = 1; f <= 9; ++f) {
            if (m == 2 && i == 0 || i == 0 && f == 9 || i == 1 && (f == 8 || f == 1)) continue;
            // Extra native output is real measured receipt, not a debit/refund error.
            prepare(i, 100, f); bytes memory program = script(m, i, "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program);
            assertEq(token(i).balanceOf(ACTOR), STOCK + 100); assertEq(token(1 - i).balanceOf(ACTOR), STOCK);
            assertEq(token(i).balanceOf(RECEIVER), 109); assertEq(token(1 - i).balanceOf(RECEIVER), 109);
            assertEq(token(1).allowance(ACTOR, TARGET), 0); assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23);
            assertEq(TARGET.balance, 10000); assertEq(CurveNativeRecipientPool(payable(TARGET)).calls(), 0);
        }
    }
    function testTokenInputRoundingHasExplicitZeroOneBoundaryAndPositiveDebit() public {
        for (uint256 m; m < 3; ++m) for (uint256 k; k < 2; ++k) {
            string memory kind = k == 0 ? "self" : "external";
            prepare(1, 100, 1); BotVM(payable(ACTOR)).execute(script(m, 1, kind, 100));
            assertEq(token(1).balanceOf(ACTOR), STOCK + 1);
            assertEq(token(0).balanceOf(ACTOR), STOCK + (k == 0 ? 200 : 0));
            assertEq(token(0).balanceOf(RECEIVER), uint256(109) + (k == 1 ? 200 : 0));
            assertEq(token(1).allowance(ACTOR, TARGET), 0); assertEq(ACTOR.balance, 17);
            prepare(1, 100, 1); vm.expectRevert();
            BotVM(payable(ACTOR)).execute(script(m, 1, string.concat(kind, "Strict"), 100));
            prepare(1, 100, 11); vm.expectRevert(); BotVM(payable(ACTOR)).execute(script(m, 1, kind, 100));
            prepare(1, 1, 1); vm.expectRevert(); BotVM(payable(ACTOR)).execute(script(m, 1, kind, 1));
            assertEq(token(1).balanceOf(ACTOR), STOCK + 1); assertEq(token(0).balanceOf(ACTOR), STOCK);
            assertEq(token(0).balanceOf(RECEIVER), 109); assertEq(token(1).allowance(ACTOR, TARGET), 0);
            assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23);
        }
    }
    function testNativeDirectZeroAndIgnoredReturnData() public {
        for (uint256 m; m < 3; ++m) for (uint256 i; i < 2; ++i) {
            if (m == 2 && i == 0) continue;
            prepare(i, 0, 0); bytes memory program = script(m, i, "external", 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program);
            assertEq(CurveNativeRecipientPool(payable(TARGET)).calls(), 0);
            prepare(i, 100, 10); BotVM(payable(ACTOR)).execute(script(m, i, "external", 100));
            assertEq(token(i).balanceOf(ACTOR), STOCK); assertEq(token(1 - i).balanceOf(RECEIVER), 309);
        }
    }
}

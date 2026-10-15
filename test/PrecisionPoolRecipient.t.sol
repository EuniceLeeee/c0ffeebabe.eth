// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";
import {CurveRecipientToken, CurveNativeRecipientPool} from "./CurvePlainRecipient.t.sol";

// Only the real PrecisionPool ABI is reused. This pool/token state is synthetic.
contract PrecisionRecipientPool is CurveNativeRecipientPool {
    function hook() external view returns (address) { return fault == 11 ? address(1) : address(0); }
    function creatorFeeBps() external view returns (uint256) { return fault == 12 ? 1 : 0; }
    function swapExactIn(address tokenIn, uint256 amount, uint256 minimum, address recipient) external payable returns (uint256) {
        require(tokenIn == address(0) || tokenIn == address(84));
        uint256 i = tokenIn == address(0) ? 0 : 1;
        uint256 result = super.swap(i, 1 - i, amount, minimum, recipient);
        if (fault == 13) send(address(91), 1);
        return result;
    }
}
contract PrecisionRecipientWrapped is CurveRecipientToken {
    bool public shortWrap;
    function configureWrap(bool value) external { shortWrap = value; }
    function deposit() external payable { balanceOf[msg.sender] += msg.value - (shortWrap && msg.value > 0 ? 1 : 0); }
    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}(""); require(ok);
    }
    receive() external payable {}
}
contract PrecisionBalanceReader {
    function getEthBalance(address account) external view returns (uint256) { return account.balance; }
}
contract PrecisionPoolRecipientTest is Test {
    address constant ACTOR = address(71);
    address constant TARGET = address(81);
    address constant RECEIVER = address(91);
    address constant MULTICALL = 0xcA11bde05977b3631167028862bE2a173976CA11;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint256 constant STOCK = 777;
    function setUp() public {
        vm.etch(ACTOR, address(new BotVM()).code);
        vm.etch(TARGET, address(new PrecisionRecipientPool()).code);
        vm.etch(MULTICALL, address(new PrecisionBalanceReader()).code);
        vm.etch(WETH, address(new PrecisionRecipientWrapped()).code);
        vm.etch(address(84), address(new CurveRecipientToken()).code);
    }
    function token(uint256 i) internal pure returns (CurveRecipientToken) { return CurveRecipientToken(i == 0 ? WETH : address(84)); }
    function setBalance(uint256 i, address account, uint256 amount) internal {
        vm.store(address(token(i)), keccak256(abi.encode(account, uint256(0))), bytes32(amount));
    }
    function prepare(uint256 i, uint256 amount, uint256 fault) internal {
        for (uint256 k; k < 2; ++k) {
            setBalance(k, ACTOR, STOCK + (k == i ? amount : 0)); setBalance(k, RECEIVER, 109);
            setBalance(k, TARGET, 10000); setBalance(k, address(92), 0); token(k).configure(false);
            vm.prank(ACTOR); token(k).approve(TARGET, 0);
        }
        vm.deal(ACTOR, 17); vm.deal(RECEIVER, 23); vm.deal(TARGET, 10000); vm.deal(address(92), 0); vm.deal(WETH, 10000);
        PrecisionRecipientWrapped(payable(WETH)).configureWrap(false);
        PrecisionRecipientPool(payable(TARGET)).configure(fault);
    }
    function script(uint256 i, string memory kind, uint256 amount) internal view returns (bytes memory) {
        return vm.envBytes(string.concat("PRECISION_RECIPIENT_", vm.toString(i), "_", kind, "_", vm.toString(amount)));
    }
    function assertUnchanged(uint256 i, uint256 amount) internal view {
        for (uint256 k; k < 2; ++k) {
            assertEq(token(k).balanceOf(ACTOR), STOCK + (k == i ? amount : 0));
            assertEq(token(k).balanceOf(RECEIVER), 109); assertEq(token(k).balanceOf(TARGET), 10000);
            assertEq(token(k).balanceOf(address(92)), 0); assertEq(token(k).allowance(ACTOR, TARGET), 0);
            assertFalse(token(k).badClear());
        }
        assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23); assertEq(TARGET.balance, 10000);
        assertEq(WETH.balance, 10000); assertEq(address(92).balance, 0);
        assertEq(PrecisionRecipientPool(payable(TARGET)).calls(), 0);
    }
    function testDefaultQuotedSelfExternalBothNativeDirections() public {
        for (uint256 i; i < 2; ++i) for (uint256 k; k < 4; ++k) for (uint256 a; a < 2; ++a) {
            uint256 amount = a == 0 ? 1 : 100; prepare(i, amount, 0);
            string memory kind = k == 0 ? "default" : k == 1 ? "quoted" : k == 2 ? "self" : "external";
            BotVM(payable(ACTOR)).execute(script(i, kind, amount));
            assertEq(token(i).balanceOf(ACTOR), STOCK);
            assertEq(token(1 - i).balanceOf(ACTOR), STOCK + (k == 3 ? 0 : amount * 2));
            assertEq(token(i).balanceOf(RECEIVER), 109);
            assertEq(token(1 - i).balanceOf(RECEIVER), 109 + (k == 3 ? amount * 2 : 0));
            assertEq(token(1).allowance(ACTOR, TARGET), i == 1 && k < 2 ? type(uint256).max - amount : 0);
            assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23);
            assertEq(TARGET.balance, i == 0 ? 10000 + amount : 10000 - amount * 2);
            assertEq(PrecisionRecipientPool(payable(TARGET)).calls(), 1);
        }
    }
    function testDirectFaultsRollbackEveryObservedBalanceAndAllowance() public {
        for (uint256 i; i < 2; ++i) for (uint256 fault = 1; fault <= 13; ++fault) {
            if (i == 0 && fault == 9 || i == 1 && fault == 13) continue;
            // The raw native-output program cannot observe the original external
            // graph receiver's ETH; common boundary only promises WETH delivery.
            prepare(i, 100, fault); bytes memory program = script(i, "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program); assertUnchanged(i, 100);
        }
    }
    function testZeroAndUnfundedDoNotConsumeOldInventory() public {
        for (uint256 i; i < 2; ++i) {
            prepare(i, 0, 0); bytes memory zero = script(i, "external", 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(zero); assertUnchanged(i, 0);
            prepare(i, 100, 0); setBalance(i, ACTOR, 0); bytes memory unfunded = script(i, "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(unfunded);
            assertEq(token(i).balanceOf(ACTOR), 0);
            setBalance(i, ACTOR, STOCK + 100); assertUnchanged(i, 100);
        }
    }
    function testDirectTemporaryApprovalAndShortWrap() public {
        prepare(1, 100, 0); vm.prank(ACTOR); token(1).approve(TARGET, 73);
        BotVM(payable(ACTOR)).execute(script(1, "external", 100)); assertEq(token(1).allowance(ACTOR, TARGET), 0);
        prepare(1, 100, 0); PrecisionRecipientWrapped(payable(WETH)).configureWrap(true);
        bytes memory shortWrap = script(1, "external", 100);
        vm.expectRevert(); BotVM(payable(ACTOR)).execute(shortWrap); assertUnchanged(1, 100);
        assertTrue(PrecisionRecipientWrapped(payable(WETH)).shortWrap());
    }
}

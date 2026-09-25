// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./LocalExecution.sol";

interface NativeResidualVm {
    function deal(address account, uint256 balance) external;
    function etch(address account, bytes calldata code) external;
    function envBytes(string calldata name) external view returns (bytes memory);
}

// Entirely in-process Foundry fixtures: no RPC, fork, network or transaction
// submission. The scripts come from the production TypeScript Family encoder.
// Regression for wrapping actual native receipts without using old inventory.
contract UniV1NativeResidualTest {
    NativeResidualVm private constant vm = NativeResidualVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant POOL = 0x1000000000000000000000000000000000000001;
    address private constant TOKEN = 0x1000000000000000000000000000000000000002;
    address private constant ISSUER = 0x1000000000000000000000000000000000000004;
    address private constant EXECUTOR = 0x1000000000000000000000000000000000000005;
    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint256 private constant INPUT = 1e16;
    uint256 private constant LOW_QUOTE = 19920056031912;
    uint256 private constant ACTUAL = 19920056031913;
    uint256 private constant OLD_NATIVE = 7 ether;
    uint256 private constant OLD_WETH = 11 ether;
    uint256 private constant OLD_TOKEN = 500 ether;
    BotVM private bot;
    LocalToken private token;
    LocalWeth private weth;

    event ResidualEvidence(uint256 quote, uint256 actual, uint256 wrapped, uint256 nativeResidual);

    function setUp() public {
        vm.etch(TOKEN, type(LocalToken).runtimeCode);
        vm.etch(WETH, type(LocalWeth).runtimeCode);
        token = LocalToken(TOKEN);
        weth = LocalWeth(payable(WETH));
        LocalExchange model = new LocalExchange(token, payable(ISSUER));
        vm.etch(POOL, address(model).code);
        BotVM deployed = new BotVM();
        vm.etch(EXECUTOR, address(deployed).code);
        bot = BotVM(payable(EXECUTOR));
        // A controlled reserve change makes the real model output exactly one
        // wei above the quote from the original 100 ETH reserve fixture.
        vm.deal(POOL, 100 ether + 1_000_000);
        vm.deal(WETH, 10_000 ether);
        vm.deal(EXECUTOR, OLD_NATIVE);
        token.mint(POOL, 50_000 ether);
        token.mint(EXECUTOR, OLD_TOKEN);
        weth.mint(EXECUTOR, OLD_WETH);
    }

    function assertInputSplit() private view {
        uint256 fee = (INPUT + 999) / 1000;
        require(token.balanceOf(EXECUTOR) == OLD_TOKEN - INPUT, "wrong gross input delta");
        require(token.balanceOf(ISSUER) == fee, "wrong issuer token fee");
        require(token.balanceOf(POOL) == 50_000 ether + INPUT - fee, "wrong pool input delta");
    }

    function testExactQuoteLeavesNoNativeResidual() public {
        uint256 poolBefore = POOL.balance;
        bot.execute(vm.envBytes("UNIV1_RESIDUAL_EXACT_SCRIPT"));
        uint256 actual = poolBefore - POOL.balance;
        require(actual == ACTUAL, "unexpected independent native payout");
        require(EXECUTOR.balance == OLD_NATIVE, "native residual or inventory subsidy");
        require(weth.balanceOf(EXECUTOR) - OLD_WETH == actual, "wrong wrapped output");
        assertInputSplit();
    }

    function testUnderquoteWrapsExtraWeiWithoutResidual() public {
        uint256 poolBefore = POOL.balance;
        // Production action succeeds; its minimum is a lower bound only.
        bot.execute(vm.envBytes("UNIV1_RESIDUAL_LOW_SCRIPT"));
        uint256 actual = poolBefore - POOL.balance;
        uint256 wrapped = weth.balanceOf(EXECUTOR) - OLD_WETH;
        uint256 residual = EXECUTOR.balance - OLD_NATIVE;
        require(actual == ACTUAL && wrapped == ACTUAL, "wrong independent output deltas");
        require(residual == 0 && actual == wrapped, "one-wei native residual");
        require(wrapped == LOW_QUOTE + 1, "extra receipt not wrapped");
        assertInputSplit();
        emit ResidualEvidence(LOW_QUOTE, actual, wrapped, residual);
    }

    function testOverquoteRevertsWithoutSpendingOldNative() public {
        uint256 poolBefore = POOL.balance;
        (bool ok,) = address(bot).call(abi.encodeCall(BotVM.execute, (vm.envBytes("UNIV1_RESIDUAL_HIGH_SCRIPT"))));
        require(!ok, "overstated minimum must revert");
        require(EXECUTOR.balance == OLD_NATIVE && POOL.balance == poolBefore, "native changed on revert");
        require(weth.balanceOf(EXECUTOR) == OLD_WETH, "WETH changed on revert");
        require(token.balanceOf(EXECUTOR) == OLD_TOKEN && token.balanceOf(ISSUER) == 0, "tokens changed on revert");
    }

    function testOneUnitShortAllowedByExecutionMinimum() public {
        uint256 poolBefore = POOL.balance;
        bot.execute(vm.envBytes("UNIV1_RESIDUAL_HIGH_TOLERATED_SCRIPT"));
        uint256 actual = poolBefore - POOL.balance;
        require(actual == ACTUAL, "wrong independent native payout");
        require(EXECUTOR.balance == OLD_NATIVE, "native residual or inventory subsidy");
        require(weth.balanceOf(EXECUTOR) - OLD_WETH == actual, "must wrap actual not higher quote");
        assertInputSplit();
    }
}

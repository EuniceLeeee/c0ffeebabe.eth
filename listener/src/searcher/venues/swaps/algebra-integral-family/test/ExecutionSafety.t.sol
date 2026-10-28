// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BotVM} from "src/BotVM.sol";

interface AlgebraSafetyVm {
    function ffi(string[] calldata) external returns (bytes memory);
    function toString(address) external pure returns (string memory);
    function toString(uint256) external pure returns (string memory);
}
interface AlgebraSafetyCallback {
    function algebraSwapCallback(int256, int256, bytes calldata) external;
}

// Synthetic protocol only. No replacement executor/interpreter and no fork/RPC.
contract AlgebraSafetyToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function burn(address from, uint256 amount) external { balanceOf[from] -= amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
}
contract AlgebraSafetyHook {
    uint256 public beforeCalls;
    uint256 public afterCalls;
    function beforeSwap() external { beforeCalls++; }
    function afterSwap(bool reject) external { afterCalls++; require(!reject, "after hook failed"); }
}
contract AlgebraSafetyForeignCallback {
    function invoke(address bot, int256 amount0, int256 amount1, bytes calldata data) external {
        AlgebraSafetyCallback(bot).algebraSwapCallback(amount0, amount1, data);
    }
}
contract AlgebraSafetyPool {
    enum Mode { Normal, Partial, LieAboutDebit, WrongReturn, ExcessDebt, ShortOutput,
        NoOutput, ExtraDebit, AfterHookFailure, ForeignCallback, ChangedCallback,
        MissingCallback, DoubleCallback, NegativeReturn, BurnOldOutput }
    AlgebraSafetyToken public immutable token0;
    AlgebraSafetyToken public immutable token1;
    AlgebraSafetyHook public immutable hook;
    AlgebraSafetyForeignCallback public immutable foreignCallback;
    Mode public mode;
    uint256 public calls;

    constructor(AlgebraSafetyToken a, AlgebraSafetyToken b, AlgebraSafetyHook h) {
        token0 = a; token1 = b; hook = h; foreignCallback = new AlgebraSafetyForeignCallback();
    }
    function configure(Mode value) external { mode = value; }
    function swap(address recipient, bool zeroToOne, int256 amountRequired, uint160, bytes calldata data)
        external returns (int256 amount0, int256 amount1)
    {
        require(amountRequired > 0, "only exact input");
        calls++; hook.beforeSwap();
        uint256 input = uint256(amountRequired);
        uint256 debt = mode == Mode.Partial || mode == Mode.LieAboutDebit ? input - 1 : input;
        if (mode == Mode.ExcessDebt) debt++;
        uint256 nominalOutput = 2 * input;
        uint256 paid = mode == Mode.ShortOutput ? nominalOutput - 1 : nominalOutput;
        if (mode == Mode.Partial) paid = 2 * debt;
        if (mode == Mode.NoOutput || mode == Mode.BurnOldOutput) paid = 0;
        AlgebraSafetyToken inToken = zeroToOne ? token0 : token1;
        AlgebraSafetyToken outToken = zeroToOne ? token1 : token0;
        outToken.transfer(recipient, paid);
        int256 debit = int256(debt); int256 credit = -int256(nominalOutput);
        (amount0, amount1) = zeroToOne ? (debit, credit) : (credit, debit);
        if (mode == Mode.ForeignCallback) {
            foreignCallback.invoke(msg.sender, amount0, amount1, data);
        } else if (mode != Mode.MissingCallback) {
            bytes memory callbackData = data;
            if (mode == Mode.ChangedCallback) callbackData[callbackData.length - 1] ^= bytes1(uint8(1));
            AlgebraSafetyCallback(msg.sender).algebraSwapCallback(amount0, amount1, callbackData);
            if (mode == Mode.DoubleCallback)
                AlgebraSafetyCallback(msg.sender).algebraSwapCallback(amount0, amount1, callbackData);
        }
        if (mode == Mode.ExtraDebit) inToken.burn(msg.sender, 1);
        if (mode == Mode.BurnOldOutput) outToken.burn(recipient, 1);
        // The pool is allowed to lie. Family checks must not trust this return
        // instead of independent executor balances.
        int256 returnedInput = mode == Mode.Partial || mode == Mode.WrongReturn ? int256(input - 1) : int256(input);
        if (mode == Mode.NegativeReturn) returnedInput = -1;
        (amount0, amount1) = zeroToOne ? (returnedInput, credit) : (credit, returnedInput);
        hook.afterSwap(mode == Mode.AfterHookFailure);
    }
}
contract AlgebraSafetyReturnPool {
    uint256 public received;
    function swap(AlgebraSafetyToken tokenIn, AlgebraSafetyToken tokenOut, uint256 amount) external {
        received = amount;
        tokenIn.burn(msg.sender, amount);
        tokenOut.mint(msg.sender, amount);
    }
}

contract AlgebraExecutionSafetyTest {
    AlgebraSafetyVm constant vm = AlgebraSafetyVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant STOCK = 1e12;
    BotVM bot;
    AlgebraSafetyToken token0;
    AlgebraSafetyToken token1;
    AlgebraSafetyHook hook;
    AlgebraSafetyPool pool;
    AlgebraSafetyReturnPool returnPool;

    function setUp() public {
        bot = new BotVM();
        AlgebraSafetyToken a = new AlgebraSafetyToken(); AlgebraSafetyToken b = new AlgebraSafetyToken();
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        hook = new AlgebraSafetyHook(); pool = new AlgebraSafetyPool(token0, token1, hook);
        returnPool = new AlgebraSafetyReturnPool();
        token0.mint(address(bot), STOCK); token1.mint(address(bot), STOCK);
        token0.mint(address(pool), STOCK); token1.mint(address(pool), STOCK);
    }
    function script(string memory mode, uint256 amount, uint256 minimum, uint256 direction) internal returns (bytes memory) {
        string[] memory args = new string[](13);
        args[0] = "node"; args[1] = "listener/node_modules/tsx/dist/cli.mjs";
        args[2] = "listener/src/searcher/venues/swaps/algebra-integral-family/test/execution-evm-program.ts";
        args[3] = mode; args[4] = vm.toString(address(pool)); args[5] = vm.toString(address(token0));
        args[6] = vm.toString(address(token1)); args[7] = vm.toString(address(bot)); args[8] = vm.toString(address(returnPool));
        args[9] = vm.toString(amount); args[10] = vm.toString(minimum); args[11] = vm.toString(direction);
        args[12] = vm.toString(tx.origin);
        return vm.ffi(args);
    }
    function assertAtomicFailure(bytes memory code) internal {
        uint256[4] memory beforeBalances = [token0.balanceOf(address(bot)), token1.balanceOf(address(bot)),
            token0.balanceOf(address(pool)), token1.balanceOf(address(pool))];
        uint256 beforeCalls = pool.calls(); uint256 beforeHook = hook.beforeCalls(); uint256 afterHook = hook.afterCalls();
        (bool ok,) = address(bot).call(abi.encodeCall(BotVM.execute, (code)));
        require(!ok, "unsafe swap accepted");
        require(token0.balanceOf(address(bot)) == beforeBalances[0] && token1.balanceOf(address(bot)) == beforeBalances[1], "executor rollback");
        require(token0.balanceOf(address(pool)) == beforeBalances[2] && token1.balanceOf(address(pool)) == beforeBalances[3], "pool rollback");
        require(pool.calls() == beforeCalls && hook.beforeCalls() == beforeHook && hook.afterCalls() == afterHook, "hook/call rollback");
        require(returnPool.received() == 0, "next hop was not rolled back");
    }
    function checkFullPayment(string memory mode) internal {
        for (uint256 direction; direction < 2; direction++) {
            AlgebraSafetyToken input = direction == 0 ? token0 : token1;
            AlgebraSafetyToken output = direction == 0 ? token1 : token0;
            for (uint256 amount = 11; amount <= 110; amount *= 10) {
                uint256 beforeIn = input.balanceOf(address(bot)); uint256 beforeOut = output.balanceOf(address(bot));
                uint256 poolIn = input.balanceOf(address(pool)); uint256 poolOut = output.balanceOf(address(pool));
                bot.execute(script(mode, amount, 2 * amount, direction));
                require(input.balanceOf(address(bot)) == beforeIn - amount && input.balanceOf(address(pool)) == poolIn + amount, "full input payment");
                require(output.balanceOf(address(bot)) == beforeOut + 2 * amount && output.balanceOf(address(pool)) == poolOut - 2 * amount, "actual output receipt");
                require(hook.afterCalls() == pool.calls(), "after hook not executed");
            }
        }
    }
    function testQuotedFullPaymentBothDirectionsAndAmounts() public { checkFullPayment("quoted"); }
    function testRuntimeFullPaymentBothDirectionsAndAmounts() public { checkFullPayment("runtime"); }
    function testQuoterEvidenceFullPaymentBothDirectionsAndAmounts() public { checkFullPayment("quoted-quoter"); }
    function testQuoterRuntimeFullPaymentBothDirectionsAndAmounts() public { checkFullPayment("runtime-quoter"); }
    function testQuoterEvidenceDoesNotProveSettlementOrHookSuccess() public {
        AlgebraSafetyPool.Mode[5] memory modes = [AlgebraSafetyPool.Mode.Partial,
            AlgebraSafetyPool.Mode.LieAboutDebit, AlgebraSafetyPool.Mode.WrongReturn,
            AlgebraSafetyPool.Mode.ShortOutput, AlgebraSafetyPool.Mode.AfterHookFailure];
        for (uint256 direction; direction < 2; direction++) {
            bytes memory lowMinimum = script("quoted-quoter", 11, 1, direction);
            bytes memory fullMinimum = script("quoted-quoter", 11, 22, direction);
            for (uint256 i; i < modes.length; i++) {
                pool.configure(modes[i]);
                assertAtomicFailure(i == 3 ? fullMinimum : lowMinimum);
            }
        }
    }
    function testQuoterRuntimeCentralFlowStillUsesActualOutput() public {
        pool.configure(AlgebraSafetyPool.Mode.ShortOutput);
        uint256 oldOutput = token1.balanceOf(address(bot));
        bot.execute(script("flow-quoter", 11, 1, 0));
        require(returnPool.received() == 21, "Quoter runtime nominal output used");
        require(token1.balanceOf(address(bot)) == oldOutput, "Quoter runtime consumed stock");
    }
    function testPartialFillsRevertBothInterfacesAndDirections() public {
        pool.configure(AlgebraSafetyPool.Mode.Partial);
        for (uint256 direction; direction < 2; direction++) {
            // Low minimum isolates input-consumption from the output floor.
            assertAtomicFailure(script("quoted", 11, 1, direction));
            assertAtomicFailure(script("runtime", 11, 1, direction));
        }
    }
    function testReturnedFullInputCannotHideSmallerActualDebit() public {
        pool.configure(AlgebraSafetyPool.Mode.LieAboutDebit);
        for (uint256 direction; direction < 2; direction++) {
            assertAtomicFailure(script("quoted", 11, 22, direction));
            assertAtomicFailure(script("runtime", 11, 1, direction));
        }
    }
    function testWrongSignedReturnAndExtraDebitRevertAtomically() public {
        AlgebraSafetyPool.Mode[3] memory modes = [AlgebraSafetyPool.Mode.WrongReturn,
            AlgebraSafetyPool.Mode.NegativeReturn, AlgebraSafetyPool.Mode.ExtraDebit];
        for (uint256 direction; direction < 2; direction++) {
            bytes memory quoted = script("quoted", 11, 22, direction); bytes memory runtime = script("runtime", 11, 1, direction);
            for (uint256 i; i < modes.length; i++) {
                pool.configure(modes[i]); assertAtomicFailure(quoted); assertAtomicFailure(runtime);
            }
        }
    }
    function testQuotedMinimumUsesDeltaNotOldOutputStockOrNominalReturn() public {
        for (uint256 direction; direction < 2; direction++) {
            pool.configure(AlgebraSafetyPool.Mode.ShortOutput);
            assertAtomicFailure(script("quoted", 11, 22, direction));
            AlgebraSafetyToken output = direction == 0 ? token1 : token0;
            uint256 beforeOut = output.balanceOf(address(bot));
            bot.execute(script("quoted", 11, 21, direction));
            require(output.balanceOf(address(bot)) == beforeOut + 21, "minimum boundary");
        }
    }
    function testQuotedRejectsMissingOutputAndBurnOfOldInventory() public {
        bytes memory quoted = script("quoted", 11, 22, 0);
        pool.configure(AlgebraSafetyPool.Mode.NoOutput); assertAtomicFailure(quoted);
        pool.configure(AlgebraSafetyPool.Mode.BurnOldOutput); assertAtomicFailure(quoted);
    }
    function testCentralFlowPassesOnlyActualOutputWithoutExactOrOldStock() public {
        pool.configure(AlgebraSafetyPool.Mode.ShortOutput);
        for (uint256 direction; direction < 2; direction++) {
            AlgebraSafetyToken input = direction == 0 ? token0 : token1;
            AlgebraSafetyToken output = direction == 0 ? token1 : token0;
            for (uint256 amount = 11; amount <= 110; amount *= 10) {
                uint256 beforeIn = input.balanceOf(address(bot)); uint256 beforeOut = output.balanceOf(address(bot));
                bot.execute(script("flow", amount, 1, direction));
                require(returnPool.received() == 2 * amount - 1, "next hop must receive actual delta");
                require(output.balanceOf(address(bot)) == beforeOut, "old output inventory consumed");
                require(input.balanceOf(address(bot)) == beforeIn - amount + 2 * amount - 1, "flow conservation");
            }
        }
    }
    function testCentralFlowRejectsZeroReceiptAndPartialInput() public {
        bytes memory flow = script("flow", 11, 1, 0);
        pool.configure(AlgebraSafetyPool.Mode.NoOutput); assertAtomicFailure(flow);
        pool.configure(AlgebraSafetyPool.Mode.Partial); assertAtomicFailure(flow);
    }
    function testCallbackDebtCapAuthenticationAndSingleUseRemainEnforced() public {
        AlgebraSafetyPool.Mode[5] memory modes = [AlgebraSafetyPool.Mode.ExcessDebt, AlgebraSafetyPool.Mode.ForeignCallback,
            AlgebraSafetyPool.Mode.ChangedCallback, AlgebraSafetyPool.Mode.MissingCallback, AlgebraSafetyPool.Mode.DoubleCallback];
        bytes memory runtime = script("runtime", 11, 1, 0); bytes memory quoted = script("quoted", 11, 22, 0);
        for (uint256 i; i < modes.length; i++) {
            pool.configure(modes[i]); assertAtomicFailure(runtime); assertAtomicFailure(quoted);
        }
    }
    function testAfterHookFailureRollsBackBothInterfacesAndFlow() public {
        pool.configure(AlgebraSafetyPool.Mode.AfterHookFailure);
        assertAtomicFailure(script("quoted", 11, 22, 0));
        assertAtomicFailure(script("runtime", 11, 1, 0));
        assertAtomicFailure(script("flow", 11, 1, 0));
    }
    function testInsufficientFundsAndSignedUpperBoundRevert() public {
        token0.burn(address(bot), STOCK - 10);
        assertAtomicFailure(script("quoted", 11, 22, 0));
        assertAtomicFailure(script("runtime", 11, 1, 0));
        assertAtomicFailure(script("runtime", uint256(1) << 255, 1, 0));
    }
}

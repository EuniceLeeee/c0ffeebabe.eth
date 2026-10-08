// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {BotVM} from "src/BotVM.sol";

// Synthetic Vault/tokens test real Family-emitted calldata and BotVM. This is
// not deployed Balancer code, strict, historical replay or profitable EV.
contract BalancerV2RuntimeToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failClearAfterSpend;
    bool public spent;
    uint256 public approvalMode;
    function mint(address who, uint256 n) external { balanceOf[who] += n; }
    function burn(address who, uint256 n) external { balanceOf[who] -= n; }
    function seedAllowance(address who, address spender, uint256 n) external { allowance[who][spender] = n; }
    function configure(bool flag) external { failClearAfterSpend = flag; }
    function configureApproval(uint256 n) external { approvalMode = n; }
    function approve(address spender, uint256 n) external returns (bool) {
        if (approvalMode == 1 || (approvalMode == 2 && spent && n == 0)) return false;
        require(n == 0 || allowance[msg.sender][spender] == 0, "zero-first");
        require(!(n == 0 && spent && failClearAfterSpend), "clear failed");
        allowance[msg.sender][spender] = n;
        if (approvalMode == 3) { assembly { return(0, 0) } }
        return true;
    }
    function transferFrom(address from, address to, uint256 n) external returns (bool) {
        allowance[from][msg.sender] -= n; balanceOf[from] -= n; balanceOf[to] += n; spent = true; return true;
    }
}
contract BalancerV2RuntimeVault {
    struct SingleSwap { bytes32 poolId; uint8 kind; address assetIn; address assetOut; uint256 amount; bytes userData; }
    struct Funds { address sender; bool fromInternalBalance; address recipient; bool toInternalBalance; }
    uint256 public mode;
    uint256 public calls;
    uint256 public received;
    function configure(uint256 n) external { mode = n; }
    function swap(SingleSwap calldata s, Funds calldata f, uint256 limit, uint256 deadline) external payable returns (uint256) {
        require(msg.value == 0 && s.poolId != 0 && s.kind == 0 && s.amount > 0 && s.userData.length == 0, "swap shape");
        require(f.sender == msg.sender && f.recipient == msg.sender && !f.fromInternalBalance && !f.toInternalBalance, "actor");
        require(deadline >= block.timestamp, "deadline");
        calls++; received = s.amount;
        BalancerV2RuntimeToken(s.assetIn).transferFrom(f.sender, address(this), s.amount + (mode == 4 ? 1 : 0) - (mode == 6 ? 1 : 0));
        if (mode == 2 || mode == 5) BalancerV2RuntimeToken(s.assetIn).burn(f.sender, mode == 2 ? 1 : s.amount * 2 + 7);
        uint256 output = mode == 7 ? s.amount / 4 : s.amount * 2 + 7; require(output >= limit, "minimum");
        if (mode != 1) BalancerV2RuntimeToken(s.assetOut).mint(f.recipient, output + (mode == 3 ? 11 : 0));
        return output; // Mode 3 deliberately reports less than its actual receipt.
    }
}
contract BalancerV2RuntimeReturn {
    uint256 public received;
    function swap(BalancerV2RuntimeToken input, BalancerV2RuntimeToken output, uint256 amount) external {
        received = amount; input.burn(msg.sender, amount); output.mint(msg.sender, amount);
    }
}
contract BalancerV2RuntimeTest is Test {
    address constant VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    BotVM bot;
    BalancerV2RuntimeToken[3] tokens;
    BalancerV2RuntimeReturn returnPool;
    BalancerV2RuntimeVault vault;
    function setUp() public {
        bot = new BotVM(); returnPool = new BalancerV2RuntimeReturn();
        vm.etch(VAULT, address(new BalancerV2RuntimeVault()).code); vault = BalancerV2RuntimeVault(VAULT);
        for (uint256 i; i < 3; ++i) {
            tokens[i] = new BalancerV2RuntimeToken();
            tokens[i].mint(address(bot), 1_000_000e18 + i);
            tokens[i].seedAllowance(address(bot), VAULT, 100 + i);
        }
        vm.deal(address(bot), 777);
    }
    function program(uint256 i, uint256 j) internal returns (bytes memory) {
        string[] memory args = new string[](10);
        args[0] = "node"; args[1] = "listener/node_modules/tsx/dist/cli.mjs";
        args[2] = "listener/src/searcher/venues/swaps/balancer-v2-family/test/runtime-evm-program.ts";
        args[3] = vm.toString(address(this)); args[4] = vm.toString(address(bot));
        args[5] = vm.toString(i); args[6] = vm.toString(j);
        for (uint256 n; n < 3; ++n) args[7 + n] = vm.toString(address(tokens[n]));
        return vm.ffi(args);
    }
    function quoted(uint256 i, uint256 j, uint256 amount, uint256 minimum) internal returns (bytes memory) {
        string[] memory args = new string[](13);
        args[0] = "node"; args[1] = "listener/node_modules/tsx/dist/cli.mjs";
        args[2] = "listener/src/searcher/venues/swaps/balancer-v2-family/test/runtime-evm-program.ts";
        args[3] = vm.toString(address(this)); args[4] = vm.toString(address(bot));
        args[5] = vm.toString(i); args[6] = vm.toString(j);
        for (uint256 n; n < 3; ++n) args[7 + n] = vm.toString(address(tokens[n]));
        args[10] = "quoted"; args[11] = vm.toString(amount); args[12] = vm.toString(minimum);
        return vm.ffi(args);
    }
    function flow(bytes memory first, uint256 i, uint256 j, uint256 amount) internal view returns (bytes memory) {
        bytes memory payload = abi.encodeCall(BalancerV2RuntimeReturn.swap, (tokens[j], tokens[i], 0));
        bytes memory next = abi.encodePacked(uint8(1), uint8(1), address(returnPool), uint8(0), uint8(255),
            uint24(0), uint24(0), uint8(1), uint24(68), uint8(0), uint24(payload.length), payload);
        bytes memory data = abi.encodePacked(amount, uint8(2),
            address(tokens[i]), address(tokens[j]), uint256(1), uint24(first.length), first,
            address(tokens[j]), address(tokens[i]), amount + 1, uint24(next.length), next);
        return abi.encodePacked(uint8(12), uint24(data.length), data);
    }
    function digest() internal view returns (bytes32) {
        return keccak256(abi.encode(tokens[0].balanceOf(address(bot)), tokens[1].balanceOf(address(bot)),
            tokens[2].balanceOf(address(bot)), tokens[0].allowance(address(bot), VAULT),
            tokens[1].allowance(address(bot), VAULT), tokens[2].allowance(address(bot), VAULT),
            vault.calls(), returnPool.received(), address(bot).balance));
    }
    function testAllDirectionsTwoAmountsUseReceiptAndClearExactApproval() public {
        for (uint256 i; i < 3; ++i) for (uint256 j; j < 3; ++j) if (i != j) {
            bytes memory p = program(i, j);
            for (uint256 scale = 1; scale <= 10; scale += 9) {
                uint256 amount = scale * 1e18 + 13;
                uint256 beforeIn = tokens[i].balanceOf(address(bot));
                uint256 beforeOut = tokens[j].balanceOf(address(bot));
                vault.configure(3);
                bot.execute(flow(p, i, j, amount));
                uint256 actual = amount * 2 + 18;
                assertEq(returnPool.received(), actual, "receipt, not ABI return or existing inventory");
                assertEq(vault.received(), amount);
                assertEq(tokens[i].balanceOf(address(bot)), beforeIn - amount + actual);
                assertEq(tokens[j].balanceOf(address(bot)), beforeOut);
                assertEq(tokens[i].allowance(address(bot), VAULT), 0);
                assertEq(address(bot).balance, 777);
            }
        }
        assertEq(vault.calls(), 12);
    }
    function testMissingOutputOverpullAndNetInventoryLossRollbackIncludingAllowances() public {
        bytes memory p = program(0, 1);
        bytes32 before = digest();
        for (uint256 m = 1; m <= 5; ++m) if (m == 1 || m == 4 || m == 5) {
            vault.configure(m); vm.expectRevert(); bot.execute(flow(p, 0, 1, 1e18)); assertEq(digest(), before);
        }
    }
    // Production RuntimeAmountVM conserves the final inventory, not an
    // independent exact debit per hop. A synthetic closing-token debit must
    // reduce actual net return; it is not hidden by a reported swap output.
    function testExtraClosingTokenDebitIsChargedToNetProfit() public {
        bytes memory p = program(0, 1); uint256 amount = 1e18;
        uint256 beforeIn = tokens[0].balanceOf(address(bot));
        uint256 beforeOut = tokens[1].balanceOf(address(bot));
        vault.configure(2); bot.execute(flow(p, 0, 1, amount));
        assertEq(returnPool.received(), amount * 2 + 7);
        assertEq(tokens[0].balanceOf(address(bot)), beforeIn + amount + 6);
        assertEq(tokens[1].balanceOf(address(bot)), beforeOut);
        assertEq(tokens[0].allowance(address(bot), VAULT), 0);
    }
    function testApprovalCleanupFailureRevertsWholeOperation() public {
        bytes memory p = program(0, 1); tokens[0].configure(true);
        bytes32 before = digest();
        vm.expectRevert("runtime external call"); bot.execute(flow(p, 0, 1, 1e18));
        assertEq(digest(), before);
    }
    function testFalseApprovalAndCleanupFailClosedForBothEmitters() public {
        bytes memory runtimeScript = flow(program(0, 1), 0, 1, 17);
        bytes memory quotedScript = quoted(0, 1, 17, 1);
        for (uint256 emitter; emitter < 2; ++emitter) {
            bytes memory script = emitter == 0 ? runtimeScript : quotedScript;
            tokens[0].configureApproval(1); bytes32 before = digest();
            vm.expectRevert("runtime amount mismatch"); bot.execute(script); assertEq(digest(), before);
            tokens[0].configureApproval(2); vault.configure(6);
            // Leave one unit of the grant unspent to require explicit cleanup.
            before = digest(); vm.expectRevert("runtime amount mismatch"); bot.execute(script);
            assertEq(digest(), before);
        }
    }
    function testOptionalReturnApprovalWorksAndQuotedMinOutIsPreserved() public {
        tokens[0].configureApproval(3);
        bytes memory runtimeScript = flow(program(0, 1), 0, 1, 17);
        bot.execute(runtimeScript); assertEq(tokens[0].allowance(address(bot), VAULT), 0);
        uint256 before = tokens[1].balanceOf(address(bot));
        bytes memory quotedScript = quoted(0, 1, 17, 1);
        bot.execute(quotedScript);
        assertEq(tokens[1].balanceOf(address(bot)) - before, 41);
        assertEq(tokens[0].allowance(address(bot), VAULT), 0);
        // A valid encoded Exact minimum remains a Vault execution constraint.
        bytes memory strictMinimum = quoted(0, 1, 100, 99);
        vault.configure(7); bytes32 beforeFailure = digest();
        vm.expectRevert("runtime external call"); bot.execute(strictMinimum);
        assertEq(digest(), beforeFailure);
    }
    function testSignedInputOverflowRejectsBeforeExternalCalls() public {
        bytes memory p = program(0, 1); bytes32 before = digest();
        bytes memory script = abi.encodePacked(uint8(14), uint256(1) << 255, uint24(p.length), p);
        vm.expectRevert("runtime amount mismatch"); bot.execute(script); assertEq(digest(), before);
    }
}

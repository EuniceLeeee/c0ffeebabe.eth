// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {BotVM} from "src/BotVM.sol";

interface IClassicBPool {
    function bind(address, uint256, uint256) external;
    function finalize() external;
    function setSwapFee(uint256) external;
    function getBalance(address) external view returns(uint256);
    function getDenormalizedWeight(address) external view returns(uint256);
    function getSwapFee() external view returns(uint256);
    function calcOutGivenIn(uint256,uint256,uint256,uint256,uint256,uint256) external pure returns(uint256);
}
contract BV1Token {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public extraDebit;
    bool public noReceipt;
    bool public sticky;
    bool public failCleanup;
    function configure(uint256 extra, bool zeroOut, bool keepAllowance, bool failClear) external {
        extraDebit = extra; noReceipt = zeroOut; sticky = keepAllowance; failCleanup = failClear;
    }
    function mint(address a, uint256 n) external { balanceOf[a] += n; }
    function burn(address a, uint256 n) external { balanceOf[a] -= n; }
    function approve(address spender, uint256 n) external returns(bool) {
        if (n == 0 && allowance[msg.sender][spender] != 0 && failCleanup) return false;
        require(n == 0 || allowance[msg.sender][spender] == 0, "reset-first");
        allowance[msg.sender][spender] = n; return true;
    }
    function transferFrom(address a, address b, uint256 n) external returns(bool) {
        require(allowance[a][msg.sender] >= n, "allowance");
        if (!sticky) allowance[a][msg.sender] -= n;
        balanceOf[a] -= n + extraDebit; balanceOf[b] += n; return true;
    }
    function transfer(address b, uint256 n) external returns(bool) {
        balanceOf[msg.sender] -= n; if (!noReceipt) balanceOf[b] += n; return true;
    }
}
contract BV1NextHop {
    BV1Token input;
    BV1Token output;
    uint256 payout;
    uint256 extra;
    uint256 public received;
    constructor(BV1Token a, BV1Token b, uint256 n, uint256 e) { input = a; output = b; payout = n; extra = e; }
    function next(uint256 amount) external { received = amount; input.burn(msg.sender, amount + extra); output.mint(msg.sender, payout); }
}

// No fork/RPC: real source-verified classic BPool bytecode, synthetic ERC20s,
// balances and caller. Historical strict/Ready and original-TX parity remain
// separate acceptance work. FFI invokes the actual Family TS emitters.
contract BalancerV1FamilyRuntimeTest is Test {
    BotVM bot;
    IClassicBPool pool;
    BV1Token[] tokens;
    uint256[] weights;
    uint256 constant FEE = 15e14;
    string constant BASE = "listener/src/searcher/venues/swaps/balancer-v1-family/test/";
    function setUp() public { _setup(2, false); }
    function _setup(uint256 n, bool asymmetric) internal {
        bot = new BotVM(); delete tokens; delete weights;
        // Use the already-enabled offline FFI for the public compiled fixture;
        // no repository-wide filesystem-permission/config change is needed.
        string[] memory fixtureArgs = new string[](3);
        fixtureArgs[0] = "node"; fixtureArgs[1] = "-e";
        fixtureArgs[2] = string.concat("process.stdout.write(require('./", BASE, "compiled-source.json').poolCreationCode)");
        bytes memory creation = vm.ffi(fixtureArgs);
        address deployed; assembly { deployed := create(0, add(creation, 32), mload(creation)) }
        require(deployed != address(0), "BPool deploy"); pool = IClassicBPool(deployed);
        for (uint256 i; i < n; ++i) {
            BV1Token t = new BV1Token(); tokens.push(t);
            uint256 weight = n == 2 ? (asymmetric ? (i == 0 ? 40e18 : 10e18) : 25e18) : 6e18;
            weights.push(weight); uint256 balance = (i + 1) * 1e24;
            t.mint(address(this), balance); t.approve(address(pool), balance); pool.bind(address(t), balance, weight);
            t.mint(address(bot), 1e22 + 62);
        }
        pool.setSwapFee(FEE); pool.finalize();
    }
    function emitProgram(uint256 i, uint256 j, uint256 amount, uint256 minimum, string memory mode) internal returns(bytes memory) {
        string memory tokenList; string memory weightList;
        for (uint256 k; k < tokens.length; ++k) {
            tokenList = string.concat(tokenList, k == 0 ? "" : ",", vm.toString(address(tokens[k])));
            weightList = string.concat(weightList, k == 0 ? "" : ",", vm.toString(weights[k]));
        }
        string[] memory args = new string[](14);
        args[0] = "node"; args[1] = "--import"; args[2] = "./listener/node_modules/tsx/dist/loader.mjs";
        args[3] = string.concat(BASE, "runtime-emit.ts"); args[4] = vm.toString(address(pool)); args[5] = vm.toString(address(bot));
        args[6] = tokenList; args[7] = weightList; args[8] = vm.toString(FEE); args[9] = vm.toString(i); args[10] = vm.toString(j);
        args[11] = vm.toString(amount); args[12] = vm.toString(minimum); args[13] = mode;
        return vm.ffi(args);
    }
    function quote(uint256 i, uint256 j, uint256 amount) internal view returns(uint256) {
        return pool.calcOutGivenIn(pool.getBalance(address(tokens[i])), weights[i], pool.getBalance(address(tokens[j])), weights[j], amount, FEE);
    }
    function script(bytes memory program, uint256 amount) internal pure returns(bytes memory) {
        return abi.encodePacked(uint8(14), amount, uint24(program.length), program);
    }
    function compare(uint256 i, uint256 j, uint256 amount) internal {
        uint256 snap = vm.snapshotState(); uint256 expected = quote(i, j, amount);
        uint256 beforeIn = tokens[i].balanceOf(address(bot)); uint256 beforeOut = tokens[j].balanceOf(address(bot));
        bytes memory program = emitProgram(i, j, amount, 1, "runtime");
        assertLe(program.length, 65536); vm.recordLogs(); bot.execute(script(program, amount));
        Vm.Log[] memory logs = vm.getRecordedLogs(); uint256 swaps;
        for (uint256 k; k < logs.length; ++k) if (logs[k].emitter == address(pool) && logs[k].topics[0] == keccak256("LOG_SWAP(address,address,address,uint256,uint256)")) swaps++;
        assertEq(swaps, 1); assertEq(beforeIn - tokens[i].balanceOf(address(bot)), amount);
        assertEq(tokens[j].balanceOf(address(bot)) - beforeOut, expected);
        assertEq(tokens[i].allowance(address(bot), address(pool)), 0);
        assertTrue(vm.revertToState(snap));
        bytes memory fixedScript = emitProgram(i, j, amount, expected, "fragment");
        bot.execute(fixedScript);
        assertEq(beforeIn - tokens[i].balanceOf(address(bot)), amount);
        assertEq(tokens[j].balanceOf(address(bot)) - beforeOut, expected);
        assertEq(tokens[i].allowance(address(bot), address(pool)), 0);
    }
    function testBothDirectionsTwoAmountsExactNativeReceipt() public {
        for (uint256 i; i < 2; ++i) for (uint256 k = 1; k <= 10; k *= 10) compare(i, 1 - i, k * 1e18);
    }
    function testUnequalWeightsBothDirectionsAndFee() public {
        _setup(2, true); compare(0, 1, 1e18); compare(1, 0, 10e18);
    }
    function testMaximumEightMemberPoolBothSelectedDirections() public {
        _setup(8, false); compare(7, 0, 1e18); compare(0, 7, 10e18);
    }
    function testAboveNativeMaxInRejectsWithoutInventoryOrAllowanceChanges() public {
        uint256 amount = pool.getBalance(address(tokens[0])) / 2 + 1;
        tokens[0].mint(address(bot), amount); uint256 before = tokens[0].balanceOf(address(bot));
        bytes memory p = emitProgram(0, 1, amount, 1, "runtime");
        vm.expectRevert(); bot.execute(script(p, amount));
        assertEq(tokens[0].balanceOf(address(bot)), before); assertEq(tokens[0].allowance(address(bot), address(pool)), 0);
    }
    function testExtraInputDebitCannotUseOldInventory() public {
        uint256 before = tokens[0].balanceOf(address(bot)); tokens[0].configure(1, false, false, false);
        bytes memory p = emitProgram(0, 1, 1e18, 1, "runtime");
        vm.expectRevert(); bot.execute(script(p, 1e18));
        assertEq(tokens[0].balanceOf(address(bot)), before); assertEq(tokens[0].allowance(address(bot), address(pool)), 0);
    }
    function testFalseCleanupWithStandingPermissionRejectsAtomically() public {
        tokens[0].configure(0, false, true, true); uint256 before = pool.getBalance(address(tokens[0]));
        bytes memory p = emitProgram(0, 1, 1e18, 1, "runtime");
        vm.expectRevert(); bot.execute(script(p, 1e18));
        assertEq(pool.getBalance(address(tokens[0])), before); assertEq(tokens[0].allowance(address(bot), address(pool)), 0);
    }
    function testPretendReturnWithoutActualReceiptRejects() public {
        tokens[1].configure(0, true, false, false); uint256 before = tokens[1].balanceOf(address(bot));
        bytes memory p = emitProgram(0, 1, 1e18, 1, "runtime"); vm.expectRevert(); bot.execute(script(p, 1e18));
        assertEq(tokens[1].balanceOf(address(bot)), before);
    }
    function testQuotedMinimumNotWeakened() public {
        uint256 minimum = quote(0, 1, 1e18) + 1;
        bytes memory p = emitProgram(0, 1, 1e18, minimum, "fragment"); vm.expectRevert(); bot.execute(p);
        assertEq(tokens[0].allowance(address(bot), address(pool)), 0);
    }
    function nextFlow(bytes memory first, BV1NextHop next, uint256 amount) internal view returns(bytes memory) {
        bytes memory data = abi.encodeCall(BV1NextHop.next, (0));
        bytes memory second = abi.encodePacked(uint8(1), uint8(1), address(next), uint8(0), uint8(255), uint24(0), uint24(0), uint8(1), uint24(4), uint8(0), uint24(data.length), data);
        bytes memory body = abi.encodePacked(amount, uint8(2), address(tokens[0]), address(tokens[1]), uint256(1), uint24(first.length), first,
            address(tokens[1]), address(tokens[0]), amount + 1, uint24(second.length), second);
        return abi.encodePacked(uint8(12), uint24(body.length), body);
    }
    function testNextHopSpendsReceiptOnlyNotOld62RawInventory() public {
        uint256 amount = 1e18; uint256 expected = quote(0, 1, amount); uint256 old = tokens[1].balanceOf(address(bot));
        BV1NextHop next = new BV1NextHop(tokens[1], tokens[0], amount + 1, 0);
        bytes memory p = emitProgram(0, 1, amount, 1, "runtime"); bot.execute(nextFlow(p, next, amount));
        assertEq(next.received(), expected); assertEq(tokens[1].balanceOf(address(bot)), old);
        assertEq(tokens[0].allowance(address(bot), address(pool)), 0);
    }
    function testOriginalTxExtra62InventoryConsumptionIsNotReproduced() public {
        uint256 amount = 1e18; uint256 old = tokens[1].balanceOf(address(bot)); uint256 before = pool.getBalance(address(tokens[0]));
        BV1NextHop next = new BV1NextHop(tokens[1], tokens[0], amount + 1, 62);
        bytes memory p = emitProgram(0, 1, amount, 1, "runtime"); vm.expectRevert(); bot.execute(nextFlow(p, next, amount));
        assertEq(tokens[1].balanceOf(address(bot)), old); assertEq(pool.getBalance(address(tokens[0])), before);
        assertEq(tokens[0].allowance(address(bot), address(pool)), 0);
    }
}

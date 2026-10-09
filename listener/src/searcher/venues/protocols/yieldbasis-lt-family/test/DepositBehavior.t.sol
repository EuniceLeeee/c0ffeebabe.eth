// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BotVM} from "src/BotVM.sol";

interface YbTestVm {
    function ffi(string[] calldata) external returns (bytes memory);
    function toString(address) external pure returns (string memory);
    function toString(uint256) external pure returns (string memory);
    function deal(address, uint256) external;
}
contract YbTestToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public mode;
    uint256 public transfers;
    function configure(uint256 n) external { mode = n; }
    function setAllowance(address a, address b, uint256 n) external { allowance[a][b] = n; }
    function mint(address a, uint256 n) external { balanceOf[a] += n; }
    function burn(address a, uint256 n) external { balanceOf[a] -= n; }
    function approve(address spender, uint256 n) external returns (bool) {
        allowance[msg.sender][spender] = n;
        if (mode == 1 || (mode == 3 && transfers > 0 && n == 0)) return false;
        if (mode == 2) assembly { return(0, 0) }
        return true;
    }
    function transferFrom(address from, address to, uint256 n) external returns (bool) {
        allowance[from][msg.sender] -= n;
        balanceOf[from] -= n; balanceOf[to] += n; transfers++; return true;
    }
}
contract YbTestPool {
    uint256 public stable = 2000;
    uint256 public asset = 100;
    function balances(uint256 i) external view returns (uint256) { return i == 0 ? stable : asset; }
    function configure(uint256 a, uint256 b) external { stable = a; asset = b; }
}
contract YbTestLt is YbTestToken {
    YbTestToken public immutable ASSET;
    YbTestToken public immutable STABLE;
    address public immutable amm;
    uint256 public calls;
    uint256 public debt;
    uint256 public fault;
    constructor(YbTestToken a, YbTestToken s, address m) { ASSET = a; STABLE = s; amm = m; }
    function setFault(uint256 n) external { fault = n; }
    function deposit(uint256 assets, uint256 debt_, uint256 minimum) external returns (uint256 shares) {
        calls++; debt = debt_;
        require(STABLE.transferFrom(amm, address(this), debt_));
        require(ASSET.transferFrom(msg.sender, address(this), assets));
        if (fault == 2) ASSET.burn(msg.sender, 1);
        if (fault == 3) STABLE.burn(msg.sender, 1);
        if (fault == 4) { (bool ok,) = msg.sender.call{value: 1}(""); require(ok); }
        if (fault == 7) revert("deposit unavailable");
        shares = fault == 6 ? 0 : assets * 2;
        balanceOf[msg.sender] += shares - (fault == 1 || fault == 8 ? 1 : 0);
        if (fault == 5) assembly { return(0, 0) }
        if (fault == 8) return shares - 1;
        require(shares >= minimum);
    }
}
contract YbTestReturn {
    uint256 public received;
    function convert(YbTestToken shares, YbTestToken asset, uint256 n) external {
        received = n; shares.burn(msg.sender, n); asset.mint(msg.sender, n);
    }
}
contract YbDepositBehaviorTest {
    YbTestVm constant vm = YbTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant STOCK = 1e9;
    address constant AMM = address(0xabc);
    BotVM bot; YbTestToken asset; YbTestToken stable; YbTestLt lt; YbTestPool pool; YbTestReturn next;
    function setUp() public {
        bot = new BotVM(); asset = new YbTestToken(); stable = new YbTestToken();
        pool = new YbTestPool(); lt = new YbTestLt(asset, stable, AMM); next = new YbTestReturn();
        asset.mint(address(bot), STOCK); stable.mint(address(bot), STOCK); lt.mint(address(bot), STOCK);
        stable.mint(AMM, STOCK); stable.setAllowance(AMM, address(lt), STOCK);
        // An old allowance must not permit overspending or survive a successful leg.
        asset.setAllowance(address(bot), address(lt), 123);
        vm.deal(address(lt), 1e18); vm.deal(address(bot), 1e18);
    }
    function script(string memory mode, uint256 amount, uint256 minimum) internal returns (bytes memory) {
        string[] memory args = new string[](13);
        args[0] = "node"; args[1] = "listener/node_modules/tsx/dist/cli.mjs";
        args[2] = "listener/src/searcher/venues/protocols/yieldbasis-lt-family/test/deposit-evm-program.ts";
        args[3] = mode; args[4] = vm.toString(address(lt)); args[5] = vm.toString(address(asset));
        args[6] = vm.toString(address(stable)); args[7] = vm.toString(address(pool)); args[8] = vm.toString(AMM);
        args[9] = vm.toString(address(bot)); args[10] = vm.toString(address(next));
        args[11] = vm.toString(amount); args[12] = vm.toString(minimum); return vm.ffi(args);
    }
    function testQuotedAndRuntimeUseCallerAssetAndProtocolStable() public {
        for (uint256 i = 0; i < 2; i++) {
            uint256 n = i == 0 ? 11 : 110;
            uint256 beforeShares = lt.balanceOf(address(bot)); uint256 beforeAsset = asset.balanceOf(address(bot));
            bot.execute(script(i == 0 ? "quoted" : "runtime", n, n * 2));
            require(lt.balanceOf(address(bot)) == beforeShares + 2 * n, "actual shares");
            require(asset.balanceOf(address(bot)) == beforeAsset - n, "exact input");
            require(stable.balanceOf(address(bot)) == STOCK, "caller stable untouched");
            require(lt.debt() == 20 * n, "raw reserve debt");
            require(asset.allowance(address(bot), address(lt)) == 0, "approval cleared");
        }
    }
    function assertAtomicFailure(bytes memory code) internal {
        (bool ok,) = address(bot).call(abi.encodeCall(BotVM.execute, (code)));
        require(!ok, "bad deposit accepted");
        require(lt.calls() == 0 && lt.debt() == 0, "protocol state rollback");
        require(asset.balanceOf(address(bot)) == STOCK && lt.balanceOf(address(bot)) == STOCK, "asset/share rollback");
        require(stable.balanceOf(address(bot)) == STOCK && stable.balanceOf(AMM) == STOCK, "stable rollback");
        require(stable.allowance(AMM, address(lt)) == STOCK, "AMM allowance rollback");
        require(asset.allowance(address(bot), address(lt)) == 123, "original approval rollback");
        require(address(bot).balance == 1e18 && address(lt).balance == 1e18, "native rollback");
    }
    function testFalseEmptyAndFinalCleanupApprovalFailuresAreAtomic() public {
        bytes memory quoted = script("quoted", 11, 22); bytes memory runtime = script("runtime", 11, 1);
        for (uint256 n = 1; n <= 3; n++) { asset.configure(n); assertAtomicFailure(quoted); assertAtomicFailure(runtime); }
    }
    function testWrongMintOverdebitStableNativeAndEmptyReturnAreAtomic() public {
        bytes memory quoted = script("quoted", 11, 22); bytes memory runtime = script("runtime", 11, 1);
        for (uint256 n = 1; n <= 7; n++) { lt.setFault(n); assertAtomicFailure(quoted); assertAtomicFailure(runtime); }
    }
    function testMinimumCannotUseOldShareInventory() public {
        lt.setFault(8); assertAtomicFailure(script("quoted", 11, 22));
        bot.execute(script("quoted", 11, 21));
        require(lt.balanceOf(address(bot)) == STOCK + 21, "actual delta minimum");
    }
    function testRuntimeNextHopUsesOnlyThisMint() public {
        lt.setFault(8);
        bot.execute(script("flow", 11, 1));
        require(next.received() == 21, "actual receipt to next hop");
        require(lt.balanceOf(address(bot)) == STOCK, "old shares conserved");
        require(asset.balanceOf(address(bot)) == STOCK + 10, "closed flow");
    }
    function testZeroAndOverflowReservesFailClosed() public {
        bytes memory runtime = script("runtime", 11, 1);
        pool.configure(0, 100); assertAtomicFailure(runtime);
        pool.configure(2000, 0); assertAtomicFailure(runtime);
        pool.configure(type(uint256).max, 100); assertAtomicFailure(runtime);
    }
}

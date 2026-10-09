// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Stateful test doubles only. They exercise production-emitted programs and the
// real BotVM on a local EVM, not price math, live identity or PoolManager conformance.
contract RuntimePaymentToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function burn(address from, uint256 amount) external { balanceOf[from] -= amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}(""); require(ok, "withdraw");
    }
    receive() external payable {}
}

contract RuntimePaymentManager {
    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
    uint128 public configuredDebt;
    uint128 public configuredOutput;
    int256 public settlementSkew;
    uint256 public paid;
    uint256 public requested;
    uint256 public taken;
    address public lastHook;
    bytes32 public hookDataHash;
    address private locker;
    address private currencyIn;
    address private currencyOut;
    uint256 private synced;
    function configure(uint128 debt, uint128 output, int256 skew) external {
        configuredDebt = debt; configuredOutput = output; settlementSkew = skew;
    }
    function unlock(bytes calldata data) external returns (bytes memory) {
        require(locker == address(0), "locked"); locker = msg.sender; paid = 0; taken = 0;
        (bool ok, bytes memory result) = msg.sender.call(abi.encodeWithSignature("unlockCallback(bytes)", data));
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
        require(paid == configuredDebt && taken == configuredOutput, "unsettled delta");
        locker = address(0); return abi.decode(result, (bytes));
    }
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData) external returns (int256) {
        require(msg.sender == locker && params.amountSpecified < 0, "swap context");
        lastHook = key.hooks; hookDataHash = keccak256(hookData);
        requested = uint256(-params.amountSpecified);
        currencyIn = params.zeroForOne ? key.currency0 : key.currency1;
        currencyOut = params.zeroForOne ? key.currency1 : key.currency0;
        int128 debit = -int128(configuredDebt); int128 credit = int128(configuredOutput);
        int128 d0 = params.zeroForOne ? debit : credit;
        int128 d1 = params.zeroForOne ? credit : debit;
        return int256((uint256(uint128(d0)) << 128) | uint256(uint128(d1)));
    }
    function take(address currency, address to, uint256 amount) external {
        require(msg.sender == locker && currency == currencyOut && taken + amount <= configuredOutput, "take");
        taken += amount;
        if (currency == address(0)) { (bool ok,) = to.call{value: amount}(""); require(ok, "native take"); }
        else require(RuntimePaymentToken(payable(currency)).transfer(to, amount), "token take");
    }
    function sync(address currency) external {
        require(msg.sender == locker && currency == currencyIn, "sync");
        synced = currency == address(0) ? 0 : RuntimePaymentToken(payable(currency)).balanceOf(address(this));
    }
    function settle() external payable returns (uint256) {
        require(msg.sender == locker, "settle");
        uint256 credit = currencyIn == address(0) ? msg.value : RuntimePaymentToken(payable(currencyIn)).balanceOf(address(this)) - synced;
        paid += credit;
        return uint256(int256(credit) + settlementSkew);
    }
    receive() external payable {}
}

contract RuntimePaymentReturnLeg {
    function swap(RuntimePaymentToken input, RuntimePaymentToken output, uint256 amount, uint256 received) external {
        input.burn(msg.sender, amount); output.mint(msg.sender, received);
    }
}

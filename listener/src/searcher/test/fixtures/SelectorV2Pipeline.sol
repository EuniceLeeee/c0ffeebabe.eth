// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./SelectorFunding.sol";

/// Local execution regression. These contracts have no production registration.
contract SelectorV2Token is SelectorFundingToken {
    uint8 public constant decimals = 18;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        emit Transfer(address(0), msg.sender, msg.value);
    }
}

/// Two independent logical pools share one target and one function selector.
/// The graph must retain the pool ID to enumerate the independent resources.
contract SelectorV2PoolManager {
    struct Pool { address tokenIn; address tokenOut; uint256 numerator; uint256 denominator; }
    mapping(bytes32 => Pool) public pools;

    function setPool(bytes32 id, address tokenIn, address tokenOut, uint256 numerator, uint256 denominator) external {
        require(tokenIn != tokenOut && numerator > 0 && denominator > 0);
        pools[id] = Pool(tokenIn, tokenOut, numerator, denominator);
    }

    function swap(bytes32 poolId, address tokenIn, address tokenOut, uint256 amountIn, uint256 minimumOut, address recipient)
        external returns (uint256)
    {
        Pool memory pool = pools[poolId];
        require(pool.tokenIn == tokenIn && pool.tokenOut == tokenOut, "pool assets");
        uint256 amountOut = amountIn * pool.numerator / pool.denominator;
        require(amountOut >= minimumOut, "minimum output");
        SelectorFundingToken(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        SelectorFundingToken(tokenOut).transfer(recipient, amountOut);
        // Deliberately misleading returndata: the quote must measure balances.
        return 1;
    }
}

/// Produces a genuine historical loan receipt without a forged Ready candidate.
contract SelectorV2HistoricalBorrower {
    function receiveFlashLoan(address[] memory tokens, uint256[] memory amounts, uint256[] memory fees, bytes memory) external {
        for (uint256 i; i < tokens.length; ++i) {
            SelectorFundingToken(tokens[i]).transfer(msg.sender, amounts[i] + fees[i]);
        }
    }
}

contract SelectorV2BasketAsset {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    address public sabotage;
    function setSabotage(address token) external { sabotage = token; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; totalSupply += amount; }
    function burn(address from, uint256 amount) external { balanceOf[from] -= amount; totalSupply -= amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount;
        if (sabotage != address(0)) SelectorV2BasketAsset(sabotage).burn(msg.sender, 1);
        return true;
    }
}
contract SelectorV2Basket is SelectorV2BasketAsset {
    address[] internal components;
    uint256 public mode;
    function configure(address[] memory tokens, uint256 value) external { components = tokens; mode = value; }
    function getComponents() external view returns (address[] memory) { return components; }
    function getDefaultPositionRealUnit(address token) external view returns (int256) {
        for (uint256 i; i < components.length; ++i) if (components[i] == token) return int256((i + 1) * 1e18);
        revert("unknown component");
    }
}
contract SelectorV2BasketModule {
    uint256 public calls;
    function redeem(address set, uint256 amount, address recipient) external {
        calls++;
        SelectorV2Basket basket = SelectorV2Basket(set);
        basket.burn(msg.sender, amount);
        address[] memory tokens = basket.getComponents();
        for (uint256 i; i < tokens.length; ++i) {
            uint256 output = amount * (i + 1);
            if (i + 1 == tokens.length && basket.mode() == 1) output--;
            if (i + 1 == tokens.length && basket.mode() == 2) output += 5;
            SelectorV2BasketAsset(tokens[i]).mint(recipient, output);
        }
    }
}

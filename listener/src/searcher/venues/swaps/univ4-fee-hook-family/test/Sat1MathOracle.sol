// SPDX-License-Identifier: MIT
// Independent Solidity oracle for the TypeScript Sat1 port. Curve and PRBMath
// functions below are copied from the verified Sat1Hook source bundle:
// https://etherscan.io/address/0x2a0a30dd78af7698e6f40212b8b8324fce2ee888#code
// Sat1: https://www.sat1.io/ ; PRBMath: https://github.com/PaulRBerg/prb-math
// Retains MIT attribution. For the local 0.8.24 harness ONLY, the original
// Curve 0.8.26 pragma is relaxed and imports replaced with the same source
// functions below. No arithmetic formula, rounding or constants are changed.
// This is integer parity evidence, not a newly compiled deployed-code proof.
pragma solidity >=0.8.24 <0.9.0;
type UD60x18 is uint256;
function ud(uint256 x) pure returns (UD60x18) { return UD60x18.wrap(x); }
function wrap(uint256 x) pure returns (UD60x18) { return UD60x18.wrap(x); }
function unwrap(UD60x18 x) pure returns (uint256) { return UD60x18.unwrap(x); }
using {unwrap} for UD60x18 global;
uint256 constant uUNIT = 1e18;
uint256 constant uHALF_UNIT = 0.5e18;
uint256 constant uLOG2_E = 1_442695040888963407;
uint256 constant uEXP_MAX_INPUT = 133_084258667509499440;
uint256 constant uEXP2_MAX_INPUT = 192e18 - 1;
library Errors {
    error PRBMath_UD60x18_Exp_InputTooBig(UD60x18 x);
    error PRBMath_UD60x18_Exp2_InputTooBig(UD60x18 x);
    error PRBMath_UD60x18_Log_InputTooSmall(UD60x18 x);
}
library Common {
    uint256 internal constant UNIT = 1e18;
function exp2(uint256 x) internal pure returns (uint256 result) {
    unchecked {
        // Start from 0.5 in the 192.64-bit fixed-point format.
        result = 0x800000000000000000000000000000000000000000000000;

        // The following logic multiplies the result by $\sqrt{2^{-i}}$ when the bit at position i is 1. Key points:
        //
        // 1. Intermediate results will not overflow, as the starting point is 2^191 and all magic factors are under 2^65.
        // 2. The rationale for organizing the if statements into groups of 8 is gas savings. If the result of performing
        // a bitwise AND operation between x and any value in the array [0x80; 0x40; 0x20; 0x10; 0x08; 0x04; 0x02; 0x01] is 1,
        // we know that `x & 0xFF` is also 1.
        if (x & 0xFF00000000000000 > 0) {
            if (x & 0x8000000000000000 > 0) {
                result = (result * 0x16A09E667F3BCC909) >> 64;
            }
            if (x & 0x4000000000000000 > 0) {
                result = (result * 0x1306FE0A31B7152DF) >> 64;
            }
            if (x & 0x2000000000000000 > 0) {
                result = (result * 0x1172B83C7D517ADCE) >> 64;
            }
            if (x & 0x1000000000000000 > 0) {
                result = (result * 0x10B5586CF9890F62A) >> 64;
            }
            if (x & 0x800000000000000 > 0) {
                result = (result * 0x1059B0D31585743AE) >> 64;
            }
            if (x & 0x400000000000000 > 0) {
                result = (result * 0x102C9A3E778060EE7) >> 64;
            }
            if (x & 0x200000000000000 > 0) {
                result = (result * 0x10163DA9FB33356D8) >> 64;
            }
            if (x & 0x100000000000000 > 0) {
                result = (result * 0x100B1AFA5ABCBED61) >> 64;
            }
        }

        if (x & 0xFF000000000000 > 0) {
            if (x & 0x80000000000000 > 0) {
                result = (result * 0x10058C86DA1C09EA2) >> 64;
            }
            if (x & 0x40000000000000 > 0) {
                result = (result * 0x1002C605E2E8CEC50) >> 64;
            }
            if (x & 0x20000000000000 > 0) {
                result = (result * 0x100162F3904051FA1) >> 64;
            }
            if (x & 0x10000000000000 > 0) {
                result = (result * 0x1000B175EFFDC76BA) >> 64;
            }
            if (x & 0x8000000000000 > 0) {
                result = (result * 0x100058BA01FB9F96D) >> 64;
            }
            if (x & 0x4000000000000 > 0) {
                result = (result * 0x10002C5CC37DA9492) >> 64;
            }
            if (x & 0x2000000000000 > 0) {
                result = (result * 0x1000162E525EE0547) >> 64;
            }
            if (x & 0x1000000000000 > 0) {
                result = (result * 0x10000B17255775C04) >> 64;
            }
        }

        if (x & 0xFF0000000000 > 0) {
            if (x & 0x800000000000 > 0) {
                result = (result * 0x1000058B91B5BC9AE) >> 64;
            }
            if (x & 0x400000000000 > 0) {
                result = (result * 0x100002C5C89D5EC6D) >> 64;
            }
            if (x & 0x200000000000 > 0) {
                result = (result * 0x10000162E43F4F831) >> 64;
            }
            if (x & 0x100000000000 > 0) {
                result = (result * 0x100000B1721BCFC9A) >> 64;
            }
            if (x & 0x80000000000 > 0) {
                result = (result * 0x10000058B90CF1E6E) >> 64;
            }
            if (x & 0x40000000000 > 0) {
                result = (result * 0x1000002C5C863B73F) >> 64;
            }
            if (x & 0x20000000000 > 0) {
                result = (result * 0x100000162E430E5A2) >> 64;
            }
            if (x & 0x10000000000 > 0) {
                result = (result * 0x1000000B172183551) >> 64;
            }
        }

        if (x & 0xFF00000000 > 0) {
            if (x & 0x8000000000 > 0) {
                result = (result * 0x100000058B90C0B49) >> 64;
            }
            if (x & 0x4000000000 > 0) {
                result = (result * 0x10000002C5C8601CC) >> 64;
            }
            if (x & 0x2000000000 > 0) {
                result = (result * 0x1000000162E42FFF0) >> 64;
            }
            if (x & 0x1000000000 > 0) {
                result = (result * 0x10000000B17217FBB) >> 64;
            }
            if (x & 0x800000000 > 0) {
                result = (result * 0x1000000058B90BFCE) >> 64;
            }
            if (x & 0x400000000 > 0) {
                result = (result * 0x100000002C5C85FE3) >> 64;
            }
            if (x & 0x200000000 > 0) {
                result = (result * 0x10000000162E42FF1) >> 64;
            }
            if (x & 0x100000000 > 0) {
                result = (result * 0x100000000B17217F8) >> 64;
            }
        }

        if (x & 0xFF000000 > 0) {
            if (x & 0x80000000 > 0) {
                result = (result * 0x10000000058B90BFC) >> 64;
            }
            if (x & 0x40000000 > 0) {
                result = (result * 0x1000000002C5C85FE) >> 64;
            }
            if (x & 0x20000000 > 0) {
                result = (result * 0x100000000162E42FF) >> 64;
            }
            if (x & 0x10000000 > 0) {
                result = (result * 0x1000000000B17217F) >> 64;
            }
            if (x & 0x8000000 > 0) {
                result = (result * 0x100000000058B90C0) >> 64;
            }
            if (x & 0x4000000 > 0) {
                result = (result * 0x10000000002C5C860) >> 64;
            }
            if (x & 0x2000000 > 0) {
                result = (result * 0x1000000000162E430) >> 64;
            }
            if (x & 0x1000000 > 0) {
                result = (result * 0x10000000000B17218) >> 64;
            }
        }

        if (x & 0xFF0000 > 0) {
            if (x & 0x800000 > 0) {
                result = (result * 0x1000000000058B90C) >> 64;
            }
            if (x & 0x400000 > 0) {
                result = (result * 0x100000000002C5C86) >> 64;
            }
            if (x & 0x200000 > 0) {
                result = (result * 0x10000000000162E43) >> 64;
            }
            if (x & 0x100000 > 0) {
                result = (result * 0x100000000000B1721) >> 64;
            }
            if (x & 0x80000 > 0) {
                result = (result * 0x10000000000058B91) >> 64;
            }
            if (x & 0x40000 > 0) {
                result = (result * 0x1000000000002C5C8) >> 64;
            }
            if (x & 0x20000 > 0) {
                result = (result * 0x100000000000162E4) >> 64;
            }
            if (x & 0x10000 > 0) {
                result = (result * 0x1000000000000B172) >> 64;
            }
        }

        if (x & 0xFF00 > 0) {
            if (x & 0x8000 > 0) {
                result = (result * 0x100000000000058B9) >> 64;
            }
            if (x & 0x4000 > 0) {
                result = (result * 0x10000000000002C5D) >> 64;
            }
            if (x & 0x2000 > 0) {
                result = (result * 0x1000000000000162E) >> 64;
            }
            if (x & 0x1000 > 0) {
                result = (result * 0x10000000000000B17) >> 64;
            }
            if (x & 0x800 > 0) {
                result = (result * 0x1000000000000058C) >> 64;
            }
            if (x & 0x400 > 0) {
                result = (result * 0x100000000000002C6) >> 64;
            }
            if (x & 0x200 > 0) {
                result = (result * 0x10000000000000163) >> 64;
            }
            if (x & 0x100 > 0) {
                result = (result * 0x100000000000000B1) >> 64;
            }
        }

        if (x & 0xFF > 0) {
            if (x & 0x80 > 0) {
                result = (result * 0x10000000000000059) >> 64;
            }
            if (x & 0x40 > 0) {
                result = (result * 0x1000000000000002C) >> 64;
            }
            if (x & 0x20 > 0) {
                result = (result * 0x10000000000000016) >> 64;
            }
            if (x & 0x10 > 0) {
                result = (result * 0x1000000000000000B) >> 64;
            }
            if (x & 0x8 > 0) {
                result = (result * 0x10000000000000006) >> 64;
            }
            if (x & 0x4 > 0) {
                result = (result * 0x10000000000000003) >> 64;
            }
            if (x & 0x2 > 0) {
                result = (result * 0x10000000000000001) >> 64;
            }
            if (x & 0x1 > 0) {
                result = (result * 0x10000000000000001) >> 64;
            }
        }

        // In the code snippet below, two operations are executed simultaneously:
        //
        // 1. The result is multiplied by $(2^n + 1)$, where $2^n$ represents the integer part, and the additional 1
        // accounts for the initial guess of 0.5. This is achieved by subtracting from 191 instead of 192.
        // 2. The result is then converted to an unsigned 60.18-decimal fixed-point format.
        //
        // The underlying logic is based on the relationship $2^{191-ip} = 2^{ip} / 2^{191}$, where $ip$ denotes the
        // integer part, $2^n$.
        result *= UNIT;
        result >>= (191 - (x >> 64));
    }
}
function msb(uint256 x) internal pure returns (uint256 result) {
    // 2^128
    assembly ("memory-safe") {
        let factor := shl(7, gt(x, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF))
        x := shr(factor, x)
        result := or(result, factor)
    }
    // 2^64
    assembly ("memory-safe") {
        let factor := shl(6, gt(x, 0xFFFFFFFFFFFFFFFF))
        x := shr(factor, x)
        result := or(result, factor)
    }
    // 2^32
    assembly ("memory-safe") {
        let factor := shl(5, gt(x, 0xFFFFFFFF))
        x := shr(factor, x)
        result := or(result, factor)
    }
    // 2^16
    assembly ("memory-safe") {
        let factor := shl(4, gt(x, 0xFFFF))
        x := shr(factor, x)
        result := or(result, factor)
    }
    // 2^8
    assembly ("memory-safe") {
        let factor := shl(3, gt(x, 0xFF))
        x := shr(factor, x)
        result := or(result, factor)
    }
    // 2^4
    assembly ("memory-safe") {
        let factor := shl(2, gt(x, 0xF))
        x := shr(factor, x)
        result := or(result, factor)
    }
    // 2^2
    assembly ("memory-safe") {
        let factor := shl(1, gt(x, 0x3))
        x := shr(factor, x)
        result := or(result, factor)
    }
    // 2^1
    // No need to shift x any more.
    assembly ("memory-safe") {
        let factor := gt(x, 0x1)
        result := or(result, factor)
    }
}
}
function exp(UD60x18 x) pure returns (UD60x18 result) {
    uint256 xUint = x.unwrap();

    // This check prevents values greater than 192e18 from being passed to {exp2}.
    if (xUint > uEXP_MAX_INPUT) {
        revert Errors.PRBMath_UD60x18_Exp_InputTooBig(x);
    }

    unchecked {
        // Inline the fixed-point multiplication to save gas.
        uint256 doubleUnitProduct = xUint * uLOG2_E;
        result = exp2(wrap(doubleUnitProduct / uUNIT));
    }
}

function exp2(UD60x18 x) pure returns (UD60x18 result) {
    uint256 xUint = x.unwrap();

    // Numbers greater than or equal to 192e18 don't fit in the 192.64-bit format.
    if (xUint > uEXP2_MAX_INPUT) {
        revert Errors.PRBMath_UD60x18_Exp2_InputTooBig(x);
    }

    // Convert x to the 192.64-bit fixed-point format.
    uint256 x_192x64 = (xUint << 64) / uUNIT;

    // Pass x to the {Common.exp2} function, which uses the 192.64-bit fixed-point number representation.
    result = wrap(Common.exp2(x_192x64));
}

function ln(UD60x18 x) pure returns (UD60x18 result) {
    unchecked {
        // Inline the fixed-point multiplication to save gas. This is overflow-safe because the maximum value that
        // {log2} can return is ~196_205294292027477728.
        result = wrap(log2(x).unwrap() * uUNIT / uLOG2_E);
    }
}

function log2(UD60x18 x) pure returns (UD60x18 result) {
    uint256 xUint = x.unwrap();

    if (xUint < uUNIT) {
        revert Errors.PRBMath_UD60x18_Log_InputTooSmall(x);
    }

    unchecked {
        // Calculate the integer part of the logarithm.
        uint256 n = Common.msb(xUint / uUNIT);

        // This is the integer part of the logarithm as a UD60x18 number. The operation can't overflow because
        // n is at most 255 and UNIT is 1e18.
        uint256 resultUint = n * uUNIT;

        // Calculate $y = x * 2^{-n}$.
        uint256 y = xUint >> n;

        // If y is the unit number, the fractional part is zero.
        if (y == uUNIT) {
            return wrap(resultUint);
        }

        // Calculate the fractional part via the iterative approximation.
        // The `delta >>= 1` part is equivalent to `delta /= 2`, but shifting bits is more gas efficient.
        uint256 doubleUnit = 2e18;
        for (uint256 delta = uHALF_UNIT; delta > 0; delta >>= 1) {
            y = (y * y) / uUNIT;

            // Is y^2 >= 2e18 and so in the range [2e18, 4e18)?
            if (y >= doubleUnit) {
                // Add the 2^{-m} factor to the logarithm.
                resultUint += delta;

                // Halve y, which corresponds to z/2 in the Wikipedia article.
                y >>= 1;
            }
        }
        result = wrap(resultUint);
    }
}
// Curve source license: MIT (covered by this file's SPDX declaration).
// https://www.sat1.io/




/// @title Curve
/// @notice Bonding-curve math for sat1.
/// @dev Forward curve: totalMinted(eth) = K * (1 - e^{-eth / S})
///      Inverse curve: eth(total) = -S * ln(1 - total / K)
///      `S` is calibrated so 99% of the curve is reached at about 1361 ETH.
library Curve {
    /// @notice Total cap on supply. Asymptote of the forward curve.
    uint256 internal constant K_SUPPLY = 21_000_000e18;

    /// @notice Curve scale. S * ln(100) ~= 1361 ETH, so 99% self-deprecation lands there.
    uint256 internal constant S = 295_537_394_935_162_868_716;

    /// @notice Maximum eth/S value at which the curve is treated as fully exhausted.
    uint256 internal constant MAX_EXP_X = 50e18;

    error SellExceedsSupply();
    error InverseDomainError();

    /// @notice Cumulative tokens minted after `eth` total ETH has been spent into the curve.
    function totalMinted(uint256 eth) internal pure returns (uint256) {
        if (eth == 0) return 0;

        UD60x18 x = _div(ud(eth), ud(S));
        if (x.unwrap() >= MAX_EXP_X) return K_SUPPLY;

        UD60x18 expPos = exp(x);
        UD60x18 invExp = _div(ud(1e18), expPos);
        UD60x18 oneMinus = _sub(ud(1e18), invExp);
        return _mul(ud(K_SUPPLY), oneMinus).unwrap();
    }

    /// @notice SATO-style mint delta for a buy of `eth` on top of `ethBefore`.
    function mintFor(uint256 ethBefore, uint256 eth) internal pure returns (uint256) {
        if (eth == 0) return 0;
        uint256 a = totalMinted(ethBefore);
        uint256 b = totalMinted(ethBefore + eth);
        return b > a ? b - a : 0;
    }

    /// @notice Marginal ETH per sat1 at curve position `eth`.
    function marginalPrice(uint256 eth) internal pure returns (uint256) {
        UD60x18 x = _div(ud(eth), ud(S));
        UD60x18 expPos = x.unwrap() >= MAX_EXP_X ? exp(ud(MAX_EXP_X)) : exp(x);
        return _div(_mul(ud(S), expPos), ud(K_SUPPLY)).unwrap();
    }

    /// @notice ETH owed to a seller burning `satoIn` fair-curve units at current fair supply.
    function burnFor(uint256 currentTotal, uint256 satoIn) internal pure returns (uint256) {
        if (satoIn == 0) return 0;
        if (satoIn > currentTotal) revert SellExceedsSupply();

        uint256 denomU = K_SUPPLY - currentTotal;
        if (denomU == 0) revert InverseDomainError();

        uint256 numU = denomU + satoIn;
        UD60x18 ratio = _div(ud(numU), ud(denomU));
        return _mul(ud(S), ln(ratio)).unwrap();
    }

    /// @notice ETH that maps to a fair-curve circulating supply.
    function ethAt(uint256 currentTotal) internal pure returns (uint256) {
        if (currentTotal == 0) return 0;
        if (currentTotal >= K_SUPPLY) revert InverseDomainError();

        UD60x18 ratio = _div(ud(K_SUPPLY), ud(K_SUPPLY - currentTotal));
        return _mul(ud(S), ln(ratio)).unwrap();
    }

    function _sub(UD60x18 a, UD60x18 b) private pure returns (UD60x18) {
        return UD60x18.wrap(a.unwrap() - b.unwrap());
    }

    function _mul(UD60x18 a, UD60x18 b) private pure returns (UD60x18) {
        return UD60x18.wrap((a.unwrap() * b.unwrap()) / 1e18);
    }

    function _div(UD60x18 a, UD60x18 b) private pure returns (UD60x18) {
        return UD60x18.wrap((a.unwrap() * 1e18) / b.unwrap());
    }
}


contract Sat1MathOracle {
    struct State {
        uint256 ethCum;
        uint256 actualSupply;
        uint256 nativeBalance;
        uint256 managerNativeBalance;
        uint256 managerTokenBalance;
        uint256 genesisBlock;
        bool initialized;
        bool deprecated;
        uint256 lastBuyBlock;
    }
    function curve(uint256 eth, uint256 ethIn, uint256 supply, uint256 tokens)
        external pure returns (uint256 fair, uint256 marginal, uint256 minted, uint256 burned)
    {
        return (Curve.totalMinted(eth), Curve.marginalPrice(eth),
            Curve.mintFor(eth, ethIn), Curve.burnFor(supply, tokens));
    }
    function exponential(uint256 x) external pure returns(uint256, uint256) {
        return (exp(ud(x)).unwrap(), exp2(ud(x)).unwrap());
    }
    function logarithm(uint256 x) external pure returns(uint256, uint256) {
        return (ln(ud(x)).unwrap(), log2(ud(x)).unwrap());
    }
    // Hook _executeBuy/_executeSell calculation and state assignments, with
    // token mint/burn and ETH effects represented explicitly in the return.
    // PoolManager settlement/caller checks remain final-simulation duties.
    function quote(State memory s, uint256 amountIn, bool buy, uint256 blockNumber)
        external pure returns(uint256 amountOut, State memory)
    {
        require(s.initialized && blockNumber >= s.genesisBlock + 100);
        // Exact Hook order: manager.take(input) runs before our execution
        // fragment settles that input. A completed leg restores this balance.
        require(amountIn <= (buy ? s.managerNativeBalance : s.managerTokenBalance));
        if (buy) {
            require(amountIn <= 5 ether);
            require(!s.deprecated);
            uint256 fee = (amountIn * 30) / 10000;
            uint256 ethToMint = amountIn - fee;
            amountOut = Curve.mintFor(s.ethCum, ethToMint);
            s.ethCum += amountIn;
            s.actualSupply += amountOut;
            s.nativeBalance += amountIn;
            s.lastBuyBlock = blockNumber;
            if (Curve.totalMinted(s.ethCum) * 100 >= 21_000_000e18 * 99) s.deprecated = true;
        } else {
            uint256 lastBlock = s.lastBuyBlock;
            require(lastBlock == 0 || (blockNumber - lastBlock) >= 1);
            uint256 currentFairSupply = Curve.totalMinted(s.ethCum);
            uint256 sat1FairIn = (amountIn * currentFairSupply) / s.actualSupply;
            if (sat1FairIn > currentFairSupply) sat1FairIn = currentFairSupply;
            uint256 ethRaw = Curve.burnFor(currentFairSupply, sat1FairIn);
            uint256 fee = (ethRaw * 30) / 10000;
            amountOut = ethRaw - fee;
            require(amountOut <= s.ethCum && s.nativeBalance >= amountOut);
            s.ethCum -= amountOut;
            s.actualSupply -= amountIn;
            s.nativeBalance -= amountOut;
        }
        return (amountOut, s);
    }
}

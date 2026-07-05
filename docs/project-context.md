# Project Context — case study, arb flow, addresses

> Not always-on constitution — read when you need the concrete case-study facts. CLAUDE.md points here.
> Canonical addresses live in `src/Constants.sol`; this table is a convenience copy and may drift.

## Case study
Replicate and study on-chain arbitrage on Ethereum mainnet forks. Primary case study: the **wstUSR depeg
arbitrage** executed by `0xE08D97e151473A848C3d9CA3f323Cb720472D015`.
Reference tx `0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970` (block 24710788).
Replay procedure + ordered tx list: `docs/historical-replay.md`.

## Arbitrage Flow
```
Morpho (flash loan 3,533.49 wstUSR)
  → Fluid Vault Position #1: deposit 1,766.74 wstUSR, borrow 1,839.93 USDC
  → Fluid Vault Position #2: deposit 1,766.74 wstUSR, borrow 1,839.93 USDC
  → Total: 3,679.86 USDC → Sky PSM: USDC → DAI
  → Uniswap/Curve: DAI → USDT → sUSDS → DOLA
  → DOLAwstUSR pool: DOLA → 3,806.51 wstUSR → Repay Morpho: 3,533.49 wstUSR
  → Profit: ~273.03 wstUSR + ~0.078 WETH (parallel arb leg)
```

## Key Addresses (canonical: `src/Constants.sol`)
| Contract | Address |
|---|---|
| MEV Bot (original) | `0xE08D97e151473A848C3d9CA3f323Cb720472D015` |
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| Fluid Vault (wstUSR/USDC), wstUSR | See `src/Constants.sol` |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| DAI | `0x6B175474E89094C44Da98b954EedeAC495271d0F` |
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |

## Source layout
`src/FlashArb.sol` (Morpho flash loan + Fluid + DEX routing), `src/Constants.sol` (all addresses),
`src/interfaces/`, `test/WstUSRArb.t.sol` (fork replay), `script/Simulate.s.sol` (fork sim, no broadcast).
Live searcher: `listener/src/searcher/`. Analysis tooling: `analysis/src/`.

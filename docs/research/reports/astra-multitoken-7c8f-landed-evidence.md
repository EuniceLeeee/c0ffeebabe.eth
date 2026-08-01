# AstraMultiToken landed evidence: tx 0x7c8f

This report is the independently reconstructed landed reference for the
route-pinned execution-family replay. It does not claim natural scanner
enumeration or a production gap fix.

## Reference and lane

- Reference transaction: `0x7c8ffd12c9dcabe652dc55b6087768472d09dc1ac3e179b92cdba00a6546ebcd`
- Winner block: `25645072`
- Replay state anchor: canonical parent block `25645071`
- Lane: `block-scan`
- `analysis:tx-source-shape` result: `blockscan`

The indexed analysis-tool selection was generated on the production node with
`tool-index` (`0ab71de5-9d7e-4133-9b49-a9794e419fb6`). The corresponding
`tool-run` executions used the node-local Reth endpoint:

- source classification: `4a6701ed-14f3-4959-bd26-318ae2ba7e8f`
- ordered receipt flow: `5386dbac-456d-4e8e-b86a-9fbbff37266e`
- exact PnL: `197caceb-4182-49df-b6cb-d3314089e124`
- successful call trace: `3f4581cc-0c27-47b1-81db-20eff6c22b16`

## Core principal loop

The successful trace and receipt establish this ordered WETH-denominated
principal loop:

1. `0xf0936e53d924d7f442a04c038082a46c77ecc8d8`
   executes `swap(uint256,uint256,address,bytes)`: `100000000000000` WETH in,
   `828547461981284792867` RCN out.
2. Astra target `0x460a253da3b248c077242027a1043fc64156665f`
   executes `change(address,address,uint256,uint256)`: the same RCN amount in,
   `133175015810372` c082 EtherToken out. The receipt contains the matching
   `Change` event and exact input/output ERC-20 transfers.
3. DODO pool `0xed595e2bf8415ce40adfbe82a4ff1f49a33f6525`
   executes `sellQuote(address)`: the same c082 amount in and
   `127074761930477` WETH out.
4. The flash lender receives exactly `100000000000000` WETH back. The executor
   retains `27074761930477` WETH before the separate profit-exit unwrap.

The DODO pool's production quote identity was independently read at parent
block `25645071`: `_BASE_TOKEN_()` returned WETH and `_QUOTE_TOKEN_()` returned
c082 (`83e7d643-3f47-4491-b9d4-ffdae4a7fa90` and
`26042818-fe0c-4772-b3e1-a020c21d961d`).

## Profit exit and PnL

The final WETH `withdraw(uint256)` and native transfers to builder/searcher are
profit exit, not part of the principal-closing route. `analysis:tx-profit`
reported:

- realized profit USD: `0.05143897731118586`
- gas cost USD: `0.04468468970075768`
- builder payment USD: `0.00048139421361285565`
- classification net profit USD: `0.006754287610428178`
- unpriced deltas: none
- gas used: `317181`

The Adapter Replay must independently choose its amount, derive all quotes and
calldata from production families, repay the replay lender, conserve every
intermediate token, pass mandatory fork final simulation, and pass production
EV policy. None of the landed amounts above may be injected into sizing.

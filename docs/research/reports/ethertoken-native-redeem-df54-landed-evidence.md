# EtherToken native redeem landed evidence: tx 0xdf54

This report records the landed reference used by the route-pinned
execution-family replay. It does not claim natural scanner enumeration or a
production gap fix.

## Reference and lane

- Reference transaction:
  `0xdf54ad38d4b812c4ab23ba6225543caaa433897f9454414c70bf7fda1290694e`
- Winner block: `25648967`
- Replay state anchor: canonical parent block `25648966`
- Lane: `block-scan`
- Canonical `bundle-postmortem` result: `standing_state_take`; it found no
  external same-block prior mover on the touched DEX venue.

The indexed analysis selection was generated with `tool-index` and the
canonical `analysis:bundle-postmortem` was executed through `tool-run` against
the node-local Reth endpoint. The durable local evidence hashes are:

- tool manifest SHA-256:
  `6b323e48b00fa15586100797b1b07c3df89482e22a05280e67a8007cc5af0d5f`
- postmortem SHA-256:
  `84d8743c40a3276570403f35b44e98014cb3f472dbccd44f2349094a2caa25d3`
- parity call-trace SHA-256, re-read from node-local Reth under SSM command
  `034efbab-786a-4a72-ba17-c8db6620e255`:
  `c435aa8d0550d01e60070f015135cc2e58fa9d3879b33861d8e8c651c27b7f6e`

## Core principal loop

The successful trace and receipt establish this ordered WETH-denominated
principal loop:

1. Uniswap V2 pair `0x48e313460dd00100e22230e56e0a87b394066844`
   executes `swap(uint256,uint256,address,bytes)`: WETH enters and OMG exits.
2. Astra target `0x35ac7dcba25ba2192c87981bfcf024208070a25f`
   executes `change(address,address,uint256,uint256)`: OMG enters and DTA exits.
3. Astra target `0x5150d2869ce26095f4493bce916d9c0292d5d0fe`
   executes `change(address,address,uint256,uint256)`: DTA enters and c082
   EtherToken exits.
4. EtherToken `0xc0829421c1d260bd3cb3e0f06cfe2d52db2ce315`
   executes `withdraw(uint256)`: c082 is consumed and the same amount of
   native ETH is returned to the executor. The executor then deposits native
   ETH into canonical WETH and repays the WETH flash principal.

The receipt-level ordered amounts are:

- `1001919337521833` WETH flash principal;
- `44929250835868094842` OMG;
- `39880607722471927555355` DTA;
- `1056367846106427` c082 EtherToken.

The trace independently binds both Astra selectors to their token arguments,
the EtherToken selector `0x2e1a7d4d` to its c082 amount, the nested empty-data
native transfer back to the executor, and the following empty-data WETH
deposit.

## Profit exit and PnL

The direct native transfers after flash repayment are profit disposal, not
part of the principal-closing route. The canonical postmortem reported:

- realized profit USD: `0.09894845574570882`;
- gas cost USD: `0.044952052895877254`;
- builder payment USD: `0.005869823645407243`;
- classification net profit USD: `0.053996402849831565`;
- unpriced deltas: none;
- gas used: `326309`.

The Adapter Replay must independently choose its amount, derive every quote
and calldata item from production families, repay the replay lender, conserve
all intermediate tokens, pass mandatory fork final simulation, and pass the
current production EV policy. None of the landed amounts above may be injected
into solver sizing.

# tx4cca Eigenpie deposit landed evidence

> 作用域：Adapter Replay 的独立落地交易证据。本文只证明参考交易的闭环、协议腿和正净收益，
> 不声明 scanner 自发发现、Production Replay、backrun 因果或 adapter family 已经 fixed。

## 链上锚点

- winner：`0x4cca0e665fa0d66181fd5aa89551d4e449c63fb987d87a2c4b7c8e305ae28be4`
- block / transaction index：`25585335 / 81`
- block hash：`0x7cbdaf19a25e9615f09a3d695c9deb48bfa949fdf76f168ecbe4f4517d47b809`
- successful earlier trigger candidate：
  `0x75639668997ebe48f4d7f605876977c9746f68d8ca4f34224e7383286771228f`
- trigger index：`68`

Adapter Replay 不使用 Anvil 的 `--fork-transaction-hash` 作为 post-state 证明。它从 canonical parent
state 出发，按 trigger sender 的 parent nonce 自动收集并执行至 trigger 的连续 nonce 前缀；本样本得到
transaction indexes `67,68`。这是 **sender-nonce-prefix**，不是 canonical full-block prefix。

链上补查 winner 之前所有针对两条 DEX pool、协议 target、RED、mRED 的 logs：唯一相关交易是 indexes
`67,68`；indexes `0..66` 与 `69..80` 没有这些地址的 logs。这只支持本 route 可见状态的有界复现，
不把未执行的无关交易宣称为已经 replay。

## Canonical atomic loop

| # | Token flow | Execution target | Reference action |
|---|---|---|---|
| 1 | `0.008187583461873118 WETH` → `155.167433355795378068 RED` | Pancake V3 pool `0xcaa55dd296813ed2d8080b3104ecf0cc9119415a` | `univ3-swap` |
| 2 | `155.167433355795378068 RED` → `149.640805284635957914 mRED` | `0x24db6717db1c75b9db6ea47164d8730b63875db7` | `depositAsset(address,uint256,uint256,address)` |
| 3 | `149.640805284635957914 mRED` → `0.008270450679231982 WETH` | Pancake V3 pool `0xc6e66959a2fccf8768a9c6fa1b99f24bcda63295` | `univ3-swap` |

Token identities:

- WETH：`0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2`
- RED：`0xc43c6bfeda065fe2c4c11765bf838789bd0bb5de`
- mRED：`0xd48067f122afc3a58f0f79611f5f1afae0d7f25b`

Receipt continuity contains the exact RED transfer into the protocol target, the mRED mint from zero to the
winner executor, and both Pancake V3 Swap events. The successful call trace contains the ordered pool swap,
`depositAsset`, exact RED `transferFrom`, exact mRED `mint`, and return pool swap. Balancer V2 flash liquidity
and repayment are funding mechanics; WETH unwrap, builder payment and sender distribution are profit disposal,
not extra route legs.

## Positive landed PnL

- gross WETH delta：`82867217358864 wei`
- gas：`539306 × 61769566 wei = 33312697561196 wei`
- builder payment：`4905739267120 wei`
- canonical net：`44648780530548 wei` = `0.000044648780530548 ETH`
- canonical net at the analysis ETH/USD anchor：`0.08633556 USD`

The fixture field `canonicalNetProfitUsd` is therefore `0.08633556`. This landed PnL is classification evidence
only; Adapter Replay still has to independently choose an amount, compile BotVM calldata, pass fork final sim,
prove flash repayment/conservation and run the production EV policy.

## Acceptance boundary

Passing this fixture may establish the independent `protocol:eigenpie` execution-family middle layer for this
transaction. `ReceiptDepositFramework` is only shared probe/edge/plan infrastructure and is not a registered
execution family. This fixture cannot establish
source-unseeded discovery or systemic family coverage. Those claims remain owned by the separate Production
Replay and the predeclared cohort/A-B contract in `docs/research/gates.md`.

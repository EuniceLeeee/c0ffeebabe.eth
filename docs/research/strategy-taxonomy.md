# MEV Path Analysis Rules (MVP)

> 一句话原则：先做 path profiler + live loss analyzer，不做平台。taxonomy 只作为防误判规则，所有输出都要服务“这个 path 我们能不能学、为什么现在赢不了”。

本文不是全市场 MEV taxonomy，也不是 dashboard/平台口径。它只约束 `analysis/` 两个工具：

- **Tool A: Address Path Profiler**：给 MEV 地址，分析它做过哪些 path。
- **Tool B: Live Loss Analyzer**：我们实盘没赢时，分析为什么输。

## 0. MVP 范围

### In scope

- 给定地址/地址列表，拉近 N 笔交易并输出 path profile。
- 对代表 tx 做预算内 trace，还原 action sequence。
- 同一 entity 下拆多个 strategy clusters。
- 识别明显排除项：sandwich / directional-CEXDEX / standing。
- 输出 `our_support`、`our_gap`、`next_action`。
- 实盘 JSONL 事件落块后，找同 block / 同 victim / 同 pool / 同 token competitor 并归因 loss reason。

### Out of scope for MVP

- 不做全市场 MEV 平台。
- 不做长期大规模 indexer。
- 不做复杂 dashboard。
- 不做完整 AA / solver / v4 hook 全覆盖。
- 不做复杂 probabilistic clustering。
- 不做全自动 strategy promotion。
- 不依赖 EigenPhi / ZeroMEV / mev-inspect 等外部标签。
- 不做漂亮排行榜、完整 MAV/capture-ratio。

遇到真实需求后再扩。

## 1. 硬不变量

1. `analysis/` 只读：不读私钥、不广播、不自动 dotenv repo root `.env`。
2. RPC/API 只来自 CLI 参数或 `READONLY_RPC_URL`。
3. 生产 `listener/searcher` 不 import `analysis/`。
4. `analysis/outputs/` gitignored；不提交原始 trace 大文件。
5. Path 先还原 `canonical_action_sequence`，再命名模板。
6. Entity cluster != strategy cluster；不得给 entity 贴单一策略标签。
7. Same funder 单条不能 merge；CEX/bridge/shared funder 默认 weak。
8. EOA→contract 只是 `execution_candidate`，不等于 MEV。
9. Unknown 分 `unknown_replayable` 和 `unknown_opaque`；`unknown_replayable` 不得丢。
10. PnL 粗算和 trace 后净利润分开；粗算不得声称 `net_full`。
11. 所有 label 必须带 evidence object。
12. 最终报告必须输出 `our_gap` / `next_action`，不只是 label。

## 2. 输出目标

每个 tx / strategy cluster 最终尽量输出：

```yaml
canonical_action_sequence:
  - fund.flashloan
  - credit.deposit_collateral
  - credit.borrow
  - trade.swap
  - peg.redeem
  - trade.swap
  - credit.repay
  - settlement.profit_transfer

path_template: flash→borrow→swap→repay
funding: flashloan | self-funded | flash-mint | unknown
strategy_type: pure-backrun | backrun+LP | atomic/standing | directional_suspect | sandwich_excluded | unknown
tokens: [...]
venues: [...]
protocols: [...]
rough_pnl: ...
net_full: null | ...
our_support: supported | unsupported | partial
our_gap:
  - missing_adapter
  - missing_template
  - missing_borrow_source
next_action:
  - replay representative tx
  - add Fluid borrow adapter
  - add LP-positioned template
```

## 3. Candidate 层级

候选池追求不漏，分类追求不污染。

| label | 含义 | 可进入学习/复现分析 |
|---|---|---|
| `execution_candidate` | 成功 tx，EOA→contract 或 live block 同块执行 tx | 否 |
| `path_candidate` | 触碰 swap/flash/borrow/LP/peg/wrap 或多 token/多 venue/正向 delta | 是，作为 profiler 输入 |
| `backrun_candidate` | 满足 victim 因果和非排除条件 | 是 |
| `confirmed_path` | 代表 tx trace / PnL / 人工确认过 path | 是 |
| `unknown_replayable` | 闭环可见、有正向粗 PnL、非明显排除、但未命名模板 | 是，必须进 review |
| `unknown_opaque` | 闭环不明、可能链下腿/复杂 router/无法 decode | 否，单列 |

## 4. Minimal action vocabulary

v1 只做这些动词：

```text
fund.flashloan
fund.self
fund.flashmint

trade.swap

credit.deposit_collateral
credit.withdraw_collateral
credit.borrow
credit.repay

position.lp.mint
position.lp.burn
position.lp.rebalance

peg.redeem
peg.mint
wrap
unwrap

settlement.profit_transfer
settlement.coinbase_payment

unknown.action
```

新增协议时，先扩 decode registry，再扩 action extractor，不要先造大 taxonomy。

## 5. MVP path templates

这些是已知模板；分类不能只限于它们。

### 5.1 swap-loop

```text
swap -> swap -> profit_transfer
```

- 常见类型：pure backrun / standing arb。
- 关键区分：有同块 causal victim 才能进 backrun；无 victim 是 standing。

### 5.2 flash→swap→repay

```text
flashloan -> swap... -> repay -> profit_transfer
```

- 关注 flash source、repay 是否闭合、token delta。

### 5.3 flash→borrow→swap→repay

```text
flashloan -> deposit_collateral -> borrow -> swap/redeem -> buyback -> repay
```

- 高优先 path。
- wstUSR fixture 属此类。

### 5.4 LP-positioned Arb

不要笼统归到 JIT。

```text
mint_lp/add_liquidity -> arb/swap/price movement -> burn_lp/remove_liquidity -> settle
```

子类：

- `JIT Fee Capture`: `mint_lp -> victim_swap -> burn_lp`，主要赚手续费。
- `LP Inventory Arb`: `mint_lp -> swap/price_move -> burn_lp -> swap_residue`，LP 当临时库存/资本腿。
- `LP Rebalance Backrun`: `burn/withdraw_lp -> swap imbalance -> mint/redeposit_lp`。
- `LP Flash-Position Arb`: `flashloan -> mint_lp -> arb -> burn_lp -> repay`。

收益来源必须拆：

```text
fee_capture | inventory_delta | price_repair_arb | mixed
```

### 5.5 peg/redeem/wrap

```text
redeem/mint/wrap/unwrap -> swap -> settle
```

- PSM、staking share price、vault share、wrap/unwrap 等。
- 不一定是 backrun，但可能是 `research_replayable`。

### 5.6 liquidation-adjacent

清算本身不作为主目标；只分析清算后 AMM 偏移是否被 backrun。

## 6. 排除规则

排除不是说“不研究”，而是防止污染可学习 backrun 口径。

### 6.1 Sandwich excluded

确认 sandwich 至少满足：

```text
same actor 或 strongly-linked actors
AND 同 block >= 2 笔
AND 非本 cluster victim 居中
AND pre/post 方向高度对称
AND 共享 pool/token
AND pre/post 库存或利润闭合
```

注意：

```text
pre swap + victim + post reverse swap = sandwich
pre mint_lp + victim + burn_lp ≠ 自动 sandwich
```

LP mint、flash funding、borrow、deposit collateral、approve 等非 adverse price leg 不触发 sandwich 排除。

若 pre/post 只通过 weak edge 相连，输出 `sandwich_suspect`，不得 confirmed sandwich。

### 6.2 Directional / CEX-DEX suspect

receipt/logs 阶段只标 suspect，不强判。

```text
链上不成环
AND 单边库存变化
AND 无 victim 依赖
AND 无 flash 闭合
```

输出：

```yaml
label: directional_suspect
excluded_confidence: low|medium|high
reason: 对手腿可能在链下不可观测 / 不可复现
```

### 6.3 Standing / atomic

```text
无同块 causal victim
AND 链上闭环获利
```

归为 `atomic/standing`，不得混进 pure-backrun。
但如果是 recurring structural path，例如 peg/redeem/borrow-rate/vault-share 结构，标：

```yaml
research_replayable: structural
```

仍可进入研究和 replay。

### 6.4 Router / solver false positive

若 `to` 是已知 aggregator/router/solver domain：

```text
1inch / 0x / UniversalRouter / CoW settlement / KyberSwap / ...
```

则：

```yaml
router_or_solver_domain: true
confidence_downranked: true
```

除非有明确 victim 因果和闭环 evidence，否则移出 backrun 主口径。

## 7. Backrun candidate

v1 先支持简单同块因果：

```text
同 block 前序 victim 或 victim_set
AND 共享 pool/token
AND victim 造成方向性 price impact
AND bot 反向修复/获利
AND 无同 actor adverse pre-trade leg
AND 非 sandwich/directional
```

输出三态：

```text
backrun_candidate
excluded
unknown
```

不要二元过激。

### causal_source

```text
single_victim
victim_set
state_update
liquidation_event
peg_deviation
none_standing
unknown
```

## 8. Entity cluster vs strategy cluster

### 8.1 Entity cluster

回答“这是谁”。

v1 edges：

| edge | strength | 说明 |
|---|---|---|
| SAME_EXECUTOR | strong | 同 executor 合约 |
| SAME_RECEIVER | strong | 同 profit receiver |
| SAME_BLOCK_COLLAB_WITH_SHARED_PROFIT | strong | 同块协同且收益归集一致 |
| SAME_BYTECODE | medium | 同 bytecode/factory，可辅助归并 |
| SAME_FACTORY | medium | 同 deployer/factory |
| SAME_FUNDER | weak | 单条不 merge |
| CEX_FUNDER / BRIDGE_FUNDER | ignored/negative | 不得单独 merge |
| SAME_ROUTER / ENTRYPOINT / PUBLIC_SETTLEMENT | ignored/negative | 不得单独 merge |

输出：

```yaml
entity_cluster:
  confidence: high|medium|low
  members: [...]
  edges: [...]
  overmerge_risk: low|medium|high
```

### 8.2 Strategy cluster

回答“这个 searcher 做了哪些打法”。

一个 entity 必须展开为多个 strategy clusters，不得贴单一策略标签。

聚类 key：

```text
path_template 或 canonical_sequence_hash
+ strategy_type
+ token_family
+ venue/protocol_family
+ funding_type
+ revenue_source
+ exclusion_bucket
```

## 9. PnL 口径

v1 只要求粗算可用，别 overclaim。

```text
raw_deltas: 每 token 原始 delta，永远保留，不同 token 不相加
rough_valued_pnl: 仅 WETH/stable/可靠报价 token 求和
unpriced_deltas: 单列
gas_paid: receipt 可得
net_ex_internal_bribe = rough_valued_pnl - gas_paid
```

`net_ex_internal_bribe` 是上界，漏内部 coinbase transfer。

trace 后才允许：

```text
coinbase_transfer
effective_bid = priority_fee + coinbase_transfer
gross_before_bid
net_after_bid
net_full
```

Live Loss 必须尽量区分：

```text
gross 更低 = no_alpha / path 差
gross 接近但 bid 低 = bid_too_low
对手有 borrow/LP/peg leg = path_unsupported 或 capital_edge
```

## 10. Addressability / our gap

每个高价值 path 必须输出：

```yaml
our_support: supported | partial | unsupported | unknown
replayable_by_us_now: true|false
addressability:
  - public_state_replayable
  - needs_new_adapter
  - needs_borrow_source
  - needs_inventory
  - offchain_cex_required
  - needs_private_orderflow
  - not_replayable
opponent_edge:
  - routing_edge
  - capital_edge
  - inclusion_edge
  - pricing_edge
  - contract_edge
  - private_flow_edge
our_gap:
  - missing_adapter
  - missing_template
  - missing_borrow_source
  - missing_builder_coverage
next_action:
  - replay representative tx
  - add adapter
  - add searcher template draft
```

## 11. Fixture 最小集

MVP CI 只保留硬 fixture：

| fixture | expected |
|---|---|
| wstUSR tx `0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970` | `flash→borrow→swap→repay` |
| BEL token `0xA91ac63D040dEB1b7A5E4d4134aD23eb0ba07e14` | borrowable=0，标不可执行 |
| block 25411620 sandwich pre/victim/post | confirmed sandwich excluded |
| LP-positioned tx **TBD** | `mint_lp -> arb/swap -> burn_lp`，不得误判普通 JIT/sandwich。**Phase 1 先用人工 fixture/代表 tx;真实链上样本找到后再补入 CI,不卡 Phase 1** |
| router false positive **TBD** | router_or_solver_domain=true，降权。**同上:真实样本补后入 CI** |

fixture 断言不只看 label，还要断言：

```text
canonical_action_sequence
evidence object
cluster edges
exclusion reason
rough pnl fields
```

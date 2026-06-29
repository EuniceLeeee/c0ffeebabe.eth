# MEV 对手策略分类口径(taxonomy)

> 这是 `analysis/` 分类的**唯一口径源**。实现中途可重构代码,但**这些口径不变**。
> 所有"排除"条件都写成可编码的布尔判定,classify 直接照此实现。

## 0. 四个正交维度

每笔 tx 同时打 4 个标签,互不混淆:

| 维度 | 取值 |
|---|---|
| **A 资金来源** | `flashloan(morpho/balancer/aave/univ3-flash/maker)` · `self-funded` · `flash-mint` |
| **B 路径形态** | `swap-loop` · `flash→swap→repay` · `flash→borrow→swap→repay` · `+LP(mint/burn)` · `peg/redeem/wrap` |
| **C 策略类型** | `pure-backrun` · `backrun+LP` · `atomic/standing` · `liquidation-adjacent` · `sandwich(排除)` · `directional/cex-dex(排除)` |
| **D 足迹** | tokens · venues(univ2/3/4,curve,balancer…) · protocols(Fluid/Morpho/Aave/Maker-Sky/Pendle…) |

### 0.1 高召回候选池分层

候选池追求**不漏**,分类追求**不污染**。`EOA → contract` 可以先进池,但**不等于 MEV**,更不等于
backrun。所有报告必须区分"进入候选池"和"确认可寻址利润"。

分层标签:

| 层级 | 含义 | 是否进入 addressable ratio |
|---|---|---|
| `execution_candidate` | 高召回入口。成功 tx,`from` 是 EOA,`to` 是合约;live-shadow/目标区块模式可仅凭这一条入池。 | 否 |
| `mev_candidate` | 候选 tx 触碰 DEX/借贷/LP/flash/peg 场所,或出现多 token/多 venue/正向 delta 等便宜信号。 | 否 |
| `backrun_candidate` | 满足 §2.3 的 victim 因果条件,且未被 sandwich/directional 排除。 | 可进入候选口径 |
| `confirmed_backrun` | `backrun_candidate` 经路径/PnL/人工或金标准规则确认后晋升。 | 是 |

批量历史模式为控成本,可要求 `execution_candidate + 至少一个便宜 MEV 信号` 才进入深一层分析;
live-shadow/目标区块模式可以更宽,把同块 `EOA → contract` 全部放入候选池,再用后续分类 false 掉。

### 0.2 Seed address 第一页预筛

给定一个 EOA seed 地址时,先用 Alchemy/RPC-compatible 分页交易查询拉**第一页历史交易**做低成本画像。
这一步只判断"像不像 executor/operator 地址",不判断 MEV 真相。

预筛信号:
- `eoa_contract_call_ratio`:第一页成功 tx 中,`from=seed EOA` 且 `to=contract` 的比例。
- `contract_reuse_ratio`:是否反复调用少数 executor/strategy 合约。
- `known_venue_touch_ratio`:这些 tx 的 receipt/logs 是否触碰已知 DEX/借贷/LP/flash/peg 场所。
- `plain_transfer_ratio`:纯 ETH/ERC20 转账、CEX 充值/提现、claim 等非执行类交易比例。

预筛输出:
```
seed_profile = executor_like | mixed | low_signal
```

建议:
- `executor_like`:第一页大多是 `EOA → contract`,且复用少数合约 → 继续归簇和 P0。
- `mixed`:继续跑候选池,但降低优先级。
- `low_signal`:默认不深挖,除非该地址来自 live-shadow 竞争者或人工指定。

候选池不变量:
- `execution_candidate` 的 count 可以很大,但不得计入 `addressable_profit_ratio`。
- unknown / excluded / unpriced 必须单独披露,不得混进 `pure-backrun`。
- 只有 `backrun_candidate` / `confirmed_backrun` 可以服务"我们能不能学"这个问题。

## 1. 研究策略簇 / 模板大类

> 这些是"研究单元",**不是单一维度**——每个簇是 A/B/C 的组合。下面每类显式标注它在
> 四维上的取值,避免把资金来源/路径形态/策略类型混成一坨。

1. **Pure Backrun Swap Arb** — victim 打歪池子后,bot swap 回正。
   `A=self-funded|flashloan · B=swap-loop · C=pure-backrun`
2. **Flashloan Swap Arb** — flash 一个 token 做 swap 闭环再还。
   `A=flashloan · B=flash→swap→repay · C=pure-backrun|atomic`
3. **Flashloan Borrow-leg Arb** — 带借贷腿(Fluid/Aave/Morpho 抵押借款定价),wstUSR 案例属此。**最高 alpha**。
   `A=flashloan · B=flash→borrow→swap→repay · C=pure-backrun|atomic`
4. **Backrun + LP / JIT** — 同块 mint/burn LP:`mint→victim→burn` / `backrun→LP rebalance` / `withdraw→swap→redeposit`。
   `A=any · B=+LP · C=backrun+LP`
5. **Oracle / Peg / Redemption** — 脱锚、预言机滞后、PSM、redeem、wrap/unwrap、staking share price。
   `A=flashloan|self · B=peg/redeem/wrap · C=pure-backrun|atomic`
6. **Liquidation-Adjacent** — 清算不做,只分析"清算后 AMM 偏移的 backrun"。
   `A=any · B=swap-loop · C=liquidation-adjacent`

## 2. 排除口径(可编码布尔)

### 2.1 Sandwich(排除,主口径不计)
判定基于 **entity cluster**(见 §3),非单地址。满足以下组合即标 `sandwich`:
- 同 cluster 在**同一 block** 出现 ≥2 笔,且
- 一个非 cluster 的 victim tx **居中**(cluster.pre.index < victim.index < cluster.post.index),且
- pre 与 post 的 token 方向**高度对称**(pre 买入 X、post 卖出 X,同一 pool/对)

> 退化情形:同 block 内**两笔不同地址、方向对称、夹一个 victim** → 标 `sandwich_suspect`,也排除主口径但记 confidence。

### 2.2 Directional / CEX-DEX(排除,但保守)
- receipt/logs 阶段只标 `directional_suspect`,**不过早强判**。
- 依据:链上**不成环**(入 token ≠ 出 token,单边库存变化)+ **无 victim 依赖** + **无 flash 闭合**。
- 报告必须显示 `excluded_confidence`;理由记为"对手腿在链下不可观测 / 不可复现"。

### 2.3 Pure-backrun 正向判定(可编码,防 standing arb 混入)
标 `backrun_candidate` **必须全部满足**(否则降级,见下):
1. **同块前序 victim**:存在非本 cluster 的 tx,`victim.index < bot.index`,同 block。
2. **共享 pool/token**:victim 与 bot 触碰同一 pool 或同一 token 对。
3. **方向性 price impact**:victim 对该 pool 造成单向价格偏移(reserves/sqrtPrice 朝一个方向移动)。
4. **bot 反向修复/获利**:bot 的方向与 victim 偏移相反(吃回错位)。
5. **无 cluster pre-leg**:本 cluster 在该 block 没有 victim 之前的腿(有 → 是 sandwich,不是 backrun)。

三态输出,**不要二元过激**:
```
backrun_candidate   # 1-5 全满足 → 进细分类
excluded            # sandwich / directional / standing / liquidation
unknown             # 条件部分满足/victim 不明 → 暂不深挖,除非利润高
```
> 缺 #1(无同块前序 victim)但仍成环获利 = `atomic/standing`,归 excluded,**不得混进 pure-backrun**。

## 3. Entity cluster(实体簇)

PnL 与策略归属的对象是**簇**,不是输入的单个地址。簇的成员关系(任一成立即归并):
- 同 executor 合约
- 同 funder(首次 gas 来源 / 资金注入源)
- 同 profit receiver(利润最终归集地址)
- 同 block 内协同(pre/post 同收益归集)

> 不做簇 → 利润漏到 receiver、或把 executor 误判成亏损。

## 4. PnL 口径(关键,防污染)

- **raw_deltas**:永远保留每个 token 的原始 delta(不同 token 不相加)。
- **valued_pnl(usd/eth)**:仅**稳定币 / WETH / 可可靠报价 token** 参与求和;`unknown/unpriced` token **单列,不进主口径 ratio**。
- **两层利润**(因为 P0 不 trace,内部 coinbase 转账拿不到):
  - `net_ex_internal_bribe`:无 trace 粗口径 = token delta − gas(含 priority fee)。**这是上界,系统性高估**(漏内部 coinbase bribe)。
  - `net_full`:trace 后完整口径 = 再减去内部 `coinbase transfer`。
- **同源 + 同估值**:`addressable_profit_ratio` 的分子分母必须都用我们 PnL、同一估值口径。zeromev/eigenphi 只给"桶标签",**利润数一律我们算**。

**分母防失真**:用"正向可估值利润"求和,亏损与 unpriced 不污染主口径,单独报。
```
positive_valued_net(set) = Σ max(valued_net(tx), 0)   # 仅可报价 token

addressable_profit_ratio =
  positive_valued_net(pure-backrun ∪ backrun+LP) / positive_valued_net(ALL-mev)
  (同源、同估值、cluster 聚合)

# 单独披露,不进主分母:
losing_valued_net (Σ min(valued_net,0))、unpriced_raw_delta_notes
```
- 若 `positive_valued_net(ALL-mev) == 0`(无任何可估值正利润)⇒ ratio 记 `n/a`,cluster 标 `unpriced/observe-only`。
- `ratio < 10%`(或 `n/a`)⇒ 该 cluster 标 `observe-only`,**不进 Phase 5 深挖**。

## 5. 金标准 fixture(CI 回归,pin 到 tx hash)

| 名称 | pin | expected |
|---|---|---|
| **wstUSR**(成功金标准) | tx `0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970` block 24710788 | C=`pure-backrun`(借贷腿), B=`flash→borrow→swap→repay`(Morpho flash wstUSR → Fluid deposit/borrow → PSM/Curve → 买回 wstUSR → repay), PnL 区间见 CLAUDE.md(~273 wstUSR + ~0.078 WETH) |
| **BEL**(不可借/不可复现基准) | token `0xA91ac63D040dEB1b7A5E4d4134aD23eb0ba07e14` | `borrowable(BEL)=0`(Morpho+Balancer 余额均 0)⇒ flashToken=BEL 的路由判定为不可执行/排除 |
| **multi-address sandwich** | block 25411620<br>pre  idx0 `0x972c33f25a9bbab96ed7c100f233fdf246d6d3a8055e1b4c675ae6994d56e562`<br>victim idx1 `0xaca468a9762f52e9b1c1c74d75ed2d310686fe4cf855d399ea07d87dee9f39fc`<br>post idx2 `0x1ae11d530ccdc0659349c368c922cfe73a7eebd153d2a57f7b5c7edb891e4695` | C=`sandwich` 并排除;cluster 检测把 idx0/idx2 归同簇(断言:`idx0.from==idx2.from` ∧ `idx0.to==idx2.to`,均 `0xae2Fc483…`→`0x1f2F10D1…`);victim 居中 idx0<idx1<idx2 |

> BEL 的 fixture 是 **token 级**(borrowable=0),不是落地 tx——它本是我们被拒的候选,不是链上成交。

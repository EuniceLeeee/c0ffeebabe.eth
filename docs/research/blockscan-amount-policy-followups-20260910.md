# Blockscan 金额策略：两个独立待办与外部实现对照

记录日期：2026-09-10。状态：**分析已完成；生产实现未修改；下一轮处理，未经批准不启动运行。**

## 范围与版本

- impl：`278c06e2ae86ca9e72df55de89e5b330c36cc456`。
- Sui：`fuzzland/sui-mev@462bb2b24caec403da62f9ce8104039fbd30a3fa`。
- Artemis：`paradigmxyz/artemis@4bb158070833ec2b789a2ece14c896c4b28ce3be`。
- 本轮重新只读获取两个外部仓库并检查实际金额选择代码，没有运行外部代码或交易脚本。
- 用户要求把既有的盈利下限问题与本次发现的搜索域问题分开记录，留到下一轮修复。本文不是修复验收，也不替代实施审批。

## AMOUNT-01：可切换的盈利参考下限

状态：用户已明确两种模式，待实现。

```ts
effectiveMin = mode === "original" || profitMin === null
  ? originalMin
  : max(originalMin, profitMin);
```

- 只有 `original` 与 `max(original, profitMin)` 两种模式，不增加 gas-only 模式。
- 保留 Exact 与 Solver 各自的原金额规则；Exact 是单次试探金额，Solver 是网格与细搜的金额边界，不能把二者当成同一个常量。
- `profitMin` 来自既有 mid 的 Token→WETH 参考估值、已有区块头和可用耗气估计；按假设的 5% 收益计算覆盖 gas 的参考额，不是保证真实盈利。
- 当前 blockscan 起点保留 WETH、USDC、USDT、DAI；通用估值支持 WETH 自身、直接有向兑换和最多三跳。没有可靠依据就不产生新下限。
- 仅内存缓存，不修改四张表，不增加 RPC 补数，不增加搜索后的补测阶段；报价点数上限、细搜次数和 deadline 不借机增加。
- 新模式约束初始网格和后续细搜，不能细搜又落回新下限以下。超过已有容量上限须明确标记无可搜索区间，不得提高上限或伪装为已经覆盖 gas。
- 旧模式走原逻辑，可跳过新估值工作；切回旧模式应恢复旧行为。
- 代价需要明示：新模式主动放弃部分小额搜索，高收益率小额机会可能因此丢失。最终 sim/EV 与真实资金守恒约束不变。
- **AMOUNT-01 不自动解决 AMOUNT-02。** 增加下限不等于已有搜索域会正确扩展；当新下限高于旧网格上界但低于容量时，不能仅过滤旧网格后错误地认定整个可行域为空。

## AMOUNT-02：Exact 小金额被绑定成 Solver 唯一搜索中心

状态：**窄搜索域机制已确认；真实漏盈利量尚未验证，待下一轮设计与修复。**

### 当前实现证据

[Exact 金额](../../listener/src/searcher/detector/blockscan-candidate-refinement.ts#L821)：

```ts
C = min(coarseSearchCenter, maxInput);
P = max(9n, C / 1024n);
```

其中 `9n` 是输入 Token 的 9 个最小单位，`C` 是粗金额参考，不是已经证明可执行且盈利的最大金额。

[Exact 通过后的改写](../../listener/src/searcher/detector/blockscan-candidate-refinement.ts#L480)把 `searchSeed.searchCenter` 改成 `P`。
[Solver](../../listener/src/searcher/solver/solver.ts#L831)直接读取这个值作为中心。

[Blockscan 默认配置](../../listener/src/searcher/blockscan-solver-search-config.ts#L7)：`gridHalfWidth=2`、`gssMaxTries=4`。
[初始网格及细搜](../../listener/src/searcher/solver/solver.ts#L391)：

```text
网格：P/4、P/2、P、2P、4P
若最佳网格点为正：在 best/2 … best*2 内细搜一次
```

在 9 raw 下限不主导、没有更紧上限且采用上述默认配置时：

- 初始最大网格点约为 `4P = C/256`，即 `C` 的 0.390625%。
- 细搜区间上界最多约为 `8P = C/128`，即 `C` 的 0.78125%。
- 上界只是区间边界，不代表实现一定实际报价到该端点；deadline、失败和上限裁剪可能使实际覆盖更小。
- 细搜不会反复向更大金额扩张。配置覆盖值和极小整数情形会改变这些比例，不应泛化成所有历史 live 的精确值。
- 这里的单次细搜是每个既有 debt 参数候选各自的一次；Planner 的 Funding 上限还能进一步缩小金额域。Exact 若算出的 `P>C` 会直接不通过，不能把 9 raw 下限当成绕过容量的例外。

假设 `C=1 WETH`（仅数学例子，不是链上容量证明）：

```text
Exact P：0.0009765625 WETH
网格：0.000244140625、0.00048828125、0.0009765625、0.001953125、0.00390625
细搜理论区间上界：0.0078125 WETH
```

### 为什么不能只改大一个数字

锚定变更来自 `341e0cdfd54662db71f4775e0e9b20dd7ec462e4`，意图是避免把 Solver 从唯一已验证的小额点直接推到未经验证的粗容量附近。该保护有合理动机，不能仅凭当前疑虑回退它。

本次问题是：**已验证的采样点兼任唯一搜索中心，配合局部窄网格，把其他金额区间排除在正常搜索之外。** 小金额并非必然不合理，大金额也可能因为滑点更亏；实际损失须靠同状态证据判断。

下一轮设计方向（不是已批准实现）：

1. 区分“已报价采样点”与“Solver 搜索域”。保留成功小额证据，但不要由该点唯一决定全部搜索范围。
2. 在不增加原定总报价预算的前提下，比较覆盖多个数量级的选点与当前局部网格；保留原功能和安全门，不以扩大并发替代设计。
3. 明确新下限、原金额参考、Funding/路线容量与细搜区间的关系，避免只过滤旧点、全变成同一个点或直接跳到容量上限。
4. 分开验证 Exact 单点筛选导致的提前淘汰，以及 Solver 已入选路线的金额域遗漏；仅调整 Solver 无法救回 Exact 已淘汰路线。
5. 若交接已有 Exact 采样结果，必须保持金额、路线、source/hash、费用及执行上下文一致，不能跨块继承成功 authority。
6. 原模式、新金额域、仅盈利下限、组合模式分开对照，避免把两项收益/退化混在一起。固定状态记录实际报价点、最终金额、gas、sim/EV 与耗时；新 live 另行授权后验证。

## 外部实现如何确定金额

### Sui：跨数量级粗搜，最佳点附近再细搜

[arb.rs:142](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/arb.rs#L142)：

```rust
let starting_grid = 1_000_000u64;
for inc in 1..11 {
    let grid = starting_grid * 10u64.pow(inc);
    // spawn ctx.trial(grid)
}
```

- `starting_grid` 的注释是 0.001 SUI，但循环从 1 开始，**实际第一个点是 0.01 SUI**。
- 实际 10 点为 `0.01, 0.1, 1, 10, 100, 1000, 10000, 100000, 1000000, 10000000 SUI`。
- 先并发试这组金额，选盈利最好点；没有正收益粗点则退出。
- 开启 `use_gss` 时，在最佳金额的 `1/10 … 10倍` 继续细搜。
- [通用细搜实现](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/common/search.rs#L141)允许最多 1000 次循环迭代，不能当成我们的低 RPC 预算实现。
- [完整 SUI 闭环的目标值](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/defi/mod.rs#L357)是 `amountOut - amountIn - gasCost`；不等同于包含全部后续 bid 的生产净 EV。
- [trial](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/arb.rs#L290)每个金额还会选择买入路径，再组合兼容卖出路径；不是对 impl 同一个固定闭环执行完全相同的工作。

可借鉴：先让有限采样覆盖有意义的金额区间，再局部细搜；已发现路径在同次任务中复用。
不照搬：SUI 的绝对金额、10 个点/1000 次循环、只选最佳买入路径的策略与本地模拟成本假设。

### Artemis：固定金额梯度，提交多个候选 backrun

Artemis 是框架，本文比较其 Token 套利示例 `mev-share-uni-arb`，不是声称所有策略共用一个 Solver。

[strategy.rs:124](https://github.com/paradigmxyz/artemis/blob/4bb158070833ec2b789a2ece14c896c4b28ce3be/crates/strategies/mev-share-uni-arb/src/strategy.rs#L124)：

```text
sizes = [10^5, 10^6, ... , 10^18]  // WETH wei，共14个金额
```

- 对应 `10^-13 … 1 WETH`，每次十倍；不是按池容量除以 1024，也没有本地金额细搜。
- 为每个金额构造独立 backrun bundle 提交给 matchmaker，README 明确称其为盲猜金额。
- 读取 gas 单价用于交易参数，固定 gas limit 为 400000；不据此推导盈利投入下限。
- [合约](https://github.com/paradigmxyz/artemis/blob/4bb158070833ec2b789a2ece14c896c4b28ce3be/crates/strategies/mev-share-uni-arb/contracts/src/BlindArb.sol#L73)检查 WETH 余额获利/coinbase 支付后的余额，但不等价于本项目包含交易 gas 的 final EV。
- 另一个 `opensea-sudo-arb` 示例根据 NFT 挂单价格与池买价决定交易，不提供通用 Token 多金额 Solver。

可借鉴：固定预算中放入跨度不同的金额点。
不照搬：14 笔盲提交、固定绝对 WETH 梯度、把 builder 的筛选成本当成本地提速。本轮没有签名或广播。

## 检查与证据边界

- 直接读三个固定版本的源码，并检查 impl 锚定变更的提交历史。
- 本地纯算术检查通过：默认网格/GSS 上界、1 WETH 示例、Sui 10 点范围、Artemis 14 点范围。未执行两个外部项目。
- 按 `solver,center` 能力查询生成当前工具清单，检查推荐项与替代项，再通过 tool-run 执行：
  - `listener:searcher:blockscan-solver-center`：PASS 2/2。
  - `listener:searcher:blockscan-solver-search-config`：PASS 7/7。
- 本地执行清单：`logs/amount-search-review-20260910-tools.json`。
- 清单 SHA-256：`7bcd2f1e3895ce8b13c9757f61013cec951b1ed04e9be12dca4d17798b3e04ae`。
- 上述是现有行为的本地验证，不是修复通过、链上盈利、漏机会量或时效性改善证据。未改生产代码，未运行 rebuild/live、链 RPC、签名或广播。
- 独立只读审阅者核验了三个版本与上述源代码，并执行比例、两套外部网格、单位与 9 raw 边界检查；确认窄域结论，同时指出细搜上界不是实际覆盖、1000 是 Sui 循环次数而非总报价次数。相关限定已纳入本文。

## 下一轮入口

先读本记录，确认 AMOUNT-01 与 AMOUNT-02 各自的实施范围。不要恢复已经否决的“原搜索之后额外补测”，不要加入 gas-only 模式，不要让中央出现协议地址/Family 特判。先确定固定报价预算内的新金额域，再单独验证可切换下限；两项可以共用通用金额边界入口，但应能分别开关、定位回归。

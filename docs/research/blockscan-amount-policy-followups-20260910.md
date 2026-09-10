# Blockscan 金额策略：两个独立待办与外部实现对照

记录日期：2026-09-10。本文包含原始分析及后续实施决定；以本节最新合同为准，下面标注的旧基线不是当前实现。

## 本批最新合同（2026-09-10 用户批准）

- Exact 单点 `P=max(10 raw,G)`；G 缺失明确取 10，不再除以 1024，不修改其他模块共用的 9 raw。
- G 读取**本轮枚举的 minSpreadBps**，不是写死 5%。枚举默认交易对及完整闭环都要求大于 200bps（2%）；Exact 独立 50bps 准入守卫不变。
- `G=floor(gasWei*10000*rate.den/(minSpreadBps*rate.num))+1`，小数 bps 通过有理数换算。rate 是 WETH wei / 投入 Token 最小单位，不再次乘 decimals。G 是参考点，不能保证最终净收益。
- 消费已有固定源 mid（最多三跳有向连接、已发布剩余手续费仅一次）、已有区块头的 nextBlockBaseFee、同进程源/hash 校验通过且毛利为正的成功 final sim 耗气量；在 EV 拒绝前记入，因此负 EV 也能提供样本。
- 路线级 gas 取最大已观察值，保留来源；每个配置固定的 live 进程独立拥有有界内存，重启不继承。既有样本不代表所有 Funding/模板的精确耗气量。
- 多实例同向汇率取较低中位数；同逻辑实例的执行变体只计一次。优先最短跳数，同跳数路径仍取较低中位数，不通过循环放大估值。仅为金额参考，不替代最终 EV 估值。
- 输入缺失或 mid 与 Exact 源/hash/generation 不符就无 G，不额外查询或沿用旧块结果。本轮参考值冻结；观察到重组时清空 gas 记录。无可用样本时不扫描全图计算无用估值。
- Exact 仍检查 `min(coarseSearchCenter,maxInput)`。P 超限记 `amount_reference_over_cap`，不报价、不压小 P、不进入 Family 失败预算或 deadline fallback。
- Solver 默认四点 `P,5P,10P,15P`，继续使用原裁剪、去重和 GSS。`SEARCHER_BLOCKSCAN_SOLVER_AMOUNT_GRID=geometric` 仅切回旧 Solver 网格，不恢复 Exact 的 /1024。
- 不增加 RPC、四张表字段、搜索后补测、并发或 GSS 预算；不改 Adapter、rebuild、Graph、mid 发布合同、final sim/EV。中央不增加协议/地址/ABI 特判。
- 这只是起点及初始网格的实验，完整搜索域、Exact 单点淘汰与完整结果交接仍在 AMOUNT-02。缺 G 的 10 raw 冷启动及旧 coarse ceiling 限制均保留。
- 用户本批另行授权：复用现有 Ready 开不广播 live，至少观察 50 个连续 source 高度（启动预热另记，缺失/取消照计）；若前 50 块无 final sim，继续至首次 final sim 完成。保留用户停止、明确 Alchemy 限流/额度错误、进程失败的安全停止；不自动重建或切换上游。本轮不是配对 A/B，不据此宣称时效性或盈利已修复。

### 启动前验证

- 完整 build、完整及 live 类型检查、金额参考、Exact、Solver 四点网格、金额搜索、deadline、顺序流水线与报价并发回归通过。
- 独立复核第二轮通过：超限候选在 deadline/Family 调度前排除；历史 gas 必须沿已观察的连续 parent hash 证明为当前源的祖先，断档时无 G。两项均有回归测试。
- 历史 grid 对比工具未记为通过：所选旧 Solver 已包含 handle 复用，不满足该工具针对更早基线的调用次数假设；不能据此声称配对性能改善。
- 现有 Ready 的所有 active Family 定义 hash 兼容，文件未变，不需要 rebuild。此处仅证明 implemented；live 的 sim/EV 结果单独记录。
- 本轮完成后独立分析最靠后的实际样本：sim 失败定位执行失败；sim 成功而 EV 拒绝分解毛利及成本；EV 成功核对执行和收益证据，不自动扩大本批修复范围。

## 范围与版本

- impl：`278c06e2ae86ca9e72df55de89e5b330c36cc456`。
- Sui：`fuzzland/sui-mev@462bb2b24caec403da62f9ce8104039fbd30a3fa`。
- Artemis：`paradigmxyz/artemis@4bb158070833ec2b789a2ece14c896c4b28ce3be`。
- 本轮重新只读获取两个外部仓库并检查实际金额选择代码，没有运行外部代码或交易脚本。
- 用户要求把既有的盈利下限问题与本次发现的搜索域问题分开记录，留到下一轮修复。本文不是修复验收，也不替代实施审批。

## AMOUNT-01：gas 参考起点（旧模式提案已被上方合同取代）

状态：本批按上方合同实现。下面的两模式提案是历史讨论，不再作为实施要求。

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

### 原基线实现证据（不是本批改动后的公式）

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

先读最新合同及实际代码，不恢复旧模式提案、/1024 或已经否决的“原搜索之后额外补测”。下一轮讨论 AMOUNT-02 的完整金额域、冷启动及单点淘汰；不让中央出现协议地址/Family 特判。原分析的检查记录只验证旧基线，不是本批代码或 live 的验证收据。

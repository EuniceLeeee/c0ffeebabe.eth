# Gas 参考金额：50 块 live 与事后诊断

## 结论与边界

代码已实现，完成用户授权的不广播观察。**尚无生产 EV 成功，也没有证明整轮 10 秒达标。**
本轮不是配对 A/B；金额政策和枚举门槛都改变，不能把较短 Exact 时间直接归功于性能优化。

- live 版本：`900222fbe1cfff14823f092d08b191b0639e3e64`。
- 交易对和完整闭环枚举门槛 200bps；G 读取同一个枚举门槛；Exact `max(10,G)`；Solver 初始四点 `P,5P,10P,15P`，原 GSS 保留。
- 复用 Ready generation 2：16,175 instances、32,058 edges，范围 `25923216–25937615`。当前所有 active Family 定义 hash 兼容，没有 rebuild。
- Ready SHA256：`418209d12a09dabf34eb292983850403326619b2bbf8e3fa1a366c416a9d5a70`。
- 固定观察窗口 `25944796–25944845`，完整 50 个连续 source 高度，缺失 0；启动 `25944791` 单记约 69.01 秒。
- 2026-09-10 13:18:07 +08:00 正常结束，exit 0。`25944846` 是停止期间取消记录，未纳入窗口。无广播、无签名。

## 结果与时效

| 指标 | 结果 |
|---|---:|
| 进入 Solver 的区块 | 49 / 50 |
| 进入 final sim 阶段 | 4 |
| 成功且通过模拟后 source 检查的 sim 结果 | 1 |
| 执行后因新 head 过期 | 3 |
| sim revert 记录 | 0 |
| 进入 EV / EV 成功 | 0 / 0 |

四个模拟 source：`25944797、25944808、25944812、25944841`。除 `25944808` 外均为 `blockscan_stale_after_sim`。
该分支只有模拟执行成功且毛利为正才会进入，因此这些是**过期拒绝，不是合约 revert**。

| 实际运行阶段 | 样本数 | p50 | p95 |
|---|---:|---:|---:|
| 状态准备，含排队 | 50 | 2.82 秒 | 3.93 秒 |
| 枚举 | 50 | 1.54 秒 | 1.77 秒 |
| Exact | 49 | 0.87 秒 | 1.72 秒 |
| Planner/Solver | 49 | 1.99 秒 | 2.62 秒 |
| final sim | 4 | 7.18 秒 | 7.93 秒 |
| EV | 0 | — | — |

从 head 观察到首次 Solver：p50 5.24 秒、p95 6.61 秒。fork 清理 p50 1.82 秒。
全部 50 个 terminal 的 wall time p50 14.23 秒、p95 16.63 秒；**包含取消和拒绝，不是完成整轮的耗时**。
阶段存在重叠，不能相加。50 个 terminal：36 source superseded、12 stale state、1 Exact deadline、1 phantom profit。

路线记录完整 50 份。4,741 条入选 coarse；Exact 编码状态合计 683 positive、3,572 negative、396 failed、90 unprobed。
负值编码的 margin=0 仅表示没有通过正收益筛选，不提供逐 leg 原始报价，不能据此虚构具体负收益数值。

## 最靠后样本：25944808

两跳 `WETH → 0xb2617246d0c6c0087f18703d576831899ca94f01 → WETH`：

- V2 `0xb36ec83d844c0579ec2493f10b2087e96bb65460`。
- V3 `0x4b2cde9effaa15999010e66da016b2b2c949f747`，fee 100，即 1bps。
- route ID `0x3d2f1cc315eb339f8e405f986e51eafacf7fbd041a4748f799e232a907c24c33`。
- Exact 冷启动 P=10 raw；Solver 保留的 GSS 允许超过初始 15P，最终投入 **267 wei WETH**。
- 模拟返回 374 wei，毛利 **107 wei = 1.07e-16 ETH**，gas 211,500。
- 比例 `107/267≈40.075%`，超过原有 `maxProfitBpsOfFlash=2000` 的 20% 保护，故 `phantom_profit` 在 EV 之前拒绝。

不能把保护标签当作“已证明模拟利润造假”。同区块 Alchemy reserves/Quoter 独立复算同样得到 374 wei。
已保存 mid：V2 正向 raw rate `57511.69724044736`、30bps；V3 回程 raw rate `0.000024489427798879104`、1bps。
固定读取的 reserves、slot0 与保存的 mid 一致。不是拿旧 Ready 的历史价格直接沿用。

按 source header 算下一块 base fee 为 46,061,848 wei：预计 gas 成本 `9,742,080,852,000 wei≈0.000009742 ETH`。
因此即使通过比例保护，这条极小金额交易也无法覆盖 gas。这里是事后经济计算，不冒充已执行的生产 EV 判定。

## G 生效后：价格不变不代表大金额可用

从 `25944809` 起直到窗口结束，37 个 pass 均有 1 条 gas reference；对应路线仍被枚举，但不再通过 Exact。
该源下一块 base fee 为 46,318,157 wei，复算 `G=489,814,510,275,001 wei≈0.000490 WETH`。
前后两个固定区块的目标池 reserves、slot0 相同；不能用“行情刚好变了”解释全部差别。

追加有限、只读的 Alchemy 对照：

- 10 wei 报价返回 14 wei，267 wei 返回 374 wei，与小额结果一致。
- G 经 V2 后得到 `28,085,147,558,558,242,226` raw TOKEN 进入 V3；3M 和 15M gas 的 Quoter 都未完成。
- 按生产 executor caller 固定源 trace，内部 V3 swap 为 `out of gas: out of memory`；Quoter 包装成 `Unexpected error`。
- 查询当前 tick `-106178`：`liquidityNet=activeLiquidity=4092510588610316610301`，向左越过该 tick 后 active liquidity **变为 0**。
- 当前极薄区间仅需 `38,633,876,269,371,328` raw TOKEN 即到边界，可输出约 `946,121,479,290` wei WETH；G 对应输入远超过这一段。

这提供了明确的**集中流动性断层证据**，说明不能把当前 mid 或虚拟储备当作真实可成交容量。
未穷举更深区间、所有金额，也未完整逐调用复现 live 那次 Exact 的原始返回；不宣称所有金额都不可能盈利，
不把追加 Quoter 的失败直接改写成 live 的 `negative` 根因。冷启动 G 缺失仍为 10 raw，是本批已接受、下一轮待改的局限。

## 工具复核与本批遗漏修补

主分析先读原始 events、routes、mid，再查询生成工具索引：

- query `blockscan,latency,production-events,state-coverage`；执行 `analysis:block-activity`（target 25944809/25944810）、`analysis:blockscan-window`、`analysis:blockscan-pass-latency`。
- window 工具确认 50 passes，但其 N-1 `coarse_source_block` 资格检查不适用于本轮 Source-N；没有把该资格失败说成价格缺失。
- latency 工具全进程含 startup/停机项；裁掉 anchor 的调用按设计不计样本。因此正式 50 高度统计来自预先冻结窗口的结构化事件，而非挑最快区间。
- manifest：`logs/amount-reference-live.is84TQ/analysis-tools.json`，SHA256 `82caf470bd8aacc215c2882c29c3beb1a1930206ca74f00a123af9172f6306f2`。
- telemetry query `blockscan,telemetry,production-events,verification`；执行 `listener:searcher:blockscan-route-telemetry`，11/11。分析 decoder 21/21 直接执行；该测试没有独立 package script，未伪造 indexed receipt。
- telemetry manifest SHA256 `c2c2506f1206a39f4ea9a02cab385b2d854a6c19818a51467a2a28430afc8805`。

新原因 `amount_reference_over_cap` 未接入紧凑日志编码的问题被独立复现：一条超限路线会使同 pass 明细整批丢弃。
已在 `6e2c8d329a9a98b6d91ebba1883c5ae1e4e51c2d` 同步 writer、worker validator、decoder，追加 code 8，保留 0–7，拒绝 9。
混合正常路线/超限路线的真实 worker 往返及 decoder 回归通过；本轮 live 未出现该日志丢弃。仅补记录，不改变报价/选择，不重启 live。
LearningCase：`tooldef-20260910-amount-cap-route-telemetry.json`。

任务启动观察器最初从 stdout 找 simulation_result，而运行时将其写入 events.jsonl。
在到达停止边界前补了任务私有的结构化事件观察器；回归及独立 13 项拦截信号检查通过，未重启生产进程。
它按 PID/start/ownership 绑定正常停止；原 supervisor 的 generic `user_or_task_stop` 由 `window-complete.json` 的正常停止证据解释。
未改生产调度、未把停止原因伪装成 Alchemy 错误。

原始现场保留在忽略目录 `logs/amount-reference-live.is84TQ/`；本报告只提交选定的公开数值和已脱敏结论。
下一轮应优先讨论冷启动参考金额和跨 tick 容量/金额搜索；本批没有擅自放宽保护或修改这两项架构。

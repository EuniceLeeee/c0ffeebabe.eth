# Family 时效性验收

新增/修改状态读取、刷新、报价或实收构造时，检查相应阶段；用户只要求查资料/改 skill 时不运行。目标是确定工作量与关键等待，不把局部测量变成整轮 live 验收。路径相对本次实际实现仓库，执行前核对当前源码和 package scripts。

## 1. 样本与比较条件

- 可复用或新建 **单块 Ready** 验证目标族的真实增量更新，不需为测速重扫 14400 块。已有较大 Ready 可只读复用；指纹失效就在副本选择性重验并重建/校验 Graph，不跳检查。
- 前后对照默认 **3 个有代表性的真实变化块，每块各 3 次，逐块取中位数**；另选无关变化/无变化块作负对照。用户限定单块或更小预算时按其范围执行，报告为单块局部结果，不强行扩充样本。缺失/失败不能靠换块补成通过。
- 测量前选定样本，固定源码/配置、区块 hash、Ready 拓扑、amountIn 规则、调用者/执行器、预算、并发和 RPC/机器条件。前后版本使用各自有效的 Ready 指纹，但目标边对象应一致；改少池子或下架一族必须标明，不算相同负载优化。
- 价格正确性对照保留 token/方向、amountIn/out、status 与实际报价来源。纯性能修改要求同输入语义输出一致；同时修正错误数学时，先以独立同状态询价/执行证明新输出，不能强求等于旧错误值。

## 2. 必须走生产调度，计时边界不能另造

当前公共入口是 `listener/benchmarks/live-stage.ts`，由 `BlockScanRuntimeLoop.schedule()` 驱动 live 阶段、`waitForIdle()` 收尾。薄 CLI 可传历史输入和停止边界；不得自己重组触发、报价队列、选额调度、取消、预算或缓存生命周期。

| 测量项 | 生产边界及应报时间 | 不包含 / 不证明 |
|---|---|---|
| effective 增量更新 | 收到待测 head → 区块/log/trace 读取、匹配、状态/报价更新 → 价格发布；报告 `publicationReadyMs`，同时保留含 drain 的 `stageMs` | 不是单个 `eth_call` 耗时；不含 Ready 加载、首次预热 |
| sim 选额 | 生产 `onSizingStart` → 金额构造、试算、粗/细搜、候选队列和 drain；报告 `stageMs`，原生 `plannerSolverMs` 作辅助 | 不把状态准备/枚举前置加进来；不含独立 final sim/EV |

当前停止参数 `through=prices` / `through=solver` 中的旧名称 `solver` 不代表改走独立旧 Solver；核对实际使用的生产选额器及 `sim_amount_construction.mode`。支持实收的路线应为 `runtime-actual`，Exact 调用为 0、无 quoted fallback；回退路线必须单列，不能混称“不逐跳”的测速。

预算、取消、新块调度和收尾仍归生产代码。显式放宽实验预算时同时保留原值/覆盖值；“更久后全部返回”可测完成成本，不是满足实时区块期限。

## 3. 前置缓存与冷热口径

- 历史热更新先完成真实前驱块的准备；首块预热、Ready/执行器加载、缓存恢复、输入校验分别记录在前置，不计入阶段中位数。不能预热待测块的报价，再把复用时间写成更新速度。
- 前置缓存须绑定当前源码兼容指纹、Ready、配置和区块 hash；由生产代码恢复状态/表/候选，不能直接注入另一个测试调度器的结果。缓存不兼容只补必要前置，不篡改 manifest/hash 来过校验。
- `--input-cache` 只缓存前置 RPC 输入；**待测 effective 更新请求、sim 试算仍访问真实 backend**。缓存 miss 的现有行为是拒绝，不偷偷回源填补。记录缓存模式、恢复耗时、loopback 转发开销和不可控的 provider 热缓存。
- 每次重复独立恢复生产初始状态，避免失败实例隔离、负缓存或残留预算减少下一次工作。统计 fresh、carried、failed/disabled 行；表 complete、行 quoted 都不保证这轮重新报价。
- Family 的 N 状态＋N 环境执行对照，与热更新 benchmark 的生产环境是不同实验。后者现用 source N / production next-block N+1；如需另一环境须明确选择，不混用两者结果。

## 4. 从日志拆分真正的慢点

优先使用现有可选诊断记录；缺定位证据再在授权范围内补日志，不预判都是 RPC 或都是某个 Family。

至少区分以下层级，并关联 Family/实例/方向、source、任务/批次 ID 与方法/selector（不输出 RPC 密钥）：

| 层级 | 回答的问题 |
|---|---|
| 变化输入 | 区块头、logs、trace 各自何时开始/返回，匹配多久；是否已并行 |
| 刷新工作量 | 哪些实例/方向 fresh、哪些 carry，多少任务启动，谁在最后拖尾 |
| 请求 | 逻辑声明次数、memo 命中、去重后物理 call 项、HTTP 批次数、依赖轮次分别多少 |
| 等待 | permit/限速排队、发送后自身响应、重试/退避各耗多久 |
| 本地 | decode、哈希/数学、构造/发布及收尾耗时，哪些在关键路径 |

例如 147 个逻辑请求去重成 21 个 call 项，不是 21 次 HTTP；1024 项外层任务并发也不代表一次 RPC。并行 span 重叠，不能逐族相加当整块耗时。HTTP batch 响应只能定位慢批；没有更细证据时不能确定批内哪条调用慢。

优化按已证明的依赖关系选择：同状态共享读取/重复校验计算合并；无依赖的报价与 guards 同轮声明；在请求前排除语义上无关的刷新。真实依赖可保留多轮，不强行“所有协议一轮”。统一 request runtime 执行调度，Family 不自建私有队列；source/代码/拓扑/rate/ramp/到账安全门不删除。刷新正负例见 [验收入口：依赖与状态变化](acceptance-entrypoints.md#六依赖与状态变化)。

## 5. 当前测速入口

先按项目要求选择/记录 tool-index、tool-run 入口；当前脚本示例如下，不表示本轮必须执行：

```bash
# listener 目录；使用已批准的配置。三次重复以参数显式指定，工具默认是一次。
SEARCHER_DRY_RUN=1 npm run benchmark:effective-update -- \
  --ready "$FAMILY_CHECKPOINT" --heads "$FAMILY_HEADS" \
  --out "$FAMILY_EFFECTIVE_BENCH_OUTPUT" --env-file "$FAMILY_ENV_FILE" \
  --repetitions 3 --latency-diagnostics --save-prices

SEARCHER_DRY_RUN=1 npm run benchmark:sim-amount -- \
  --ready "$FAMILY_CHECKPOINT" --heads "$FAMILY_HEADS" \
  --out "$FAMILY_SIM_BENCH_OUTPUT" --env-file "$FAMILY_ENV_FILE" \
  --repetitions 3 --latency-diagnostics
```

- `HEADS` 为 `[{"number":N,"hash":"0x..."}]`，当前 CLI 一次接收 1–250 个连续 head。三个代表块不连续时，分别传单 head 文件，各自准备真实 N−1；不要用伪连续或陈旧前驱表凑输入。
- 实际 executor/owner、REVM、runtime-code 参数按当前 CLI/配置提供，不部署、不签名。前置缓存捕获现限 `benchmark:sim-amount --prepare-cache NEW_DIR` 且一次重复；后续匹配的阶段用 `--input-cache DIR`。不因存在旧目录就认定兼容。
- `--latency-diagnostics` 收集现有脱敏 `effective-quote-timing`、`quote-batch-*`、`strict-session-timing`、`strict-eth-call-timing` / `strict-exec` 等；收集开销在计时内，产物写盘在阶段后，比较两边使用同样设置。
- 保存声明、每次输入/结果/诊断和 summary。`latency-diagnostics.test.ts` 检查诊断采集/脱敏，不是性能通过的证据。

## 6. 结果怎样判定

按块列出三次原始值、完成/超时/中断/未到达状态及中位数。只有计划的三次都完成，才写该块的完整耗时中位数；否则保留观察耗时并标“未完整完成”。`stageMs=null` 是没到达，不是 0ms。失败不删除，也不追加成功样本替换。

分开报告：

1. **正确性**：目标方向、金额输出、source/freshness 与安全负例是否通过。
2. **工作量**：逻辑/物理请求、依赖轮次、重复本地计算是否减少。
3. **时效性**：同输入阶段耗时观察到什么变化，是否仍被慢响应或其他族拖尾。

没有目标刷新任务的负对照只证明省掉无用更新；它不能代替正例。请求变少但总耗时不稳定，照实写“工作量下降，整段提速未证实”。单块小图和顺序送入历史 head 不覆盖全图压力、真实 WS 延迟/新块竞争及下游争用；不得据此宣称整轮 live 已达标，也不自行再开 live。

# Solver 时效性复核交接 — 2026-10-01

## 先读这个结论

这是用户要求上传的**证据交接，不是优化完成／验收通过／上线批准**。内容覆盖上海时间 2026-09-30 的 live 诊断，以及持续到 10-01 的同输入实验与 Kyber 研究。未签名、未广播；本次整理不启动 RPC 或新的 live。

当前最值得复核的方向是：**复用现有统一缓存管理，让标准无 Hook V4 也能按真实金额本地报价；不是再做一套 V4 私有缓存，也不是用 effective 点价格线性外推。** 这是候选方向，尚未实现并证明 live 有收益。

## 代码与证据身份

- 工作分支：`codex/s1-unified-adapter-architecture-impl`。
- 生产源码基准：`baca79b03384a93fb656482c09a5e4de026f5fbc`。
- 整理前有 13 个 tracked 文件尚未提交，完整补丁 SHA-256：`793568b69413b2778fcdb63b9199c9528abfddda43fb7e5019e58c3ae94d7427`。
- 本次提交只上传本目录的报告／脱敏证据／补丁快照，不提交这些生产修改，不合并 main，不部署。
- [当前补丁快照](code-review/current-uncommitted.review.patch) 是供审阅的副本；**不同实验用了不同冻结版本，不能把当前补丁当成每次 live 的实际版本**。以各轮 `run-contract.json`、`source-frozen.json`、声明和结果中的哈希为准。
- [V4 读状态草稿](code-review/unintegrated-v4-local-state.ts.txt) 未接入 `exact.ts`，依赖的 `local-math.ts` 尚不存在，**未测试、未完成、不可作为可运行方案**。用户要求先交接评估，已停止继续实现。
- [manifest.json](manifest.json) 逐项记录本地来源、原始字节数／SHA-256、脱敏副本哈希、压缩分片及排除项。

## 固定配置与比较口径

P = **0.002 ETH 等值**；枚举 3×3、最多 6 跳；禁止重复 Token、允许重复池。Solver 候选报价并发 16、金额并发 8；粗搜 P／10P／100P／1000P，黄金分割细搜 8 次，保留正 P 门槛。Exact 传输 64 条／批、8 批并发；调度总并发 12，producer 预留 4。

不可通过减少搜索点、缩窄输入、丢弃慢样本、放宽 deadline、移除源状态校验、跳过独立最终 sim 或放宽偿还／守恒／EV 来宣称提速。上述是本轮主配置；每个诊断的实际覆盖、预算及唯一变量仍以其 declaration 为准。

“前序状态”在本任务中主要指**同一条候选路线的前几跳所产生的试算状态**，不是在这些 blockscan 轮次里重放 N 内真实前序用户交易。没有重复逻辑实例时省略路线前缀；有重复时从 hop0 保留完整有序前缀。V4 同一个 PoolManager 下的不同 PoolId 不等于重复池。跨池隐含共享状态仍需最终 sim 兜底，不能把逻辑池不同当成全局独立的数学证明。

## 已有数据能说明什么

### 1. 无重复实例不带前缀：受控样本明显减少无用工作

见 [same-input-primary-2-assessment](evidence/same-input-primary-2-assessment.json) 和对应 [原始结果的脱敏副本](experiments/same-input-primary-2-bootstrap-corrected/results.json)。

- 同源块 `26029536`、自然样本 rank 477，ABBA；旧 always-prefix 两次均在 30 秒总预算中止。
- 条件前缀两次完整 Solver：**5.829 秒、4.604 秒**；各 12 个金额点、8 次细搜、24 次逐跳报价，0 prefix 调用。
- 旧版本已完成的 6 个共同逐跳输出完全一致；旧版未完成，**不能宣称最终所有金额／候选完全等价，也不能给出无截断的提速百分比**。
- 重复池 local-math 控制组保持完整前缀和输出一致，但 B 更慢；这不是重复池性能胜利，也不是 Rust prefix 样本。

### 2. 最新 250 块仍没完成整批 Solver，主要在等普通报价 RPC

窗口 `26090582–26090831`，目录 [live-solver-skip-settle-250.7MsLu8](live/live-solver-skip-settle-250.7MsLu8)。见 [完整轮次汇总](evidence/third250-final.json)、[RPC 分解](evidence/third250-quote-waves.json)、[工具核对](evidence/third250-reconciliation.json)。

| 项目 | 结果 |
| --- | --- |
| 观察到的 source heights | 250 |
| 有分阶段 timing 的记录 | 246；缺 4 个高度，未当作成功 |
| 进入 Solver 的窗口 | 211；其余 35 个 timing 未进入 |
| 完成整批 Solver | **0** |
| 单路线尝试／完成／取消 | 5,206／1,851／3,355 |
| ordered-prefix 路线／Solver Rust 请求 | **0／0** |
| 独立最终 sim | 169 次，全部 revert |
| 整轮 p50／p95（246 条 timing） | 12.112／18.475 秒 |
| 状态准备 p50／p95（246 条 timing） | 7.089／17.828 秒 |
| 枚举 p50／p95（246 条 timing） | 0.537／0.740 秒 |
| Solver p50／p95（仅 211 个进入窗口） | 4.472／8.312 秒 |
| Solver 窗口内 exact RPC 区间并集 p50 | 3.679 秒 |
| 其余未归因区间 p50 | 0.791 秒；不等于纯 CPU |
| 每 Solver 窗口物理批次数中位数 | 6 |
| 批次响应 p50／p95 | 0.517／1.141 秒 |
| 批次许可排队累计 p50 | 0.069 **毫秒** |
| 标准 V4 amount quote | 29,449 次，p50 581ms／p95 1,264ms；含 4,147 次 aborted |

不同阶段的分位数不能直接相加；并行 RPC 时长必须取区间并集，不能把各请求相加。窗口时长包含取消，不能解释为“整批 Solver 完成用时”。148 块曾有正报价，**不是 148 块最终盈利**。

### 3. 其他 live 记录保留，但不是公平因果 A/B

| 运行 | 观察 | 注意 |
| --- | --- | --- |
| `live-raw-ready-250.ajvb1j` | 旧前 250 高度 `26089681–26089930`，整轮 p50 约 11.96s | 旧 binary 拒绝 trialPrefix；不可当作语义等价快基线 |
| `live-solver-unique-pools-250.YgUfBJ` | `26090073–26090322`；整轮 p50 11.975s，Solver p50 5.544s；38 次 final sim 全 revert | 整批 Solver 完成 0；该版没有逐路线 telemetry |
| `live-solver-batched-prefix-250.I49DJ4` | 正式计数窗口打开前停止；103 条非启动 timing，Solver／枚举均未进入 | 状态准备被取消；不是一次完成的 250 块测试 |
| `live-solver-skip-settle-250.7MsLu8` | 上节最新窗口 | 并非同块 A/B；带多项已记录改动 |

不要用这些不同窗口的截断中位数证明生产整体提速。

### 4. 统一原始 storage 复用：请求数改善已证，live 时效未证

见 [source-storage-offline-main-assessment](evidence/source-storage-offline-main-assessment.json)、[独立核验](evidence/source-storage-offline-result-review.json)、[ABBA 结果](experiments/source-storage-offline-2/results.json)。

- xWin 历史环境录下的字节：**父块 `26029584` 状态＋合成的 N=`26029585` 执行环境**，不是 N 块末状态，也没有重新认证链上来源。使用已保存的自然 rank 1 做选中后的生产 Solver 诊断，没有重新枚举；ABBA 四次都完成 12 金额／8 细搜／24 逐跳报价。
- storage 物理读取数 **108／9／9／108**，9 个相同源状态 slot；所有逐跳输出、候选、金额、计划一致。
- 共用缓存只保存源状态原始字节，不共享各金额已变更的试算状态；绑定 source number/hash/generation、lane、address/slot、signal 和 deadline。
- **零外部网络，无人工延迟；这是语义与请求数证据，不是 live 速度证据。** 原存档的 fork 耗时不能外推为直连 RPC 节省。

### 5. 已试过但未证明有效的方向，不要丢掉失败记录

- 64 条批次改成单条：12/12 Solver 完成且等价，但中位数 **4.834s → 5.922s**，B 只赢 2/6 对；未改默认。
- gzip：20/20 完成且等价，传输字节明显减少；中位数 **4.554s → 4.322s**，但只赢 4/10 对且 p95 **5.751s → 7.432s**，未达事先标准，代码已撤回。
- 冷前缀校验／预取／合并 hydration 等多轮，常在 P 的前两跳就达到 30s；没有进入完整 Solver。降低 RPC 数不代表整条路线已提速。
- 两个相邻 prefix 请求共用一次传输的 retained 补丁仅有窄机制证据：共同输出一致、完成 hop 的物理 envelope 24→23；全部整条 P 路线仍中止，不能视作完整 Solver 胜利。
- SAT1／xWin 重复池成功控制样本用本地试算，不是 Rust prefix 的合格性能替代品。尚未找到已成功完成、适用当前默认的代表性 remote-prefix 全路线队列。

## 缓存架构：统一管理，Family 负责语义

我们不是没有统一缓存，也不应把 V2／V3／V4 各做一套 lifecycle／失效管理。

| 层 | 当前职责 | 代码入口 |
| --- | --- | --- |
| 共用 amount/state 缓存 | 精确输入结果、源状态 request rounds、容量淘汰、source/代码/方法兼容性；有完整活动证明时才跨块携带 | `listener/src/searcher/adapter-family-exact-quote-cache.ts`、`venues/adapter-family-runtime.ts` |
| 共用传输及读取复用 | 同源 eth_call memo/batching；本轮扩展 code/storage 原始读取共享 | `strict-central-adapter-runtime.ts`、`pinned-reth-quote-backend.ts` |
| 共用试算状态隔离 | 同金额路线内承接状态，不同金额互不污染；模型缺失时保留真实有序 EVM prefix | `exact-trial-state.ts`、`venues/adapter-family-runtime.ts` |
| Family | 声明读哪些状态、事件如何影响状态、如何解码、金额数学、费用、capacity、执行编码 | 各 Family `exact.ts`／state reader／model |

V2／V3 已有本地金额模型。标准 V4 当前仍主要走 amount Quoter，不能仅因共享 manager 或近似 V3 就套公式。V4 的方向性 protocol fee、原生币、shared PoolManager 余额、跨 tick 整数舍入／覆盖和重复状态都要单独验证。

### Kyber 公共代码实际展示的分工

固定研究版本 [`0867b088e490608f731e4e37eaf49ea72e7846b3`](https://github.com/KyberNetwork/kyberswap-dex-lib/tree/0867b088e490608f731e4e37eaf49ea72e7846b3)。

1. 共用 [`entity.Pool`](https://github.com/KyberNetwork/kyberswap-dex-lib/blob/0867b088e490608f731e4e37eaf49ea72e7846b3/pkg/entity/pool.go) 容器，携带 `BlockNumber`、reserves、Family-specific `Extra`／`StaticExtra`。
2. 共用 [`IPoolTracker`／`IPoolSimulator`](https://github.com/KyberNetwork/kyberswap-dex-lib/blob/0867b088e490608f731e4e37eaf49ea72e7846b3/pkg/source/pool/iface.go) 契约：刷新 → `CalcAmountOut` → `CloneState`／`UpdateBalance`；具体协议实现放在各 liquidity source。
3. [`V4 tracker`](https://github.com/KyberNetwork/kyberswap-dex-lib/blob/0867b088e490608f731e4e37eaf49ea72e7846b3/pkg/liquidity-source/uniswap/v4/pool_tracker.go) 缓存 sqrtPrice、liquidity、ticks；依据 `ModifyLiquidity` 补读改变的 tick，保留其他 tick。无 Hook V4 simulator 复用 V3 多 tick 核心，而不是复用某个金额的点价格。
4. 试不同金额时克隆可变标量状态，只读 tick 数据可共用；同一路线应用已执行腿的 post-state，不能把某个试额的状态污染其他试额。

这能证明“**统一契约／容器＋协议模型**”，**不能据此声称 Kyber 整个平台的中心缓存服务、LRU、容量和失效策略已在这个开源库中全部公开**。

不能原样照搬：该版本 tracker 某些标量用 latest，历史 tick missing-trie-node 时会退到 latest；我们的历史／backrun 必须保持同源状态及执行环境。其单一 SwapFee、按 ticks 估计 reserves 也不能替代本项目的方向费用与 shared manager 真实余额校验。详见 [Kyber 数学审阅](evidence/v4-kyber-math-review.json)。

## 请接手窗口独立判断的问题

1. 先读详细证据而不是直接采纳结论：当前主要等待是否确是标准 V4 的普通金额报价 RPC？前缀优化对实际生产覆盖能产生多大收益？
2. 优先复用哪些已有通用缓存接口？源状态读取缓存与解码后池状态缓存是否重复？哪些失效／coverage 能力确实缺失？禁止在中央加入协议判断。
3. V4 实用方案应覆盖多金额复用、跨 tick、覆盖缺失时原金额 Quoter fallback、双向手续费／原生币／容量及 source/hash/env fencing。不能只做单 tick 近似；不允许 latest 回退。
4. **重复池模型尚未完成**：当前候选计划仍保持原有 EVM-prefix；未证明可只靠本地状态更新安全替代。若要进一步模型化，先解决共享 manager 余额和跨资源依赖，而不是偷偷取消前缀。
5. 分别测 cold 状态准备、warm 多金额计算、跨 tick／覆盖 fallback 和重复池；再做完整同输入 Solver，最终做同预算、保留所有取消的生产 live 对照。
6. 不减少 P／10P／100P／1000P、8 次细搜及 final sim/EV；只做到请求数降低或测试通过，应标记 implemented，不是 fixed。

## 验证状态与阅读方式

本轮已保留旧检查记录：source-storage 相关 287/287、实际 Rust/client 259/259、`build:live` 成功；历史全量类型检查有 8 个当时已知未改测试错误。**这些不是新 V4 草稿的检查结果，不代表当前带草稿的整树检查已通过。**

`evidence/` 是已有声明、手工分析、review、tool-index/tool-run 回执的脱敏副本；`experiments/` 是所有完成／失败实验原结果的脱敏副本；`live/` 是 4 轮日志、events、routes 和运行身份。状态文件里的“等待 V4 授权”是历史文字，用户后来已批准；当前优先级改为交接给另一个窗口判断。

压缩日志按 `part-001`、`part-002`… 顺序解压拼接即可恢复**脱敏版本的逐行记录**，没有挑选成功事件。原始日志不提交。RPC／凭据／私人路径／大段原始 hex 已替换，原文件及副本哈希不同是预期。

未上传 Ready、数 GB 完整价格表、编译二进制和重复代码 checkout，排除理由列于 manifest。本包足以做日志与代码审阅，**不是完全离线重跑 Solver 的独立输入包**；需要重跑时应先根据声明定位本机已冻结输入，不另造管线。

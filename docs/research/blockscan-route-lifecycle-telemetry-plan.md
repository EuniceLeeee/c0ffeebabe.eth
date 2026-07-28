# Block-scan Enumeration / Solver 异步日志方案

状态：`implemented_not_deployed`。离线构建、功能、故障、parser、
`tool-index/tool-run` 以及已声明的主线程微基准已通过；完整生产影响性能门
证据不足。尚未部署 live，因此不是 `fixed`。

## 1. 只回答两个问题

每个已观察 source block 只回答：

1. `Enumeration`：scanner 自发枚举出了哪些具体闭环；
2. `Solver`：哪些具体闭环实际进入了 solver。

不新增以下逐 route 日志：

- edge state / metadata；
- mid、reserve、fee 或 quote；
- exact-refine 明细；
- planner 明细；
- DFS 中间节点；
- calldata、余额或 RPC 原文。

需要 edge 或 quote 时，以日志中的 source block 和闭环定位符实时查询。现有
block-scan pass 聚合日志继续负责说明 state / exact / planner 等阶段整体是否
运行；本方案不复制它们。

## 2. “具体闭环”的最小表示

只记录能区分同 token ring 上不同 venue 组合的最小 locator：

```text
route_id
ordered token ring
ordered venue path（adapter id + poolId/target）
flash token
```

这不是 edge 状态。它只说明 scanner 当时选择了哪条闭环；不包含任何报价或
链上状态。

稳定 `route_id` 由有序 directed canonical edge identity 计算，但 canonical
edge identity 本身不写日志：

```ts
blockScanRouteId(seedEdges): sha256(
  "blockscan-route-v1" +
  ordered(seedEdges.map(blockScanEdgeKey))
)
```

`route_id`：

- 跨 source block 稳定；
- venue、pool、direction 或 adapter 不同则不同；
- 不使用只含 token ring 且带 source block 的 `cycleFingerprint` 代替。

## 3. 文件格式：业务上只有两组数据

专用 sidecar 每次 live 启动先截断旧文件：

```text
SEARCHER_BLOCKSCAN_ROUTE_EVENTS_PATH=
  /var/log/mev/events/searcher-live.blockscan-routes.jsonl
```

文件中有两种物理记录，但业务数据仍只有 Enumeration / Solver：

### 3.1 route catalog（仅用于压缩）

同一 run 中，一个不同闭环只登记一次：

```json
{
  "type": "block_scan_route_catalog",
  "run_id": "...",
  "catalog_epoch": 1,
  "route_ref": 17,
  "route_id": "0x...",
  "token_ring": ["0x...", "0x...", "0x..."],
  "venue_path": [
    ["univ3-swap", "0xpool"],
    ["curve-swap", "0xpool"]
  ],
  "flash_token": "0x..."
}
```

`route_ref` 是本 run 内的整数压缩编号。catalog 不是第三类生产信息，也不记录
edge；它只是避免每个区块重复完整闭环字符串。

### 3.2 每块 lifecycle

```json
{
  "type": "block_scan_enumeration_solver",
  "run_id": "...",
  "catalog_epoch": 1,
  "source_block": 0,
  "source_block_hash": null,
  "pricing_mode": "source_n|n_minus_one_coarse_current_n_exact|null",
  "pass_outcome": "ran|degraded|not_started|...",
  "pass_reason": null,
  "enumeration": [17, 4, 9],
  "solver": [17, 4]
}
```

规则：

- `enumeration` 按 scanner 最终 rank 顺序保存全部候选；
- `solver` 按真实调用顺序，只包含实际调用 `solver.solve` 的闭环；
- route 在调用前登记，所以 solver 返回、报错或 deadline 都不会把
  “曾进入 solver”这个事实抹掉；
- `enumeration - solver` 就是“枚举到但没有进入 solver”的闭环；
- 不为这些差集逐 route 记录 exact/planner 原因；需要时结合现有 pass
  aggregate stage / reason；
- solver 的具体结果、final sim / EV 仍以现有聚合/正式事件为准，正式
  block-scan 事件补同一个 `route_id` 以便 join。

若整趟未进入 enumeration：

```text
enumeration=[]
solver=[]
pass_outcome / pass_reason 明确为 not-run 原因
```

不得把未运行写成“scanner 运行后找不到候选”。

## 4. 每个已观察区块

`LatestHeadScheduler` 会在 busy 时用最新 pending head 替换旧 pending head。
因此只在 `runHead.finally` 写日志会漏掉被 coalesce 的区块。

实现必须给 scheduler 增加只读、可选的 drop callback：

- pending 被更新 head 替换：
  `pass_outcome=not_started`,
  `pass_reason=scheduler_coalesced`；
- shutdown 丢弃 pending：
  `pass_outcome=not_started`,
  `pass_reason=shutdown_pending_dropped`；
- 真正进入 `runHead` 的区块在 finally 写正常记录。

这里只承诺 feed 交付的唯一 head number；只有真正进入 `runHead` 并通过
`observeHeader` 后才有 canonical hash。feed 根本没交付的 head 证据不足，
不能伪造一条记录。

## 5. 生产接线点

当前实际生产边界：

```text
detectProductionBlockScanOpportunities
或 enumerateNMinusOneCoarseCandidates
        ↓
coarse.opportunities
        ↓
refineBlockScanCandidates
        ↓
planBlockScanFromSeedEdges
        ↓
solver.solve
        ↓
mandatory final sim / EV
```

只接两个点：

1. `coarse.opportunities` 确定后，按原顺序登记 Enumeration；
2. 每次调用 `solver.solve` 前，登记 Solver entered。

不得为日志新增 RPC、quote、simulate、图枚举或 planner 调用。N-1 coarse 到
current-N exact promotion 必须保持同一 `route_id`。

## 6. 异步与背压

当前 `events.ts` 使用 `appendFileSync`，本方案不能复用其同步写盘路径。新增
专用有界 FIFO writer：

- JSON serialization 与文件 I/O 在专用 worker thread；
- `runHead` 不 await writer；
- 主线程总共五个 credit：一个已发给 worker、最多四个 pending；MessagePort
  内任何未 ack 消息也占 credit；
- 同一时刻最多一个 `postMessage` 未 ack，其他 batch 留在主线程有界 FIFO；
- 没有 credit 时在构造 locator 和 structured clone 前整块 drop；
- 禁止 latest-value coalescing；
- queue 满时整块 drop，不能只删部分闭环；
- 下一条成功记录必须带
  `dropped_batches / first_dropped_block / last_dropped_block`；
- `postMessage` 同步异常、writer 错误、queue 满、worker 崩溃永不进入交易决策；
- worker `error/exit` 不自动重启，立即释放 outstanding 引用并永久 fail-open；
- 只有 queue-full 后恢复才承诺下一成功批写 gap；worker crash 或 shutdown
  timeout 只能以一次有界 stderr 声明文件 incomplete，不能伪造已持久化 gap；
- orderly shutdown 最多等 2 秒 flush；
- 专用文件启动时用 truncate 语义删除上一次 live 的内容，绝不删除或截断
  `SEARCHER_EVENTS_PATH`。

disabled 时不启动 worker、不构造 route catalog，也不创建文件。

worker 独占 route catalog：主线程批次使用本批内 route index，worker 在写盘前
分配或复用 `route_ref`，把新增 catalog 行和 block 行合并为一次顺序 append。
只有 append 成功后才提交字典更新。整写失败不会提交 catalog Map，worker
随后永久 incomplete / fail-open，因此不会出现“block 引用了从未落盘的 ref”。

启动 truncate 是唯一破坏性操作，必须同时满足：

- 路径来自非空的专用环境变量；
- `SEARCHER_EVENTS_PATH` 已启用，且 `initEvents()` 提供同一个不可变 `run_id`；
- 规范化路径不等于 `SEARCHER_EVENTS_PATH`，现存文件也不允许拥有相同
  `(dev, ino)`；
- 已存在目标必须是当前用户拥有、link count 为 1 的普通文件；
- 在同目录用 `O_CREAT | O_EXCL | O_NOFOLLOW` 取得专用单写者 lock；lock
  指向仍存活 PID 时只禁用 telemetry，绝不 truncate；
- 持有 lock 后，以 `O_NOFOLLOW` 且不带 `O_TRUNC` 打开 route file；
- 对实际 FD 执行 `fstat`，再次验证 owner / type / link count，并与正式
  events FD 的 `(dev, ino)` 比较；全部通过后才 `ftruncate(fd, 0)`；
- 只截断这个精确文件，不递归删除；
- worker ready / truncate 完成后才注册 block listener。

clean shutdown 仅由 lock 持有者关闭并删除精确 lock。stale lock 只有在确认
owner 为当前用户、普通单链接文件且记录 PID 已死亡后，才能精确删除并重新
`O_EXCL` 获取；任一校验失败只禁用 telemetry，不 truncate。lock 从安全打开
前一直持有到 worker 退出。

A/B 或其他并行 searcher 必须使用互异 route path / lock；部署 preflight 比较
规范路径和 inode。该环境变量不得作为 champion/challenger 的算法差异项，也
不能由 B 无意继承 A 的路径。

源码 `tsx` 与编译后 `node dist` 都必须能启动 worker：按当前模块后缀选择
`.ts` / `.js`，源码 worker 显式继承 `--import tsx`，并把 worker 加入
`tsconfig.live.json` 的检查范围。

初始化和退出顺序固定：

```text
initEvents
→ await route writer safe-open / truncate / ready
→ 构造 runtime loop
→ 注册 block listener

停止接收新外部输入
→ route writer 保持 accepting
→ await blockScanRuntimeLoop.shutdown()
→ route writer close admission
→ 最多 2 秒 drain / terminate
→ discovery / state cleanup
→ process exit
```

route writer 初始化失败返回 noop sink，不能阻止 searcher 启动。

## 7. 数据量

约束：

- 完整闭环 locator 每个 run 只写一次；
- 每块只写 Enumeration / Solver 两个整数 ref 数组；
- 不写 edge / quote / exact / planner 明细；
- error 只写有限 status，不写长 error message；
- 每条 batch 记录 encoded byte 数，analysis 可以投影 24 小时数据量。

每个 catalog epoch 最长 24 小时。epoch 到期后由持有单写者 lock 的 worker
安全 truncate 同一个专用文件并重置 catalog；每次 live 重启也执行相同重置。
因此磁盘只保留当前 run 的当前 24 小时窗口。

硬边界：

- 每 epoch 最大文件大小 `100 MiB`；
- 最大 catalog entries `50,000`；
- 主线程 outstanding batch 合计估算值 `<= 4 MiB`；
- 单 batch 在 clone 前限制 routes、legs、字符串宽度和估算 bytes；
- 每次 append 前检查磁盘至少保留 `1 GiB` free space。

任一硬边界触发后，本 epoch 的 route telemetry 永久 fail-open，打印一次有界
gap；scanner / solver 继续运行。只有下一次安全 live 重启才恢复。不得在同一
进程内静默重启 worker、抽样或只保留 top routes。

验收同时做正常生产投影和 adversarial churn。正常投影按 7200 块、最大
Enumeration / Solver 以及已观察的 route churn，须 `<= 100 MiB / 24h`。
adversarial 全新-route churn 不允许突破 100 MiB 硬帽；它应触发明确 gap 并停止
本 epoch telemetry。此后 analysis 必须显示证据缺口，不能声称仍覆盖每块。

## 8. Analysis CLI

扩展现有工具，不另造 gap 工具：

```bash
npm run block-activity -- \
  --block <target-block> \
  --events /var/log/mev/events/searcher-live.jsonl \
  --route-events /var/log/mev/events/searcher-live.blockscan-routes.jsonl
```

输出：

- target block 对应的 block-scan source block；
- Enumeration 的每条具体闭环；
- Solver 实际进入的每条具体闭环；
- 枚举但未进入 solver 的闭环；
- 已有关联的 final sim / EV；
- scheduler coalesce、writer gap 或 unknown。

工具不得：

- 从 route 缺失猜成 scanner 零候选；
- 用事后 quote 改写 live solver 结果；
- 把 solver positive 写成 final sim success；
- 混用 target block 和 source block。

## 9. 验收

### 9.1 语义

1. telemetry disabled / enabled 下 scanner 输出、顺序、planner input、
   solver input、final sim input 和决策完全相同。
2. 每个进入 `coarse.opportunities` 的候选恰好出现在 Enumeration 一次。
3. 每次真实 `solver.solve` 调用恰好产生一条 Solver 记录；未调用的 route
   不能进入 Solver 数组。
4. N 与 N-1 模式都通过；N-1 promotion 保持 route identity。
5. route id 对 block 稳定，对 venue / pool / direction / adapter 敏感。
6. scheduler 被替换和 shutdown 丢弃的已观察 head 有明确 not-started 记录。
7. final sim / EV 事件能以 `run_id + source_block + route_id` join。

### 9.2 故障

1. 人工挂起 worker并填满 queue，runtime 仍完成且结果相同。
2. queue 只整块 drop，恢复后 gap counter 精确。
3. 路径不可写、worker 崩溃、shutdown timeout 都 fail-open，无重启风暴。
4. 多个相邻 source blocks 保持 FIFO，禁止 writer 自行 coalesce。
5. live 启动只截断专用 route file，普通 searcher events 不受影响。

### 9.3 性能与体积

冻结生产候选数、budget 和 fixture，disabled / enabled 交错测试：

- 512 个四跳闭环的首次 identity/locator 提取到 `postMessage` 返回，主线程
  p95 增量 `<= 5 ms`；
- p99 增量 `<= 10 ms`；
- 主线程同步 fs 调用 enabled - disabled 增量为 0，新增 route telemetry
  自身调用图的同步 fs 调用数为 0；
- worker 阻塞时 enqueue p99 仍 `<= 10 ms`；
- scanner → solver wall-time p95 相对差 `<= 2%`；
- 事件循环延迟 p99 增量 `<= 5 ms`；
- 常驻内存增量 `<= 32 MiB`；
- 24 小时投影 `<= 100 MiB`。

不得减少候选、路线、字段或放宽生产预算来过门。

正常性能 verdict 还必须满足：

- worker healthy，所有 batch ack，zero drop / zero gap；
- 输出可解析，Enumeration / Solver 数量逐项相等；
- `run_count >= 20`，固定 seed，disabled / enabled 交错 paired samples；
- 预先冻结精确 run count；计算 matched-pair delta 并保留所有 timeout /
  failed samples；
- percentile 固定 nearest-rank：
  `sorted[ceil(p * n) - 1]`；看到结果后不得追加样本，追加必须成为新实验；
- 正式 `SEARCHER_EVENTS_PATH` 同时启用，并测试同盘竞争；
- 重复 route、全新 route churn、最大 Solver 数分别成组。

blocked-worker / writer-failure 只验证 fail-open，不能贡献正常性能过门样本。

本分支在加入 2,048-entry 有界 route-locator cache 后，连续执行三次互相独立、
每次 20 组的冻结交错离线样本；三次结果全部通过，且全部保留：

- fixture：512 条四跳闭环，100 条进入 Solver；
- 源码 worker 主线程 matched-pair p95：
  `2.335ms / 2.433ms / 3.390ms`；
- 源码 worker 主线程 matched-pair p99：
  `2.458ms / 2.571ms / 3.940ms`；
- 源码 worker blocked enqueue p99：
  `0.014ms / 0.016ms / 0.017ms`；
- 编译后 Node worker 独立复跑：p95 `2.246ms`、p99 `2.263ms`、
  blocked p99 `0.055ms`；
- 重复 512-route、Solver=100 这一窄场景的 24 小时投影：
  `18,867,284 bytes`（约 `18.0 MiB`）；
- hard cap：`104,857,600 bytes`；
- healthy worker：全部 ack，zero drop / zero gap。

这些是 facade/worker 隔离门，不是生产数据上界，也不是 live scanner →
solver 全链路延迟结论。晚期 50k 宽 ref、最大 Solver、真实 churn、正式 events
同盘竞争、同步 I/O 计数、event-loop、RSS 和真实 scanner → solver 相对差均
证据不足；100 MiB hard cap 与触发后 fail-open 已单独验证。

### 9.4 工程门

至少实际运行：

```text
listener build:live
route id / catalog / FIFO writer 单测
latest-head scheduler coalesce 回归
blockscan runtime / N-1 回归
analysis build
block-activity parser 单测
npm run tool-index -- --check
npm run tool-index -- --select single-block,production-events,block-scan \
  --out <manifest>
npm run tool-run -- --manifest <manifest> \
  --tool analysis:block-activity -- \
  --block <N> \
  --events <fixture-events> \
  --route-events <fixture-route-events>
```

`tool-run` 必须在 fixture JSONL 输出 Enumeration / Solver 两组闭环及 join
结果。离线门只允许称 `implemented`；没有生产 scanner 自发枚举和 mandatory
final sim live 证据，不能称 `fixed`。

本分支实际执行结果：

```text
listener build / build:live                         PASS
route telemetry source worker                      4/4 PASS
route telemetry compiled worker                    4/4 PASS
latest-head scheduler                              PASS
blockscan runtime startup/N-1 + nonzero solver    26/26 PASS
blockscan pricing source mode                      8/8 PASS
blockscan production boundary                      PASS
analysis block-activity                           11/11 PASS
analysis targeted deploy boundaries               73/73 PASS
analysis full suite                              290/290 PASS
tool-index --check                                 PASS (250 tools)
```

实际 tool selection：

```text
requested capabilities:
  single-block,production-events,block-scan
recommended:
  analysis:block-activity
manifest:
  /tmp/blockscan-route-tool-manifest.json
final manifest sha256:
  0dd626767d52f742e2bdce9726ece9233a45e3ef410c9c95a58b7dc28377e607
tool-run:
  exit=0
  Enumeration=2
  Solver entered=2
  Final events joined=2
```

## 10. 实施顺序

1. 对本文做性能隔离和证据完整性对抗审计；
2. P0 / P1 全部闭合；
3. 从最新 `origin/main` 创建
   `codex/blockscan-enumeration-solver-telemetry`；
4. 实现、测试、实际运行 `tool-index/tool-run`；
5. 提交并推送；
6. 本轮不部署 live。

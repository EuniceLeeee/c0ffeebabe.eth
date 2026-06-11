# V7: Fewer Paths + Quote-Level Concurrency

借鉴 [sui-mev](https://github.com/fuzzland/sui-mev) 的"少路径"做法，并修复当前未提交 diff 引入的 AC-3 回归。
分四阶段，每阶段都有可量化验收。核心原则：**在路径扩展时就少生路径**（不是先生成再截断），
**只读 quote 可并发、stateful simulate 必须串行**。

## 背景 / 动机

- 当前 `npm run searcher:ac3` **FAIL**：detector 出机会，但 planner `0 candidate plans`。
  根因：未提交 diff 把 planner 兜底从 `?? defaultTokenGraph()` 改成 `?? []`
  （`planner.ts:35`），而 `ac3.ts` 的 `new TemplatePlanner()` 从不 `setGraph()`。
- `selectPlanningGraph`（`planner.ts:124`）做的是**边级**剪枝（只保留沾 impact token 的边），
  会砍掉长环中间段（如 `USDC→DAI→USDT→sUSDS→DOLA`），等于让 fluid 借贷长环模板失效。
  它还**兼着 live 的性能护栏**——删它必须同时上 top-N，否则 3000+ 边裸 DFS 爆炸。
- sui-mev 的少路径三件套（`bin/arb/src/defi/mod.rs`，已核实）：
  `MAX_HOP_COUNT=2`、`MAX_POOL_COUNT=10`、`MIN_LIQUIDITY=1000`，
  在 DFS 扩展邻居时 `retain(liquidity>=MIN) → sort desc → truncate(top N)`，
  并对 pegged/last-hop 强制收敛到 base coin（SUI）。

## 不照抄的部分（EVM 专有坑）

- **不**把 Anvil simulate 当 quoter：sui-mev 的 simulator 是本地的（`DBSimulator`/`ReplaySimulator`），
  我们的是 Anvil-over-RPC，一次 simulate = `send`(45s) + `mine`(120s) + 失败再 `traceRevert`(30s)，
  比一个 eth_call quote 更贵。
- **不**照抄 JoinSet 并发 simulate：sui-mev 用 `ObjectPool<Simulator>`，每个 trial 领独立 simulator；
  我们共享单个 `AnvilStateBackend` + snapshot/revert，并发会互相冲掉状态。要并发 simulate 得先有 Anvil 池（后话）。

---

## 路径方向（四阶段）

| 阶段 | 方向 | 主要改动 |
|---|---|---|
| **S0** 修空图回归 | AC-3 转绿的前置闸门 | `ac3.ts` 显式 `detector.setGraph(g)` + `planner.setGraph(g)`（同一张 `defaultTokenGraph()`）；planner 图为空时打 warn |
| **S1** 边级→路径级过滤 | 让长环能生成 | 删 `selectPlanningGraph` 边级 cull；保留 `focusPathsOnImpact` 路径级排序；引入 `pin` 集合（受害池 + 静态 backbone） |
| **S2** sui-mev 少路径 | 压乘数基数 | `TokenEdge.score`（复用 `scanActivePools` 的 count）；`buildTokenPaths` 扩展时 top-N + `maxHops` 参数 + base-token 锚定 + pin 豁免 |
| **S3a** sui-mev 数值/逻辑(无需池) | 更优金额搜索 + 出价 + 不卡死 | 金额搜索换 victim-锚定几何 grid + GSS(**限次 ~12,非** sui-mev 的 tries<1000);出价 `profit*9/10`(可配);deadline + 提交前终验 + 机会 5s 过期 |
| **S3b** Anvil simulator 池(b1) | 并发 simulate(对标 ObjectPool) | N 个 anvil 实例池;Anvil 上 simulate 重,故**保留 quote(eth_call)预筛 → 只对 top-N 跨池并发 simulate**(刻意背离 sui-mev 的"simulate 一切") |

**发布耦合**：S1 删掉的 `selectPlanningGraph` 同时兼着 live 性能护栏，所以 **S2 落地前 live 一次都不跑**，
S1 只在 AC-3 小图上离线验。

---

## 验收标准（两层）

> **方法论修正**：AC-3 是"那一次历史 wstUSR depeg"的**回测样本**（2 fixture、同池同事件、手写 11 边图）。
> V7 改的是 fewer-paths + 并发 + 超时——目标是**实战跑得快、覆盖广、不卡死**，跟"能否在小图上复刻那笔"基本无关。
> 仓库 `boundary.ts` 本就禁止 searcher 出现 wstUSR 硬编码（设计上要通用）。
> 所以 V7 的**主验收是 B 层（实战就绪）**，AC-3 降级为 A 层回归哨兵。

### A. 回测 / 回归（correctness，偶尔跑，**不是 V7 的门**）
- **AC-3** `[fork]` `npm run searcher:ac3` — 历史 wstUSR 套利仍能被流水线找到（回归哨兵）。
  当前红：Fluid lend 腿 + UniV4 腿有**既有 revert**（`debug-revert.ts` 排查），**单独一条线处理，不阻塞 V7**。
- Stage 0/1 的正确性用**结构性检查**验证（planner 对该机会生成预期形状的路径），不靠 AC-3 利润数字。

### B. 实战就绪（V7 主验收，全部基于近期 orderflow **dry-run**，无需盈利 / 无需私钥）
测量工具：`npm run searcher:liveready`（回放近 N 区块真实 swap 当合成 hint，纯内存 + mainnet 读，无 anvil/solver/submit）。

- **LR-1 覆盖率** `[liveready]`：回放 hint 中命中已知池(impact)、且产出 ≥1 候选的比例 → Stage 2 后应 ≥ baseline。
- **LR-2 搜索有界** `[liveready]`：真实 live 图上，单机会候选数 & planner wall（avg/p50/p95/max）有界 → Stage 2 后候选数明显下降、wall 不增。
- **LR-3 时延达标** `[liveready+sim]`：单 hint 端到端（quote→排序→top-N sim→dry-run submit）< `SEARCHER_SOLVER_DEADLINE_MS` 的比例 ≥X%；报 p50/p95。（需 Stage 3 的 deadline 机制）
- **LR-4 不卡死** `[liveready+sim]`：单 quote/sim 超时即丢、loop 继续，无 30s 单点阻塞。（需 Stage 3）
- **LR-5 通用性** `[lint]`：`npm run searcher:lint`（boundary.ts）持续绿——searcher 无 wstUSR 硬编码。
- **LR-6 剪枝不变量** `[unit]`：top-N / pin / maxHops 的确定性单测（见下方 Stage 2 三条，不需要真套利）。

口径待定（实现时按 baseline 钉死）：N 区块数、LR-3 的 X% 阈值与 deadline 目标值。

---

## 各 Stage 的具体验收（映射到上面两层）

验证类型：`[liveready]` / `[unit]` / `[fork]`=AC-3 回归 / `[gate]` 发布门槛 / `[review]` 代码审查。

### Stage 0 — 空图回归
- **AC-0.1** `[fork]` `npm run searcher:ac3`：不再出现 `planner: 0 candidate plans`（全 0）；
  **每个 fixture 聚合** `candidatesEnumerated ≥ 2`。_防：空图回归。_
- **AC-0.2** `[review]` detector 与 planner 都**显式注入同一张图**，不依赖隐式 fallback；
  planner 收到空图时打 warn。_防：将来再被静默空图坑。_

### Stage 1 — 边级→路径级
- **AC-1.1** `[fork]` `npm run searcher:ac3` **PASS 2/2**：
  fixture1 `bestProfit ≥ 543 wstUSR`、fixture2 `≥ 1 wstUSR`。_防：长环被边级 filter 砍死。_
- **AC-1.2** `[fork]` 路径断言：best path **含受害池 或 反向受害方向**；
  长环中间边 `USDC→DAI→USDT→sUSDS→DOLA` 完整存在于候选里。
  _防：①selectPlanningGraph 误杀中段边；②"必须含受害池"过严、误杀 cross-venue。_
- **AC-1.3** `[gate]` top-N(S2) 未合入前，`main.ts` live 路径保持不跑
  （或 selectPlanningGraph 暂留当护栏）。_防：3000+ 边裸 DFS 爆炸。_

### Stage 2 — 少路径（验收重点）
- **AC-2.1** `[fork]` 回归：加 top-N/maxHops/base-anchor 后 `npm run searcher:ac3` **仍 PASS 2/2**；
  利润以 **S1 实测为基线 ±1%** 不变；AC-3 跑 `maxHops=8`。_防：剪枝误伤历史回归。_
- **AC-2.2** `[unit]` pin 不变量：合成假图，受害池边 `score=0` 且同 token 下另有 `>N` 条更高分边
  → 截断后**受害池边仍在**；无 score 的静态 backbone 边**也仍在**。_防：top-N 误删受害池 / backbone。_
- **AC-2.3** `[unit]` top-N 生效：假图某 token 有 `M>N` 条 discovered 边
  → 该 token **只扩 top-N**（按 score 降序），低分边被剪。_防：剪枝形同虚设。_
- **AC-2.4** `[unit]` 性能边界：合成 ~3000 边图跑 `buildTokenPaths`：
  **path 数 ≤ 上限**（S3 quote 的乘数基数，阈值按 S1 baseline 定）；
  DFS 纯内存同步遍历，**wall < 500ms**；planner 打印剪枝前/后候选数并断言下降。
  _防：剪枝"正确但仍慢"。_
- **AC-2.5** `[review]` 零额外启动开销：`TokenEdge.score` 取自 `scanActivePools` 已算出的 count，
  建图**不新增启动期 eth_call**。_防：为 score 又加一轮链上查询。_
- **AC-2.6** `[review/fork]` 可观测：live 启动日志打印
  `maxHops / maxPoolsPerToken / baseTokens / pin 集合大小`。_防：线上参数不可见。_

### Stage 3a — sui-mev 数值/逻辑（不依赖池）
> 评估结论：grid+GSS 的**形状**好、比线性强,但 sui-mev 的**常量不能照抄**——它 simulate 是本地微秒级,我们一次 trial = `send`+`mine` 重操作。
- **AC-3a.1** `[unit]` 金额搜索：grid 是 **victim-锚定几何**（跨度 ≥ `[v/8, v*8]`,**非** sui-mev 的绝对 `1e6×10^10`）；GSS 在 `[best/k, best*k]` 精修,**收敛到合成单峰利润函数的最大值,评估次数 ≤ `SEARCHER_GSS_MAX_TRIES`(~12)**——硬限次,**非** sui-mev 的 `tries<1000`。确定性,无 RPC。
- **AC-3a.2** `[unit]` 出价：`bid = profit * SEARCHER_BID_BPS / 10000`(默认 9000=90%)；`profit≤0` 时 `bid=0`；`bid` 恒 `< profit`。_对标 sui-mev `profit/10*9`,但做成可配、非硬编码。_
- **AC-3a.3** `[fork]` deadline：单 opportunity solve 在 `SEARCHER_SOLVER_DEADLINE_MS` 内返回(硬封顶、放弃剩余 trial)；无 18 分钟失控。
- **AC-3a.4** `[review]` 提交前终验：任何 submit 前重新 simulate 一次、断言 net profit > 0(终验闸门),失败即弃。_对标 sui-mev `dry_run_tx_data`。防：在陈旧状态上付 gas。_
- **AC-3a.5** `[review]` 机会过期：超过 `SEARCHER_OPP_TTL_MS`(默认 5000)的机会直接丢弃、不再 solve。_对标 sui-mev `ArbCache(5s)`。_
- **AC-3a.6** `[fork]` 回归：grid 覆盖盈利区间,AC-3 仍能找到已知套利(利润 ±1%)；若 AC-3 仍因 Fluid/V4 revert 红,则用 AC-3a.1 单测 + 单路线定向 solve 验证(不被既有 revert 阻塞)。

### Stage 3b — Anvil simulator 池（b1）
> Anvil 上 simulate 重于 quote,故**刻意背离 sui-mev 的"simulate 一切"**：保留 quote(eth_call)预筛 → 只对 top-N 跨池并发 simulate。
- **AC-3b.1** `[unit/review]` 池：`AnvilSimulatorPool` 起 N 个实例(端口 8555..),checkout 返回互不相同的后端、release 归还；实例间 snapshot/revert 互不污染。_对标 `ObjectPool<Simulator>`。_
- **AC-3b.2** `[liveready+sim]` 并发评估：开池后单 opportunity 端到端 wall ≈ 串行 / `min(N, 候选数)`(受 RPC 限频约束)；测 **LR-3**(端到端 < deadline 比例)、**LR-4**(无单点 stall 阻塞 loop)。
- **AC-3b.3** `[review]` 隔离：并发 simulate 各自用 checkout 出的独立实例走完 `snapshot→send→revert`,绝不共享单一后端。
- **AC-3b.4** `[review]` RPC 预算：池大小 `SEARCHER_SIM_POOL_SIZE`(默认小,如 4)封顶,避免 N 实例同时回填打爆上游 RPC/配额。

---

## Definition of Done

S0–S2 全绿 + S2 三条 `[unit]`(2.2/2.3/2.4) + S3a 单测(3a.1/3a.2)确定性通过；
S3a deadline 生效(无失控)、提交前终验就位、机会 5s 过期；S3b 开池后 LR-3/LR-4 达标。
AC-3 作为 A 层回归哨兵单独跟踪(Fluid/V4 revert 不阻塞 V7)。
`[gate]` AC-1.3 贯穿：**S2 前不碰 live**。

## 新增环境变量（S2/S3）

```
# S2
SEARCHER_MAX_HOPS=3              # live DFS 最大跳数（AC-3 用 8）
SEARCHER_MAX_POOLS_PER_TOKEN=8  # 每 token 扩展的 top-N 池
# S3a
SEARCHER_BID_BPS=9000           # 出价 = profit * bps/10000（默认 90%）
SEARCHER_SOLVER_DEADLINE_MS=8000 # 单 opportunity 硬封顶
SEARCHER_OPP_TTL_MS=5000        # 机会过期（对标 sui-mev ArbCache 5s）
SEARCHER_GSS_MAX_TRIES=12       # GSS 评估次数硬上限（非 sui-mev 的 1000）
SEARCHER_SIM_SEND_TIMEOUT_MS=4000 # simulate 的 send 超时，必须 <= deadline
# S3b
SEARCHER_SIM_POOL_SIZE=4        # Anvil 实例池大小（RPC 预算约束）
SEARCHER_QUOTE_CONCURRENCY=8    # 只读 quote 预筛并发度
SEARCHER_MAX_SIMULATIONS=3      # 跨池并发 simulate 的 top-N
```

---

## 实现进度

| 阶段 | 状态 | 验证 |
|---|---|---|
| **S0** 空图回归 | ✅ done | `ac3.ts` 注入图 + planner 空图 warn;fixture2 candidates 0→4 |
| **S1** 边级→路径级 | ✅ done | 删 selectPlanningGraph;fixture1 候选 0→20(长环恢复) |
| **S2** fewer-paths | ✅ done | `buildTokenPaths` maxHops + 每token top-N + pin + maxPaths;score 来自 scanActivePools count |
| **S3a** grid+GSS/出价/deadline | 🔧 核心+单测 done,solver/submit 接线待 | `searcher:amtsearch` 4/4(grid+GSS ≤12 评估 / bid 数学) |
| **S3b-pool** Anvil 池(b1) | ✅ 原语 done | `searcher:pool` AC-3b.1 隔离 PASS;并发冷读 2.1x |
| **S3b-forkreuse** fork 复用 | ✅ done(已接热路径) | `searcher:forkreuse` 每 hint 4-5s→**182ms(30x)**,撤销已验证 |
| AC-3 Fluid/V4 revert | ⬜ 单独线 | `debug-revert.ts`,不阻塞 V7 |

### 及时性(实测分量拼出的单 hint 预算)
| 阶段 | 改前 | 现在(fork 复用 + 池) |
|---|---|---|
| fork/复位 | ~4-5s (`forkAt`/hint) | **182ms** (`resetToBaseline`) |
| detect+plan | <2ms | <2ms |
| simulate top-N | 串行 N×1.4s+ | 跨池一轮 ~1.4s |
| **单 hint 合计** | **~10s+** | **~1.6s** |

12s 出块 / 竞争窗口 ~1-4s:改前必然错过;现在 ~1.6s **进了出块预算、贴近竞争窗口**。剩余大头是 simulate ~1.4s(revm/b2 才能再压)。

### 测试脚本
- `npm run searcher:liveready` — LR-1/LR-2(近期 orderflow dry-run,无 anvil)
- `npm run searcher:pruning` — LR-6 剪枝不变量(确定性,无 RPC,4/4 PASS)
- `npm run searcher:ac3` — A 层回归哨兵(当前红:Fluid/V4 revert,单独处理)
- `npm run searcher:lint` — LR-5 boundary(searcher 无 wstUSR 硬编码)
- `npm run searcher:amtsearch` — S3a grid+GSS+bid 单测(确定性,4/4)
- `npm run searcher:pool` — S3b AC-3b.1 池隔离 + 延迟探针
- `npm run searcher:forkreuse` — fork 复用 30x 验证(helper 正确性 + 延迟)

### Baseline(Stage 2 后,LR_MAX_HOPS=3 LR_MAX_POOLS_PER_TOKEN=6,306 边 live 图)
- **LR-1**: 90 hint → 命中受害池 98.9% / 出 ≥1 候选 73.3%
- **LR-2**: 候选/机会 p50=4 p95=20,planner wall p95=0.8ms(Stage 2 前:depth-8 无界 DFS → 182s OOM 4GB)
- **LR-6**: top-N / pin(受害池 score=0、backbone score=undefined)/ perf(2986 边 0.6ms)4/4 PASS

> S3 完成后补 LR-3(端到端 < deadline 比例)、LR-4(不卡死)。

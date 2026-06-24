# T2d — Daemon 级共享 HTTP Client（跨块连接复用）

> 隶属 V8 / T2（cold-prepare elimination），排在 T2a（trace 预取 + upfront warm_batch）之后。
> 前置结论修正：**"单次 RTT 1.5–3s 是 endpoint 硬地板、2s 物理不可达"是误诊。**

## 1. 误诊修正（为什么要做这个）

2026-06-11 的测量把"新建连接的 TLS 握手成本"误读成了"endpoint 每次往返的地板"。
重测数据（同一 Alchemy endpoint，流量经 `HTTPS_PROXY=127.0.0.1:1082`）：

| 测量条件 | 延迟 |
|---|---|
| 新建连接，单次 `eth_blockNumber`（旧测法，curl 每次冷启动） | 1.0–3.3s，最差 10.6s |
| 冷连接细分 | TLS 握手 0.65–1.3s + TTFB ≈ 总时长的全部 |
| **keep-alive 复用连接，单次调用** | **~0.31s** |
| **keep-alive 复用连接，30-way batch（`eth_getStorageAt` ×30）** | **~0.42s** |
| 直连（绕过代理），warm 连接 | ~0.32–0.42s（与代理路径相同） |

结论：

- warm 连接上 per-RTT 地板是 **~0.35s**，不是 1.5–3s。
- "30-way batch 和单次一样慢"不是限流证据，是**握手主导**的特征（batch 仍然有效，
  30 slot 一次往返）。
- 剩余 ~300ms 是地理路径成本（代理/直连无差别），只有换就近 endpoint 或本地节点
  能压掉——**但那是 round_trips 压到最小、且本任务落地之后才值得考虑的事。**

## 2. 代码根因

daemon 每个新块都重建 HTTP client，连接池清零，于是**每块第一笔调用都重付一次
1–10s 的冷握手**——这就是日志里 `ensure_warm` / `getBlockByNumber 1.8–3.9s` 的来源：

```text
ensure_warm (main.rs:976)
  → RemoteRevmDb::new (main.rs:300)
    → RpcClient::new (main.rs:135)
      → Client::builder().build()   // 全新 reqwest Client = 空连接池
```

注：reqwest 默认读 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量，daemon 的流量也在走
127.0.0.1:1082，握手成本被代理进一步放大。

## 3. 改的方向

reqwest 的 `blocking::Client` 内部是 `Arc` 共享的：**clone 共享同一个连接池**。
所以把 `Client` 提到 `Daemon` 生命周期（与 `PersistentCache` 同等待遇），
`ensure_warm` 重建 `RemoteRevmDb` 时传入 clone，TCP+TLS 隧道跨块存活。

主线不改变调用语义：`round_trips` 计数器仍在 per-block 的 `RpcClient` 里，
warm_batch / trace_prefetch 仍是 prepare 的批量预热机制。

落地时发现两个 T2a 漏点会把共享连接的收益吃掉，已并入本任务修：

- `approve()` 本地执行会读 allowance slot，旧 warm_batch 只预热 balance slot，
  导致 approve 阶段额外打一笔隐藏 `eth_getStorageAt`。修复：从 approve calldata
  解出 spender，把常见 allowance candidate slots 并入同一个 upfront warm_batch。
- victim swap 的 trace 已经走过 impact pool；同一个 pool 的 route quote prewarm
  再 trace 一遍是重复工作。修复：`buildPrewarmCalls` 跳过 impact pool，只为路径上
  其他 pool 做 quote prewarm。
- live 中 20 个候选会把大量 route hops 合并进一次 prepare，导致 `traced=10/12`
  的重 trace。修复：新增 `SEARCHER_REVM_PREWARM_ROUTE_HOPS`（默认 2），prepare
  只预热最靠前的少量非 victim route hop，避免为了预热所有候选先把 hint 过期。

所以最终结果不是“round_trips 原样不变”，而是更好：new-block prepare 从 4 个
round trips 降到 3 个，同时 timing fixture 的 trace call 数从 3 降到 1。

### 核心代码

```rust
// 1) RpcClient::new 接收共享 Client，不再自建
impl RpcClient {
    fn new(url: String, client: Client) -> Result<Self> {
        Ok(Self { url, client, round_trips: std::cell::Cell::new(0) })
    }
}

// 2) 连接池构建独立成函数（daemon 与 one-shot simulate 共用）
fn build_http_client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(45))
        .pool_max_idle_per_host(8)
        // 块间隔 12s，防代理/NAT 静默断开空闲隧道
        .tcp_keepalive(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(300))
        .build()
        .context("failed to build blocking rpc client")
}

// 3) RemoteRevmDb::new 透传
impl RemoteRevmDb {
    fn new(
        rpc_url: String,
        block_number: u64,
        funded: HashSet<Address>,
        persist: Rc<RefCell<PersistentCache>>,
        http: Client,                       // 新增
    ) -> Result<Self> {
        Ok(Self {
            rpc: RpcClient::new(rpc_url, http)?,
            // ... 其余不变
        })
    }
}

// 4) Daemon 持有 daemon 生命周期的 Client
#[derive(Default)]
struct Daemon {
    warm: Option<WarmBlock>,
    prepared: Option<CacheDB<SharedRemote>>,
    block_env: Option<BlockEnv>,
    persist: Rc<RefCell<PersistentCache>>,
    /// Daemon 生命周期的 HTTP client：连接池（TCP+TLS，含代理隧道）跨
    /// ensure_warm 重建存活，新块不再重付冷握手。
    http: Option<Client>,
}

impl Daemon {
    fn http_client(&mut self) -> Result<Client> {
        if self.http.is_none() {
            self.http = Some(build_http_client()?);
        }
        Ok(self.http.as_ref().unwrap().clone()) // clone 共享连接池
    }

    fn ensure_warm(&mut self, block_number: u64, rpc_url: Option<String>) -> Result<()> {
        // ... rpc_url 解析不变
        let http = self.http_client()?;
        let remote = RemoteRevmDb::new(
            rpc_url, block_number, HashSet::new(), Rc::clone(&self.persist),
            http,                               // 复用，不再每块新建
        )?;
        // ... 其余不变
    }
}
```

另一处构建点同步改：one-shot `simulate()`（main.rs:708）传
`build_http_client()?` 即可（one-shot 本来就只活一次，行为不变）。

### 可选加固（先量再做，不要顺手都加）

- **daemon 启动预热**：`serve()` 起来后若 `MAINNET_RPC_URL` 已设，先发一笔
  `eth_blockNumber` 把隧道建好，让 daemon 生命周期的第一个 prepare 也不付握手。
- T2c 背景 warmer 若落地，天然兼任 keep-alive，预热可省。

## 4. 验收

> 测量纪律：今后所有 RTT/耗时断言必须在 **warm 连接** 上测。
> 单发 curl 新建连接的数字只能用来量"握手成本"，不能用来定 endpoint 地板。

### AC-1 — 握手消失（本任务的核心目标）

```bash
cd listener && tsx src/searcher/test/revm-prepare-timing.ts
```

- `NEW-BLOCK prepare`（×2）的 stderr phase 输出里，**不再出现 1.5s+ 的单 phase**
  （改前 `ensure_warm`/首笔调用 1.8–3.9s）。
- NEW-BLOCK prepare wall ≈ `round_trips × 0.35–0.5s`（用日志里的
  `prepare round_trips=N (wall Xms)` 直接验算）。
- 连续 ≥3 个新块（脚本跑 2 个 + 改 baseBlock 再跑），p50 wall ≤ **2s**。
  达不到时先看 round_trips 是否仍 >5，往返结构问题回 T2a 继续折叠,不归本任务。

### AC-2 — round_trips 不增加；隐藏 miss 被前置批量化

- `prepare round_trips=N` 不允许增加。
- 如果 N 下降，必须能解释为“把原本 prepare 内部的隐藏串行 miss 并入已有 batch”，
  而不是删除必要状态读取。
- 当前验收值：new-block prepare `round_trips=3`。

### AC-3 — 正确性回归

```bash
npm run searcher:revm-quote        # UniV3/Curve quote 与改前 bit-exact
npm run searcher:revm-health
tsx src/searcher/test/replay-live-fixtures.ts   # 已录 fixture 全绿，profit diff ≤1 wei
```

### AC-4 — live 验证（最终判据，见 memory: validate-live-not-backtest）

- live dry-run 30 分钟，`expiredBeforeSolver` 相比改前下降；
  prepare 相关 TTL 过期不再由握手贡献。
- 注意:本任务只解决 prepare 路径的握手成本;quote 循环读 Anvil 的问题是 T3,
  live TTL 不会单靠本任务清零。

## 5. 明确不做

- 不换 RPC provider / 不加第二个 endpoint——round_trips 已最小、本任务落地后
  若 wall 仍超标,那时剩下的才真是 ~300ms/RTT 的地理成本,再议。
- 不动 warm_batch / trace_prefetch 的批结构（T2a 已落）。
- 不在本任务里做 T2c 背景 warmer。

## 6. 当前验收记录（2026-06-11）

命令：

```bash
cd listener && npx tsx src/searcher/test/revm-prepare-timing.ts
```

连续两轮、四个 new-block 样本：

| 样本 | round_trips | wall |
|---|---:|---:|
| run1 NEW-BLOCK | 3 | 1928ms |
| run1 NEW-BLOCK #2 | 3 | 2026ms |
| run2 NEW-BLOCK | 3 | 1873ms |
| run2 NEW-BLOCK #2 | 3 | 2099ms |

结果：

- new-block p50 ≈ 1.98s，满足 p50 ≤ 2s。
- phase 无 1.5s+：warm_batch 689–1287ms，token_deals 573–595ms，
  trace_prefetch 573–783ms。
- `trace_prefetch` traced calls 从 3 降为 1，seeded 2 accounts + 9/10 slots；
  同池 quote 的第一笔可能 cold miss，第二笔 warm。

回归：

```bash
npm run searcher:revm-health       # PASS
npm run searcher:revm-quote        # PASS 3/3, diff=0
tsx src/searcher/test/replay-live-fixtures.ts
npm run build
npm run searcher:lint
```

Live dry-run smoke:

```bash
SEARCHER_LIVE_BACKEND=revm \
SEARCHER_DRY_RUN=1 \
SEARCHER_ENABLE_HASH_ONLY=1 \
SEARCHER_MAX_HINTS=80 \
SEARCHER_MIN_PROFIT_RAW=0 \
npm run searcher:live
```

结果：

- 启动：3124 routing edges / 1561 detection pools，MEV-Share SSE connected。
- counters：`hints=80 impacts=13 opportunities=13 plans=140 solverEntered=63
  expiredBeforeSolver=6 revmErrors=0 accepted=0`。
- 旧症状是 opportunities 后 solver 完全进不去；现在 solverEntered > 0，
  prepare 相关握手成本不再是绝对门槛。
- 仍有 `expiredBeforeSolver=6`：这些来自 match/plan/overlay/quote 总预算超过
  `SEARCHER_OPP_TTL_MS=5000`，下一阶段应继续压 planner/quote 搜索预算；本任务只
  证明 revm prepare 不再因为每块冷 HTTP client 卡 10–20s。

30-min live dry-run：

```bash
SEARCHER_LIVE_BACKEND=revm \
SEARCHER_DRY_RUN=1 \
SEARCHER_ENABLE_HASH_ONLY=1 \
SEARCHER_MIN_PROFIT_RAW=0 \
npm run searcher:live
```

结果：

- counters：`hints=545 impacts=102 opportunities=102 plans=508 solverEntered=234
  expiredBeforeSolver=19 quoteTimeouts=2 revmErrors=7 accepted=0`。
- 与改前 `solverEntered=0` 相比，prepare 不再是绝对门槛。
- 但 AC-4 的 `expiredBeforeSolver=0` **未达成**。剩余过期样本主要来自：
  - 重 route prewarm（随后加 `SEARCHER_REVM_PREWARM_ROUTE_HOPS` cap）；
  - solver/amount-bounds 在没有有效 flash amount 时仍可耗尽 TTL。
- 结论：T2d 解决了共享 HTTP client / hidden slot fault / duplicate trace 的
  prepare 问题；V8 live 仍需要下一步压 solver 搜索预算，不能宣称 live 完全生产就绪。

Route prewarm cap smoke：

```bash
SEARCHER_LIVE_BACKEND=revm \
SEARCHER_DRY_RUN=1 \
SEARCHER_ENABLE_HASH_ONLY=1 \
SEARCHER_MAX_HINTS=120 \
SEARCHER_MIN_PROFIT_RAW=0 \
SEARCHER_REVM_PREWARM_ROUTE_HOPS=2 \
npm run searcher:live
```

结果：`hints=120 impacts=12 opportunities=12 plans=24 solverEntered=7
expiredBeforeSolver=5 revmErrors=0`。重机会里 prepare `traced=1`,
`roundTrips=3`, `prepare total=2441ms`; 过期点继续后移到 solver 阶段。

方差备注（2026-06-11 23:4x 复测，同代码）：new-block prepare 2301/2934ms，
phase 结构相同（warm_batch 834–838 + token_deals 562–630 + trace_prefetch
895–1463）。即同代码下 wall 分布 **1.9–2.9s**，看到 ~3s 属网络/代理抖动的
差端，不是退化。

## 7. T2e — 剩余两个可折项（live dry-run 差一口气时再做）

> 触发条件：AC-4 的 30 分钟 live dry-run 后 `expiredBeforeSolver > 0` 且
> 过期主要由 prepare/首quote 贡献。dry-run 绿就不做（见 §5 的纪律）。

### T2e-1 — token_deals 的隐藏 RTT（round_trips 3 → 2，省 ~0.6s）

根因：`apply_token_deals` 的 slot 试探用 `erc20_balance_of` 验证，而它以
`Address::ZERO` 作 caller（main.rs:1532 `execute_call(db, …, Address::ZERO,
token, …)`）。warm_batch 的 accounts 列表（funded + deal token/to + prewarm）
不含零地址，于是 token_deals 阶段第一笔 `basic(ZERO)` 串行 fault 一次
——正好 1 个 RTT，对上 phase 稳定的 562–630ms。

修法：把 `Address::ZERO` 并入 upfront warm_batch 的 accounts（现有 batch 加
一个条目，不加 RTT）：

```rust
// prepare() 组装 accounts 时：
accounts.push(Address::ZERO);   // erc20_balance_of / prewarm 视图调用的 caller
```

验收：`prepare round_trips=2`；token_deals phase 从 ~0.6s 降到 <50ms
（不再打印）；AC-3 回归全绿。

### T2e-2 — 首 quote 的 3 个 cold miss（首 quote ~1.3s → ~3ms）

根因：`buildPrewarmCalls`（revm-live-backend.ts:134）把 impact pool 预置进
`seenTargets`，整池跳过 prewarm——这是为了不重复 trace victim swap 走过的池。
但 victim trace 只覆盖 victim 方向（如 WETH→CRV）；GSS 第一笔 quote 走**反
方向**（CRV→WETH），跨的是 current tick 另一侧的 tick/bitmap word，3 个 key
全 miss，串行 fault ≈ 1.3s。

修法：impact pool 只跳过与 victim 同方向的 hop，反方向的 quote view-call
保留进 prewarmCalls。它和 victim swap 在**同一个**批量 debug_traceCall 里
（trace_prefetch 一个 RTT 装下所有 traced calls），所以 traced 1→2 只加
server 端计算，不加 RTT：

```ts
// buildPrewarmCalls(): 不再无条件跳过 impact pool ——
const victimDir = `${input.impact.pool}|${input.impact.tokenIn}`.toLowerCase();
const hopDir = `${hop.target}|${hop.tokenIn}`.toLowerCase();
if (hopDir === victimDir) continue;   // 只去重同方向，反方向保留
```

（实现时去掉 `seenTargets` 预置 impact.pool 那一行，改为按 (target, tokenIn)
方向去重。）

验收：timing 测试里 `first GSS-direction quote` 的 `coldMisses=0`、耗时
~3ms（与 second quote 同级）；traced=2、round_trips 不变；quote amountOut
与改前 bit-exact。

### 两项都落后的预期

prepare ≈ 2 RTT（warm_batch + trace_prefetch）≈ **1.3–2.2s**，prepare+首quote
基本同值。5s TTL 下从"勉强"变"从容"。再往下压就只剩换就近 endpoint/本地
节点（§5），代码侧到此为止。

## 8. T2c — 跨 hint 后台池子预热（landed 2026-06-12）

> 30 分钟 dry-run 复盘把卡点定到了 trace_prefetch（avg 2117ms，tail 3930ms）
> + warm_batch 尾部尖刺，而非 round_trips。蓝筹池 `0xc7bBeC68`（jared 退出跳
> 也用它）在日志里复发 30+ 次，却每个 hint 从冷状态重 trace，3.5s overlay 把
> 5s TTL 吃光、quote 0 点过期。这是和我们策略重叠、最该修的一桶。

### 思路

热池复发但每 hint 重 warm。在**块间空档**把复发热池的 slot 提前 trace 进
daemon 缓存，等 hint 落到同一块时 solve 直接命中 warm，省掉 TTL 内的冷
route-hop trace。

### 改动

- `revm-sim/src/main.rs`：新增 `Warm { blockNumber, rpcUrl, prewarmCalls }`
  daemon 命令 = `ensure_warm(block)` + 对每个热池的代表性 quote view-call 跑
  `trace_prefetch`（复用现有原语，空 overlay，纯读）。
- `revm-sim-client.ts`：`warm()` 方法 + `WarmRequest`。
- `revm-live-backend.ts`：把 per-hop quote 编码抽成 `encodeHopQuoteCalls`，
  `buildPrewarmCalls` 与新 `warmHotPools(blockNumber, hops)` 共用；后者对热池
  发 `client.warm`（上限 16 池）。
- `live-state-backend.ts`：接口加可选 `warmHotPools`。
- `main.ts`：`HotPoolTracker` 按 (target, tokenIn) 方向频率记录每个 hint 的
  route hop；`provider.on("block")` 在新块、且 **not busy / not warming** 时对
  top-K（`SEARCHER_WARM_TOP_K`，默认 8）发 `warmHotPools`。busy 守卫保证后台
  warm 不和 hint 的 prepare 在单线程 daemon 上互相排队。

### 验收（机制证明，本地）

```bash
npm run searcher:revm-warm
```

同一 daemon、对照 vs 处理：

| 场景 | 首 quote | cache | amountOut |
|---|---:|---|---|
| CONTROL（不 warm，prepare 不 trace route hop） | **1178ms** | 0 warm / 3 cold | 15677436334175943 |
| TREATMENT（先 `warmHotPools` 491ms，再同块 prepare） | **3ms** | 3 warm / 0 cold | 15677436334175943 |

- 那笔 1.2s 冷 fault 从 TTL 关键路径移到块间空档（warm 491ms，不占 TTL）。
- amountOut bit-exact——warming 只改"何时取 state"，不改"取到什么"。
- 附带：warmed 同块 prepare 自身 round_trips 3→2、wall 4026→1883ms（block
  header + accounts 已被 warm 命令预热）。

### 回归

```bash
npm run build                      # PASS（Rust + TS）
npm run searcher:lint              # PASS
npm run searcher:revm-quote        # PASS 3/3, diff=0（重构后 quote 仍 bit-exact）
npm run searcher:revm-warm         # PASS（机制证明）
tsx src/searcher/test/revm-prepare-timing.ts  # buildPrewarmCalls 重构无回归，
                                   # traced=1 / p50=2253ms / p95=2794ms 不变
```

### 落地后的 live 调法

1. 先 dry-run 让 `HotPoolTracker` 跑几分钟填充热集（top-K 频率）。
2. 热集稳定后设 `SEARCHER_REVM_PREWARM_ROUTE_HOPS=0`：per-hint route trace 整个
   去掉，靠后台 warm 让首 quote 命中 warm——这才是 trace_prefetch 从 ~3 trace
   降到 1（victim only）、prepare 进一步压到 ~1.5–2s 的开关。
3. 看 `expiredBeforeSolver` 是否相对 19 下降、蓝筹重叠机会能否跑完 quote。

### 明确不做 / 限制

- 后台 warm 只覆盖**复发**热池;首次见到的池仍冷(下一块起被 tracker 纳入)。
- warmer 与 hint 抢同一块时有竞态:块刚到、warm 未完时落的 hint 仍走冷
  prepare(可接受,下一块补)。
- 不在本任务改 `SEARCHER_REVM_PREWARM_ROUTE_HOPS` 默认值(仍为 2,保守);要靠
  上面第 2 步在 live 验证后手动切 0。

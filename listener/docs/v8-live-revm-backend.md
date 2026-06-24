# V8: Live-First revm Backend Plan

## 结论

V7 已经证明两件事：

- 策略逻辑能 work：live orderflow 下能 `detect → plan`，历史/回归路径也能证明 BotVM 执行能力。
- 当前 live 卡点不是 detector/planner，而是 **Anvil-over-RPC 的 victim state preparation 太慢**。

实测 live dry-run 中，多次出现：

```text
hint via logs → detector: 1 opportunities → planner: 4/8 candidate plans
→ opportunity expired (10-16s > TTL 5s)
→ solverSuccess=0
```

也就是说机会不是没抓到，而是在进入 solver 之前就被 TTL 杀掉。把 TTL 放大只能用于 debug，不能解决生产竞争窗口问题。

V8 的目标是保留现有 RPC/Anvil 作为基线和 final verify，同时新增本地 `revm` backend，把 live 热路径里的 state prep / quote / sim 从 Anvil RPC 往返迁到进程内执行。

---

## 核心目标

V8 最终验收只有一句话：

```text
revm backend 必须和现有 RPC/Anvil backend 得到同样的执行结果，只是更快。
```

也就是说，revm 不是新策略，不改变 detector/planner/solver/submit 语义。它只替换慢的执行环境：

```text
RPC/Anvil: 正确但慢
revm:     同样正确但快
hybrid:   revm 快速执行 + RPC/Anvil final verify
```

所以验收核心不是“revm 能不能跑起来”，而是：

| 项 | 要求 |
|---|---|
| 行为等价 | revm 与 RPC/Anvil 对同一个 plan 的 success/revert/profitToken/profit 结果一致 |
| 状态等价 | revm 准备的 victim 后状态与 RPC/Anvil victim 后状态一致 |
| 速度更快 | revm pre-solver + sim 显著快于 RPC/Anvil，满足 live 时间窗 |
| 安全提交 | production submit 仍以 final verified positive profit 为准 |

不是单纯证明 revm 能跑历史回测，而是证明：

```text
真实 live hint
  → 解析 opportunity
  → 构造 victim 后状态
  → plan
  → solve
  → final sim
  → dry-run would-submit / production submit
```

并且必须在 live 时间窗内完成。

最终 live 标准：

| 指标 | 要求 |
|---|---|
| opportunity → solver | >= 90% |
| expired-before-solver | 0 |
| pre-solver p95 | <= 2s |
| revm sim p95 | <= 500ms |
| live opportunity 有明确终态 | 100% |
| profitable 才 submit | 100% |
| hash-only approximate 默认不真发 | 100% |

---

## 后端切分

不要删除现有 RPC/Anvil 路径。V8 必须做成双 backend。

```text
SEARCHER_LIVE_BACKEND=rpc
  → 当前 Anvil fork / impersonate / eth_call / BotVMSimulator

SEARCHER_LIVE_BACKEND=revm
  → revm CacheDB / overlay victim state / local quote / local sim

SEARCHER_LIVE_BACKEND=hybrid
  → revm prepare + revm quote + revm sim
  → RPC/Anvil final verify only before submit
```

默认仍然是：

```text
SEARCHER_LIVE_BACKEND=rpc
SEARCHER_DRY_RUN=1
```

生产第一阶段只能用：

```text
SEARCHER_LIVE_BACKEND=hybrid
```

---

## Phase 0: Live Fixture Baseline

先建立真实 live fixture，而不是只用历史 AC-3。

新增目录：

```text
listener/searcher/live-fixtures/
  hints/*.json
  receipts/*.json
  reports/*.json
```

记录每个命中 opportunity 的信息：

```json
{
  "txHash": "0x...",
  "receivedAt": 0,
  "path": "hash-only | rawTx | mined",
  "pool": "0x...",
  "tokenIn": "0x...",
  "tokenOut": "0x...",
  "amountIn": "0",
  "stageMs": {
    "statePrep": 0,
    "detect": 0,
    "plan": 0,
    "solve": 0,
    "finalSim": 0,
    "total": 0
  },
  "finalState": "expired-before-solver | no-profitable-quote | sim-revert | final-verify-failed | would-submit"
}
```

### 验收

命令：

```bash
SEARCHER_DRY_RUN=1 \
SEARCHER_ENABLE_HASH_ONLY=1 \
SEARCHER_MIN_PROFIT_RAW=0 \
SEARCHER_RECORD_LIVE_FIXTURES=1 \
npm run searcher:live
```

通过条件：

- 至少记录 3 个真实 live opportunity fixture。
- 每个 fixture 必须包含 `pool/tokenIn/tokenOut/amountIn`。
- 每个 fixture 必须包含阶段耗时。
- 每个 opportunity 必须有明确终态：
  - `expired-before-solver`
  - `quote-timeout`
  - `no-profitable-quote`
  - `sim-revert`
  - `final-verify-failed`
  - `would-submit`
- 不允许出现“有 opportunity/plans 但后面无原因消失”。

---

## Phase 1: LiveStateBackend Boundary

只抽 `SimulationBackend` 不够，因为当前卡点发生在 solver 前。

新增接口：

```ts
interface LiveStateBackend {
  prepareVictimState(event: LiveEvent): Promise<PreparedState>;
  quote(req: QuoteRequest): Promise<QuoteResult>;
  simulate(plan: ResolvedPlan): Promise<SimulationResult>;
  finalVerify?(plan: ResolvedPlan): Promise<SimulationResult>;
}
```

实现：

```text
RpcAnvilLiveBackend
  → 当前 AnvilStateBackend + BotVMSimulator

RevmLiveBackend
  → revm CacheDB + local overlay + local EVM execution

HybridLiveBackend
  → revm prepare/quote/sim
  → RPC/Anvil finalVerify only before submit
```

### 验收

- `SEARCHER_LIVE_BACKEND=rpc` 走旧路径。
- `SEARCHER_LIVE_BACKEND=revm` 不启动 per-hint Anvil fork。
- `SEARCHER_LIVE_BACKEND=hybrid` 只在 final verify 时允许调用 Anvil。
- live hot path 不再直接依赖 `AnvilStateBackend`，只能依赖 `LiveStateBackend`。
- revm backend 不存在或启动失败时，`rpc` backend 仍能启动 live dry-run。

---

## Phase 2: revm Live Fixture Replay

用 Phase 0 记录的真实 live fixture 验证 revm，而不是先拿历史成功套利 tx 自嗨。

命令：

```bash
SEARCHER_LIVE_BACKEND=revm \
npm run searcher:replay-live-fixtures
```

每个 fixture 流程：

```text
load recorded live hint
  → revm prepare victim state
  → detector
  → planner
  → solver
  → revm final sim
```

### 验收

- 每个 fixture 必须进入 solver。
- 不允许 `expired-before-solver`。
- `prepareVictimState + detect + plan <= 500ms`。
- 单个 warmed quote `<= 10ms`。
- 单个 cold quote miss `<= 200ms`。
- 单个 warmed final sim `<= 100ms`。
- 单个 cold final sim `<= 500ms`。
- 缺 account/storage 时必须输出：

```text
missingStateKeys=[...]
```

不能静默 fallback 成成功。

---

## Phase 3: Live Dry-Run With revm

真实 MEV-Share，不真发 bundle。

命令：

```bash
SEARCHER_DRY_RUN=1 \
SEARCHER_LIVE_BACKEND=revm \
SEARCHER_ENABLE_HASH_ONLY=1 \
SEARCHER_MIN_PROFIT_RAW=0 \
npm run searcher:live
```

至少跑 30 分钟。

### 验收

- `hints > 0`
- `opportunities > 0`
- `plans > 0`
- `solverEntered / opportunities >= 90%`
- `expired-before-solver = 0`
- opportunity 命中后的总耗时：
  - `p50 <= 500ms`
  - `p95 <= 2000ms`
- 每个 opportunity 必须有最终状态：
  - `no-profitable-quote`
  - `sim-revert`
  - `final-verify-failed`
  - `would-submit`
- revm error 不能 crash live loop，必须计入 `revmErrors` 并继续处理后续 hint。

这一步证明 revm 解决了 live 卡死问题。

---

## Phase 4: Hybrid Live Dry-Run

revm 快速算，RPC/Anvil 只做最终确认。

命令：

```bash
SEARCHER_DRY_RUN=1 \
SEARCHER_LIVE_BACKEND=hybrid \
SEARCHER_ENABLE_HASH_ONLY=0 \
SEARCHER_MIN_PROFIT_RAW=0 \
npm run searcher:live
```

### 验收

- revm 找到 `revmProfit > 0` 时，必须触发 RPC final verify。
- RPC final verify 成功才打印 `would-submit`。
- revm 成功但 RPC 失败时必须打印：

```text
rejected-by-rpc-final-verify
```

- dry-run 下不广播。
- `hash-only approximate` 不能进入真 submit 路径。
- 日志必须包含：

```text
backend=hybrid
revmProfit=...
rpcProfit=...
revmLatencyMs=...
rpcVerifyLatencyMs=...
```

---

## Phase 5: Controlled Production

只有 Phase 3/4 通过后，才允许真发。

命令：

```bash
SEARCHER_DRY_RUN=0 \
SEARCHER_LIVE_BACKEND=hybrid \
SEARCHER_ENABLE_HASH_ONLY=0 \
SEARCHER_MIN_PROFIT_RAW=0 \
npm run searcher:live
```

提交条件：

```text
revm sim success
AND revm netProfit > 0
AND RPC final verify success
AND RPC final netProfit > 0
AND mode != hash-only approximate
```

### 验收

每次 `submitAttempts++` 前，必须打印：

```text
backend=hybrid
revmProfit=...
rpcProfit=...
finalVerify=pass
mode=rawTx | mined-standalone
targetBlock=...
```

通过条件：

- `profitable 才 submit` 为 100%。
- `hash-only approximate` 默认不真发。
- `accepted > 0` 时必须有 `bundleHash`。
- builder reject 必须记录 reject reason，不允许归因到 solver。

---

## Phase 6: revm Primary Path

只有在 hybrid 对齐足够多以后，才允许考虑：

```bash
SEARCHER_LIVE_BACKEND=revm
SEARCHER_DRY_RUN=0
```

前提：

- 至少 20 次 historical/live dry-run 对齐。
- 无 unexplained profit mismatch。
- 无 missing storage fallback。
- hash-only approximate 仍单独 gated。

---

## Stage Counters

V8 需要比 V7 更细的计数：

```text
hints
impacts
opportunities
plans
solverEntered
solverSuccess
revmSimSuccess
rpcVerifySuccess
submitAttempts
accepted
expiredBeforeSolver
quoteTimeouts
simReverts
finalVerifyFailed
missingState
revmErrors
```

每 30 秒打印一次：

```text
[searcher/live] counters
  backend=...
  hints=...
  opportunities=...
  solverEntered=...
  expiredBeforeSolver=...
  revmErrors=...
  submitAttempts=...
  accepted=...
```

---

## 不做

- 不删除 RPC/Anvil backend。
- 不直接 `revmProfit > 0 → submit`。
- 不让 hash-only approximate 默认真发。
- 不用历史成功套利 tx 作为唯一验收。
- 不把 revm 失败静默 fallback 成成功。

---

## Definition of Done

V8 完成必须满足：

- live fixture 能记录真实 opportunity。
- revm backend 能 replay live fixtures，并且所有 fixture 都进入 solver。
- 真实 live dry-run 中 `expired-before-solver = 0`。
- opportunity 命中后 `p95 <= 2s`。
- hybrid 模式下，revm profitable 必须 RPC final verify。
- production submit 只发生在 hybrid final verify 通过后。
- RPC/Anvil 路径始终保留，可随时切回。

---

## Final Acceptance: RPC Equivalence + Faster revm

V8 的最终验收分两条主线，必须同时满足。

### A. 等价性验收

同一个 live fixture / historical fixture，分别跑：

```text
SEARCHER_LIVE_BACKEND=rpc
SEARCHER_LIVE_BACKEND=revm
SEARCHER_LIVE_BACKEND=hybrid
```

对比：

| 字段 | 要求 |
|---|---|
| `success` | revm == RPC |
| `revertReason` | 同类 revert，不能一个成功一个失败 |
| `profitToken` | 完全一致 |
| `grossProfit` | 误差 <= 1 wei 或明确解释 rounding |
| `netProfit` | 误差 <= 1 wei 或明确解释 gas policy 差异 |
| `gasUsed` | 可不同，但必须记录 |
| touched pools/tokens | 必须一致 |
| missing state | 不允许 silent success |

如果不一致：

```text
revmMismatch
  txHash=...
  planHash=...
  rpcResult=...
  revmResult=...
  missingStateKeys=[...]
```

不一致时不能 submit。

### B. 性能验收

同一批 live fixtures，统计：

| 指标 | RPC/Anvil baseline | revm 要求 |
|---|---|---|
| prepare victim state | 现状 10-16s worst case | p95 <= 500ms |
| opportunity → solver | 当前常被 TTL 杀死 | >= 90% |
| expired-before-solver | 当前 6/6 机会过期 | 0 |
| quote warmed | RPC eth_call / Anvil | p95 <= 10ms |
| final sim warmed | Anvil send/mine/revert | p95 <= 500ms |
| opportunity total | 常 > TTL | p95 <= 2s |

revm 如果不比 RPC 快，V8 不算通过；revm 如果快但不等价，也不算通过。

---

## Implementation Phases For Equivalence

### Phase E0: RPC Baseline Fixtures

目标：建立 RPC/Anvil 的“真值集”。

输入：

```text
recorded live fixtures
historical AC fixtures
```

输出：

```text
baseline/rpc/*.json
```

每条 baseline 必须包含：

```json
{
  "fixtureId": "...",
  "backend": "rpc",
  "preparedStateHash": "...",
  "plans": 0,
  "bestPlanHash": "...",
  "success": true,
  "profitToken": "0x...",
  "grossProfit": "0",
  "netProfit": "0",
  "gasUsed": "0",
  "revertReason": null,
  "latencyMs": {
    "prepare": 0,
    "quote": 0,
    "simulate": 0,
    "total": 0
  }
}
```

验收：

- 至少 3 个 live opportunity fixture。
- 至少 1 个 historical profitable fixture。
- 每个 fixture 都有明确终态。
- RPC baseline 可重复跑，结果稳定。

### Phase E1: revm State Equivalence

目标：revm 准备出来的 victim 后状态要和 RPC/Anvil 一致。

先不跑完整 BotVM，只比关键读数：

```text
pool reserves / slot0 / liquidity / token balances / vault positions
```

验收：

- 对每个 fixture，关键 state read 与 RPC 一致。
- `missingStateKeys` 为空，或明确列出并能预加载后消失。
- `preparedStateHash` 与 RPC baseline 对齐，或差异能解释。
- 不允许把 missing storage 当 zero 成功。

### Phase E2: revm Quote Equivalence

目标：每条路径上的每段 quote 与 RPC quoter 一致。

对比：

```text
Curve get_dy
UniV2 getAmountOut
UniV3 exactInput
PSM
Fluid operate/dryrun
```

验收：

- 每段 `amountOut` 与 RPC quote 一致。
- 允许的误差：
  - pure integer pool: 0 wei
  - 有 rounding 的路径：<= 1 wei
- warmed quote p95 <= 10ms。
- cold miss p95 <= 200ms。

### Phase E3: revm BotVM Simulation Equivalence

目标：同一个 `ResolvedPlan`，revm 和 RPC/Anvil 执行结果一致。

流程：

```text
compilePlan(resolved.root)
→ buildExecuteCalldata(script)
→ RPC/Anvil simulate
→ revm simulate
→ compare
```

验收：

- `success` 一致。
- `profitToken` 一致。
- `grossProfit/netProfit` 一致。
- RPC revert 的，revm 也必须 revert。
- RPC success 的，revm 也必须 success。
- warmed sim p95 <= 500ms。

### Phase E4: Hybrid Final Verify

目标：live 可以先用 revm 快速跑，但 submit 前必须 RPC final verify。

流程：

```text
revm success && revmProfit > 0
→ RPC final verify
→ RPC success && rpcProfit > 0
→ submit / dry-run would-submit
```

验收：

- revm profitable 但 RPC failed：必须 `rejected-by-rpc-final-verify`。
- RPC final verify 成功才允许 `submitAttempts++`。
- dry-run 下输出 `would-submit`，不广播。
- production 下只允许 `mode=rawTx | mined-standalone` 提交。
- hash-only approximate 默认不真发。

### Phase E5: revm Primary

目标：只有在 E0-E4 稳定后，才允许 revm 成为 primary。

验收：

- 至少 20 个 fixture revm/RPC 对齐。
- 至少 30 分钟 live dry-run 无 unexplained mismatch。
- `expired-before-solver = 0`。
- opportunity total p95 <= 2s。
- production 仍可一键切回：

```bash
SEARCHER_LIVE_BACKEND=rpc
```

---

---

## Implementation Progress

> Updated 2026-06-11 to match what is actually built + verified. See the
> "V8 Review & Corrected Plan" section at the bottom for the task list (T1–T5);
> "remaining" rows point there.

| 项 | 状态 | 验证 |
|---|---|---|
| Live fixture recorder | done | `SEARCHER_RECORD_LIVE_FIXTURES=1` writes `hints/receipts/reports` |
| Stage counters | done | live logs include solverEntered/expiry/revmErrors counters |
| `LiveStateBackend` interface | done | `prepareVictimState(PrepareInput)` + `quote`/`simulate`/`finalVerify`; rpc/revm/hybrid impls |
| Victim overlay builder | **done + verified** | `live-backends/victim-overlay.ts`; live smoke: WETH→CRV overlay shifts pool `slot0` inside revm |
| `revm-sim serve` daemon | **done + verified** | JSON-lines `prepare`/`quote`/`simulate`/`reset`, per-block warm cache; repeat quote 3166ms→0ms |
| Persistent `RevmSimClient` | **done + verified** | rewritten off per-process `execFile`; FIFO transport smoke-tested end-to-end |
| revm execution + ERC20 delta | done | `RemoteRevmDb` + CacheDB + block/env + BotVM calldata + pre/post profit |
| `SEARCHER_LIVE_BACKEND` wiring | done | `rpc` always; `revm/hybrid` used for `mined` path + finalSim; revm prepare failure → `revmErrors`++ → Anvil fallback; block tag read at pre-victim `latest` |
| Equivalence harness tolerance | **partially done (T1)** | `replay-live-fixtures` now fails on empty reports / no runnable reports and requires profit diff ≤1 wei; still needs ≥3 live fixtures + ≥1 mined/profitable fixture |
| **Prewarm + batched state fetch** | **partially done (T2) — THE remaining live blocker** | warm cache proven (`searcher:revm-quote`: UniV3 cold 12750ms → warm 2ms, Curve cold 4271ms → warm 2ms) but live hints always land on a fresh block → cache dropped → cold overlay `prepare` **21.3–22.5s** → TTL expiry (2026-06-11 evening fixtures). Fix = access-list prefetch + cross-block cache persistence; see T2 |
| Quote-loop migration (hash-only fix) | **landed (T3) — live DoD blocked by T2** | `propagateAmounts` accepts `quoteSource`; `RevmLiveBackend.quote()` implements Curve/UniV2/UniV3/UniV4-fallback/PSM; hash-only skips Anvil fork/impersonate (lazy `ensureHintFork`); overlay deferred until plans>0; live 30-min counters + fixture candidate-equivalence pending T2 |
| Submit gate (verify policy) | **not started (T4)** | resolve Anvil-verify vs 2s-budget contradiction (parallel verify or sampled equivalence) |

## Next Core Implementation: `revm-sim` Execution

`revm-sim` 的下一步不是再加 TS 壳，而是实现真正的本地 EVM 执行层。必须一次性覆盖下面这些点，否则不能算 V8 revm backend。

### 1. RemoteRevmDb

实现 `revm::Database`：

```text
basic(address)
code_by_hash(code_hash)
storage(address, slot)
block_hash(block_number)
```

要求：

- 从 JSON-RPC 拉 mainnet account/code/storage。
- 查询结果写入进程内 cache。
- cache miss 必须可观测。
- RPC 失败不能静默当成 zero。

### 2. JSON-RPC State Fetch

支持：

```text
eth_getBalance
eth_getTransactionCount
eth_getCode
eth_getStorageAt
eth_getBlockByNumber / eth_getBlockByHash
```

要求：

- 按 fixture/live 指定 block 读取状态。
- 所有 state reads 都带 block tag。
- 输出 `missingStateKeys=[...]`，方便后续预加载。

### 3. Block Env / Tx Env

revm 执行前必须设置：

```text
chainId
blockNumber
timestamp
baseFee
gasLimit
coinbase
caller
to
calldata
value
gasLimit
```

要求：

- `caller = owner`
- `to = executor / BotVM`
- `calldata = BotVM.execute(script)` 或等价 backrun calldata
- 不允许用默认 block env 假跑。

### 4. BotVM Calldata Execution

执行对象：

```text
owner → BotVM executor → execute(script)
```

要求：

- executor code 必须来自链上或 fork-installed BotVM runtime。
- 调用失败时输出 revert / halt reason。
- 成功时输出 gas used。

### 5. Profit Delta

执行前后读取：

```text
balanceOf(profitToken, executor)
```

输出：

```text
grossProfit = post - pre
netProfit = grossProfit
```

要求：

- `profit > 0` 才能返回 success。
- `balanceOf` 也必须在 revm 内执行，不能回退到 Anvil。

### 6. JSON Output Contract

`revm-sim simulate fixture.json` 必须输出：

```json
{
  "success": true,
  "profit": "0",
  "gasUsed": "0",
  "revertReason": null,
  "latencyMs": 0,
  "missingStateKeys": []
}
```

要求：

- `success=false` 时必须有 `revertReason` 或 `missingStateKeys`。
- `latencyMs` 必须测真实执行耗时，不包含 TS 外层开销。
- 不允许 fake success。

### 7. Acceptance

第一阶段验收不是 production submit，而是：

```bash
npm run searcher:revm-health
SEARCHER_LIVE_BACKEND=revm npm run searcher:replay-live-fixtures
```

通过条件：

- 每个 live fixture 都进入 revm execution。
- 不再出现 `expired-before-solver`。
- revm 输出明确终态：
  - `no-profitable-quote`
  - `sim-revert`
  - `missing-state`
  - `would-submit`
- warmed `simulate` p95 <= 500ms。
- revm 报错不影响 `SEARCHER_LIVE_BACKEND=rpc` 路径。

---
---

# V8 Review & Corrected Plan (2026-06-11) — for Opus execution

> Reviewer note. This section supersedes the acceptance numbers above where they
> conflict. It records (a) what was actually built and verified, (b) three
> direction-level problems in the original plan, and (c) a sequenced, *measurable*
> task list to finish V8. Read this before touching code.

## What is built and verified (do not rebuild)

Verified locally on 2026-06-11 (cargo build + `tsc --noEmit` + live RPC smoke):

- **revm engine works.** `revm-sim` builds (revm 40.0.3, stable toolchain at
  `~/.rustup/toolchains/stable-aarch64-apple-darwin/bin`). `RemoteRevmDb` +
  `CacheDB` + `stateOverrides`/`tokenDeals`/`preCalls` execute real mainnet state.
- **Victim overlay is correct.** New `live-backends/victim-overlay.ts` turns a
  `PoolImpact` into `{tokenDeals, preCalls}` byte-for-byte mirroring
  `impersonateSwap`. Smoke-proven: applying the WETH→CRV overlay shifted the
  pool `slot0` sqrtPrice (`…511e435f…`→`…5115b230…`, tick `0x15772`→`0x1576a`)
  inside revm. **This is the equivalence keystone and it holds.**
- **Resident daemon + warm cache.** `revm-sim serve` (new) speaks JSON-lines:
  `prepare` / `quote` / `simulate` / `reset`, holding a per-block warm
  `RemoteRevmDb` shared across requests. Smoke: repeat `slot0` quote
  **3166ms → 0ms**. The persistent TS transport (`RevmSimClient`, rewritten off
  per-process `execFile`) reuses the warm cache end-to-end.
- **Wiring + counters.** `prepareVictimState` now takes `PrepareInput`
  (`impact`, `baseBlock`, `path`); revm prepare failures count `revmErrors` and
  fall back to Anvil; block tag fixed (read at pre-victim `latest`, not the
  non-existent `latest+1`).

## Three direction-level problems the original plan missed

1. **The plan abstracted `simulate()`, but the live bottleneck is *before* the
   solver and *inside the quote loop*.** The solver's Phase-1 amount search
   (`solver.ts` → `propagateAmounts`) reads pool state from **Anvil /
   `PoolStateCache`**, never from the backend. So `SEARCHER_LIVE_BACKEND=revm`
   cannot move the 10–15s (`impersonateSwap` state-prep + the eth_call/local-math
   quote search) off Anvil. **Making revm primary for hash-only REQUIRES
   migrating the quote loop to the daemon — that is the central remaining task,
   not an optional E2.** Until it lands, hash-only correctly stays on Anvil
   (the code does this and logs why).

2. **The cold-latency targets are physically impossible and have no owning
   task.** One uncached slot = one Alchemy round trip = **300–1300ms** (measured).
   A cold UniV3 swap touches dozens of tick/bitmap slots → the with-overlay
   `prepare` measured **12.2s cold**. So `cold quote ≤200ms` / `cold sim ≤500ms`
   cannot hold. Reframe (below): cold is first-touch and bounded by *round trips*,
   the real target is **warm**, and the lever is **prewarming + batched state
   fetch**, which must be a first-class task — not a footnote.

3. **Mandatory Anvil final-verify contradicts the 2s budget.** Phase 4/5 require
   an Anvil final-verify before submit, but that re-runs the 10–16s prep path →
   `targetBlock` is already mined → `accepted` is structurally 0 while
   "profitable-only submit" trivially passes. Pick one: (a) prepare the Anvil
   verify state *in parallel* with the revm solve so verify pays only one BotVM
   tx, or (b) gate submit on revm↔rpc equivalence proven over N offline samples
   and drop per-hint Anvil verify. The plan must state which; "verify on Anvil
   every hint, p95 ≤ 2s" is unattainable.

## Corrected acceptance (replaces conflicting numbers)

Latency is stated as **round-trip budget**, not wall-ms, because wall-ms is RPC-
bound and not what revm controls.

| Metric | Target | How measured |
|---|---|---|
| warm quote (state already fetched this block) | p95 ≤ 10ms | daemon `latencyMs` on 2nd+ quote of a slot |
| cold quote (first touch) | ≤ `roundTrips × rpcRtt`, `roundTrips` logged | daemon `latencyMs` + `missingStateKeys` count |
| warm `simulate` | p95 ≤ 500ms | daemon `latencyMs`, prepared state warm |
| prewarm coverage | ≥ 95% of solve-loop reads are warm | daemon counter: warm hits / total reads per hint |
| opportunity → solver (hash-only, post-migration) | ≥ 90% | `solverEntered / opportunities` |
| expired-before-solver (post-migration) | 0 over a 30-min run | counter |
| opportunity total (excl. cold first-touch of a brand-new pool) | p95 ≤ 2s | `stageMs.total` in reports, partitioned warm/cold |
| revm↔rpc equivalence | `success` equal; profit diff ≤ 1 wei or explained | E3 harness, per fixture |
| profitable-only submit | 100% | submit gate |

**Equivalence tolerance is 1 wei (or a written rounding explanation), not 100
bps.** `replay-live-fixtures.ts` currently accepts `withinBps(...,100n)` — tighten
to exact / ≤1 wei before E3 can pass.

## Task sequence (each task: goal → files → DoD with a runnable check)

### T1 — Equivalence harness on recorded fixtures  *(unblocks everything)*
- **Goal:** prove revm `simulate` == Anvil `simulate` on the same prepared state.
- **Files:** `test/replay-live-fixtures.ts` (tighten tolerance to ≤1 wei; print
  per-fixture `rpcProfit` vs `revmProfit`, `success`, `missingStateKeys`).
- **DoD:** record ≥3 hash-only + ≥1 mined fixture
  (`SEARCHER_RECORD_LIVE_FIXTURES=1`), then
  `SEARCHER_LIVE_BACKEND=revm npm run searcher:replay-live-fixtures` reports
  `revm equivalent = N/N`, every fixture `missingState=0`. **No fixture may be
  silently skipped.**

### T2 — Cold-prepare elimination: prefetch + cache persistence  *(THE remaining live blocker)*

**Live evidence (2026-06-11 evening, post-T3).** Two recorded hash-only fixtures
(`searcher/live-fixtures/reports/`); every stage is now ms-level **except the
overlay**:

```text
aba66188: match=680 prep=1 detect=1 overlay=21267 plan=1  total=21950ms → no-profitable-quote (plans=0, pre-reorder run)
9dbd8f82: match=340 prep=0 detect=2 plan=1 overlay=22514  total=22857ms → expired-before-solver (plans=4)
```

**Root cause (read from `revm-sim/src/main.rs`):**
1. `ensure_warm` discards the entire chain cache whenever the block number
   changes (`RemoteRevmDb::new(rpc, block, HashSet::new())`). Live hints always
   arrive on a fresh block, so every hint's `prepare` starts from an empty cache —
   the `searcher:revm-quote` warm numbers (2–3ms) never apply live.
2. The overlay `preCalls` (approve + victim swap) then execute against that empty
   cache: every first-touch account/code/storage read is one **serial** RPC round
   trip (300–1300ms each); a UniV3 swap touches dozens of slots → 21–22.5s.
3. The existing `prewarm` request param only calls `db.basic(addr)` (account+code)
   and runs **after** the preCalls — it cannot warm the swap execution.

- **Goal:** hash-only `overlay` stage p95 ≤ 2s on new-block hints; the solve loop
  never serial-faults slots mid-search.
- **Sub-tasks (in order of leverage):**
  - **T2a — access-list prefetch (kills the 22s).** Before executing preCalls,
    obtain the touched-state set in O(1) round trips: `debug_traceCall` with
    **`prestateTracer` + `stateOverrides`** per preCall against the remote RPC at
    `baseBlock` (NOT `eth_createAccessList` — the whale's token balance exists
    only in the local overlay, so on the remote node the swap reverts at the
    balance check and the returned list would miss the deep tick/bitmap slots;
    `stateOverrides` must inject the whale balance + token deal so the trace
    walks the full swap), then batch-fetch all `{address: [slots]}` + codes in
    1–2 JSON-RPC **batch** requests, seed the cache, then execute preCalls
    locally. Cold prepare collapses from ~40 serial RTTs to ~3–4 RTTs.
  - **T2b — cross-block cache persistence.** Stop discarding `RemoteRevmDb` on
    block advance: contract code and account info are block-stable — carry them
    over; only storage needs re-validation. Cheapest correct policy: keep
    code/accounts forever, drop storage per block (T2a re-seeds it cheaply).
    Better: invalidate storage only for pools that emitted Swap/Sync/TokenExchange
    logs in the new block (one `eth_getLogs` per block), keep the rest.
  - **T2c — background top-pool warmer (optional, after a+b).** Per new block,
    pre-seed the discovery set's top active pools (slot0/liquidity/tick words,
    token balances) so first-seen-pool hints start warm.
- **Files:** `revm-sim/src/main.rs` (`prepare`: access-list prefetch + batched
  fetch; `ensure_warm`: persistent code/account cache across blocks),
  `revm-sim-client.ts` / `revm-live-backend.ts` (surface per-stage `cacheStats`).
- **DoD:** live 30-min hash-only dry-run (`SEARCHER_LIVE_BACKEND=revm`):
  `overlay` p95 ≤ 2s, `expiredBeforeSolver=0`, `solverEntered/opportunities ≥ 0.9`,
  per-hint `cacheStats` logged with warm-hit ratio ≥ 95% during GSS.
  **T2 green = T3's outstanding live DoD unblocked = V8 live acceptance.**

### T3 — Quote-loop migration  *(THE fix for the live bottleneck, problem #1)*
- **Goal:** `propagateAmounts` reads pool state from the prepared (overlaid) revm
  state via `daemon.quote`, so hash-only no longer needs `impersonateSwap` or
  `PoolStateCache`. **"hash-only zero-Anvil" means the ENTIRE hot path, not just
  the swap** — measured Anvil costs that must all leave the hash-only path:
  `impersonateSwap` ~11s, `ensureFreshFork`/`refreshFork` 1.3–4.5s, detector
  token0/token1 eth_call 0.5–1s.
- **Files:**
  - `solver/amount-propagation.ts` + `solver/quoter.ts` — add a backend-quote
    source so the amount search reads from `daemon.quote`, not `state`/`cache`.
  - `live-backends/revm-live-backend.ts` — implement `quote()` per adapter:
    curve `get_dy`, univ2 `getReserves`+math or `getAmountsOut`, univ3 via
    Quoter/`exactInputSingle` staticcall — all as `daemon.quote` view calls
    against prepared state.
  - `main.ts` — when revm handles hash-only: skip `impersonateSwap` AND
    `prepareForkExecutor` AND the Anvil fork maintenance at `main.ts:415`
    (`ensureFreshFork`). Make fork maintenance **lazy/background** — only run it
    when an Anvil path is actually taken (rpc backend, or rawTx/mined fallback),
    not unconditionally at the top of every hint. Open the hash-only gate.
  - `detector` token query (`main.ts:241` `setTokenQuery`) — point at a **direct
    mainnet provider**, not `ctx.state` (Anvil). token0/token1 are static chain
    reads; routing them through the Anvil fork adds an eth_call to the hot path
    for no benefit (and is faster off the direct provider for rpc too).
- **DoD:** `SEARCHER_LIVE_BACKEND=revm` on a recorded hash-only fixture produces
  the **same candidate `flashAmount`/`fluidDebtBps`** the rpc path picks (±1 grid
  step), with **no Anvil call anywhere in the hot path**. The no-Anvil assertion
  must cover fork maintenance + detector token queries + quotes + sim — not just
  the swap (a hash-only hint must complete with `ctx.state` untouched). Live
  30-min: `expiredBeforeSolver=0`, `solverEntered/opportunities ≥ 0.9`.

Current smoke (2026-06-11):

```text
npm run build                         PASS
npm run searcher:lint                 PASS
cargo check --manifest-path revm-sim/Cargo.toml PASS
npm run searcher:revm-health          PASS
npm run searcher:revm-quote           PASS 3/3
  univ3-usdc-weth    diff=0 coldMs=13143 warmMs=3 warmHits=17/17
  curve-3pool-usdc-usdt diff=0 coldMs=4113 warmMs=2 warmHits=9/9
  psm-usdc-dai       diff=0 coldMs=0 warmMs=0
minimal live dry-run (`SEARCHER_LIVE_BACKEND=revm`, 1-block discovery) starts
without Anvil provider startup, builds graph, connects SSE, processes hints
without the prior `0x` log-data crash, and exits cleanly at `SEARCHER_MAX_HINTS`.
No opportunity was hit in that smoke window.
```

**T3 status (2026-06-11 evening live dry-run):** the migration works end-to-end —
hash-only hints run detect → plan → revm overlay → solver with `quoteSource`,
no Anvil call in the hot path (`ensureHintFork` is lazy and fires only on
rpc/fallback paths), and a 0-plan opportunity no longer pays the overlay
(backend prepare moved after the planner). What is **not** met is the live half
of the DoD: with plans>0 the hint still dies inside the cold overlay `prepare`
(21–22.5s → `expired-before-solver`, see T2 evidence). The remaining work for
live acceptance is entirely T2. Run the recorded-fixture candidate-equivalence
check (same `flashAmount`/`fluidDebtBps` as the rpc path) as soon as T2 lands.

### T4 — Submit gate (resolve problem #3)
- **Goal:** decide and implement the verify policy.
- **Files:** `live-backends/hybrid-live-backend.ts`, `main.ts`.
- **DoD (choose A or B, document it):**
  - **A (parallel verify):** Anvil victim-state prep runs concurrently with the
    revm solve; final-verify pays only the BotVM tx; total added latency ≤ 1
    block. Show `rpcVerifyLatencyMs` p95 ≤ 1500ms.
  - **B (sampled equivalence):** after ≥20 offline + ≥20 live aligned samples
    with 0 unexplained mismatch, submit on revm profit alone; per-hint Anvil
    verify removed. Show the alignment ledger.
- Either way: dry-run prints `would-submit` with `revmProfit`/(`rpcProfit`),
  `mode != hash-only-approximate`, and `accepted>0 ⇒ bundleHash` once live.

### T5 — Controlled production
- Unchanged from original Phase 5/6, but **only after T2 shows
  `expiredBeforeSolver=0` live (T3 is landed; T2 is its live gate) and T4's
  gate is green.** Keep `SEARCHER_LIVE_BACKEND=rpc` as the one-flag rollback.

## Known smaller fixes still open
- `revm-sim` `execute_call` has a dead `stateful` bool (both branches identical) —
  remove or use it.
- Daemon `prepare`'s `prewarm` param only calls `db.basic()` (account+code) and
  runs **after** the preCalls, so it cannot warm the victim-swap execution —
  subsumed by T2a/T2b.
- hint `match` stage is 340–680ms (token0/token1 lookups per unknown pool, now on
  the direct provider) — acceptable; cacheable in the graph if it ever matters.

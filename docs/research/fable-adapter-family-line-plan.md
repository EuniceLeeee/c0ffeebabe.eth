# Fable 独立版 — Adapter Family 全量框架计划（swap / protocol / flash 一律以 family 形式）

> **角色**：本文是 Fable 5 独立起草的版本，与 Codex 独立起草的 canonical 版
> [adapter-family-line-plan.md](adapter-family-line-plan.md) 构成**互评对**。两文各自保持独立立场原样；
> 分歧在互评记录中逐条裁决，采纳结论只改 canonical 版。本文不是第二真相源，不驱动实施。
> 基线：`origin/main @ ad35790`。所有行号锚点已按该 SHA 核实。
> 状态：设计稿。未实现；不使任何历史 gap 变为 fixed。

## 0. 本轮定位（用户拍板，2026-07-23）

1. **重点是全量 adapter family 框架，不是升级单个 adapter。** 框架建成后，单 adapter 迁移应是薄活。
2. **一律以 family 形式存在**：只要是接入的 adapter，不分 swap / protocol / flashloan，都必须是
   adapter family——统一的是**形式**（注册契约、谱系框架、conformance、状态 capability），不是运行路径：
   各类保留各自的谱系框架与运行时 lane。"线"指生产 family 的公共框架，不是一条混用的运行管道。
3. **孤岛政策**：已有 adapter 但尚未升级成 family 形式的——**保留 adapter 文件**，但把"为了让它在旧线
   上跑起来"而穿进共享代码的接线**切断**，退成孤岛文件（不再被线引用）。共享代码里不允许残留
   按-adapter 特判。
4. **公共框架吃掉共性，family 变轻**。用户点名的六项公共职责（§3.2 Conversion 谱系）：
   asset → receipt edge 构造；approve；exact-in quote 结果检查；receipt 余额增加；无 standing position；
   plan/final-sim 约束。

## 1. 现状矩阵（2026-07-23 按 `ad35790` 逐项核实，非记忆）

执行层已经全部 family 化（16 个 adapter 都在 `PRODUCTION_ROUTE_ADAPTERS`，
[production-registry.ts:53-69](../../listener/src/searcher/venues/production-registry.ts:53)）；缺口在
**状态层**、**flash 入册**和**孤岛接线**：

| adapter | kind | identity 政策 | 状态层（`warm`） | prepared | 缺什么 |
|---|---|---|---|---|---|
| univ2 / univ3 / univ4 | swap | onchain-resolver ×2；v4 singleton-seed | `mutable-pool` 专用批处理 | ✅ | 样板，仅待并入协调器（S0）|
| curve-plain | swap | onchain-resolver | `curve-pool` 两轮串行 → 9.6s | ✅ | 状态层批处理（S1）|
| curve-underlying | swap | onchain-resolver | **`external-mid` 逐边** | ✅(custom) | 状态层（S2）|
| balancer-v3 | swap | onchain-resolver | **`external-mid` 逐边** | ❌ null | 状态层（S2）+ prepared |
| dodo-v2 | swap | onchain-resolver | **`external-mid` 逐边** | ✅ | 状态层（S2）——**"DODO 没 family 化"的真实含义就是这一格** |
| fluid-dex | swap | singleton-seed | external-mid + **main.ts:4749 特判** | — | 孤岛候选（§6）|
| erc4626 / goldx / metronome×2 / psm / eigenpie / rocksolid / wsteth | protocol-conversion | singleton-seed；erc4626/eigenpie 另有 discovery+identity | **`protocol-mid` 逐边 quote** → 11.6s | null | 状态层（S3）|
| fluid-credit | compat | — | — | — | 孤岛候选（§6）|
| balancer-flash / morpho-flash | **registry 外** | 描述符表 + **动态链上 borrowability**（`balanceOf(token, holder)`，非 allowlist，[flash-liquidity.ts](../../listener/src/searcher/solver/flash-liquidity.ts)）| **已是每块一个 Multicall batch** ✅ | n/a | 入册 + conformance（§4）|

共享路径的按-adapter 特判**只有一处**（[main.ts:4749](../../listener/src/searcher/main.ts:4749)
`edge.adapterId === "fluid-dex-swap"`）；plan-builder / token-graph / exact-route 零特判（已 grep 验证）。
所以框架工程量集中在 WarmSpec 四桶 switch 的收敛，不是大扫除。

## 2. 框架的五个部件

```
                        ┌──────────────────────────────────────────────┐
                        │  PRODUCTION_ROUTE_ADAPTERS（唯一注册源，全 kind）│
                        └──────┬───────────────────────────────────────┘
             ┌─────────────────┼──────────────────────┬────────────────┐
       kind: "swap"    kind: "protocol-conversion"  kind: "flash-liquidity"（新）
             │                 │                      │
   ┌─────────┴─────────┐ ┌─────┴──────────────┐ ┌─────┴──────────────┐
   │ Swap 谱系框架      │ │ Conversion 谱系框架 │ │ Flash 谱系框架      │   ← §3 谱系框架层
   └─────────┬─────────┘ └─────┬──────────────┘ └─────┬──────────────┘
             └─────────────────┴──────────────────────┘
                               │
              BlockScanStateCoordinator（双 lane 状态协调器,§5）
                               │
              conformance 门（启动断言 + 共享代码零特判 grep 门）
```

1. **唯一注册源**：`PRODUCTION_ROUTE_ADAPTERS` 扩成全 kind——新增 `RouteLegKind`"flash-liquidity"。
   继续执行 auto-discovery plan §14 边界：一个 adapter 就是一个 family；发现与身份同次交付；
   framework 永远不是 owner。
2. **谱系框架层**（§3）：三个谱系框架吃掉共性，family 只剩差异声明。
3. **状态协调器**（§5）：双 lane 时效层——这是当前最大的延迟债（28.7s pass → `skipped=busy`）。
4. **conformance 门**：启动断言（family 契约完整性、discovery+identity 同交付、§5.4 硬护栏）+
   **共享代码零特判门**——CI grep 断言共享路径文件不含 `adapterId === "` 字面量分支（孤岛目录白名单）。
5. **孤岛区**（§6）：未迁移 adapter 的保命接线的唯一去处。

## 3. 谱系框架层：共性下沉，family 变轻

### 3.1 framework ≠ family（沿用 §14 边界 6）

ERC4626 deposit、Eigenpie deposit 的 identity、quote ABI、calldata、事件、rounding 各不相同——谱系框架
**不注册、不拥有 pool/edge/action ID**，只提供共享执行骨架。已存的 `ReceiptDepositFramework` 就是这个
形态的第一个实例；本文把它推广成三谱系，不是发明新概念。

### 3.2 三个谱系框架各吃什么

| 谱系 | 吃掉的公共职责 | family 剩下什么 |
|---|---|---|
| **Conversion**（deposit/mint/wrap/redeem 类） | 用户点名的六项：asset→receipt edge 构造；approve；exact-in quote 结果检查；receipt 余额增加断言；无 standing position；plan/final-sim 约束。加上：funded-caller state-override probe、ERC20 storage-key 提取（已在 `protocol-discovery-erc20-state.ts`） | identity 根（singleton/registry 调用）、quote ABI、calldata 编码、事件/rounding 断言、`deriveMid` 数学 |
| **Swap**（池对池） | pair edge 构造；池 identity 反查（factory/registry）；quote 结果符号与 taxonomy 检查；plan fragment 不变量（输入耗尽/输出入账）；无 standing position；final-sim 约束 | 池数学（reserve/slot0/A/PMM）、tick/rate 元数据 schema、`deriveMid`、prepared-lane quote |
| **Flash**（借还同 tx） | 动态 borrowability（链上 balanceOf，非 allowlist——现有实现直接升格为框架职责）；borrow/repay 守恒；lender before/after 余额不变断言（final sim 已有，上收为框架断言）；repayment 形态（approve-pull / transfer）编排 | 描述符（target/holder/paramShape/priority）+ ActionAdapter 编码 |

### 3.3 "轻"的可验收定义

框架建成后，新增一个 family 只允许包含：**identity 解析 + 调用描述符（quote/execute ABI）+ 数学/断言
差异 + capability 声明**。量化验收：新 family（不含测试）**≤ 200 行**；若超出，先怀疑框架缺了一块共性，
而不是把共性写进 family。Eigenpie（当前形态）做基准回测：框架完成后按此契约重写应显著低于现在的行数。

## 4. Flash family 化（第三 kind 的具体形状）

现状已达标的部分**原样保留**：`FLASH_PROVIDER_DESCRIPTORS` 描述符表
（[flash-providers.ts](../../listener/src/adapters/flash-providers.ts)，target/holder/repayment/paramShape/
双 priority）、动态 borrowability、每块一个 Multicall 刷新。要改的只有归属：

1. `balancer-flash` / `morpho-flash` 各注册为 `kind: "flash-liquidity"` 的 family（描述符即声明）；
2. plan-builder 不再 import `DEFAULT_FLASH_ADAPTER_ID` 常量，改从 registry 取
   （[plan-builder.ts:42](../../listener/src/searcher/solver/plan-builder.ts:42) 的默认参数是最后一个
   registry 外接线）；
3. `FlashLiquidityCache` 的刷新并入状态协调器（行为不变：每块、批量、动态）；
4. conformance 新增：flash family 必须声明 liquidityHolder 且 final sim 断言 lender 余额 before==after。

注意：**这里没有"admission"问题**——flash provider 是基础设施 singleton（CLAUDE.md §2 允许 pin 的
identity 源），不是实例 allowlist；borrowability 本来就动态。

## 5. 状态层：双 lane 时效架构（完整图 <10s）

### 5.1 证据：为什么必须做（live 已锁定，非推测）

tx `0x055f5c…` 复盘的最终事实：live funnel 里**没有**该路线"发现后放弃"的记录——所需源块被整轮跳过。

| 事实 | 数值 | 出处 |
|---|---|---|
| `source=25585379` 的 pass 总耗时 | **28,739ms** | 生产日志（SSM `4afc0b54`）|
| 其中 Curve warm / protocol mids | 9,629ms / 11,630ms（合计 ≈74%）| 同上 |
| `25585380`（目标源块）、`25585381` | `skipped=busy`（[main.ts:1781](../../listener/src/searcher/main.ts:1781)）| 同上 |
| 图规模 | 29,220 边 > 20,000 → pass 预算升至 30s | 同上 |
| refine 结果 | 预留 8s solve 后耗尽：`exactRouteProbes=0`、`deadline=1`，solve 未运行 | 同上 |
| funnel 事件 | 该块 4 条 `opportunity_seen`/5 条 drop 全是其他 mempool 候选，无本路线 | `analysis:block-activity`（SSM `1732ec95`，exit 0；manifest SHA `90cd32d7…a08c9`）|

busy 机制在代码里逐字可见：`blockScanBusy` 是**单个布尔**
（[main.ts:1723](../../listener/src/searcher/main.ts:1723)），无队列、无抢占、无历史源块补扫。

### 5.2 根因：pass 是纯串行阶段链

`WarmSpec` 只有四个桶（[route-leg-adapter.ts:73](../../listener/src/searcher/venues/route-leg-adapter.ts:73)：
`mutable-pool / curve-pool / external-mid / protocol-mid`），`main.ts` 按桶各写一套刷新逻辑（消费点散布
[4427](../../listener/src/searcher/main.ts:4427)–[5016](../../listener/src/searcher/main.ts:5016)），且
每段顺序 `await`——阶段名就是 `passBudgetExceeded(stage)` 的实参：

| 阶段（执行顺序） | 锚点 | 实际行为 |
|---|---|---|
| `warm_plan` → `warm_v2v3` | [main.ts:1956](../../listener/src/searcher/main.ts:1956) / :1962 | 专用批处理——**Uni 快的唯一原因** |
| `warm_verify` / `v3_tick_meta` | :1987 / :2002 | 校验/元数据 |
| `warm_curve` | :2012 `await` [warmBlockScanCurves:4908](../../listener/src/searcher/main.ts:4908) | 226 池 × 8 chunk × **两轮**；chunk 在 [pool-state-cache.ts:985](../../listener/src/searcher/solver/pool-state-cache.ts:985) **顺序 await** → 9.6s |
| `protocol_mids` | :2085 `await` [buildBlockScanProtocolMids:4621](../../listener/src/searcher/main.ts:4621) | **逐 edge task**（签名收 `edges[]`+`concurrency`）：约 1,879 个 quote × 并发 24（[main.ts:732](../../listener/src/searcher/main.ts:732)）≈ 79 波 → 11.6s |
| `curve_mids` → `scan` → `refine` | :2100 / :2138 / :2155 | 到这里预算已尽 |

**Uni 快是因为独享批处理；Curve/protocol/external 慢是因为逐 edge + 串行，不是"每块刷新"本身。**

### 5.3 时效契约：按 lane 统一规则，**不是统一 TTL**

"protocol 统一 TTL 10 blocks"曾被提出，**已撤回**（用户否决："突然有个区块汇率大更新就找不到机会了"）：

- 机会往往恰好发生在**更新块**：ERC4626 donation/harvest/loss 单块跳变；wstETH oracle report 离散更新；
  PSM `tin/tout` 一次治理直接改。
- stale mid 的失败模式是**假阴性**：旧 mid 看着无利 → coarse scanner 不产候选 → exact probe / final sim
  根本不执行。**final sim 只能过滤假阳性，救不了假阴性。**

| 数据 | 允许的块 | 责任方 |
|---|---|---|
| Graph topology | 允许滞后，最多 **T-10** 已验证 snapshot（分歧点：canonical 版要求 watermark 证明，见互评）| 后台 discovery，不在热路径 |
| Swap 动态价格状态 | **source block N** | swap lane：有可靠事件的池只刷 changed；无可靠事件的每块读最小 sentinel |
| Protocol 动态兑换状态 | **source block N** | protocol lane：每唯一实例批量读一次最小状态 |
| Coarse mids | 从 N 的最小状态**本地推导** | 各 family 的 `deriveMid` |
| Exact probe / final sim | **source block N** | 现有 solver/sim，不变 |

TTL 仅限**静态**部分（schema/descriptor/decimals/拓扑/后台巡检）。事件驱动只能做"优先刷新"，不能做
唯一失效依据——Curve NG `stored_rates` 可因外部依赖变化而无目标合约日志，ERC4626 同理。Curve 今天慢
是两轮串行 + 逐边解析 metadata，不是每块刷新的物理代价——批处理后应与 Uniswap 同量级。

### 5.4 接口与硬护栏

`WarmSpec` 收敛为 per-family capability，调度归唯一协调器；family 声明"怎么读、怎么解码、怎么算"，
**不得自己决定调度**：

```ts
interface BlockScanStateCapability {
  readonly lane: "swap" | "protocol";
  stateKey(edge): string;                   // 按池/实例去重；N 条 edge 共享一个 key
  staticReadPlan?(edge): Call[];            // schema —— 长期缓存
  dynamicReadPlan(edge, schema): Call[];    // 当前块 N 的最小动态状态
  decode(results): StateSnapshot;
  deriveMid(snapshot, edge): Mid;           // 纯本地：一个 snapshot 派生 N 条 edge
  eventDependencies?(edge): Address[];      // 仅"优先刷新"提示
  batching: "multicall" | "rpc-batch";      // 依赖 msg.sender 的走固定 from 的 batch
}
```

流程：按 lane + stateKey 分组去重 → 双 lane 并行批量读（source-block N pin）→ decode →
`deriveMid` 映射回所有 edge → 原子发布 → 全 lane 就绪后跑完整 graph scanner（edge 数/顺序/hash 不变）。

硬护栏（conformance 必须断言）：

1. **`deriveMid` 禁止读链**——谁在里面调 quoteExact，谁就退回逐 edge = 回到 11.6s。
2. **一个 stateKey 只读一次**——N→1 收益的本体（1,879 task → 少数几个 batch）。
3. **stale/unresolved mid 不得把路线判成 no-opportunity**——只能标"需 exact probe"。
4. **无法本地派生的 family** 才走批量 quote fallback，必须合批，不逐 edge。
5. **duplicate-key 胜出规则、edge 顺序、graph hash 不变。**

### 5.5 busy 调度：latest-head 单槽抢占

`blockScanBusy` 布尔改为 latest-head single-slot：新 head **取消**进行中的 pass（AbortSignal 贯穿全程），
只保留最新 pending source；被取消 pass 完全 settle 后才复用 Anvil/cache；final sim 前后、submit 前重校验
source block hash；**不排队历史块**——解法是 <10s 让下一个不再错过。
（分歧点：canonical 版将"立即取消 vs 让短任务 settle"列为尚待实测；本文立场是形态可先定、参数实测。）

### 5.6 <10s 预算（目标，非结论）与禁用捷径

严格口径：29,220 边不减、所有 slow edge 仍读当块状态。预算：状态就绪 ≤4.5s、完整图 scanner ≤1.8s、
probe/solve/final sim ≤3.2s、余量 0.5s → **p95 head_seen→scanner_done <10s**。

| 禁用捷径 | 原因 |
|---|---|
| 30s 预算直接改 10s | scanner 前退出，什么都没扫 |
| 只并行 Curve + protocol mids | 推算约 19.1s，仍不够 |
| 统一 TTL 让动态价格变旧 | 机会在更新块；假阴性（§5.3）|
| mid 只按目标合约日志失效 | 无目标日志的状态变化会漏 |
| 只调大 `MID_CONCURRENCY` | 可能打爆 Anvil/reth；逐 edge 模型没变 |
| 先扫 V2/V3/V4、慢图以后再说 | 不是完整图 <10s |

## 6. 孤岛政策（用户拍板：切断保命接线）

**规则**：adapter 文件保留；共享代码里为其存在的特判/兼容接线**移出**到 `venues/islands/`（或直接删除，
无人引用即成孤岛文件）；共享代码不 import 孤岛目录。每个孤岛文件头部必须写 (a) 属于哪个 adapter、
(b) 缺哪块 family 契约、(c) 迁移或删除条件。

当前孤岛候选（穷举，已核实）：

| 候选 | 现状 | 处置 | 覆盖影响（显式，不许静默） |
|---|---|---|---|
| `fluid-dex-swap` 特判（main.ts:4749） | 共享代码唯一按-adapter 分支 | 特判移出；fluid-dex 若不在本轮实现 `blockScanState`，其边不再进 block-scan | fluid-dex 的 block-scan 覆盖暂停，列入迁移队列；backrun 不受影响 |
| `fluid-credit` compat adapter | `kind: "compat"` 整类 | 保留文件，线不引用；compat 谱系随 auto-discovery plan Slice 6 清退 | credit 本就在目标范围外（CLAUDE.md §3），无生产覆盖损失 |
| `WarmSpec` 四桶 | 状态层旧协议 | 由 capability 投影为兼容 shim，F5 清退 | 无——投影期逐 wei 等价 |

**红线**：任何因孤岛化产生的生产覆盖变化必须出现在上表和部署说明里；静默丢覆盖就是自己制造 pool gap。

## 7. 实施切片（框架先行，adapter 迁移是薄活）

strangler + 逐 wei 等价纪律（每片单独提交、单独验证，不等价即 fail）。
（分歧点：canonical 版选"一次 cutover + shadow parity + 原子翻转"并否决中间态；本文立场见互评——
在 bounded-live 正在运行的系统上，分片可审计的爆炸半径更小。）

| 片 | 内容 | 等价/验收 |
|---|---|---|
| **F0** | registry 扩全 kind（+flash-liquidity）；conformance 门（契约完整性 + 零特判 grep） | 纯增量，现有 conformance 全绿 |
| **F1** | 谱系框架抽取：`ReceiptDepositFramework` 推广为 Conversion 框架；Swap/Flash 框架落地 | 现有 family 全部改挂框架，route-adapters/replay 套件 bit-identical |
| **F2** | 状态协调器（§5）：S0 包装 V2/V3/V4 → S1 Curve 一轮批 → S2 清退 external-mid 桶（dodo/balancer/curve-underlying）→ S3 protocol 接入 | 每步 mid bit-identical；延迟见 §5.6 |
| **F3** | flash 入册（§4 四步） | plan/final-sim 输出逐字节等价；lender 余额断言上收 |
| **F4** | 孤岛化（§6 表全部执行） | 零特判门变绿；覆盖影响表随部署说明发布 |
| **F5** | `WarmSpec` shim + `buildBlockScanProtocolMids` / `warmBlockScanCurves` / busy 布尔删除，busy 换单槽抢占（§5.5） | 删除后全套 replay + A/B |

行为可能变化的片（F2 延迟、F4 覆盖、F5 抢占）走 Hermes A/B；纯等价片（F0/F1/F3）deterministic 替换，
走 replay+smoke 直进 main（HISTORICAL-GAP 机械分流）。

## 8. 验收门（整线）

1. conformance 全绿，含新三条：全 kind 注册、flash lender 断言、**共享代码零特判**（grep 门，孤岛目录白名单）。
2. 新 family 契约压力测试：按 §3.3 重写一个现有 family（建议 Eigenpie），行数与内容符合"轻"定义。
3. 状态层四门：同 graph snapshot 生产形态 A/B 逐项等价（route fingerprint/候选排序/probe 符号/final sim）；
   **p95 <10s 且连续重块 `skipped=busy` 归零**；"更新块汇率跳变"样本当块即捕捉；§5.4 五条硬护栏断言。
4. 孤岛表逐条落地，覆盖影响显式发布。
5. 定锚交易验收：tx055f 六步 + 秒级时限（细则已并入 canonical 版 §8.5，两文共享同一标准，含
   时限不达标的"诚实 fail + 升级讨论"出口）。
6. 诚实边界：`tool-index --select latency,performance` 当前无工具覆盖——延迟结论要先补测量工具；
   本文完成 ≠ 任何历史 gap fixed，fixed 仍要 scanner 自发枚举 + final sim（gates.md）。

## 9. 与 canonical 版的关系

- canonical（Codex）版 [adapter-family-line-plan.md](adapter-family-line-plan.md) 驱动实施；本文是独立
  对照版，只用于互评与裁决记录。
- 两文重合的结论（双 lane、source-N 动态状态、deriveMid 本地化、stateKey 去重、flash 非价格 lane、
  禁 TTL/减图/参数硬凑）视为已收敛。
- 分歧点在文中就地标注（§5.3 topology T-10 vs watermark、§5.5 抢占形态、§7 strangler vs 一次 cutover、
  §3.3 200 行量化阈值），裁决走互评记录，采纳结论只改 canonical 版。

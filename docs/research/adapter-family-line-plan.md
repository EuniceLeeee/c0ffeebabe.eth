# Adapter Family 线 — 全量 family 框架计划（swap / protocol / flash 一律 family）

> 基线：`origin/main @ ad35790`。作者：Fable 5（2026-07-23）。评审协议见 §9：本文与 Codex 互审，分歧落表。
> 关系：[codex-adapter-family-auto-discovery-plan.md](codex-adapter-family-auto-discovery-plan.md)（执行层
> family + 自动发现，已落地第一版 §14）和
> [blockscan-state-lane-family-plan.md](blockscan-state-lane-family-plan.md)（状态/时效层双 lane 设计）是本文
> 的两根支柱；本文是把它们连成**一条完整生产线**的总纲。
> 状态：**设计稿。未实现；不使任何历史 gap 变为 fixed。**

## 0. 本轮定位（用户拍板，2026-07-23）

1. **重点是全量 adapter family 框架线,不是升级单个 adapter。** 框架建成后,单 adapter 迁移应是薄活。
2. **一律 family**:只要是接入的 adapter,不分 swap / protocol / flashloan,都走同一条 family 线。
3. **孤岛政策**:已有 adapter 但尚未升级成 family 的——**保留 adapter 文件**,但把"为了让它在旧线上跑起来"
   而穿进共享代码的接线**切断**,这些接线可以退成孤岛文件(不再被线引用)。共享线里不允许残留按-adapter
   特判。
4. **公共框架吃掉共性,family 变轻**。用户点名的六项公共职责(§3.2 conversion 谱系):
   asset → receipt edge 构造;approve;exact-in quote 结果检查;receipt 余额增加;无 standing position;
   plan/final-sim 约束。

## 1. 现状矩阵（2026-07-23 按 `ad35790` 逐项核实，非记忆）

执行层其实已经全部 family 化（16 个 adapter 都在 `PRODUCTION_ROUTE_ADAPTERS`，
[production-registry.ts:53-69](../../listener/src/searcher/venues/production-registry.ts:53)）；缺口在
**状态层**、**flash 入册**和**孤岛接线**：

| adapter | kind | identity 政策 | 状态层（`warm`） | prepared | 缺什么 |
|---|---|---|---|---|---|
| univ2 / univ3 / univ4 | swap | onchain-resolver ×2；v4 singleton-seed | `mutable-pool` 专用批处理 | ✅ | 线上样板，仅待并入协调器（S0）|
| curve-plain | swap | onchain-resolver | `curve-pool` 两轮串行 → 9.6s | ✅ | 状态层批处理（S1）|
| curve-underlying | swap | onchain-resolver | **`external-mid` 逐边** | ✅(custom) | 状态层（S2）|
| balancer-v3 | swap | onchain-resolver | **`external-mid` 逐边** | ❌ null | 状态层（S2）+ prepared |
| dodo-v2 | swap | onchain-resolver | **`external-mid` 逐边** | ✅ | 状态层（S2）——**"DODO 没 family 化"的真实含义就是这一格** |
| fluid-dex | swap | singleton-seed | external-mid + **main.ts:4749 特判** | — | 孤岛候选（§5）|
| erc4626 / goldx / metronome×2 / psm / eigenpie / rocksolid / wsteth | protocol-conversion | singleton-seed；erc4626/eigenpie 另有 discovery+identity | **`protocol-mid` 逐边 quote** → 11.6s | null | 状态层（S3）；六项公共职责已由 `ReceiptDepositFramework` 吃掉 deposit 谱系的一部分 |
| fluid-credit | compat | — | — | — | 孤岛候选（§5）|
| balancer-flash / morpho-flash | **registry 外** | 描述符表 + **动态链上 borrowability**（`balanceOf(token, holder)`，非 allowlist，[flash-liquidity.ts](../../listener/src/searcher/solver/flash-liquidity.ts)）| **已经是每块一个 Multicall batch** ✅ | n/a | 入册 + conformance（§4）|

共享路径的按-adapter 特判**只有一处**（[main.ts:4749](../../listener/src/searcher/main.ts:4749)
`edge.adapterId === "fluid-dex-swap"`）；plan-builder / token-graph / exact-route 零特判（已 grep 验证）。
所以"线"的工程量集中在 WarmSpec 四桶 switch 的收敛,不是大扫除。

## 2. 家族线的五个部件

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
              BlockScanStateCoordinator（双 lane 状态协调器,状态层文档 §3）
                               │
              conformance 门（启动断言 + 共享线零特判 grep 门）
```

1. **唯一注册源**：`PRODUCTION_ROUTE_ADAPTERS` 扩成全 kind——新增 `RouteLegKind`"flash-liquidity"。
   继续执行 §14 的边界：一个 adapter 就是一个 family；发现与身份同次交付；framework 永远不是 owner。
2. **谱系框架层**（§3）：三个谱系框架吃掉共性，family 只剩差异声明。
3. **状态协调器**：状态层文档的双 lane 设计原样并入（swap lane / protocol lane；flash 的 borrowability
   刷新已经是目标形态，接进协调器只是换 owner，不改行为）。
4. **conformance 门**：启动断言（family 契约完整性、discovery+identity 同交付、§3.1 五条硬护栏）+
   **共享线零特判门**——CI grep 断言共享路径文件不含 `adapterId === "` 字面量分支；孤岛文件目录除外。
5. **孤岛区**（§5）：未迁移 adapter 的保命接线的唯一去处。

## 3. 谱系框架层：共性下沉，family 变轻

### 3.1 framework ≠ family（沿用 §14 边界 6）

ERC4626 deposit、Eigenpie deposit 的 identity、quote ABI、calldata、事件、rounding 各不相同——谱系框架
**不注册、不拥有 pool/edge/action ID**，只提供共享执行骨架。已存的 `ReceiptDepositFramework` 就是这个
形态的第一个实例；本文把它推广成三谱系,不是发明新概念。

### 3.2 三个谱系框架各吃什么

| 谱系 | 吃掉的公共职责 | family 剩下什么 |
|---|---|---|
| **Conversion**（deposit/mint/wrap/redeem 类） | 用户点名的六项：asset→receipt edge 构造；approve；exact-in quote 结果检查；receipt 余额增加断言；无 standing position；plan/final-sim 约束。加上：funded-caller state-override probe、ERC20 storage-key 提取（已在 `protocol-discovery-erc20-state.ts`） | identity 根（singleton/registry 调用）、quote ABI、calldata 编码、事件/rounding 断言、`deriveMid` 数学 |
| **Swap**（池对池） | pair edge 构造；池 identity 反查（factory/registry）；quote 结果符号与 taxonomy 检查；plan fragment 不变量（输入耗尽/输出入账）；无 standing position；final-sim 约束 | 池数学（reserve/slot0/A/PMM）、tick/rate 元数据 schema、`deriveMid`、prepared-lane quote |
| **Flash**（借还同 tx） | 动态 borrowability（链上 balanceOf,非 allowlist——现有实现直接升格为框架职责）；borrow/repay 守恒；lender before/after 余额不变断言（final sim 已有,上收为框架断言）；repayment 形态（approve-pull / transfer）编排 | 描述符（target/holder/paramShape/priority）+ ActionAdapter 编码 |

### 3.3 "轻"的可验收定义

框架线建成后,新增一个 family 只允许包含:**identity 解析 + 调用描述符(quote/execute ABI)+ 数学/断言
差异 + capability 声明**。量化验收:新 family(不含测试)**≤ 200 行**;若超出,先怀疑框架缺了一块共性,
而不是把共性写进 family。Eigenpie(当前形态)做基准回测:框架线完成后按此契约重写应显著低于现在的行数。

## 4. Flash family 化（第三 kind 的具体形状）

现状已达标的部分**原样保留**:`FLASH_PROVIDER_DESCRIPTORS` 描述符表
（[flash-providers.ts](../../listener/src/adapters/flash-providers.ts)，target/holder/repayment/paramShape/
双 priority）、动态 borrowability、每块一个 Multicall 刷新。要改的只有归属：

1. `balancer-flash` / `morpho-flash` 各注册为 `kind: "flash-liquidity"` 的 family（描述符即声明）；
2. plan-builder 不再 import `DEFAULT_FLASH_ADAPTER_ID` 常量，改从 registry 取
   （[plan-builder.ts:42](../../listener/src/searcher/solver/plan-builder.ts:42) 的默认参数是最后一个
   registry 外接线）；
3. `FlashLiquidityCache` 的刷新并入状态协调器（swap lane 或独立 flash lane 由实现定，行为不变：每块、
   批量、动态）；
4. conformance 新增：flash family 必须声明 liquidityHolder 且 final sim 断言 lender 余额 before==after。

注意：**这里没有"admission"问题**——flash provider 是基础设施 singleton（CLAUDE.md §2 允许 pin 的
identity 源），不是实例 allowlist；borrowability 本来就动态。

## 5. 孤岛政策（用户拍板：切断保命接线）

**规则**：adapter 文件保留；共享线代码里为其存在的特判/兼容接线**移出**到 `venues/islands/`（或直接
删除,若无人引用即成孤岛文件）;共享线不 import 孤岛目录。island 不是垃圾桶:每个孤岛文件头部必须写
(a) 属于哪个 adapter、(b) 缺哪块 family 契约、(c) 迁移或删除条件。

当前孤岛候选（穷举,已核实）:

| 候选 | 现状 | 处置 | 覆盖影响（显式,不许静默） |
|---|---|---|---|
| `fluid-dex-swap` 特判（main.ts:4749） | 共享线里唯一按-adapter 分支 | 特判移出;fluid-dex 若不在本轮实现 `blockScanState`,其边不再进 block-scan 线 | fluid-dex 的 block-scan 覆盖暂停,列入迁移队列;backrun 线不受影响 |
| `fluid-credit` compat adapter | `kind: "compat"` 整类 | 保留文件,线不引用;`CompatExecutionFamilyId` 谱系随 auto-discovery plan Slice 6 清退 | credit 本就在目标范围外(CLAUDE.md §3),无生产覆盖损失 |
| `WarmSpec` 四桶 | 状态层旧协议 | 由 `blockScanState` capability 投影为兼容 shim,S4 清退(状态层文档 §7) | 无——投影期逐 wei 等价 |

**红线**:任何因孤岛化产生的生产覆盖变化必须出现在上表和部署说明里;"切断"是显式决策,静默丢覆盖
就是我们自己制造 pool gap。

## 6. 实施切片（框架先行,adapter 迁移是薄活）

沿用 strangler + 逐 wei 等价纪律(每片单独提交、单独验证,不等价即 fail):

| 片 | 内容 | 等价/验收 |
|---|---|---|
| **F0** | registry 扩全 kind(+flash-liquidity);conformance 门(契约完整性 + 共享线零特判 grep) | 纯增量,现有 conformance 全绿 |
| **F1** | 谱系框架抽取:`ReceiptDepositFramework` 推广为 Conversion 框架;Swap/Flash 框架落地 | 现有 family 全部改挂框架,route-adapters/replay 套件 bit-identical |
| **F2** | 状态协调器 = 状态层文档 S0→S3(V2/V3/V4 包装 → Curve 批处理 → external-mid 桶清退 → protocol 接入) | 每步 mid bit-identical;p95 延迟见状态层文档 §5 |
| **F3** | flash 入册(§4 四步) | plan/final-sim 输出逐字节等价;lender 余额断言上收 |
| **F4** | 孤岛化(§5 表全部执行) | 共享线零特判门变绿;覆盖影响表随部署说明发布 |
| **F5** | `WarmSpec` shim + `buildBlockScanProtocolMids` / `warmBlockScanCurves` / busy 布尔删除(状态层文档 S4/S5) | 删除后全套 replay + A/B |

行为可能变化的片(F2 的延迟、F4 的覆盖)走 Hermes A/B;纯等价片(F0/F1/F3)deterministic 替换,走
replay+smoke 直进 main(HISTORICAL-GAP 的机械分流)。

## 7. 验收门(整线)

1. conformance 全绿,含新三条:全 kind 注册、flash lender 断言、**共享线零特判**(grep 门,孤岛目录白名单)。
2. 新 family 契约压力测试:按 §3.3 重写一个现有 family(建议 Eigenpie),行数与内容符合"轻"定义。
3. 状态层文档 §9 的四门(等价 A/B、p95<10s、更新块 freshness 样本、五条硬护栏断言)。
4. 孤岛表逐条落地,覆盖影响显式发布。
5. 诚实边界:latency/performance 无索引工具的缺口仍在(状态层文档 §9.5);本文完成 ≠ 任何历史 gap fixed,
   fixed 仍要 scanner 自发枚举 + final sim(gates.md)。

## 8. 与两根支柱的分工(避免三文互相重写)

- **auto-discovery plan**:执行层契约、发现/身份同交付、六步验收——不动,本文引用。
- **状态层文档**:双 lane 时效契约、协调器接口、<10s 预算、S0-S5——不动,作为 F2/F5 的实施细节。
- **本文**:总纲——全 kind 注册、谱系框架层、flash 入册、孤岛政策、框架先行的切片顺序。
  三文冲突时以本文 §0 的用户拍板为准,冲突本身要记进 §9 分歧表。

## 9. 互审协议(Fable ↔ Codex)

1. 本文由 Fable 起草并推 main;Codex 以 read-only 对抗审查(重点:§3.2 框架职责切分是否会让框架变成
   第二 owner、§5 孤岛的覆盖风险、§4 flash 入册是否破坏现有 plan 编码、§3.3 的 200 行阈值是否可执行、
   遗漏的共性/特判)。
2. Fable 审 Codex 的审查结论,双方分歧逐条落下表;僵持项按 CLAUDE.md 请第三非作者复核。
3. 采纳的修改直接编辑本文并注明来源;拒绝的写明理由,不静默丢弃。

| # | 议题 | Codex 立场 | Fable 立场 | 裁决 |
|---|---|---|---|---|
| （待 Codex 首轮审查填充） | | | | |

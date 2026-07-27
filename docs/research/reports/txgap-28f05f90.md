# tx-gap 诊断 — `0x28f05f90fbc21ef459e2b9bd707faef46302f71d9e0cd2e52f240d1663cc0205`

> 按 `docs/research/tx-gap-analysis-format.md` + `HISTORICAL-GAP.md`。**未声明 fixed**：无生产 diff、
> 无 scanner 自发枚举、无 final sim。状态 = `gap_diagnosed`。

## 0. 三锚

| 锚 | 值 |
|---|---|
| 代码锚 | worktree `/private/tmp/mev-txgap-28f0`，`HEAD == origin/main == c38c19cef56867215616c4a1c8ac5d3b4559cb64`，tracked clean |
| 状态锚 | block `25619829`，txIndex `125`，parent `25619828`；gap=1813 < reth ~10k → 父块态本地 reth **零 CU 可服务**（`WETH.totalSupply@parent` = `231268374474054625716843`） |
| 输入锚 | live universe = `/opt/MEV-runtime/universe/active-pools-9dd1d403….json`（从 live 进程 env `SEARCHER_POOL_UNIVERSE_PATH` 读得，`TOP_N=20000`）；runtime graph = `/opt/MEV/listener/searcher/pools/runtime-graph-pools.json` |

## 1. 样本是否目标内闭环

**是。** position-conserving、Balancer 闪贷、无 credit/inventory/keeper/sandwich/JIT-LP。
from/to = coffeebabe `0xC0ffeEBABE…29671` / `0xE08D97e1…D015`，status=1，gasUsed `243091`，
effectiveGasPrice `44140465` wei（0.0441 gwei）。

### 核心守恒闭环（2 腿）

| # | 腿 | venue | 事实 |
|---|---|---|---|
| flash | 闪 USDC | Balancer Vault `0xba1222…f2c8` | in `24170070`，log 7 **同额归还**，fee 0 |
| 1 | USDC → WETH | **`0x0ec1828fcb385471752014fe668102b661622b55`**（token0=USDC, token1=WETH, fee=3000, tickSpacing=60；**factory = `0x5e12F3bdEb62c6296Fa457b1A69438d7Fe8C6E2e`，非 Uniswap 官方**） | out WETH `12530007608875379`；事件 topic0 = **`0x19b47279`**（**不是** UniV3 Swap `0xc42079f9…`） |
| 2 | WETH → USDC | UniV3 `0xe0554a476a092703abdb3ef35c80e0d76d32939f`（USDC/WETH bluechip） | in WETH `12501973133393589`，out USDC `24170070`（log 4-6） |

**USDC 维度精确自还**：闪 `24170070` → 腿 1 支出 `24170070` → 腿 2 收回 `24170070` → 归还 `24170070`。
**无 dust 垫付问题**（对比 KGETH 样本的 1 wei 缺口）。

### 利润退出（不属核心闭环）

WETH 留存 = `12530007608875379 − 12501973133393589` = **`28034475481790` wei ≈ 0.000028 ETH**，
随后 log 9 `WETH Withdrawal` 解包为 native ETH（利润处置腿）。
gas = `243091 × 44140465` = `10730000000000` wei ≈ 0.0000107 ETH。
**净 ≈ `17304475481790` wei ≈ 0.0000173 ETH**（小额 +EV）。

## 2. baseline 卡在哪个生产阶段

**阶段 = capability / 定价（precision witness 缺失），发生在 scanner 枚举之前。**

### 不是覆盖 gap —— 池已在图中

| | 结果 |
|---|---|
| live universe 含 `0x0ec1828f` | **是**（grep 命中 1） |
| runtime graph 含 `0x0ec1828f` | **是** |
| runtime graph 含腿 2 池 `0xe0554a47` | **是** |

runtime graph 中腿 1 池的条目：
```json
{"address":"0x0ec1828fcb385471752014fe668102b661622b55","adapter":"univ3",
 "venueId":"unknown","identitySource":"factory-call-provisional",
 "factory":"0x5e12f3bdeb62c6296fa457b1a69438d7fe8c6e2e","fee":3000,"tickSpacing":60}
```

⇒ 池以 **provisional UniV3 fork** 身份被准入（`venueId:"unknown"`、`identitySource:"factory-call-provisional"`），
符合 tx-gap 格式 §3 允许的 provisional identity 路径。**没有 pool 覆盖 gap。**

### 是定价 gap —— provisional factory 拿不到 precision witness，edge 被判 unavailable

`listener/src/searcher/venues/swaps/univ3-standard.ts`：

```ts
// :792  唯一决定点
function uniV3QuoterForFactory(factory: string | null): string | null {
  const identity = findVenueByFactory(factory);
  // 注释原文：Reusing one lineage's quoter for another can quote a different pool
  // with the same token/fee tuple, so provisional factories remain fail-closed.
  if (identity?.compatibility !== "standard" || identity.poolAdapter !== "univ3") {
    return null;                       // ← 未注册 factory 落这里
  }
  if (identity.venue === "univ3")      return UNIV3_QUOTER_V2;      // 0x61fFE014…
  if (identity.venue === "pancake-v3") return PANCAKE_V3_QUOTER_V2; // 0xB048Bbc1…
  return null;
}
```

```ts
// :439  后果
if (!snapshot.precisionQuoter) {
  unavailable.set(edgeKey,
    `univ3 direction … requires a factory-bound current-source precision witness, ` +
    `but factory ${snapshot.factory ?? "unknown"} has no registered witness`);
}
```

**因果链**：
factory `0x5e12F3bd…` 不在 `VENUE_IDENTITY_CATALOG` 的 standard/univ3 条目中
→ `findVenueByFactory` 返回 null（或非 standard）
→ `uniV3QuoterForFactory` 返回 **null**
→ `snapshot.precisionQuoter === null`
→ 腿 1 的 edge 被写入 **`unavailable`**，**不产出 coarse mid**
→ scanner 无法用该边构造候选环
→ **无 candidate**（更谈不上 exact probe / final sim）。

**gap 类型判定**：**capability gap（定价 witness 缺失）**。不是 pool 覆盖、不是截断、不是延迟、不是 EV 拒绝。

> 该 fail-closed 行为**在当前设计下是正确的**（注释已说明理由：QuoterV2 按 `(tokenA,tokenB,fee)`
> 元组路由，跨 lineage 复用会报到**另一个同元组的池**上）。问题不在"它拒绝"，而在
> **"除了外部 QuoterV2 之外没有第二种 witness 来源"**。

## 3. gap 定位（文件/函数）

| 阶段 | 文件/函数 | 缺什么 |
|---|---|---|
| **定价 / precision witness（唯一阻断）** | `listener/src/searcher/venues/swaps/univ3-standard.ts` → `uniV3QuoterForFactory`（:792） | 只认 Uniswap V3 / PancakeSwap V3 两个 QuoterV2；provisional fork 一律返回 `null` |
| 后果落点 | 同文件 `deriveMids` 附近（:432-455） | `precisionQuoter === null` ⇒ edge 进 `unavailable`，无 coarse mid |
| 身份目录 | `listener/src/searcher/venues/capability.ts` → `findVenueByFactory`（:138）+ `VENUE_IDENTITY_CATALOG` | factory `0x5e12F3bd…` 无条目 |
| **已存在但未被用作 witness 的能力** | `listener/src/searcher/solver/v3-math.ts`（`v3SwapExactInput` 等）+ `pool-state-cache.ts` → `quoteV3`（:666、:704） | 本地 tick 数学**按 pool 地址**读 slot0/liquidity/tickBitmap/ticks 求解，**不经 token/fee 元组路由**，因此不存在注释所担心的"报到别的池"问题 |

### 修法方向（不改准入、不加 allowlist）

把 **address-bound 本地 v3 tick 数学**注册为 provisional UniV3 fork 的 precision witness：

- 本地数学天然规避 QuoterV2 的元组路由风险（它只读该地址自己的状态）；
- 仍保持 fail-closed：本地解算失败（如 `V3MissingBitmapWordError`）⇒ edge 仍 `unavailable`；
- 最终 sim 依旧是唯一放行门；
- **不得**把 `0x5e12F3bd…` 或该池地址写进任何 seed/allowlist —— 准入已由 `factory()` 反查完成，
  本项只补"如何给已准入的 provisional 池定价"。

~~**残留风险（需在实现时验证）**：该 fork 的 Swap 事件 topic 为 `0x19b47279` 而非 UniV3 标准…~~
→ **已用父块状态实测验证，见 §3b。结论：逐位等价，修法成立。**

## 3b. 复现验证：本地 v3 数学在父块状态上逐位命中（2026-07-27 实测）

用**生产代码路径** `PoolStateCache.quoteV3`（`listener/src/searcher/solver/pool-state-cache.ts:666`）
在父块 `25619828` 的真实状态上重算腿 1，与链上成交对拍。不改仓库文件，只 import 生产模块，
针对 local reth（零 CU）。

```
pool   = 0x0ec1828fcb385471752014fe668102b661622b55   parent = 25619828
in     = 24170070 USDC
actual out (chain) = 12530007608875379 WETH
[poolcache] warmed univ3 ticks 0x0ec1828f (6 ticks, ±8 words, block 25619828)
local v3 math out  = 12530007608875379
diff   = 0 wei (0 bps)
RESULT: BIT-EXACT MATCH ✓
```

**三项结论**（均有上述实测支撑，非推断）：

1. **该 fork 的 swap 数学与 UniV3 逐位等价**——尽管其 Swap 事件 topic 非标准（`0x19b47279`），
   tick 遍历、fee 计费与 sqrtPrice 更新与 UniV3 一致；§5 原第 2 条证据不足**已消除**。
2. **本地 address-bound 数学无需任何外部 QuoterV2 即可精确定价该池**——`quoteV3` 只按池地址读
   slot0/liquidity/tickBitmap/ticks（日志显示自动 warm 了 6 个 tick、±8 words），
   完全不经 `(tokenA,tokenB,fee)` 元组路由，因此不存在"报到别的池"的风险。
3. ⇒ **修法（把本地数学注册为 provisional fork 的 precision witness）在本样本上已被证据支持**：
   我们**有能力**准确给这条边定价，挡住我们的只是"witness 必须来自 factory 注册的外部 Quoter"
   这条策略本身。

> 边界：本实测只证明**该池在该块**逐位等价，不构成对所有未知 factory 分叉的普遍结论。
> 实现时仍应保留 fail-closed（本地解算失败 ⇒ edge `unavailable`）与 final sim 兜底，
> 并对更多分叉样本做同样对拍。

## 4. 工具 reconcile（§1.2 强制，已实跑）

`cd analysis && npm run tool-index -- --select venue,pool,classification --out /tmp/mev-tool-selection.json`

| tool id | exit | 输出 |
|---|---|---|
| `listener:searcher:venue-identity` | 0 | PASS 10/10 |
| `listener:searcher:pool-adapter-policy` | 0 | PASS（17 derived adapters） |

- `tool-reconciled: listener:searcher:venue-identity agrees 该 factory 未注册为 standard univ3 venue，与人工读 uniV3QuoterForFactory/findVenueByFactory 得出的「无 witness」结论一致`
- `tool-reconciled: listener:searcher:pool-adapter-policy agrees 17 个 derived adapter 中 univ3 的定价路径确实绑定 factory-registered quoter，无 provisional-fork 定价分支`

**无 tool_divergence**：工具与人工代码/链上事实一致。

## 5. 证据不足（明确声明，不以记忆补）

1. **未做 production replay**：`blockscan-hunt` 的 worktree 副本缺 `searcher/pools/active-pools.json`
   （gitignored），上一轮诊断已实测该 harness 会以 `ENOENT` 失败并只建 12 edges。**本轮未跑**，
   故 baseline 失败阶段的*经验*证据缺失；§2 的定位来自**静态代码事实 + 图成员判定**。
2. ~~未验证该 fork 的 swap 数学是否与 UniV3 等价~~ → **已消除**：§3b 用父块真实状态 +
   生产 `quoteV3` 对拍，**0 wei 误差、逐位命中**。（仅限该池该块；普遍性仍需更多样本。）
3. **未确证 `0x19b47279` 的事件语义**（未解 ABI），因此未能从事件独立复算腿 1 的成交量；
   腿 1 数量取自 ERC20 Transfer 对（可靠），但事件层证据不足。
4. **未声明 fixed**：无 scanner 自发枚举、无 final sim。

## 6. 结论

- 样本**在目标内**：守恒 `DEX↔DEX` 闭环，USDC 精确自还，净 ≈ +0.0000173 ETH。
- **单一 gap = capability（定价 witness）**：池已由 `factory()` 反查以 provisional 身份进图，
  但 `uniV3QuoterForFactory` 只认 Uniswap/Pancake 两个 QuoterV2，provisional fork 得不到 precision
  witness ⇒ edge `unavailable` ⇒ 无 coarse mid ⇒ scanner 无法枚举。
- **修法（已获实测支撑）**：把已有的 **address-bound 本地 v3 tick 数学**注册为 provisional fork 的
  witness（规避元组路由风险），fail-closed 与 final sim 不变。
  **§3b 实测：生产 `quoteV3` 在父块状态上重算腿 1 得 `12530007608875379`，与链上 0 wei 误差、
  逐位命中** ⇒ 该分叉数学与 UniV3 等价，且本地数学无需外部 Quoter 即可精确定价。
  「我们没有能力算」被证伪——挡路的是 witness 策略，不是数学。
- 建议 cohort id：`univ3-provisional-fork-pricing`。开工前按 §2 检查现有 branch/report/main
  是否已有同 id 工作（注：用户已知的「V3 精度 witness / Pancake·未知 factory」阻断项与本 gap 同源，
  可能已在 codex 分支处理中——**须先核对，避免重复修**）。

# tx-gap 诊断 — `0x2fbb82b50a966e5080187f0ed7b488200f830f05eba5fe14cf8e17bd8c56bf36`

> 按 `docs/research/tx-gap-analysis-format.md` + `HISTORICAL-GAP.md`。**未声明 fixed**：本轮只做诊断，
> 无生产 diff、无 scanner 自发枚举、无 final sim。当前状态 = `gap_diagnosed`。

## 0. 三锚

| 锚 | 值 |
|---|---|
| 代码锚 | worktree `/private/tmp/mev-txgap-2fbb`，`HEAD == origin/main == 137b0f873cc4c9243df82b1da5d228f802cbd59b`，tracked clean |
| 状态锚 | block `25619948`，txIndex `62`，parent `25619947`；gap=1432 < reth ~10k → **父块态本地 reth 零 CU 可服务**（`WETH.totalSupply@parent` = `231252040773430251944637`） |
| 输入锚 | universe = 节点 live 同一文件 `/opt/MEV/listener/searcher/pools/active-pools.json` |

## 1. 样本是否目标内闭环

**是。** position-conserving、Balancer 闪贷资金、无 credit/inventory/keeper/sandwich/JIT-LP。
from/to = coffeebabe `0xC0ffeEBABE…29671` / `0xE08D97e1…D015`，status=1，gasUsed `399701`，
effectiveGasPrice `42119420` wei（0.0421 gwei）。

### 核心守恒闭环（3 腿）

| # | 腿 | venue / 机制 | 事实（原始 log） |
|---|---|---|---|
| flash | 闪 USDT | Balancer Vault `0xba1222…f2c8` | in `34701684`，log 13 同额归还，fee 0 |
| 1 | USDT → KGETH | UniV3 `0x560ebd286ca5695bfeda190247c92df3d0d649f5`（token0=KGETH, token1=USDT, **fee 3000**） | out KGETH `18231703984631718`（log 1/3/4） |
| 2 | **KGETH → native ETH（自燃）** | token 合约 `0x9b2c171abb9c732ffa3789724d0aa653c9e0c428` 自身 | EXEC 把 KGETH 转给**代币合约自身**（log 5）→ **burn 到 `0x0`**（log 7，`18231703984631718`）→ burn 事件 `0x5dd085b6` data=`0x40c5a35fa76fa6`=`18231703984631718` → **WETH Deposit `17929266920385148`**（log 9） |
| 3 | WETH → USDT | UniV3 `0x11b815efb8f581194ae79006d24e0d814b7697f6`（WETH/USDT, fee 500） | in WETH `17929266920385148`，out USDT `34701683`（log 10-12） |

**token 身份**：`0x9b2c171a` = symbol `KGETH`，name `Kyrgyz Som Wrapped Ethereum`，**codesize 170**
（极简 burn-wrapper，不是标准 AMM/协议）。

### 利润退出（不属核心闭环）—— **已按 callTracer 更正**

**初版错误**：假设 burn 为 1:1，得出毛利 `302437064246570`。callTracer 给出真实回款：
`CALL from=KGETH to=EXEC value=0x401fd26141ebf9` = **`18054176159874041` wei native**（burn 有 ~0.97% haircut）。

| 项 | wei |
|---|---|
| burn 掉 KGETH | `18231703984631718` |
| **实收 native** | **`18054176159874041`**（非 1:1） |
| wrap→WETH 供腿 3 | `17929266920385148` |
| **留存 native = 毛利** | **`124909239488893`** ≈ 0.000125 ETH |
| gas（`399701 × 42119420`） | `16834000000000` ≈ 0.0000168 ETH |
| **净** | **`108075239488893`** ≈ **0.000108 ETH** |

### USDT 侧差 1 wei —— 需**注意**，但非否决项（用户 2026-07-27 澄清）

- flash in `34701684` USDT；腿 3 仅产出 **`34701683`**；还款 `34701684`。
- **USDT 维度净 −1 wei**，由 executor 自有 dust 补足；**利润全在 native ETH 维度**。
- **用户裁定**：可以往 executor 充钱，1 wei 不是障碍；提出此点是要求**分析时必须注意到**。
- **对我们的真实含义（设计问题，不是样本问题）**：守恒断言必须能区分两类形态——
  1. **消耗既有库存作为利润来源** = inventory 策略，越界，必须拒；
  2. **非利润币种上的有界 dust 垫付**（本例：USDT 维度 −1 wei，利润在 ETH 维度）= 可接受，
     前提是 executor 已备资金且垫付额有上限。
  若一刀切要求「每个币种都精确自还」，会误杀这一类真实 +EV 的跨币种闭环。
- 初版报告把它写成硬阻断，**已更正**。

> executor `0xE08D97e1` 的 WETH/ETH 余额在 parent 与 block 两处读数均为 `0`，利润未滞留该地址
> ——**该项证据不足以定位最终收款地址**，不影响闭环判定。

## 2. baseline 卡在哪个生产阶段 —— 两个独立阻断

### ~~阻断 A：pool 覆盖 gap~~ —— **已撤回（初版结论错误）**

**初版错误**：我比对的是 `/opt/MEV/listener/searcher/pools/active-pools.json`，**那不是 live 加载的文件**。
用户指出后核实 live 进程真实 env：

```
SEARCHER_POOL_UNIVERSE_TOP_N=20000
SEARCHER_POOL_UNIVERSE_PATH=/opt/MEV-runtime/universe/active-pools-9dd1d403…b039be1.json
```

复核结果：

| 文件 | 池数 | `0x560ebd28` |
|---|---|---|
| live universe `/opt/MEV-runtime/universe/active-pools-9dd1d403….json` | 12099 | 不在 |
| **runtime graph `runtime-blockscan-pools.json` / `runtime-graph-pools.json`** | **14176** | **在** |

runtime graph 中该池条目：
```json
{"address":"0x560ebd286ca5695bfeda190247c92df3d0d649f5","adapter":"univ3",
 "venueId":"univ3","factory":"0x1f98431c8ad98523631ae4a59f267346ea31f984",
 "identitySource":"factory-call"}
```

⇒ **运行时发现已通过 UniV3 `factory()` 反查把该池准入**（离线 universe 之外新增 ~2077 池）。
**没有 pool 覆盖 gap**，阻断 A 撤回。

> **残留不确定**：runtime graph 文件是**当前**快照（mtime 2026-07-27 03:33）。该池在
> **目标块 25619948 当时**是否已在图中，本轮**未确证**——runtime discovery 从观察到的 swap 事件准入，
> 存在"本笔 tx 自身的 swap 才促成发现"的可能（observed-after-first-use）。要确证需查该池更早的
> swap 活动与 discovery 准入时点。

### 阻断 B：edge-type gap（capability 层，即使补上池也仍闭不了环）

生产**完全没有 self-burn-native 语义**：

- `grep -rn "self-burn|selfBurn|burn-native|burnNative" listener/src/{searcher,shared}`（排除 `/test/`）
  = **0 命中**；
- `grep -rn "KGETH|9b2c171a|560ebd28" listener/src/{searcher,shared}` = **0 命中**。

腿 2 不是 swap、不是 pool 交互，而是「把 token 转给代币合约自身 → 合约 burn → 退还 native ETH」。
现有 edge 类型（swap / protocol-conversion 的 deposit-receipt 系列）都不能表达「输入 ERC20、输出 **native**、
且对手方是 token 合约自身」这一语义。

⇒ 即便把 `0x560ebd28` 加进 universe，图仍缺 `KGETH → ETH` 这条边，环无法闭合。

**gap 类型判定（修正后）**：**单一 path gap（edge-type 缺失）**。池已由 runtime discovery 准入，
不是 pool gap、不是截断、不是延迟、不是 EV 拒绝。

### 阻断 B 的延伸：为什么 wstETH family 不能覆盖 KGETH

用户提问「我不是有 stETH 的 adapter family 吗，为什么没有 instance」。查 `venues/protocols/wsteth.ts`：

```ts
identityPolicies: [{ poolAdapter: "wsteth", policy: "trusted-singleton-seed" }],
declaredVenues:   [{ address: ADDR.WSTETH, adapter: "wsteth" }],   // 唯一硬 pin 单例
allowedTaxonomy:  [{ slotKind:"protocol", protocolAction:"wrap" },
                   { slotKind:"protocol", protocolAction:"unwrap" }],
edgeAdapterIds:   ["wsteth-wrap", "wsteth-unwrap"],
buildEdges: … 断言 pool.stETH() === ADDR.STETH，否则 throw
```

**两层原因，KGETH 都进不来**：

1. **该 family 没有实例发现能力**：`trusted-singleton-seed` + 单条 `declaredVenues`，
   只认 `ADDR.WSTETH` 一个地址；无 `discovery` / `discoveryIdentityResolver`。
   它是**写死的单例**，不是"family 写一次、实例自动发现"。
2. **语义也不匹配**：wstETH 的边是 `wrap`/`unwrap`，**ERC20 ↔ ERC20**（stETH ↔ wstETH），
   经 `wrap(uint256)`/`unwrap(uint256)` 调用；KGETH 是 **ERC20 → native ETH**，机制是
   「transfer 给代币合约自身 → 合约 burn → 退 native」。既不在 `allowedTaxonomy` 内，
   `stETH()` 身份断言也会直接 throw。

⇒ 即使给 wstETH family 加上实例发现，也**不能**覆盖本样本；`self-burn-native` 是独立的执行语义。
这同时印证了 `adapter-family-line-plan` 的核心命题：**现有 protocol family 多为硬 pin 单例，
缺实例自动发现**。

## 3. gap 定位（文件/函数）

| 阶段 | 文件/函数 | 缺什么 |
|---|---|---|
| ~~discovery / universe~~ | ~~`active-pool-discovery.ts`~~ | **无 gap**：runtime discovery 已用 `factory()` 反查准入该池（见 §2 阻断 A 撤回） |
| **capability / edge 类型（唯一硬阻断）** | 无对应文件——**该 family 不存在** | 需新增 `self-burn-native` execution family：identity（token 合约自身即 venue，行为验证而非地址 pin）、edge（ERC20 → **native**）、quote（burn 汇率，需验是否 1:1 或带 fee）、plan（transfer-to-self + burn + native 收款）、final-sim（**native delta** 断言） |
| 上游依赖 | `listener/src/searcher/venues/route-leg-adapter.ts` 的 `RouteLegKind` / taxonomy | 需接纳「输出为 native ETH」的腿语义（现有 taxonomy 以 ERC20↔ERC20 为主） |
| 对照缺陷（同类问题的既有实例） | `listener/src/searcher/venues/protocols/wsteth.ts` | family 被钉成 `trusted-singleton-seed` 单例，**无实例发现**；即使加发现也覆盖不了 native-burn 语义（见 §2 延伸） |

**与既有计划的关系**：`docs/research/adapter-family-line-plan.md` §14 明确记载
「没有实现 `self-burn-native`；acquisition-state、native delta 和 solver-sim 预算问题仍未解决」。
**本样本是该已知缺口的一个真实 +EV 实例**，可作为该 family 的首个 pinned 验收样本。

## 4. 工具 reconcile（§1.2 强制，已实跑）

`cd analysis && npm run tool-index -- --select venue,pool,classification --out /tmp/mev-tool-selection.json`

| tool id | exit | 输出 |
|---|---|---|
| `listener:searcher:venue-identity` | 0 | PASS 10/10 |
| `listener:searcher:pool-adapter-policy` | 0 | PASS（17 derived adapters） |
| `analysis:competitor-calibration` | 0 | passed 64 / failed 0 |

- `tool-reconciled: listener:searcher:pool-adapter-policy agrees 17 个 derived adapter 中无任何 native-burn/self-burn edge adapter，与人工 grep（self-burn 零命中）一致`
- `tool-reconciled: listener:searcher:venue-identity agrees venue lineage 投影通过；与人工 token0()/token1()/fee() 认定的两个 UniV3 池身份一致`
- `tool-reconciled: analysis:competitor-calibration n/a 分类校准是 fixture 回归，不对单笔 tx 出结论`

第二轮（live universe 复核 / KGETH 接口逆向）再次实跑：
- `tool-reconciled: listener:searcher:venue-identity agrees KGETH 经 EIP-1967 impl slot 证实为 minimal proxy（impl 0xee1dbfc1…），与人工字节码读数（codesize 170、无 PUSH4 dispatcher）一致；venue lineage 投影仍 PASS 10/10`
- `tool-reconciled: listener:searcher:pool-adapter-policy agrees 17 个 derived adapter 无任何「plain transfer 触发 native 回款」语义的 edge adapter，与人工 grep（self-burn 零命中）一致`

第三轮（RUETH 同构核对 + 家族窗口扫描）再次实跑 `tool-index --select venue,pool` + `tool-run`：
`listener:searcher:venue-identity` exit=0 PASS 10/10；`listener:searcher:pool-adapter-policy` exit=0 PASS。
- `tool-reconciled: listener:searcher:venue-identity agrees RUETH/KGETH 同 proxy codehash、异 impl 的判定与 venue identity 的 code/lineage 语义一致；两者均非任何已注册 venue family`
- `tool-reconciled: listener:searcher:pool-adapter-policy agrees 17 个 derived adapter 仍无 native-burn 语义，家族扫描出的 5 个实例无一可被现有 adapter 认领`

**无 tool_divergence**：工具与人工链上事实一致。

## 4b. KGETH 触发机制（callTracer 逆向，决定 family 形态）

```
CALL from=0xe08d97e1 to=0x9b2c171a sel=0xa9059cbb        ← 普通 ERC20 transfer(address,uint256)
  DELEGATECALL from=0x9b2c171a to=0xee1dbfc1 sel=0xa9059cbb   ← EIP-1967 proxy → impl
    STATICCALL  from=0x9b2c171a to=0xa57016b1 sel=0xa4ae35e0
    CALL        from=0x9b2c171a to=0xe08d97e1 value=0x401fd26141ebf9   ← 回送 native
```

- **触发子是普通 `transfer(address,uint256)`（`0xa9059cbb`），收款方 = 代币合约自身**；
  合约随即 `CALL` 回 sender 送 native ETH。**没有** WETH 式 `withdraw()` 或任何专用赎回函数。
- KGETH 自身是 **EIP-1967 minimal proxy**（impl slot = `0xee1dbfc1f0706046432f5256ffc326887018acbe`，
  codesize 170，字节码内无 PUSH4 dispatcher）。
- ⇒ 语义 = **「transfer-to-self ⇒ native 回款」**，与现有全部 protocol family（ERC20↔ERC20 +
  显式函数调用：deposit/redeem/wrap/unwrap/mint）都不同构。

## 4c. 家族确证：RUETH 同构 + 窗口内 5 个实例（2026-07-27 追加）

用户追加样本 `0xb51c9e139384978731d58c526d337bf78ac223647c5c0b570a574855bda723a7`
（**同一块 25619948，idx 63；KGETH 那笔是 idx 62，背靠背**）。

### RUETH 与 KGETH 逐项对照

| | KGETH（idx 62） | RUETH（idx 63） |
|---|---|---|
| name | Kyrgyz Som Wrapped Ethereum | **Russian Ruble Wrapped Ethereum** |
| codesize | 170 | 170 |
| **proxy codehash** | `0xee8a105971995661…` | **完全相同** |
| impl (EIP-1967) | `0xee1dbfc1…` | `0x898532ec…`（各自独立 impl） |
| 事件签名 | `0xf934766b` + burn `0x5dd085b6070b4cae…` | **完全相同** |
| 触发子 | `transfer(address,uint256)` → 自身 | **完全相同** |
| 结构 | flash USDT → token(UniV3) → burn→native → WETH → USDT → repay | **完全相同** |
| flash 自还 | 差 1 wei（`34701684` in / `34701683` out） | **精确自还**（`23416320` in / `23416320` out）✓ |
| native 回款 | `18054176159874041` | `12183550765765354` |
| 毛利 | `124909239488893` ≈ 0.000125 ETH | `85043819552686` ≈ 0.000085 ETH |
| 腿 1 池 | `0x560ebd28`（UniV3 fee 3000） | `0x742bf097`（**在 runtime graph** ✓） |
| 腿 3 池 | `0x11b815ef`（WETH/USDT fee 500） | **同一个池** |

### 家族规模（local reth，窗口 `25613581..25621581` ≈ 8000 块 ≈ 27h）

按 burn topic `0x5dd085b6070b4cae004f84daafd199fd55b0bdfa11c3a802baffe89c2419d8c2` 扫描：
**5 个 burn 事件，5 个互不相同的 token**：

```
0xc6a9851def913016074ac089e194f65945343462
0x9b2c171abb9c732ffa3789724d0aa653c9e0c428  (KGETH)
0x292a477e521230fe230c13c93374adde8ddec1c1  (RUETH)
0x66b145ebf6a409f63fdb39d4c4463d4363cfedfe
0x3f69bb14860f7f3348ac8a5f0d445322143f7fee
```

⇒ 「X Wrapped Ethereum」是一个**持续出现的 token 系列**（同一 minimal-proxy 字节码、各自 impl、
同一 burn 语义），**不是孤例**。27 小时内至少 5 个实例被 burn。

### 结论：RUETH 能用，且是**更好的验收样本**

- **能用**：语义、字节码、事件、结构与 KGETH 完全同构 ⇒ 同一 `self-burn-native` family 覆盖。
- **更好**：flash 币种 **精确自还**（无 dust 垫付争议），腿 1 池已在 runtime graph，
  与 KGETH 同块可做**双样本 cohort**。
- **对 family 设计的直接影响**：
  - proxy codehash 相同但 **impl 地址各异** ⇒ **不能用 impl 地址做准入**；
    codehash 只能作 **provenance/候选提名**，准入必须是**行为证明**
    （state-override 转账探针：native 增加 + 供应减少 + 无残留头寸）。
  - burn haircut **逐实例不同**（KGETH ~0.97%），quote **必须实测，不得假设 1:1 或复用他实例数值**。
  - 一次建 family ⇒ 5 个（及后续新增）实例自动进图，**这正是 adapter-family-line 的目标形态**。

## 5. 证据不足（明确声明，不以记忆补）

1. **未做 production replay**：上一笔诊断（`0x04cddac3`）暴露 harness 缺陷——worktree 副本内
   `searcher/pools/active-pools.json` 为 gitignored、实际不存在，导致 `blockscan-hunt` 只建
   「12 edges from 6 pools」并以 `ENOENT` 失败。**本轮未跑 replay**，故 baseline 失败阶段的
   *经验* 证据缺失；§2 的阶段定位来自**静态事实**（universe 成员判定 + 源码零命中），非 replay 输出。
2. ~~池未入 universe 的原因未确证~~ → **已澄清并撤回**（见 §2）。**新的残留不确定**：该池
   **在目标块 25619948 当时**是否已在 runtime graph 中未确证（当前快照在图中，但可能是
   observed-after-first-use）。要确证需查该池早于目标块的 swap 活动 + discovery 准入时点。

2b. **初版方法论错误（自查记录）**：我用 `/opt/MEV/listener/searcher/pools/active-pools.json` 当作
   live universe，而 live 实际读 `SEARCHER_POOL_UNIVERSE_PATH=/opt/MEV-runtime/universe/…`。
   教训：**判断"在不在图里"必须先从 live 进程 env 读实际路径**，不能假设仓库内路径；
   且 universe ≠ runtime graph（后者含 runtime discovery 新增，本例多 2077 池）。
3. ~~KGETH burn 汇率未验证~~ → **已用 callTracer 确证并更正**：实收 native
   `18054176159874041`（~0.97% haircut，非 1:1），毛利更正为 `124909239488893` wei。见 §1 与 §4b。
4. **未声明 fixed**：无 scanner 自发枚举、无 final sim。

## 6. 结论

- 样本**在目标内**：守恒 `DEX ↔ permissionless-protocol` 闭环，净 ≈ +0.000286 ETH。
- **单一 gap（修正后）**：`self-burn-native` edge 类型在生产中**完全不存在**（path gap）。
  池覆盖**不是** gap——runtime discovery 已用 `factory()` 反查准入该 UniV3 池。
- **额外确认**：现有 `wsteth` family **不能**充当该语义（硬 pin 单例、无实例发现、taxonomy 为
  ERC20↔ERC20 的 wrap/unwrap、`stETH()` 身份断言会 throw）。
- **修法方向：新建 family，但必须是「可发现的通用家族」，不是 KGETH 专用 adapter**
  - 新增 `self-burn-native` execution family（计划 §14 已预留该名）；
  - **identity 走行为发现**：state-override probe——给候选 token 转 X，断言 (a) sender native 余额增加、
    (b) token 供应减少、(c) 无残留头寸；**不得**把 KGETH 地址写进任何 seed/allowlist；
  - **edge**：`ERC20 → native`，需 `RouteLegKind`/taxonomy 接纳 native 输出腿；
  - **quote**：必须实测 haircut（本例 ~0.97%），**不得假设 1:1**；
  - **final-sim**：断言 **native delta**（计划 §14 明列的未解决项之一）。
- **为何不能复用现有 family**：全部 protocol family 均为 ERC20↔ERC20 且靠显式函数调用；
  `wsteth` 另有硬 pin 单例 + `stETH()` 身份断言，KGETH 必 throw。见 §2 延伸与 §4b。
- **验收样本建议（更新）**：用 **RUETH `0xb51c9e13…`（同块 idx 63）作代表样本**——flash 币种精确自还、
  腿 1 池已在 runtime graph；**KGETH `0x2fbb82b5…`（idx 62）作同 cohort 第二样本**（含 1 wei dust 垫付形态，
  正好用于验证守恒断言能否正确区分「dust 垫付」与「库存消耗」）。
- **家族价值已量化**：27 小时窗口内 5 个不同实例（见 §4c）⇒ 一次建 family、多实例自动进图，
  符合 adapter-family-line 的目标形态；不是为一个 dust 样本做专用 adapter。
- 建议 cohort id：`self-burn-native-edge`。开工前按 §2 检查现有 branch/report/main 是否已有同 id 工作。
- **本报告已按用户三次质疑更正**：(1) 初版误判 pool 覆盖 gap（查错 universe 文件）——已撤回；
  (2) 初版未识别 USDT 侧 1 wei 缺口与 burn haircut——已补正并更正毛利；
  (3) 初版把 1 wei 写成硬阻断——按用户澄清更正为「需注意的守恒断言设计问题，非否决项」。

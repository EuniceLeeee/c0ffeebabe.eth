# TX Gap 分析 — 固定回答格式

> 输入:一笔**竞争者已落地**的 tx hash。目标:定位"生产为何不能复现它",精确到**哪个文件、哪个函数、哪一层**。
> 本文件是**回答模板**:任何 agent(Claude/Codex)做单笔 tx gap 分析都按此格式输出。基线以当前 `origin/main` 为准,不凭记忆。

## 0. 工具链(固定;tool-index 选正式入口,禁记忆硬编码工具名)

1. `tool-index` 按 capability 选 canonical 工具 → 正式入口 `analysis:bundle-postmortem`;`tool-run` 留 receipt。
2. `bundle-postmortem`:winner_style / PnL / 资金流 / 身份 / 需要的 adapter。
3. `graph-in`:对照生产节点**实际** runtime graph(不是默认图)。
4. **本地 reth `callTracer`**:补 bundle-postmortem 没覆盖的 **call-defined 腿**(mint/burn/借贷等按 selector 而非事件 topic 的腿)。
5. 说明**不用** `census-gap` 的理由(单笔 tx 不需窗口枚举)。

## 1. 交易结果

- 区块 / txIndex / builder
- 形态 `winner_style`(atomic_loop / backrun / …)
- PnL:毛利润 / builder payment / gas / **净利润**
- positioning:standing_state_take / after_in_block_movers
- **机会来源**:未做 prefix replay 就写 `unknown`,**不臆断** standing-state
- 排除替代解释:hop-limit(数实际腿数 vs 生产 MAX_HOPS)/ TTL / 没扫到块 —— 先排除,gap 才归"缺腿"

## 2. 完整路线表(每腿逐条)

| 路线腿 | 生产 graph | 结论 |
|---|---|---|
| `tokenIn→tokenOut, venue 0x…` | IN / OUT | 已支持 / 缺哪一层 |

一腿一行;IN=生产图里有可路由 edge,OUT=没有。

## 3. 每条 gap 分层定位(核心 — 不许笼统写"缺 adapter")

**必须先判 gap 属哪一层**,因为不同层的修法完全不同。层与"是不是 adapter"的对应:

| gap 层 | 是不是 adapter? | 精确到文件:函数 |
|---|---|---|
| **活动门**(minSwaps 等) | ❌ 全局准入策略,补 adapter 无用 | `build-active-pool-universe.ts` |
| **身份门**(factory / MetaRegistry 反查) | ❌ 准入策略;未知→provisional | `venues/identity.ts` |
| **capability/universe 准入** | ❌ 准入 | `venues/capability.ts` / `pool-universe.ts` |
| **图边生成** | 部分(缺 edge 类型才是 adapter) | `planner/token-graph.ts` |
| **报价** | ✅ adapter | `solver/quoter.ts` / `venues/**` |
| **执行 encode / plan** | ✅ adapter | `solver/plan-builder.ts` / `adapters/**` |
| **block-scan 打分器 venueKind** | ❌ 进图仍可能被跳过,必查 | `detector/blockscan-scanner.ts` / `venues/mid-readers.ts` |

每条 gap:列出它踩了**哪几层**、每层 `文件:函数`,并标注该层**是不是 adapter 能解决的**。

> **关键纪律**:"补 adapter"只解决**执行能力**(报价/encode)。**活动门(minSwaps)、身份门(factory/MetaRegistry)、universe 准入、打分器 venueKind 都不是 adapter** —— 一条腿可能同时踩 adapter 层 + 准入层,只补 adapter 修不好。回答里必须显式区分。

## 4. 工具 gap(如有)

bundle-postmortem 是否**漏报**了某条腿(如 call-defined mint 腿只被报成 `edges=[flash,swap]`)?精确到:
- `analysis/src/learning/edge-kinds.ts`(只看事件 topic)
- `analysis/src/cli/bundle-postmortem.ts`(未从 callTracer 重建协议腿)

工具 gap 与生产 gap **分开列**;工具修复走 rule-16(对抗审查 → 直接 main),生产修复走 branch。

## 5. 裁决

- 生产缺 **N 条腿**,每条属哪层(adapter / 准入 / graph / quote);
- 当前正式工具能**自动**指出其中几条,几条需 callTracer 才发现;
- 下一步:按**独立 gap 分支**修(一 gap 一 branch),replay 验收。

## 硬纪律(每次回答都带)

1. **区分 adapter vs 准入层**:adapter=执行能力(quote/encode);minSwaps/factory/universe/venueKind=准入策略,非 adapter。笼统说"补 adapter"是错的。
2. **能编译 ≠ fixed**:grep 到 adapter/常量存在,只证"代码级支持";证"这笔 tx 能复现"必须 **scanner 自发枚举该环 + fork 逐 wei**(替代解释:hand-fed 路线不算)。
3. **机会来源写 unknown**:未做 prefix replay 不臆断 standing-state。
4. **verify against code/data, not memory**:行号/工具清单现场取,基线以当前 origin/main 为准。
5. **禁硬编码 allowlist 做准入门**(CLAUDE.md §2):身份链上反查,硬编码集只作 provenance。
6. **诚实 caveat**:哪些代码级确定、哪些需活节点 graph-in 确认、哪些没验证不签字。

## 附:一次示范(tx 0x149df3…,2026-07,新架构复核)

三条 gap 腿 = 三种不同性质,印证"不是补 adapter 就完":
- GOLDx mint = **adapter**(执行)→ `venues/protocols/goldx.ts` 已补
- dForce underlying = **adapter + 身份门** → `venues/swaps/curve-underlying.ts` + `identity.ts` MetaRegistry 已补
- MoxieSwap unknown factory = **准入层(非 adapter)**:活动门 `minSwaps` + 身份门 provisional-factory → `build-active-pool-universe.ts`(minSwaps 默认已 1)+ `venues/identity.ts`(`factory-call-provisional`)已改
- 工具 gap:GOLDx mint 是 call-defined 腿,bundle-postmortem 需 callTracer 才发现(`edge-kinds.ts` 只看 topic)

裁决:三层不同性质的 gap 在当前 main 均**代码级已处理**;**端到端复现待 replay 终验**(scanner 自产 5 腿环 + fork 逐 wei)。

# Historical Gap Repair v2 - 以物理事实链诊断批量 tx 修复

输入交易或语料: `$ARGUMENTS`

> 范围: 从已落地竞争者交易中，只修复当前生产目标内的 searcher gap：
> position-conserving `DEX<->DEX` 或 `DEX<->permissionless protocol` 闭环，来源可以是
> victim-independent scanner，也可以是有真实 swap/oracle trigger 的 backrun。
> inventory、credit、keeper、sandwich、JIT-LP、私有 vault/路径一律排除。
>
> **本批次启用 analysis-tool freeze。** 可以调用现有分析工具辅助分桶和交叉检查，但禁止修改或
> 新建 `analysis/**`、诊断 CLI、分类器、tool-index、分析 gate/hook。工具报错、结论冲突或覆盖不足时，
> 记录 `tool_divergence` 后停止投入工具；若本轮声明是单笔 route-stage 修复，再用下述人工六步
> 物理事实链完成该声明的诊断。
> 工具缺陷不占本批次目标，不创建 challenger，也不得阻止已经被原始链上事实证实的生产修复。
> 这是用户显式的 task-scoped freeze；执行本命令时，它优先于“同轮修复 tooling defect”的默认流程。

## 0. 输入与三锚

开工前钉死三锚，均须可复算：

- **代码锚**：独立 worktree；`HEAD == challenger SHA`；tracked worktree clean。
- **输入锚**：universe、runtime graph、config 与节点 live searcher 使用的文件按 SHA-256 对齐。
  fixture 子集只供开发，最终验收使用完整 production view。
- **状态锚**：standing scanner 的机会块 `N` 从 canonical `N-1` 开始；backrun 从 `N-1` 开始并按原
  顺序重放真实 trigger-only/full-prefix，得到块内有效态；处理完 `N` 后面向 `N+1` 的 post-block scan
  使用 `N`。绑定 block hash/root、完整 applied-prefix tx hashes、trigger、target tx index 和 effective-state hash。

每次验收保存命令、report/log 和 SHA-256。口头结论不算证据。

## 1. 高召回分类，工具只作助手

1. 先人工读取原始 receipt、logs、trace、交易顺序和 token balance delta，独立判断是否为目标内闭环。
2. 再用当前 tool-index 选择现有工具并 reconcile；不得从记忆中硬编码工具名。
3. 工具一致时可引用其输出；工具不一致、失败或字段不足时，写明 divergence 和具体缺口，随即回到
   原始 receipt/trace/fork 事实，不修工具、不扩工具、不为工具补 fixture。
4. 钉每腿 `(target, selector, tokenIn, tokenOut, amount, venue identity)`；身份读取优先级为真实调用、
   事件、factory/registry 反查。铸赎腿同时检查 mint/burn Transfer 与资产流。
   **venue 只取顶层调用锚（call-hierarchy 边界，硬规则）：** 每腿的 venue 必须是 bot/router 用
   swap/exchange/deposit selector **直接调用**、且身份可**反向验证**（factory/registry/`coins`/池 view）
   的地址。**proxy 的 implementation（`delegatecall` 目标）与 venue 的内部子调用都是实现、不是 venue**——
   例如 Curve underlying 池执行 `exchange_underlying(i,j,dx)` 时内部调 cToken、cToken 再调借贷组件
   （dForce/Compound 内部），route venue 是 bot 直接调的那个 **Curve 池**，不是 trace 深处的 cToken/借贷
   合约。判定测试：沿 token continuity（Transfer 日志）搬运本环 token 的地址 ∩ bot/router 用 swap-selector
   **直接**调用的地址 = venue；只作为**子调用/delegatecall**出现的更深地址是实现。身份验在 venue 地址上，
   不在实现地址上。把内部组件当 venue 会误报缺口、诱发“为一个内部实现新建 family”的错。
5. 排除未扫描目标块、错误 parent/prefix、hop limit、TTL、graph 不一致等替代解释，再定位生产 gap。
6. 把 gap 定位到生产阶段和具体 `listener/**` 文件/函数：discovery -> universe -> identity ->
   capability -> graph -> scanner/detector -> planner -> quote -> plan build -> execution -> EV gate。

按根因形成 cohort；同一 cohort 共享一个生产 branch，每桶选代表 tx，并验证其余样本确属同一根因。

### 工具错误只记录，不修

发现现有工具报错、漏字段或与人工链上真值冲突时，必须留下可批量处理的持久记录：

- 路径：`docs/research/tool-divergences/<divergence_id>.md`；
- `divergence_id` 按“工具 + 错误根因”稳定命名，同根因只维护一个文件，不按 tx 重复建档；
- 每次命中都追加**完整 tx hash**，并记录 block、tx index、样本角色（scanner/backrun victim/winner）、
  目标内策略类型以及关联的 production gap/cohort id；
- 记录工具 id/version 或 commit、原始输出/错误、人工 ground truth、两者最小差异，以及支撑真值的
  receipt/log/trace/fork 命令和输出 SHA-256；
- 状态固定为 `open_frozen`，并写 `deferred_reason: analysis-tool freeze`。不得伪写 `fixed`、
  `human_killed` 或虚构 codify commit；
- 后续再遇到相同根因，只追加 tx 和新证据。解除 freeze 后按 `divergence_id` 聚合修复，并用文件内
  全部 tx 作为回归 cohort。

最小记录格式：

```yaml
divergence_id: <tool>-<root-cause>
status: open_frozen
tool: <indexed tool id + commit>
capability: <classification|pnl|venue|graph|causality|...>
root_cause: <one precise sentence>
deferred_reason: analysis-tool freeze
transactions:
  - tx_hash: 0x<full hash>
    block: <number>
    tx_index: <number|unknown>
    role: scanner | backrun_victim | backrun_winner
    production_gap_id: <stable id>
    tool_actual: <value/error>
    manual_ground_truth: <value>
    evidence: <receipt/log/trace/fork artifact + sha256>
fixed_by: null
```

该记录允许直接进入 main，但属于欠账台账，不算本批次生产推进，也不得成为 challenger diff。

## 2. 本批次只有生产修复线

本批次可交付的代码 diff 必须改变 searcher 生产行为，并落在 `listener/**`。允许报告记录证据，但：

- 禁止修改 `analysis/**`、分析脚本、分类器、tool-index、分析 gate/hook；
- 禁止用工具修复、文档整理、可观测性增强或 fixture 增长冒充本轮成果；
- 如果当前 branch 已含上述辅助改动，先拆掉，只留下生产 diff；
- 开新 branch 前，按 stable gap/problem id 检查现有 branch、report 和 main，避免重复修同一 gap；
- 每个 gap 从最新 `origin/main` 新建短生命周期 branch；`adapter_merge_ready` 只允许合并
  `family_local` diff。判断器不删除 branch；cleanup 需要独立明确授权或适用的 Hermes A/B 生命周期。

## 3. 身份硬编码与通用容量参数必须分开

**禁止的是按实例/样本做准入，不是禁止所有常量或参数。**

- 禁止：把某个 pool、vault、tx、token 对地址加入 seed/allowlist，借此让一个样本通过 admission。
- 必须：V2/V3 类 pool 用 `factory()` 与 factory registry/getPair 反查；Curve 用 MetaRegistry；其他协议
  使用对应链上 factory/registry/identity singleton。硬编码集合只能提供 provenance/label，不得决定准入。
- 允许：基础设施 singleton、标准 token 常量、ABI selector/topic 常量。
- **允许：通用搜索容量参数**，例如 per-token candidate cap、top-N、hop/candidate budget。`8 -> 20`
  不是地址硬编码；它属于分布/资源变量。不能只因目标样本 rank=17 就宣告正确，必须通过同样本翻转、
  cohort 负例、CPU/延迟和候选质量验收。
- unknown factory/registry 的已知语义 fork 可进入 provisional identity，最终 sim fail-closed；全新 family
  必须 fail-closed 并实现专用 adapter。

发现自己“往地址表加一项让样本过”时立即停止；发现自己调整通用 cap 时，按分布类改动验收，而不是
误判成硬编码。

## 4. 统一六步物理事实链

现有工具可提供旁证，但六步的事实来源必须是原始链上数据、未修改的生产入口和 fork 执行结果。
challenger 不得修改 harness、fixture 或验收入口。
确定性 adapter/route 改动以六步作为主验收；protocol scanner、universe、分布或性能改动仍按自己的
cohort/覆盖率/公平性/Hermes 标准，不得被无关单笔样本否决。

| # | 步骤 | 独立判据 |
|---|---|---|
| 1 | 输入、transition、发现/身份准入/图 | 完整 production universe 下真实入口自发产生 canonical edges；backrun 必须由真实 raw trigger/prefix 驱动；不得注入 route/opportunity。 |
| 2 | 路线枚举 | production enumerator 自然输出完整有序 route；expected route 只能在输出冻结后由 comparator 比较。 |
| 3 | 状态与 exact quote | 在同一 lane-aware anchor 上逐腿记录 amountIn/out、fee、rounding 和 overlay；报价不可用/≤0 在此失败。 |
| 4 | plan、sizing 与 solver | production planner/solver 自选 input，产出 resolved plan 和逐腿金额；不得固定 landed amount 或预建 plan。 |
| 5 | fork final sim | 在正确 effective state 执行生产 calldata，成功还贷、守恒且无 standing position；独立复算 profit/gas。 |
| 6 | production EV | 运行生产 evaluator 并记录 allow/reject、reason、valuation/gas/bid 与 signed net EV；正 EV 修复的生命周期 gate 另要求 allow + net EV > 0。 |

六步是 machine evidence 的有序前缀；第一个 `fail/reject/not_reached` 后停止。人工可判断失败属于本次
scope、旧 harness 假阴性还是基础设施问题，但不能把 machine fail 写成 pass。若旧 harness 与 canonical
证据冲突，保留旧工具输出作诊断；只要 canonical producer 已覆盖本声明全部字段、独立 reviewer 证明旧失败
与本 diff 无关且不涉及硬安全，便不为旧工具改生产代码。

### 两种独立结果

1. **Adapter 结果：**同一 fixture 的稳定 baseline family-owned failure/未注册必须翻转为
   `adapter_replay_pass`；步骤 1–2 诚实 bypass，步骤 3–6 由生产 quote/planner/solver/calldata/final
   sim/EV 通过。再绑定 exact family ownership/conformance 与 `family_local` boundary。核心 judgment
   输出 `adapter_fixed + adapter_merge_ready`，只允许合并 boundary 内的 adapter diff；不要求自然枚举。
2. **Production gap 结果：**producer 不得获得 expected route/amount；自然输出先冻结，verifier 后比较。
   同一 run/state/route 的当前六步必须自然完成，solver 自选 amount，mandatory final sim 成功，Step 6
   `allow` 且 `net_ev_wei > 0`。核心 judgment 输出 `production_gap_fixed`。
3. 两种 judgment 都没有部署、回滚或删 branch 副作用。基础设施失败不判产品失败；系统性分布/延迟/资源
   声明继续走 cohort + Hermes A/B。

## 5. Cohort、分布和资源验收

- route-stage/等价声明的代表 tx 跑完整六步；cohort 其余交易至少跑确定性 baseline/challenger 翻转并逐笔记录 hash/result。
- 若部分失败，先判断是否误分 cohort；不是同根因则拆桶，不让通过样本替失败样本搭便车。
- 单笔 adapter/detector/planner/quote/execution funnel 修复：六步通过后做短 smoke，验证启动、安全和资源无回归。
- protocol scanner、graph/universe、top-N、candidate cap、排序、admission 等系统/分布改动：使用
  cohort 正负例、覆盖率/输出等价和短 smoke/A-B，
  记录 CPU、pass latency、budget-censored blocks、候选组成及 final-sim 假阳性；不能只看一个样本。
- smoke 可回答资源/回归，不能替代 pinned replay；历史 replay 可回答确定性能力，不能证明竞争 inclusion。

## 6. 合并与分支生命周期

- `adapter_merge_ready`：确认 exact base/challenger、原生 replay flip 与 `family_local` boundary 未漂移；
  只合并 family-owned diff。
- boundary 红但 `adapter_fixed=true`：adapter execution 已修，停止子分支；把超范围文件移到新的 framework
  分支，不得扩大 adapter branch 权限。
- `production_gap_fixed` 红：不否定已通过的 adapter verdict；记录首个失败生产阶段，并按
  enumeration/ranking/state/runtime 等独立 gap 处理。
- judgment 不负责 deployment/rollback/cleanup；这些动作遵循明确的人类授权或适用的 Hermes A/B 生命周期。
- 后续 main 修复同一 stable problem id 时，重跑该问题原先声明的 pinned 验收；通过后归档旧报告并删除旧 branch。
- main 是 champion。下一 gap 永远从最新 main 新切，不在旧 challenger 上堆叠。

## 7. 收尾报告

每个 cohort 只报告：

1. 样本 tx 与为何属于目标内闭环；
2. baseline 卡在哪个生产阶段；
3. 修改的 `listener/**` 文件/函数；
4. 本轮预声明验收的逐项证据与 reviewer 结论（适用时附六步）；
5. 是否需要/完成短 smoke 或 A/B；
6. merge SHA 与 branch 是否已删除；
7. `tool_divergence`（如有），引用对应 `divergence_id`、记录文件和本轮新增的完整 tx hash，明确写
   “本批次冻结，未修工具”，不得把它算作生产成果。

本批次唯一成功指标：至少一个真实目标样本沿生产漏斗推进。分析工具变好、测试数量增加、报告变完整，
都不计为生产推进。

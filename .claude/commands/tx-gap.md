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
- **状态锚**：scanner 样本 fork 在交易父块态；backrun 样本 fork 在父块态并按原交易顺序重放真实
  prefix/victim。核对 block number、state root、tx index。

每次验收保存命令、report/log 和 SHA-256。口头结论不算证据。

## 1. 高召回分类，工具只作助手

1. 先人工读取原始 receipt、logs、trace、交易顺序和 token balance delta，独立判断是否为目标内闭环。
2. 再用当前 tool-index 选择现有工具并 reconcile；不得从记忆中硬编码工具名。
3. 工具一致时可引用其输出；工具不一致、失败或字段不足时，写明 divergence 和具体缺口，随即回到
   原始 receipt/trace/fork 事实，不修工具、不扩工具、不为工具补 fixture。
4. 钉每腿 `(target, selector, tokenIn, tokenOut, amount, venue identity)`；身份读取优先级为真实调用、
   事件、factory/registry 反查。铸赎腿同时检查 mint/burn Transfer 与资产流。
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
- 每个 gap 从最新 `origin/main` 新建短生命周期 branch；通过即合并并删除，失败则记录证据后保留或关闭。

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

## 4. 人工六步物理事实链

现有工具可提供旁证，但六步的事实来源必须是原始链上数据、未修改的生产入口和 fork 执行结果。
challenger 不得修改 harness、fixture 或验收入口。
六步独立于 A/B deployment：`deploy` 不运行也不等待它；需要时在 live 窗口结束并 pause B 后执行。
它是 route-stage/等价声明的可选诊断，不是 deploy、decision、close 或 merge 的强制开关。若本轮
预声明目标就是某笔交易的六步推进，失败只否定该声明；protocol scanner、universe、分布或性能改动
按各自预声明的 cohort/覆盖率/公平性标准验收，不得被无关的六步样本否决。

| # | 步骤 | 独立判据 |
|---|---|---|
| 1 | scanner/detector 自发发现 | 完整 production universe 下，真实入口自行产生目标 route；不得手工注入 route/opportunity。Backrun 必须由真实 prefix/victim 触发。 |
| 2 | planner 出 plan | `candidate_plans > 0`，plan 边序与 trace 的调用腿序一致。 |
| 3 | solver 定价与 sizing | 逐腿 quote 与目标块真实池状态及 receipt/trace 成交量对齐；人工列出输入、输出、fee 和 rounding。 |
| 4 | fork sim 逐 wei | 在正确 parent/prefix 状态执行生产 calldata，成功还贷且无 standing position；用 fork 前后原始 `balanceOf`/ETH delta 独立复算 gross。 |
| 5 | 生产 EV gate | 调用生产同一 EV-gate/成本口径得到 net；不以手算美元值代替生产判定。 |
| 6 | 同桶翻转/等价 | 功能修复：同一历史输入从 baseline 的明确失败阶段推进到 `path_found`、`plans>0` 或 `final_sim_success`。等价重构：步骤 1–5 的集合/逐 wei/calldata/EV 判定一致，再单独检查 live performance 不低于预定阈值；build/test 通过不等于 fixed。 |

若 canonical 工具无法生成某一步，不修改工具：保存原始 RPC/trace/fork 命令与输出哈希，由主持 agent
人工完成六步，并让 fresh non-author reviewer 以 REFUTE 为目标复核。人工与 reviewer 均必须明确引用
每一步的证据；无法证明时只能放弃该 route-stage 声明，不能拿它证明 `fixed`。无关类型的改动仍按
自己预声明的 cohort/覆盖率/公平性标准决定。

## 5. Cohort、分布和资源验收

- route-stage/等价声明的代表 tx 跑完整六步；cohort 其余交易至少跑确定性 baseline/challenger 翻转并逐笔记录 hash/result。
- 若部分失败，先判断是否误分 cohort；不是同根因则拆桶，不让通过样本替失败样本搭便车。
- 单笔 adapter/detector/planner/quote/execution funnel 修复：六步通过后做短 smoke，验证启动、安全和资源无回归。
- protocol scanner、graph/universe、top-N、candidate cap、排序、admission 等系统/分布改动：使用
  cohort 正负例、覆盖率/输出等价和短 smoke/A-B，
  记录 CPU、pass latency、budget-censored blocks、候选组成及 final-sim 假阳性；不能只看一个样本。
- smoke 可回答资源/回归，不能替代 pinned replay；历史 replay 可回答确定性能力，不能证明竞争 inclusion。

## 6. 合并与分支生命周期

- 本轮预声明的验收标准、必要 smoke/reviewer 全绿（route-stage 声明才包含六步）：rebase/merge 到最新 `origin/main`，确认生产 diff 未漂移，
  push 后立即删除对应本地/远端 branch 和 worktree。
- 红或证据不足：不合并为 fixed；记录 exact base/challenger、失败步骤、复现命令和未解问题。
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

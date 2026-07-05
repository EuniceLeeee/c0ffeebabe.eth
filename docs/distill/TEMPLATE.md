# 对比记录 | 编号: d:MMDD-qNN | 日期:

<!-- 复制本模板为 docs/distill/2026-0704-q01.md 之类。由Fable填写,不进Opus上下文 -->

## 0. 问题原文
> (你发起的问题,原样贴)

**代码状态锚点:** git commit `___`(没有git就写一句当时的代码状态)
**原始记录路径:**
- Opus会话: `raw/0704-q01-opus.jsonl`
- Fable会话: `raw/0704-q01-fable.jsonl`
<!-- 本文件是索引和提炼层;完整源数据以raw/为准,反推和未来重蒸馏都用raw -->



## 1. Opus的表现
- **结论:**
- **推理路径:** 先查了什么 → 假设了什么 → 跳过了什么(按实际顺序)
- **工具序列:** 实际执行的命令,按顺序列出
- **自我验证:** 做了哪些检查(如果没做,明确写"无")

## 2. Fable的表现(先独立回答,再看Opus答案)
- **结论:**
- **推理路径:** (同上,Fable自己复盘:我先做了什么,为什么是这个顺序)
- **工具序列:**
- **自我验证:**

## 3. Diff分层
| 层 | 有差异? | 具体差在哪 |
|---|---|---|
| ① 结论差 | 是/否 | |
| ② 路径差(顺序/切入点) | 是/否 | |
| ③ 验证差(该查没查) | 是/否 | |
| ④ 工具差(命令/用法) | 是/否 | |

**根因归类:** 这个差距属于「可指令化」(写规则能修)还是「原始能力差」(标记为Fable介入节点)?

## 4. 提炼 → 去向
| 提炼出的规则/流程改动 | 写入位置 | 已写? |
|---|---|---|
| (可迁移的模式,一句话) | CLAUDE.md / SKILL阶段_ / SKILL失败模式 | ☐ |
| (绑定当前代码的具体结论) | decision-log D-___ / F-___ | ☐ |
| (完整过程值得做范例?) | SKILL worked example | ☐ |

## 5. 回归验证
- **重跑方式:** 新会话让Opus(加载更新后的规则)重答原问题
- **结果:** 差距消除 / 部分消除 / 无效(无效→撤回规则,在此注明)

## 6. Method Trace (Fable 每轮手工分析必附;缺失 = 无效交付)
<!-- 这是给 Opus 蒸馏的"项目方法胶囊",不是隐藏思维链。字段规范见 docs/research/HERMES.md rule 16。 -->
```
task_class:       competitor_path | bundle_postmortem | architecture_review | replay_fixture | protocol_leg
tools_used:
evidence_order:
analysis_frame:
sanity_checks:
tool_gap:         none | <工具没抓到什么>
codify_next:      no | <要加的 field/test/gate/tooling_defect + 目标文件>
distill_for_opus: <这轮 Opus 应学到的一条可复用规则>
```

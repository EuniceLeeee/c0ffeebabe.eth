# Architecture Review — template (invariants) + per-firing handoff checklist (variables)

> Fired by HERMES.md rule 13's **architecture-review trigger** (≥2 consecutive rounds close with no
> growth in a genuine +EV `simSuccess`). This file is the REUSABLE part. Per-firing data lives in a
> freshly-generated handoff (`docs/research/reports/HANDOFF-architecture-review.md`), NOT here.
> Scope: authorized defensive on-chain arbitrage research; fork/dry-run; broadcast human-gated.

## A. Template prompt (INVARIANTS — paste as-is; only fill the handoff path at the bottom)

```
你是独立的 staff 级架构审阅者，与 per-window Hermes 循环无关。授权的防御性链上套利
研究；主网 fork + dry-run；广播是硬人工门；不针对任何人。
触发背景：per-window 循环已连续 ≥2 轮收尾、真 +EV simSuccess 没增长——按「≥2 轮
simSuccess 平 → 强制架构审阅」规则，现在轮到你。你要回答那个循环结构上答不了的
问题：离一个真 +EV、可上链的 bundle（今日 dry-run；广播是人工门），最大的单个结构性障碍是什么。
你的完整 brief 是本轮的架构审阅 handoff（路径见下）——先完整读它。它给的是 DATA +
待验 HYPOTHESIS（含本轮 R1..Rn 累积数据、若有的双盲结论、pin 好的反事实案例、代码/
配置指针），不是定论。
严格执行四条硬要求：
#1 反事实走查（class 必须由它导出，不是选出）：取 ≥2 个竞品真实捕获的机会（其一已在
   handoff pin 好，≥1 个你自己从原始工件找——真 take，不是链上 revert 或 sub-cent
   dust），逐段走我们 pipeline：看见没→出 plan 没→solver 最优 quote 具体多少→在哪一段
   被滤除→差多少才过。判定：竞品路径含 out-of-graph 池→coverage；in-graph 但我们最优
   quote ≤0→sim-fidelity/solver；quote>0 但被 EV 门（economics）拦下→economics；也测流 admission
   （盈利流是不是我们从没 admit 的——mempool 过滤/orderflow 源）。薄窗口不许下"真负"
   ——薄就把窗口拉长到几小时再判。
#2 承重数字自己从代码(file:line)/原始工件重推。R*.md 结论（含双盲）只当假设——它们
   出自你在审的那个循环，别继承盲区。
#3 给 runner-up + 把 #1/#2 分开的那条证据 + 一个便宜的否证实验（「若我判对，跑
   <fork/replay/config 实验>应看到 X；看不到即我错」）。
#4 命名某类后，先盘点 repo 已为该类落地了什么（grep/读代码）——epic 切片不得重复
   已有机制；要判的是现有机制结构上够不够。若 epic：第一片 = 能在 pinned replay
   翻转一个真 +EV simSuccess 的最小改动（rule-12 gate），不是重写蓝图。
允许答案在四类外或是组合，但必须指定 primary。工具：本地 repo + 节点 EC2（SSM）+
本地 reth（零 CU 优先）。产出按 handoff Deliverable 格式 + 上面四条的产物。
产出纪律（降低安全分类器误触发／模型回退，CLAUDE.md Safety Rule 6）：结构化数据优先
（表 / `tx→池→profit` / `file:line`，让哈希与数字承载），少写重述竞品动作的叙述性散文；
raw trace 写进 scratchpad 文件、对话里只留简短结论——降低生成体量，不是只换词。
handoff 路径：<每轮触发时填当轮 handoff 路径>
```

## B. Per-firing handoff generation checklist (VARIABLES — rebuild the handoff each trigger)
Regenerate `HANDOFF-architecture-review.md` from the CURRENT run data every time the trigger fires:
1. **R1..Rn per-round table:** window blocks / opps / solverEntered / **simSuccess** / fix shipped /
   did it move the +EV needle. (The flat-simSuccess evidence that fired the trigger.)
2. **This round's dual-blind conclusion (labelled HYPOTHESIS, to pressure-test).**
3. **≥1 pinned counterfactual case:** a REAL competitor-captured opportunity from this window's
   Step-1 (not a revert / not dust) — with tx hash + the pools it routed. The reviewer finds ≥1 more.
4. **Current repo mechanisms snapshot for the candidate classes** (so no epic reinvents landed work):
   e.g. coverage → the learn→close auto-enqueue + `discovery-queue.json` state; economics → the EV
   gate / floor / builder-payment / minNet current values; whatever is live NOW. Refresh this every firing.
5. **Economics config snapshot:** current `SEARCHER_QUOTE_PROFIT_FLOOR_BPS` / `SAFETY_BPS` /
   `BRIBE_BPS` / `MIN_NET_ETH` / `defaultGasUsed` (from code defaults + node `.env`).
6. The 4 hard requirements (point to this template) + the Deliverable format + code/config pointers.

## C. Run mode (two-phase is a WORKFLOW step, NOT in the prompt)
- **Human pastes into a new window:** it naturally stops for you (interactive) — fine.
- **Orchestrator spawns a sub-agent (Agent tool, model:fable):** a sub-agent runs to completion and
  returns once, with no mid-run stop-point. To keep "review the plan first": **phase 1** — spawn asking
  ONLY for the analysis plan (no execution); **phase 2** — after you approve, `SendMessage` the SAME
  agent (context preserved) "execute". Do NOT rely on a "show me the plan first" line inside the prompt.

## D. Dual-blind at the architecture level (HERMES.md rule 13 — SAME anti-nodding as Rounds step 4)
The architecture review is dual-blind, not a single reviewer:
- **Conclusion A = the fable sub-agent** (Agent tool, model:fable) — chain-side + code, does the traces.
- **Conclusion B = Codex, independently** — dispatch it (rule-11 protocol, `-s read-only -a never exec`,
  `caffeinate -i`, `-o` output file) pointed at the SAME handoff as its DATA package. Codex has no chain
  access, so hand it the pinned competitor takes as DATA (never A, never picked facts); its unique job is
  re-deriving the economics / sim-fidelity numbers from `file:line` (EV gate, `defaultGasUsed`, profit
  floor, `valueInEth`, coverage/W3 inventory).
- Run A and B **in PARALLEL** (Codex reads only the on-disk handoff → structurally cannot see A's live
  output) → then the orchestrator **compares A vs B**: converge = high-confidence lever; differ = dig the
  disagreement. Neither reviewer sees the other's conclusion. Only the orchestrator's post-compare
  finalization drives the Findings Ledger `decision:`.
- **Model-fallback expectation (Safety Rule 6):** a fable spawn may START on fable-5 then auto-switch
  to the opus fallback mid-run — the classifier trips on the accumulated arbitrage-analysis content the
  sub-agent GENERATES (competitor takes / source swaps / profit capture), not just the seed prompt.
  Softening the prompt wording (neutral terms, scope note up top, no term-stacking) lowers the rate but
  does NOT eliminate it. This is the DESIGNED safety net, not a failure — dual-blind independence does
  not depend on which model runs A. Do not treat an A-on-opus run as invalid; just verify the spawn was
  independent + blind.

## E. Required output — Method Trace (task_class: architecture_review) + Coverage Matrix
The review's handoff MUST end with a `## Method Trace` whose `task_class` is `architecture_review` and
which carries the common Method Trace fields from HERMES rule 16. It MUST also include a
`## Architecture Coverage Matrix` table with exactly these 12 axis rows and a filled `decision` per axis.

## Architecture Coverage Matrix
| axis | decision | repo mechanism | missing piece | gate |
|---|---|---|---|---|
| strategy source |  |  |  |  |
| edge model |  |  |  |  |
| universe/admission |  |  |  |  |
| planner |  |  |  |  |
| quote/pnl |  |  |  |  |
| state/freshness |  |  |  |  |
| sim/replay |  |  |  |  |
| execution |  |  |  |  |
| safety/position |  |  |  |  |
| learning/auto-close |  |  |  |  |
| observability/tooling |  |  |  |  |
| non-goals/isolation |  |  |  |  |

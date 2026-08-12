# S1 Phase E cleanup plan（先建后删，逐对保持绿）

> D-011：用户决定跳过默认 authority 切换的额外验证，直接执行 Phase E，
> 可回退。live 节点 `/opt/MEV` 在显式部署前仍运行旧 runtime，不受本分支
> 删除影响。每条删除对（pair）都必须：strict 替换先落地（合同绿）→
> call-site 切到 strict（默认 OFF 的 env gate 内）→ 验证 → 删除 legacy
> （合同绿）。任一 pair 无法保持绿则回退该 pair 并如实记录。

## 已完成

- Slice 1（`74ee43b5`）：移除 legacy activation manifest + 合同/基线、
  erc4626 legacy recall + 探针；全部绿。

## 删除对（按依赖排序）

> **结构性前置（2026-08-12 确认）：** 所有删除对都依赖 live 循环真正提交
> strict catalog publication。当前 production 里
> `discoveryContinuityComposition.catalogRoot.capture()` 恒为 null：没有
> 任何生产者执行 discovery→lifecycle→closure→stage→commit 管线，strict
> views 从未存在，execution 投影因此永远回退 legacy。Phase E 删除的硬
> 前置是**先建这条 strict 生产管线**（这是 canonical 一直说的"solver 真实
> 接线"本体），不是默认 authority 开关本身：
> 1. 每个 admission 的 pool 经 strict Family lifecycle 签发 PreparedFamilyInstance；
> 2. checkpoint inventory（writer 已落地）→ closure verifier → receipt；
> 3. 逐族 stage（complete-snapshot / observed-complete）→ catalogRoot
>    prepare + compareAndPublish；
> 4. solver/revm 消费 committed views（execution 投影已就绪）。
> 在此之前任何 legacy 删除都会留下无数据路径；"直接删除+回退"只会在
> 回退循环里打转，不构成推进。
>
> **管线进展（2026-08-12）：** `strict-catalog-live-publisher` 已落地：
> 给定 lifecycle-issued publication，恢复 checkpoint inventory →
> closure verifyAndIssue → 逐族 stage（complete-snapshot /
> observed-complete）→ prepare + compareAndPublish，返回 revision 或
> unresolved；wsteth 合同测试通过（rev1 + committed views）。剩余：
> 生产循环里为每个 admission 的 pool 跑 strict Family lifecycle（管线
> 步骤 1）并把 publisher 接到 live 发布路径（步骤 4 消费端已就绪）。
>
> **管线进展 2（2026-08-12）：** `runStrictFamilyLifecycle` 已落地
> （catalog.matches → executeAdapterFamilyLifecycleBatch → publication，
> 无 match/无 publication fail-closed 且错误带 stage/reason）；wsteth
> fixture runtime 导出复用，合同测试通过。管线步骤 1 的调用面就绪；
> 剩余为生产循环把 discovery observations 喂给 runner 并把 publication
> 接到 publisher。
>
> **硬边界（2026-08-12 证据确认）：** `main.ts` 只有 legacy
> `AdapterRuntimeCoordinator`，**production 不存在 strict
> `CentralAdapterRuntime`**（无任何 lifecycle 执行实例、无 strict
> scheduler/budget/fence 生产接线），`catalogRoot` 在生产里从未被
> 提交过 publication。因此管线最后一段（production strict runtime +
> live-loop 接线）是整套 S1 production runtime 迁移，不是可继续以
> 合同 wrapper 凑出的 slice；继续产出小 wrapper 而不建 production
> runtime 属于"polishing the microscope"（decision-log X-004），
> 不再这样推进。下一步必须是生产 runtime 建设（multi-slice 程序），
> 或明确接受 shadow-only 边界。
>
> **生产 runtime 第一块已落地（2026-08-12）：**
> `createStrictCentralAdapterRuntime`：provider-backed strict runtime
> （eth-call / get-code / get-storage 按 canonical source block 执行，
> simulation fail-closed resource-limited，scheduler/policy/fence 按
> central 契约）；合同测试用 mock provider 驱动 wsteth lifecycle 到
> publication 成功。剩余：simulation transport（revm）接入、main.ts
> 构造并接线 live-loop（runner→publisher）。
>
> **生产 runtime 第二块（2026-08-12）：** simulation transport 合同面
> 已落地（`StrictSimulationTransport`）：注入 simulator 后
> state-override/effect-delta simulation 返回 data + effects，缺省
> 仍 fail-closed resource-limited；合同测试覆盖两分支。剩余：revm
> backend 实现该 transport、main.ts 构造 runtime 并接线 live-loop。

| Pair | legacy 目标 | 需要的 strict 替换 | 状态 |
|---|---|---|---|
| A | `production-registry.routes()/funding()` 在 `revm-live-backend` 的执行消费 | strict family runtime handle / strict funding consumer 接入 live execution | step 1-5 完成：22 族 execution projection 全覆盖（spender 静态/hop.target/angstrom 常量/null；prewarm 保守留空）env gate 接线（默认 OFF）；**删除步骤阻塞**：strict 路径激活依赖 composition env + committed publication（即默认 authority 接线），用户选择跳过；在 composition 成为默认前删除 legacy 会让无 composition 的生产路径失去 execution 数据 |
| A | 同上 | 同上 | step 1-6 完成：execution 投影改为 composition 存在即默认启用（移除 env flag；无 committed views 时按 per-family/per-availability 回退 legacy），删除步骤的 authority 前置已最小化；仍保留 per-family 回退，删除 legacy 消费前需 composition 生产默认 |

> **Pair A 节点验证（2026-08-12，SSM 串行 strict-live run）：**
> challenger `45908c6c` + `SEARCHER_STRICT_LIVE_EXECUTION=1`（composition
> env 未开）：priced=32730/37328（87.68%）、edges=37062、events=865，
> 与无 gate challenger（87.61%/36922）相比无回退。注意该 run 无 committed
> strict views，strict 路径按设计回退 legacy——验证的是 gate 接线 no-op
> 安全性；univ2 pilot 真正激活需要 composition env + committed publication
> （节点下一步）。
| B | `PRODUCTION_IDENTITY_RESOLVERS` / `attestPoolIdentities` | strict 身份经 Family lifecycle identity 阶段 + source-bound consumer | 未开始 |
| C | `landedPoolDiscovery` / `landed-event-registry` / `auto-close-router-gap` 消费 | strict discovery checkpoint + enumerator + observed-complete 事件面 | 未开始 |
| D | `productionPoolUniverseSourceFingerprints`（universe deploy trust） | strict catalog/checkpoint 派生指纹（identity/lineage 部分先由 strict 覆盖） | 未开始 |
| E | blockscan loop 的 legacy pricing 消费（14 legacy pricing Family） | strict pricing views + `strict-solver-consumer` 全量解析 | 合同已备，接线未接 |
| F | family facade / 手工 revision / legacy schema/cache bridge / 旧 flag | strict manifest + capability hash + CAS publication | 未开始 |

## 验收

- 每个 pair 提交后：`npm run build`、shadow suite、`s1-regression-sweep.sh`
  全绿；删除目标不再被 `listener/src`（除自身文档）引用；
- 全部 pairs 完成后：`searcher:live` 在无 legacy registry 引用下可编译
  启动（dry-run），canonical §18.3/§20.2.6 全门通过，Phase E 关闭。

# S1 F5-b real corpus rollout plan（守护窗口自动续跑契约）

> 目标：把 22 族的 sealed-production corpus 从 fixture 升级为真实链上采集。
> 本文件是自动化续跑的唯一事实来源：每轮守护恢复后先读本文件，从未完成项
> 继续，直到 `DONE`。用户无需每轮回复。P0-6 fail-closed 门不动。

## 模板契约（univ2，第一族）

1. 新建 `captureUniv2OnchainCase(input: {source, provider, pool, tokenA?,
   tokenB?, reserves?, caseId?})`，在 `source.number` block tag 上：
   - `pair.factory()` / `pair.token0()` / `pair.token1()` /
     `pair.getReserves()` 实读；
   - 描述符与链上值不一致（含 RPC 失败/空结果）一律 fail-closed 抛错；
   - 身份用链上 factory/token 派生，禁止硬编码 factory。
2. 证据 ref 改为 `onchain:1:<source.hash>:univ2:<pool>`（可对链上数据复核）。
3. 本地合同测试：mock provider 正例 + RPC 失败拒绝 + token/factory 不一致
   拒绝 + evidenceRefs 前缀断言。
4. 节点 dry-run 复验（SSM 只读 + impl-capture worktree，dry-run）。
5. 验收：build + shadow suite + 12 组 sweep 全绿，checkpoint 同轮 commit+push。

## 通用采集路径（2026-08-13 用户选定，替代逐族工具链扩展）

新增 `generic-family-capture.ts`：`captureFamilyGenerically` 输入
`{catalog, familyId, source, observation, runtime}` → 通用 strict
lifecycle → publication 派生 stages（instances/edges/prices/
enumeratedRoutes/failures 全通用；exact/execution/finalSim 在 per-plugin
driver 接入前诚实 `framework-blocked`，不伪造）。合同测试（wsteth
fixture runtime：onchain 证据 ref + 无 fixture + blocked 诚实）；
build/shadow suite（38）/12 组 sweep 全绿。剩余：由 discovery 声明
派生 observation 的通用函数、CLI 通用模式、exact/execution per-plugin
driver 注册表（新族 = 插件自带模块，不再改工具链逻辑）。

**通用路径推进 2（2026-08-13）：** `deriveFamilyObservationFromNodeData`
按插件 discovery 声明派生 observation（callPatterns→call、logPatterns→
log、addressSurfaces→codeHash+EIP-1967 实读）；`GenericCaptureDriver`
注册表 + `registerGenericCaptureDriver`/`resolveGenericCaptureDriver`，
`captureFamilyGenerically` 在 driver 注册时真实执行 exact/execution/
finalSim，否则诚实 framework-blocked。合同测试：无 driver blocked +
有 driver exercised。build/shadow suite（38）/12 组 sweep 全绿。
剩余：CLI `--generic` 模式（descriptor 只带 family+address，走
derive+capture 通用路径 + strict runtime/revm）与 univ2 真实 driver。

**通用路径推进 3（2026-08-13）：** CLI `--generic` 模式已接线
（descriptor 只带 family+address，strict runtime + revm 经
`S1_REVM_SIM_BIN`；逐族容错，失败记录并继续）；generator 输出通用
`{family,address}`；corpus 脚本走 `--generic`。节点首次 generic 运行
暴露 univ4：通用 log 派生需要 emitter（V4 PoolManager 单例）与
Initialize log data（pool key 从 manager 链上读再编码）。
**经验约束（重要）：** 插件契约变更（即使加可选字段）会改 capability
manifest 哈希，使已提交节点证据失效（verifier 按设计 fail）——因此
“LogPattern 加 emitter 声明 + univ4 插件声明 + 节点证据重生成”必须
作为一个完整 slice 一起落地，不能半切。当前保持绿（emitter 未入插件，
generic 派生用 descriptor 可选 emitter 兜底）。

## 滚动清单（按序，模板先 erc4626 再其余）

| # | 族 | capture 函数 | 状态 |
|---|---|---|---|
| 1 | univ2 | captureUniv2OnchainCase | completed |
| 2 | erc4626 | captureErc4626OnchainCase | completed |
| 3 | erc4626-silo | captureErc4626SiloOnchainCase | completed |
| 4 | astra | captureAstraOnchainCase | completed |
| 5 | eigenpie | captureEigenpieOnchainCase | completed |
| 6 | ethertoken | captureEtherTokenOnchainCase | completed |
| 7 | metronome-hgusdc | captureMetronomeHgUsdcOnchainCase | completed |
| 8 | curve-underlying | captureCurveUnderlyingOnchainCase | completed |
| 9 | dodo-v2 | captureDodoV2OnchainCase | completed |
| 10 | fluid-dex | captureFluidDexOnchainCase | completed |
| 11 | fluid-credit | captureFluidCreditOnchainCase | completed |
| 12 | psm | capturePsmOnchainCase | completed |
| 13 | wsteth | captureWstethOnchainCase | completed |
| 14 | goldx | captureGoldxOnchainCase | completed |
| 15 | rocksolid | captureRocksolidOnchainCase | completed |
| 16 | metronome-synth | captureMetronomeSynthOnchainCase | completed |
| 17 | self-burn | captureSelfBurnOnchainCase | completed |
| 18 | angstrom-v4 | captureAngstromV4OnchainCase | completed |
| 19 | univ3 | captureUniv3OnchainCase | completed |
| 20 | univ4 | captureUniv4OnchainCase | completed |
| 21 | funding | captureFundingOnchainCase | completed |
| 22 | curve | n/a — 与 curve-underlying（row 8）同一族，captureCurveUnderlyingOnchainCase 已 completed | completed |

## 每族完成判据（全部满足才把状态改为 completed 并 commit+push）

- 真实链上身份派生 + 描述符一致性 fail-closed；
- `onchain:` 证据 ref，无 `fixture:`；
- 本地合同测试（mock provider 正/负例）；
- 节点 dry-run 复验有机器证据（JSON 落在
  `docs/research/design/evidence/`）；
- build + shadow suite + 12 组 sweep 全绿。

## 终态

- 22 族全 completed 后（当前 21 族 + curve 同族已 completed）：
  **held-out 契约修正（2026-08-13 代码核对）**：
  `ArchitectureMigrationHeldOutNegativeInput` 是“故意不匹配的
  baseline/challenger 对”，必须判 `semantic-mismatch`——不是真实 cases
  的切分。因此采集分两步：
  1. 真实 baseline：节点上从 universe 快照（univ2/univ3/univ4/
     curve-underlying/dodo-v2/fluid-dex 真实 pool）+ protocol cache
     verifiedCandidates（erc4626 等真实协议地址）生成 descriptor，
     `run-architecture-migration-capture-real-cli.ts --onchain` 产出
     `onchain:` 证据的 baseline side；
  2. 逐族负例：对每个真实族生成篡改 challenger（univ2/univ3/dodo 交换
     tokenA/tokenB、univ3/univ4 改 fee/tickSpacing、协议族改 vault/
     asset 地址），同一 judge 必须输出 `semantic-mismatch`。
  3. sealed-production acceptance 判定：
     `evidenceClass=sealed-production` + 非空 heldOutNegatives +
     aggregate pass + 负例全 mismatch → `eligible`；F5 关闭后再进 F6。
- 节点执行步骤（待运行）：impl-capture 已到 `26888125` 且 build OK；
  下一步生成真实 descriptor → 跑 baseline + 负例 → parity judge →
  写 evidence JSON 到 `docs/research/design/evidence/`。

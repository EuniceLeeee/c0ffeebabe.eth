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

| Pair | legacy 目标 | 需要的 strict 替换 | 状态 |
|---|---|---|---|
| A | `production-registry.routes()/funding()` 在 `revm-live-backend` 的执行消费 | strict family runtime handle / strict funding consumer 接入 live execution | step 1 完成：funding prewarm 投影 + env gate 接线；route 投影待做 |
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

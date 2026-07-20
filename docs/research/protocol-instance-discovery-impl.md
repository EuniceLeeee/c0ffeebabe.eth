# Protocol Instance Discovery — 终审 + 实现规格(自包含,供手机 Fable 执行)

> **实现基线**:`codex/protocol-instance-discovery @ 1810309`(评审时的 tip)。
> **状态**:`implemented_not_validated`(未 fixed)。P0 none。
> **文档性质**:三方评审(Codex 1 / Codex 2 / Codex 3)+ Claude 1 终裁 + 可执行实现清单,合并为一份。
> 姊妹文档:[protocol-instance-discovery-plan.md](protocol-instance-discovery-plan.md)(架构总纲)。本文件是它的落地规格。

---

## 〇、给实现者(手机 Fable)的执行须知 — 先读

1. **验证最新代码再动手**(HARD RULE):`git fetch origin` → 以 `origin/codex/protocol-instance-discovery` **当前 tip** 为准 grep/读;本文件锚 `1810309`,若 tip 已前移,先 diff 确认下列"已实现/缺口"仍成立,再改。绝不照记忆或本文改一个已经变了的位置。
2. **提交目标**:代码改动 commit + push 到 `codex/protocol-instance-discovery`(不是 main)。md 文档改动才进 main。
3. **reconcile 门(CLAUDE.md §5)**:任何手搓的 venue/pool/trace/PnL 分析后,`Stop` 前必须 `cd analysis && npm run tool-index -- --select <cap> --out /tmp/mev-tool-selection.json` 然后 `npm run tool-run -- --manifest /tmp/mev-tool-selection.json --tool <id>` 清门(默认路径 `/tmp/mev-tool-selection.json` 才清得掉)。
4. **build ≠ fixed**:编译过只是 `implemented`。升 `fixed` 必须同一失败样本 **scanner 自发枚举 → path_found → final_sim_success** 翻转,且验收含第二-adapter fixture(见 §四)。
5. **安全**:mainnet 广播/私钥签名是人类门(Rule 1),本任务全程 fork/dry-run,不触发。final sim 永远是 fail-closed 终门。

---

## 一、实现路径总结

**当前(`1810309`)已实现**(逐条核实):
```
adapter 声明 eventTopics/callSelectors
→ 通用 scanner 收集 DEX address / observed trace 候选
→ attestIdentity → probeCandidate → assertVerifiedEdges → graph projection
```
- adapter 派生 event topic **union** ✓;selector 由 scanner 遍历 descriptor **分发** ✓(新 adapter 无需改 scanner)
- 单 range pass 内按 txHash **去重** ✓;live observed 短期 txHash 去重 ✓
- **positive/negative address cache 落盘** ✓(`main.ts` cache path + 写入 + 启动日志 `address=N verified=M path=..`)
- **verifiedCandidates 落盘 + 重启重新 identity/probe** ✓(链不匹配拒载,测试实测 `expected=10 actual=1`)
- observed 循环**收集全部 per-adapter 匹配,不提前丢**(丢弃发生在 coordinator 的 pre-probe target quarantine)

**核心实现(单一交付,不分期 — 用户已否决分期,按依赖排序):**

| # | 实现项 | 主要落点文件 | 要点 |
|---|---|---|---|
| 1 | 独立调度 + 持久 cursor | `main.ts`(现 `refreshIntervalMs=300000` DEX timer)、`protocol-discovery-runtime.ts` | protocol range/address scanner 脱离 DEX refreshTimer,自有 cadence;持久化补 `observedCursor / recentProcessedTxs / routeOwnership`(现 positive/negative/verified 已落盘,只**扩 schema**,勿重写) |
| 2 | 跨入口 trace memo | `observed-protocol-discovery.ts` + range scanner | observed 与 range 共享 `TraceMemo<txHash>`,同 tx 全局只 `traceTransaction` 一次 |
| 3 | 每候选独立验证 → `VerifiedRouteClaim` | `protocol-instance-discovery.ts`(coordinator) | `normalize → identity → evidence → probe → 单 adapter assert`;**删除 pre-probe 的 target 一刀切**(现在 identity 前按 target quarantine);observed 与 address 两路径统一到此 |
| 4 | Evidence 同块优先级 + 漂移复检 | `erc4626-discovery.ts` | 当前块 evidence **全部**检查、任一矛盾即拒;无当前块则用最新且 fingerprint 匹配的历史;**去掉旧 evidence `.find()` 遮蔽新同块的 bug**;复检已含 asset/code/impl/preview-convert bounds/同块 payout,补 adapter-owned 跨块漂移不变量(**不比历史 payout 绝对值**) |
| 5 | post-probe route ownership + 跨 pass 合并 | `protocol-instance-discovery.ts`、`protocol-discovery-runtime.ts` | 新 claim + 上轮有效 + retry-retained + **static/legacy** 一起进裁决;确定性失败撤旧、临时失败保留;ownership 需落盘(项1) |
| 6 | 全局 route 裁决 | `protocol-instance-discovery.ts` | `semanticRouteKey = chainId + target + logicalInstanceId/poolId + tokenIn + tokenOut + slotKind + protocolAction`;等价 fingerprint **去重** + 显式 authority **选主(禁按注册顺序/字符串排序)**;observed selector **不进** semantic key,执行 selector 进 executionFingerprint |
| 7 | 复合 projection key | `pool-universe.ts`(`poolRegistryKey` 现非 v4 = 裸地址)、`token-graph.ts`(`poolAddressMap`) | 同址第二逻辑实例会被吞;改复合 key **或**把 protocol route ownership 与单值 `poolAddressMap` 解耦 |
| 8 | C2 非零 fork/revm redeem 第二证据 | `erc4626-discovery.ts`(新 evidence producer) | 现 C2 仅 `asset/convertTo*/preview*/deposit(0)/redeem(0)` view 调用;补本地 fork/revm 真跑非零 deposit+redeem、解码收据(实付 token/量 vs preview 一致)。**verified-routes-only + 删 legacy 的前置** |
| 9 | legacy 全迁移 | `token-graph.ts`(`EXTERNAL_AND_LEGACY_POOL_REGISTRY`)、`erc4626.ts`(`buildEdges`) | 标准 erc4626 static seed 全删;srUSDe 类(`nonStandardRedeem`)进专用 adapter/verified route;`buildEdges` **只为 `verifiedRoutes[]` 发边**(否则通用 builder 凭 `fixedTokenIn` 重新长出 probe 拒过的 redeem);static 不再覆盖动态验证失败 |
| 10 | 验收(见 §四) | 测试目录 | 含第二-adapter fixture + no-seed recall + scanner 自发枚举→final sim |

**`VerifiedRouteClaim` 结构**:
```ts
type VerifiedRouteClaim = {
  semanticRouteKey; producerAdapterId; edgeAdapterId;
  authorityFingerprint;   // 身份根(registry/factory/role/接口自洽)
  executionFingerprint;   // 实际执行 selector/calldata 形状
  edge;
};
```

---

## 二、具体意见与分歧(Claude 1 覆盖裁决,以 `1810309` 源码为准)

| 议题 | Codex 1 | Codex 2 | Codex 3 | **Claude 1 终裁** |
|---|---|---|---|---|
| 总体流程 | 三门后 arbitration | 方向对,闭环未完 | 未推翻 | 保留;全部为核心一次交付 |
| Gate 1 职责 | 属协议族 | 还查 code/asset/preview | — | 身份 + 最低接口自洽 |
| Gate 2 职责 | probe 绑定 | 依赖 adapter 自律 | 复检不全 | 需明确 adapter probe contract |
| Gate 3 职责 | shape 校验 | 不完整 | — | 接受 |
| scanner cadence | 未列 | 未评 | 挂 DEX timer | **Codex 3 部分对**:range/address 挂,observed 不挂 → 核心1 |
| cursor 落盘 | 遗漏 | 只审 retry | 没落盘 | **Codex 3 对** → 核心1 |
| topic union | 应派生 | 未列 | 没派生 | **Codex 1 对**,已实现 |
| selector 派生 | 应派生 | 未列 | 没有 | **Codex 1 对**,已由 descriptor 分发 |
| 单 pass trace 去重 | 应去重 | — | 会重复 | **Codex 1 对**,已去重 |
| 跨入口 trace 去重 | 未明确 | — | 会重复 | **Codex 3 对** → 核心2 |
| specificity 唯一性 | post-probe | 只有 pre-probe target | 没有 | **Codex 2/3 对** → 核心3/6 |
| observed 多匹配 | 分别验证 | 提前丢弃 | 归 specificity | **更正**:observed 收集全部;丢在 coordinator pre-probe target quarantine → 核心3 |
| 歧义裁决位置 | post-probe | identity 前拒 | 未实现 | post-probe → 核心6 |
| 同址不同 route | 共存 | projection 不支持 | — | 接受 → 核心7 |
| route key | t+in+out+action | 加 instanceId/slotKind | — | 用 Codex 2 完整 key → 核心6 |
| selector 进 key | 酌情 | 语义不进/执行进 fingerprint | — | 同意 Codex 2 |
| 多 adapter 同路线 | 隔离 | 等价去重/不等价隔离 | 未实现 | **细化(三.5)** |
| 选主方式 | 未明确 | 禁排序,显式 authority | — | 同意 Codex 2 |
| 跨 pass ownership | 合并旧 claims | observed pass 不带 retained | — | **Codex 2 对** → 核心5 |
| C2 第二证据存在? | 应补 | 未评 | 没有 | **Codex 3 对**:仅 view → 核心8 |
| C2 是否核心 | 需质量门 | 未评 | 必须补 | **必须补**(verified-routes-only) |
| positive cache 落盘 | 已落盘 | 确认 reload | 没落盘 | **Codex 1 对**;Codex 3 错(拿 final3 判) |
| negative cache 落盘 | 已落盘 | 未专项 | 没落盘 | **Codex 1 对** |
| route ownership 落盘 | 要持久 | 生命周期不全 | 混入双 cache | **Codex 3 实质对** → 核心1 |
| retry 分类 | reload 重验 | 依赖错误正则 | 未否定 | **更正 Codex 2**:主用 `.code`,仅 pruned-state 用正则,类型化那一条 |
| 行为复检 | 有 preview/convert | 旧 evidence 遮蔽同块 | 只查非零 | **Codex 3 表述错**(远不止非零);真缺口 = evidence 优先级 → 核心4 |
| 历史 payout | 不比绝对值 | evidence 顺序 bug | 应比旧证据 | 不比绝对值,改 adapter-owned 漂移不变量 |
| evidence 优先级 | 未覆盖全冲突 | 同块不被旧遮蔽 | 未分同/跨块 | 采用 Codex 2 → 核心4 |
| static legacy | 未重点 | 不归 ownership 撤不掉 | 未全迁移 | **Codex 2/3 对** → 核心5+9 |
| code hash+impl | 覆盖常见升级 | 不覆盖 beacon/diamond/asset proxy | — | 接受局限,别称通用升级证明 |
| P0 判断 | none | none | none | **四方一致 none** |
| 是否 fixed | 入图≠fixed | 须翻转 final sim | 列残余项 | **implemented_not_validated** |

---

## 三、最重要的实际分歧

### 1. 三方在不同 tip 互评(Claude 1 独立,最优先)
cache 工作只在 `1810309`;`final3(70c3904)` 等五个 `-final*/-fix/-budget` 分支是**独立 solver 延迟修复线,不含 discovery cache**。Codex 1 看对分支(cache 已落盘,他对),Codex 3 事实落在无 cache 分支(错)。**一切裁决先锚 `1810309`。**

### 2. Codex 3 两项事实错(源码推翻)
- "无 adapter 派生 topic/selector" → **错**:`eventTopics` 已 union,`callSelectors` 已由 scanner 遍历 descriptor 分发。
- "positive/negative 双 cache 没落盘" → **错**:cache path + 写入 + 启动日志实证落盘,链不匹配拒载。**真没落盘的是 cursor / routeOwnership / recentTxs**。

### 3. Codex 2 一项更正
retry 主判据是结构化 `.code`(CALL_EXCEPTION/BAD_DATA/INVALID_ARGUMENT),较可靠;仅 `isPermanentlyPrunedHistoricalState` 用 message 正则——**要类型化的是那一条**,不是整个 retry 分类。

### 4. 分期被否 → 仲裁可测性转成硬验收(Claude 1 独立)
技术事实:C1 只有 **1 个** dynamic adapter(erc4626)→ 多-adapter 仲裁 / 跨-pass 冲突 / fingerprint 去重 / 复合 projection **没有触发路径**;标准 erc4626 一 vault 一 pair,同址多 pair 也不触发。**用户否决分期 = 这些是核心、一次交付。核心但不可测比延后更糟,所以转为硬验收:验收套件必须含一个第二 dynamic adapter fixture(真实的,或 test-only 的 `ProtocolObservationCapability`),专门驱动多-adapter 仲裁、跨-pass A/B、同址多 pair、fingerprint 去重/隔离。** 无此 fixture,核心项 5/6/7 是 shipping-untested,不得记 validated。

### 5. 不等价多匹配是验证-松红灯,不是仲裁(Claude 1 独立)
两 adapter 对同一 semantic route 都完整过 attest+probe 却 fingerprint 不同 → 至少一个**放行了不该认领的合约**。响应 = 隔离 **+ 告警 + 收紧那个 adapter**,不是路由级 tie-break 了事。**仲裁频繁触发 = gate 太松**,不是缺更好的裁决器。

### 6. C2 第二证据是真缺口(同 Codex 3)
现 C2 无非零 burn/payout/返回值一致证明。verified-routes-only + 删 legacy 下**必须补** fork/revm 非零 redeem,否则 static seed 删不掉。

---

## 四、验收(升 `fixed` 的硬门,缺一不可)

1. 独立 cadence(protocol scanner 不挂 DEX timer);
2. cursor 重启恢复(kill 进程后从 `observedCursor+1` 补扫,不重扫全历史);
3. live observed + range scanner 同一 tx **只 trace 一次**(TraceMemo 命中计数);
4. 旧 evidence + 新同块矛盾 evidence → **拒绝**(不被旧遮蔽);
5. 已有 adapter A,下一轮发现 adapter B → 跨 pass 一起裁决(不互相看不见);
6. 同 target、不同 token pair → **共存**;
7. 同 semantic route、不同 execution fingerprint → **隔离 + 告警**;
8. **第二 dynamic adapter fixture**(§三.4)驱动 5/6/7 —— 无此 fixture 核心 5/6/7 记 untested;
9. retryable 失败**不撤边**、确定性失败**撤边**;
10. C2 非零 fork/revm redeem 第二证据;
11. 无 ERC4626 static seed(legacy 全删)后,**no-seed replay**:物理移除 legacy/`POOL_REGISTRY` seed → scanner 自发枚举 → identity/probe → edge 入图 → `path_found` → `final_sim_success`;
12. flag off + 有效 discovery = graph hash 不变。

**第 11 项翻转前,一律 `implemented_not_validated`。**

---

## 最终裁决(Claude 1)

保留总体架构。九项核心作为单一交付一次做完:独立调度+持久 cursor、跨入口 trace memo、每候选独立验证去 target-quarantine、evidence 同块优先级+漂移复检、post-probe 跨-pass ownership、全局 route 裁决、复合 projection、C2 非零 redeem 证据、legacy 全迁移。

Codex 2 未推翻架构;Codex 3 补出 cadence/cursor/跨入口 trace/C2 四个真缺口,但"无 adapter 派生 filter""双 cache 没落盘"两项与 `1810309` 不符(错拿 final3 判);Codex 2 retry-正则表述更正为 `.code` 主判据。

**Claude 1 独立追加三项**:① 三方须先统一到 `1810309`;② 多-adapter 仲裁可测性转硬验收(第二-adapter fixture);③ 不等价多匹配是验证-松红灯,非常规仲裁。

**P0 none**(flashloan 原子闭环 + final sim fail-closed + 蜜罐仅造假阳性无资金风险)。当前 **`implemented_not_validated`**。

本轮执行证据(真分支 `1810309`,`listener/` 内 npm 直跑):`searcher:erc4626-instance-discovery PASS`、`searcher:observed-protocol-discovery PASS`。

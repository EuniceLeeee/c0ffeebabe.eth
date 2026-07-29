# Adapter Family 扩展边界、实现合同与六步验收

> 状态：架构与验收合同；核心 family boundary gate 与 target-late 结果契约已在前置工具分支实现，仍不是某个 family 的完成报告。
> 实现基线：`origin/main@3c8a04b9c31960d39992d139a310f868edbe5631`。
> 日期：2026-07-29。
> 范围：新增 Swap / Protocol Adapter Family、V4/Ekubo 一类 hook/extension 例外，以及从开发到删除分支的验收生命周期。
> 不在范围：某一笔 Ekubo 交易的 ABI、地址、路径或盈利结论；具体实现必须另立 feature branch。

规范层级：[`CLAUDE.md`](../../CLAUDE.md) 和 [`gates.md`](gates.md) 仍是上位规则。本文件把本次架构裁决具体化，并诚实记录当前实现与上位规则之间尚未修复的缺口；不得用本文件的目标状态冒充当前代码已经具备的能力。

## 1. 目标

本合同解决三个问题：

1. 普通新增 Adapter Family 应是插件级改动，不修改中央运行语义。
2. 当 V4 hook、Ekubo extension 等确实需要扩展执行语义时，允许扩展，但不给它任意中央权限。
3. 开发期可以快速迭代；合并与删除分支仍必须分别通过可信的六步 checkpoint 和 deployed-main final validation。

核心原则是：

> **扩展点封闭，扩展实现开放。**

普通 family 只能实现既有 capability。现有 capability 确实无法表达需求时，必须先停止 family 实现，单独提出协议无关的 framework 升级；不得在 family 内私建调度器、缓存、枚举器或 solver 来绕过中央接口。

## 2. 非目标

本合同不要求：

- 用固定文件数或 LOC 代替正确性审查；
- 每个 hook 地址建立一个 family；
- 所有 extension 共用一种报价数学；
- 为了通过验收把 swap edge 标成 protocol edge；
- 让旧 Hermes/harness 覆盖或替代 canonical six-step receipt；
- 在 Adapter Replay 通过后就声称 `fixed`；
- 把协议特有字段直接加入中央 `TokenEdge`。

“插件级”表示行为边界和 source closure 受控，不表示机械限制为恰好两个文件。

## 3. 当前中央接口

### 3.1 通用 RouteLegAdapter

[`RouteLegAdapter`](../../listener/src/searcher/venues/route-leg-adapter.ts) 是 Swap 和 Protocol 的共同执行合同。

每个可执行 route family 都必须提供：

- `buildEdges(pool, backend, control)`：把已准入实例投影成统一 `TokenEdge`；
- `quoteExact(ctx)`：对确定方向和输入量做精确报价；
- `buildPlanFragment(ctx)`：把 route leg 编译为统一执行片段。

同时声明：

- `id`、`kind`；
- `poolAdapters`、`edgeAdapterIds`；
- `allowedTaxonomy`；
- `ownedActionAdapterIds`；
- `requiredInfraActionAdapterIds`；
- `identityPolicies`；
- `requiresProtocolEdgesFlag`；
- `prepared`。

以下是通用可选 capability：

- `routeIdentity`；
- `planExecutionIdentity`；
- `discovery`；
- `discoveryIdentityResolver`；
- `discoveryIdentityAuthority`；
- `livePoolState`；
- `oracleVictim`。

可选不代表可以随意省略。若实例不是静态声明或成熟 DEX universe 能可靠提供，生产准入就必须实现 discovery、反向身份验证和 active probe。

### 3.2 SwapAdapter

[`SwapAdapter`](../../listener/src/searcher/venues/route-leg-adapter.ts) 继承 `RouteLegAdapter<"swap">`，另外强制要求：

- `kind: "swap"`；
- `landedEvents`：family-owned 的落地区块事件声明；
- `observation`：把已识别事件转换为统一 swap observation；
- `victimModel`：victim/backrun 的统一策略声明；`detect-only` 是合法声明，但必须让 backrun replay/overlay fail closed，不能冒充已经支持 victim reproduction；
- `pricingState`：block-scan 状态读取和定价 capability。

可选：

- `matureDexUniverseDiscovery`；
- `poolDiscovery`。

因此一个正常 Swap family 的生产闭环是：

```text
identity / discovery
→ buildEdges
→ pricingState
→ scanner enumeration
→ quoteExact
→ buildPlanFragment
→ solver
→ final sim
→ EV
```

### 3.3 ProtocolConversionAdapter

[`ProtocolConversionAdapter`](../../listener/src/searcher/venues/route-leg-adapter.ts) 继承 `RouteLegAdapter<"protocol-conversion">`，另外强制要求：

- `kind: "protocol-conversion"`；
- `pricingState`；
- `declaredVenues`；
- `undeclaredVenueReason`。

Protocol 不强制 `landedEvents`、`observation`、`victimModel`，因为这些属于 swap victim/影响识别能力。

Protocol 有两种合法实例来源：

```text
静态实例
→ declaredVenues
→ buildEdges / pricingState / quoteExact / buildPlanFragment
```

```text
动态实例
→ discovery
→ discoveryIdentityResolver
→ probeCandidate（直接返回并验证动态 TokenEdge）
→ projection / pricingState / quoteExact / buildPlanFragment
```

同一个 family 可以同时拥有静态和动态实例，但两类实例的 provenance、source coverage 和 admission proof 必须分开记录；不得在动态 source 不完整时静默退回 `declaredVenues`，从而掩盖缺失。

`declaredVenues` 只能用于代码所有的基础设施 singleton 或明确静态 venue，不得退化为按样本累加的实例 allowlist。

`buildEdges` 仍是所有 `RouteLegAdapter` 的通用必备能力，用于静态/普通 graph construction；当前动态 discovery 路径的 `probeCandidate` 本身已经返回 verified edges，不应再描述为 probe 后重复调用一次 `buildEdges`。

### 3.4 Swap 与 Protocol 的合并点

Swap 和 Protocol 在进入 graph 后都产生统一 `TokenEdge`，并共享：

- graph identity；
- scanner route enumeration；
- exact quote；
- planner；
- solver；
- final sim；
- EV。

差异只应保留在 family 自己拥有的准入、状态读取、报价和执行编码中。中央 scanner/planner/solver 不应出现 Ekubo、ERC4626、Curve、V4 hook 等协议名分支。

### 3.5 Registry 与状态 Kernel

[`AdapterFamilyRegistry`](../../listener/src/searcher/venues/adapter-family-registry.ts) 是唯一高层生产注册源。下列 projection 必须由它派生：

- swap families；
- protocol families；
- discoverable route families；
- pricing lane families；
- landed-event registry；
- victim-model registry；
- landed-pool discovery registry；
- owned/shared ActionAdapter closure。

禁止为新 family 再建立第二张中央手写表。

状态层遵循相同边界：family 的 [`BlockScanStateCapability`](../../listener/src/searcher/venues/blockscan-state-capability.ts) 只声明：

- `stateKey`；
- static schema；
- current-block/dependent reads；
- state decode；
- `deriveMids`；
- 可证明不可执行的 terminal edge。

中央 coordinator 独占：

- I/O；
- scheduling；
- retry；
- deadline；
- batching；
- generation/CAS；
- publication。

`deriveMids` 必须同步、确定性、无 I/O。Family 不得在 `deriveMids`、decode 或 dependent-read builder 内偷偷访问 RPC、timer、scheduler 或全局 cache；对应测试必须使用 poisoned backend/ambient-I/O harness，而不是仅凭接口约定。

## 4. 普通新增 Family 的修改边界

### 4.1 正常允许

普通 Swap family 原则上只修改：

```text
listener/src/searcher/venues/swaps/<family>/**
listener/src/adapters/<family>.ts
listener/src/searcher/venues/production-registry.ts    # 薄注册
listener/src/adapters/index.ts                         # 薄 ActionAdapter 注册
listener/src/searcher/test/**                          # family 测试与 fixture
```

普通 Protocol family 原则上只修改：

```text
listener/src/searcher/venues/protocols/<family>/**
listener/src/adapters/<family>.ts
listener/src/searcher/venues/production-registry.ts    # 薄注册
listener/src/adapters/index.ts                         # 薄 ActionAdapter 注册
listener/src/searcher/test/**                          # family 测试与 fixture
```

`production-registry.ts` 和 `adapters/index.ts` 只允许：

- import 新 family / ActionAdapter；
- 在既有 catalog 中增加直接 binding；
- 保持既有中央控制流和 AST skeleton 不变。

### 4.2 正常禁止

普通 family branch 不得修改下列行为：

- `main` 和 runtime loop；
- scanner / DFS / changed-edge enumeration；
- graph dispatch；
- planner / plan selection；
- solver / sizing；
- final-sim gate；
- EV policy；
- state coordinator；
- deadline、cache、TTL、queue 和 scheduler；
- candidate cap、top-K、rank 或 ordering；
- submission / signing / broadcast；
- 其他 family；
- canonical evidence schema。

中央代码不得增加：

- family ID 判断；
- adapter ID 判断；
- 协议地址判断；
- selector 判断；
- 针对某个 venue 的 fallback。

### 4.3 Family 自己不得实现

Family 内禁止出现：

- 私有 block/head 调度器；
- 私有状态生命周期；
- 私有 TTL/cache 系统；
- 私有路径枚举；
- 私有 candidate 排名；
- 私有 solver；
- 私有 final sim；
- 绕开统一 graph/state/planner 的旁路；
- quote 失败后调用另一套未声明路径；
- 通过全局对象或 prototype 修改中央行为。

### 4.4 接口不足时的处理

以下情况说明现有接口不足：

- 必须向中央 `TokenEdge` 添加协议专属字段；
- 必须把复杂配置编码进字符串，再由多个中央模块解析；
- 必须在 planner/solver 中识别 family ID；
- 必须让 family 控制 scheduler、cache、rank 或 final sim；
- 必须借用另一个 family 拥有的执行 ActionAdapter；
- 必须让 canonical hash 忽略实际影响 quote/plan 的字段。

处理顺序必须是：

```text
停止 family 实现
→ 描述缺失的协议无关 capability
→ 独立 framework branch
→ cross-family 回归/必要时 Hermes cohort
→ capability 合入 main
→ 从新 main 重新切 family branch
```

不得为了保持“小改动”把中央复杂度隐藏进一个巨型 adapter。

### 4.5 Family Boundary Gate

上述边界必须成为机器 gate，不能只依赖 code review 或开发者自觉。

Gate 应在开发早期即可独立运行，并在 checkpoint 中再次强制运行。输入至少包括：

- 冻结的 `origin/main` baseline；
- candidate SHA；
- production family ownership manifest；
- registry/action catalog skeleton；
- family source closures；

输出必须是结构化结果，但核心 gate 只做两类判断：

```text
classification:
  family_local
  | framework

impacted_family_ids:
changed_runtime_files:
reasons:
required_action:
```

判定规则：

| 发现 | 分类 | Gate 动作 |
|---|---|---|
| 仅 family source closure + 薄注册 | `family_local` | 允许继续 family 开发 |
| 修改中央 capability/interface/hash | `framework` | 非零退出，停止 family 自证 |
| 修改多个既有 family 共享 host | `framework` | 非零退出，移到独立 branch |
| 修改 scanner/rank/cap/deadline/queue/cache | `framework` | 非零退出，移到独立 branch |
| family 修改中央 mutable runtime | `framework` | 非零退出，报告具体路径 |
| 协议专属字段进入中央 graph/planner | `framework` | 非零退出，要求协议无关 capability 设计 |
| registry/catalog 超出薄注册 skeleton | `framework` | 非零退出 |

Gate 发现越界后必须执行的流程动作：

```text
停止在当前 family branch 继续堆实现
→ 输出 exact changed files / findings / missing capability
→ 将中央改动从 family diff 中拆出
→ 将 family 外改动移到独立 branch
→ 该独立 branch 按自己的风险使用现有验收
→ 先合入 main
→ 从新 main 重新创建或重放 family-local diff
```

Gate 不应自动删除用户代码或重置分支；它负责 fail closed、保留现场并给出确定的拆分动作。

实现使用同一个纯函数 `evaluateAdapterFamilyBoundary`：

- 开发期由 `adapter-family-boundary-gate` CLI 调用；
- checkpoint 在任何 RPC、universe 读取和 producer 之前调用；
- 两处都只从 registry-derived ownership manifest、source closure 和两张薄注册表的 skeleton 得出结论；
- `framework` 非零退出，并输出 exact runtime paths 与 reasons。

这道核心 gate 不再细分 `systemic_live`，也不实现一套庞大的 AST 安全框架。标准 `SwapAdapter` / `ProtocolConversionAdapter` 类型、ownership manifest、source closure、薄注册 skeleton 和正常 code review 共同约束 family；若日后有真实绕过样本，再在独立工具 branch 增加协议无关规则。

## 5. Hook / Extension 的例外模型

### 5.1 不新增全局 HookFamily

不建议增加：

```ts
AdapterFamilyKind = "hook";
```

原因：

1. Pool adapter、edge adapter 和 ActionAdapter 当前都要求单 owner。
2. 顶层 HookFamily overlay 另一个 family 会产生 ownership 冲突或注册顺序语义。
3. 若放宽 owner 约束，hook 就可能绕过 host 的身份、状态、plan 和安全边界。
4. 一个全局任意 callback 会把中央 scheduler、graph、planner 暴露给协议扩展。

推荐模型：

```text
V4 / Ekubo host
  └─ host-local、受限的 variant spec
       ↓
host factory 组合
       ↓
registry-visible 的完整 SwapAdapter composite
```

逻辑上它是 host-local subfamily；注册层仍是标准 `SwapAdapter`。

### 5.2 Family 粒度

一个 composite 对应一种经过验证的执行语义，不对应单个地址：

```text
custom-swap:ekubo-base
custom-swap:ekubo-extension-x
custom-swap:univ4-hook-x
```

当前 `SwapExecutionFamilyId` 的扩展命名空间是 ``custom-swap:${string}``。若要新增另一种顶层 `swap:*` namespace，本身就是中央类型/framework 变更，不能混在普通 family branch。

下列变化通常需要不同 composite：

- quote 入口不同；
- mutation/state source 不同；
- settlement/forward 模式不同；
- hookData schema 不同；
- token conservation 语义不同；
- ActionAdapter 编码不同。

仅地址不同但语义完全相同的实例应由同一 family 的 discovery/identity 处理。

Registry-visible composite 不能复用 host 的同一个 `poolAdapter` / `edgeAdapterId`。合法选择只有两种：

1. 一个 host `SwapAdapter` 在内部对已验证 variant 做 typed dispatch；或
2. 每个独立 composite 使用自己的 branded `poolAdapter`、`edgeAdapterId` 和 route-root ActionAdapter ID。

本合同推荐第 2 种，因为 source completeness、ownership 和失败域都能独立表达。例如物理 target 可以相同，但 materialized pool/edge 的逻辑 owner ID 必须是 variant-specific，且 identity arbitration 对一个实例只能选出一个 owner。

若希望多个顶层 composite 共用同一 pool/edge ID，就必须修改当前单-owner 模型，属于 framework change。

### 5.3 最小权限 spec

推荐的 host-local 形态：

```ts
interface HostLocalSwapVariant<Key, Snapshot, Intent> {
  readonly hostId: string;
  readonly variantId: string;
  readonly semanticsVersion: string;

  classify(
    key: HostAttestedKey<Key>,
  ): "supported" | "not-applicable";

  readonly pricing: HostScopedPricing<Key, Snapshot>;

  quoteExact(
    ctx: HostScopedQuoteContext<Key, Snapshot>,
  ): Promise<bigint>;

  buildSwapIntent(
    ctx: HostScopedPlanContext<Key>,
  ): Intent;
}
```

该 spec 只能：

- 消费 host 已反向验证的 pool key / extension identity；
- 声明 host 认可的 mutation/state source；
- 读取 host 绑定到 source block 的状态；
- 计算精确 quote；
- 返回 host 定义的 typed intent。

典型 intent 字段可以包括：

- `hookData`；
- `forwardMode`；
- swap direction；
- amount limit；
- host 允许的 callback 参数。

### 5.4 明确禁止的权限

Variant spec 不得：

- 返回任意 `PlanFragment`；
- 自行指定任意 target；
- 自行指定 ActionAdapter ID；
- 自行创建 requirements / children；
- 访问 `AdapterFamilyRegistry`；
- 访问 scanner、scheduler、planner、solver；
- 改 candidate cap、rank、top-K；
- 改 final-sim 或 EV gate；
- 自行发布 graph；
- 自行持久化跨块状态；
- 使用未知 extension 时回退到 base 数学。

Host 负责：

- identity binding；
- edge identity；
- route taxonomy；
- target 和 pool identity；
- plan wrapper；
- settlement；
- transfer / wrapping；
- ActionAdapter ownership；
- conservation metadata；
- canonical evidence。

### 5.5 Unknown extension

未知 extension 必须：

```text
identity candidate
→ unsupported semantics
→ RouteInstanceNotApplicable
→ 仅隔离该实例/variant
```

禁止：

- 假设它与 base pool 同报价；
- 只凭地址或 selector 准入；
- 把 unknown hook 作为普通池；
- 因一个 unknown extension 把整个 host family 标为 incomplete。

### 5.6 V4 的当前边界

当前 `univ4-standard` 明确排除会影响 swap 的 hook；低层 V4 ActionAdapter 还使用固定空 `hookData`。因此：

- 删除 `v4HooksAffectSwap` 检查不等于支持 hook；
- 在现有 `univ4-standard` 中持续增加 hook 地址分支不可接受；
- hook-aware 语义必须成为独立 composite；
- 迁移共享 V4 host factory 会影响现有 family，必须按 multi-family/framework 处理；
- 单独新增一个 host 文件不变的 variant，才可能保持 family-local。

### 5.7 Ekubo 的应用

Ekubo pool config 包含 extension 和执行配置。Extension 可以影响 swap 前后行为、报价入口与 forward 方式，因此：

- 不能假设所有 Ekubo pool 都共享 base quote；
- discovery 必须解析 pool key/config；
- identity 必须验证 Core/registry/extension 关系；
- variant 必须声明完整状态依赖；
- ActionAdapter 必须匹配真实执行入口；
- unknown config 必须 fail closed。

实现 Ekubo 时优先复用标准 `SwapAdapter`，而不是先新增中央 hook kind。

## 6. Ownership、Canonical Identity 与失败隔离

### 6.1 唯一 owner

每个 composite 必须独立拥有：

- `family.id`；
- `poolAdapters`；
- `edgeAdapterIds`；
- route-root `ownedActionAdapterIds`；
- source coverage；
- family source closure。

禁止两个 family 共享同一个 pool/edge owner。

同一个物理 Core/manager 地址不等于共享逻辑 owner。Composite 必须用 attested variant identity 投影到唯一 branded pool/edge ID；不能依赖 registry 顺序决定由哪个 family 接管。

### 6.2 ActionAdapter

Route-root 执行编码器必须属于该 family 的 `ownedActionAdapterIds`。

`requiredInfraActionAdapterIds` 只允许真正共享、ownerless 的基础动作，例如经过中央预声明的 transfer/approve 类 infra。不得把 Ekubo/V4 swap encoder 伪装成 infra，从而借用另一个 family 的执行权限。
反方向同样禁止：只要某 ActionAdapter 被任一 family 声明为 required shared infra，就不能再被任何
family 声明为 owned。候选把既有 `erc20-transfer` 一类 shared infra 重新包装成自己的 route root，
boundary 必须输出 `framework` 并停止。

### 6.3 Canonical metadata

Claim-relevant 数据必须 hash-bound，但不应全部塞进 `TokenEdge`。需要分成两层。

Route/execution identity 层承载生产下游确实需要读取的 immutable execution fields：

- token pair；
- logical pool/variant identity；
- 影响 quote/plan 的 extension/hook 配置；
- execution target；
- callback permission；
- hookData schema/version；
- plan compatibility；
- safety/conservation。

这些字段进入 typed `TokenEdge`、family state schema或 canonical execution identity，取决于实际消费位置；不得用 opaque metadata 绕过类型。

Admission/provenance 层承载：

- reverse-identity registry/factory proof；
- implementation/codehash proof（当该 family 的 identity contract 声明它为 invariant 时）；
- callpoint/selector observation proof；
- source watermark/coverage；
- active probe receipt。

这些证据进入 Step 1 identity/admission/shard artifact 及其 hash，不要求无条件复制进每条 `TokenEdge`。

无论属于哪一层，任何会影响以下结论的数据都必须进入 schema-owned、canonical、hash-bound 输出：

- admission；
- token pair；
- extension/hook identity；
- callback permission；
- quote；
- execution target；
- hookData schema；
- plan compatibility；
- safety/conservation。

不得把这些字段放进：

- diagnostics-only `extensions`；
- 未参与 canonical hash 的 opaque object；
- 未深度冻结的 `TokenEdge` 任意 metadata；
- 只在日志中存在的字符串。

只有当一个新的字段确实需要被跨 family 的生产下游读取、且现有 typed identity/state/plan schema 都无法表达时，才做协议无关的 `TokenEdge` framework 升级。单纯 admission provenance 不得成为膨胀中央 edge schema 的理由。

### 6.4 失败域

失败至少区分：

- instance-local；
- variant/family-local；
- shared infrastructure；
- global framework。

默认规则：

| 失败 | 影响范围 |
|---|---|
| 一个 pool key/config 不适用 | 该实例 |
| 一个 extension probe 失败 | 该实例/variant |
| variant state source incomplete | 该 variant |
| family resolver 自身整体损坏 | 该 family |
| trusted RPC/journal/framework 失败 | 显式 infrastructure/global |

一个 hook/extension 的 retryable error 不得清空同 host 下已健康 composite 的 graph 或 pricing state。

## 7. Source Closure 与静态边界

Family implementation 和其同目录相对 import 应进入 family source closure。推荐目录：

```text
listener/src/searcher/venues/swaps/ekubo/
  host.ts
  identity.ts
  state.ts
  variants/
    base.ts
    extension-x.ts
  family-base.ts
  family-extension-x.ts
```

ActionAdapter：

```text
listener/src/adapters/ekubo.ts
```

Import closure 只证明依赖关系，**不能给 candidate 授予新的编辑权**。某个 baseline 已存在、
但此前不属于该 family 的 runtime 文件，即使被 candidate 新增 import 后出现在 manifest，
仍分类为 `framework`。Candidate 新建的 runtime 文件只允许位于
`venues/{swaps,protocols,credit,funding,liquidity}` 的该 family 路径或该 family 的
`src/adapters/` 路径；中央 scheduler/planner/solver/runtime 文件不能靠“纳入 closure”变成
family-owned。

既有 family 的 `kind`、`root_source`、`root_export` 是稳定身份，candidate 不得靠重命名它们
扩大 supplemental test/doc 的命名权限。Supplemental 路径只使用稳定 family ID 派生 token；
新 family 不得认领 baseline 已存在的测试文件。`production-replay`、`blockscan-hunt`、
ownership manifest、Adapter Replay 与 execution witness 等 trusted TCB 路径无条件排除，不能
因为文件名恰好包含某个 candidate-controlled token 就变成 family-owned；这些保留项按稳定
入口/helper 前缀族匹配，避免先新增同名 family、下一次提交再认领既有 trusted helper 的
两阶段洗白。

Family 根导出应保留显式静态 ID，便于 ownership manifest 的 AST producer 读取：

```ts
export const EKUBO_EXTENSION_X = Object.freeze({
  ...makeEkuboComposite(EKUBO_EXTENSION_X_VARIANT),
  id: "custom-swap:ekubo-extension-x",
}) satisfies SwapAdapter;
```

不建议只写：

```ts
export const EKUBO_EXTENSION_X =
  makeEkuboComposite(EKUBO_EXTENSION_X_VARIANT);
```

因为当前 manifest producer 未必能从任意 factory call 静态解析 family ID。

### 7.1 核心门的有意边界

本次 gate 只机械保证用户要求的两件事：

1. family runtime 改动归属于唯一 family，中央文件只允许既有薄注册；
2. family 继续实现标准 `SwapAdapter` / `ProtocolConversionAdapter` capability，不修改中央接口或共享生产行为。

它不宣称能静态证明任意 TypeScript 都无恶意副作用。出现 prototype/global mutation 一类非常规实现时由正常 review 拒绝；不要为了假想攻击把普通 adapter 开发变成另一套编译器工程。

## 8. 实现顺序

### Phase 0：先修可信验收基础

在任何 Ekubo feature branch 之前，先独立完成：

1. 修复 target-blind producer/comparator；
2. 修复纯 DEX graph 的 protocol-only harness 假设；
3. 把 Step 1 改成 route-required shard completeness，而不是“图必须增长”；
4. 将同一个核心 family boundary evaluator 接入开发期 CLI 和 checkpoint preflight。

这些是 trusted tooling/framework 变更，不能由 Ekubo branch 修改并自证。

### Phase 1：建立 family skeleton

只完成：

- family ID；
- pool/edge adapter IDs；
- taxonomy；
- ActionAdapter ownership；
- explicit registry/catalog binding；
- source closure；
- unsupported-by-default 的 variant registry。

验收：

- registry 唯一 owner；
- 未支持 extension fail closed；
- 没有中央行为 diff；
- family activation gate 通过。

### Phase 2：Identity 与 Discovery

实现：

- landed event/call selector 候选；
- pool key/config 解码；
- on-chain reverse identity；
- extension/registry/Core 绑定；
- active probe；
- pool materialization；
- source coverage。

地址和 selector 只能提名候选，不能替代反向身份验证。

验收：

- 正样本能生成正确 instance；
- 错 target/selector/config 被拒绝；
- 当 family 的 reverse-identity contract 明确声明 implementation/codehash invariant 时，mismatch 被拒绝；否则使用 registry/factory/on-chain interface proof，不得新增实例 codehash allowlist；
- unsupported extension 不影响 supported sibling；
- historical source window 能独立发现目标 edge。

### Phase 3：State 与 Quote

实现：

- family-owned `pricingState`；
- source-block pin；
- mutation/source 声明；
- exact `quoteExact`；
- local/prepared/on-chain quote 的明确策略；
- 无隐式 fallback。

验收：

- state key 与 edge identity 一致；
- N 或声明的 production fallback anchor 一致；
- quote 与链上独立 oracle/parity 一致；
- state source incomplete 不伪装为零报价；
- unknown extension 不能退回 base quote。

### Phase 4：Plan 与 ActionAdapter

实现：

- host-scoped swap intent；
- host wrapper；
- route-root ActionAdapter；
- execution target、ABI、参数关系与 pool identity；
- settlement/transfer/wrapping；
- plan execution identity；
- conservation。

验收：

- edge owner 与 action owner 一致；
- exact quote 的语义与 plan calldata 一致；
- hookData/forward mode 进入 canonical execution identity；
- 零预存 route-token balance 下 final sim 成功；
- revert 被分类为 family domain 或 infrastructure，不靠错误文本猜测。

### Phase 5：Production Funnel

证明自然路径：

```text
source / identity
→ graph
→ scanner enumeration
→ exact refine
→ planner
→ solver
→ mandatory final sim
→ production EV
```

不得把 expected route、pool、token、amount 或 route hash 注入：

- discovery；
- graph；
- enumeration；
- pruning；
- ranking；
- solve selection；
- sizing。

## 9. Target-late 结果契约

### 9.1 已实现的 producer / verifier 分离

同一套 canonical six-step lifecycle 现在复用如下结果契约，不建立第二套六步 schema：

```text
candidate producer argv/env 不含 winner tx、reference route、target pool 或 target amount
→ 自然运行完整 graph / enumeration / refine / top-K solve
→ 冻结 natural top-K、hop amounts、raw calldata、calldata hash 和 required shard proof
→ producer 退出
→ controller 对同目录 pending artifact 执行 file fsync
→ rename 为只读 sealed artifact并 fsync directory
→ 此后才把 winner tx 与 rollback/main-owned reference 交给 verifier
→ rollback/main verifier 匹配冻结路线
→ 在新 fork 执行冻结 raw calldata
→ 重算 funding holder、final-verify、phantom-profit、standing、零库存/偿还和 EV
→ target trace 与 final-sim trace 都由同一个有限声明式 ReferenceWitness 解释
→ witness 绑定 ABI、token 方向、pool identity、参数关系、receipt transfer 与父子调用分支
→ final-sim 每条腿的 root calldata 必须逐字节等于 solver-selected resolved subtree 的编译结果
→ verifier 后再次校验 sealed artifact/reference hash 未变化
```

Reference artifact 必须在 adapter candidate 的 `rollback_commit` 中已存在并经过人工语义审查；family branch 不能新增或修改它。它绑定：

- target receipt + call trace 的 canonical SHA；
- parent block/hash/state root；
- normalized ordered route 与 route SHA；
- 每个 route leg 的 execution identity 与有限声明式 `ReferenceWitness`。

`ReferenceWitness` 只允许固定 schema 的 ABI/参数/调用层级/receipt-transfer 关系，不执行任意代码，
也不得退化为 bare `target + selector`。每条腿必须同时绑定 `token-in` 与 `token-out`；当
`poolId !== execution target` 时还必须显式使用 `pool-id`。final sim 另以 producer 冻结的
`executionSurfaces[]` 验证每条腿的 selector 和完整 calldata SHA；该 calldata 来自真实
solver-selected resolved-plan subtree，包含 selected amount 与 child bytes。

每个 execution surface 还冻结：

- family-owned `rootActionAdapterId`；
- ordered `subtreeActionAdapterIds`；
- subtree 实际产生的全部 external call target/selector/calldata SHA；
- funding wrapper 下未归入 route subtree 的 support action IDs 与实际 external calls。

trusted controller 用 candidate ownership manifest 重算：route root 必须由对应 family owned；
subtree 其余 action 只能是同 family owned，或该 family 显式 required 且全局 ownerless 的 shared
infra。未归属 sibling 只允许 declared、ownerless support action；它实际产生的每个 external
call 都必须在 target trace 被某条有限声明式 route witness 覆盖，并在 final sim 完整 calldata
byte-match。不能把 `tokenIn === tokenOut` 当作“无价值变化”，ERC-20 transfer 也必须绑定。
foreign owned action、额外 owned sibling、未声明或未绑定的 support call、non-wrapper 的 ignored
child 都直接失败。由于当前生产 `PlanFragment.nodes[]` 不保留逐 leg provenance，多 sibling
family-owned fragment（例如一条 leg 用两个并列的 family node）会保守 fail closed；需先在独立
协议无关 capability branch 保留 fragment provenance，不能在 gate 猜测 sibling 属于哪条腿。
后一条逻辑 route leg 也不得借用前一条 route root 的 descendant internal call 充当自己的 root。

此外，boundary 判定出的唯一 changed family 必须实际出现在 selected route 的
`requiredFamilyIds` 中。只改 family B、却用既有 family A 的自然路线与 reference 来过门会被拒绝。

当前标量 `pool-id` 可直接表达 address/bytes32 参数。若某协议只把 pool identity 藏在嵌套 tuple
中，或必须由 tuple 派生（Ekubo PoolKey 属于此类），本 gate 会 fail closed；必须先在独立的、
协议无关 capability branch 扩展有限 witness schema，不能在 family 内写 Ekubo 特判绕过。

Family branch 同样不得修改：

- controller；
- producer；
- hunt runner；
- semantic schema；
- trusted reference；
- verifier。

Producer 启动前会从 disposable candidate worktree 删除
`docs/research/references/production-routes`，rollback verifier worktree 只在 producer 退出并 seal 后创建。
这缩小了普通误读面，但不是安全沙箱：candidate 仍共享 repository Git object database，并持有可读取
archive RPC 的 transport。

纯 swap 路线是合法输入；`blockscan-hunt` 不再把“图里必须有 protocol edge”当作全局验收前提。Step 1 的 completeness 只对最终选中路线的 required family shards fail closed，其他 family 的局部不完整保持隔离。

Rollback 与 candidate producer 都必须记录实际 scanner completion。任一边出现
`budget_exceeded`、rank 不完整或 exact-refine deadline，整份 checkpoint 失败；不得把冷启动时的
预算截断当成 baseline “没有路线”。两边还要在 producer 内对 universe、universe manifest 和
精确 runtime JSON key→SHA 集合在 hunt 前后重算，并由 verifier receipt 与 controller 预期值
共同绑定。

`rankComplete` 是现有 receipt 的历史字段名，精确含义是：在冻结的生产配置与生产 cap 下，
scanner 正常走到策略终点，没有 deadline、强制注入或未完成 refine；它**不表示穷举完整图的所有
路径**。生产 DFS 的 `maxPaths` 属于被冻结的生产策略。候选仍必须自然进入该策略的 top-K 并通过
final sim；验收结论只覆盖“生产策略输出已翻转”，不得写成“全图穷举完成”。

### 9.2 证据强度限制

这套隔离是 **explicit-input target-late isolation**：目标值不会通过 argv/env/reference 进入自然 producer。它不是恶意 candidate-source 隔离；candidate 作者理论上仍可把一个公开样本常量硬编码进自己的 family 实现。

同样，0400 文件与 producer 前后重哈希用于捕获正常代码的输入漂移，不是不同 UID / mount
namespace 的 hostile-code sandbox；同 UID 恶意代码临时替换后恢复文件不在当前结论范围内。

因此：

- 对开发前已经公开、反复使用的交易，只能称为已知样本回归证据；
- 不得仅凭公开样本把“泛化捕获能力”写成已证明；
- candidate SHA 冻结后再选 held-out 样本，单独看仍不足以证明泛化，因为当前 producer 仍可读 Git object 与 archive RPC；
- 强泛化证据需要未来的 hidden reference、source filesystem isolation 与 source-block-limited RPC isolation；当前 gate 不签发这一结论；
- `fixed` 的既有要求不变：scanner 自发枚举、mandatory final sim、production EV、合并后 exact deployed-main full final 全部通过。

## 10. 三类验收轨道

### 10.1 Family Execution

目的：证明 family 自己的 quote、plan、execution 可运行。

主要工具：

- unit/parity 测试；
- Adapter Replay；
- family fixture；
- ActionAdapter/compiler 测试。

Adapter Replay 可以支持 Steps 3–6，但它是 route-pinned，不能证明 Steps 1–2，也不能授权合并或删除分支。

### 10.2 Production Route Stage

目的：证明 production scanner 自发发现并推进目标历史路线。

必须使用修复后的 target-blind canonical six-step：

1. source / decode / identity / admission / graph；
2. natural route enumeration；
3. state + exact quote；
4. planner + solver + sizing；
5. independent mandatory final sim；
6. production EV。

只有该轨道能支持确定性 route/family 的 `checkpoint_pass` 和 `final_validated`。

### 10.3 Family 外生产变化

以下改动不属于 family-local deterministic route：

- scheduler；
- latency；
- queue/cache/TTL；
- candidate cap/rank；
- scanner algorithm；
- cross-family state distribution；
- resource use；
- live submission/inclusion。

核心 family gate 不再给它们细分标签，只输出 `framework` 和 exact paths/reasons，并要求移到独立 branch。独立 branch 再按实际风险复用项目已有的确定性 gate 或 live cohort；不能借一笔六步 replay 自证延时/提交类结论。

## 11. 开发、合并、部署与删除分支

### 11.1 开发期快速循环

允许使用：

- 当前 production live graph / verified graph view；
- 当前 live 的 per-family/per-source completeness；
- 当前 priced state / quote snapshot；
- enumeration / solver 异步诊断日志；
- typecheck；
- family unit tests；
- identity/probe fixture；
- quote parity；
- ActionAdapter/compiler tests；
- Adapter Replay；
- 复用 content-addressed universe/shard 的 checkpoint 输入。

“轻量”只表示复用已有、可验证、内容寻址的输入和基础设施，不表示跳过六步语义。

Live graph 在开发期非常有价值，可以快速判断：

```text
目标 pool/instance 是否已存在
→ 目标方向 edge 是否进入 graph
→ family/source shard 是否完整
→ state key 是否 resolved/priced
→ route 是否被自然枚举
→ solver 是否收到该 route
```

但必须给它正确的证据等级：

| Live 观察 | 可以证明 | 不能证明 |
|---|---|---|
| 当前 A/main graph 无目标 edge | 定位 baseline graph/admission gap | candidate 已修复 |
| 当前 A/main graph 已有目标 edge | baseline 不再是单纯 graph gap | route 会被枚举/执行 |
| 隔离 dry-run B graph 出现 candidate edge | candidate implementation 能 materialize edge | deployed main 已修好 |
| Live enumeration 日志出现目标闭环 | scanner 在该运行中枚举过 | mandatory final sim/EV 通过 |
| Live solver/final-sim telemetry 完整 | 定位 funnel 到达阶段 | canonical exact-SHA final 已通过 |

因此开发循环可以是：

```text
当前 live graph/telemetry 定位
→ family code + unit/parity
→ isolated dry-run/Adapter Replay
→ target-blind checkpoint
```

checkpoint 不是只跑 candidate。trusted controller 先在完全相同的 anchor、universe、runtime
inputs、production caps 上运行并封存 rollback producer/verifier receipt，要求 rollback 在 step 6
之前失败；再运行 candidate 并要求六步全过。若 rollback 已经全过，comment/no-op 或同 family
无关 action 改动不得借成熟路线领取 checkpoint。final 对 deployed merge 重跑 candidate，同时
再次绑定同一 rollback failure。
当前 controller 只接受“自然输出中没有目标 route”或“已自然枚举但未 solve”的 rollback failure。
若 baseline 已进入 solve/final sim/EV，必须先有能区分确定性 EVM/domain failure 与 RPC/infra 的
typed witness；仅靠错误字符串一律 fail closed。

查 live graph 不要求先重建 universe；若已有目标区块的 content-addressed graph/view/pin，优先复用。只有现有 graph 不能回答目标 edge 在当时是否存在、证据冲突或 hash/anchor 不可验证时，才升级重建。

任何 live 诊断结果都必须标记为：

```text
diagnostic_only
```

不能单独写成 `checkpoint_pass`、`final_validated` 或 `fixed`。

### 11.2 Pre-merge checkpoint

Checkpoint 必须：

- 运行完整六步；
- 使用 production caps、阈值、排序和 policy；
- target-blind；
- 绑定 candidate SHA；
- 绑定 state anchor；
- 绑定 universe/manifest/graph；
- 绑定 family source closure；
- required family shards 完整；
- scanner 自发枚举目标 route；
- final sim 成功；
- production EV allow。

成功结果是：

```text
checkpoint_pass
```

它只授权：

- 合并到 main；
- 在既有安全 envelope 下部署。

它不授权：

- 宣布 `fixed`；
- 删除 branch。

### 11.3 Post-merge full final

合并并启动 deployed main 后，必须针对：

- 实际运行的 exact merge SHA；
- normalized effective config；
- content-addressed full universe/manifest；
- exact production caps；
- before/after runtime attestation；
- independent review；
- 所有 mechanically impacted families；

重新运行完整六步。

合并前必须重新获取最新 `origin/main`，对同时发生的 adapter、registry、identity/discovery、quote、
plan/encoding 和测试改动逐文件做语义审查。不得用 `ours`、`theirs`、盲目 cherry-pick 或仅以“无文本
冲突”为完成标准；若另一个改动修复了同一 capability，应合并不变量与测试、删除重复实现，并在
整合后的实际 candidate SHA 上重新运行 family boundary gate、受影响 family 测试和 checkpoint。

成功结果是：

```text
final_validated
```

只有这一步允许把 deterministic route/family 声明为 `fixed`。

### 11.4 Branch cleanup

分支清理必须：

1. 保留 candidate branch 到 final validation；
2. 重新生成可信 final receipt；
3. 移除 clean candidate worktree，并确认待删 branch 不是当前分支、也未被任何 worktree checkout；
4. 从另一个 trusted checkout 调用 finalizer；
5. 验证 local/remote ref 仍精确指向 receipt 绑定的 tip；
6. 使用 exact lease 删除；
7. 任一 SHA/ref/worktree/receipt 不一致则停止。

不得用：

- 单元测试；
- Adapter Replay；
- checkpoint；
- 人工口头确认；
- 旧 harness pass；

替代 `final_validated`。

## 12. Hermes 与旧 Harness 的关系

普通 family-local 改动在 canonical checkpoint/final 完整后，不需要由旧架构 Hermes/harness 再次授权。

旧 harness 可以作为诊断，但只有在以下条件全部成立时，它的无关失败才不阻塞：

- canonical receipt 覆盖当前声明的全部性质；
- fresh non-author review 证明旧失败与该性质无关或属于同 fingerprint harness defect；
- 不涉及 state anchor、SHA、config、repayment、conservation、standing、wallet/signing 等硬安全项。

下列情况仍必须走 Hermes/systemic：

- 新增中央 capability；
- 修改 scanner/planner/solver/coordinator；
- 修改 candidate distribution；
- 修改 latency/resource 策略；
- 修改多个既有 family 共享的 host factory；
- 修改 canonical identity/hash；
- 修改 live submission。

## 13. 验收矩阵

| 场景 | 必须结果 |
|---|---|
| `Ekubo → Ekubo → UniV3`，三条均为 swap | 可走六步，不要求目标 route 含 protocol edge |
| Ekubo 实现 quote/plan，但没有所需 discovery | Step 1 失败 |
| Mature UniV2/UniV3 纯 DEX 路线 | 不因整张图缺 protocol edge 失败 |
| Swap + Protocol 路线 | 目标 swap/protocol family shards 都必须完整 |
| 图中存在无关 protocol edge，目标 route 错误 | 不得通过 |
| Unknown Ekubo extension | instance/variant fail closed |
| 一个坏 extension + 一个健康 extension | 坏实例不得清空健康 composite |
| Candidate 修改 producer/controller/comparator | checkpoint 前拒绝 |
| Family 顶层修改 registry prototype | checkpoint 前拒绝 |
| Route-root ActionAdapter 被声明为 infra | ownership gate 拒绝 |
| Hook identity 只存在 diagnostics extensions | canonical evidence gate 拒绝 |
| 目标 route 被枚举但未自然进入 refine/top-K | Step 3/4 `not_reached`，不得强行追加 |
| Solver 找不到可执行 amount | Step 4 失败 |
| Internal solver sim 全 revert | Step 4 失败 |
| Resolved plan 的 mandatory final sim revert | Step 5 失败 |
| Final sim 正利润但 production EV 拒绝 | Step 6 失败 |
| 目标 route +EV，但另一自然 route 被选中 | 不得把另一 route 冒充目标 |
| Unrelated family shard incomplete | 记录隔离，不连坐未使用它的目标 route |
| Required family shard incomplete | Step 1 失败 |

## 14. 必须新增的负向测试

### 架构门

- duplicate family ID；
- duplicate pool adapter owner；
- duplicate edge adapter owner；
- duplicate owned ActionAdapter；
- route-root ActionAdapter 伪装 infra；
- unowned/shared runtime path；
- 中央 registry/action index 超出薄注册 skeleton；
- 多个 family source closure 同时变化；
- unknown extension 回退 base quote。

### Discovery/Identity

- 错 selector；
- 错 target；
- 错 Core/registry；
- 错 pool key/config；
- extension code/registry proof 不一致；
- source window 未发现 instance；
- retryable instance failure 不污染 sibling；
- family-global resolver failure 正确标记。

### Target-blind 六步

- producer argv/env 不含 winner/reference/expected oracle；
- controller 只在 producer 退出并完成 fsync/rename seal 后调用 verifier；
- verifier 前后 producer/reference artifact hash 不变；
- rollback baseline 已自然通过六步时失败；
- baseline receipt/artifact 未与 candidate 使用同一冻结输入或未被 receipt hash 绑定时失败；
- target 不在自然 route set 时失败；
- target 在 enumeration 但不在 natural solve set 时失败；
- changed family 不在 selected route required-family set 时失败；
- route-root ActionAdapter 为 ownerless infra 或其他 family owned 时失败；
- resolved subtree 含 foreign action 或未归属 owned sibling 时失败；
- ownerless support external call 未被 target witness 覆盖或 final bytes 不同即失败；
- target/final trace 只有正确 target+selector、但参数或 token 方向错误时失败；
- 两个 sibling branch 拼成的伪路线失败；
- 后一条 route root 借用前一条 root 的 descendant call 时失败；
- 同一个 physical trace call 或 receipt Transfer log 被两个规则或两个 route leg 重复消费时失败；
- reverted/failed call 不参与 witness；
- `poolId !== target` 却没有显式 `pool-id` 绑定时失败；
- final-sim root calldata 与 solver-selected resolved subtree 不同即失败；
- funding action 无法由 rollback/main registry 重算 holder 时失败；
- profit token 不是闭环首尾 token 时失败；
- pure dynamic swap route 正向；
- mature DEX-only route 正向；
- swap + protocol route 正向；
- 图中无关 +EV route 不能代替目标；
- feature branch 修改 trusted surface 时失败。

### Lifecycle

- checkpoint 不能清理 branch；
- final 必须绑定 exact deployed merge；
- runtime/config/universe 任一漂移时失败；
- independent reviewer 不独立时失败；
- local/remote ref lease 漂移时不删除；
- semantic failure 保留 branch；
- infrastructure failure 保留 branch 等待重跑。

## 15. 当前实施状态与剩余边界

前置工具分支已实现：

1. 开发期 CLI 与 checkpoint 共享的核心 family boundary evaluator；
2. preflight 在 RPC/universe/producer 之前 fail closed；
3. candidate target-blind producer 与 rollback/main target-aware verifier；
4. producer artifact 的 durable seal 与 verifier 前后不可变复核；
5. natural top-K、raw calldata、required shard、final sim、还款/零库存、EV 的结果绑定；
6. pure swap graph 不再被 protocol-edge 全局条件拒绝。

仍不能声称完成的部分：

1. 这条工具分支尚未合入 `origin/main`；
2. 每个验收样本仍需在 adapter branch 之前，把人工审查的 trusted reference artifact 提交到 main；
3. 尚未针对 Ekubo candidate 实际跑出 checkpoint/final receipt；
4. 已公开样本只证明 explicit-input target-late 回归，不证明恶意 source isolation 或泛化；
5. Ekubo 的 identity/state/quote/plan/canonical extension identity 仍属于后续纯 family branch；
6. `fixed` 仍必须等 exact deployed-main full final。

因此当前状态只能写：

```text
architecture_contract = implemented_in_prerequisite_branch
trusted_acceptance = implemented_not_yet_executed_for_ekubo
ekubo_family = not_started_under_this_contract
fixed = false
```

## 16. 推荐交付顺序

```text
Slice A — trusted acceptance tooling
  target-blind producer
  independent comparator
  DEX-only coverage
  route-required shard semantics

Slice B — family boundary hardening
  early boundary preflight + exact path/reason artifact
  standard interface / ownership / thin-registration gate

Slice C — Ekubo family
  host-local variants
  discovery/identity/probe
  pricing/quote
  ActionAdapter/plan
  unit/parity/Adapter Replay

Slice D — checkpoint
  full target-blind six steps
  checkpoint_pass

Slice E — merge/deploy/final
  exact deployed main
  full production universe/config
  final_validated

Slice F — cleanup
  exact ref validation
  branch deletion
```

Slice A/B 必须先于 Ekubo branch 落到 main。Trusted reference 也必须先存在于该 rollback/main。Slice C 必须从包含 A/B 的新 `origin/main` 创建，不能把可信验收器和 feature 放在同一 branch 自证。

## 17. 命令层级

以下命令是当前入口示意；运行前仍应以所在 commit 的 `package.json` 和 CLI usage 为准。

### 17.0 Early boundary preflight

开发期运行：

```bash
cd analysis
npm run --silent adapter-family-boundary-gate -- \
  --baseline origin/main \
  --candidate HEAD \
  --out /tmp/adapter-family-boundary.json
```

CLI 只接 baseline/candidate/out，不接受调用者自报的 family ID 或 `family_local`。它与 checkpoint 调用同一个 evaluator；输出 `framework` 时以非零退出，并要求把 exact paths/reasons 对应的 family 外改动移到独立 branch。

### 17.1 Family 静态与状态合同

```bash
cd listener
npm run --silent searcher:route-adapters
npm run --silent searcher:adapter-family-activation
npm run --silent searcher:adapter-family-shared-surface
npm run --silent searcher:swap-blockscan-state
npm run --silent searcher:protocol-blockscan-state
```

只运行与目标 family kind 有关的 state suite；完整合并门应包含共享 registry/ownership suite。

### 17.2 Adapter Replay

```bash
cd listener
npm run --silent searcher:adapter-family-replay -- \
  --fixture src/searcher/test/fixtures/adapter-families/<family>.json \
  --out-dir /tmp/<family>-adapter-replay
```

该命令不证明 scanner discovery/enumeration，不能签发 checkpoint/final。

### 17.3 Freeze checkpoint inputs

```bash
cd analysis
npm run --silent six-step-validation-gate -- \
  --freeze-inputs \
  --request /tmp/<family>-freeze-request.json \
  --out /tmp/<family>-input-snapshot.json
```

最小 freeze request：

```json
{
  "schema_version": 2,
  "request": "trusted-six-step-input-freeze-request",
  "sample_tx_hash": "0x<64-hex>",
  "lane": "block_scan_standing",
  "universe_path": "/absolute/path/to/pool-universe.json",
  "universe_manifest_path": "/absolute/path/to/pool-universe.manifest.json"
}
```

### 17.4 Pre-merge checkpoint

```bash
cd analysis
npm run --silent six-step-validation-gate -- \
  --phase checkpoint \
  --request /tmp/<family>-checkpoint-request.json \
  --out /tmp/<family>-checkpoint-receipt.json
```

最小 checkpoint request：

```json
{
  "schema_version": 2,
  "request": "trusted-six-step-validation-request",
  "mode": "checkpoint",
  "branch": "codex/<family>",
  "rollback_commit": "<40-hex-origin-main>",
  "sample_tx_hash": "0x<64-hex>",
  "lane": "block_scan_standing",
  "trusted_reference_path": "docs/research/references/production-routes/<sample>.json",
  "input_snapshot_path": "/tmp/<family>-input-snapshot.json"
}
```

### 17.5 Deployed-main final

```bash
cd analysis
npm run --silent six-step-validation-gate -- \
  --phase final \
  --request /tmp/<family>-final-request.json \
  --out /tmp/<family>-final-receipt.json
```

最小 final request：

```json
{
  "schema_version": 2,
  "request": "trusted-six-step-validation-request",
  "mode": "final",
  "branch": "codex/<family>",
  "rollback_commit": "<40-hex-pre-change-main>",
  "sample_tx_hash": "0x<64-hex>",
  "lane": "block_scan_standing",
  "trusted_reference_path": "docs/research/references/production-routes/<sample>.json",
  "universe_path": "/absolute/path/to/deployed-pool-universe.json",
  "universe_manifest_path": "/absolute/path/to/deployed-pool-universe.manifest.json",
  "checkpoint_receipt_path": "/absolute/path/to/<family>-checkpoint-receipt.json",
  "review_commit": "<40-hex-origin-main-review-commit>",
  "review_artifact_path": "docs/research/reports/<family>-independent-review.json"
}
```

Review artifact 必须由独立 reviewer 提交到 `review_commit`：

```json
{
  "schema_version": 2,
  "artifact": "six-step-independent-review",
  "reviewer_email": "reviewer@example.com",
  "rollback_commit": "<40-hex-pre-change-main>",
  "reviewed_candidate_commit": "<40-hex-candidate-tip>",
  "reviewed_merge_commit": "<40-hex-deployed-merge>",
  "integration_base_commit": "<40-hex-first-parent-latest-main>",
  "diff_sha256": "<64-hex>",
  "merge_patch_sha256": "<64-hex-first-parent-to-merge>",
  "candidate_tree_delta_sha256": "<64-hex-candidate-to-merge>",
  "overlap_paths": ["<sorted-semantic-overlap-path>"],
  "reviewed_at": "<ISO-8601>",
  "evidence": "<per-overlap semantic disposition and retained regressions>",
  "verdict": "pass"
}
```

### 17.6 Final + cleanup

```bash
cd analysis
npm run --silent six-step-validation-gate -- \
  --phase final \
  --finalize-cleanup \
  --request /tmp/<family>-final-request.json \
  --out /tmp/<family>-cleanup-final-receipt.json
```

`--finalize-cleanup` 只能与 `--phase final` 同时使用。

> 公开已知样本仍受 §9.2 的证据强度限制。命令存在不等于某个 Ekubo family 已经 `fixed`；必须实际产出 checkpoint 和 exact deployed-main final receipt。

## 18. Definition of Done

一个普通新增 Swap/Protocol family 完成，必须同时满足：

### 架构

- [ ] 中央运行逻辑零协议特有分支；
- [ ] 只使用标准 RouteLegAdapter capability；
- [ ] registry/catalog 仅薄注册；
- [ ] pool/edge/action owner 唯一；
- [ ] 无私有 scheduler/cache/enumerator/solver/final sim；
- [ ] source closure 完整；
- [ ] early family-boundary gate 分类为 `family_local`；
- [ ] 普通 code review 未发现 family 内私建中央调度/枚举/solver 或全局副作用；

### 身份与状态

- [ ] 实例由 on-chain reverse identity 准入；
- [ ] 地址/selector 只作候选；
- [ ] dynamic source coverage 完整；
- [ ] mutation/state dependency 完整；
- [ ] exact quote 与独立 oracle parity；
- [ ] unknown instance/extension fail closed；
- [ ] instance failure 不污染其他 healthy family/variant。

### 执行

- [ ] route-root ActionAdapter 由 family own；
- [ ] quote 与 calldata 语义一致；
- [ ] canonical execution identity 包含所有 claim-relevant 配置；
- [ ] 零 route-token inventory 下守恒；
- [ ] mandatory final sim 成功；
- [ ] production EV allow。

### 生命周期

- [ ] Adapter Replay 仅作为支持证据；
- [ ] pre-merge `checkpoint_pass`；
- [ ] exact deployed-main `final_validated`；
- [ ] independent review 已绑定；
- [ ] full universe/config/runtime attestation 已绑定；
- [ ] cleanup 使用新 final receipt 和 exact ref lease；
- [ ] 只有上述全部完成后才写 `fixed`。

## 19. 最终裁决

1. **普通新增 family 不修改中央接口**是默认规则。
2. **接口确实不足时允许升级**，但必须先做独立、协议无关的 framework slice。
3. Swap 与 Protocol 已有标准接口，不需要各自建立旁路生产线。
4. V4/Ekubo hook/extension 采用 **host-local variant → 标准 composite SwapAdapter**，不增加全局任意 HookFamily。
5. Hook 权限只覆盖 identity、state、quote 和 typed execution intent；不能触碰中央 funnel。
6. 开发期可以基础设施轻量，但 checkpoint 仍是完整六步。
7. 合并后必须对 exact deployed main 运行 full final；只有 `final_validated` 后才能删除 branch。
8. 当前只证明 explicit-input target-late 回归；即使 SHA 后再选 held-out，也不能单独证明泛化，强结论还需 hidden reference + source/RPC isolation。

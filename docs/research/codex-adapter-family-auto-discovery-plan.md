# Codex — Protocol Adapter Family 自动实例发现统一管道计划

> 状态：设计稿，供 Fable 对抗审查；**没有实现，也没有把 tx43 标成 fixed**。
>
> 分支：`codex/adapter-family-auto-discovery`
>
> 基线：`origin/main @ 7f8b8595f2e6100d41cc34dcdee90fae676fb013`
>
> 目标：让所有生产 `ProtocolFamilyAdapter` 像 ERC4626 一样，通过一套共享的
> candidate → identity → probe → ownership → graph projection 管道自动发现实例；**一个高阶 adapter
> 就是一个 execution family，也是唯一注册单元**，family 只实现协议差异。

## 0. 术语和一对一约束（本计划的硬定义）

本计划采用下面的严格关系：

```text
1 ProtocolFamilyAdapter = 1 ExecutionFamilyId = 1 种完整执行语义
1 ProtocolFamilyAdapter -> N 个自动发现的 ProtocolInstance
1 ProtocolFamilyAdapter -> N 个可验证 route/direction
1 ProtocolFamilyAdapter -> 复用 N 个低阶 ActionAdapter
```

- `ProtocolFamilyAdapter` 是 searcher 的高阶 route-leg adapter。新建一个这种 adapter，就是新增一个
  adapter family；不存在“先建 adapter、再另外建 family”的第二步。
- `ProtocolInstance` 是该 family 在链上的具体合约/pool/vault。新增一个同语义实例只应被共享 discovery
  自动收入，**不新增 adapter、不改 main、不增加 registry instance row**。
- `ActionAdapter` 仍只是 BotVM 的低阶编码器，例如 `erc20-transfer`、`weth-deposit-value`。它不是这里所说
  的 adapter family；多个 family 可以复用同一个 ActionAdapter。
- family 的边界由完整执行语义决定，不由协议品牌或合约地址决定。quote、rounding、calldata、资产流和
  状态变化完全相同才属于同一 family；任一执行语义不同就新增另一个 `ProtocolFamilyAdapter`。

因此 gap 名称也必须固定：

| 现象 | 正确分类 | 修法 |
|---|---|---|
| 没有任何 family 能证明并执行这类语义 | **adapter gap / missing family** | 新增一个 `ProtocolFamilyAdapter` |
| family 已存在，但某实例未进入候选或 identity 失败 | instance discovery / identity gap | 修共享 source 或该 family matcher/probe，不新建 adapter |
| family 已存在，但漏了同语义 direction/selector | family coverage gap | 补当前 family；若语义不同则拆新 family |
| 高阶 plan 正确，但缺 BotVM 编码动作 | action encoding gap | 补/复用低阶 `ActionAdapter`，不把实例做成 family |

以后报告中的 **adapter gap** 只表示“缺一个 execution family”。像 MRETH 这种现有 family 无法覆盖的
执行语义，补 `protocol:cashiva-native-wrapped`；以后另一个 Cashiva 实例若通过同一套 family 证据，
只自动进图，不再出现 `protocol:that-token`。

## 1. 先给结论

1. **ERC4626 已经有自动发现管道，但还不是“完全无手工名单”。** 当前动态路径已经能从 DEX token
   domain 和 observed receipt/trace 产生候选，统一完成 identity、probe、cache、仲裁、生命周期和原子进图；
   但 `token-graph.ts` 仍保留 21 条 ERC4626 compatibility fallback，只有逐实例 Production Replay
   达标后才能删除。
2. 当前另外 6 个生产 protocol family：`goldx`、`metronome-synth`、`metronome-hgusdc`、`psm`、
   `rocksolid`、`wsteth`，都只有手写 `declaredVenues`，没有 discovery capability。
3. 附件交易 `0x43f37bd6c9fcf2bdc8ebd21e948d16c2b453e07d8ee2b33d3277e5c94ec6c70b`
   **不能由现有任何非 ERC4626 family 正确解析**。它也不是 ERC4626；它属于
   **Cashiva native-wrapped token execution family**，应该新增 `protocol:cashiva-native-wrapped`，
   而不是新增实例专属 `protocol:mreth`。
4. 不为 7 个 family 各写 scanner/cache/timer。保留现有一个共享 scanner，并补齐三类共享候选源：
   DEX token address、observed interaction、canonical registry/root。adapter family 只声明自己使用哪些源，
   并实现 matcher、identity、nonzero probe、edge、quote 和 plan。
5. “自动发现”不是“凭 selector 猜协议”，也不是全链 bytecode census。没有 factory/registry、实例又不是
   DEX token、历史和实时都没有 interaction 的 dormant target，系统无法凭空知道它。此类实例必须等待
   observed interaction，或由可验证的 canonical registry/root 枚举。

## 2. 本轮范围

“所有其他 family”在本计划中精确定义为：

- 当前 `PRODUCTION_ROUTE_ADAPTERS.protocols` 中的 6 个非 ERC4626 family；
- 新增的 `protocol:cashiva-native-wrapped` family；
- ERC4626 继续作为第一个动态 family 和回归基线。

明确不在本轮：

- swap family：UniV2/V3/V4、Curve、DODO、Balancer V3 已经走 DEX factory/event/universe 管道，
  不应重复接入 protocol instance scanner；
- `compat:fluid-credit`：它是 compat/lend 语义，不是 `ProtocolConversionAdapter`；
- Curve LP、FlashAdapter：分别属于 Liquidity/现有 flash 架构，不在这次 protocol instance 改造中；
- 扩大 mempool 广播或放松 final sim。新发现的 target 进图后，mempool intake 应继续从 registry/graph 派生，
  不新增 protocol 地址 hardcode。

## 3. tx43：现有 family 能不能解析

### 3.1 已有证据

附件的可信分析给出的核心闭环是：

1. `USDT → MRETH`：UniV3 pool `0xcb09e61fcaff245d9f7016c8ff5c403757a5a961`；
2. `MRETH → native ETH`：把
   `20194339741810358` MRETH `transfer` 给 MRETH 合约自身，随后 token burn，并向调用者支付
   `19992396344392255 wei` native ETH；
3. 把其中 `19856348175019991 wei` wrap 成 WETH；
4. `WETH → USDT`：UniV3 pool `0xc7bbec68d12a0d1830360f8ec58fa599ba1b0e9b`。

MRETH 地址：`0xc6a9851def913016074ac089e194f65945343462`。Etherscan 显示它是 EIP-1967 proxy，
当前 implementation 为 `0xd51b38bd3ac0777ee15fc6bda67849fa1d3e6d87`；已验证源码包含
`MRETHCashivaToken.sol`、`CashivaNativeWrappedToken.sol`、`NativeWrappable.sol` 和 `WrapFee.sol`。
上游源码也直接声明 `MRETHCashivaToken is CashivaNativeWrappedToken`：

- [MRETHCashivaToken.sol](https://github.com/wmtprime/cst-contracts/blob/master/ethereum/tokens/ETH/MRETHCashivaToken.sol)
- [NativeWrappable.sol](https://github.com/wmtprime/cst-contracts/blob/master/ethereum/tokens/extensions/NativeWrappable.sol)
- [WrapFee.sol](https://github.com/wmtprime/cst-contracts/blob/master/ethereum/tokens/extensions/WrapFee.sol)

公开的 Cashiva family 源码中，`NativeWrappable.transfer(to, value)` 在 `to == address(this)` 时执行
unwrap：burn token 并支付 native ETH；fee 按 `amount * wrapFeeRate / wrapFeeParts` 计算，再受
`wrapFeeMin/wrapFeeMax` clamp。实现时仍必须读取部署实例的 getter 并用 nonzero sim 核对，不能把上游
源码或附件样本恰好约 99% 的 payout 直接硬编码成 `99/100`。

### 3.2 为什么现有 family 都不能冒充

| Family | 能否直接解析 | 原因 |
|---|---:|---|
| ERC4626 | 否 | 没有 `asset/previewRedeem/redeem` 语义；退出入口是 ERC20 `transfer(self)` |
| wstETH | 否 | `wrap/unwrap` selector、quote 和输出 token 都不同；只能复用 wrap/unwrap taxonomy 思路 |
| RockSolid | 否 | 现有语义是 `rETH → share` 的 `syncDeposit`，方向和执行入口均不同 |
| GOLDx | 否 | PAXG mint conversion，不产生 native payout |
| PSM | 否 | `gem/dai` 固定兑换，不是 burn/native wrap |
| Metronome 两类 | 否 | synth swap / 复合 hgUSDC exit，与 self-transfer burn 无关 |

可以复用的只有低阶动作：

- `erc20-transfer`：把 MRETH 转给它自己；
- `weth-deposit-value`：把收到的 native ETH wrap 成 WETH。

所以不需要 MRETH 专属 BotVM opcode；需要新增的是高阶 execution family 的 identity/probe、quote、
edge 和多节点 `PlanFragment`。

### 3.3 Cashiva family 的最小正确语义

建议命名：

```text
ExecutionFamilyId: protocol:cashiva-native-wrapped
Pool adapter:      cashiva-native-wrapped
Edge adapter:      cashiva-unwrap-native
Logical edge:      CASHIVA_TOKEN -> WETH
Plan nodes:        erc20-transfer(token -> token self)
                   weth-deposit-value(native payout -> WETH)
```

v1 只发已经被本 tx 和 nonzero probe 证明的 `Cashiva token → WETH` 路线。虽然合约还有 payable
`wrap()`，但在 shared backend 支持 value-bearing nonzero probe、且反向 Adapter Replay 通过前，
**不自动发 `WETH → Cashiva token` 边**。

Cashiva identity 不能只检查 `transfer(address,uint256)`，所有 ERC20 都有这个 selector。最低证据链：

1. DEX token domain 或 observed interaction 产生 target；
2. code hash + EIP-1967 implementation word 进入共享 fingerprint cache；
3. family getter/interface 自洽：fee parts/rate/min/max、oracle/feed 等必要字段可读且约束合法；
4. observed 路径必须看到 `recipient == token self`，同一 call subtree 中出现 transfer-to-self、burn、
   `Unwrap`/native payout，不能接受 sibling payout；
5. 主动地址路径必须做 nonzero fork/sim：给 probe actor 非零 token，执行 `transfer(self, amount)`，
   receipt 证明 exact burn + native payout，并与动态 fee quote 一致；
6. final fork sim 仍是 fail-closed 终门。

当前 `ProtocolDiscoveryReadBackend.simulateCalls` 只有 `from/to/data` 和 storage diff。如果 Cashiva
nonzero probe 需要设置 native balance，或未来验证反向 payable `wrap()`，只给共享 call descriptor
增加通用 `value`/account balance override；**不新建 Cashiva 私有 Anvil runner**。

已有三个 `cashiva-burn-native` 历史样本应和 tx43 组成同一 family corpus：

- `0x5eb6dd6b9ae7fe1666666d125e8b61b41c1121ed6da4a205155880ce70a8502f`
- `0xd8171509037a51f87bcd58d68e8634580c9b56dd04b5f69852dab1b6525b141a`
- `0x3ab5ca68abc87d4143d8b5cbb3d1f4cde88f2c302a090b575317f46cc6c7ef53`

## 4. 目标架构：一条管道，family 只提供差异

### 4.1 不变的共享责任

现有这些模块继续是唯一 owner：

```text
candidate source union
  ├─ DEX token domain
  ├─ landed/observed receipt + one shared trace
  └─ canonical registry/root enumeration
        ↓
fingerprint cache (chain + codeHash + proxy implementation + matcherVersion)
        ↓
family candidate matcher
        ↓
canonical identity resolver (no seed credential for dynamic candidate)
        ↓
family nonzero semantic probe
        ↓
verified route claims
        ↓
global arbitration / ownership / retry lifecycle
        ↓
atomic pool + graph + strategy-view projection
```

共享层统一拥有：block range/cursor、receipt/trace 去重、RPC concurrency/deadline、positive/negative
cache、proxy fingerprint invalidation、retryable/permanent 分类、route ownership、歧义隔离、删除/保留语义、
graph projection、telemetry。family 文件不得出现自己的 block loop、`getLogs` cadence、cache 文件或 timer。

### 4.2 family 唯一允许不同的部分

每个 family 只声明/实现：

- 使用哪些候选源；若有 canonical registry/root，只声明 root 和一个 bounded enumerator，不拥有调度；
- event topics / call selectors 的廉价 shortlist；
- `candidateFromAddress` / `candidateFromObservedCall` 的协议完整匹配；
- on-chain identity resolver；
- nonzero semantic probe 和 `VerifiedRouteClaim`；
- edge derivation、quote、plan fragment、底层 action adapter 列表。

### 4.3 最小接口改造

不重写现有 `ProtocolDiscoveryCapability`，只补两件事。

第一，给 discovery 明确声明候选源：

```ts
type ProtocolCandidateSource =
  | { kind: "dex-token-domain" }
  | { kind: "observed-interaction" }
  | {
      kind: "canonical-registry";
      root: string;                 // 可 pin 的是身份/枚举根，不是 executable instance
      sourceVersion: string;
    };

interface ProtocolDiscoveryCapability {
  readonly candidateSources: readonly ProtocolCandidateSource[];
  readonly eventTopics: readonly string[];
  readonly callSelectors: readonly string[];
  readonly addressMatcherVersion?: string;
  candidateFromAddress?(...): Promise<ProtocolCandidate | null>;
  candidateFromObservedCall?(...): Promise<ProtocolCandidate | null>;
  enumerateFromRoot?(root, ctx): Promise<readonly ProtocolCandidate[]>;
  probeCandidate(...): Promise<readonly TokenEdge[]>;
}
```

`enumerateFromRoot` 只允许做协议专属的 bounded calls/decoding；range、deadline、cache、重试和生命周期仍由
shared scanner 控制。没有可信 registry 的 family 不填这一项，不能伪造一个 root。

第二，让高阶 adapter 对象本身就是完整 family 和唯一注册单元，消除当前
“adapter 已注册、discovery identity registry 仍是 trusted seed”的漏接状态：

```ts
interface ProtocolFamilyAdapter extends ProtocolConversionAdapter {
  /** id 本身就是 ExecutionFamilyId；一个 id 只对应一种完整执行语义。 */
  readonly id: ProtocolExecutionFamilyId;
  /** production family 必须自带自动实例发现能力。 */
  readonly discovery: ProtocolDiscoveryCapability;
  /** 与 execution 分层，但和 family 在同一个对象、同一次注册中交付。 */
  readonly discoveryIdentity: IdentityResolverDescriptor;
}
```

`PRODUCTION_PROTOCOL_FAMILIES: readonly ProtocolFamilyAdapter[]` 是唯一真相源；
`PRODUCTION_ROUTE_ADAPTERS.protocols`、`PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS`、candidate
topic/selector union、mempool/graph target projection 都从它派生。Identity 与 Execution 仍是两层能力，
但它们由同一个 family adapter 一次性交付、一次注册，不能再维护两张容易漂移的手工表或要求调用方
“注册 adapter 后再注册 family”。

### 4.4 两个必须先补的共享安全缺口

1. **dynamic identity 不能只给 ERC4626 特判。** 当前 discovery identity registry 只有 ERC4626
   被替换成 on-chain resolver；其他 family 即便添加 matcher，仍会因 discovery 的 `seedEntries=[]`
   在 identity 阶段被 `untrusted_seed` 拒绝。必须由每个 `ProtocolFamilyAdapter.discoveryIdentity` 为自己
   提供 resolver。
2. **`verifiedRoutes` 必须由 RouteLegRegistry 通用强制。** 当前 `PoolEntry` 注释声称 discovery pool
   只重建 probe 通过的 route，但真正的限制只写在 ERC4626 `buildEdges` 内。迁移其他 family 后，普通
   `buildEdges` 可能重新长出 probe 没批准的边。通用做法：adapter 仍可重验链上状态并返回 edges，
   registry 对其输出与 `pool.verifiedRoutes` 做 exact-set 比对；多一条、少一条或 metadata 漂移都 fail closed。

## 5. 每个 family 怎么接同一条管道

| Family | 首选自动候选源 | family identity / probe 的关键 | 静态 fallback 删除条件 |
|---|---|---|---|
| ERC4626（已有） | DEX token + observed Withdraw/redeem | 标准接口自洽 + causal payout + nonzero deposit/redeem | 现有 21 个实例逐个 no-seed Production Replay |
| wstETH | DEX token | `stETH()` 派生 pair；conversion views + 双向 nonzero sim | 动态地址召回、双边 replay 与 graph 等价 |
| GOLDx | DEX token + observed mint | `unit()` 只能 shortlist；必须证明 PAXG input → GOLDx mint/output | no-seed source 能召回当前 target，mint replay 通过 |
| RockSolid | DEX token + observed `syncDeposit` | `convertToShares()` 只能 shortlist；receipt/trace 证明 rETH input → share mint | no-seed source 召回 + nonzero deposit replay |
| PSM | canonical registry/root（若确认）+ observed call | `gem()/dai()` 派生 pair，双向 quote/execution probe | root/observed 自发召回当前 LitePSM + 双向 replay |
| Metronome synth | canonical pool/controller root + observed swap | 从 graph token/observed calldata 得 token 候选，再用 `doesSyntheticTokenExist` 和 quote/sim 验证；删除手写 `SYNTH_TOKENS` | 全部现有 synth route 自发枚举且 exact-set 等价 |
| Metronome hgUSDC | canonical root + observed exit | 这是复合 path family；必须 attest router、Curve leg、hgUSDC asset 和 path fingerprint，不能泛化成任意 ERC4626 | 当前复合路线自发召回 + whole-plan replay |
| Cashiva native-wrapped（新增） | DEX token + observed `Unwrap`/self-transfer | interface/fingerprint + self-transfer burn + native payout + fee一致 | 新 family 无 static instance；tx43 + 3 个同族样本 replay |

注意：

- `wstETH/GOLDx/RockSolid/Cashiva` 的 instance 本身是 token，能由 DEX universe 主动地址扫描发现；
- `PSM/Metronome` target 通常不是 DEX token。fresh node 若没有可信 registry/root，只能在第一次 supported
  landed interaction 后发现并持久化。文档和日志必须明确 `source=observed`，不能声称 cold-start 穷举；
- 当前 PSM 是唯一 `requiresProtocolEdgesFlag=false` 的 protocol family，而 registry 禁止 ungated discovery。
  迁移时动态 PSM 必须经过 coordinator 的 `protocolEdgesEnabled`；静态 grandfathered PSM 可在 replay
  完成前保留。不能为了加一个 `discovery` 字段就把安全门绕掉。

## 6. `declaredVenues` 的最终语义

这次不是粗暴删除所有 hardcode，而是分清两类：

- **允许保留：** canonical registry/factory/controller/singleton 身份根，用于枚举或 attestation；
- **最终应删除：** 直接把 executable instance + token pair 无条件塞进图的 compatibility row。

这延续 D-005 的“pin identity root，不把行为观察当身份”安全原则，但重新打开了 D-005 中“单例可以永远
declared-only”的暂缓项：用户现在明确要求它们接入自动 discovery。每个 family 的旧 `declaredVenues`
先作为兼容 fallback 保留，dynamic 路径在隔离 replay 中必须排除它；当 no-seed recall、identity、probe、
六步验收全部通过后，才在该 family 的独立提交中删除 fallback。不得一次清空 6 个 venue。

静态 row 存在时，production projection 会 `staticSuppressed` 动态同址结果，所以迁移验证必须显式：

1. shadow 比较动态 claim 与静态 edge；
2. 在测试/Production Replay 输入中移除该 family 静态 row；
3. 证明 dynamic 自发召回并得到相同 route；
4. 再删生产 fallback。

## 7. 实施顺序

### Slice 0 — 共享骨架补强

- 增加 `ProtocolFamilyAdapter`，以 `PRODUCTION_PROTOCOL_FAMILIES` 为唯一注册表，从 adapter 自身派生
  route registry、discovery identity registry、candidate filters 和 graph/mempool projection；
- 增加 `candidateSources` 和共享 canonical-root 调度入口；
- 在 `RouteLegRegistry` 通用强制 `verifiedRoutes` exact-set；
- conformance：每个 production protocol family 必须有 discovery，或有带 owner/期限的 migration exemption；
- 保持现有 ERC4626 graph 和 admission 逐位不变，先证明没有回归。

### Slice 1 — Cashiva 作为第二个真实 dynamic family

- 新增 Cashiva identity/discovery/quote/plan；不 hardcode MRETH instance；
- 用 DEX token candidate 自动识别 MRETH；
- tx43 与三个既有 Cashiva 样本做 Adapter Replay + Production Replay；
- 同时让 multi-adapter arbitration 不再只靠 test-only fixture。

### Slice 2 — 地址可见的现有 family

依次迁移 `wstETH → RockSolid → GOLDx`。每个 family 单独提交、单独 replay、单独删除 fallback；出现
identity/probe 歧义就停在 shadow，不影响其他 family。

### Slice 3 — 非 token target family

依次迁移 `PSM → Metronome synth → Metronome hgUSDC`。优先确认 canonical registry/root；没有权威枚举根
时使用 observed source + persisted ownership，不做全链 code census，不把当前 executable 地址伪装成 factory。

### Slice 4 — 清 compatibility debt

- ERC4626 21 条 legacy row 继续按既有 recall gate 清理；
- 清除已通过 Production Replay 的 6 个旧 `declaredVenues` executable rows；
- 保留真正的 registry/factory/controller roots；
- 更新 D-005 与 protocol discovery 文档，记录新边界和仍存在的 exception。

## 8. 六步验收（每个 family 都要，不能只验 tx43）

每个 family 至少一个正样本、一个 lookalike 负样本；复合/双向 family 每种执行语义各一个 fixture。

1. **Source / identity**：不把答案实例注入 candidate；shared source 自发产出，canonical identity 唯一通过；
2. **Graph**：`(adapterId,target,tokenIn,tokenOut,slotKind,protocolAction)` exact-set 与基线/预期一致；
3. **Enumeration**：scanner/planner 自发枚举目标 ring，不能注入 path 或 amount；
4. **Quote / solve**：每 hop amountIn/amountOut、sizing 和 netProfit 逐 wei；family 自己拥有 rounding；
5. **Plan / final sim**：calldata/PlanFragment 结构正确，success/revert、gas、conservation 和净收益符合 fork；
6. **EV decision**：allow/reject 和 reason 正确；正收益样本能走到 production EV，仍不广播真钱。

验收分两层：

- Adapter Replay：可以 pin route，但 amount 必须由 production solver 选；证明 execution family 正确；
- Production Replay：只给 historical tx/state anchor，不给 route/amount；证明自动发现和生产漏斗正确。

共享 scanner/registry/lifecycle 属系统性改动，因此全部 deterministic replay 通过后，还要走 Hermes paired A/B，
比较 graph hash、candidate composition、RPC/cache、warm 后 pass latency、budget censoring 和 final-sim false
positive。六步 checker 仍是可运行的诊断/验收项目，不重新做成部署强制开关；若 checker 本身有 bug 可以人工
裁决并修 harness，但相关 family 在对应步骤重新通过前不能标 `fixed`。

## 9. 负例与资源门

必须覆盖：

- 普通 ERC20 也有 `transfer`，不得被 Cashiva 认领；
- 只伪造 `asset/unit/convertToShares/fee getter` 的 lookalike；
- 同 target 被两个 family 匹配：不同 execution fingerprint 全部隔离并告警；
- proxy implementation 升级、getter/pair 漂移、payout token 漂移；
- observed selector 命中但 receipt/trace 缺失或 payout 在 sibling subtree；
- transient RPC timeout 保留旧 route，确定性 identity/probe 失败撤 route；
- registry root 枚举爆量、重复、恶意地址；shared concurrency/deadline 和 per-family cap 生效；
- cold start 第二轮 cache hit，不重复做所有 expensive probes。

资源报告至少记录：每个 source 候选数、每 family matcher/probe 次数、code/impl reads、cache hit、trace 次数、
scan wall time、admitted/negative/ambiguous、graph edge delta。目标不是任意降低候选，而是不让新增 family
线性复制 scanner I/O。

## 10. 预计改动落点

- `listener/src/searcher/venues/route-leg-adapter.ts`：candidate source 与 family registration 类型；
- `listener/src/searcher/venues/production-registry.ts`：单一 protocol family registration 真相源；
- `listener/src/searcher/observed-protocol-discovery.ts`：聚合 source descriptor，继续唯一拥有扫描/缓存；
- `listener/src/searcher/protocol-discovery-runtime.ts`：统一合并 DEX/observed/root candidates；
- `listener/src/searcher/venues/route-leg-registry.ts`：`verifiedRoutes` exact-set 门；
- `listener/src/searcher/venues/protocols/*-discovery.ts`：各 family matcher/identity evidence/probe；
- `listener/src/searcher/venues/protocols/cashiva-native-wrapped.ts`：新 execution family；
- `listener/src/searcher/planner/token-graph.ts`：只随 family replay 成功逐项删除 legacy fallback；
- 现有 conformance、multi-adapter fixture、Adapter Replay、Production Replay 与 Hermes 报告。

## 11. 请 Fable 重点对抗的 8 个问题

1. Cashiva identity 是否仍可能被普通 ERC20 + 伪 getter 冒充？nonzero probe 是否真的验证 causal payout？
2. `transfer(self)` 后 native payout 再 WETH wrap，现有 PlanFragment/BotVM 的余额语义是否可逐 wei复现？
3. shared simulation 加 `value/balance override` 是否必要，还是 v1 单向 Cashiva 不需要？
4. generic `verifiedRoutes` exact-set 放在 RouteLegRegistry 是否会妨碍 adapter 的链上 drift re-attest？
5. PSM 在保留 grandfathered static route 时，如何保证 dynamic path 始终受 protocol flag 控制？
6. Metronome hgUSDC 的多合约 path identity 应放在一个 logical instance 还是复合 route fingerprint？
7. 哪些 family 真有可信 canonical registry/root，哪些只能诚实地标 `observed-after-first-use`？
8. 逐 family 删除 static fallback 时，`staticSuppressed`/ownership 是否存在短暂重复或撤边窗口？

## 12. 完成定义

只有同时满足以下条件，本计划才完成：

- 7 个现有 production protocol family + Cashiva 各自只有一个 `ProtocolFamilyAdapter` 注册项，且 adapter
  自带 discovery capability 和 dynamic identity resolver；
- scanner/cache/cursor/arbitration/lifecycle/projection 仍只有一套；
- 新增 family 只新增一个 adapter module 并加入唯一 family registry；不修改 `main.ts` protocol switch、
  不追加 identity 手工表、不手写 mempool target；
- 新增同 family 实例不改任何注册代码，由共享管道自动发现；
- 每个 family 至少一个 Production Replay 自发走完六步；
- 所有可替代的 executable `declaredVenues` 已在各自 replay 后删除，保留项都有明确的 identity-root 理由；
- ERC4626 现有 admitted graph 无回归；系统性 Hermes A/B 资源与 warm 后性能无实质回退；
- tx43 由 Cashiva family 自发枚举并 final-sim success 后，才允许从 `implemented_not_validated` 升级状态。

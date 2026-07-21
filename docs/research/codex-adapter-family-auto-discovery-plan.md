# Codex — Route Adapter Family 自动实例发现统一管道计划

> 状态：设计稿，供 Fable 对抗审查；**没有实现，也没有把 tx43 标成 fixed**。
>
> 分支：`codex/adapter-family-auto-discovery`
>
> 基线：`origin/main @ 7f8b8595f2e6100d41cc34dcdee90fae676fb013`
>
> 目标：让所有生产 `RouteFamilyAdapter` 像 ERC4626 一样，通过一套共享的
> candidate → identity → probe → ownership → category projection 管道自动发现实例；**一个高阶 adapter
> 就是一个 execution family，也是唯一注册单元**。管道同时服务 protocol conversion、credit 和
> liquidity family；family 只实现执行与风险语义差异。

## 0. 术语和一对一约束（本计划的硬定义）

本计划采用下面的严格关系：

```text
1 RouteFamilyAdapter = 1 ExecutionFamilyId = 1 种完整执行语义
1 RouteFamilyAdapter -> N 个自动发现的 RouteInstance
1 RouteFamilyAdapter -> N 个可验证 route/direction
1 RouteFamilyAdapter -> 复用 N 个低阶 ActionAdapter
```

- `RouteFamilyAdapter` 是 searcher 的高阶 route-family adapter。新建一个这种 adapter，就是新增一个
  adapter family；不存在“先建 adapter、再另外建 family”的第二步。
- `RouteInstance` 是该 family 在链上的具体合约/pool/vault。新增一个同语义实例只应被共享 discovery
  自动收入，**不新增 adapter、不改 main、不增加 registry instance row**。
- `ActionAdapter` 仍只是 BotVM 的低阶编码器，例如 `erc20-transfer`、`weth-deposit-value`。它不是这里所说
  的 adapter family；多个 family 可以复用同一个 ActionAdapter。
- family 的边界由完整执行语义决定，不由协议品牌或合约地址决定。quote、rounding、calldata、资产流和
  状态变化完全相同才属于同一 family；任一执行语义不同就新增另一个 `RouteFamilyAdapter`。
- adapter 内禁止维护 `variants = { wsteth, mreth, ... }` 这类协议枚举。ABI/状态行为相同的实例天然落入
  同一个 behavior family；行为不同就属于不同 family，而不是在一个 family 里加品牌分支。

因此 gap 名称也必须固定：

| 现象 | 正确分类 | 修法 |
|---|---|---|
| 没有任何 family 能证明并执行这类语义 | **adapter gap / missing family** | 新增一个 `RouteFamilyAdapter` |
| family 已存在，但某实例未进入候选或 identity 失败 | instance discovery / identity gap | 修共享 source 或该 family matcher/probe，不新建 adapter |
| family 已存在，但漏了同语义 direction/selector | family coverage gap | 补当前 family；若语义不同则拆新 family |
| 高阶 plan 正确，但缺 BotVM 编码动作 | action encoding gap | 补/复用低阶 `ActionAdapter`，不把实例做成 family |

以后报告中的 **adapter gap** 只表示“缺一个 execution family”。像 tx43 这种现有 family 无法覆盖的
执行语义，补 `protocol:self-burn-native`；以后任何 token 若通过同一套行为证据，只自动进图，
不再出现 `protocol:that-token`、协议名 variant 或 implementation allowlist。

## 1. 先给结论

1. **ERC4626 已经有自动发现管道，但还不是“完全无手工名单”。** 当前动态路径已经能从 DEX token
   domain 和 observed receipt/trace 产生候选，统一完成 identity、probe、cache、仲裁、生命周期和原子进图；
   但 `token-graph.ts` 仍保留 21 条 ERC4626 compatibility fallback，只有逐实例 Production Replay
   达标后才能删除。
2. 当前另外 6 个生产 protocol family 的 legacy id 是 `goldx`、`metronome-synth`、
   `metronome-hgusdc`、`psm`、`rocksolid`、`wsteth`；它们都只有手写 `declaredVenues`，没有 discovery
   capability。迁移目标要先证明行为边界，不能把这些协议名直接变成新的 variant enum。
3. 附件交易 `0x43f37bd6c9fcf2bdc8ebd21e948d16c2b453e07d8ee2b33d3277e5c94ec6c70b`
   **不能由现有任何非 ERC4626 family 正确解析**。它也不是 ERC4626；它属于
   **self-burn-native behavior family**，应该新增 `protocol:self-burn-native`，而不是新增实例专属
   `protocol:mreth`、协议 variant 或 Cashiva allowlist。
4. 不为 protocol/credit/LP family 各写 scanner/cache/timer。保留一个共享 route-family scanner，并补齐三类共享候选源：
   DEX token address、observed interaction、canonical registry/root。adapter family 只声明自己使用哪些源，
   并实现 matcher、identity、nonzero probe、route spec、quote 和 plan。
5. “自动发现”不是“凭 selector 猜协议”，也不是全链 bytecode census。没有 factory/registry、实例又不是
   DEX token、历史和实时都没有 interaction 的 dormant target，系统无法凭空知道它。此类实例必须等待
   observed interaction，或由可验证的 canonical registry/root 枚举。

## 2. 管道范围与本次迁移 cohort

共享管道从接口层开始就覆盖三类 route family：

```text
RouteFamilyDiscoveryPipeline
├─ ProtocolConversionFamilyAdapter  // 原子兑换、wrap/redeem，不留负债
├─ CreditFamilyAdapter              // lend/borrow，可能留下 position/debt
└─ LiquidityFamilyAdapter           // add/remove liquidity，可能是多资产 delta
```

这三个是风险/会计类别，不是协议 variant。它们共用 candidate、fingerprint cache、identity、behavior sim、
ownership、arbitration、lifecycle 和 telemetry；只在 verified route shape、风险门和 projection hook 上不同。

本次首先实现和验收的 cohort 是：

- 当前 7 个 protocol conversion execution semantics（含 ERC4626）；
- 新增的通用 `protocol:self-burn-native` behavior family；
- 同时把 base interface、registry 和 coordinator 提升为 `RouteFamilyAdapter`，确保 credit/LP 后续只新增
  family module，不再改 scanner/cache/main orchestration。

credit/LP 不是排除项，但不能假装已经可生产：

- 当前 `compat:fluid-credit` 只是 legacy diagnostic adapter，缺 exact quote/debt search，且
  `leavesStandingPosition=true`。它要成为 `CreditFamilyAdapter`，必须声明 position identity、collateral/debt
  delta、risk model 和显式 credit-live policy；shared discovery 可以先 shadow 发现实例，不能直接放进普通套利环；
- 当前 main 的 `SlotKind` 没有 liquidity，`edgeKind=lp` 仍是 analysis-only。Curve single-coin LP 等实现要成为
  `LiquidityFamilyAdapter`，必须先补 runtime liquidity taxonomy/projector；在此之前同一管道可完成 discovery、
  identity、probe、ownership/cache，但 graph projection 必须 fail closed；
- 多资产 LP 不是简单 `TokenEdge`，不能为了复用 protocol 图而压成伪单边，见 §4.3 的 route-claim union。

仍不在本计划：

- swap family 的迁移：UniV2/V3/V4、Curve swap、DODO、Balancer V3 已有 DEX factory/event/universe 管道；
  可以将来接入相同 claim/lifecycle IR，但本轮不重复扫描；
- FlashAdapter 改造；
- 扩大 mempool 广播或放松 final sim。新发现的 target 进图后，mempool intake 继续从 family registry/graph
  派生，不新增地址 hardcode。

## 3. tx43：现有 family 能不能解析

### 3.1 已有证据

附件的可信分析给出的核心闭环是：

1. `USDT → MRETH`：UniV3 pool `0xcb09e61fcaff245d9f7016c8ff5c403757a5a961`；
2. `MRETH → native ETH`：把
   `20194339741810358` MRETH `transfer` 给 MRETH 合约自身，随后 token burn，并向调用者支付
   `19992396344392255 wei` native ETH；
3. 把其中 `19856348175019991 wei` wrap 成 WETH；
4. `WETH → USDT`：UniV3 pool `0xc7bbec68d12a0d1830360f8ec58fa599ba1b0e9b`。

MRETH 地址、implementation 和协议源码在这里仅作为**历史样本解释与测试 fixture 证据**。它们不得进入
production matcher、family variant、identity allowlist 或 quote 分支。Etherscan 显示该样本是 EIP-1967
proxy；公开源码解释了为何 landed trace 呈现 self-transfer → burn → native payout：

- [MRETHCashivaToken.sol](https://github.com/wmtprime/cst-contracts/blob/master/ethereum/tokens/ETH/MRETHCashivaToken.sol)
- [NativeWrappable.sol](https://github.com/wmtprime/cst-contracts/blob/master/ethereum/tokens/extensions/NativeWrappable.sol)
- [WrapFee.sol](https://github.com/wmtprime/cst-contracts/blob/master/ethereum/tokens/extensions/WrapFee.sol)

公开源码中，`NativeWrappable.transfer(to, value)` 在 `to == address(this)` 时执行 unwrap：burn token 并
支付 native ETH。这个事实只帮助我们命名历史现象；production family 不依赖这些源码、协议名或 fee getter。
输出必须由当前块上的实际模拟测得，不能把样本约 99% 的 payout、源码公式或 implementation codehash
硬编码成 quote/admission。

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

- `erc20-transfer`：把 candidate token 转给它自己；
- `weth-deposit-value`：把收到的 native ETH wrap 成 WETH。

所以不需要实例专属 BotVM opcode；需要新增的是高阶 behavior family 的 identity/probe、quote、
edge 和多节点 `PlanFragment`。

### 3.3 `self-burn-native` family 的最小正确语义

family 按行为命名，不按协议命名：

```text
ExecutionFamilyId: protocol:self-burn-native
Pool adapter:      self-burn-native
Edge adapter:      self-burn-native-to-weth
Logical edge:      candidate token -> WETH
Plan nodes:        erc20-transfer(token -> token self)
                   weth-deposit-value(native payout -> WETH)
```

MRETH 只是这个 family 的第一个已知正 fixture。production 模块中不得出现 `MRETH`、
`0xc6a985…`、`0xd51b38…`、`Cashiva`、`mrethVariant` 或已知 implementation hash。测试 fixture 和研究
报告可以保留交易/地址，目的是证明 generic probe 对真实样本有效，而不是给生产代码喂答案。

family 不能只检查 `transfer(address,uint256)`，所有 ERC20 都有这个 selector。最低行为证据链：

1. DEX token domain 或 observed interaction 产生 target；
2. code hash + proxy implementation word 只进入共享 fingerprint cache，负责升级失效/重 probe，
   **不参与正向准入，也没有 implementation allowlist**；
3. shared simulation 给 caller 准备非零 candidate token，执行真实
   `transfer(candidateToken, amount)`；
4. simulation 必须证明 caller token 恰好减少 `amount`，同一调用因果树发生 burn/总供给减少，token 合约向
   同一 caller 支付 `nativeOut > 0`；仅有 event、selector 或 sibling native transfer 都不算；
5. 将该次模拟测得的 `nativeOut` 作为 `token → WETH` exact quote，WETH deposit 按 1:1 衔接；
6. scanner 生成的完整 route 仍必须通过独立 final fork sim，任何 probe/quote/sim 不一致都 fail closed。

v1 只发被上述行为证明的 `candidate token → WETH` 路线。某个实例即使还有 payable `wrap()`，也不会因此
自动获得反向边；反向是另一套 calldata/state semantics，必须单独证明，必要时成为另一个 behavior family。

### 3.4 唯一新增的通用 quote 基础设施

当前 `StateBackend.call()` 只返回 returndata，无法取得一次状态调用造成的 native/token balance delta。
不能靠 protocol getter 或已知 fee 公式弥补；需要一个共享的、block-pinned 行为模拟接口：

```ts
interface ValueDeltaSimulationRequest {
  /** 必须是最终 plan 使用的真实 executor，不能用 family 私有 probe 地址。 */
  readonly from: string;
  readonly to: string;
  readonly data: string;
  readonly tokenIn: string;
  readonly expectedTokenIn: bigint;
  readonly stateOverrides: FundedCallerOverrides;
  readonly deadlineAtMs: number;
}

interface ValueDeltaSimulationResult {
  readonly success: boolean;
  readonly tokenInSpent: bigint;
  /** Call-induced native delta, excluding gas accounting. */
  readonly nativeOut: bigint;
  /** Signed delta; zero is explicit when the simulated action does not change supply. */
  readonly totalSupplyDelta: bigint;
  readonly logs: readonly ProtocolDiscoveryLog[];
  readonly trace: unknown;
}

simulateValueDelta(request): Promise<ValueDeltaSimulationResult>;
```

它属于共享 state/revm backend，不属于 `self-burn-native` 私有 runner。discovery probe 和 solver quote 调用
同一个语义入口；prepared local Revm 可按 `(stateRoot,target,calldata,amount,codeHash,implWord)` 缓存结果。
RPC/本地 backend 不支持 state override、value delta、trace 或 deadline cancellation时，该 family 在该 lane
**不可用并 fail closed**，不得回退到 `99/100`、fee getter、historical ratio 或 codehash 推断。

因此还要把实际 `executor` 传进 `ExactQuoteContext`/prepared quote request。state override 只给该 executor
准备本 route 所需的 candidate token；不得改 target 的 code、implementation、native reserve 或 fee state。
`nativeOut` 必须同时由 caller 增量和 token-contract 减量交叉验证，并排除 gas、coinbase payment 与 sibling
transfer。`self-burn-native` 还必须满足 `totalSupplyDelta === -tokenInSpent`；缺少 supply delta 能力或关系不等
就 fail closed。否则选择性针对 probe 地址放行的 token 会产生假阳性。

下面三个历史 `cashiva-burn-native` 样本与 tx43 只作为 `self-burn-native` 正向 corpus：

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
fingerprint cache (chain + codeHash + proxy implementation + matcherVersion; shortlist/invalidation only)
        ↓
behavior-family candidate matcher
        ↓
candidate identity attest (target/token/root invariants; no seed/brand/implementation credential)
        ↓
family nonzero semantic probe
        ↓
verified route claims
        ↓
global arbitration / ownership / retry lifecycle
        ↓
shared category projector
  ├─ conversion -> token graph
  ├─ credit -> risk-gated position view
  └─ liquidity -> liquidity route/delta graph
        ↓
atomic runtime projection
```

共享层统一拥有：block range/cursor、receipt/trace 去重、RPC concurrency/deadline、positive/negative
cache、proxy fingerprint invalidation、retryable/permanent 分类、route ownership、歧义隔离、删除/保留语义、
graph projection、telemetry。family 文件不得出现自己的 block loop、`getLogs` cadence、cache 文件或 timer。
code hash 和 proxy implementation word 只决定结构 shortlist 缓存是否失效、是否重新 probe；它们不能提高
authority rank，不能成为 allowlist，也不能决定 candidate 属于哪个 family。positive semantic claim 另按
`(blockHash/stateRoot, amount-domain, probeVersion)` 缓存，并受短 TTL/块边界约束；即使 code/implementation
不变，storage 配置、余额或风险参数变化也必须触发 re-probe，不能把 fingerprint 当成永久准入凭证。

### 4.2 family 唯一允许不同的部分

每个 family 只声明/实现：

- 使用哪些候选源；若有 canonical registry/root，只声明 root 和一个 bounded enumerator，不拥有调度；
- event topics / call selectors 的廉价 shortlist；
- `candidateFromAddress` / `candidateFromObservedCall` 的行为候选匹配；
- 不依赖品牌/实例/codehash allowlist 的 on-chain behavior identity；
- nonzero semantic probe 和 `VerifiedRouteClaim`；
- edge derivation、quote、plan fragment、底层 action adapter 列表。

family id 也必须描述执行语义。`wsteth-compatible`、`self-burn-native` 这类 ABI/状态行为名是目标；
`mrethVariant`、`cashiva-*` 或地址/implementation 派生 id 禁止进入 production registry。已有以协议品牌命名
的 legacy family 在迁移时先证明其真正行为边界，再决定重命名或拆分，不能只做字符串替换。

### 4.3 最小接口改造

现有 `ProtocolDiscoveryCapability` 的 scanner 机制可以保留，但公共类型要上提为 route family，避免以后
credit/LP 复制一套：

```ts
type RouteCandidateSource =
  | { kind: "dex-token-domain" }
  | { kind: "observed-interaction" }
  | {
      kind: "canonical-registry";
      root: string;                 // 可 pin 的是身份/枚举根，不是 executable instance
      sourceVersion: string;
    };

type RouteFamilyKind = "protocol-conversion" | "credit" | "liquidity";

type RouteExecutionFamilyIdByKind = {
  "protocol-conversion": ProtocolExecutionFamilyId;
  credit: `credit:${string}`;
  liquidity: `liquidity:${string}`;
};

type RouteCandidateEvidence =
  | { kind: "address-domain"; address: string }
  | { kind: "observed-call"; txHash: string; callPath: string }
  | { kind: "registry-member"; root: string; memberKey: string };

/** Shared discovery input. It deliberately contains no PoolEntry or fixed token pair. */
interface RouteCandidate {
  readonly chainId: bigint;
  readonly target: string;
  readonly source: RouteCandidateSource;
  readonly evidence: readonly RouteCandidateEvidence[];
  readonly observedAtBlock?: bigint;
}

type VerifiedRouteClaim =
  | {
      kind: "protocol-conversion";
      tokenIn: string; tokenOut: string;
      protocolAction: "wrap" | "unwrap" | "convert" | "redeem" | "stake" | "unstake";
    }
  | {
      kind: "credit";
      collateralToken: string; debtToken: string;
      positionKey: string; riskModel: VerifiedCreditRiskSpec;
      leavesStandingPosition: true;
    }
  | {
      kind: "liquidity";
      inputs: readonly AssetDeltaSpec[];
      outputs: readonly AssetDeltaSpec[];
      lpToken: string; action: "add" | "remove";
    };

type RouteClaimFor<K extends RouteFamilyKind> =
  Extract<VerifiedRouteClaim, { kind: K }>;

interface IdentityAttestedRouteCandidate<K extends RouteFamilyKind> {
  readonly familyKind: K;
  readonly target: string;
  readonly identityProof: IdentityProof;
  readonly attestedAtBlockHash: string;
}

interface VerifiedRouteInstance<K extends RouteFamilyKind> {
  readonly identity: IdentityAttestedRouteCandidate<K>;
  readonly claims: readonly RouteClaimFor<K>[];
  readonly revalidateAtBlock: bigint;
}

interface RouteIdentityResolverDescriptor<K extends RouteFamilyKind> {
  readonly familyKind: K;
  resolve(
    candidate: RouteCandidate,
    ctx: RouteIdentityResolverContext,
  ): Promise<IdentityAttestedRouteCandidate<K> | null>;
}

interface RouteFamilyDiscoveryCapability<K extends RouteFamilyKind> {
  readonly candidateSources: readonly RouteCandidateSource[];
  readonly eventTopics: readonly string[];
  readonly callSelectors: readonly string[];
  readonly addressMatcherVersion?: string;
  candidateFromAddress?(...): Promise<RouteCandidate | null>;
  candidateFromObservedCall?(...): Promise<RouteCandidate | null>;
  enumerateFromRoot?(root, ctx): Promise<readonly RouteCandidate[]>;
  probeCandidate(
    candidate: IdentityAttestedRouteCandidate<K>,
    ctx: RouteFamilyProbeContext,
  ): Promise<readonly RouteClaimFor<K>[]>;
}

interface RouteFamilyBase<K extends RouteFamilyKind> {
  /** id 本身就是执行 family id；一个 id 只对应一种完整执行语义。 */
  readonly id: RouteExecutionFamilyIdByKind[K];
  readonly familyKind: K;
  /** production family 必须自带自动实例发现能力。 */
  readonly discovery: RouteFamilyDiscoveryCapability<K>;
  /** 与 execution 分层，但和 family 在同一个对象、同一次注册中交付。 */
  readonly discoveryIdentity: RouteIdentityResolverDescriptor<K>;
}

interface ProtocolConversionFamilyAdapter
  extends RouteFamilyBase<"protocol-conversion">,
    ProtocolConversionExecutionCapability {}

interface CreditFamilyAdapter
  extends RouteFamilyBase<"credit">,
    CreditExecutionCapability {}

interface LiquidityFamilyAdapter
  extends RouteFamilyBase<"liquidity">,
    LiquidityExecutionCapability {}

type RouteFamilyAdapter =
  | ProtocolConversionFamilyAdapter
  | CreditFamilyAdapter
  | LiquidityFamilyAdapter;
```

这里不能机械地写成 `RouteFamilyAdapter extends RouteLegAdapter`。当前 `RouteLegAdapter` 强制单一
`tokenIn/tokenOut/amountIn/amountOut`，它适合 conversion，却会把多资产 LP 和
collateral/debt/position credit 错误压平成 swap-like leg。三类 family 可以拥有不同的 quote/plan context
和 execution capability；共享的是同一个 `RouteFamilyBase`、同一套 discovery coordinator、同一次注册，
不是同一个单边 token 数据模型。

`enumerateFromRoot` 只允许做 family 专属的 bounded calls/decoding；range、deadline、cache、重试和生命周期
仍由 shared scanner 控制。没有可信 registry 的 family 不填这一项，不能伪造一个 root。

`RouteCandidate`、`IdentityAttestedRouteCandidate` 和 `VerifiedRouteInstance` 不能复用现有
`ProtocolCandidate.pool: PoolEntry` 或
`AttestedPoolEntry<PoolEntry>`；共享生命周期对象按阶段只携带 target/来源证据、身份证明或 typed claims。
`PoolEntry` 只能由 conversion projector 在验证之后生成，不能成为 credit/LP 的共同输入模型。

阶段顺序也必须保持单向：candidate → identity attestation（无 claims）→ behavior probe → typed claims →
`VerifiedRouteInstance`。不能让 identity resolver 读取尚未由 probe 产生的 claims，也不能复用绑定
`PoolEntry["adapter"]` 的现有 `IdentityResolverDescriptor`。

同样，`VerifiedRouteClaim` 不能等同于 `TokenEdge`。泛型把 `familyKind → execution capability → claim kind`
绑在一起，编译期阻止 credit family 返回 conversion claim；registry 在运行时仍要做 kind/exact-set 复核，
不能把 TypeScript 类型当作信任边界。

共同 coordinator 对三种 claim 做 identity、ownership、arbitration 和 lifecycle；随后按 `familyKind` 进入三
个**共享类别 projector**，不是 per-family pipeline：conversion projector → token graph；credit projector →
standing-position/risk-gated strategy view；liquidity projector → liquidity route graph。LP 单进单出在 taxonomy
落地后可映射成 edge，多资产 LP 保持 delta/DAG，禁止伪装成单 `TokenEdge`。

`PRODUCTION_ROUTE_FAMILIES: readonly RouteFamilyAdapter[]` 是唯一真相源；route registry、discovery identity
registry、candidate topic/selector union、mempool targets 与 category projectors 都从它派生。Identity 与
Execution 仍是两层能力，但由同一个 family adapter 一次性交付、一次注册，不能要求调用方“注册 adapter
后再注册 family”。

### 4.4 三个必须先补的共享安全缺口

1. **dynamic identity 不能只给 ERC4626 特判。** 当前 discovery identity registry 只有 ERC4626
   被替换成 on-chain resolver；其他 family 即便添加 matcher，仍会因 discovery 的 `seedEntries=[]`
   在 identity 阶段被 `untrusted_seed` 拒绝。必须由每个 `RouteFamilyAdapter.discoveryIdentity` 为自己
   提供 resolver。
2. **verified claims 必须由新的 RouteFamilyRegistry 通用强制。** 当前 `PoolEntry` 注释声称 discovery pool
   只重建 probe 通过的 route，但真正的限制只写在 ERC4626 `buildEdges` 内。不能把三类 claim 塞进现有
   `RouteLegRegistry`；它只接收 `RouteLegAdapter/PoolEntry/TokenEdge`。新的 category-neutral registry 必须在
   projector 之前对 identity 输出与 verified claim 做 kind + exact-set 比对；多一条、少一条或 metadata
   漂移都 fail closed。只有 conversion projector 产出的 `PoolEntry/TokenEdge` 再进入现有 RouteLegRegistry。
3. **LP 不能直接复用当前 TokenEdge projection。** 当前 runtime `SlotKind` 没有 liquidity，`lp` 只是
   analysis vocabulary。先新增独立 liquidity taxonomy/projector，并证明 conservation；在此之前 LP family
   只能完成 shadow discovery/identity/probe，不能被通用 coordinator 误投进生产 token graph。

## 5. 每个 family 怎么接同一条管道

下表左列是当前 legacy 名称，只用于定位现有代码；目标 family 按右列的行为边界实现。右列名称仍须由 fixture
证明，不能因 ABI 看起来相似就合并。

| 当前代码 | 目标 behavior family | 首选自动候选源 | identity / probe 的关键 | fallback 删除条件 |
|---|---|---|---|---|
| ERC4626 | `erc4626-standard` | DEX token + observed Withdraw/redeem | 标准接口自洽 + causal payout + nonzero deposit/redeem | 现有 21 个实例逐个 no-seed Production Replay |
| wstETH | `steth-wrap-compatible` | DEX token | `stETH()/wrap/unwrap/rate-view` 全套行为 + 双向 nonzero sim | 动态地址召回、双边 replay 与 graph 等价 |
| GOLDx | 待行为验收命名，候选 `fixed-unit-collateral-mint` | DEX token + observed mint | `unit()` 仅 shortlist；实际 collateral spend → token mint/output | no-seed source 召回 + mint replay |
| RockSolid | 待行为验收命名，候选 `sync-deposit-share` | DEX token + observed deposit | quote view 仅 shortlist；实际 asset spend → share mint | no-seed source 召回 + nonzero deposit replay |
| PSM | 待行为验收命名，候选 `gem-dai-converter` | canonical registry/root（若确认）+ observed call | pair view + 双向 actual balance delta/sim | root/observed 自发召回 + 双向 replay |
| Metronome synth | 待行为验收命名，候选 `synthetic-pool-convert` | canonical pool/controller root + observed call | 从 graph/call 得 token 候选，再以 membership + actual swap delta 验证 | 现有 routes 自发枚举且 exact-set 等价 |
| Metronome hgUSDC | 待行为验收命名，候选 `curve-vault-composite-exit` | canonical root + observed exit | attest 完整多合约 path 与 whole-plan delta，不能泛化成任意 ERC4626 | 复合路线自发召回 + whole-plan replay |
| 新增 | `self-burn-native` | DEX token + observed self-transfer/burn | actual `transfer(self)` → exact token spend + burn + causal native payout | tx43 + 3 个同类历史样本 replay |

注意：

- `steth-wrap-compatible/fixed-unit-collateral-mint/sync-deposit-share/self-burn-native` 的 instance 本身通常是
  token，能由 DEX universe 主动地址扫描发现；
- `PSM/Metronome` target 通常不是 DEX token。fresh node 若没有可信 registry/root，只能在第一次 supported
  landed interaction 后发现并持久化。文档和日志必须明确 `source=observed`，不能声称 cold-start 穷举；
- 当前 PSM 是唯一 `requiresProtocolEdgesFlag=false` 的 protocol family，而 registry 禁止 ungated discovery。
  迁移时动态 PSM 必须经过 coordinator 的 `protocolEdgesEnabled`；静态 grandfathered PSM 可在 replay
  完成前保留。不能为了加一个 `discovery` 字段就把安全门绕掉。

## 6. `declaredVenues` 的最终语义

这次不是粗暴删除所有 hardcode，而是分清两类：

- **允许保留：** canonical registry/factory/controller/singleton 身份根，用于枚举或 attestation；
- **最终应删除：** 直接把 executable instance + token pair 无条件塞进图的 compatibility row。

这保留 D-005 对**被动 observed trace** 的限制：一笔 landed 行为只能提名 candidate，不能单独 admission，
因为它可能是选择性行为或蜜罐。这里新增的行为身份是另一回事：shared backend 在 pinned state 上主动准备
输入、执行 production calldata、核对完整 state delta，再由独立 final sim 复核。它不依赖协议名、实例地址或
implementation allowlist，符合“derive identity on-chain”的规则。

本计划重新打开 D-005 中“单例可以永远 declared-only”的暂缓项：用户现在明确要求它们接入自动 discovery。
每个 family 的旧 `declaredVenues` 先作为兼容 fallback 保留，dynamic 路径在隔离 replay 中必须排除它；当
no-seed recall、active behavior probe、六步验收全部通过后，才在该 family 的独立提交中删除 fallback。
不得一次清空 6 个 venue。

静态 row 存在时，production projection 会 `staticSuppressed` 动态同址结果，所以迁移验证必须显式：

1. shadow 比较动态 claim 与静态 edge；
2. 在测试/Production Replay 输入中移除该 family 静态 row；
3. 证明 dynamic 自发召回并得到相同 route；
4. 再删生产 fallback。

## 7. 实施顺序

### Slice 0 — 共享骨架补强

- 增加 `RouteFamilyAdapter`，以 `PRODUCTION_ROUTE_FAMILIES` 为唯一注册表，从 adapter 自身派生 route
  registry、discovery identity registry、candidate filters 和 category projection；
- 增加 `candidateSources` 和共享 canonical-root 调度入口；
- 增加共享 `simulateValueDelta`：funded caller、token/native/totalSupply delta、logs/trace、绝对 deadline；
- 把 coordinator 输出从 `TokenEdge[]` 提升为 `VerifiedRouteClaim[]`，再交给共享 category projector；
- 新增 category-neutral `RouteFamilyRegistry`，在 projector 前通用强制 claim kind + exact-set；只有 conversion
  projector 输出进入现有 `RouteLegRegistry`；
- conformance：每个 production route family 必须有 discovery，或有带 owner/期限的 migration exemption；
- 加 protocol/credit/liquidity 三种 fixture，证明共用 scanner/cache/ownership，且 credit/LP 不会误投进
  protocol token graph；
- 保持现有 ERC4626 graph 和 admission 逐位不变，先证明没有回归。

### Slice 1 — `self-burn-native` 作为第二个真实 dynamic family

- 新增 generic behavior matcher/probe/quote/plan；production 文件零协议名、零实例地址、零 implementation
  allowlist；
- 对 DEX token candidates 统一运行 bounded behavior probe，MRETH 仅作为 fixture 中的第一个正例；
- tx43 与三个既有同类样本做 Adapter Replay + Production Replay；
- 同时让 multi-adapter arbitration 不再只靠 test-only fixture。

### Slice 2 — 地址可见的现有 family

依次把当前 `wstETH → RockSolid → GOLDx` 适配器收敛成经 replay 证明的 behavior family。每个 family
单独提交、单独 replay、单独删除 fallback；出现 identity/probe 歧义就停在 shadow，不影响其他 family。

### Slice 3 — 非 token target family

依次迁移 `PSM → Metronome synth → Metronome hgUSDC`。优先确认 canonical registry/root；没有权威枚举根
时使用 observed source + persisted ownership，不做全链 code census，不把当前 executable 地址伪装成 factory。

### Slice 4 — Credit family 接入同一管道

- 把 `compat:fluid-credit` 只作为迁移输入，不直接宣布 production-ready；
- 定义 `CreditFamilyAdapter` 的 position key、collateral/debt delta、risk spec 和 standing-position policy；
- shared discovery/probe/ownership 通过后，credit projector 默认仍拒绝普通套利提交；只有现有显式
  credit-live policy 授权才可进入对应 strategy view；
- Adapter Replay 必须证明 debt accounting、repayment/position conservation，不能只证明 calldata 不 revert。

### Slice 5 — Liquidity family 接入同一管道

- 新增 runtime liquidity taxonomy 和 shared liquidity projector；
- 先接 single-coin add/remove family，再处理多资产 delta/DAG；
- 可以复用现有 Curve LP 适配工作中的 quote/plan，但 discovery/cache/lifecycle 必须走本管道；
- LP mint/burn receipt 只作 candidate/evidence，active sim + conservation + final sim 才能 admission。

### Slice 6 — 清 compatibility debt

- ERC4626 21 条 legacy row 继续按既有 recall gate 清理；
- 清除已通过 Production Replay 的 6 个旧 `declaredVenues` executable rows；
- credit/LP 旧 compat row 只在对应 category replay 通过后清除；
- 保留真正的 registry/factory/controller roots；
- 更新 D-005 与 route-family discovery 文档，记录新边界和仍存在的 exception。

## 8. 六步验收（每个 family 都要，不能只验 tx43）

每个 family 至少一个正样本、一个 lookalike 负样本；复合/双向 family 每种执行语义各一个 fixture。

1. **Source / identity**：不把答案实例注入 candidate；shared source 自发产出，behavior identity 唯一通过；
2. **Claim / projection**：conversion edge exact-set；credit position/risk claim exact-set；LP asset-delta claim
   exact-set。任何 kind 投错 projector 都 fail；
3. **Enumeration**：scanner/planner 自发枚举目标 route/strategy，不能注入 path 或 amount；
4. **Quote / solve**：amount delta、sizing、risk/slippage 和 netProfit 逐 wei；family 自己拥有 rounding；
5. **Plan / final sim**：calldata/PlanFragment 结构正确，success/revert、gas、token/native/position conservation
   和净收益符合 fork；
6. **EV decision**：allow/reject 和 reason 正确；protocol/LP 正收益样本走到 production EV；credit 没有显式
   live policy 时应正确拒绝。全程不广播真钱。

验收分两层：

- Adapter Replay：可以 pin route/claim，但 amount 必须由对应 production solver 选；证明 execution family 正确；
- Production Replay：只给 historical tx/state anchor，不给 route/amount；证明自动发现、category projection
  和生产漏斗正确。

共享 scanner/registry/lifecycle 属系统性改动，因此全部 deterministic replay 通过后，还要走 Hermes paired A/B，
比较 graph hash、candidate composition、RPC/cache、warm 后 pass latency、budget censoring 和 final-sim false
positive。六步 checker 仍是可运行的诊断/验收项目，不重新做成部署强制开关；若 checker 本身有 bug 可以人工
裁决并修 harness，但相关 family 在对应步骤重新通过前不能标 `fixed`。

## 9. 负例与资源门

必须覆盖：

- 普通 ERC20 也有 `transfer`，但没有完整 self-transfer → burn → causal native payout，不得被
  `self-burn-native` 认领；
- 伪造协议名、symbol、getter、proxy implementation 或 event，但 actual state delta 不成立的 lookalike；
- probe amount 成功、另一 solver amount 选择性 revert/少付；每次 quote 都必须取对应 amount 的模拟结果；
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

- `listener/src/searcher/venues/route-leg-adapter.ts`：`RouteFamilyAdapter`、candidate source、route-claim union；
- `listener/src/searcher/venues/production-registry.ts`：单一 route family registration 真相源；
- 现有 `observed-protocol-discovery.ts` / `protocol-discovery-runtime.ts`：原地泛化为 route-family 共享
  scanner/runtime；允许后续重命名，但禁止复制 credit/LP 版本；
- `listener/src/shared/state/*` / prepared Revm backend：共享 `simulateValueDelta`，不增加 family 私有 runner；
- 新增 `listener/src/searcher/venues/route-family-registry.ts`：candidate/attested instance、verified claims
  exact-set 门与 kind/projector 一致性；
- `listener/src/searcher/venues/route-leg-registry.ts`：只接 conversion projector 产生的既有 TokenEdge；
- `listener/src/searcher/strategy-taxonomy.ts`：liquidity runtime taxonomy；credit standing-position 规则不放松；
- shared conversion/credit/liquidity projectors：同一 coordinator 的三种 category 投影，不含 family 扫描逻辑；
- `listener/src/searcher/venues/protocols/*-discovery.ts`：各 family matcher/identity evidence/probe；
- `listener/src/searcher/venues/protocols/self-burn-native.ts`：新 behavior execution family；
- credit/liquidity family modules：只实现 family hook，复用同一 scanner/cache/simulation/lifecycle；
- `listener/src/searcher/planner/token-graph.ts`：只随 family replay 成功逐项删除 legacy fallback；
- 现有 conformance、multi-adapter fixture、Adapter Replay、Production Replay 与 Hermes 报告。

## 11. 请 Fable 重点对抗的问题

1. `self-burn-native` 是否彻底不依赖协议名、实例、getter/codehash allowlist，并真的验证 causal payout？
2. `transfer(self)` 后 native payout 再 WETH wrap，现有 PlanFragment/BotVM 的余额语义是否可逐 wei复现？
3. `simulateValueDelta` 是否准确排除 gas、coinbase/builder transfer 和 sibling payout，并能硬取消超时？
4. `RouteFamilyRegistry` 的 claim exact-set 与 block/TTL re-attest 是否会产生短暂撤边或 stale claim？
5. PSM 在保留 grandfathered static route 时，如何保证 dynamic path 始终受 protocol flag 控制？
6. Metronome hgUSDC 的多合约 path identity 应放在一个 logical instance 还是复合 route fingerprint？
7. 哪些 family 真有可信 canonical registry/root，哪些只能诚实地标 `observed-after-first-use`？
8. 逐 family 删除 static fallback 时，`staticSuppressed`/ownership 是否存在短暂重复或撤边窗口？
9. credit claim 是否在任何默认路径都保持 `leavesStandingPosition=true`，不会被 conversion projector 洗白？
10. multi-asset LP 是否保持完整 asset delta/conservation，而不是被强行压成可套利的伪 `TokenEdge`？
11. 三种 kind 是否共用同一个 cursor/trace memo/cache/ownership，还是实现时又暗中长出三套 scheduler？

## 12. 完成定义

只有同时满足以下条件，本计划才完成：

- 7 个现有 production protocol family + `self-burn-native` 各自只有一个 `RouteFamilyAdapter` 注册项，且 adapter
  自带 discovery capability 和 dynamic identity resolver；
- scanner/cache/cursor/arbitration/lifecycle/projection 仍只有一套；
- 新增 family 只新增一个 adapter module 并加入唯一 family registry；不修改 `main.ts` protocol switch、
  不追加 identity 手工表、不手写 mempool target；
- 新增同 family 实例不改任何注册代码，由共享管道自动发现；
- credit 与 liquidity 至少各有一个 conformance/Production Replay fixture 经过同一 candidate→identity→probe→
  ownership 管道；credit 默认 risk gate、LP category projector 和 conservation 均按预期工作；
- 新增 credit/LP family 不创建新的 scanner、cache、cursor、timer 或 main orchestration；
- 每个 family 至少一个 Production Replay 自发走完六步；
- 所有可替代的 executable `declaredVenues` 已在各自 replay 后删除，保留项都有明确的 identity-root 理由；
- ERC4626 现有 admitted graph 无回归；系统性 Hermes A/B 资源与 warm 后性能无实质回退；
- `self-burn-native` production 源码/配置不含 MRETH、Cashiva、样本地址、implementation allowlist 或 fee
  variant；这些只存在于测试/研究证据；
- tx43 由 `self-burn-native` 自发枚举并 final-sim success 后，才允许从
  `implemented_not_validated` 升级状态。

## 13. 多方对抗审查（Codex 1 设计 · Claude 1 评审）

统一称呼：
- **Codex 1**：本计划（§0–§12）作者。
- **Claude 1（我）= 评审人**：以 `bcc7a42` 文档 + `origin/main @ 7f8b859` 源码为唯一裁准。

三条 load-bearing 代码断言已核（均属实）：`simulateCalls` 当前 `traceTransfers:false` 只返回
`{status,returnData,logs}`、无 native delta（§3.4 大致成立，但见 C-5）；`psm.ts` 确为
`requiresProtocolEdgesFlag:false`（§5 准）；`staticSuppressed` 机制在 `main.ts:1145` /
`protocol-instance-discovery.ts:741,794` 真实存在（§6 有依据）。

总评：方向正确、纪律吸收到位；`self-burn-native` 正确地补上了第二个 dynamic family，解决了此前
"单 adapter 下多-family 仲裁不可测"的问题。以下为 Claude 1 独立发现，Codex 1 未在文中覆盖。

### 13.1 分歧与发现表

| # | 议题 | Codex 1 原设计 | Claude 1 对抗发现 / 裁决 | 级别 |
|---|---|---|---|---|
| C-1 | 行为探测起始 state | funded-caller override 铸 candidate token 后执行 `transfer(self)`（§3.3/§3.4） | **override 会破坏 payout 不变量**：payout 常是 `nativeReserve×amount/totalSupply` 类读不变量公式，裸铸余额若不同步 totalSupply→比率错，同步→稀释错；`totalSupplyDelta===-tokenInSpent` 只抓 burn 侧、抓不到起始 state 不一致。**修法：同一 sim 内按 §3.1 真实路径从 DEX 池买入 candidate（USDT→MRETH 走真 UniV3 池），不用裸 override。** | **P1** |
| C-2 | gap 分类形态 | §0 固定 4 类 gap 对照表（按现象查表） | **分类是经验判定程序,不是查表**：新 family vs coverage gap 肉眼判不了,只能"跑遍现有 family probe→全 fail 且语义确新→新 family"。应改写成**决策程序**,否则会把"某 family 漏一个 direction"误判成新 family。 | **P1** |
| C-3 | family 粒度 | "1 family=1 execution semantics;任一语义不同就新增"（§0） | **边界不可判、要么爆炸要么含糊**：带提现费的 4626 算同 family 还是新 family?字面规则会让每个 fee/rounding 变体炸成新 family。**补一条线:family=相同 call-shape+相同 state-delta 类型;per-instance 量级(费率/汇率/rounding)是 probe 测的参数,非 family 边界。** | **P1** |
| C-4 | shadow family 仲裁 | LP/credit 在 shadow 跑 discovery/identity/probe/ownership,projector fail-closed（§4.4.3） | **shadow claim 必须与生产仲裁隔离**:`staticSuppressed`（已确认存在）+ 跨-family 仲裁下,一个不投影的 shadow LP/credit claim 可能在同 target 抑制掉真会投影的 conversion claim。须显式把 shadow claim 排除出影响生产投影的 ownership/仲裁。 | **P2** |
| C-5 | quote 时 sim 成本 | 每个 amount 取对应 `simulateValueDelta` 结果、按 amount 缓存（§9/§3.4） | **quote 的 amount 搜索变 sim-bound**:solver 对 amount 做 grid/GSS 时每个候选=一次完整 fork sim,不像 AMM 闭式报价;资源节只担心 candidate I/O、没提这个。**须补:此类 family 用更粗 amount 搜索或廉价本地模型,否则烧 solver 预算。** | **P2** |
| C-6 | self-burn-native 证据 | tx43+3 历史样本为正 corpus（§3.4/§1.3） | **正样本全是单品牌(Cashiva)**:主网"self-transfer→burn→native"真实实例可能就只有 Cashiva → "generic"当前不可证伪;真正挣来通用性的是**负样本(§9 lookalike fail)**而非正样本。应明说 family 是 behavior-defined 但**单品牌验证**。 | **P3** |
| C-7 | 立项依据 | 未引用 EV/频次 | **北极星 EV 门缺位**:按本项目入场门(频次/累计 EV),4 笔观测 arb+共享 simulateValueDelta backend 可能是 dust 级机器。**诚实定位:self-burn-native 的价值在"第二个 dynamic family 给仲裁提供可测性",不该靠自身 arb 价值立项**——这没问题,但要写明。 | **P3** |
| C-8 | simulateValueDelta 定位 | 表述为"唯一新增基础设施"、新 interface（§3.4） | 更准确:它是**现有 `eth_simulateV1` 路径的扩展**(打开 `traceTransfers`+解析 balanceChanges),不是全新 interface;framing 上认掉即可,不影响设计。 | 备注 |

### 13.2 最重要的实际分歧（三个 P1，Slice 1 前必须解决）

1. **funded-caller override 的 state 一致性（C-1）** 是唯一的真 soundness 洞：它会让 payout 探测在
   读不变量的 wrapper 上系统性失真,而 §8 六步的 final sim 只在**完整路线**层复核、未必能把"probe 起始
   state 不一致导致的 quote 偏差"和"真实执行"区分开(因为两者用同一个错误 override)。换成"同 sim 内走真
   DEX 腿买入"后,probe state 与真 arb 同源,这个洞消失。
2. **gap 分类程序化（C-2）+ family 粒度判据（C-3）** 是这份文档对外承诺的"固定分类"能否被低阶执行者
   正确套用的前提。缺这两条,分类会退化成"看着像新协议就建新 family",正是文档自己反对的品牌分支问题的
   变体。

### 13.3 最终裁决（Claude 1）

> 保留总体架构与 §7 实施顺序。**三个 P1(C-1 override 换真 DEX 腿买入、C-2 分类改决策程序、C-3 补
> parametric/categorical 粒度线)必须在 Slice 1 前落进文档并实现**;C-4 shadow 仲裁隔离、C-5 quote-sim
> 延迟、C-6 单品牌 corpus、C-7 EV 门定位须在文中显式认掉。三条代码断言 Claude 1 已核属实,C-8 仅
> framing 修正。P0 none(fork/dry-run + final sim fail-closed + 蜜罐仅假阳性)。当前维持
> `implemented_not_validated`,升 fixed 仍以 §8 六步 + Production Replay 自发枚举为准。

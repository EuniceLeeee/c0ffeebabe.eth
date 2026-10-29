# 公共 TS 修改：只补“JSON 无法表达”的模块（2026-10-29 修订）

## 原则（按用户要求修订）

1. **JSON 能忠实表达 → 不改公共 TS。** 原 TS 怎么写，不代表 JSON 必须逐字节/逐字段复刻。
2. 契约失败若只是**形状、顺序、地址大小写、错误文案、字节布局**差异，而语义等价：
   - 优先在测试/验收侧归一化（按 routeKey/methodId/语义查找，而不是 `[0]`/字节比较），或
   - 作为 documented deviation 接受。
   这些**不构成改 TS 的理由**。
3. 只有 JSON **完全无法表达**某能力（没有对应模块/操作）时，才新增通用模块；
   模块必须与协议无关，不能加协议分支、ABI 特判或单族例外。

---

## 一、必须补的模块（真实能力缺口）

### M1. oracleVictim（metronome-synth）
- 现状：v2 编译器拒绝 `protocol.oracleVictim`（`build-declarative-production.ts:141`），runtime 还要求同步
  `oracleVictim.decode`（`adapter-family-plugin.ts:2461-2466,4698-4751`），JSON 无法提供。
- 改法：v2 接受 `protocol.oracleVictim` 的声明式形式（含 decode 引用/模型），保持 hashed capability root。
- 解锁：`metronome-synth`。

### M2. 按方向选择 exact 报价程序（yieldbasis-lt）
- 现状：一个 variant 只有一份 `quoteFlow`/`chainQuote`/`steps`（`declarative-protocol.ts:140`、
  `declarative-quote-proof.ts:91-108`、`declarative-read-flow.ts:50-66`）。yieldbasis 的 withdraw 需要 view 证明、
  deposit 需要 effect-simulation 证明，二者不能共存。
- 改法：`exact.quoteFlows: { "<direction>": {...} }`（每方向独立 sourceKind/chainQuote/steps），
  `buildFragment` 按路由方向选择；可选 per-direction `execution.steps`。
- 解锁：`yieldbasis-lt`。

### M3. quoteOutput settlement + per-settlement 程序（psv / curve-lp / set-redemption）
- 现状：settlement 只支持 directOutput/deferredInput（`declarative-execution.ts:439-461`），
  且整个 variant 只有一份静态程序（`:40-47,112-113,268-272`）；`RuntimeSettlementCapabilities.quoteOutput`
  （`runtime-amount-program.ts:243`）无声明入口。
- 改法：
  1. `settlement.quoteOutput: true` 能力声明；
  2. `settlement.program`/`settlement.steps` 支持 per-settlement 覆盖；
  3. 允许声明只读嵌套 quote 程序（或复用 quoteFlow 输出）。
- 解锁：`psv`（核心）、`curve-lp`（per-direction settlement）、`set-redemption`（部分）。

### M4. 执行 codec：有界 uintN + 审计过的 raw call
- 现状：运行时 ABI 叶子只允许 uint256/bytes32（`declarative-call-codec.ts:27-29,43-46`）；v1 还要求全标量
  （`declarative-execution.ts:343-346`）；无法表达 `uint224`（mellow）和手工 selector 0xccee0802（ondo）。
- 改法：
  1. 支持 `uint8..uint248` 固定宽叶子（含 uint224）；
  2. 或允许 v1 标量 + 动态 `bytes32[]`；
  3. 可选 `rawCall: { selector, words }`，仅白名单/已审计 selector。
- 解锁：`mellow-queue`、`ondo-usdy`、`set-redemption`（部分）。

### M5. 提名 fan-out 与双通道
- 现状：nomination read flow 只能返回单对象/null（`declarative-nomination.ts:62-66`）；
  `txSeedNominations` 只在 tx-evidence 模式设置（`declarative-discovery.ts:266-272`）。
- 改法：
  1. 允许返回 opaque 数组（每元素一条 observation）；
  2. 允许 tx-seeded 与 address-surface 并存；
  3. 可选 reverseBinding 声明。
- 解锁：`yearn-auction`、`few-wrapped`、`set-redemption`（部分）。

### M6. simulation setup 与 receipt 扩展（few-wrapped）
- 现状：declarative simulation 禁止任意 preCalls/funding/setup（`declarative-simulation.ts:46-48,71-80,122-129`）；
  `programReceipt` 只覆盖固定形状，无法表达多 token delta + supply + native + logs 组合。
- 改法：允许声明受保护地址白名单内的 funding/preCalls/setup；receipt 支持多 delta/supply/native/logs。
- 解锁：`few-wrapped`（部分）。

### M7. 多资产执行 fan-out / 嵌套程序 / log 操作
- 现状：execution 强制一 debit 一 credit（`declarative-execution.ts:161-168`），steps 静态数组（`:26-33,244-298`），
  单 action node（`declarative-protocol.ts:650-671`）。
- 改法：
  1. steps 支持 `forEach: "$descriptor.components"` 动态展开；
  2. 允许嵌套 program 引用；
  3. 增加 log 操作与 per-account conservation 检查。
- 解锁：`set-redemption`、`curve-lp`（TwoCrypto fee claim）、`few-wrapped`（部分）。

### M8. direct-calldata action 声明（set-redemption）
- 现状：声明式 action 只能编码 runtimeAmountProgram（`declarative-execution.ts:471-492`）；
  TS Basic action 是直接 `redeem(address,uint256,address)` calldata。
- 改法：允许 `action.encode: { signature, args }`（无 runtime 金额时直接 ABI 编码），保留现有 program 模式。
- 解锁：`set-redemption`（Basic 方向）。

### M9. 只读 runtime-proof 原语（token-conversion，可选）
- 现状：BTB 资产依赖闭包要遍历字节码 opcode（`variants.ts:32-49`），JSON 值操作没有字节码索引/循环。
- 改法：新增 sanctioned 只读 `runtimeProof` 操作（输出依赖集合），或注册“依赖闭包”证明模型；
  严格只读，不进入执行路径。
- 解锁：`token-conversion`。不做则该族保持 blocked。

---

## 二、不改 TS 的项（测试侧归一化或接受差异）

| 现象 | 涉及族 | 处理 |
|---|---|---|
| 路由被追加 `target/adapterId/direction`，测试把 TS route 喂给 plugin 后 `assertInvocation` 失败 | curve-lp、psv | 测试按 routeKey/字段语义匹配，或接受 documented deviation；不改框架 |
| 路由地址 EIP-55 vs lowercase | badger | 测试侧统一大小写；或接受（地址等价） |
| `exact.methods[0]` 取到 local-zero | token-migration | 测试按 methodId 查找；排序不是语义 |
| `pricing.static.refreshPolicy` 标记缺失 | psv | 行为已由 `refreshPolicyForInstance` 决定；测试检查放宽或补声明字段（若已有等价字段） |
| 错误文案 `/unresolved/` vs typed error | token-migration、arcana | 按错误类型/语义断言，不按字符串 |
| 执行字节/call 数量不同（自动 captures/unchanged-native） | psv、curve-lp、badger | 比较调用集合与效果，不做 byte equality；行为已由负例覆盖 |
| `inspectRuntime` 零数据 fixture | boring、peapods、psv | 测试注入余额/调用 fixture（框架测试工具改动，非协议框架） |

这些差异不改变协议语义，**不应驱动公共 TS 修改**；如果团队希望契约测试原样通过，应改测试工具/断言方式。

---

## 三、每族最终映射

| Family | 真实缺口 | 结论 |
|---|---|---|
| badger | 无（仅形状/大小写/字节） | 不改 TS；测试侧归一化后可转正 |
| token-migration | 无（仅顺序/文案/staticEvidence） | 不改 TS；测试侧按 methodId/语义断言 |
| psv | M3（quoteOutput/per-settlement） | 补 M3；route 形状走测试侧 |
| curve-lp | M3 + M7 | route/native fixture 走测试侧 |
| yieldbasis-lt | M2 | 补 M2 |
| metronome-synth | M1 | 补 M1 |
| ondo-usdy | M4 | 补 M4 |
| mellow-queue | M4 | 补 M4 |
| yearn-auction | M5 | 补 M5 |
| few-wrapped | M5 + M6（+M7 部分） | 补 M5/M6 |
| set-redemption | M5 + M7 + M8 | 补 M5/M7/M8 |
| token-conversion | M9（可选） | 不做则保持 blocked |

## 四、建议顺序

1. M1（最小）→ metronome-synth；
2. M2（单行级）→ yieldbasis-lt；
3. M4（codec）→ mellow/ondo；
4. M3（settlement）→ psv/curve-lp；
5. M5 → yearn；
6. M6/M7/M8 → few-wrapped/set-redemption；
7. M9 视投入决定。

每组完成后验收：
```
npm run family-capability-manifest:generate
npm run build:live
npm run family-capability-manifest:check
node --import tsx --test src/searcher/test/declarative-*.test.ts
# 对应 family 契约/lifecycle
```

---

## 五、按 app-run2 上架范围收敛（2026-10-29 二次修订）

app-run2 `production-families` 中 `enabled: true` 的非 swap 协议族：
`astra-multitoken, badger-sett-withdraw, eigenpie, erc4626-silo-redeem, erc4626,
ethertoken-native-redeem, goldx, metronome-hgusdc, metronome-synth, psm, rocksolid,
self-burn-native, set-redemption, token-conversion, token-migration, wsteth`。

其中尚未适配通过的只有 5 个：**badger / token-migration / metronome-synth /
set-redemption / token-conversion**。下面只针对这 5 个提改动；未上架族（compound、peapods、
psv、curve-lp、yieldbasis、ondo、mellow、yearn、few-wrapped、olympus、metafactory、
origin-*、arcana、boring、default-collateral）**暂不改 TS**。

### P1. badger —— 不需要新模块（优先测试侧）
- 现状：JSON 能表达；契约 12/16，失败全部来自测试 fixture 把声明式 route 喂给**手写**
  `exact.ts/routes.ts`（`routes.ts:13` 的 `assertRoute`），以及地址 EIP-55 大小写。
- 改动选择（二选一）：
  - **推荐（测试侧，不改框架）**：`badger-sett-withdraw-family/test/fixture.ts` 的
    `collect()` 改用 `plugin.exact.methods(input)` 返回的 `program`，不再 import `../exact.js`；
    地址比较统一 `toLowerCase()`。
  - 若必须保持测试原样：框架加 `routes.exact` 模式（不追加 `target/adapterId/direction`）
    + 地址按声明大小写输出（`declarative-protocol.ts:100-109,220-232`）。
- 结论：**框架零改动即可，优先测试适配**。

### P2. token-migration —— 3 个小 API 兼容（约 20 行）
1. `exact.methods` 顺序：现在 local-zero 永远在第一个（`declarative-protocol.ts:539-546`），
   测试/消费方按 `methods[0]` 取正报价。改为：**local-zero 追加到末尾**，或允许
   `exact.methodOrder` 声明。
2. `pricing.static` 可省略：`finalizePricingDescriptor` 要求 `input.staticEvidence`
   （`declarative-protocol.ts:412`），TS 该族没有 static 阶段。改为：JSON 未声明
   `pricing.static` 时跳过该证据（或允许 `static: null`）。
3. 错误文案：`declarative-identity.ts:108-111` 抛 typed `RequiredAdapterRequestError`，
   测试断言 `/unresolved/`。改为：message 保留 `unresolved` 语义（如 `identity unresolved: ...`）
   或允许 JSON 声明 `identity.unresolvedMessage`。
- 结论：改 3 处编译器行为，风险低，改完 12/12。

### P3. metronome-synth —— oracleVictim（1 个模块）
- 位置：`build-declarative-production.ts:141` 拒绝 `protocol.oracleVictim`；
  `adapter-family-plugin.ts:2461-2466,4698-4751` 要求同步 `oracleVictim.decode`。
- 改法：v2 允许 `protocol.oracleVictim` 声明（含 decode 引用/已注册 victim 模型），
  保持 hashed capability root 与能力清单不变。
- 风险：中；victim 是 capability root，需补负例（错误 oracle/缺 decode 拒绝）。

### P4. set-redemption —— 三项结构性能力
1. **提名 fan-out + 双通道 + reverseBinding**
   - `declarative-nomination.ts:62-66` 只允许单 opaque/null；
   - `declarative-discovery.ts:266-272` txSeed 仅 tx-evidence。
   - 改法：允许返回 opaque 数组（每元素一条 observation）、txSeed 与 address-surface 并存、
     可选 reverseBinding 声明。
2. **多资产执行 fan-out / 嵌套程序**
   - `declarative-execution.ts:161-168` 强制一 debit 一 credit；`:26-33,244-298` 静态 steps；
     `declarative-protocol.ts:650-671` 单 action node。
   - 改法：steps 支持 `forEach: "$descriptor.components"` 动态展开，每项允许独立 debit/credit/effect；
     允许嵌套 program 引用；补 log 断言操作。
3. **direct-calldata action**
   - `declarative-execution.ts:471-492` 只会编码 runtimeAmountProgram。
   - 改法：允许 `action.encode: { signature, args }`（无 runtime 金额时直接 ABI 编码）。
- 风险：高（执行图与提名预算），需要上限保护与负例。

### P5. token-conversion —— 只读 runtime-proof（最后做）
- 位置：`declarative-values.ts:22,217-218`（闭集 op，无字节码索引/循环）；
  TS 依赖闭包是 EVM opcode 遍历（`variants.ts:32-49`、`asset-runtime.ts:20-47`）。
- 改法：新增 sanctioned 只读 `runtimeProof` 操作（输出依赖集合），或注册“依赖闭包”证明模型；
  严格只读、不进入执行路径、不承载 ABI/授权。
- 风险：高；若投入不允许，该族保持 blocked（上架族里唯一可能长期阻塞的）。

### 建议顺序与验收
1. badger：测试 fixture 改造（不动框架）→ 契约 16/16；
2. token-migration：P2 三处小改 → 契约 12/12；
3. metronome-synth：P3 → 契约 + lifecycle；
4. set-redemption：P4（分 3 小步，每步跑原契约）；
5. token-conversion：P5（视投入）。

每步之后：
```
npm run family-capability-manifest:generate
npm run build:live
npm run family-capability-manifest:check
node --import tsx --test src/searcher/test/declarative-*.test.ts
# 对应 family contract/lifecycle
```

---

## 六、逐项必要性审计：协议语义 vs 当时 TS 写法

判定标准：
- **必须**：协议行为本身要求该能力，JSON 没有等价表达，去掉就是收窄/改变语义。
- **写法**：TS 当时的编码/接口/优化选择；JSON 可换一种表达，或测试侧适配即可。

### 上架族

| Family | 缺口 | 判定 | 依据 / 替代 |
|---|---|---|---|
| badger | sequential trial / prefix 报价 | **写法（优化）** | `trial-state.ts` 只是多腿复用与前缀本地报价；单腿 exact 无需它。可声明 `localStateUnsupportedReason` fail-closed，测试改为断言“前缀回退”，核心撤资不受影响 |
| badger | 路由地址大小写、追加 `target/direction`、运行时字节布局 | **写法** | 语义/地址等价，测试侧归一化即可 |
| metronome-synth | `oracleVictim` 的 runtime detection（受影响边 + 价格探针刷新） | **必须** | `victim.ts:26-50` 是真实的 oracle 操纵检测/刷新触发；JSON 无对应运行时能力。其 discovery decode 本身可用 call pattern + 谓词表达（部分可 JSON） |
| set-redemption | 一次赎回给 N 个 basket token（多 debit/credit） | **必须** | `execution.ts:16-42` 组件循环 + 每个 receipt 校验是协议语义；单 debit/credit 表达不了 |
| set-redemption | 嵌套 subscript program | **写法** | 分片是 EVM 栈/脚本实现技巧；framework 可用 `forEach` 展开替代 |
| set-redemption | direct Basic action 编码、reverse binding | **写法** | direct action 是编码格式；reverse binding 是发现通道之一（surface 通道仍可准入） |
| token-conversion | BTB 资产的 opcode-walk 依赖闭包 | **写法（保守安全证明）** | 目的是证明“资产运行时不外呼”，从而安全刷新；可替代为更保守策略（未知资产每次刷新/标为高波动），不是协议数学。若接受保守刷新，可不做该模块 |
| token-conversion | xWin 部分（Map/trial） | 已支持 | 6876fef0 §5 已支持 Map；不需要新模块 |

### 未上架族（暂不改 TS，仅记录判断）

| Family | 缺口 | 判定 | 依据 / 替代 |
|---|---|---|---|
| psv | `quoteOutput` settlement | **必须** | 结算要走 preview/quote 腿，协议语义（`runtime-quote.ts`），不是编码选择 |
| yieldbasis-lt | 每方向 exact quote（view vs effect-simulation） | **必须** | deposit 必须执行自身 program 才能得到报价；共用一份 quoteFlow 只能二选一 |
| ondo-usdy | raw selector `0xccee0802` helper 调用 | **必须（除非恢复 ABI）** | 实际执行字节就是该 selector+9 words；JSON 只支持 ABI 签名。若拿到 helper ABI 可改为普通调用 |
| mellow-queue | `uint224` 运行时叶子 | **写法（编码限制）** | deposit 的 `bytes32[]` 实际是空数组（`execution.ts:25`），只有 uint224 金额需 patch；uint224 与 uint256 都是 32 字节字，加一个 bounded-uintN 叶子或带范围检查的 uint256 patch 即可 |
| yearn-auction | 每次枚举产生多条 observation（每个 enabled auction 一条） | **必须** | 发现语义就是“枚举注册表里的多个 auction”；单对象提名会漏拍 |
| few-wrapped | simulation 任意 setup/funding、receipt 多 delta/logs | **必须** | 其 probe 需要 approve/funding/setup 与完整 receipt；不做就无法构造真实证明 |
| few-wrapped | 双提名通道 | **写法（冗余）** | 可只保留一条通道，但会减少发现入口（属收窄，需明确接受） |
| curve-lp | 路由 identity（target/direction）、native fixture、stub | **写法** | legacy lineage 本身可表达；失败来自测试按 TS route 形状/字节断言 |
| curve-lp | NG/generic 的 per-direction settlement、嵌套 fee-claim program/log 操作 | **必须（对 NG/generic）** | 这些方向的结算/费用提取是协议语义；legacy-only 可不做 |
| token-conversion | 同 BTB opcode-walk | **写法（保守证明）** | 同上，可用保守刷新替代 |
| psv/curve-lp/yieldbasis/ondo/mellow/yearn/few-wrapped | — | 未上架 | 按 app-run2 范围，暂不改 TS |

### 结论（上架族里真正必须补的）

只集中在 3 个族：
1. **metronome-synth**：oracle-victim runtime detection；
2. **set-redemption**：多资产 execution fan-out（其余用 `forEach`/测试适配解决）；
3. **token-conversion**：可先不做——用保守刷新策略替代 opcode-walk（若业务接受“未知资产更频繁刷新”）。

`badger` 不需要新模块：放弃 sequential trial（fail-closed）即可适配，核心撤资/报价不受影响；
`token-migration` 已完成。

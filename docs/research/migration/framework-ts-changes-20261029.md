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

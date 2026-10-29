# 声明式框架公共 TS 修改清单（一次性提案，2026-10-29）

目标：在不放松 Family 语义的前提下，解锁当前 12 个阻塞族中可忠实表达的部分。
每条给出最小改法、影响族、风险；按“小改 → 结构性扩展”排序。

约定：所有引用基于 `work/protocol-json-20261028`（框架 6876fef0）。

---

## 阶段 1：小改（低风险，优先做）

### T1. 路由身份不再强制追加字段
- 位置：`listener/src/searcher/venues/declarative-protocol.ts:100-109,220-232`
- 现状：每个 route 强制加 `target`、`adapterId`、`direction`，`fields` 的 reserved 列表禁止覆盖这些键；
  routeKey 默认 `familyId␟bindingKey␟directionId`。
- 改法：新增 `routes.exact: true`（或 `routes.shape`）模式：要求 JSON 显式声明 `target/adapterId/direction/routeKey`
  （`routes.key` 已存在），此时不追加默认值、不做 reserved 覆盖限制；保持现有默认模式不变。
- 解锁：`curve-lp`（B1/B5）、`psv`（route shape）、`badger`（若同时做 T2）、`few-wrapped`（部分）。
- 风险：低；只影响显式选择 exact 模式的 family。

### T2. 路由地址大小写按声明保留
- 位置：`declarative-protocol.ts:220-232`（`getAddress` 强制 EIP-55）
- 改法：exact 模式下允许 `addressCase: "as-declared" | "lower"`；或统一输出 lowercase 与 TS 一致。
- 解锁：`badger`（5 条契约失败）、`psv`（部分断言）。
- 风险：低；需检查 routeKey/副作用一致性。

### T3. exact 方法顺序可声明
- 位置：`declarative-protocol.ts:531-559`（框架把 local-zero 放前面）
- 改法：允许 `exact.methodOrder: ["local-zero","<positive>"]`，或把 local-zero 默认追加到末尾。
- 解锁：`token-migration`（6/8 失败）。
- 风险：低；消费方按 `methods[0]` 取正报价的假设需要回归。

### T4. pricing.static 增加可选 refreshPolicy
- 位置：`declarative-protocol.ts:393-398`
- 改法：允许 `static.refreshPolicy: "each-block" | "on-touch" | ...`，仅作声明与校验。
- 解锁：`psv`（1 条契约）。
- 风险：低。

### T5. 错误/消息面稳定化
- 位置：`declarative-identity.ts:108-111`（typed `RequiredAdapterRequestError`）、`declarative-discovery.ts` 等
- 改法：允许 JSON 声明 `identity.unresolvedMessage`/`errorText`，或让 typed error 保留 `/unresolved/` 文案。
- 解锁：`token-migration`（1 条）、`arcana`（部分文案差异）。
- 风险：低；不得改变 retryable/terminal 语义。

### T6. oracleVictim 支持
- 位置：`build-declarative-production.ts:141`、`adapter-family-plugin.ts:2461-2466,4698-4751`
- 改法：v2 编译器接受 `protocol.oracleVictim`（含同步 `decode` 的 JSON 形式，或引用已注册 victim 模型）。
- 解锁：`metronome-synth`。
- 风险：中；victim 是 hashed capability root，必须保持身份/能力完整性。

---

## 阶段 2：结构性扩展（中风险）

### T7. 多方向 exact 报价程序
- 位置：`declarative-protocol.ts:140`（单 quoteFlow）、`declarative-quote-proof.ts:91-108`（单 proof kind）、
  `declarative-read-flow.ts:50-66`（单 step list）
- 改法：允许 `exact.quoteFlows: { "<direction>": {...} }`（每方向独立 sourceKind/chainQuote/steps），
  并让 `buildFragment` 按 route/direction 选择；可选 per-direction `execution.steps`。
- 解锁：`yieldbasis-lt`（G-YB5，draft 只差这一行）。
- 风险：中；需保证同一 descriptor 下方向级选择的确定性与缓存键。

### T8. quoteOutput settlement + per-settlement 程序
- 位置：`declarative-execution.ts:439-461`（仅 directOutput/deferredInput）、`:40-47,112-113,268-272`
  （单一静态程序）、`runtime-amount-program.ts:243`
- 改法：
  1. `settlement.quoteOutput: true` 能力声明；
  2. `settlement.program`/`settlement.steps` 允许 per-settlement 覆盖；
  3. 允许声明一个只读嵌套 quote 程序（或直接复用 quoteFlow 输出）。
- 解锁：`psv`（核心）、`curve-lp`（B3）、`set-redemption`（部分）。
- 风险：中高；涉及结算与 program 选择路径，需要新增负例（错误 settlement 拒绝）。

### T9. 执行命令 codec 扩展
- 位置：`declarative-call-codec.ts:27-29,43-46`（仅 uint256/bytes32 叶子）、`declarative-execution.ts:343-346`
  （v1 要求全标量）
- 改法：
  1. 支持有界固定宽 `uintN`（uint8..uint248，含 uint224）作为运行时叶子；
  2. 或允许 v1 标量参数与动态数组（`bytes32[]`）混用；
  3. 可选 escape hatch：`rawCall: { selector, words }`（严格模式，仅白名单 family）。
- 解锁：`mellow-queue`（uint224）、`ondo-usdy`（raw selector 0xccee0802）、`set-redemption`（部分）。
- 风险：中；rawCall 必须限制为已审计 selector，防止绕过 ABI 校验。

---

## 阶段 3：大扩展（高影响，建议单独立项）

### T10. 提名 fan-out 与双通道
- 位置：`declarative-nomination.ts:62-66`（单对象/null）、`declarative-discovery.ts:266-272`（txSeed 仅 tx-evidence）
- 改法：
  1. nomination read flow 允许返回 opaque 数组（每元素一条 observation）；
  2. 允许 `txSeedNominations` 与 `address-surface` 并存；
  3. 可选 reverseBinding 声明。
- 解锁：`yearn-auction`、`few-wrapped`、`default-collateral`（恢复 recent-call seed scan）、`set-redemption`。
- 风险：中高；候选数量放大，需要预算/上限保护。

### T11. 任意 simulation setup 与 receipt 扩展
- 位置：`declarative-simulation.ts:46-48,71-80,122-129`、`declarative-execution.ts:178-202`
- 改法：
  1. 允许声明 funding/preCalls/setup（受保护地址白名单）；
  2. receipt 支持多 token delta + supply + native + logs（不仅 programReceipt 固定形状）；
  3. execution 允许关闭自动 balance captures（或声明 capture 集合）。
- 解锁：`few-wrapped`、`psv`（字节/调用数）、`curve-lp`（B2）、`set-redemption`。
- 风险：高；涉及 VM 授权边界，必须保持“无任意 VM bytes/替代 caller”的红线。

### T12. 多资产执行 fan-out / 嵌套程序 / log 操作
- 位置：`declarative-execution.ts:161-168`（一 debit 一 credit）、`:26-33,244-298`（静态 steps）、
  `declarative-protocol.ts:650-671`（单 action node）
- 改法：
  1. steps 支持 `forEach: "$descriptor.components"`（动态 fan-out，每项产生 debit/credit/effect）；
  2. 允许嵌套 program 引用（`program: "sub"`）；
  3. 增加 log 操作（emit/expect log）与 per-account conservation 检查。
- 解锁：`set-redemption`、`curve-lp`（B4 TwoCrypto fee claim）、`few-wrapped`（部分）。
- 风险：高；执行图复杂度与验证成本显著上升。

### T13. 通用 runtime proof 原语（opcode walk）
- 位置：`declarative-values.ts:22,217-218`（闭集 op，无字节码索引/循环/opcode 分类）
- 改法：新增 sanctioned `runtimeProof` 值操作（只读字节码遍历，输出依赖集合），或允许注册
  “dependency closure” 证明模型（不是把 ABI/授权藏进 math）。
- 解锁：`token-conversion`（BTB/xWin）。
- 风险：高；需严格限定为只读证明，不进入执行路径。

### T14. 执行/路由的 per-direction 与字节布局兼容开关
- 位置：`declarative-execution.ts:153-157`（强制 unchanged-native）、`:300-301`（captures）
- 改法：允许 family 声明 `execution.compat: "legacy-bytes"`（关闭自动 capture/native 检查，
  由 family 自带 checks 补回）。
- 解锁：`psv`、`curve-lp`、`badger`（字节断言）、`token-migration`（部分）。
- 风险：中高；等价性由 family 负例保证，不能默认开启。

### T15. 测试侧（非框架，但决定“通过”口径）
- `runtime-program-testkit.ts` 的 `inspectRuntime` 增加可注入余额/调用 fixture（或允许声明
  “captures 由测试提供”），解决 boring/peapods/psv 等“零数据 fixture”失败。
- 对 `plugin.exact.methods[0]`、`route` 字段形状等消费假设，统一改为按 methodId/routeKey 查找，
  避免顺序/形状变化被当成行为回归。

---

## 每族 → 最小修改映射

| Family | 需要的条目 | 备注 |
|---|---|---|
| badger | T1 + T2（+T14 可选） | 5 条地址大小写断言 |
| token-migration | T3 + T5 | 6 条 methods[0] + 1 条 staticEvidence + 1 条文案 |
| psv | T1 + T4 + T7/T8 + T14 | quoteOutput 是核心；route shape 次之 |
| curve-lp | T1 + T8 + T12 + T14 | B1 route identity + B3 settlement + B4 嵌套 |
| yieldbasis-lt | T7 | 每方向 quoteFlow/proof |
| metronome-synth | T6 | oracleVictim |
| ondo-usdy | T9 | raw selector |
| mellow-queue | T9 | uint224（或 v1 动态数组） |
| token-conversion | T13 | opcode walk 证明 |
| yearn-auction | T10 | 提名 fan-out |
| few-wrapped | T10 + T11 + T12 | 双通道 + setup + receipt |
| set-redemption | T7 + T9 + T10 + T12 | 多资产 fan-out + direct action + 双提名 |
| default-collateral（已迁移） | T10 可选 | 恢复 txSeed scand，当前已接受 narrowing |

## 建议实施顺序与验收

1. T1–T5（一天级）：改完重跑 21 个已迁移族的 `generate/build/check` + 契约，确认无回归。
2. T9/T6（codec/victim）：分别解锁 mellow/ondo 与 metronome-synth。
3. T7/T8：先 yieldbasis（单行）再 psv/curve-lp。
4. T10/T11/T12：few-wrapped/yearn/set-redemption，需预算/上限保护与负例。
5. T13 最后评估；若不做，token-conversion 保持 blocked。

每组改完的验收命令：
```
npm run family-capability-manifest:generate
npm run build:live
npm run family-capability-manifest:check
node --import tsx --test src/searcher/test/declarative-*.test.ts
# 对应 family 的 contract/lifecycle
```

# TS 扩展需求（供框架窗口实现，2026-10-30）

基线：`codex/family-runtime-actual-20261007` @ `656cfbb3`。以下均是 app-run2 上架族在 JSON 迁移中
**实际撞到**的通用能力缺口；加粗为阻塞族，其余为已确认语义。

## R1. per-direction execution / quote 选择（阻塞 uniswap-v1，预计阻塞多数 swap）

现状：
- `declarative-family.ts:199-203` variant 只按 descriptor 选择，不看 route；
- `declarative-execution.ts:450` 拒绝 step call 上的 `when`（“execution step calls cannot silently skip on when”）。

需要：允许按 `input.route.direction` 选择 execution 程序/quoteFlow（或允许同一 variant 内
`steps`/`call` 带 direction 条件），并保证 fragment/runtime 两条路径一致。

uniswap-v1 证据：`univ1-family/execution.ts:11-31` buy = WETH.withdraw + ethToTokenSwapInput(value)；
sell = approve + tokenToEthSwapInput + wrap，两条方向调用/授权/native 路径不同。

## R2. 零输出 exact 与 unavailableReason（阻塞 univ2/univ3）

现状：声明式 exact 硬拒绝 `amountOut<=0`（`declarative-family.ts:680`），而 TS：
- univ2 超容量返回 `amountOut=0` + `unavailableReason=input-reserve-capacity`（`univ2-family/exact.ts:111-144`）；
- univ3 缺 bitmap/触价返回 0 + `univ3-local-ticks` evidence（`univ3-family/exact.ts:224-235`）。

需要：允许 exact method 返回带 `unavailableReason`/证据的零输出结果（与 pricing 的
classifyUnavailable 对齐），不能把容量不足伪装成报价失败。

## R3. quoteOutput 结果可被 execution step 引用（阻塞 univ2）

现状：`univ2-family/runtime-execution.ts:52-54` 声明 `settlement.quoteOutput`，并在 program 内根据
pre-transfer reserves 算 `amount0Out/amount1Out`；声明式 quoteOutput 的局部结果无法被 execution step
args 读取（`declarative-execution.ts:150-217,480`）。

需要：把 quoteOutput 的命名结果暴露给 execution 环境（如 `$quoteOutput.<field>` 或 `$steps.<id>`），
并保持 direct-output 校验仍从实际到账测量。

## R4. 动态 read/tick 程序（阻塞 univ3）

`univ3-family/exact.ts:87-117,168-175,205-208`：tick-lens fallback、49-word state-reader 选择、
per-descriptor swap-access 门控，都是按 descriptor/状态动态决定的读取程序；固定 read flow 无法等价表达。

需要：允许 JSON 声明多个候选 read 程序并带选择条件（或一个受限的 `selectReadProgram` 表达式），
保持每个请求的 source/ABI/provenance 校验。

## R5. Swap 专用观察（阻塞 univ2/univ3，可能影响其他 swap）

`univ2-family/swap.ts:44-93`、`univ3-family/swap.ts:54-216` 使用自定义严格 swap 观察/victim replay，
超出声明式 `swap.events`（log-only）能力。

需要：声明式 swap observation 接口（标准事件之外的 custom decode/replay 钩子），
或明确哪些 swap 族只能保留 TS 实现。

## R6. 多资产 execution fan-out（阻塞 set-redemption）

`declarative-execution.ts:308-311` 强制 1 debit / 1 credit；Basic/Legacy redemption 需要按
`descriptor.components` 循环、逐币校验 receipt 并嵌套 subscript（`set-redemption-family/execution.ts:16-42,74-110,134-146`）。

需要：effects/steps 支持 `forEach: "$descriptor.components"` 展开；允许嵌套 program；
保留每项 debit/credit 与旧库存/回滚检查。另：Basic action 的 direct calldata 编码
（`action.ts:8-17`）目前 JSON 只能生成 runtimeAmountProgram。

## R7. metronome-synth materialization 诊断（阻塞单族验收）

Ready 分区稳定返回：

```
retryable / materialization / resource-limited
"strict lifecycle produced no materialized instance"
```

已排除 scope（同块加入 univ2/univ3 后其他族 verified，metronome 仍 retryable）。

进一步定位：failure 在 `universe-rebuild-production.ts:1329-1345`——identity 已被接受
（`result.accepted[0]` 存在），但 `publication`/`instances` 为空，所以 stage=materialization；
`failureCode` 在这条分支被硬编码为 `resource-limited`，掩盖了真实原因（routes/pricing/descriptor 投影失败）。
需要：publication 为空时输出各段（instance/routes/pricing/exact）的具体拒绝原因，而不是统一
`resource-limited`；这样才能区分 identity 之后的投影失败与 transport 限制。

## 备注

- 以上都不要求协议特判；R1–R5 是 swap 域通用能力，R6 是 protocol 域通用多资产能力。
- 已完成的族（Protocol 15、Credit fluid、Swap balancer-v1）在 656cfbb3 上 build/check/declarative 全绿；
  加上这些能力后可继续迁移其余 14 个 swap 与 set-redemption。

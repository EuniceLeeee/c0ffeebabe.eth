# Family 领域拆分与 Swap 公共表达缺口

基线为云端 `/opt/mev-cloud/family-runtime-20261007` 的 `656cfbb3b4c5c50240eac64d6b1f031d0414f627`，保留原 dirty 修改与已有进程。只改 Family 公共层、公共测试及自动生成的能力目录；未迁移其它窗口的协议 JSON，未启动 live、部署、签名或广播。

## 交付范围

| 项目 | 结果 |
|---|---|
| Protocol 领域入口 | 新增 `declarative-protocol-domain.ts`，与 Swap/Credit 的领域声明组装结构一致；共享 lifecycle 不复制 |
| G1 方向执行 | `execution.steps[].when` 为严格布尔条件；不能依赖链外输入、报价或最低输出；本次方向决定调用、授权与包装步骤 |
| G2 零输出 | 正输入零输出必须有 `evidence.unavailableReason`；trial 无状态写入/效果；quoted 执行仍拒绝零输出；不放宽 chain quote 行为证明 |
| G3 报价局部结果 | `quoteOutput.exports`＋`{quoteOutput: name}`；私有 capture 不可覆盖。default/direct 核实真实到账；deferred 先绑定父层 expectedOutput 再由原回调核实 gross 实收/债务 |
| G4 动态读取 | 条件请求、依赖结果与49项窗口已有表达能力，本批补回归而非新增调度；新增显式 local-math `stateOnlyReads`、按实例 trial 准入及结构化金额投影 |
| G5 Swap 观察 | calldata 观察、同池同交易关联事件、按需 receiptReads；复用原 tokenQuery/期限/取消，不虚构 source 证明或缺失 value |

## 统一测试与事实边界

`npm run test:family-json` 自动纳入公共模块测试和现有领域测试；新族提供定义和样本数据，不复制一套测试逻辑。公共生命周期共测，Swap 加观察/结算回归，Protocol 按已声明能力，Credit 保留独立仓位风险语义。空模块不能当支持，应有但缺失的能力不能靠 skip 算完成。

冻结代码的生产 build、公共 suite、generated check 均需完成；最终机器结果记录在下方。

最终云端结果：生产 `build:live` 通过；统一套件 **582 pass / 0 fail / 1 explicit skip（583 total）**；自动目录生成与 `family-capability-manifest:check` 通过。提交用干净基线导出的目录另行 generate/build/check 通过，云端原有 dirty 目录差异保留。新增测试的严格 Node16 typecheck 通过。

- 新增测试使用实际公共编译器、字节码解释器、生产 StrictObservation 和现有读取后端契约，覆盖错误方向/条件、零扣款/欠扣/过扣、少到账、授权清零、原生币、旧库存、错误回调债务、错误父层报价见证、坏/异交易日志、超时与RPC错误。
- 动态读取测试核对聚合路径、49项回退、权限拒绝后的零额外请求。未声明新模块时保留无新增读取/旧字节码对照。这是离线成本回归，不是生产性能通过。
- 独立复核发现过空请求 guard 的热 trial 路径漏校验。修前进程内载入原候选为4通过/2失败，修后6/6；修正会执行空请求 guard 的 decode，并把 guardResult 交给 outputChecks。原候选源码和失败日志保留。
- 中间测试曾因 fixture 缺 math 声明、trial 不支持标记冲突及 TypeScript unknown 类型报错，已修正并保留失败日志；不以最终绿覆盖失败记录。

## 仍未完成

- 这不是 UniV1/V2/V3 或其余 Swap 的 JSON 迁移/历史执行验收；另一窗口继续写定义、补真实样本并跑统一入口。也不能从本批公共测试推断15族全部适配完成。
- Set 多资产 fan-out 仍有公共表达缺口：现有执行器强制单路由收付，不能把其它篮子组件忽略或当库存兜底。本批未放宽这一门。
- Metronome 的 `retryable/materialization/resource-limited` 需其实际 lifecycle 请求与失败证据定位，不能由该总括错误直接归因 identity；本批未验证其历史验收。
- callback 内才产生且无父层见证的 deferred 输出仍不支持；父层 quote export 不能直接当 callback-body 局部寄存器。
- `receiptReads` 是已有 blockTag 观察补读，不是 canonical quote 证明；缺少完整 receipt/状态锚点会拒绝。
- 本批不做新的 EVM 历史执行、Ready 重建、机会复现或代表性时效性实验，旧 Balancer V1 历史证据保留原源码指纹，不能改 hash 冒充本批新执行。

完整配置接口见 [迁移交接](../design/swap-credit-json-framework-20261030.md)。原始本地产物位于 `logs/family-domain-gaps-20261030/`，独立审查产物另保存在 `logs/swap-json-enabled-20261030/`；云端同名目录保存生产构建与套件日志。

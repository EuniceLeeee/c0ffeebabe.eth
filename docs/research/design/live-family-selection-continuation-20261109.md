# 启动价格表：Family 增减共用流程

本次以 `1379d73ea4dab688bee4c1b8f2b62811f7bd4a39` 的云端实际源码为基础，扩展已有跨 live 价格恢复入口。**一次比较新旧启用名单，同一条流程同时处理新增、减少和保留项。** 不复制两套上架／下架主流程。

## 一个入口，内部按职责拆子流程

1. **认证来源**：旧 journal 先通过原完整接收器、文件摘要、代码兼容证明、区块锚点及 Ready 指纹验证。父子 journal 分开，父记录不覆写。
2. **比较启用集合**：新旧集合交集为保留项，旧有新无为移除项，新有旧无为新增项。所有当前边必须由已启用 Family 认领；保留 Family 的实例／方向／元数据不能悄悄变化。
3. **整理 raw 价格**：保留项复用原锚点上的真实观察和 provenance；移除项从当前视图删除；新增项通过当前生产 coarse-pricing 会话读状态。读取范围按 `Family × 实例` 限定，不触发保留 Family 的全量或 per-block 状态读取。
4. **补齐 effective 价格**：调用既有 `buildEffectiveMids`。保留有效的原始 amountIn/amountOut/quotedAt；移除输入路径所依赖的边时，重新计算受影响方向；新增边正常报价。新增估值路径可以使旧 `missing-valuation` 行恢复，不能凭空填成功输出。
5. **保留检查结果的证据边界**：只保留仍在当前图内、前缀仍完整的启动观察；不能给新增方向制造启动执行成功。原有 pool 拒绝、自动排除及最终模拟门继续生效；失去前缀证明的保留 pool 拒绝会阻止恢复。
6. **校验后发布**：要求完整 effective 行集合、同一受测 source、可恢复的金额来源链、当前生产 index 完整一致。通过原 `restoreHistoricalBaseline` 后，才写入新的 journal；随后仍走原启动检查及追块流程。

## 核心文件和函数

| 文件（仓库相对路径） | 作用 |
|---|---|
| `listener/src/searcher/main.ts`：`liveSubsetParentProof`、主 continuation 恢复段 | 认证旧断点及 sealed Ready，编排一次统一更新，使用已有 RPC 调度和 source-bound 会话，校验后保存 |
| `listener/src/searcher/blockscan-live-continuation.ts`：`reconcileLiveContinuationFamilies` | 一个主流程完成集合差异、方向一致性、金额路径失效、过滤证据与完整性检查 |
| 同文件：`projectLiveContinuationSubset` | 仅保留旧调用名作为上面函数的别名，没有另一套实现 |
| `listener/src/searcher/strict-current-runtime-coordinator.ts`：`reconcileLiveContinuationRawPricing` | 校验同状态及保留项合同，复用原 raw 观察，调用现有 raw 构造器生成完整当前视图 |
| `listener/src/searcher/strict-production-runtime-session.ts`：`StrictProductionRuntimeRoot.createSession` | coarse-pricing 支持显式 `requiredEdgeIds` 范围；同实例的各方向一同读取，避免跨 Family 共用 key 导致多读 |
| `listener/src/searcher/blockscan-effective-mid.ts`：`buildEffectiveMids`（原实现） | 原报价、估值路径、missing-valuation 恢复和增量复用，不另造报价管线 |

旧 `SEARCHER_BLOCKSCAN_LIVE_READY_SUBSET`／`LIVE_SUBSET_PARENT_DIR` 参数名保留兼容，语义扩展为选择 sealed Ready 中的启用 Family，允许相对旧价格表增加或减少。

## 范围与限制

- 新增是“旧价格表未启用，但本份 sealed Ready 已扫描、当前规则仍有效”的 Family。新 Family 无实际实例时不强造价格行。
- **未进入 Ready 的新协议、不同 Ready 指纹、相关 Family 规则过期，不由价格恢复绕过。** 这些仍需先走既有 Ready 验证／更新；本次没有实现跨不同 Ready 代际复用价格表。
- 修改代码仍受原完整代码指纹及显式兼容审查约束；本次不自动信任旧部署断点，也不生成虚假的兼容证明。
- 正常逐块路径未新增模块／RPC。明确的新增读取只发生在启动重整，新增量仍消耗真实报价时间与 RPC。
- 未启动 live、未改默认启用名单、未重建或改写 Ready、未部署和广播。

## 验证

- 同一个更新函数：纯增加、纯减少、同时增减、全部替换、名单不变；缺元数据／错误归属、锚点不符、补价不完整及读取故障拒绝。
- 复用原行对象和金额，新增路径修复旧缺估值，移除前缀后重新报价；原 pool 拒绝证据门、自动排除复核继续覆盖。
- 实际生命周期签发的 Ready 实例及生产 pricing session：新增 10 个实例只读 10 个，同时增减只读新增 10 个，纯下架／不变读 0 个。真实 RPC 返回和报价金额在这组离线测试中是 fixture，不能据此宣称主网时效性通过。
- 新 raw 表经过二进制保存，再由原生产恢复器校验和加载；既有 journal 增量、内存、损坏／中断检查一起运行。
- 生产 `build:live` 及上述聚焦回归通过。全量 strict-session 回归在旧基线及候选均遇到既有 sequential exact-prefix fixture 的 `buildExecution` 断言失败（期望 `resolved`，实际 `failed`）；没有修改断言来过门，完整套件不标全绿。
- 诊断工具按当前 inventory 选择 `listener:searcher:strict-production-runtime-session`。基线全套失败与手工定位一致；候选用 `--historical-baseline-only` 跑到并包含新增恢复检查，工具执行 receipt 保存在本次 ignored 日志目录。

本次结论是公共流程实现与离线恢复合同验证；没有新增真实跨 live 的运行／时效性证据。

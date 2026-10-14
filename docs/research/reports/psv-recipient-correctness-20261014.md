# PSV 收款方适配与正确性验收

PSV 新增按实际收款人报价及直接到账路径，源代码提交 `4a71243757c691cc25ddfdb343fafa481516f14c`。当前生产代码在 N26152596 的双向默认与新结算路径已完成本次正确性核验；完整适配交付、正式 Adapter Replay、原交易机会复现和时效性仍未完成。

- Family 根据收款人白名单计算费用；treasury 收款时实际到账为净额加手续费。两方向参数均为完整输入，不扣减报价/请求输入。
- 共用编排将实际收款人传给只读报价；执行器增加协议无关的相等比较。原有实收、完整扣款、0/1 舍入、旧库存、原生币、最终偿还与利润门未放宽。Aqua 与 UniV2 的既有报价路径同步做了兼容回归。
- 复用原 Ready，只对副本做当前生产重验与价格阶段：41 实例、82 边；目标 PSV 两方向自然输入均为 4,969,763 原始单位，到账相同。整图 82 raw／80 effective，另外两条缺估值属于背景行。原 Ready 和价格文件未修改。
- 同 N/hash 的默认 quoted/runtime 为 16 正例／8 声明回滚，外部普通及 treasury 收款为 16／8；额外自收款模式只补 8／4，没有重跑默认和外部组。合计 40 正执行／20 声明回滚，所有报价/实收差为 0。构造期 Exact/RPC/quoted fallback 为 0；默认指定金额验收另有 8 次 Exact 和 8 次 quoted 编码，不能混为“全程零报价”。
- 36 项 PSV/编排回归、132 项共用执行器安全回归、301 项已有 Family 双接口测试、11 项 Aqua 测试、2 项新兼容测试通过。真实 PSV 字节码的合成状态 EVM 7/7，覆盖费用、白名单、treasury、精度、限额、错误扣款/到账及余额/allowance/capacity 回滚；执行器 17 wei、外部收款人 19 wei 旧原生币余额保留。

历史状态的费用和限额均为零。非零费用、限额、白名单及精度边界属于真实字节码上的合成状态验证。历史负例只证明 EVM 声明回滚，空 effects 不等于独立完整 stateDiff；历史外部收款人的 native 余额未单独观测。当前 BotVM 通过本地 REVM 反事实代码运行，未部署、签名或广播。treasury 等于付款人且有手续费的分流状态保持原子拒绝；不强造成功。

验收工具的 caller 声明错误已由独立审查确认并修复，同 Ready/价格回归完成，LearningCase `tooldef-20261014-psv-recipient-state-caller` 的 codify_commit 为本次源码提交。所有旧失败、准备失败、未运行样本和既有负 EV 结论保留。

完整源码/dirty 指纹、输入来源、逐项证据哈希、独立审查、失败记录及限制见 [验收 JSON](psv-recipient-correctness-20261014.json)、[独立执行审查](psv-recipient-evidence-review-20261014.json)及[自收款补验审查](psv-self-recipient-evidence-review-20261014.json)。当前更新仅为 PSV 结算能力；其他 Family 的旧证据继续按原源码范围保留，不以更新公共哈希替代重验。

下一项为 Mooniswap 外部 receiver 接线；此前 255 笔完整前序和自然正 EV 成果继续复用。4A/4B 仍为 NOT RUN，并在所有正确性工作之后推进。

已通过当前源码的 PSV 结算能力验收门，46 个已安装 Family 的清单完整性校验通过，本次行为门只选择 PSV。实际执行收据见 [结算能力验收收据](psv-settlement-gate-20261014.json)。这不改写其他 Family 的原验收范围。

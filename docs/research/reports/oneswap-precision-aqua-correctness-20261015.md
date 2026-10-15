# OneSwap、PrecisionPool、Aqua：本次接入范围正确性

OneSwap 与 PrecisionPool 的旧 Family 已接回当前云端生产注册，保留原身份／数学／变体能力；原生币包装与指定收款复用共用执行器。Aqua 补齐真实回调结算与指定收款负例。以下均已完成非作者原始结果复核，机会与性能仍单独记录。

| Family | 实际验收 | 范围与限制 |
| --- | --- | --- |
| OneSwap | N26130639 两池双向、8组金额、quoted／runtime／自收／外收32次成功；16次零额与24次其他回滚拒绝 | 原TX与旧生产行只借输入，当前同状态重报／执行；AMM+orderbook池在该状态实际由AMM成交，未冒称其他订单簿变体。 |
| PrecisionPool | N26129175 原native池双向、4组金额、4模式16次成功；16次strict声明拒绝；4组真实本地BotVM故障测试 | 当前旧Ready副本重验，naturalDiscovery=false；历史负例不冒称全storage diff独立回滚。 |
| Aqua／SwapVM | N25680170／171两策略四方向，20次真实callback成功、120次deferred拒绝、50次direct拒绝及20次非活跃context安全空操作 | 1 raw output资金夹具只验证结算；旧默认／quoted／direct证据经源闭包审查复用，原凭证拒绝仍保留。 |

逐项核对完整请求输入、实际扣款／到账、收款方、原生币、授权及旧库存；运行时构造Exact／quoted／RPC为0，无quoted fallback。生产构建、全族双接口和catalog／生成器回归通过。新注册由原生成器串行产生，原有catalog行当时逐项不变；提交单独排除他人V1修改与后续Few改动。

OneSwap首轮历史工具在运行时构造前错误地把原生币内部收款限制套到最终WETH收款人，原失败保留。经非作者复核后只修验收断言并加入真实issuer映射回归；复用已经通过的Ready与结算合同，不重做旧成果。工具缺陷以实际代码提交登记。

[OneSwap原始复核与金额](oneswap-current-correctness-20261015.json)、[PrecisionPool逐项结果](precision-pool-current-correctness-20261015.json)、[Aqua真实结算与证据复用](aqua-current-correctness-20261015.json)。本报告不声明原机会、正式Adapter Replay、4A／4B或全任务完成；未部署、启动live、签名或广播。没有实际实例的额外变体只列边界，不制造必补事项。

后续按用户要求用满3个subagent，分别完成独立Family的实现与必要正确性收尾；共享注册／catalog写入集中协调，正确性fork可并行，阶段4单机性能测量仍串行。

# Few、Vault、Curve underlying、Ekubo：本次新增收款路径

Few 的指定收款分支补齐正额、完整实际扣款、返回值与实收、原生币及旧库存检查，默认路径保持原行为。Vault、Curve underlying、Ekubo 本批仅补真实历史验收工具，复用仍有效的旧默认路径成果。

| 本次范围 | 已运行且独立复核的结果 |
| --- | --- |
| Few 两实际包装实例、四方向 | 20 次外收成功、80 次故障拒绝、4 次零额拒绝；精确临时授权并清零 |
| Vault 双向 | 12 次外收成功、48 次故障拒绝、6 次容量／零输出状态拒绝、2 次零额拒绝 |
| Curve underlying 两个 nativeAlias 实现、八方向 | 64 次 quoted／runtime／自收／外收成功，32 次零额与96 次其他拒绝；独立原始余额槽与 storage-union 回滚核对 |
| Ekubo 实际无 extension 原生币池双向 | 8 次自收／外收成功、8 次 strict 声明拒绝；旧默认双向与3个 quoted 程序字节复核相同 |

报价与执行绑定同一历史状态，请求输入保持原数，使用实际到账；运行时构造 Exact／quoted／RPC 为0。Few 与 Vault、Ekubo 历史负例保留 strict 声明回滚的证据范围，不冒称独立 storage diff。Vault 原大额容量拒绝和 zero-output 拒绝保留，不用小额成功覆盖。Curve 首次第二实例启动遇 TIME_WAIT 已保留；确认无监听、原进程退出后只继续未运行的 clone，未重跑成功的 full。

FRAX／5f8908 的旧26次外收和26次零额控制，经88个相关源码文件兼容复核认证复用，原哈希保留，不重跑。Curve underlying 的213be／rateSlot16和2c7796／rateSlot10两种经典元池收款变体、Ekubo ERC20/ERC20 的新增 direct 行仍按原待验状态保留，本报告不声明整个 Family 全部模式通过。没有实际实例的额外变体不制造必补缺口。自然集成、原交易机会与正式 Adapter Replay、4A／4B性能继续分别记账，未部署、运行live、签名或广播。

[各族余额与实际金额](few-vault-recipient-correctness-20261015.json)、[Curve 两实现](curve-underlying-native-recipient-correctness-20261015.json)、[Ekubo 原生币范围](ekubo-native-recipient-correctness-20261015.json)。原失败与工具修复单列，工具缺陷的实际 codify_commit 由同批后续 LearningCase 提交登记。

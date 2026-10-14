# Yearn：当前历史块报价与收款方验收

在 N26152335 块末的实际 Yearn 拍卖上，4组金额共16次正执行、8次声明回滚和4次零预付只读报价通过。测试使用当前生产 strict issuer、Exact、quoted、runtime 和 direct-output 编码；默认、自收款和外部收款均核对真实扣款及到账。独立复核见[报告](yearn-recipient-historical-review-20261015.json)。四参非空 data 回调仍只有实现及本地 EVM 证据，本批没有运行其实际历史执行，整族保持未完成。

实现提交 `56d94de6e2f91cbbae5563abd3633b48c4ebfd4b`；本轮验收 CLI 提交 `f08be40082dda6618b504671254d28f16b51867c`。实际工作区含保留的他人修改，以源码指纹 `6abcce6d176740345e69bd8dbc8e535368b27f6ecc2a9a3b92535cc8e33c0323` 绑定本次运行，不能仅用提交 SHA 替代实际源码。规范生成目录与已提交版本相同，无需更新；本轮只提交本任务的 CLI 与入口登记，工作区 UniV1 增量保持。

原交易 `0x6cc7a620da9e1fc47e894ec69bdbd3b1075c05ebc6c1807a3a6a000035fe136b`，index188；拍卖 `0xa00e6b35c23442fa9d5149cba5dd94623ffe6693`。当前反向身份为 v1.0.4 clone，支付 crvUSD、收到 ALCX，18/18精度。本次测试状态为 N块末，不是原交易调用前状态，也不是原机会复现。

| 输入来源/边界 | 输入预算（原始单位） | ALCX实收 | crvUSD实扣 | 余款 |
| --- | --- | --- | --- | --- |
| borrowed-production-input-at-N | 5137296582894235185 | 2041007520497841855 | 5137296582894235183 | 2 |
| original-budget-at-N | 267759246788654353808 | 106378642455288485048 | 267759246788654353808 | 0 |
| original-budget-plus-two-wei | 267759246788654353810 | 106378642455288485048 | 267759246788654353808 | 2 |
| capacity-capped-budget | 1945528466888290612819 | 772943155644044667101 | 1945528466888290612802 | 17 |

每组分别运行 quoted、默认runtime、direct自收和direct外收。实扣与同状态协议成本差0，实收与同状态报价差0，临时授权清零、执行器原生币保持。余款是最大预算未使用部分，并非接受欠扣；原报价/请求金额没有人为减少。8个历史负例只证明声明回滚，返回effects为空，不能写成完整历史stateDiff原子性证明；完整回滚矩阵另有已提交本地EVM证据。

生产单块 Ready 由已有材料复制重验，共20实例/39边，Yearn目标1边及raw存在；effective仍为 `missing-valuation`，`historicalNaturalDiscoveryProven=false` 原值保留。该 Ready/strict 和手工金额成果有效，不等于目标自然估值或全图自然集成通过。借用的crvUSD输入来自保存的生产 Ekubo 行：N26146969、hash `0x0c9cffba34b89d868dd1596f5449cef9c0fdb8da84f96111f4987b0ad907f500`，fresh；只借amountIn，目标输出、身份与准入均在N26152335验证，原价格表未改。

当前生产构建和只含本任务修改的提交输入构建通过。CLI由现有历史工具扩展并登记到当前规范工具索引；使用真实规范执行收据。运行完成并drain，未因观察超时重复启动；本次未运行live、部署、广播、统一机会复现或性能实验。旧机会成果、旧失败、原Ready和旧执行器产物均保留。

完整源、金额来源、配置、执行器、规范工具收据和限制见[进度证据](yearn-recipient-historical-progress-20261015.json)，逐笔实际余额见[执行收据](yearn-recipient-historical-receipts-20261015.json)。下一缺口为实际四参回调与适用真实付款前序的历史组合验证。

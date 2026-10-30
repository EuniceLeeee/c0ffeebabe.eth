# Swap JSON 测试输入

`index.json` 冻结 app-run2 实际启用的 15 个 Swap Family，共 27 条 TX 引用。`cases/` 是可供公共 runner 使用的完整输入；`balancer-v1-fields.json` 是可离线复核字段/整数/调用的保存资料。`balancer-v1-generic-fields.json` 声明通用字段测试步骤与预期事实，并以 SHA-256 引用该资料。

样本库不是通过清单。`completeCases` 只表示字段完整；不能把历史输出复制到不同状态作为预期值。第一份 Balancer case 有两个方向、四个金额，原交易金额在 N 块末状态重新报价与执行，不冒称原交易前序状态复现。

代码、命令、回调/Credit 限制及迁移规则见 [公共框架交接](../../../../../../docs/research/design/swap-credit-json-framework-20261030.md)。新协议提供 JSON、纯数学与样本数据，运行 `npm run test:family-json`；不要另写一套协议验收结论或降低公共断言。

# 统一 Protocol 历史样本

`index.json` 保存全部已找到的 TX、来源文件与 SHA256、变体/方向、旧证据的边界，以及尚需补取的字段。`cases/*.json` 只保存公共验收器读取的输入数据，不放测试代码或通过标签。

库检查只核对这些来源 pin 的格式和索引一致性，不重新认证所有外部历史原件。金额条目未单独列来源时，继承该样本的来源列表；有逐金额来源时必须匹配其中一个 pin。实际验收仍从当前 source-bound 生产上下文重新取得执行事实。

样本库覆盖 **24 个已迁移 Protocol＋本次公共模块涉及的 Metronome Synth、PSV，共 26 族**。这与公共 TS 的 **app-run2 实际启用 18 族**是两个清单：保存关闭族的历史样本不会上架它，也不授权为它扩张公共模块。Set Redemption 实际关闭，本批未补 fan-out，不能把它算成本次 TS 已完成的第 26 族。

已导入 **49 条 TX 来源记录，25 族有完整 TX 哈希；48 份完整格式的 case，覆盖 25 族**。这不是 25/26 或 25/26 适配通过；输入库完整不代表历史执行验收。仅 wstETH 仍缺可确认的 wrap/unwrap TX（保留显式 reference-only 条目）。

此前按 18 族盘点漏收的 8 个已迁移族现已补入：

| Family | 补回的 TX | 来源与状态 |
|---|---|---|
| staked-usdat | `0x63fb77b723f3bd7fd4d9539ef1e1e248cb5499153dbfc225e8b24ae1522ec6e7` | 原 IMPL 第 18 行；待组装当前 case |
| arcana-migration | `0xefa1ed163fe6ce5dd40a67b5cc3d0ed43d3521cb4f1a07cb6e92bb1d5d1644de`、`0xddea3ef19112b1d90c16b67691b97c07cdcd0c3a6ce31df73aa076f6a8178460` | 原 IMPL 第 49、50 行；各取协议腿 |
| boring-vault-teller | `0x0bff8c156d526f052998a5f27e25ec44493d71818189226a53888e3826648b80` | 原 IMPL 第 51 行；待组装当前 case |
| default-collateral | `0xad88c7f614ac27fa1707e224a2276d1f1b12f8cffe9a4443f1fa3fa2cf209833` | 既有合同测试的实际 TX 引用；不导入 mocked effects |
| metafactory | `0xbc7223c28f592b70fd17b8ff9522efc244a1cffb2c73aec9a0dd4c1b820a0af7` | 既有历史报告；实际收到 native ETH，不能写成 WETH 转账 |
| olympus | `0x28c9e5f8b41db8e2a0b5653b0a48520307bcafe95d1edf993f6f15e1ea904696` | 旧测试标注的 landed TX；测试中的合成块哈希不入库 |
| origin-steth-arm | `0x1b6545dd23d993366e41175eaefbd993e740752d4c92ee8a1b473a7d43f40f5c` | 既有 receipt 和单腿报告；整笔的 skim 不属于本腿验收 |
| origin-ousd | `0xab27e7006f6d2471e6f2d037cdc8e2ecbf6848f65d79c54a43c3bf145cbba13a` | 从源码缩略引用及 N=26185253 区块找回完整哈希；尚需 receipt/协议腿资料 |

**唯一仍没有可确认兑换 TX 的族是 wstETH。** 原 IMPL 表没有独立 wrap/unwrap 样本；本次有界检查的测试/历史资料也未找到。仅在别的池子里出现 wstETH 不能算其 wrap/unwrap 证据。接手窗口继续查历史资料，确实找不到再请用户补。

Eigenpie、GoldX、Metronome Synth、Metronome hgUSDC 早已有完整 TX，但尚无完整 case；上述新补 8 族也是“TX 已有，case 待整理”。这些缺字段由接手窗口从已有 receipt/区块头/calldata/日志/trace 补，不让用户补本可从 TX 取得的字段。`caseInputsReady` 与有 TX、已适配、已执行是不同状态。

## 接手步骤

1. 拉取框架提交。只改具体协议 JSON、必要数学、`index.json` 和 `cases/*.json`；不要新增 Family 专用测试 TS，不修改公共断言。
2. `npm run check:protocol-json-samples` 查看现成 case、待补资料和缺 TX 项。命令仅检查库完整性，不做 RPC/执行。
3. 缺字段优先查原证据，再取 receipt/header/calldata，必要时 trace。识别协议腿的实际输入/输出资产、金额和收款；多次调用逐腿分开，不把整笔净利润当单腿输出。
4. case 的 `source` 必须明确测试的 canonical block-end。原 TX 输入可以借用；原调用输出仅留 index 的 `recordedAmountOut`，不得自动填为新状态的 `expectedAmountOut`。用原调用前状态复现属于另一验收层。
5. 使用当前生产生成器、build 与既有单块 Ready 入口获得当前定义对应的自然 Ready。旧 Ready 若指纹不符，按生产流程重验证；禁止手改 Ready/哈希。测试 actor 与 Ready 的执行身份一致，不能为绕过代码检查替换真实 actor。
6. `npm run test:protocol-json`，再按下方命令运行同一历史验收器。报告用新路径保存，包括失败、状态拒绝、RPC 故障和缺方向。不要改测试文件。

```sh
npm run check:protocol-json-samples
npm run test:protocol-json

npm run accept:protocol-json -- \
  --case src/searcher/test/fixtures/protocol-json/cases/astra-multitoken--rcn-to-c082.json \
  --validate-only

npm run accept:protocol-json -- \
  --case src/searcher/test/fixtures/protocol-json/cases/astra-multitoken--rcn-to-c082.json \
  --ready /absolute/current-ready.json \
  --rpc-file /absolute/read-only-rpc-config.json \
  --revm-bin /absolute/revm-sim \
  --out /absolute/new-report.json
```

运行环境应使用对应生产启用配置；公共验收器不擅自开启默认关闭的 Family。RPC 配置、Ready 和新结果仍留在本地日志目录，不提交凭证或原始日志。

## 如何读结果

- `caseInputsReady`：样本格式及索引对应完整，**没有执行**。
- 实例内所有已准入方向均取样且 quoted/runtime 等事实检查通过，才得到该 case 的通过。Astra 示例仅一条真实方向，若 Ready 还有其他方向，整体会明确 incomplete，不能把一个样本当完整 Family。
- 各真实变体/实例的覆盖需汇总；无实际实例的变体按既有口径记录不适用依据，不造成功样本。
- 回调真实执行若当前公共入口不能覆盖，保持未验证并交回框架窗口；离线 callback 测试不能替代真实结算证据。
- 完整套利复现、自然估值和时效性单独记账。样本、测试绿色、历史旧结果都不自动修改 IMPL 的协议完成状态。

完整框架说明见 [公共模块与统一验收](../../../../../../docs/research/design/protocol-json-common-tests-20261030.md)。

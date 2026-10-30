# 统一 Protocol 历史样本

`index.json` 保存全部已找到的 TX、来源文件与 SHA256、变体/方向、旧证据的边界，以及尚需补取的字段。`cases/*.json` 只保存公共验收器读取的输入数据，不放测试代码或通过标签。

库检查只核对这些来源 pin 的格式和索引一致性，不重新认证所有外部历史原件。金额条目未单独列来源时，继承该样本的来源列表；有逐金额来源时必须匹配其中一个 pin。实际验收仍从当前 source-bound 生产上下文重新取得执行事实。

当前范围是 app-run2 本批启用的 **18 个 Protocol**。已导入 **41 条来源记录、35 份完整格式的 case，覆盖 13 族**。这是样本可读取的数量，不是适配通过数量。35 份中 34 份复用既有资料，本轮只额外补齐 Astra 的一笔 TX；未批量执行历史验收。

没有完整 case 的已有 TX：Eigenpie、GoldX、Metronome Synth、Metronome hgUSDC。这些由接手窗口从已有 receipt/区块头/calldata/日志/trace 补齐；不要让用户补本可从 TX 取得的字段。wstETH 在本次有界资料盘点中尚未找到可确认的兑换 TX，可继续查已有记录，仍找不到再向用户索取。此处“缺样本”不等于协议缺实现。

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

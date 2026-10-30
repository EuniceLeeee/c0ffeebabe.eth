# Protocol JSON 公共模块与统一验收（2026-10-30）

本次补公共 TS 和共用测试。迁移窗口只编写协议 JSON、必要的数学定义与样本 JSON，然后运行同一套测试；不新增协议专用验收 TS，也不能通过修改断言让迁移通过。既有协议合同、数学边界测试和历史证据继续保留。

基线：云端原工作区 `/opt/mev-cloud/family-runtime-20261007`，原分支 `codex/family-runtime-actual-20261007`，HEAD `6876fef0ff60c56f55f22939fe0e458d1366bf75`。本次未改具体协议 JSON、live 默认值、Ready、策略或调度。公共框架通过不代表某协议迁移或历史执行已经通过。

## 1. 以实际启动配置确定扩展范围

核对 app-run2 源码 `c609ffaf8b029cd40dd594af94925273fd900d76` 与保存的运行 `live-2026-10-29T04-32-58-703Z-1c8d0866` 的 config、run-contract、Ready activation。源码默认值不能代替实际开关：Set Redemption 被覆盖为关闭，PSV 被覆盖为开启。

本批对应的 18 个 Protocol：astra-multitoken、badger-sett-withdraw、eigenpie、erc4626-silo-redeem、erc4626、ethertoken-native-redeem、goldx、metronome-hgusdc、metronome-synth、psm、rocksolid、self-burn-native、token-conversion、token-migration、wsteth、compound-ctoken、peapods-debond、psv。

因此新增 oracle victim 声明（Metronome Synth）和运行时收款方报价（PSV），不为关闭的 Set 新做 fan-out，也不为 Curve LP、Yield Basis、Ondo、Mellow、Yearn、Few 扩张本批模块。PSV 不再按旧的“7 个关闭项”判断。交付前复核新运行 `live-2026-10-30T03-10-36-590Z-68a6c8af`，上述 Family 开关一致。该运行属于另一窗口，保留原进程；本轮构建和测试在本地源码快照执行，避免占用其云端测量资源。

## 2. 统一模块视图，空块不产生能力

`declarative-protocol-modules.ts → protocolModuleCatalog/readProtocolModules` 管理公共模块。根和变体原 JSON 无须批量改写；`createDeclarativeProtocolRuntime().moduleViews` 为每个变体显示完整的规范模块视图，`moduleCoverage` 明确 `undefined / defined / blocked`。

未声明新模块的旧定义会显示：

```json
{
  "quoteOutput": {},
  "oracleVictim": {},
  "math": {},
  "executionMath": {},
  "quoteFlow": {},
  "pricingFlow": {},
  "trialState": {}
}
```

这是**规范视图的空模块示例**，不是一个已支持全部能力的协议，也不是要求清空已有模块。缺省和 `{}` 等价；非空但不完整、未知字段/版本、缺依赖不能被计为可用。`oracleVictim` 是根级能力，变体视图显示继承结果，子 JSON 不可覆盖它，包括写 `{}`。其余模块维持已有变体覆盖规则。视图是检查输出，不是可直接回写任意层级的完整协议文件。

新模块只在声明时编译，未声明时不增加每块 RPC、状态刷新、runtime 步骤或 victim 监听项。注册时预编译 ABI/目标索引，运行时复用既有 Family 和中央生命周期。

## 3. Oracle victim：共同编译，原生产消费者执行

`declarative-oracle-victim.ts → compileDeclarativeOracleVictim()` 把根 `modules.oracleVictim` 编译为已有 `OracleVictimSpec`，随后由 `defineProtocolFamily → FamilyCapabilityCatalog → StrictProductionFamilyDeclarations` 接入现有消费者。

JSON 提供 `callPatterns`（signature、targets、candidateAddress、when、result）、`resultChecks`、`runtimeDetection` 和可选 `canonicalIntakeTargets`。目标是已有基础设施调用来源，不是实例准入白名单。先按 target+selector 筛选，只有匹配项才本地 ABI 解码；畸形 calldata 返回未匹配，声明错误不能伪装成无关调用。

`runtimeDetection.priceProbe` 沿用现有消费者的 `(address,address,uint256)` view/pure 调用合同，输出索引须为 uint；公共层统一规范 ABI 写法。重复 target+selector、金额溢出、矛盾 selector、未拥有的 action 均拒绝。生产能力清单只有在非空且编译成功时登记 oracle-victim，不因新增一个空 JSON 块自动声称支持。

## 4. 收款方报价：同一个实际输入，链上只读步骤

`declarative-execution.ts` 扩展已有多步执行器，消费 variant 的 `modules.quoteOutput`；协议不能绕过模块目录直接在 `execution` 填入内部字段。

```json
{
  "quoteOutput": {
    "version": 1,
    "steps": [
      {
        "id": "preview",
        "static": true,
        "call": {
          "target": "$descriptor.vault",
          "signature": "function previewDeposit(uint256) view returns(uint256)",
          "args": [{ "runtime": "amountIn" }],
          "save": { "previewed": 0 }
        }
      }
    ],
    "result": { "runtime": "previewed" }
  }
}
```

此为格式示例，PSV 的实际 ABI、收款方参数及计算由迁移 JSON 按原语义声明。步骤数由 JSON 决定。允许 static call 和已有纯 runtime 数学；禁止批准、转账、value、callback 或任意 bytecode 混入报价模块。结果必须同时依赖实际 r0 输入和本次链上读取，不能退化为离线 Exact 常量。真实 direct-output 动作执行时核对到账等于同状态/同收款方报价，保留实扣、旧库存、原生币和跨资产保护。

本模块要求 execution v2；本批只支持 ERC20 收款方报价。不能因此声称新的原生币 quote-output 变体已支持。旧 JSON 的默认程序及已有 direct-output 能力保持。

## 5. 提名与实例分组

`declarative-discovery.ts` 新增可选 `txSeedNominations`，独立于普通 nomination；不写时维持旧行为。v2 的 `candidate.instanceKey` 可声明实例聚合字段，但不替代原 `candidate.key` 的证据去重键。实例字段必须存在、非空、非 nullable，且包含已声明的地址字段。

这让 PSV/Peapods 保留原有种子行为，也让 Astra 同一目标的多份真实观察按实例聚合，不丢不同交易证据。没有为某协议写新的中央分支。

## 6. 一套测试，两种执行边界

真实 TX 样本已集中到 `listener/src/searcher/test/fixtures/protocol-json/`：`index.json` 收录本批 18 族的 41 条来源记录，`cases/` 收录 35 份完整格式输入（13 族）。34 份来自既有资料，本轮只补齐 Astra 一笔；剩余字段由迁移窗口补数据。`check:protocol-json-samples` 自动列出待补字段，不运行样本。详细步骤、限制和分工见该目录 README；其他窗口不新增测试 TS。

在 listener 目录运行：

```sh
npm run test:protocol-json
```

这是统一的**离线公共合同回归**：规范模块、发现、身份、读链、不可变 Map、方向分组、报价证明、纯数学入口、多步执行、回调、收款、旧 JSON 兼容、实际证据检查和报告拒假。沿用已有 ERC4626 管线测试。它不会读取 RPC 配置、生成 Ready 或启动 live。全域 `family-dual-execution.ts` 仍是单独保留的既有审计，覆盖 swap、credit、禁用项，不能用本套绿色替代其结果。

真实历史单腿验收使用同一入口，协议只提供样本 JSON：

```sh
npm run accept:protocol-json -- --case /absolute/case.json --validate-only

npm run accept:protocol-json -- \
  --case /absolute/case.json \
  --ready /absolute/ready-checkpoint.json \
  --rpc-file /absolute/read-only-rpc-config.json \
  --revm-bin /absolute/revm-sim \
  --out /absolute/new-acceptance-report.json
```

RPC 配置仍使用已有 `MAINNET_RPC_URL` JSON 键，文件保持本地且不提交。输出文件必须不存在；失败保留原报告，重跑使用新文件。已有源码、Ready、executor artifact、REVM、样本及验收器文件都冻结哈希；不把旧哈希覆写成通过。

样本格式：

```json
{
  "version": 1,
  "familyId": "protocol:example",
  "instanceKey": "实例的真实键",
  "lineageId": "已有生产 lineage",
  "source": { "number": 123, "hash": "0x完整的32字节块哈希" },
  "executor": "0x独立测试执行器地址",
  "owner": "0x独立测试origin地址",
  "trials": [
    {
      "id": "direction-and-amount",
      "tokenIn": "0x输入资产地址",
      "tokenOut": "0x输出资产地址",
      "amountIn": "1000000",
      "inputToleranceRawUnits": 0,
      "outputToleranceRawUnits": 0
    }
  ]
}
```

占位地址/哈希不能通过解析，必须换成实际资料。可选字段：`transactionHash`、trial 的 `expectedAmountOut`、`recipients`、`protectedBalances: [{token, account}]`。金额使用十进制字符串；容差仅 0/1 原始单位，输入欠扣与少到账分别计算。不能放 descriptor、成功标记、测试函数、状态覆盖或任意执行脚本。

## 7. 事实判断与限制

`protocol-json-acceptance-context.ts` 复用当前生产 catalog、自然 Ready、定义指纹检查和 issued rehydrate，绑定历史 hash/header/stateRoot；调用既有 strict adapter runtime 和本地 REVM transport。只给测试 actor 配余额/代码，不覆盖协议状态，不读私钥，不签名/广播。复用 Ready 不等于重新执行 strict，报告明确 `newStrictAttestation:false`。

`protocol-json-acceptance.ts` 按实际方向运行指定金额 Exact + quoted、独立 runtime；runtime 在 Exact 之前构造，禁止读取 I/O executor 或 quoted fallback。收款路径按声明覆盖执行器自身和独立 origin，并可加其他收款人。每条编码执行正例、零输入拒绝、强制最终回滚。dynamic quote-output 在同一 EVM 程序中先只读报价、再执行、再比较真实余额差；报告注明该证据口径，不能当成离线 Exact 数值一致。

`protocol-json-acceptance-facts.ts` 不信 JSON 的通过标签：核对 requestId、source/generation、完成类型、可信 transport provenance、唯一且完整的实扣/实收记录、保护资产与原生币。0 扣款、超请求扣款、超过 1 wei 的欠扣/少到账、缺观测、错来源、RPC 失败均不能通过。全额模式输入为请求原数，maximum 模式也必须有正实际扣款且不超过预算。规范化 EVM revert 的显式空 effects 只证明完成回滚，报告写 `completed-evm-revert`，不伪装成逐余额零值观测。

一个 case 只覆盖一个实际实例及其已准入方向；未取样方向列为 incomplete。真实状态拒绝保持拒绝，不能提升为执行支持。若声明 deferred-input/deferred-debt/settle-output，本单腿入口明确拒绝宣称回调通过；已有公共回调合同仍运行，真实 callback 执行需后续公共 case 能力，不能要求迁移窗口另写专用测试偷补。

本入口不重建 Ready、不做原交易中间状态复现、不证明自然估值、套利机会或时效性。不使用新增测试调度取代 live 生产阶段。适配正确性结论按实际变体、身份/接口、报价和双执行证据汇总；完整套利复现、自然集成及上线时效性单独记账，不混成一次单腿正确性结论。

## 8. 旧登记工具与验证记录

两个旧 `settlement-register-family.ts / settlement-register-boring.ts` 曾把整笔计划 success/grossProfit 写成单腿扣款/到账，并固定填 pass。实际 reader 对显式 false 的断言仍可能接受。独立复核确认后，公共 reader 拒绝这类旧整笔摘要；两个 writer 在读取外部配置/资料前立即拒绝。已有证据文件和 registry 原样保留，不重写历史成功。

公共套件在云端实际 dirty 源码快照和仅含本次修改的提交校验副本上均 **356/356** 通过；新 runner/context/facts 的严格类型检查通过，生产构建和清单生成/检查通过。新真实历史执行尚未运行。扩大运行原全域 `family-dual-execution.ts` 得到 **309/314**：缺少新增族的旧 fixture、以及 UniV3 静态报价两条旧断言，共 5 个失败；未修改基线在同样环境重现相同 5 个失败，不能称全域审计通过，也未删除或放宽这些断言。原始失败日志保存在 `logs/protocol-json-enabled-20261030/`，不入库。另一窗口只需要拉取提交、适配 JSON/数学与样本、运行上述公共入口；发现不支持的模块/真实失败交回框架窗口，不能修改公共断言或将其标成通过。

Astra 示例补数先手工核对 receipt 两条实际转账，再以当前索引的 `single-transaction,flow` 能力选取 `analysis:tx-flow` 经 `tool-run` 复核；输入 `828547461981284792867` 与输出 `133175015810372` 原始单位一致，仅借输入作为新状态测试量。执行 manifest 为云端 `logs/protocol-json-enabled-20261030/sample-tool-selection.json`，SHA256 `15246f13d61df0d0d532d6fabefa25e22f876fcc5a75e24f487587237a6ed52e`。一次连接错误和一次既有 analysis 依赖失效均保留；后者以临时依赖链接运行，完成后删除，未改原依赖链接。

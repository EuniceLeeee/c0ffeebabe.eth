# Protocol JSON 公共框架缺口交付（2026-10-29）

本轮只补 Family 公共 TS。代码落在 `/opt/mev-cloud/family-runtime-20261007` 的原分支 `codex/family-runtime-actual-20261007`，基线 `e57ac81bf1d91f102f36abfafe7da490eaf5b9bf`。未创建主任务分支/工作区，未改具体协议 JSON、开关、Ready 或 live。

迁移证据来自只读工作区 `/Users/eunice/Documents/deepseek-harness/default-workspace/work/protocol-json-20261028`。其 4/33 状态、parked 草稿、数学注册与未提交修改仍由迁移窗口维护。本文不把公共框架测试写成协议适配完成。

## 1. 发现与提名

`declarative-discovery.ts → compileDeclarativeDiscovery(definition, values?)` 保留旧版及新版定义。静态 Family 的 `candidateSources: []` 在公共编译时省略该可选生产字段；`defineProtocolFamily` 的严格生产合同不放宽。

新版可声明：

```json
{
  "candidate": {
    "kind": "conversion",
    "addressField": "vault",
    "fields": {
      "vault": "address",
      "payout": "address",
      "transactionHash": "bytes32"
    },
    "optionalFields": ["transactionHash"],
    "nullableFields": ["transactionHash"],
    "key": ["vault", "payout"]
  },
  "surface": {
    "id": "conversion-surface",
    "fingerprint": "conversion-surface-v1",
    "fields": {
      "vault": { "from": "emitter" },
      "payout": { "from": "opaque", "path": "payout" },
      "transactionHash": { "from": "opaque", "path": "transactionHash" }
    }
  }
}
```

这是字段示例，不能单凭 fingerprint 准入。`optionalFields` 只允许缺省，`nullableFields` 才允许显式 null；错误类型仍拒绝，候选键不能 nullable。`from: "observation"` 可读取真实观察的来源字段。`surface.predicates` 复用共同值表达式。

`events[].nominationOnly: true` 与空 `fields` 可把缺少完整参数的真实日志保留为提名线索，不制造完整候选。新 `nominationReadFlow` 使用原 read-flow 定义，由 `declarative-nomination.ts` 桥接既有 nomination provider；仅支持固定 `source.number` 的 get-code/get-storage/普通 return-data eth-call。输出 opaque 对象或 null；provider 失败沿原单项 unresolved 边界处理，不能改写为成功/revert/终态。它不签发 identity/quote 的准入证明，也没有新建搜索或调度。

生产入口已传共同 values；没有该扩展的旧调用仍兼容。原 wstETH、Rocksolid 草稿均在完整 `compileDeclarativeProtocol → defineProtocolFamily` 合同下由注册失败转为通过；不代表业务迁移已完成。

## 2. 多步报价证明与中间证据

`declarative-quote-proof.ts → quoteProofSteps / verifyDeclarativeQuoteChain` 消费单步旧格式，或新的有序 view 链：

```json
{
  "chainQuote": {
    "steps": [
      {
        "step": "assets",
        "requestId": "preview-assets",
        "signature": "function previewRedeem(uint256) view returns (uint256)",
        "amountPath": [0],
        "outputPath": [0]
      },
      {
        "step": "payoutShares",
        "requestId": "preview-payout",
        "signature": "function previewWithdraw(uint256) view returns (uint256)",
        "amountPath": [0],
        "outputPath": [0]
      }
    ]
  }
}
```

配合 JSON 的依赖步骤：第一步输入必须等于请求金额；下一步 calldata 的金额必须等于上一条真实返回；最终返回等于报价。每条调用都核对 ID、source、completion、provenance、规范 ABI 编码。JSON 不能用公式制造证明金额。Silo 的 payout 转换应保留 `previewWithdraw` 的原向上舍入语义，不能替换成 `convertToShares`。

`declarative-read-flow.ts → completedEnvironment()` 从完整已观察轮次重建 `$steps`。Exact 的证据可以引用它；需要在 quoted 执行时保留这些来源时显式启用：

```json
{
  "retainReadEvidence": true,
  "evidence": {
    "source": "$source",
    "amountIn": "$amountIn",
    "amountOut": "$amountOut",
    "exchangeRate": "$steps.rate.exchangeRate",
    "bindingFingerprint": "$route.bindingRef.fingerprint"
  }
}
```

这里是 `exact` 的局部字段，其他原字段继续保留。公共层附加 `readProof`，由真实初始/依赖结果组成；Family 不可覆盖此字段。`buildFragment()` 用同一声明重建调用、重跑检查与证明，并比较完整证据及输出金额，不信任消费者手填的中间值。`zeroEvidence` 可单独声明零额证据，避免虚构未发生的读取。

`trialState + retainReadEvidence` 暂不支持，在注册时拒绝。trial 转移的已签发状态证据继续走原路径；不能为了迁移绕过这一拒绝。

## 3. 部分能力与价格状态

`declarative-protocol.ts` 可接受明确的缺失 Exact：

```json
{ "exact": { "unavailableReason": "指定金额报价尚未迁移" } }
```

此时不提供 Exact method；独立 pricingFlow 与 runtime 可继续工作。这只供准确表达未完成能力，不能用来缩小原协议支持范围并宣称迁移通过。

`variant.pricing.classifyUnavailable` 返回 `[routeKey, reasonCode][]`。公共层核对键属于本价格组、无重复且理由非空；可以让已返回的零价/缺失方向撤价，其他正价方向继续产生 mid。未返回、RPC 失败、来源错配仍按原失败路径拒绝，不交给该分类器掩盖。

根 `pricing.sampleAmount` 可读取当前 source-bound flow 的 `$steps`、真实结果及 `$snapshot`，因此可保留依赖 totalSupply 等实际读数的取样。它不修改指定金额 Exact 的请求输入。

## 4. 动态方向与逐方向隔离

`routes.directions` 可为原静态数组，也可为共同值表达式，输出同样的方向条目。每条仍必须有 `id/enabled/tokenIn/tokenOut/adapterId/taxonomy`。可选 `fields` 声明额外绑定字段（如 pairIndex），不可覆盖核心资产/身份字段。

`routes.key` 可声明稳定路由键，`pricing.stateKey` 可声明价格组：

```json
{
  "pricing": { "stateKey": "$route.routeKey" },
  "routes": {
    "key": {
      "op": "join",
      "args": [
        ["$descriptor.familyId", "$route.target", "$route.tokenIn", "$route.tokenOut"],
        "\u001f"
      ]
    }
  }
}
```

这是根字段局部示例。使用实际已验证 token 集合生成全部有序不同币对；不静态铺 992 条方向，也不把目录外资产投影进去。公共层拒绝重复方向/键与同币输入输出。调用时按重新生成的完整路由核验额外字段，不能任意换 pairIndex 或身份。

`pricing.compileDraft` 要求每个组只含相同 stateKey 的行为已证路由。JSON draft/finalize 须保留本组 `routes`，不能塞回整实例所有路线；`bindingProjection` 可声明组内静态证据绑定。现有中央价格组调度负责独立成功/失败，无新调度器。

mutation 索引用内部规范键映射回原 opaque stateKey，indexed/fallback 均保留大小写，不合并仅大小写不同的组。只有完整深不可变 descriptor 才缓存方向投影与查找表；顶层冻结、内部 token 仍可变时不缓存。32 token/992 方向的离线回归证明复用及绑定，没有将其称为生产性能验收。

## 5. Map 与纯数学

`declarative-immutable.ts → immutableDeclarativeData` 复用 `exact-trial-state.ts` 原冻结器；新增导出不改变中央状态算法。数学输入/输出、readflow 输出及 trial 状态可保留嵌套 Map，包括 xWin/V3 的余额、池、bitmap、ticks。

Map 可读但不可 set/delete/clear；嵌套值冻结，primitive key 保持类型，旧 canonical projection 不改。Map 不进入 JSON 定义，也不偷偷变成 `{}`。数学允许 safe integer 元数据（索引/精度）与 null，金额由模型继续约束 bigint；任意实例/函数/访问器/循环对象拒绝。

实际状态提交、读取、后续 local quote、依赖失效和 V3↔xWin 回归覆盖了这条路径，不只是检查 `Object.freeze`。

## 6. 身份与报价中的 executor-program 模拟

`declarative-protocol.ts → materializeRequests()` 在 Family 边界把下列伪请求变成原生 `effect-delta-simulation`。中央 issuer 只接收原请求类型。

```json
{
  "kind": "declarative-execution-simulation",
  "id": "program-proof",
  "amountIn": "$amountIn",
  "protectedTokens": ["$descriptor.otherToken"],
  "observe": ["logs"]
}
```

`declarative-simulation.ts → buildDeclarativeExecutionSimulation()` 从同一 `execution` JSON 调用 `buildDeclarativeRuntimeLeg()`，再包装原 executor subscript 入口。没有第二份专用模拟动作，没有 raw mint 替代。JSON 不能提供 VM bytes、任意 caller/funding 或 preCalls；只覆盖图输入资产的指定金额，基础输入/输出/native 观察自动加入。native 仍声明原中央资产边界。

报价调用复用已签发 descriptor/route/executor/source，禁止通过 `context` 替换。Identity 尚无 admitted descriptor，可用伪请求的 `context` 从前轮已观察事实构造调用上下文；下一次 transport 仍必须验证真实 executor、代码、独立 origin 和来源。

读取器和身份阶段 decode 的观测上下文同时有真实 `requests/results`。两项新闭集操作只按 ID 取实际观测：

```json
{
  "op": "programReceipt",
  "args": [{
    "requestId": "program-proof",
    "source": "$source",
    "executor": "$executor",
    "tokenIn": "$route.tokenIn",
    "tokenOut": "$route.tokenOut",
    "amountIn": "$amountIn"
  }]
}
```

`simulationActor` 同样只声明 requestId/source/tokenIn/amountIn，从前轮 symbolic-executor 请求及唯一真实扣款记录提取 actor。禁止 JSON 传 request/result 对象，局部 let/命名参数也不能遮蔽入口的真实观测。`programReceipt` 核验空 subscript 返回、实扣/实收、额外 token 与原生币保全；事件断言仍由协议 JSON 声明。错误 actor/origin 在已有 transport 派发前拒绝。

Identity 的 requirements 现在也按 JSON 表达式求值并冻结，可按前轮结果选择所需能力。没有加入固定轮数或协议名称。

## 7. Compound 草稿和迁移分工

四条原断言不能删掉或放宽：

1. `exact.checks` 明确拒绝不支持的 prefix，包括已有 trial object；公共层在 requirements、requests、decode、local-zero 四入口执行该检查。
2. identity 对成功传输但 completion 为 revert 的实际观测，需通过 `successful/shape` 显式声明方向不可用与 retryable。RPC 失败继续由 RequiredAdapterRequestError 传播，不能把 throw 或 terminal 冒充原 retryable。
3. registry/active 每轮用既有 `assertSource` 对比先前证据来源；不要遗漏 generation。
4. 本地数学结果保留 exchangeRate，证据用 `$steps` 加 retained read proof；零额用明确 zeroEvidence。不能只给同数值 amountOut 就省掉原证据。

Yield Basis 的本地公式与 runtime 算术可分别登记进已有 `math / executionMath` 静态清单；空清单不是框架缺少入口。具体公式/JSON 与全部原方向事实验收由迁移窗口负责，本轮不把仅 withdraw 草稿算成原双向覆盖。

迁移窗口拉取本提交后，先跑原 family 合同与新增公共回归，再按原事实验收逐族推进。保留原 TS 备份、有效证据和失败记录；缺实现/缺声明/状态性拒绝/未验证分别记账。不得为了称完成缩小原取样、prefix、原生币或结算覆盖。

## 8. 验证与限制

- 云端实际 dirty 基线：**276/276** 相关回归通过；目标 strict TypeScript、`npm run build:live`、清单生成/一致性检查均通过。
- 仅含本提交修改的校验副本：**271/271** 公共解释器/执行/状态等回归、目标严格类型检查与生产构建通过。
- 扩大测试曾包含 `runtime-maximum-input.ts`：提交基线与本次副本均在同一旧测试桩报 `session.blocksPrefixInversion is not a function`（该文件其余 4 项通过）。这是未修改基线的独立测试桩缺项，未改中央 selector 来隐藏它；因此不声称干净提交的完整扩大集合全绿。云端实际 dirty selector 上该项通过，以上两种环境分别记录。
- 三个原 ERC4626 JSON 的方向、指定金额请求和 runtime bytes 保持；未改具体协议 JSON。
- 独立复核关闭了 opaque stateKey 大小写丢失、未支持的 trial/retained-proof 组合误报、JSON 伪造观测及局部 shadow 等问题；对应负例成为回归。
- 存在的 Anvil 保留；未停止/重启他人进程，未启动 live，不使用签名或广播。

全部补丁与原始失败记录在本地及云端 `logs/protocol-json-framework-gaps-20261029/`；raw logs 不入库。未执行新的协议链上验收、机会复现或 live/性能实验。未改另一迁移工作区，未将上述框架通过改写为 33 个 Protocol 已迁移。

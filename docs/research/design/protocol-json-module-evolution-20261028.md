# Protocol JSON 公共模块与事实验收设计

## 1. 范围与当前事实

本文前半部分记录源码盘点与目标契约，末节区分公共框架实现和协议迁移。**本窗口负责公共 Family TS 框架与合同回归；具体协议 JSON 适配及协议验收由另一窗口负责。** 不把设计、框架构建或 fixture 通过写成协议适配通过。

初次盘点基线：云端工作区 `/opt/mev-cloud/family-runtime-20261007`，HEAD `6295825b23cf53688d112162579f07235ca7a2aa` 加当时未提交修改；809 个相关源文件与只读审查副本逐一匹配。该次 loader 枚举 33 个 Protocol，issues=0，代码默认 22 开、11 关。下列盘点保留此历史来源，不推断当前 live 参数。本轮公共框架修改基于设计提交 `ea06b7fdf90bd61db04662a620241631d7ebfd19` 与云端实际未提交基线。Swap/Credit 不在改造范围。

ERC4626 是 1 个 Family：主 `erc4626.json` 与 Custodian/InfiniFi 两个子 JSON。它已由公共 Family TS 编译生产注册、发现、身份、实例/方向、价格/报价和执行。其他 32 个 Protocol 的迁移需求见第 6 节；本表是架构清单，不替代原 IMPL 进度表。

用户的兼容性要求：TS 新增模块后可识别 JSON 缺失/空块，统一格式中可展示对应空块；**不自动补协议实现、不推断支持、不专门新增 runtime 功能**。runtime 只是扩展机制的例子。

## 2. 迁移前公共能力与限制（历史盘点）

已有可复用部分包括 `declarative-discovery.ts`、`declarative-identity.ts` 的多阶段 request/decode/decide、`declarative-values.ts` 的受限表达式、变体归一化、类型生成、ABI 读写、授权和余额/供给断言。不要再造逐协议流程或把每族 TS 移进公共目录冒充共用。

盘点时的限制；本次公共框架已补部分见第 8 节，不能将这里的旧状态视为当前实现：

- `build-declarative-production.ts:102` 和 `declarative-protocol.ts:77` 固定字段集合；当前既不能任意添加新模块，也不能直接将必要块清空。
- `declarative-discovery.ts:24` 主要提取 call target，候选键是单地址；反向发现为 explicit unsupported。
- identity 已支持多阶段；pricing/exact 则是一次 buildRequests→results，结果锚定约定 ID。**同轮可以多请求**；缺的是上一轮结果决定下一轮调用的通用流程，以及纯本地数学的真实 source/方法声明。
- execution 目前按静态 ABI、一个主调用、一份全额 ERC20 debit/credit 和 direct-output 编译。不能据此直接声称篮子、动态参数、native、回调、最大预算均已可由 JSON 表达。
- `ExecutionSemantics.buildRuntimeLeg` 本身是可选接口；现有 ERC 编译器同时生成双接口。不应为演示新空模块而删减 ERC 已验证能力。

## 3. 必要的公共 TS 扩展

以下是能力边界，文件可依现有模块扩展，不要求机械新增同等数量的文件。

| 公共能力 | 必要扩展 | JSON 保留什么 |
|---|---|---|
| 模块目录/兼容读取 | 每模块注册 key、字段契约、版本、依赖和编译器；输出统一空块与缺项视图；事实要求继续由原验收负责 | 该 Family 的定义；未定义块为 `{}` |
| 发现与反向关系 | calldata/log 字段映射、参数谓词、复合键、factory/registry/proxy 关系核对 | selector/event、字段、关系调用、约束 |
| 身份与证明流程 | 复用现有阶段机；扩充 clone/存储/相互引用证明和 effect proof 模板 | 分阶段读取、解码、判定、每实例证明要求 |
| 状态读取/报价/刷新 | 多轮依赖、call/log 触碰、view/effect-simulation/local-math 三类来源、必要 trial-state 与 prefix projection | 依赖、函数、轮次引用、刷新条件、纯数学模型输入 |
| 调用与资产效果 | 多步动作、动态 tuple/array ABI、调用时金额计算、篮子、多资产 effects、全额/预算内扣款 | ABI、参数、动作依赖、资产和金额约束 |
| 结算 | native 实收/包装、指定收款方、callback 鉴权/债务/先后顺序、返回码/拒绝语义 | 协议参数、callback/recipient 声明、错误码含义 |
| 完成状态汇总 | 复用原有事实验收及其可信 producer、校验器；仅将既有结果与声明能力/空模块按范围对齐 | 不新增“事实验收框架”；不把自填 `passed:true` 或路径存在当成成功 |

**本地数学是独立 TS 数学模块的入口，不是 JSON 中的公式。** 简单比例和复杂不变量都通过已注册、版本化的数学入口执行；JSON 声明模型、输入来源和结果用途，公共 Family TS 负责读状态、校验输入、调用模块、校验结果。普通 ABI、授权、调用顺序、回调和结算不能藏进数学函数。已有声明中的通用值绑定与整数边界操作保留兼容，不借此继续把协议公式塞进 JSON。

**调用几步，由 JSON 决定。** JSON 列出有序步骤、调用目标/函数、参数、保存结果以及下一步引用；公共 TS 遍历、校验并编译步骤，既不写死“两步/三步”，也不按 Family ID 分支。一次读取可声明同轮多个独立请求，有前后结果依赖时才分轮；复用当前生产请求调度。执行动作同样由步骤定义，共用授权清理、实扣/实收和旧库存保护不能逐族重写。VM/请求预算仍是通用上限，不是协议步骤数。

以下是多步读取的**契约示意**，具体字段以末节实际 API 为准；不是已适配协议或执行证据：

```json
{
  "steps": [
    {
      "id": "relationship",
      "function": "asset()",
      "target": "$instance",
      "save": "asset"
    },
    {
      "id": "balance",
      "function": "balanceOf(address)",
      "target": "$steps.relationship.asset",
      "args": ["$executor"],
      "save": "balance"
    }
  ]
}
```

公共 Family 层调用已有 issuer/executor/调度，不建立另一套 live 管线。

## 4. 新模块为空的兼容机制

公共模块目录是唯一能力目录。**新增 TS 实现时登记一次**；系统根据目录生成字段契约与覆盖视图；TS 类型继续由公共模块定义，不扫描函数名字猜协议语义，也不是实例地址 allowlist。

处理顺序：读取旧格式 → 按已支持版本做确定性归一化 → 逐模块校验 → 编译已定义能力 → 输出能力状态。默认只读，不改原 JSON。明确要求输出新格式时，才生成保留旧内容的新表示；新增模块可以是空块，不填 selector、公式或动作。

例如以下只是新增块的格式片段，不是可独立执行的 Family 定义：

```json
{
  "modules": {
    "newCapability": {}
  }
}
```

| 状态 | 含义与处理 |
|---|---|
| 键缺失或 `{}` | 未定义；保留原有能力，报告缺项，不生成该接口、不宣称通过 |
| 非空且合法 | 可编译；仍需事实证据才能验收通过 |
| 非空但无效/未知版本 | 配置错误，不能当空块忽略 |
| 有依据的不适用 | 独立记录原因及证据；不能仅由空块推导 |

缺失与空块在能力判定中等价。依赖空模块的动作明确不可用，不能跳过调用或回退另一条执行来假装完成。原有必需的身份/安全约束保持必需；新增可选模块不能无条件变成所有旧 Family 的启动必填项。

兼容承诺是原定义语义、输出和原有接口不因新增可选模块而变化。执行规则有破坏性变化时使用新契约版本或显式迁移。指纹/证据安全检查照常生效；不能保证代码变化后旧缓存永久有效，更不能覆写 hash 绕过重验。

## 5. 适配完成靠事实，不靠 JSON 填满

保留三层独立结论：

1. **格式合法**：ABI、整数/类型、引用和依赖能被安全解释。必要字段由实际声明的动作及依赖决定，未使用的模块不要求填业务内容。
2. **实现可用**：公共编译、现有 fixture/负例/接口接线通过。字段齐全、方法存在、返回 `true` 均不足以证明实际协议行为。
3. **声明范围内适配正确性通过**：可信生产同源入口产生的事实覆盖全部应支持实例/方向/变体和所用能力；未覆盖仍明确保留。

所需事实由既有支持范围、实际部署能力和本次要求共同确定，不能由待测 JSON 自己缩小。迁移前后保留旧版本/方向/变体，禁止通过删掉能力让验收变绿。

按适用情况核查：自然发现及反向身份、指定金额报价、同状态实际扣款到账、已有 quoted/交易内实收接口、recipient/callback、返回码、容量/舍入、零扣款/旧库存/少到账/原生币/失败回滚等。并非每族都必须支持 callback、native 或队列；不适用要有事实依据。没有实际实例的变体不强造样本；这不等于它被执行验收通过。

**原来的真实执行测试已经是事实验收，不另造测试框架，也不替换既有测试。** 调整的是完成状态汇总：旧支持范围继续用原验收；新增空模块显示未定义，不抹掉旧范围的有效结论；填好以后再跑对应既有验收。

现有事实入口复用：各 Family 历史 dual/recipient harness、生产 strict，以及 `family-settlement-review.ts` 的 source closure 与 behavior evidence 校验。结构检查、合成 fixture 和 source-pinned 历史事实分别展示；某些 `behaviorValid` 仅来自视图/公式，不能作为余额执行证明。保留已有 gate 的可信 producer 边界，不另收一份可任意手填成功的报告来替代事实。

统一结果按 `family × 实际变体 × 方向 × 能力` 给 `通过 / 失败 / 未验证 / 有依据不适用`。新增空模块显示“未定义”，不追溯否定已有 scope 的有效证据；若该模块已是承诺范围的必需项，则该范围尚未完成。通过结论绑定源码、状态、金额、执行环境和证据有效性。

单块 Ready/自然集成、原 TX 机会复现、时效性仍分列，不能由 JSON 改造或局部行为事实直接推导；不因新增空模块自动重建 Ready 或重跑 live。

## 6. 全部 33 个 Protocol 盘点

“默认”是源码默认值；必要扩展是源码审查判断，尚未等价迁移/验收。详细逐文件依据见同名 JSON。

| Family | 默认 | 迁移前必须表达或核对的语义 |
|---|---|---|
| `protocol:arcana-migration` | 开 | 带参数的复合发现键；source/tokenId 身份基数核对；视图证明与实际执行证明分开。 |
| `protocol:astra-multitoken` | 开 | 按部署/种类选择 ABI 与方向；原生币资产边界；保留实际费用与容量检查。 |
| `protocol:badger-sett-withdraw` | 开 | 多轮依赖读取、代理/存储关系证明、调用时数学、trial-state；仅同步可用资产。 |
| `protocol:boring-vault-teller` | 开 | caller/权限/额度与即时提现条件；视图比例不能替代实际扣款到账。 |
| `protocol:eigenpie` | 开 | 关联合约与依赖读取；方向条件和供给/余额事实；异步领取不投影为即时资产。 |
| `protocol:erc4626-silo-redeem` | 开 | calldata/log 参数发现；结果驱动的多轮读取；份额、底层、payout 资产分别建模。 |
| `protocol:erc4626` | 开 | 已有完整 JSON 样本；先补公共模块目录、兼容读取和能力/事实状态，不新增专用 TS。 |
| `protocol:ethertoken-native-redeem` | 开 | native 实收与 ERC20 burn 分别计量；接已有公共 ETH/WETH 资产边界。 |
| `protocol:goldx` | 开 | 命名 TS 数学入口及不支持原因；JSON 只绑定输入/结果，不从单位报价推导执行事实。 |
| `protocol:mellow-queue` | 开 | 复合事件/调用候选；动态 bytes32[] ABI；队列权限/延迟到账边界。 |
| `protocol:metronome-hgusdc` | 开 | 前轮结果驱动后轮报价；多步合约/代币转款；中间余额和总实收约束。 |
| `protocol:metronome-synth` | 开 | 同时支持 pool log 与 OracleForwarder call 的依赖触碰；indexed/fallback 行为一致。 |
| `protocol:olympus` | 开 | index 等状态驱动的调用时数学；unwrap/unstake 多步动作及份额舍入。 |
| `protocol:ondo-usdy-instant-redeem` | 开 | 容量/权限/即时赎回条件；保留资产及代码关系；补事实证明不能只凭 behaviorValid。 |
| `protocol:psm` | 开 | 最大输入预算/实际扣款策略；fee 与额度守卫；保留非零扣款及实收安全。 |
| `protocol:rocksolid` | 开 | 现有标量 ABI 调用、授权、余额断言基本可复用；定义 caller/receiver 参数即可。 |
| `protocol:self-burn-native` | 开 | 调用参数谓词与联合证据发现；自烧供给变化、费用数学、原生币实收。 |
| `protocol:set-redemption` | 开 | 两版 Set 能力保留；篮子、多资产 effects 与多步动作；不能只套一借一收。 |
| `protocol:staked-usdat` | 开 | 代理/实现/存储证明；复用守卫；独立纯数学；保留现有 each-block 刷新要求。 |
| `protocol:token-conversion` | 开 | 按已有 1:1/包装变体声明关系与动作；保留实际执行和供给/底层约束。 |
| `protocol:token-migration` | 开 | xWin 的依赖读取、本地数学和状态转移；局部执行 projection/prefix 语义。 |
| `protocol:wsteth` | 开 | 现有标量调用/方向/授权可复用；指定金额实际调用，不用点价格线性外推。 |
| `protocol:compound-ctoken` | 关 | 返回错误码可复用 call save/check；按需补 exchange-rate/利息状态数学和 native 边界。 |
| `protocol:curve-lp` | 关 | 四类已声明 lineage 的数学分别保留；定长/动态 ABI、调用时金额、原生币/组合资产语义。 |
| `protocol:default-collateral` | 关 | clone/实现证明、每实例 backing/capacity 与行为校验；不靠 class hash 放行。 |
| `protocol:few-wrapped` | 关 | factory 反向关系；effect-simulation 报价结果；指定收款方与供给/旧库存断言。 |
| `protocol:metafactory` | 关 | 原生币 pro-rata 实收及包装边界；多资产余额/供给守恒与调用时数学。 |
| `protocol:origin-ousd` | 关 | 依赖/重基/价值数学；资产域和实际份额赎回边界。 |
| `protocol:origin-steth-arm` | 关 | price words、容量、反向关系；本地报价数学和调用时状态一致。 |
| `protocol:peapods-debond` | 关 | 数组 ABI、份额 burn、多资产输出与费用/舍入；不扩展锁仓库存策略。 |
| `protocol:psv` | 关 | 代理/资产别名证明；caller/recipient 敏感报价；quote-output/临时执行结果封装。 |
| `protocol:yearn-auction` | 关 | 回调鉴权、债务和先后顺序；最大预算、时间/价格数学及非零实际扣款。 |
| `protocol:yieldbasis-lt` | 关 | 金额相关状态/费用数学与容量守卫；保留各方向实际执行及同步资产条件。 |

## 7. 公共测试需要覆盖的契约

- 同一旧 JSON 在目录新增可选模块前后：报价、调用编码、原有能力结果一致；新项为未定义。
- 缺块与空块一致；输出统一格式不填业务参数；归一化/格式输出幂等，不丢原定义和子变体。
- 不合法非空块、未知版本、拼错 key、循环依赖、缺必需输入必须拒绝。
- 缺可选模块不阻断无关已支持动作；请求缺失能力明确拒绝，不静默 fallback。
- 非空完整 JSON 加错误实际返回/错误到账仍失败；空新增模块不冲掉既有事实结论。
- 旧范围移除、方向漏测、source/状态/金额错配、证据过期或仅 fixture 的“成功”不得作为实际行为通过。
- quote/view、本地数学与 simulation 事实分类正确；实际扣款、实收和旧库存保护继续由独立断言验证。

这些是模块兼容、公共流程和完成状态汇总的回归要求；不另造协议事实 producer。协议数学/执行/strict 等已有测试继续复用，33 族实际执行验收由协议迁移窗口负责。

## 8. 本轮公共框架交付与协议迁移接口

仅实现 Family 公共解释器及必要模块，不修改 33 个 Protocol 的业务定义、开关、Ready 或 live。ERC4626 主/子三个 JSON 原样用于兼容回归。新增能力没有协议事实验收时，保持“公共框架已实现 / 协议未迁移、未验收”。

### 调用顺序与公共文件

| 顺序 | 公共文件 / 核心入口 | 消费的定义与职责 |
|---|---|---|
| 1 | `build-declarative-production.ts` → `createDeclarativeProtocolRuntime()` | 继续生成共同生产入口；校验根定义和子定义的 `modules`。不生成新的逐族 TS 行为。 |
| 2 | `declarative-modules.ts` → `createDeclarativeModuleCatalog().read()`；`declarative-protocol-modules.ts` → `readProtocolModules()` | 按版本验证、解析依赖、编译可用块；`moduleViews` 展示统一 `{}`，`moduleCoverage` 展示 `undefined / blocked / compiled`。这些状态不是适配通过。 |
| 3 | `declarative-discovery.ts` → `compileDeclarativeDiscovery()` | 旧版保持原义；新版定义 call/log 参数、目标/发出方、谓词、复合候选键。一次观察允许多个独立候选。 |
| 4 | `declarative-identity.ts` → `compileDeclarativeIdentity()` | 根/子变体均可直接使用已有通用阶段机；读取、关系和行为证明由 JSON 定义，不要求 conversion 专用 workflow。 |
| 5 | `declarative-read-flow.ts` → `compileDeclarativeReadFlow()`；`declarative-trial-state.ts`；`declarative-protocol.ts` 的 pricing/exact | `quoteFlow / pricingFlow` 按 JSON `steps` 生成初始与依赖轮次请求；来源、轮次、请求 ID 必须一致。调用现有 issuer 与调度，不自行发送 RPC。`trialState` 复用原状态提交器，读取当前状态并声明变化。 |
| 6 | `declarative-math.ts`；`declarative-runtime-math.ts` | `math / executionMath` 仅绑定已静态注册的 TS 模型及版本。前者作本地纯计算，后者将 TS 算术模型展开为现有 VM 运算；JSON 不承载协议公式。 |
| 7 | `declarative-execution.ts`、`declarative-call-codec.ts`、`declarative-callback.ts` | `execution.version:2` 定义有序调用/数学步骤、结果引用、授权、资产 effects 和结算。quoted/runtime 共用编译器；旧 v1 定义保留。 |
| 8 | `declarative-quote-proof.ts` 与既有验收入口 | chain quote 声明必须指向实际请求：ABI 输入等于请求金额、返回等于结果；effect simulation 核查扣款/到账。继续使用既有协议测试，框架不生成自证“通过”。 |

### 新模块的空块与继承

```json
{
  "modules": {
    "math": {},
    "executionMath": {},
    "quoteFlow": {},
    "pricingFlow": {},
    "trialState": {}
  }
}
```

这是公共读取器生成的统一展示，不会改写原 JSON。根块由子变体继承；子变体显式 `{}` 表示未定义该块。非法非空根块不能被子块遮住。依赖尚未定义时标为 `blocked`，调用该能力明确失败；独立的原有能力继续可用。

目录扩展只需公共 TS 登记新模块，旧 JSON 自动看见新的空块；不自动生成选择器、数学参数或执行动作。旧核心身份、安全、路由字段仍按原版本的必需契约校验。

### 多步读取的实际格式

下面是字段形式示例，不是已验收协议。`requirements / requests` 使用现有 AdapterRequest 合同；`data` 可由现有 ABI 值绑定生成。

```json
{
  "version": 1,
  "steps": [
    {
      "id": "relationship",
      "requirements": { "transports": ["eth-call"] },
      "requests": "$relationshipRequests",
      "result": "$relationshipResult"
    },
    {
      "id": "quote",
      "requirements": { "transports": ["eth-call"] },
      "requests": "$dependentQuoteRequests",
      "result": "$dependentQuoteResult"
    }
  ],
  "result": "$steps.quote"
}
```

每步 `result` 或 `decode` 二选一；后一步用 `$steps.relationship` 引用前步结果。公共层遍历步骤，拒绝前向引用、缺轮次、重复/丢失请求、来源错配。多步不是固定两步；128 步是解释器结构保护，实际请求和 VM 预算继续由原管线约束。

`quoteFlow` 在上述结构之外要求 `sourceKind`。`view` / `effect-simulation` 还要求 `chainQuote` 指定证据步骤/请求；view 再声明 ABI 签名、输入金额和输出金额的路径。`local-math` 不能声明 `chainQuote` 或取得 `chainAmountQuote` 标记；它需要有效 `trialState`，或明确的 `localStateUnsupportedReason`。

`trialState` 用 `reads` 声明有序状态引用、初始读数与依赖，用 `model / input` 调用纯数学入口，用 `amountOut / stateChanges / stateEffects` 映射结果。首次缺状态才走原 readflow；后续已有 trial cell 必须优先于新 source baseline。绑定或依赖失效直接抛错；不会清空状态继续报价。需要链上 guard 的本地命中返回 `not-applicable`，继续原带 guard 的读取路径。状态提交仍由原 issuer 负责。

### 执行与结算边界

多步调用可以引用前一步保存值；固定形状的 tuple/array 可包含运行时金额。运行时 ABI 叶子目前只支持 `uint256 / bytes32`，其他 ABI 类型可用静态值；窄整数、动态长度或字节填充不能凭声明伪装已支持。

公共编译器强制正输入、真实扣款/实收、旧库存和原生币余额边界。最大预算必须明确声明，不能用零扣款冒充成功。native 原始资产由方向声明，包装继续交给共用中央资产边界；当前 native 输出只接受执行器收款。

声明的 deferred callback 使用共用调用方/回调数据鉴权、债务上限、实际输出及支付检查。只支持已明确编码的回调形状；不自动猜测任意协议回调，不据接口存在宣称协议通过。

### 仍由迁移窗口负责

- 为具体协议写 JSON、注册纯 TS 数学模型及版本；两个数学注册清单目前不含新的协议业务模型。
- 迁移 retained reverse-discovery 需先核对既有公共能力；当前声明式发现的该接口仍明确 unsupported，identity 阶段的链上关系证明不能冒称已实现反向发现。
- 队列、非即时资产、多资产路线及原生币 effect proof 等具体语义须逐项核对；目前 effect quote proof 只对 ERC20 扣款/到账给出支持，不泛化为 native 证明。
- 更新于 2026-10-29：trial-state 数学边界已支持嵌套只读 `Map`，共用原状态冻结器和提交器，保留类型与依赖失效语义。旧 xWin 数学/组合回归不能替代 xWin 的 JSON 协议迁移验收。
- 保留每族原版本/方向/变体和已有有效证据，补新增能力对应的原测试；没有实际实例的变体按既定口径记录，不强造通过。
- 完成状态仍由既有验收报告维护。本轮不引入新的事实 producer，不把 `compiled` 写成“适配已通过”，不自动跑 live。

### 验证记录

- 云端实际 dirty 基线：公共解释器、ERC4626 原 JSON 接线、生成边界、native/最大输入/结算和 trial-state 相关回归 **208/208**；新增目标严格 TypeScript 检查、`npm run build:live`、生成清单及其一致性检查通过。
- 仅含本次修改的提交内容校验副本：生产构建、生成清单检查及模块/生产接线/trial-state 回归 **26/26** 通过。
- 独立复核已关闭回调最低输出遗漏、运行时 ABI 类型误报、native 收款能力误报、交易 origin 透传和缺依赖导致旧能力启动失败等问题。旧 v1 字节码兼容回归通过。
- 测试前后未更改任何具体协议 JSON；未运行新 live、协议链上验收或性能测试。结果只证明公共框架与现有接线合同，不能推导 33 个 Protocol 已迁移。

本地证据目录 `logs/protocol-json-framework-20261028/`；云端同名目录保留全部初次失败、修复后成功、原生成清单和日志。历史盘点的旧 `sourcePins` 原样保留；本次框架指纹与验证范围另记在同名 JSON 的 `implementationReceipt`。当前含其他未提交代码的云端清单与提交内容清单分别按各自真实源码生成，不手改旧 hash 过门。


## 9. 2026-10-29 迁移窗口缺口回填

在本窗口原云端工作区补公共 TS，另一迁移工作区及其 JSON/未提交修改只读保留。此次不迁移具体协议、不改 Family 默认、不启动 live。

- G1：两版发现定义的空 `candidateSources` 不再投影为无效的生产字段；插件自身仍拒绝无效声明。原 wstETH/Rocksolid 草稿有完整注册失败→通过对照。
- G2/G4：有序 view 报价证明链与中间观测证据；可选 retained read proof 在 quoted 执行前重新核验。
- G3/G6：明确未提供 Exact 时保留独立价格能力；JSON 申明逐方向零价/不可用原因；RPC/缺结果仍失败，不能包装成有效价格。
- G5：opaque/来源字段、optional/nullable 字段、仅作提名线索的日志及固定 source 的提名读取流程。
- G7：已验证实例数据驱动的方向列表、稳定键/额外绑定字段、逐方向价格状态组；失效索引保留 opaque key。深不可变实例复用投影。
- G8：纯数学/读取结果/试算状态支持不可变嵌套 Map，复用现有状态签发与提交机制。
- G9：身份与报价流程可把同一执行动作编译成 executor-program 模拟请求；共用代码按实际 request ID 取真实观测，不允许 JSON 伪造或局部遮蔽 receipt。
- G10：Compound 的 prefix、revert 分类与跨轮来源属于草稿需要补回的声明；exchange-rate 中间证据已有公共入口。原失败断言继续保留，尚未把 Compound 重新迁移/验收。

详细字段、调用点、测试范围和仍不支持的组合见 [公共框架缺口交付与迁移接口](protocol-json-framework-gaps-20261029.md)。新增字段是显式 opt-in；旧三个 ERC4626 JSON 未改。`trialState + retainReadEvidence` 暂不支持并在注册时明确拒绝，不能登记为已编译能力。

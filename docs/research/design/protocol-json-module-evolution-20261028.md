# Protocol JSON 公共模块与事实验收设计

## 1. 范围与当前事实

本轮是源码盘点和验收契约设计，**尚未实施下文的新模块机制、修改生产验收判定或迁移其他 Protocol**。不把设计完成写成适配通过。

云端工作区 `/opt/mev-cloud/family-runtime-20261007`，HEAD `6295825b23cf53688d112162579f07235ca7a2aa`；仍有未提交修改。809 个相关源文件以 SHA-256 与只读审查副本逐一匹配。当前生产 loader 枚举 33 个 Protocol，issues=0；代码默认 22 开、11 关，不推断当前 live 参数。Swap/Credit 不在本轮改造范围。

ERC4626 是 1 个 Family：主 `erc4626.json` 与 Custodian/InfiniFi 两个子 JSON。它已由公共 Family TS 编译生产注册、发现、身份、实例/方向、价格/报价和执行。其他 32 个 Protocol 的迁移需求见第 6 节；本表是架构清单，不替代原 IMPL 进度表。

用户的兼容性要求：TS 新增模块后可识别 JSON 缺失/空块，统一格式中可展示对应空块；**不自动补协议实现、不推断支持、不专门新增 runtime 功能**。runtime 只是扩展机制的例子。

## 2. 现有公共能力与真实限制

已有可复用部分包括 `declarative-discovery.ts`、`declarative-identity.ts` 的多阶段 request/decode/decide、`declarative-values.ts` 的受限表达式、变体归一化、类型生成、ABI 读写、授权和余额/供给断言。不要再造逐协议流程或把每族 TS 移进公共目录冒充共用。

实际限制：

- `build-declarative-production.ts:102` 和 `declarative-protocol.ts:77` 固定字段集合；当前既不能任意添加新模块，也不能直接将必要块清空。
- `declarative-discovery.ts:24` 主要提取 call target，候选键是单地址；反向发现为 explicit unsupported。
- identity 已支持多阶段；pricing/exact 则是一次 buildRequests→results，结果锚定约定 ID。**同轮可以多请求**；缺的是上一轮结果决定下一轮调用的通用流程，以及纯本地数学的真实 source/方法声明。
- execution 目前按静态 ABI、一个主调用、一份全额 ERC20 debit/credit 和 direct-output 编译。不能据此直接声称篮子、动态参数、native、回调、最大预算均已可由 JSON 表达。
- `ExecutionSemantics.buildRuntimeLeg` 本身是可选接口；现有 ERC 编译器同时生成双接口。不应为演示新空模块而删减 ERC 已验证能力。

## 3. 必要的公共 TS 扩展

以下是能力边界，文件可依现有模块扩展，不要求机械新增同等数量的文件。

| 公共能力 | 必要扩展 | JSON 保留什么 |
|---|---|---|
| 模块目录/兼容读取 | 每模块注册 key、schema、版本、适用条件、依赖、编译器和证据要求；统一生成格式、类型与缺项视图 | 该 Family 的定义；未定义块为 `{}` |
| 发现与反向关系 | calldata/log 字段映射、参数谓词、复合键、factory/registry/proxy 关系核对 | selector/event、字段、关系调用、约束 |
| 身份与证明流程 | 复用现有阶段机；扩充 clone/存储/相互引用证明和 effect proof 模板 | 分阶段读取、解码、判定、每实例证明要求 |
| 状态读取/报价/刷新 | 多轮依赖、call/log 触碰、view/effect-simulation/local-math 三类来源、必要 trial-state 与 prefix projection | 依赖、函数、轮次引用、刷新条件、纯数学模型输入 |
| 调用与资产效果 | 多步动作、动态 tuple/array ABI、调用时金额计算、篮子、多资产 effects、全额/预算内扣款 | ABI、参数、动作依赖、资产和金额约束 |
| 结算 | native 实收/包装、指定收款方、callback 鉴权/债务/先后顺序、返回码/拒绝语义 | 协议参数、callback/recipient 声明、错误码含义 |
| 事实验收 | 按已承诺范围匹配可信 producer 事实证据，区别格式/局部/实际行为结论；复用现有验收入口 | 不把自填 `passed:true` 或证据路径存在当成成功 |

复杂数学仍可保留纯数学模块，JSON 引用版本化模型及输入。普通 ABI、授权、调用顺序、金额传递和结果断言不能藏进所谓数学函数。公共 Family 层调用已有 issuer/executor/调度，不建立另一套 live 管线。

## 4. 新模块为空的兼容机制

公共模块目录是唯一能力目录。**新增 TS 实现时登记一次**；系统根据目录生成统一 schema/类型/覆盖视图，不扫描函数名字猜协议语义，也不是实例地址 allowlist。

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
| `protocol:goldx` | 开 | 命名纯数学及不支持原因；声明式整数算式，不从单位报价推导执行事实。 |
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

这些是待落地的公共判定测试要求。本轮只执行了源码指纹与 production loader 清单读取，没有改写判定代码，也没有重新运行 33 族实际执行验收。

## 8. 实施顺序

先实现统一模块目录、旧格式兼容读取、空块/能力报告和条件必填校验；再把现有可信事实入口接成共同覆盖判定。用原 ERC4626 三个 JSON 验证无语义变化后，从简单标量转换族逐个迁移；多轮读取、多资产、native/callback 等通用能力由真实族需求驱动增加。每族保留旧能力，按事实验收再切换生产入口。关闭项保留关闭状态。

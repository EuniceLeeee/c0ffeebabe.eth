---
name: family-plugin-adaptation
description: 新增或修改 Adapter Family、接入 strict，或制定与执行适配验收。检查指定金额报价与交易内实收双接口、历史单块 Ready/Graph/价格及生产阶段时效性。不把单族验收扩成全量重建或 live；纯机会复现另用 mev-blockscan-replay。
---

# Adapter Family 适配与验收

## 范围与完成口径

先确认实际实现工作区，读取其 AGENTS.md、CLAUDE.md 和当前验收契约。实现 Family 时再读项目指定的 Family 架构文档和模板；不要从旧工作区调用不同版本的工具。

多人或跨模型交接时，先按[工作区与交接](references/acceptance-entrypoints.md#八工作区与交接)固定源码基线、文件归属、样本和验收入口。分支 HEAD 不包含未提交改动；独立分支也不等于独立工作目录。

**默认顺序：真实样本 → Family 内实现 → 局部测试与 strict → 同状态双接口对照 → 历史单块 Ready → 自然入图、价格与相关阶段时效性。**

**本 skill 与机会复现分开：** 从真实交易 receipt 得到 N，Family 适配采用 N 的交易证据，strict、单块 Ready、mid/effective 和同状态编码执行对照默认使用 N 状态＋N 执行环境；不能套用机会复现的 N−1。若要与原交易该腿的实际输出逐单位一致，另按该腿调用前状态核对，N 块末不自动等于调用前。只有用户另外要求机会复现，才转入统一的 `mev-blockscan-replay`：先判断 blockscan/backrun，再准备对应状态与环境，分别调用各自真实的 live 管线；不能用触发后 blockscan 搜索替代 backrun 检测。

这是证据依赖顺序，不是另建多条验收管线。相同代码/配置、样本与状态下已有的有效结果直接复用；一个生产入口已完成 strict→Graph，就检查其产物，不再重复跑自建 strict。strict 未通过的 Family 不先投入大范围 rebuild 或机会复现。

用户只要求整理流程或更新 skill 时，仅检查源码并更新说明，不自动跑链、重建 Ready、启动 live 或修业务代码。

| 结论 | 所需证据 |
|---|---|
| 实现与局部测试通过 | build、Family 合同测试、相关共用合同回归 |
| strict 样本通过 | 当前 strict catalog 下，真实样本完成身份验证、实例准入及适用的执行检查 |
| 历史单块集成通过 | 自然发现 → admitted Ready → 生产 Graph → raw mid 与指定金额 effective；附同状态金额对照 |
| 双执行能力通过 | 原指定金额 quote＋quoted fragment 与实收 runtime 分别有行为测试/执行证据；生产 sim 试额构造无链外 Exact、无报价回退 |
| 局部时效性已验证 | 同输入生产阶段计时、真实更新与复用分列、前后输出核对；不等于整轮 live 达标 |
| 正式修复/可合入 | 仓库 gates.md 要求的 Adapter Replay baseline→candidate 翻转、conformance 与 family_local 边界证据 |
| 生产机会已修复 | 另行验证自然枚举、该 lane 当前生产选额器、独立 final sim、EV；不能由单族集成推导 |

不要把整个架构迁移的 S1 cutover、全系统 sealed-corpus、14400 块 rebuild、250 块 live、盈利闭环排名当作每个 Family 的默认必经步骤。正式合入契约确实要求的证据不能删除；明确用途，不拿轻量验收冒充合入结论。

## 1. 真实样本与历史锚点

- 优先使用用户交易或现有 strict 永久缓存中的交易线索；缺样本再用现有真实样本发现方法。执行前读取 [验收入口与测试覆盖](references/acceptance-entrypoints.md)。
- 从真实 receipt 得到 **N**，核对缓存的 blockNumber、blockHash、transactionHash 及链 ID。缓存候选的发现块、identity 验证块、Ready 发布块是不同字段，不能混用。
- strict checkpoint 保存候选/准入证据，**不是完整交易 receipt、trace 或历史状态数据库**。缺失证据从对应链历史 RPC 读取，不编造。
- 记录池/实例、方向、实际 amountIn、输出收币者；未知或不适用样本记“未验证”。先区分新 Family、未接 strict、实例识别失败和执行权限失败，复用已有实现。
- 公共 Vault/Core/模块按 pool key、篮子或市场拆分实例；不能整地址排除，也不能把入口个数当实例数。selector/topic 和已验证源码用于归组，不能代替同历史状态下的身份反向验证；已有协议名字不等于所有版本/Hook/方向已支持。
- 缓存没有命中不是结束：在授权预算内继续查已有历史报告和真实样本发现工具，再说明缺证据的原因。live 没触发也不等于 Family 不支持；已有 live 的同源成功样本可作为证据，缺样本的补历史单块，不为补验自动再开 live。

## 2. 实现边界

- **先盘点现成能力，再加接口。** 对照 Family 模板、中央 issuer、已有报价/余额/执行 backend 和测试，说明本次缺的是注册、接线还是协议语义。原接口支持指定输入/输出就复用；不能把“支持指定输入”写成所有 Family 都支持 exact-out。
- **实现前核对依赖刷新接线。** 区分固定身份与动态价格/权限依赖，确认依赖地址如何从链上解析、由谁监听、如何映射回实例，以及当前生产入口是否实际消费这些声明。`dependencies`/`mutation` 写好了不等于接通；预言机被 touched 也不等于依赖它的池子被刷新。相关检查见参考文件的“依赖与状态变化”。
- 遵循 `listener/src/searcher/templates/family-plugin/README.md`。身份、ABI、状态解码、fee/精度、定价、容量、执行编码归 Family；反向验证 factory/registry 等链上身份，不做实例准入白名单。
- 身份结论不得超过证据：相同运行时代码和 factory 存储绑定可证明行为，不自动证明创建关系；声明 factory-child 需对应创建/注册证据。可变预言机或实现地址不得冒充永久固定身份。
- 补齐 domain 必需槽，通过既有 generated catalog 注册。旧 adapter 存在不等于 strict 已接入。
- 按本次动作而不是品牌划分 domain：不建立用户债务的份额赎回属于 Protocol；借还款/抵押债务才按 Credit 语义检查。确认原操作的实际收币、权限及是否延迟到账；不能把锁仓/排队赎回投影成同交易可用的资产，也不因样本含清算就扩大策略范围。
- Swap/兑换类复用原 `ExactQuoteSemantics`：effective、显式报价及仍配置使用的 Solver 共用指定金额报价接口。**不新增 effective 专属接口、producer、Family 复用判断或独立验收计算管线。**
- **兑换类必须保留并分别验收双接口**：指定输入金额报价＋原 `execution.buildFragment`，以及交易内实收接下一跳（当前 `ExecutionSemantics.buildRuntimeLeg`，供 sim 选额构造使用）。两者互不替代；后一条不得先调用链外 Exact 来填写下一跳金额。ABI、必要的交易内金额计算、原生币和 callback 语义仍由 Family 提供。全族审计从当前注册表列出全部已安装项（含关闭项），按 Swap/Protocol、Funding、Credit 分开，不能只检查启用清单。
- 指定 amountIn 不得被 oneAsset/oneShare 点价格采样量覆盖。返回该金额的 amountOut；本地公式须与同状态链上询价/执行作对照，不能用点价格线性乘法冒充金额报价。
- 验收金额至少包含**当前生产 effective 行实际使用的 amountIn**，或由原共用金额模块在本次配置下生成的参考金额；不能只用 9 wei、oneAsset/oneShare 或自选小金额代替。原 TX 金额可作另一组对照。P/G 选择与 fallback 读同一全局配置，不在 Family/验收脚本手写第二份，也不把历史的 0.005 固化为永久值。
- 中央保持通用，不加协议分支、ABI/数学或单池特判。确实缺通用能力时明确框架改动及回归范围，不伪装成 Family-local。
- 报价模式、共用状态复用、执行资格与容量检查遵循 [已有生产约定](references/acceptance-entrypoints.md#五已有生产约定不能在适配时另起一套)。仅支持本次明确的协议语义；不为假想变体设计额外框架，也不把单样本公式宣称适用于所有变体。

## 3. 最小测试集：先离线，后历史执行

按参考文件核对当前 package scripts，跑目标 Family 的相关测试，不一律跑全仓所有套件。

1. 当前生产 build（现为 `build:live`）；Family 合同测试覆盖发现/反向身份、错误证据拒绝、方向、fee/精度、amountIn/out、金额边界和执行编码。生产 build 与全仓 build/typecheck 分开报告。
2. 核对目标 Family 在当前 strict catalog 中；跑相关 strict lifecycle、central runtime、execution projection 合同测试。fixture PASS 只证明框架合同，不等于目标实例的历史链上 PASS。
3. 依改动补最小共用回归：pricing/exact → effective/Exact/Solver；执行金额传递 → 实际到账/final verification；Ready/hash → 选择性重验/图加载。
   存在外部价格/权限依赖时，增加生产入口的轻量状态变化回归：仅依赖地址变化、池子无交易，raw/effective 仍刷新；无关变化不扩大刷新。依赖可换地址时检查重新绑定或明确的安全拒绝及恢复路径。无需因此自动增加整轮 live 或全量重建。
4. 无关旧测试错误记录基线是否也失败和影响层，不无限扩修。真实共用模拟器、准入、执行或安全错误不能忽略；定位最小复现，明确所需额外修复，不擅自扩权。

兑换类双接口是必查项：每个已支持方向／变体用多个金额验证原报价接口及实收执行；通过生产 sim 选额器检查实收构造的链外逐跳 Exact 调用数为 0，同时显式报价模式仍可运行。用抛错桩拦截 Exact/quoted 构造入口，防止测试悄悄回退。下一跳使用本次到账，不能消耗原库存或用预设输出补差；按实际语义覆盖临时授权清理、原生币差额、callback 债务、金额边界、失败原子回滚与最终偿还／守恒约束。strict、报价和执行核对同一 source、executor、caller 及适用的 `transactionOrigin`，不能在默认入口漏传。返回 `null`、整路回退报价、缺样本分别记录，不能仅凭方法存在宣称接通。历史同状态执行证据与合成 ABI/合同测试分开；资金源和 Credit 按各自能力验收，不强塞兑换接口。相关入口与近期变体边界见参考文件。

协议若以返回错误码而非 revert 表示失败，或允许部分成交，须校验该返回语义、实际花费和实际到账并补负例；“RPC 正常返回／TX 成功”不等于该腿成功或全额成交。指定输入份额与指定底层输出金额不是同一接口，不能在实收路径中不经验证地互换。

集成验收必须调用**当前 live 使用的生产函数**，读取其真实 Ready/价格产物；薄 CLI 只传 Ready/价格文件、区块、配置与输出位置。单元测试可用 fixture/负例，但不能另写一个“测试用 effective/枚举/执行实现”，也不能把旧 fixture 的失败直接说成生产 Family 不支持。必要审查意见处理后运行相应验收，不以反复加审查代替执行。

## 4. 真实交易输出对照

每个支持语义/方向选择真实代表样本；一例成功不代表所有池、金额和方向通过。

分别记录原始整数：**原 TX 该腿实际 amountOut、Family quote amountOut、quoted 编码执行到账、runtime 实收执行到账**。后两条不能互相代替。记录相同的 tokenIn/out、amountIn、状态和收币者口径，不能把分润/偿还后的整笔净余额冒充单腿输出。

实际到账必须独立于报价或编码中预设的转出/包装数量测量。涉及 wrap/unwrap 时同时核对原生币与包装币的前后余额，排除初始余额补差或残留；用有针对性的错误金额负例验证测试能发现不一致。

先完成可直接验证的“同状态 quote↔实际到账”，再判断是否具备原 TX 前状态以对照原输出。这是两个独立结论：原 TX 精确复现缺证据，不抹掉已经完成的 strict/入图/同状态验收，也不允许声称原 TX 对照通过。不要为了齐全的对照表擅自开发通用块内回放系统。

- 声称“与原 TX 输出一致”需要还原该腿的调用前状态。N−1 是父块末，不一定是交易前状态；有相关块内前序交易或同笔前序调用时，要复用已验证的 prefix/trace 回放能力还原。
- 现有 `anchorHistoricalSenderNoncePrefix` 只重放同 sender 的 nonce 前缀，不是完整块内前缀。缺完整状态还原能力就注明未验证，不能假装支持。
- N 块末可以验证“同状态 quote 与执行一致”，不能据此声称与原 TX 落地输出一致。
- 默认精确原始单位比较。若确有 1 最小单位舍入差，报告 signed delta、原因与当前开关；不是百分比宽限或主动少传 1 单位。下一跳传实际到账，偿还/守恒/final sim 安全门不放宽。
- 现有覆盖分 fixture、同状态模拟、route-pinned Adapter Replay；没有通用“任意 tx 每腿输出逐 wei 一致”入口。需补覆盖时写 Family 自有测试，调用生产报价与编码，不手写另一套公式/执行/图验自己。
- 复用保存的真实执行证据时，核对 source/环境、请求返回、执行器字节码和相关源码指纹；当前代码离线重算通过只能称“旧证据认证＋当前代码重算”，不能写成新跑 EVM。限流失败的重跑仍保留为失败，不被旧成功覆盖。

## 5. 历史单块 Ready → 图 → mid/effective

1. **先确认真实样本 strict 通过，再检查入图与价格。** 可由同一次生产单块 rebuild 先完成 strict、再发布 Graph，不要求另造一条前置验收流程。已有来源和 Family 指纹匹配的 N 单块 Ready 就复用；指纹失效对副本走现有选择性重验，不改原证据。旧 Ready 不因代码改动一律弃用；也不能跳过失效 Family 的重验。
2. 没有 Ready 时，用现有生产 rebuild 入口限定 **from=N、to=N**。该块真实交易/log/trace 自然发现；禁止手塞目标池、admitted 标志或 Graph 边。无需扫描 14400 块。
3. 验证目标 memo/active instance 已准入、Family 指纹有效、生产 Graph 有对应方向。只有候选、legacy 注册或 `READY` 总状态不算目标成功；Ready 可能包含未入图的 retryable。
   单候选 probe 更新 memo 后，须经原生产发布入口重新生成/校验 Graph。比较的是当前准入集合与证据是否和发布内容同步，不是 retry 队列是否清空；不得手改 Ready hash、图边或清除状态来绕过检查。
4. 用生产价格薄 CLI 在明确的历史块末建 raw/effective。Family 集成通常用 N，发现块与报价块分别记录。检查目标行 mid、effective 状态、amountIn/out 及 source。合法金额应为 `quoted`；生产参考金额确实超过容量时，用同状态合约拒绝验证“正确不可报价”，另用合法金额验证输出。不得偷偷缩小生产 P，也不得把正确拒绝写成当前 P 已有可搜索价格。表的 `complete` 不代表每行报价成功。
5. 输出 tx/N、Family/实例、strict、Ready/Graph 边、mid、effective amountIn/out、报价状态、对照差值与失败原因，附真实产物路径。

Funding-only 验证 funding 准入/额度/执行，不强求 swap 图或 mid/effective；Credit 按 credit 槽验收，不凭此扩展策略授权。

另有机会复现要求时，使用统一的 `mev-blockscan-replay`：复用 N Ready 拓扑，blockscan 默认 N−1 状态/环境，使用当前 live 的价格→枚举→sim 选额→独立 final sim→EV；不能因旧脚本叫 Solver 又插回链外逐跳报价。backrun 准备真实触发输入及对应状态/N 环境，沿该 lane 当前真实检测/Planner/选额/最终 sim/EV 接线，不假设与 blockscan 相同。它是后续策略验证，不是 Family 集成前提。

## 6. 时效性也是适配验收项

新增或改变状态读取、刷新、金额报价、实收构造时，检查相应生产阶段的成本；仅查资料/更新 skill 时不启动测速。执行时读 [时效性验收](references/latency-acceptance.md)。

- 可用单块 Ready 做局部检查；不要求先重扫 14400 块。正式前后比较默认 **3 个代表块、每块各 3 次取中位数**，证据不足明确标注。
- 只驱动 live 的生产调度与阶段边界，不另组测试调度。effective 从接收新区块到发布价格表计时，sim 从生产选额边界计时；各自保留 drain，前置准备单列。
- 真正刷新、未变化复用和失败撤价分开；无任务/无 RPC 不是“报价很快”。核对输出与安全门，不靠少启用池子、放宽校验或只增并发制造提速。
- 区分请求声明、去重后 call 项、HTTP 批次、依赖轮次、排队、响应及本地处理。减少请求可单独成立，不直接推导整轮 live 更快。失败/超时不换成成功重跑；整轮 live 仍需另行授权。

## 7. 交付与失败处理

向用户分项报告：实际跑的测试、strict、单块自然入图、mid/effective、双接口及 TX/quote/到账对照、相关阶段时效性。未跑、无样本、限流、权限失败不得写成通过。

多 Family 任务逐族列出样本 TX/N、strict、入图、mid、effective、到账对照及缺项原因；不把“实现了多少”“live 出现多少”“历史已验多少”混成一个覆盖率。同一状态无需重报/重建的证据只引用原产物。

429/超时用共用调度既有退避/批量限速，不当协议永久拒绝，不无限重跑启动。动态权限按状态时效处理，不冒充永久身份错误。

当前仓库正式检查/审查/提交规则照常适用；skill 不自动授权广播、部署、live 或无关框架修复。

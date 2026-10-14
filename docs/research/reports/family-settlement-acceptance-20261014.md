# 全安装 Family 结算能力核对

本轮直接使用 `mev-impl-c4d-20261002 / us-east1-b` 的 `/opt/mev-cloud/family-runtime-20261007`，基线 HEAD 为 `854d35ef60e790e59a4493afcd52c8fa95be71a3`，沿用原分支，包含本任务修改及保留的 Ready／Uniswap V1 他人增量。未新建主工作区、部署、签名、广播或启动 live。本文是验收证据说明；协议进度仍以原 Obsidian IMPL 主表为准。

已遍历 46 个已安装 Family（包含默认关闭、Funding、Credit），逐动作／方向／变体整理 110 个审查项。实际部署的已验证 ABI／实现、代理实现及能取得的历史代码绑定分别记账：接口 92 项 verified、12 项 partial、6 项 unverified；身份绑定 43 项 verified、58 项 partial、9 项 unverified。部分核实或未核实不代表协议不支持，也不代表适配通过。完整逐项材料见 [结算能力验收记录](family-settlement-interface-review-20261014.json) 及其固定哈希的四份独立审查报告。

新增必查门 `npm run searcher:family-settlement-review -- --family <family-id>` 校验安装集合、独立报告中的变体集合、实际源码闭包、证据内容哈希、接线及行为证据。全量实跑覆盖 46 个 Family，4 项在本门通过（Balancer V1、Balancer V2、Ella、Curve LP），42 项保留缺项，退出码 1。结构、源码与证据引用检查无错误。通过本门只表示相应结算能力项通过，不能代替 strict、双执行、自然集成、机会复现、正式 Adapter Replay 或时效性。静态 quote 无付款和收款动作时不强塞交易执行断言；其实际 quote 成果另列。

共用 issuer／执行器按 Family 声明消费 quote-output、direct-output、deferred-input。ABI、金额和 callback 付款语义仍在 Family。回调结算仅指先交付可用输出、再由调用者回调结算输入；输入先付的 callback、内部 hook／unlock、独立 flash loan 均单列。已有 receiver 但当前未接线的真实缺口包括 InfiniFi、GOLDx、PSV、RockSolid、Silo、部分原生币路径、Angstrom、Mooniswap、Fluid DEX、Curve 部分变体和 UniV1；Yearn 非空 data 的四参入口存在 output-first callback，当前三参路径不能代替该项。V2 pool-owned quote 变体的外部收款声明已移除：该变体 callback 目标同时跟随输出收款方，未证实可把付款继续交给原执行器，故新请求明确拒绝，原默认路径保留。

Balancer V2 在 N26138724（TX `0x9db5b6b8efe9dacc0931ee1b48c861b0284e8088f7c27c93455e95c374b50a4b`）和 N26138511（TX `0x80334cda165c424da8ffc9bbb4ccd302b77b79a3bc1f4e25bbbcd643c1712e3d`）复用真实单块 Ready，自然参考金额及两倍金额，共 3 个池来源实例、10 个方向、20 组金额，完成 20 quoted＋20 runtime＋20 direct-recipient 成功及 130 次 EVM 拒绝。指定 recipient 的询价与实际到账、原付款方扣款、旧库存、实际授权清零和回滚拒绝均复核；普通 swap 不声明 deferred input。参见 [行为证据](balancer-v2-settlement-behavior-20261014.json) 和 [独立重算](balancer-v2-recipient-independent-review-20261014.json)。拒绝只观察到主 EVM revert 及运输层空 effects，不声称另读了回滚后的账户状态；原生币余额仅核对 executor。相关 16 个 Family 文件及 57 个共用文件与原验收来源核对一致，原 source hash 未改，无重复历史执行。

Aqua／SwapVM 两个策略、四个方向已有当前历史双执行；history20 另完成 4 次实际 static quote、4 次外部 recipient 实际收款。N25680170 的 1INCH/WETH 两方向自然 effective 有效；N25680171 的 1INCH/WBTC 两方向自然估值仍缺，手工 reserve/100 及两倍金额的同状态成果有效，但不冒充自然估值。4 次 direct 成功保留；新增 direct 拒绝矩阵与真实历史 deferred-input 仍未验全，不能拿默认路径 28 次拒绝代替。参见 [独立复核](aqua-settlement-independent-review-20261014.json)。当前相关源码与原历史运行一致。

当前实际工作树 build:live 与 301 项 Family 测试通过，V2 合同通过，新增检查规则 6 项回归通过。此前已经完成并保留的相关验证包括共用执行／issuer／选额回归、46 项 Solidity 测试（含 256 次 fuzz）、Aqua、Kyber、PSM、YB、Frax、Set、Curve underlying、Yearn、Balancer V2 的相关局部合同；各项仍保持原证据范围，不由单元测试推出真实新模式执行。独立审查见 [检查规则复核](family-settlement-gate-independent-review-20261014.json)。

保留的失败／中断：settlement24 的类型构建失败在 25 修复；25 的未索引工具名称导致后续未运行，26 使用实际索引入口补验；26 检查规则的列表顺序回归失败修复后通过；27 源码导出遇到 production entry basename 路径问题，28 修复并完成实际全安装导出；29 全量门退出 1 是上述 42 项未完成的真实状态。旧 central conformance 的具体族导入／分支失败继续保留；installed-versus-active 误判只作局部工具修复，不宣称整个 framework 通过。

本轮没有重型阶段性能实验。4A／4B 未完成；Balancer V2 原 28,040 边／94 实例、727 方向、4 秒预算与重块中位 4,276.945 ms 失败及 429／未运行样本保留。全部目标协议仍须按既定顺序在正确性之后验收时效性，原机会与 Curve underlying 双调 A 等缺口也继续保留。总目标未完成。

提交核对：代码提交 `4dd7fc8239bd981c5a12eee0c4b2f374b3a04b5f` 从实际待提交树生成 catalog，并通过 build:live、Family 双执行合同及结算检查规则回归（套件用例数分别为 298, 6）。提交树排除他人的 Ready／UniV1 改动，原工作文件与原 generated 仍保留。`tooldef-20261014-installed-family-conformance` 已以该提交 codify，仅关闭安装集合误判，不关闭原 central boundary 失败。

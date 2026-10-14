# Curve underlying FRAX 5f 双调 A：局部正确性与收款方验收

在 N=14274089 的 FRAX 元池与 3pool 底池同时向上调 A 状态，原 Family 对 500000000000 USDC 报价 499692126927421651121141 FRAX，实际到账 499699329276493554552688，相差 7202349071903431547 raw。本次修复将精确绑定的 5f 实现接入既有实际 base-LP 铸造金额模型，并保留两个既有经典实现的支持。原失败证据没有改写。

源码提交：`dc9013a8ceb8d325bd5422592cc24ff6eb3068e0`，在 `/opt/mev-cloud/family-runtime-20261007` 当前实际基线上验证。测试包含原有 peer dirty 修改；这不是单独干净 checkout 的构建结论。源文件指纹 `ea4e35f52e18b03efe600e2022d8da8039167c2269220cede7ddc9896d7da0f2`，1209 个生产 TS/Sol 文件。全部明细、输入来源、文件哈希及限制见同名 JSON。

- 池：`0xd632f22692fac7611d2aa1c0d552930d43caed3b`；实现：`0x5f890841f657d90e081babdb532a05996af79fe6`。
- 来源块：`14274089 / 0x30ccd5160f0898c018bd53954f0cf36e7910461491848b10530d9b4d6ed3163b`，timestamp `1645776136`。
- 线索 TX：`0x7d996f99247b03b809e5eea4989de17f674946b75b1bfddae601311bf0e85a70`。原交易的 499699802768386519441096 FRAX 输出属于块内前状态，不能与块末适配执行量混为一谈。

Family 自己声明并校验 `_update` 的时间读取和代码依赖，使用共用 request/refresh 生命周期。时间倒退、代码/来源不符、正 elapsed 下余额乘积或累计和溢出均拒绝；真实受测块 elapsed=0，不执行该算术分支。正 elapsed 及撤价/恢复由离线回归覆盖，没有把合成状态写成历史成功。中央没有加入该协议专属分支，报价与请求输入不减量，也没有新增舍入容差。

12 个方向、26 组唯一输入均完成 quote＋quoted 执行和实际输入 runtime 执行：52 次主执行、26 次 minimum=1 辅助执行，报价与实际到账逐单位一致。额外 26 次独立收款方 runtime 执行复用已验默认结果，全部与 fresh Exact 及默认输出一致。共 104 次同 calldata 零输入控制均在根调用回滚；实际扣款等于请求输入，付款者及收款者的旧输入、旧输出和原生币库存受到保护。runtime 构造没有 RPC/Exact/quoted 回退。授权按既有 standing-grant 语义观察：DAI/USDT 无限授权保持 MAX，FRAX/USDC 为 MAX−input，没有误称全部临时授权清零。

受测五参 `exchange_underlying` 支持外部输出收款方，真实调用带上指定 recipient，先支付 caller 的输入再交付输出；没有 deferred-input callback 声明。新工具模式通过实际 issuer 构造 direct-output，独立证明 recipient 的 balance getter 槽并核对真实 stateDiff；它只补充收款路径，没有重跑或覆盖已完成的默认 quoted/runtime 样本。测试文件提交前各删除一个末尾空行，EOF-only 旧/新哈希对应单独保存，历史报告内的原执行哈希不变。

金额分别取原交易数量及其两倍，或已保存生产价格行的 DAI/USDC/USDT 输入及十倍。生产行来源 N=22871578、hash=`0x5345cfd3ad3194fd740c849eb9c025ebeaf53284779af187c263994417d17b2b`，generation=1，fresh，配置逐项核同；只借输入量。原表没有补写价格、输出或准入。受测 N 的 Ready 沿用已有历史发现并选择性重验，12 个 Graph/raw 方向保留，12 个 effective 仍为 missing-valuation；本轮没有新的自然发现或自然估值通过结论。

当前生产 build:live 通过；Family plugin 39、经典模型/刷新 79、共用双执行 301、补充更新/生命周期 18、历史工具安全 18 项通过，strict-family-lifecycle 和 exact-quote-cache 检查通过。独立审查逐条复算默认及收款方原始 trace/stateDiff；其 ran_gate=false 表示复核保存证据，没有再次运行 gate 或 EVM。

同时闭合验收工具缺陷 `tooldef-20261014-curve-underlying-clock-read-scope`：旧历史双执行工具复制了不完整的 Family 读地址集，漏掉新代码绑定的 clock，合法读取在 RPC 前被拒绝。工具改为复用 Family 的 refresh 地址集，保持固定来源、无关地址拒绝和调用预算。新增测试在旧工具上失败，修复后 13 项通过，后续收款方安全扩展为 18 项；LearningCase 的 codify_commit 指向上述源码提交。

本记录仅为实际适配修复、同状态局部执行与接口接线证据。当前 BotVM 在显式 Cancun/current-executor 环境运行；没有冒称原历史 EVM/opcode44 等价或原 TX 完整复现。正式 Adapter Replay、family_local/merge_ready、其他 Curve 精度/利率及 generic/native 变体、机会复现、4A/4B 性能仍未完成。单块正确性成功不代表适配整体交付完成。

生成 catalog 通过仓库的 canonical serializer 仅暂存 Curve 的 9 条新记录，另一个 Family 的 9 条工作区记录原样保留；没有回写旧 hash 过门。28 个他人 dirty 文件逐一核对未改。未签名、广播、部署或启动 live。

tool-reconciled: listener:searcher:curve-plain-historical-ready agrees 当前生产复用/重验的 12 个 Graph/raw 方向与 missing-valuation 限制一致。

tool-reconciled: listener:searcher:curve-runtime-dual-historical-fork agrees 同源手工输入和收款方补充验收已执行；工具清单、descriptor、参数及输出哈希见同名 JSON。

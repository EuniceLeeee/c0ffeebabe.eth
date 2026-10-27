# ERC4626 三种语义迁移到 Family 公共管线（2026-10-27）

本次完成标准 ERC4626、Frax Custodian、InfiniFi 的声明化实现。生产入口读取主 JSON 与两个子 JSON，统一生成 discovery、identity、instance、routes、pricing、Exact、quoted/runtime execution、recipient/settlement、protocol 和 action 能力。普通 ABI 编码、授权、结果解码与约束检查由 Family 公共 TypeScript 执行。

## 源码与范围

- 实际工作区：`/opt/mev-cloud/family-runtime-20261007`。
- 起点：`9ea9ee7fcb8f28b73bda5c2faf73efbcf7f303c3`；工作区开始已有 298 处 dirty，验证明确包含实际 dirty 基线。
- 标准定义：`listener/src/searcher/venues/protocols/erc4626-family/erc4626.json`。
- 子定义：同目录 `custodian.json`、`infinifi.json`；分别保留身份、权限、依赖和兑换语义。JSON 不绑定专用 TypeScript handler。
- 19 个旧实现文件改为 JSON 常量导出或公共编译器兼容转接，`types.ts` 保留类型。生成的生产入口不导入这些兼容文件。
- StakedUSDat 保留独立身份、刷新策略与生产入口，使用单独兼容桥；不成为 ERC4626 子变体。
- 只迁移这三种已存在的语义。其它 Family 仍可用 v1 生产定义及原 Swap/Protocol/Credit 模板，没有自动扩大覆盖。

## 行为和安全边界

- 指定输入报价和交易内实收执行由同一份动作定义生成。runtime 构造不读取链外 Exact/quoted 结果；下一跳使用本次到账。
- 原请求金额不做预扣；实际输入扣款、输出新增余额、旧库存、返回值、容量/权限、授权清理与失败回滚继续检查。
- 指定收款方按真实接口声明。未支持的回调结算请求明确拒绝；没有将内部 hook 或普通 receiver 参数冒充 deferred-input。
- 标准 ERC4626 保留 on-touch 刷新；变体保留自身权限/价格依赖及刷新规则。身份依赖与触碰刷新地址分开。
- 本次未修改中央偿还、利润、原生币、守恒或 0/1 舍入安全门。

## 已执行验证

| 验证 | 结果与范围 |
|---|---|
| 云端当前源码 `build:live` | 通过 |
| 目标合同与共同声明化测试 | 226/226 通过，包含原三种语义、Staked 刷新、JSON 校验、双执行及安全负例 |
| 当前 capability 正常生成与 check | 通过；不覆盖旧 hash 绕过检查 |
| 共用 strict runtime、Exact cache、settlement、maximum-input、native-boundary、catalog、content-hash | 7 个入口通过 |
| Custodian 真实本地 EVM | 4/4 通过；调用公共程序兼容入口，使用合成协议状态，证明 BotVM 执行和回滚，不单独证明真实部署的生产入口 |
| InfiniFi 真实本地 EVM | 4/4 通过；从生产插件生成执行，使用合成协议状态，覆盖默认/指定收款与安全负例 |
| 仅 HEAD＋本次文件的独立提交副本 | 正常生成、`build:live`、226/226 目标测试、manifest check、strict-production-runtime-session 通过 |

原先 family-dual 的 ERC4626 fixture 不返回新增余额观察所需的 ABI word，出现 `word bounds`。本次只补对应 host fixture，增加少扣 1、少收 1 和缺失返回数据负例，没有放宽生产解释器。

### 全族旧失败独立保留

云端实际 dirty 基线的 `family-dual-execution`：314 项，309 通过、5 失败。与迁移前源码的隔离对照为 313 项、308 通过、同样 5 失败：3 项是九个既有 Family 缺 fixture 登记，2 项是 UniV3 不支持 quote-output 请求的旧测试/实现冲突。另一个 `strict-production-runtime-session` Fluid publication=null 也在原基线复现。没有将这些失败抹掉或归因于 ERC4626。

仅 HEAD＋本次文件的独立副本中，全族 dual 测试在 UniV1 fixture 缺少 `standardAnswer` 导出时停止；恢复 HEAD 原测试文件仍同样失败。该副本的 strict session 则通过。两个基线与各自失败分别记录，不能混成“全仓全绿”。

## 当前历史验收

当前冻结源码的 Rust 模拟器已独立构建，二进制 SHA256 `774712da3eb2683b4ddef56daf4d074b242d55d23301ed01aacf24b17dfdcc60`。8 个历史生产入口完成；复用旧 Ready 发现资料，选择性重验并通过当前准入，不手改 Ready，也不重扫历史区间。

| 历史状态／代表交易 | 范围 | 成功执行／预期拒绝 |
|---|---|---:|
| N25887370／`0x7c8b742e0176be3ab8247f1f8d46674d9c38af7bd6ff0ccb1a804852819f3d16` | 标准 ERC4626，存入／赎回，quoted/runtime 与自身／外部收款 | 32／84 |
| N26017168／`0x02bf41c595d08e397b90edaaee8a00f4521d1d7c2b0f538b1d1597e4e1ccacec` | Custodian，direct 及默认 quoted/runtime | 32／86 |
| N25944594／`0x3ba33cd287b063eebfdcc42802e143b9107e1923df56d16a2c94cbd5f81dc4a5` | InfiniFi，默认 quoted/runtime 及 direct 补验 | 16／32 |

独立复核共 32 组测试样本、80 次实际执行成功、202 次预期拒绝；不是 32 个实例。正例逐一核对同 source、完整输入扣款、实际到账等于当前报价、观测账户的原生币守恒和旧输出库存保护；runtime 构造的 RPC/Exact 调用为 0，无 quoted fallback。负例计数不混入成功执行。

输入和覆盖边界：标准使用原事件数量与两倍金额，不称当前自然估值通过；Custodian 只借旧生产行的 amountIn，原行 table N26146969／quote N26146968、carried 身份保留，报价和执行均在目标 N26017168；InfiniFi 使用一代币控制量及原 TX 数量，小图自然估值仍为 `missing-valuation`。InfiniFi 本次 `pendingRewards=0`，不推导有待分配收益状态通过。标准和 Custodian 本次不重跑自然价格表；三个代表样本不替代所有既有标准 vault 实例的完整迁移认证。

InfiniFi default 文件承担 quoted/runtime 执行证明，direct 文件只补直接收款。实际 EVM revert 不等于独立 post-rollback storageDiff；本地合成 EVM 的完整回滚证明另记。标准本轮没有启动可选 Anvil，`forkDrained=false` 表示未使用，不是遗留活跃 fork。原有 Anvil PID35510 保留。

此前缺少默认 `revm-sim-ready` 的失败及空 Ready 样本均保留。修正使用当前源码独立构建的同一二进制，显式配置 Ready backend，没有修改协议准入、批量调度或拿旧 hash 过门。五份结果的 source、文件 SHA、逐金额 delta 和限制见 `erc4626-thin-migration-independent-20261027.json`。

## 成本、交付与限制

本轮验证的是声明化迁移和局部正确性，不是机会复现或时效性交付。标准执行新增四次余额观察用于实扣/实收断言；不能据代码统一或离线检查推导更快。代表性生产背景负载、局部 3×3 时效性、正式 settlement pins/review 与完整合入 gate 未在本轮宣称通过。没有启动 live、部署、签名或广播。

云端原始日志/失败尝试保存在 `logs/erc4626-thin-migration-20261027/`。独立提交副本在本机 `logs/erc4626-production-json-20261027/thin-commit-review/`；其 catalog 由正常生成器生成并随限定提交收录。云端包含他人改动的完整工作区 catalog 保持原状，不拿另一套指纹覆盖它。

工具清单使用当前 `tool-index`，查询 `erc4626,custodian,infinifi,evm,strict,execution,protocol,family,capability,runtime`；相关验收经 `tool-run` 执行，保留入口、参数指纹、输出与退出码。来源指纹及证据摘要见同名结构化验收记录。

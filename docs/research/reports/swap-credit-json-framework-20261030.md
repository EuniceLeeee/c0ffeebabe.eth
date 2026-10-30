# Swap／Credit 公共 JSON 框架验证记录

本报告只描述公共框架与 Balancer V1 单实例参考迁移。其他 Swap、Fluid Credit 的协议 JSON 未迁移；不声明原 TX 机会已复现、全部变体适配完成或性能通过。

## 实际基线

- 权威目录：`/opt/mev-cloud/family-runtime-20261007`。
- 原 HEAD：`55faa563872a3b5b838a7c51cc15c061a725a966`，分支 `codex/family-runtime-actual-20261007`。
- 本轮修改在包含既有未提交工作的实际源码上验证，提交只含本轮相关文件。实际 dirty 版本的 generated catalog 与干净提交版分别生成，不把旧 hash 改写成新验收。
- 范围来自 app-run2 实际运行配置：15 个 Swap＋`credit:fluid`，详见 [交接](../design/swap-credit-json-framework-20261030.md)。
- 全部原始运行资料：云端 `logs/swap-json-enabled-20261030/`；未启动 live、未部署、未签名广播，原 Anvil 与旧 Ready 保留。

## 公共测试与保留的失败

- 当前实际源码本地生产构建、generated catalog 校验通过。
- 本地 `test:family-json`：516 通过，0 失败，1 明确跳过。跳过的旧专用 fixture 仍由原专用回归验证，不重复记作通用格式验收。
- 独立 Credit 复核修正了必须持有风险证明及 capture 格式两处接线，27/27 通过；现有 transport 159/159 通过，含禁止非零 call.value。Credit 未增加 runtime。
- 回调公共编译器独立复核修正返回后抽走输出、外部名称覆盖内部寄存器两个问题。仍要求父层可确定的 expectedOutput 见证，尚不支持只有回调内才知道输出的 deferred 模式。
- 全注册表双接口审计为 309/314，与任务前基线相同的 5 个既有失败（三项 fixture 覆盖、两项 UniV3 预期），没有把这项写成全绿。
- 云端首次公共套件 506/507：测试误拦自身 `/opt/mev-cloud/` 源码加载。修正只开放精确加载边界，并保留外部读写/网络负例；原失败日志仍保留。
- 首次单块 Ready：真实候选 identity 通过，但 pricing-static 空依赖误声明 dependency-proof，导致无 publication。修正为空依赖 source-local；公共字段套件现已实际经过生产 lifecycle 验证实例、方向及价格状态发布。原 `ready.json` 和 `single-ready.log` 保留。
- 第一次双执行试验借用了 app-run2 旧模拟器二进制；该版本拒绝 executor-program 自调用的代码 overlay，四个金额均在校验层失败，没有 EVM 到账结果。本工作区源码已有该能力，改用当前源码构建；失败产物 `acceptance-v4.json` 保留，不记为协议 revert 或执行通过。
- 最初 tool-index 因 analysis 未配置 tsx 返回 127；后续使用仓库现有 listener 工具路径，未安装新依赖。原失败保留。

## Balancer V1 历史状态

TX：`0x6be8b298d56ac7993ee3a2e9faa389b73694d70d0d385b490b74f6bba78094a8`。

状态 N：`26138731`，hash `0x696b86358440cc2b7a0a5e80dc87c2542a2e1535cd21502b99b317fef1d4d266`。

实例：`0x5a0d85166a20f9cd27be2cb293e4d10188f0c97d`，NMR／WETH 两个方向；原有接口仅默认调用者收币，无回调结算或指定收币者能力，本次不新增这两项能力。

输入为既有生产价格参考量、半量和原 TX 金额。原 TX 位于块内，原输出与 N 块末不同；本轮比较同 N 状态 quote 与 quoted/runtime 实际到账，不宣称原 TX 调用前逐 wei 复现。

真实结果：生产单块 Ready 1 个候选 verified、1 实例、2 Graph 边、0 retryable；raw/effective 各 2 行，均绑定同一 N/hash。价格来源 refreshed=2、carried=0、failed=0；`perBlockRefreshStateKeys=[]`。公共默认参考输入为 `2000000000000000` wei WETH，未传固定输入覆盖。当前价格表两个方向的输入及输出与执行用例完全一致，已不只依赖旧价格借入金额。

| 方向 | amountIn（原始单位） | Exact amountOut | quoted 实收 | runtime 实收 |
|---|---:|---:|---:|---:|
| NMR → WETH | `311013283877631901` | `1993692884200948` | `1993692884200948` | `1993692884200948` |
| NMR → WETH | `155506641938815950` | `996885360276100` | `996885360276100` | `996885360276100` |
| WETH → NMR | `2000000000000000` | `311013283877631901` | `311013283877631901` | `311013283877631901` |
| WETH → NMR | `8444695829171278` | `1312875449799276467` | `1312875449799276467` | `1312875449799276467` |

8 次正例、16 次无输入／强制回滚反例通过，实际扣款、实际到账、预置旧库存及 native 余额均由公共断言核对；容差 0。runtime 构造 4 次，构造期间 Exact／quoted／RPC 禁止调用数为 0。独立 Exact 与 quoted 各 4 次。执行成功后 drain 完成；历史直接读取 18 次无错误，REVM 内部读取数量未统计。

raw mid：NMR→WETH `0.006410814799041918`，WETH→NMR `155.518803966853`；effective mid 对应为 `0.006410314245565685`、`155.50664193881593`。同状态整数输出以表格为准。

云端最终公共套件同为 516 通过、0 失败、1 明确跳过，生产 build 与目录检查通过。纯离线与单实例验证的耗时不用于代表性性能结论。

### 证据与冻结指纹

本次云端目录 `logs/swap-json-enabled-20261030/`：

- `ready-v4.json`：SHA-256 `e2ee4f3902cec708d6609b903e60da4ddab1986d64c6750bb4832e1940b7c729`。
- `acceptance-v5.json`：SHA-256 `d8614f67a9ebaa93904c74267b8d3fc4cbfadcce4a995f74fab239dc787adbe7`。
- `prices-v5/prices.json`：SHA-256 `7ec23ad7c983516a4f238afe9520362e02570d5197d06a29da148bc1dc386f22`。
- `prices-v5/input.json`：SHA-256 `10cf86efdde6f6349bb1102a33fce1bf662899ba827b56a676d92a37d0eadd70`。
- `revm-build-done.json`：SHA-256 `bf30a16461118a8624281f637c65e37f0861da09b6cfd0d41e1e73b4eef505ad`。

实际源码树指纹（acceptance 的生产源码算法）：`e8c3f14f28e0128898424fa53d874d1bc01ac7195c3953bebcaeabffc9732193`。执行后二进制 SHA-256：`774712da3eb2683b4ddef56daf4d074b242d55d23301ed01aacf24b17dfdcc60`。交付前工作区 dirty status 指纹：`05abfc7a95ac9cf896582b8c0c25aa9610f720536e29d9def17416331b7edc4d`；完整原始文件散列保留在 before-install/installed 记录。

规范工具复核：capability query=`family,capability,manifest,check`；选中 `listener:family-capability-manifest:check`，通过 `analysis tool-run` 实际执行 exit=0。manifest=`logs/swap-json-enabled-20261030/tool-selection.json`，SHA-256 `c6ad2b3745fa18a2513a34a94226c14ba100195b4e1aaac74bc817367a6810b4`。结果与手工定位的依赖排序修复一致；原 hash 算法未改。工具缺陷已附独立复核、回归与 codify commit，见 `analysis/learning-cases/*20261030.json`。

源码提交：`570dde129584f0e52bcf9034f15b2e6997d807a2`。接收窗口应从当前分支拉取提交，保留自己的未提交修改，按交接中的公共命令迁移。

## 交付边界

- 保存 15 族 27 条 Swap TX 引用及一个双方向四金额完整 case；其余由迁移窗口补字段，事实验收缺项仍显示缺项。
- 公共字段测试自动读取 JSON；真实 runner 复用 production Ready、strict catalog、公共 Exact 与执行器，不允许手塞 Graph/输出或 runtime 回退 quoted。
- Credit 仅提供框架、测试和 TX 引用，Fluid 历史协议迁移/风险证明实测由后续窗口完成。
- 单块 correctness 不替代局部时效性、代表性背景负载或长期 live；本轮没有运行这些性能实验。
- 正式全系统 settlement registry source pins、全族 fixture 覆盖及仓库 replay／merge gate 不由这一个参考样本自动完成；没有声称 `adapter_merge_ready` 或 `production_gap_fixed`。

原 IMPL 主表已仅更新 Balancer V1／Fluid Credit 两行（33、42），其他行逐字保留；更新后 SHA-256 `d4daaad602857cde986322ba97724afe9312be5236bbd31cc9990e1149bb1659`。完整主表仍保存在用户指定的 Obsidian 原路径，没有建立第二张主表。

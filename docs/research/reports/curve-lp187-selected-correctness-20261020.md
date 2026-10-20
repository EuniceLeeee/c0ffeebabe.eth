# Curve LP187 扩展：选定实例正确性

现有 Curve LP Family 扩展已实现，选定 **8 个实例、42 个方向**的同状态指定金额报价、quoted 执行与交易内实收 runtime 执行完成独立核对。**187 条候选没有全部验收完成**，自然估值、原机会复现和时效性仍分别保留未验证状态。本轮没有恢复 live。

源码提交：`78f4bbbc6f6bc77992fab639eef56502fd4bc7f5`。工作区仍是 `/opt/mev-cloud/family-runtime-20261007`。机器可读证据见 [curve-lp187-selected-correctness-20261020.json](curve-lp187-selected-correctness-20261020.json)。

## 样本与状态

报价和执行均固定在 **N=26202387**、hash `0xa1039f363d8d34e4941dd912bb1caeb8d602f951e1dc4ba0ebee7a592406b134`。下表原交易只提供候选来源及明确标记的输入金额，不能将其原块输出用作 N 的期望值。

| 样本 | 实例 | 已验方向 | 原交易块 | 原交易 |
| --- | --- | ---: | ---: | --- |
| ng2 | `0x08bfa22bb3e024cdfeb3eca53c0cb93bf59c4147` | 4 | 26202356 | [0x525415040e…](https://etherscan.io/tx/0x525415040ec79f8d5b5d8b6da98ec33fda621a5b741299582019f9a0e0508f8d) |
| ng3 | `0x66039342c66760874047c36943b1e2d8300363bb` | 6 | 26201295 | [0x9cbd83fea2…](https://etherscan.io/tx/0x9cbd83fea2b46bc9420a42d65d93bea6c37f119c510169783b15fc4dd203a7c1) |
| ng4 | `0x06936efcaaab49af1c8b9ce3ac8bd85aabef3a3e` | 8 | 26197276 | [0x97eb88a5f8…](https://etherscan.io/tx/0x97eb88a5f8c3746aa83b9b99e1528e429db0eead16e8d237478188df88feb56c) |
| underlying zap aa82 | `0xaa82ca713d94bba7a89ceab55314f9effeddc78c` | 6 | 26191200 | [0x6cb7c6c0c6…](https://etherscan.io/tx/0x6cb7c6c0c6d869076daf2d08a6e804fa606b7b38d7cfceffb424d246fb7591bf) |
| underlying zap d5bc | `0xd5bcf53e2c81e1991570f33fa881c49eea570c8d` | 6 | 26190204 | [0x054947a1c0…](https://etherscan.io/tx/0x054947a1c0215608291e51691b7c8964dbd1a2b4a9deab259348a1ade6943c48) |
| TwoCrypto 6dc | `0x6dc8de7343d2e3b4e5ef9a196e946ae4d460e2d0` | 4 | 26200939 | [0x93df8666c6…](https://etherscan.io/tx/0x93df8666c69d17a7a8815991e766e3e5fd752f2faafdbf46d4da922363180324) |
| NG v6 | `0xe080027bd47353b5d1639772b4a75e9ed3658a0d` | 4 | 26200988 | [0xf5ad607267…](https://etherscan.io/tx/0xf5ad607267f50019a547dddbe83845f69f9f7c93402c4f00e214f22bc9ca52ec) |
| NG meta v7 | `0x579a9a9d43f9c112dee359e09a87a44f2718a483` | 4 | 26192964 | [0x6780ef7ffa…](https://etherscan.io/tx/0x6780ef7ffacebcafb248114f49bf95fb65e227419bf97e268d72cd7c5f72333d) |

三 NG 样本分别覆盖全部 2／3／4 币的单币 mint、redeem。两 zap 各覆盖 indices 0、1、2 的 mint、redeem；两者 index3 的 mint／redeem 在 N 因共享 sBTC 暂停转账而不可用，实际拒绝证据见下。TwoCrypto 覆盖两币 mint／redeem 的四个方向。

使用保存的真实候选进入当前生产 strict、memo、封存 Ready 和 Graph；受测 N 只扫描一块，不能称这些候选全部在 N 自然发现。旧 Ready 的 344 候选、1 准入、343 待重试仍是旧轮统计，原产物未覆盖。

## 实际执行与独立核对

| 证据组 | 方向 | 正执行 | 故障拒绝 | 零输入拒绝 | 独立 REVM 指定报价 | 原始结果数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 复用三 NG | 18 | 288 | 576 | 54 | 0 | 918 |
| 两 zap | 12 | 96 | 192 | 12 | 24 | 324 |
| TwoCrypto 6dc | 4 | 64 | 128 | 12 | 12 | 216 |
| 新增 NG v6／meta v7 | 8 | 128 | 256 | 24 | 0 | 408 |
| 合计 | 42 | 576 | 1152 | 102 | 36 | 1866 |

正执行逐笔核对请求全额输入、实际扣款到账、Transfer、LP 供给、旧库存和原生币变化。quote 与实际到账按整数相等，输入没有人为减 1。runtime 构造链外 Exact=0、quoted=0、RPC=0，无 quoted fallback。此结论针对 Family 构造和本批执行，不等于完整生产选额、final sim／EV 已验。

拒绝证据为可信主调用阶段 EVM revert、空 effects／logs；没有逐槽回滚后余额或 storage diff，不能冒称独立实测回滚。min+1／错误 receiver 部分故障含执行后保护，不能全部归因于 Curve 原始 calldata 的滑点检查。

两 zap 为 caller-only，没有声明任意 receiver 或延迟回调能力。实际核对 6 token × 5 account 的 30 余额矩阵、meta/base 双 LP 供给与完整 Transfer 路径。index0 直达 meta 币，baseLP 供给变化为 0；indices1／2 实际经过 baseLP 的铸造或销毁。未用池或 zap 余额覆盖制造成功。

aa82 redeem1 原 LP 量 `48461173050892769` 在 N 经 baseLP `57015567821779799` 到账 renBTC `2723860`，2 倍输入到账 `5440366`。d5bc redeem2 原 LP 量 `88314324534916895` 经 baseLP `101041661187215260` 到账 WBTC `796461`，2 倍输入到账 `1578809`。余十个方向为预先声明的手工金额及 2 倍；不伪称自然选额。

TwoCrypto 的原交易是双币存入后质押，本批单币操作不是原动作复现。四方向各两金额，覆盖默认 quoted／runtime 与 direct 自收／外收。redeem 实际触发两币非零 ClaimAdminFee：`1613985054579550`、`437328903568387266111`，收款人从当前池／factory 接口取得。实际核对池、用户和费用收款人矩阵、完整 LP 扣款与销毁。

例如 LP 输入 `13880769867190792097` 的 redeem0 实收到 `54087271111692010`，比提取费用前 view 少 `3189639253695`；redeem1 实收到 `14419473961408365308598`，比旧 view 少 `850346471907418310`。新执行报价等于实际到账；费用与用户输出分别记账。

## 本次增量与状态拒绝

新增两实例在实际 HEAD `2efc5871f87d59de2530d049ba454ec95fdabf39` 加保留的 dirty 内容上执行，生产源码未改；完整 1,266 文件清单独立重算仍为 `d03c638e428d41b328d7036e5afd0c9278ef838250c714d7d7ccea0c62908966`。原 NG918 与后续同指纹的948条分组保留，旧记录不换哈希。

两者各 mint／redeem0、1，预先固定手工 `10^15` 与 `2×10^15` 原始单位，所有输入资产均18位精度。NG v6 使用动态数组，NG元池使用固定 `[2]` 数组；默认 quoted／runtime、direct 自收／外收、旧输出库存0／103均有实际结果。逐笔核对请求全额输入、实际扣款、到账、6余额矩阵、LP供给、Transfer和原生币库存。新增128正执行、256故障拒绝、24零输入拒绝；24条样本记录／实例不是24个方向。指定报价是现有链上询价方法，结果由每笔成功执行到账印证，不将它计为新增原始 REVM 报价回执。独立核对见 [NG增量证书](curve-lp187-ng-v6-meta-independent-20261020.json)。

两个新Ready各真实发布4条方向；原候选来自更早的真实receipt，受测N仅做单块生产重验。e080原TX是swap；579a原TX包含baseLP存入 `4904477361100453947`、铸LP `102490843111614666134`，本次手工试额不是该原量或原调用前输出复现。自然effective、生产参考额和机会复现仍未新增。

sBTC `0xfe18be6b3bd88a2d2a7f928d00292e7a9963cfc6` 在N的实际代理target及代码与已验证源码精确绑定。使用底池真实非零sBTC持仓转账1单位和试额均直接返回 `Synth is suspended. Operation prohibited`；测试actor的外置TokenState余额准备控制成功，排除了资金准备失败。aa82生产strict的两档mint3／redeem3全部可信MainRevert，重验Ready与原件逐字相同；aa82 raw两次及d5bc raw四次也均main revert，Vyper返回空数据，不能说这些空回退本身带有明文原因。共享资产真实转账拒绝及源调用路径支持本状态关闭方向；不永久拉黑、不强造成功，也不把这些诊断纳入已验42方向。证据见 [sBTC状态拒绝独立复核](curve-lp187-sbtc-state-rejection-20261020.json)。

其余真实缺口继续保留：BF五币池已实读确认 pool→当前LP→minter→pool 的反向身份，现有两至四币范围仍需最小扩展；Swerve派生LP代码不同，首次未猜私有minter槽；随后取得完整匹配57efd7代码类的已验证源码，再单独补读同N的slot6，确实回指pool，身份依据已闭合。两者仍未新增生产LP准入或执行。两者来源TX都是swap，LP能力扩展不能冒称原swap腿已支持。首次26次身份读取整体exit1表示当时Swerve来源未决，各RPC正常返回；该失败保留，后续仅新增1次源代码约束的storage读，不能把身份闭合写成LP执行通过。[独立身份复核](curve-lp187-residual-identity-20261020.json)保留新旧结果。

## 实现、工具修复与回归

准入使用链上 registry／factory／LP／pool 反向身份及已验证部署代码类别。旧版 sBTC LP 没有公开 minter getter，仅对已验证运行时代码类别解析 slot6，并核对非零规范地址与反向身份得到的 basePool；未知无 getter 代码继续关闭。该规则不是实例地址白名单。

TwoCrypto 0.3.10 的费用提取路径按已验证源码和部署运行时处理，原 generic 保护保留。中央接口仍共用，协议 ABI、金额和 fee effects 留在 Family。

历史 CLI 曾丢失真实 `A_precise` JSON-RPC code3 revert，导致两个旧尝试在 EVM 执行前失败。修复复用 ethers 标准错误解析，HTTP／容量／未知错误不伪装成合约拒绝。另将两条历史验收 CLI 的元数据修为 test／fork。两个缺陷均登记真实 `codify_commit=78f4bbbc6f6bc77992fab639eef56502fd4bc7f5`，实际 tooling validator 无失败；其余 73 个 LearningCase 保留。

前一实现批的当前生产 build、CLI 导入、Curve 合同 **85/85**、共用双接口合同 **311/311**、composition、strict declarations 通过；metadata **21/21**、LearningCase **16/16**、tooling validator 合同 **1/1** 通过。不将离线合同计入上表历史执行数，不声称整个仓库 TypeScript 全量检查无旧问题。

工具对账查询 `curve,lp`；实际使用 `listener:searcher:curve-lp-family`、`listener:searcher:curve-lp-historical-ready` 和 `listener:searcher:curve-lp-historical-dual`。v5 manifest SHA256 为 `701a9bee0c8f5134487cd5613d5907268520669b0fa97675a12ac64f04629a1f`；v6 为 `3d279477ef0ac1332a503ef1b588d792f15f201aa4abf7fad4ee5fa81b3da095`，路径与执行收据在 JSON。

## 源码和未完成边界

首批六实例的实际执行基线是 HEAD `72019630c2d1cfc716754a99544794c406752a1d` 加当时真实 dirty 内容。复用 NG 的源码指纹 `ae8af3bd15b75f4a97ea069840af971fbf54e3ebe22fb65928bd689d6ab66444`；新增 zap／crypto 的指纹 `d03c638e428d41b328d7036e5afd0c9278ef838250c714d7d7ccea0c62908966`。原实现提交不替换旧证据指纹。前六实例不是在新提交的干净 checkout 上重跑；本次两新增实例另记实际HEAD2ef与完整dirty指纹；独立依赖审查确认所需外部接口在提交父基线存在。

提交仅包含 36 个相关路径，其中 package 仅三个 Curve LP 脚本键、generated 仅 11 条 Curve LP 行；其他 Ready、UniV1 等未提交内容保留。既有失败、Ready、checkpoint 和原始执行材料全部保留。REVM binary SHA256 为 `e5cbce3521fd98d7e59d3de80cca4fa0c3ec94c5cdfb1e74bbae4d6d7c7588c6`。

187 候选分类为 125 NG、56 registry nonNG、1 V1 self-LP、2 zap、3 未准入／来源待定项。五个 NG 实例不代表 125 个全部通过；一个 TwoCrypto 不代表全部 generic 类别、V1 或其他池。两 zap index3 已记录本状态正确拒绝；其他精度／费率类别、stable 调 A 和 metapool TTL 等范围仍需逐项证据，不能因接口存在升级为支持。

本批没有新增自然 effective／估值、原 TX 调用前输出一致性、完整机会复现、代表性性能或 live 成果。整体 goal 保持未完成。

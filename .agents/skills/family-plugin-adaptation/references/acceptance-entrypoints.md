# 验收入口与覆盖边界

路径相对本次实际实现仓库；下面是入口地图，不是永不变化的命令契约。执行前核对当前源码/package scripts。不要因文件名叫 strict/historical 就把 fixture 当真实历史验收。诊断分析遵循项目 manual-first、tool-index/tool-run 的取证要求；固定测试命令不代替真实实例证据。

## 一、先跑哪些测试

在 listener 目录执行：

```bash
npm run build:live
# 按目标 Family 的实际测试入口运行，不假设每个 test/*.ts 都能由 --test 运行。
npm run searcher:strict-family-lifecycle-runner
npm run searcher:strict-central-adapter-runtime
npm run searcher:strict-execution-projection
```

目标 Family 测试例子：

```bash
npm run searcher:univ3-family-plugin
npm run searcher:curve-underlying-family-plugin
node --import tsx --test src/searcher/venues/swaps/balancer-v3-family/test/contract.ts
```

这些例子按涉及的 Family 选择，不是每次全部运行。检查相应源码断言涵盖本次语义和正/负例。`build:live` 是当前生产编译检查；`npm run build` 还包含 Rust enumerator 和全仓 TypeScript，不能互相冒充。全仓旧失败须核对基线并单列，不能由生产编译通过推导全仓通过。

相关共用测试入口：

| 改动范围 | 当前 package script / 文件 |
|---|---|
| strict catalog/注册 | `searcher:production-family-composition`、`searcher:strict-production-family-declarations` |
| strict 生命周期/执行投影 | `searcher:strict-family-lifecycle-runner`、`searcher:strict-central-adapter-runtime`、`searcher:strict-execution-projection` |
| Ready/图 | `searcher:strict-ready-runtime`、`searcher:strict-ready-graph-view`、`searcher:universe-rebuild-production` |
| Exact 复用 | `searcher:adapter-family-exact-quote-cache`、`searcher:strict-solver-consumer` |
| 共用模拟器 | `searcher:revm-strict-simulation-transport`，仅在相关改动/故障时加入 |
| 双接口覆盖／生产 sim 构造 | `searcher:family-dual-execution`；逐族检查指定金额报价与实收执行，包含关闭的已安装 Family |
| 保存 Ready 的实收构造审计 | `searcher:family-runtime-audit -- <checkpoint.json>`；只读检查现有 descriptor/route 的构造覆盖，不签发新准入或绕过指纹 |
| 实收 VM 安全约束 | `test/BotVMRuntimeAmount.t.sol`；原库存隔离、到账、callback 债务、原生币差额与指令边界 |
| 单块阶段时效性 | `benchmark:effective-update`、`benchmark:sim-amount`；边界、参数与比较口径见 [时效性验收](latency-acceptance.md) |

先核对当前分支是否已有双接口入口；不能从别的分支借测试结果。`family-dual-execution` 的静态描述符和合成状态只证明 ABI／接线合同，即使调用生产 sim 选额器，也不等于真实 RPC 模拟、strict 或历史盈利通过。仍需该 Family 原有指定金额报价测试及本次适用的同状态执行证据；新方向／变体补入 Family 自有行为测试，不仅增加接口清单。

`listener/src/searcher/test/strict-family-lifecycle-runner.ts` 使用合成 source 和 fixture runtime，包含 Exact/fragment 金额一致断言；**不证明任意新 Family 的链上 strict 已通过**。

## 二、“原 TX 输出与适配输出一致”现有覆盖

| 文件 | 真正检查的内容 | 不能推导的结论 |
|---|---|---|
| `listener/src/searcher/venues/swaps/balancer-v3-family/test/contract.ts` | 合成 RPC/state 下 identity、quote、执行编码、负例 | 不是链上回放 |
| `listener/src/searcher/test/family-integration/balancer-v3/historical-check.ts` + `historical-execution.ts` | 实际 receipt 金额与样本一致；自然 lifecycle→Graph；N 块末 quote 与同状态执行到账一致 | 不是原 TX 调用前状态输出对照；当前样本固定，省略 artifact 会跳过执行 |
| `listener/src/searcher/venues/swaps/curve-plain-family/test/cached-execution-parity.ts` | 保存的真实 identity simulation 返回值、四项 token delta、当前 action calldata 对照 | 不签发新准入；不是 receipt replay |
| `listener/src/searcher/test/family-integration/three-family/historical-dual.ts`（`searcher:three-family-runtime-dual-historical-fork`） | 固定 Balancer V1/V2、Badger Sett 样本的生产 Ready/价格绑定；同 N、多个金额的 quote、quoted 和 runtime 实际到账 | 不是任意 Family/TX 通用入口，不是原 TX 调用前状态或完整资金闭环 |
| `listener/src/searcher/venues/protocols/set-redemption-family/test/historical-runtime-dual.ts` / `historical-runtime-dual-offline.ts` | Set 指定篮子的同状态双执行与组件到账；offline 版使用捕获状态 | 不代表所有篮子/模块、全链状态或自然套利盈利 |
| `listener/src/searcher/test/family-integration/three-family/original-runtime.ts` / `original-exact.ts` 及同目录 Solidity 验证器 | 指定三笔 TX 的捕获调用前状态、原输出与当前 Exact/编码执行；需检查实际运行的 native verifier | 不是通用块内前缀还原，也不是原交易融资全复现 |
| 同目录 `original-v1-cached.test.ts` | 认证先前 native 证据，使用当前代码重算 Exact/calldata/runtime，校验请求/返回和执行器绑定 | 不新增 EVM/RPC 执行，不能覆盖失败的 fresh-native 重跑 |
| `listener/src/searcher/test/adapter-replay.ts` | route witness→Family→Planner→Solver 选量→final sim→偿还/守恒→EV | Solver 自选量，不断言等于原 TX 金额/输出；不证明自然枚举 |

```bash
# 以下会用历史 RPC/模拟；只在本次实际验收授权内执行。
node --import tsx src/searcher/test/family-integration/balancer-v3/historical-check.ts \
  --env-file "$FAMILY_ENV_FILE" --botvm-artifact "$FAMILY_BOTVM_ARTIFACT"

# 离线验证已保存的真实执行证据；显式传本次适用的产物。
node --import tsx src/searcher/venues/swaps/curve-plain-family/test/cached-execution-parity.ts \
  "$FAMILY_EXECUTION_ARTIFACT"

# 正式 route-pinned 执行验收；--validate-only 仅检查 fixture，不跑执行。
npm run searcher:adapter-family-replay -- --fixture "$FAMILY_REPLAY_FIXTURE" --out-dir "$FAMILY_REPLAY_OUTPUT"
```

当前没有通用“任意 TX → 还原每腿前状态 → adapter 与原 receipt 输出逐 wei 相等”入口。`historical-replay-anchor.ts` 的 `anchorHistoricalSenderNoncePrefix()` 只还原同 sender nonce 前缀。不能把它当完整块内前缀工具。

复用已有测试时检查其实际 backend、source、executor 和断言；有本地 fork 要求就按项目规则执行。已保存远端只读模拟证据与本地 strict 结果分开列，互不冒充。

## 三、历史交易与区块在哪里取

1. 首查本次运行的 `SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH`，或用户明确指定的 Ready。此安装曾使用 `/Users/eunice/src/MEV/runtime/universe-rebuild-checkpoint.json`；这是定位线索，不是固定输入，更不代表最新。
2. 从 checkpoint 的 `verifiedMemos` / `candidateSnapshot` 找目标 Family 的真实来源：`blockNumber`、`blockHash`、`transactionHash`，同时保存 memo key/fingerprint、Family definition hash。
3. 区分 `candidateSnapshot` 的发现块、`validity.proofSource` 的验证块、`readyGeneration.cutoff` 的发布块。不可把 proofSource 误认 TX 所在块。
4. 用该交易 receipt 确认 N/hash；用历史 RPC 获取 receipt、trace 和 pinned state。strict 缓存不是完整 receipt/trace 缓存，旧准入 memo 也不是当前代码的准入许可。
5. 缺样本先检查已有缓存清单/历史报告，再用当前 tool-index 选择真实交易发现工具。日志里的旧案例 runner 可能硬编码地址/块高，不能直接当通用入口运行。

指定 TX 清单的 Ready 可有稀疏 observation scope；其 from/to 是外包络，不代表连续区块均已扫描。优先读取相配套的 transaction receipt/trace 缓存，核对 selection、内容哈希及成功调用（排除 reverted ancestor）。用于 Family 集成的单块 Ready 仍走 from=N/to=N，不能把稀疏 Ready 声称成该范围完整扫描。

## 四、单块生产 Ready 和价格

变量均先由本次 receipt/配置解析为明确值。`FAMILY_SAMPLE_BLOCK=N`，不是某个固定历史高度。使用新的隔离 checkpoint、run id 和输出目录，保留原 Ready。

此处是 Family 的 N 环境验收，不是机会复现的 N−1 环境。价格与单腿执行都固定 N；若受测 simulator 自动推进 N+1，必须明确识别并改用适配的同环境入口，不能仅凭 `sourceBlock=N` 宣称环境一致。原交易逐单位到账对照仍须该腿的实际调用前状态。

```bash
# 在 listener 目录；运行环境按当前 CLI 提供已批准的 RPC 和模拟器配置。
SEARCHER_DRY_RUN=1 npm run searcher:universe-rebuild-startup -- \
  --checkpoint "$FAMILY_CHECKPOINT" --run-id "$FAMILY_RUN_ID" \
  --from-block "$FAMILY_SAMPLE_BLOCK" --to-block "$FAMILY_SAMPLE_BLOCK"

npm run searcher:universe-rebuild-status -- --checkpoint "$FAMILY_CHECKPOINT" --json

SEARCHER_DRY_RUN=1 npm run searcher:at-block -- \
  --ready "$FAMILY_CHECKPOINT" --block "$FAMILY_SAMPLE_BLOCK" \
  --through prices --out "$FAMILY_PRICE_OUTPUT" --env-file "$FAMILY_ENV_FILE" \
  --executor "$FAMILY_EXECUTOR" --owner "$FAMILY_OWNER" --revm-bin "$FAMILY_REVM_BIN"
```

- `universe-rebuild-runner.ts::rebuildUniverse` 支持 from/to 同为 N；`universe-rebuild-production.ts::createRebuildWiring` 复用 production discovery→strict attestation→memo→Graph。
- `blockscan-at-block-cli.ts::runAtBlock` 加载已完成 Ready，调用生产价格流程输出 `prices.json`，自身不做 discovery/rebuild。核对当前版本已包含它；不要默默跑别的工作区版本。
- startup 的 RPC 配置通过当前环境解析器注入，不能误以为后一个命令的 `--env-file` 同时配置了前一个命令；不输出凭据。
- `status=READY` 不代表每个候选 admitted；`effective.complete` 不代表每行 quoted。检查目标 memo/active instance、图方向、raw/effective 具体行及 source。

必要的单候选补验已有入口：

```bash
npm run searcher:universe-rebuild-probe -- \
  --checkpoint "$FAMILY_CHECKPOINT" --run-id "$FAMILY_RUN_ID" \
  --family-candidate-key "$FAMILY_CANDIDATE_KEY"
```

probe 保持原 cutoff，更新 outcome/memo；之后仍需原生产 rebuild 发布 Graph，不能把 probe 成功当作图已更新。

仅队列重试次数变化不等于图过期；新增/撤销准入或被选中证据变化且未发布才构成同步差异。运行期须取 sealed catalog 选中的 candidate memo，不能按实例随便取第一条历史 alias。保留 retryable 是允许的，但不能凭旧图根合法就把更新后的 checkpoint 当已发布。

Family 集成核对价格、同状态双执行及相关阶段时效性；不默认追加机会搜索。额外请求机会复现时转入统一的 `mev-blockscan-replay`：按 blockscan/backrun 准备状态与环境，沿各 lane 当前生产选额/最终 sim/EV；不在这里复制管线。Blockscan 的 sim 选额与仍存在的 quoted/Solver 兼容模式应分开记录。

## 五、已有生产约定：不能在适配时另起一套

这些约定来自用户逐次确认；执行时核对当前实现和最近明确选择，不把早期方案覆盖后续决定。

- **报价来源不是一刀切。** 新适配优先寻找匹配池/实现的链上询价入口；`eth_call` 读取状态后由本地公式算 amountOut 仍是本地报价，不能只改声明说成链上输出。没有合适询价入口时，在同状态执行对照支持下使用本地金额公式。保留已有模式切换，不自动把所有 Family 改成重模拟。
- **已批准的本地模式要保留。** 用户后来明确同意 V2/V3 effective 改成本地，并与 Solver 共用报价函数；Self-burn 的已确认语义也允许源码复算。不能因早期“优先链上”要求将这些选择悄悄改回去。V3 读取的是当前 word 左右各 24 个、合计 49 个 bitmap word 的已批准方案，不是 49 个 tick 或整池 tick；缺失范围不能硬算。此项只约束对应实现，不强推其他 Family。
- **区分读状态与算金额。** 协议需要的读取与解码由 Family 声明，批处理、并发和生命周期由共用 request runtime/调度执行。effective 与显式金额报价复用同一报价函数；对已验证的本地模型，相同有效池状态下换金额只重算，不重复读状态。链上询价仍可按金额请求，不因追求缓存擅自改成本地公式；无金额依赖的读取/guards 可按现有有效性规则共享。不得另设 Family 私有的 effective 复用判定或第二个调度器。
- **沿用同一 mid 更新流程。** 使用既有 touched 集合、增量状态/价格缓存与发布过程；不为 effective 加全量 producer、全图会话准备或 gas/amountIn 变化失效条件。正常状态/source 安全约束仍保留；若发现既有增量流程的问题，准确归因，不在本次适配顺手改中央刷新策略。
- **按实际 effective 金额验收。** 当前 `blockscan-effective-mid.ts` 由成功的 effective 前向报价确定 amountIn，不用 raw mid 重新换算。`SEARCHER_BLOCKSCAN_EFFECTIVE_AMOUNT_CASCADE_ENABLED` 默认 0：未变化池保留原 amountIn/out、报价来源与金额路径，不因上游参考额变化自动重报。查当前实现/配置；不能把表的发布块当每行的新报价块，也不能用统一新 P 覆盖 carried 行。
- **执行资格和金额容量在 Family 内处理。** V3 等调用者权限问题通过现有准入/执行资格能力检查；动态权限不记永久身份拒绝，随既有启动/状态刷新流程验证。V4 的已批准输出余额约束放在其报价内：同一状态下 amountOut 超过 PoolManager 输出币余额则该金额不可用；余额够也不等于最终一定可执行。不要推广为所有协议新增余额查询接口，也不要每条 effective 都做一遍 final sim。
- **费用和舍入要有依据。** 验收记录实际 fee 来源、源码常量或现存假定，不冒称逐池已读取。用户已知且明确暂缓的旧假定单列，不因此扩大当前适配。1 原始单位宽限是允许实际少到账，不主动少传；是否启用取现有全局开关，不能让报价和 Solver 先扣 1 单位“制造一致”。
- **调度沿用共用机制。** 429/超时按原共用调度降低整批压力与有界重试，不只让失败单项降并发；不能把一次降档永久带入后续独立启动。这里是复用检查，不授权顺带重写调度或无限重试。

验收需同时区分两组金额：生产参考 amountIn 证明实际搜索输入可用，原 TX amountIn 用于历史对照。若不同，不用其中一组冒充另一组；最终以各自同状态 quote 和实际到账比较。

## 六、依赖与状态变化

- 先沿当前生产调用链核对：Family 链上读取依赖 → `pricing.dependencies()`/`mutation.affectedStateKeys()` → 共用 touched 选择 → raw/effective 同轮刷新与 Exact 状态失效。接口存在、单独调用返回正确、或 backrun 已有 oracle 触发，都不能证明 blockscan 已接通。
- 从实例 getter/已验证布局解析地址；中央只处理通用地址与 stateKey 关系，不放池子→预言机白名单或协议分支。复用原日志/trace 监听，不为这一族新增扫描器或调度器。
- 区分预言机“同地址更新数值”和“更换代理/聚合器地址”。可变绑定若保存进 Ready，必须说明旧 Ready 如何安全恢复；读到变化后永远拒绝、只能人工删缓存，不是自动恢复。用户明确限定“先接固定依赖、换地址时安全停报”时按该范围验收，验证变化后及后续无交易区块都不会复用旧价格，并把自动重新绑定列为未实现；不能借 skill 擅自扩展模板。缺通用能力时先说明范围并取得必要授权，不伪造 Family-local 实现。
- 最小回归覆盖受影响实例刷新、无关实例复用及失败不发布旧价格为新状态。测试调用真实生产入口；合成状态变化只证明接线，历史链上证据仍单列。不要为该检查扩成全量协议审计。
- 缩小刷新范围时仍接收完整日志/trace 和依赖变化，在发 RPC 前由 Family 的语义判定筛选；不把基础币的任意 Transfer/Approval 当作全体持币池变化，也不一概忽略它们。只对已证明不影响定价的绑定对象/事件过滤。正例覆盖适用的 swap、底池操作、donation、mint/burn、fee/rate/topology 变化；负例覆盖无关转账/授权；未知、畸形或未绑定输入保持保守处理。
- “无日志就复用”只适用于已证明静态的语义；Hook、rate provider、时间依赖/active ramp 仍需对应刷新或安全拒绝。无依赖的报价与 guard 读取可在同轮声明，同状态读取/重复哈希可共享，但不删 source、代码、拓扑、ramp 校验，不跨无效状态复用成功证据。

## 七、近期 Family 的语义边界：作为测试设计例子，不作通用模板

| Family / 分支 | 适配时应检查 | 不可泛化为 |
|---|---|---|
| Set Redemption | quote＋quoted fragment 保留；实收程序用现有嵌套子程序分组保护组件，每个组件检查到账，失败原子回滚；同时验证程序/金额上限 | 默认扩中央 VM、漏组件检查、无限篮子支持，或一个历史篮子代表所有模块 |
| Balancer V1 / V2 Swap | 各自链上身份、fee/math、池型/方向、Vault/pool 收币与执行接口；Swap 与 flashloan Funding 分开 | 能闪借即支持 Swap，或已验 2/3-token 样本即所有 Stable/Managed/Composable 池通过 |
| graviAURA | 当前是 `protocol:badger-sett-withdraw` 的 liquid withdrawal，按 share→asset 方向验证 | 通用 Aura Family、任意策略/锁仓解锁/存入均支持 |
| Balancer V3 | 验证 Hook flags、rate/fee 行为和真实执行；仅证明静态无 Hook/无 rate 的分支才缩减无变化块刷新 | 带 Hook 池套无 Hook 刷新策略；非 swap Hook 样本证明任意 swap Hook 支持 |
| Curve Plain | 支持的 quote ABI/执行模式分别验证；无依赖的 `get_dy` 与刷新 guards 同轮声明 | 已去链外 Exact 即没有链上执行成本，或局部无排队即全图时效达标 |
| Curve Underlying classic meta/base | 区分 base→meta 的 mint 费/舍入、base→base 的 exchange 费/精度顺序、meta→base 的 rate/withdraw 语义；当前有效金额与原 TX 金额分别比对 | 一个线性点价/统一费率覆盖三种方向，或已绑定模型覆盖未知实现；active ramp 不能沿用静态模型 |

这些检查来自当前生产模板及已提交验收，定位入口为 `docs/research/reports/family-goal-closeout-20261008.json` 所引用的分项报告（核对基线 `c471b5a5`）。需要案例时读取对应报告和 Family 测试；数量、块高、耗时不是永久验收阈值。保存的历史成功、当前离线重算、当前历史 EVM 执行、全 live 验收分别报告。

## 八、工作区与交接

- 交接写明机器/实际源码路径、分支、HEAD、未提交改动、文件归属、代表 TX/块高/实例及证据位置；接手者先核对，不从另一目录的同名分支推测一致。
- 是否新建分支/工作区服从用户要求，不自动增建。并行任务获准用独立分支时还要使用独立目录，不能在别人的活动工作区 checkout；若当前源码未提交，使用经核对的 HEAD＋补丁＋必要新增源文件（或已保存完整源码快照）恢复相同基线，再记录快照指纹。不得遗漏新文件，也不得打包密钥、环境文件、node_modules 或庞大运行日志。
- 清楚划分 Family 自有文件与共用注册生成物。现有生产入口是 `venues/production-families/*.production.ts`，运行期消费 `generated/production-family-entries.generated.ts` 等静态产物；只添加目录不等于已注册。核对当前生成工具如何收集入口（包括 Git tracked-source 约束），通过生成工具更新和检查，不能手填 hash 或给中央加协议分支。
- 当前可核对 `family-capability-manifest:generate` / `family-capability-manifest:check`、production-family-composition 和 strict-production-family-declarations。生成物、package scripts、共享测试或激活默认变更在各自分支完整验证，合并时由整合者统一重新生成并复测；不能整文件覆盖另一人的变更。
- 原 Ready、输入缓存和运行快照只读复用；输出、RPC预算和进程分别归属。跨目录 node_modules 或工具复用需核对版本，不能把别人的正在运行产物当稳定基线。
- 每个 Family 交付限定文件清单/源码指纹、真实样本、严格准入/Graph/价格/双接口/耗时结果及未验证项。只有当用户要求时才写原配置表；保留表格既有列，把 Family 集成、自然枚举和完整盈利分开，没跑的列记未验证，不用新的汇总表替代原表。

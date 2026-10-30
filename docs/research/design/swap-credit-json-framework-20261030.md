# Swap／Credit JSON 框架与迁移交接

本轮采用一套 Family 公共核心、三个领域声明：Protocol、Swap、Credit。发现、身份验证、实例、方向、读取轮次、定价、Exact、动作和效果检查共用；Swap 观察与回调、Credit 仓位风险各有领域模块。它们不进入 live 调度器的协议分支。

权威工作区仍是云端 `/opt/mev-cloud/family-runtime-20261007`，分支 `codex/family-runtime-actual-20261007`。本轮不启动 live、不部署、不签名广播，不改原 coffee Ready/checkpoint，不把旧 hash 改写成新验收。历史单块使用新的独立输出。

## 1. 冻结范围与实际交付

范围来自 app-run2 已结束的实际运行 `live-2026-10-30T03-10-36-590Z-68a6c8af`，HEAD `c609ffaf8b029cd40dd594af94925273fd900d76`，配置 SHA-256 `0f2c2973a82bd0a7b49fbffaf51bf7ed717f4486fb66bc0f973bfffd1d9ffe19`。

Swap 15 族：`univ2-standard`、`univ3-standard`、`univ4`、`univ4-fee-hook`、`custom-swap:angstrom-v4`、`balancer-v1`、`custom-swap:dodo-v2`、`custom-swap:ekubo-router-v1`、`ella-exchange`、`fluid-dex`、`custom-swap:uniswap-v1`、`swap:algebra-integral`、`kyberswap-elastic`、`custom-swap:oneswap`、`custom-swap:precision-pool`。

Credit 只有 `credit:fluid`。关闭的 Balancer V2/V3、Curve plain/underlying、Mooniswap 等不迁移、不重新启用。

- 公共 TS 与测试由本窗口维护；迁移窗口提供 JSON、纯数学入口、样本字段，运行同一套测试，不另写协议验收逻辑。
- Balancer V1 是本轮唯一完整 Swap JSON 示例；其他 14 族继续保留现有生产实现。框架覆盖不等于这些族已经迁移或通过。
- Credit 提供公共风险证明模块、生成入口和中央调用者接线；没有替换 Fluid Credit 生产入口、没有新增 Credit 策略或 runtime 能力。
- Swap 样本库导入 15 族、27 条真实 TX 引用；一个 Balancer V1 case 有四个输入、两个方向。其他引用保留待补字段，不能用输入库完整性代替执行通过。

## 2. 生产入口与公共生命周期

入口由 `build-declarative-production.ts` 生成：

```ts
// 生成文件只负责把静态 JSON 交给同一公共核心。
export const plugin = defineSwapFamily(
  compileDeclarativeSwap(definition, children),
);
```

`declarative-protocol.ts`、`declarative-swap.ts`、`declarative-credit.ts` 仅做领域类型与入口检查；实际流程都调用 `declarative-family.ts#createDeclarativeFamilyRuntime()`。JSON 不允许 `module/export/handler` 回到 Family 专用 TS。

```json
{
  "version": 2,
  "scope": { "family": "balancer-v1" },
  "production": {
    "domain": "swap",
    "activation": {
      "enabled": true,
      "envKey": "SEARCHER_FAMILY_BALANCER_V1_ENABLED"
    }
  }
}
```

示例保留原代码默认开关；测试启用只作用于该进程。生成器拒绝直接覆盖手写入口，迁移时先保留旧入口的版本证据，再正式转为生成文件。生成与 runtime 共用 root-only 模块列表，子 JSON 不能覆盖实例证明、执行投影或 oracleVictim。

## 3. Discovery、Identity 与实例证明

`compileDeclarativeDiscovery()` 执行 JSON 中的 selectors/events/sources，严格检查 ABI 编码；这只是提名。`compileDeclarativeIdentity()` 按声明步数执行 `decide → requests → decode`，多轮数量由 JSON 决定，不硬编码协议流程。

`instanceEvidence` 供需要独立实例静态证据的族声明读取、解码与最终检查；`executionProjection` 描述 spender/prewarm 元数据；二者不直接发 RPC。实例证明非空却缺数学依赖时拒绝注册，不能降级成“无证明”。

`declarative-bytecode.ts` 的 `bytecodeGetter` 是现有有界 CFG/dispatcher/storage getter 证明的公共接口；不是任意 contains-selector 或 codeHash allowlist。当前唯一编译器 profile 是已实现的 address→bool mapping getter，未知字节码拒绝。

Balancer 示例保留三轮证明：pool/factory runtime、factory 的池身份返回、finalized/publicSwap、tokens/fee/weights。固定 factory 是身份来源，不能用逐池地址名单代替实例反查。

## 4. 方向、状态与价格

`declarative-family.ts` 投影实际方向，并对 descriptor、route、binding fingerprint 验证一致性。多 token 全对方向可以用公共列表表达式，不把方向表硬编码在中央。

`pricingFlow` 读取状态；`pricingProjection` 把整数比率转换为原有 Graph mid。它验证每条可用方向都有唯一价格，拒绝外来 route、缺行、重复行和零分母。只有最终 mid 边界使用浮点数。

显式空静态依赖使用 `source-local`：仍由中央封存为当前 source 的证据，不伪造依赖，也不增加请求。非空依赖继续走 `dependency-proof`。本轮真实 Ready 暴露过错误声明 dependency-proof 导致 publication 为空的问题，已保留原失败产物并补公共完整生命周期回归。

```json
{
  "modules": {
    "pricingFlow": {},
    "pricingProjection": {},
    "instanceEvidence": {},
    "executionProjection": {},
    "liveStateProjection": {},
    "quoteFlow": {},
    "trialState": {},
    "quoteOutput": {},
    "oracleVictim": {},
    "math": {},
    "executionMath": {}
  }
}
```

这是公共目录导出的统一视图，空块表示未定义，不代表支持，也不会新增每块读取。已有 JSON 可以省略新键；公共 `moduleViews/moduleCoverage` 会显示空块和 `undefined/blocked/compiled`。非空定价投影缺依赖时不能退回普通预览报价。

Balancer 使用池记录的 `getBalance()`、权重和费用产生原始 mid，保持 on-touch 刷新；没有为了通用化改成每方向预览报价或每块刷新所有实例。Exact 继续走声明的两轮合约报价，纯数学只负责整数边界与比率。

## 5. Swap 观察、匿名事件与重放接口

`declarative-swap-domain.ts` 读取 `swap.events`，调用公共事件解码器并绑定 Ready 中已准入的 target/adapter/token 方向，再交给 `createStrictSwapObservation()`。不能靠 JSON 凭空生成 Graph 边。

- 标准事件要求 canonical ABI/topic/data；尾部多余数据拒绝。
- singleton 匿名 packed 事件声明精确地址、字节数、identity offset、字段偏移和有符号宽度；每个字节必须有归属，不能重叠。
- `victimSupport` 与 `localApply/overlay/replay` 分开声明；缺失能力不得自动提升。
- `liveStateProjection`、local/overlay/replay 仅做纯投影，不负责 live 搜索或调度。
- 这些是可供迁移消费的模块；尚未证明所有 15 族的关联事件、多池 identity、hook/plugin 或 victim 分支都可以无补充地完成等价迁移。每个真实缺口必须保留。

## 6. Exact、quoted、runtime 与回调

`declarative-family.ts` 从同一动作定义调用 `buildDeclarativeExecutionProgram()`。quoted 在现有封存证据校验后固定输入；runtime 的输入留在 VM `r0`，不读 Exact、不取报价回填。收款、授权、实扣、实收、旧库存、原生币边界由公共编译器统一实施。quoted 要求 `0 < minAmountOut <= quotedAmountOut`。

`declarative-callback-frames.ts` 让 JSON 声明调用和回调 ABI、data argument、参数/父层捕获值、多步和嵌套 frame；TS 计算编码偏移、分配寄存器和鉴权 payload。完整 `int256` 及受限 `neg` 数学操作可用，窄整数 runtime patch 仍拒绝。

framed deferred 要求父层 `expectedOutput` 见证，再与回调内 gross 实收核对，外层返回时必须满足准确净到账与输入还原。可使用已有 runtime read/math 得出见证，不能借 Exact/quoted fallback。**仅在 callback 内才知道输出、又无法提供父层见证的 deferred 模式尚不支持**；不得把 default/direct frame 的成功记为该模式通过。旧手写 Family 保留原路径。

当前 VM 已检查 callback sender、payload hash、消费一次和缺失回调。本轮未修改 Solidity。TS 解释器测试不替代实际 EVM 鉴权/回滚验收。

## 7. Credit 独立风险模块

`declarative-credit-domain.ts` 复用公共 read-flow；JSON 定义读取步骤、ABI 参数/返回值路径、风险计算与错误信息。公共 TS 强制验证：同一 source、descriptor/route、executor/origin、抵押输入、债务比例、position=0 请求、新 position>0 返回、抵押实际全扣、债币实际全到账、资金覆盖精确一致。

当前 profile 为 `new-position-return-and-effects-v1`；不声称泛化到所有债务策略。比例候选必须严格递增；最多 5 步来自现行中央 1 个初始＋4 个依赖轮预算，实际步数仍由 JSON 定义。最终仓位关闭、偿还与利润门保留在中央。

`adapter-credit-runtime.ts` 现在把风险阶段的 `transactionOrigin` 保存在私有记录中，构造执行时传入，调用方不能替换。有效风险证明可以进入公共 quoted 编译器；无普通 Exact 不等于无风险证明。当前 Credit 入口不生成 `buildRuntimeLeg`。普通 Exact 即使存在，也不能替代 Credit 风险证明。Capture 使用原有 Credit 格式，保留 `collateralAmount/debtBps`，不转换成普通 route 的 `amountIn`。

TX 引用保存在 `test/fixtures/credit-json/references.json`，仅有引用，不是迁移或执行通过。Swap/Protocol 双执行 runner 拒绝 Credit，不能绕过仓位与偿还检查。

## 8. 共用测试、样本与交接操作

从仓库 `listener/` 运行：

```bash
npm run family-capability-manifest:generate
npm run build:live
npm run test:family-json
npm run family-capability-manifest:check
npm run check:swap-json-samples
```

`test:family-json` 保留原 Protocol suite，并加入 Swap、Credit、callback、模块演进及中央 Credit issuer 回归。旧 `test:protocol-json` 命令仍可用。输入 case 只含真实来源与输入，不预填另一状态的输出。

`declarative-family-fields.test.ts` 自动读取样本目录中 `declarative-family-fields-v1` 格式的 JSON：声明发现观察、identity 请求轮次与反例、实例字段、全部方向、价格读取及指定金额。`balancer-v1-generic-fields.json` 是格式样板，引用保存读取资料的 SHA-256。新协议补数据，不复制测试逻辑。该离线字段测试与下面真实 EVM runner 分开报告；旧专用 fixture 保留原测试，不冒称通用字段验收。

单族真实验证使用同一生产入口：

```bash
SEARCHER_FAMILY_BALANCER_V1_ENABLED=1 npm run prepare:family-json -- \
  --case src/searcher/test/fixtures/swap-json/cases/balancer-v1--nmr-weth.json \
  --rpc-file /path/to/read-only-rpc.json \
  --revm-bin /path/to/revm-sim \
  --out /path/to/new-ready.json

SEARCHER_FAMILY_BALANCER_V1_ENABLED=1 npm run accept:family-json -- \
  --case src/searcher/test/fixtures/swap-json/cases/balancer-v1--nmr-weth.json \
  --ready /path/to/new-ready.json \
  --rpc-file /path/to/read-only-rpc.json \
  --revm-bin /path/to/revm-sim \
  --out /path/to/new-acceptance.json
```

准备入口只从 case 取 family、块号/hash、测试 actor；池地址、预期 route、输出不喂给生产 discovery。中断先查原进程和产物，不能重复启动。模拟器使用本工作区当前源码构建的 `listener/revm-sim/target/release/revm-sim`，记录源码和二进制 SHA-256；不得凭别的工作区已有二进制就假设兼容 executor-program。RPC 文件不入库，日志与原始报告保留在 `logs/swap-json-enabled-20261030/`。

迁移窗口只补其余 JSON/数学/样本字段并运行上述套件。缺真实方向／变体 TX 才向用户补样本；已有 TX 先补 receipt/header/calldata/logs，必要时 trace。每个方向的 quoted/runtime、实扣实收、拒绝/回滚和实际支持结算要分别记录。公共 runner 已覆盖默认与 direct 收款；对 deferred-input、deferred-debt、settle-output 仍明确拒绝，迁移这些能力前需要对应真实回调执行测试支持，不能改数据强行过门。

本轮执行结果见 [验证报告](../reports/swap-credit-json-framework-20261030.md)。单块正确性不代表原 TX 机会复现或代表性时效性通过；本轮不跑 live 或性能实验。

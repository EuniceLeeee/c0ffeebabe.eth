# Family 公共能力补丁与迁移交接（2026-11-02）

## 1. 范围与基线

基线是 `47422c97bd82635dc7fdeaa69380f5ca0cca746e`，权威工作区为云端
`/opt/mev-cloud/family-runtime-20261007`，分支为 `codex/family-runtime-actual-20261007`。
本批只交付公共 TypeScript、公共回归和生成的能力指纹；具体协议 JSON 迁移与历史执行验收由迁移窗口继续。

边界是：Family 定义 ABI、数据依赖、步骤、条件、结果及约束；公共层解释并验证；独立数学入口实现数学。
不增加按 family ID 分支，不把完整协议实现藏进新的公共模块，不修改 live 默认开关。
没有启动 live、重建 Ready、签名、广播或部署。

旧 JSON 没有声明新能力时保留原流程。新能力沿用现有模块、表达式、请求程序和执行 VM，
没有新增每族每块强制读取。模块缺项仍是缺项，空定义不能获得能力通过结论。
本批没有增加新的顶层 `modules` 键；已有模块空块规范化机制不变。

## 2. 公共能力与消费位置

| 文件（相对 `listener/src/searcher/`） | 本批变化 | 不代表什么 |
| --- | --- | --- |
| `build-declarative-production.ts`、`venues/declarative-family.ts` | 同一 lineage 可有多个不同 variant ID；声明的 lineage 必须覆盖；运行时条件须恰好命中一个模型 | 不自动推断模型，不放宽身份准入 |
| `venues/declarative-discovery.ts` | ABI tuple/array 叶子、派生标量字段、有界候选展开、topic-only 提名 | 不是 reverse binding 或新的日志扫描器 |
| `venues/declarative-identity.ts` | 可选 `identity.assets` 接到已有中央 metadata authority；decode 可读取返回的资产资料 | 不用 code hash 或资产存在替代行为证明 |
| `venues/declarative-values.ts` | 通用 `abiEncode`、`create2Address`、`decodeErrorCanonical` | 算出地址不是完成反向身份验证 |
| `venues/declarative-quote-proof.ts`、`declarative-family-modules.ts`、`declarative-family.ts` | 条件选择报价证明；绑定 target/caller；证明派生调用输入、packed 返回、自定义 error 返回 | 不是允许任意表达式伪造报价输出，也不是交易内 revert-quoter 的支持 |
| `venues/declarative-execution.ts`、`declarative-call-codec.ts` | 有界步骤/效果集合、普通 ERC20 多输出、带范围检查的 `uintN/intN` runtime 参数 | 不提供无限篮子、嵌套程序、native/callback 多输出 |
| `venues/declarative-event-codec.ts`、`declarative-swap-domain.ts` | topic-only 触发；显式 mutation-only receipt | topic-only 不能制造金额、resolved swap 或可重放 victim |

## 3. 定义方式（节选）

以下是字段片段，完整可执行定义及正反例以同提交的公共测试为准，不是新的协议样本。

### 同 lineage 多模型

多个子 JSON 可以声明同一个 `lineageId`，但每个 `id` 必须唯一。
模型的 `match` 写在 JSON；结果必须是布尔值，并且只有一个命中。
生产生成器仍检查声明的全部 lineage 有对应定义；不能为绕过这个检查缩减已有支持。
公共运行时不凭协议名字自动挑模型。

### tuple、派生字段与候选展开

```json
{
  "fanOut": { "argument": 0, "maxItems": 3 },
  "fields": {
    "subject": { "from": "target" },
    "token0": { "from": "item", "path": [0, 0] },
    "token1": { "from": "item", "path": [0, 1] },
    "poolId": {
      "from": "expression",
      "value": {
        "op": "codeHash",
        "args": [{
          "op": "abiEncode",
          "args": [["address", "address"], ["$item.0.0", "$item.0.1"]]
        }]
      }
    }
  }
}
```

公共编译器把 `maxItems=N` 编译成 N 个已有 catalog pattern，继续使用原来的单候选接口。
没有声明 fan-out 时仍只有原 pattern。超出声明长度整条观察拒绝，不截断成“部分成功”。
上限为每处 128 项、总 pattern 1024、路径深度 16；fan-out calldata 限 64 KiB。
实例 subject 仍来自真实 target/emitter 等已支持地址来源，不能由表达式任意指定准入地址。
派生 poolId 仅是候选字段，之后仍须真实 identity 验证。

### 可选资产资料

```json
{
  "identity": {
    "assets": [
      { "key": "input", "kind": "erc20", "address": "$candidate.asset" },
      { "key": "output", "kind": "native" }
    ]
  }
}
```

只有声明这个字段才挂接 metadata hook；资料由已有请求/来源验证提供。
旧 JSON 未声明时，原来名为 `assets` 的局部变量仍合法；实际 Peapods 定义已做只读编译复核。

### 报价证明

`modules.quoteFlow.chainQuote` 的原单步及 `steps` 链仍可使用。新的条件选择写法：

```json
{
  "version": 2,
  "choices": [{
    "when": { "op": "eq", "args": ["$direction", "deposit"] },
    "proof": {
      "version": 2,
      "step": "quote",
      "requestId": "quote",
      "signature": "function quote(uint256) view returns (uint256)",
      "amountPath": [0],
      "outputPath": [0],
      "requestBinding": { "target": "$target", "caller": { "kind": "none" } },
      "inputBinding": {
        "value": { "op": "sub", "args": ["$quote.amountIn", "$steps.relationship"] },
        "checks": [{ "op": "gt", "args": ["$quote.amountIn", "$steps.relationship"] }]
      }
    }
  }]
}
```

`inputBinding` 只用于协议确实需要计算调用参数的场景，不能为了舍入人为减小用户请求。
原始 `amountIn` 仍保留在 Exact 证据；测试验证了原请求 170、状态关系 7、实际调用 163，
并拒绝换 target、换来源或错误参数。关系资料来自公共 read flow 重建的环境，不能从伪造的 evidence 注入。
协议数学正确性仍须该协议同状态报价和执行证明，公共绑定检查不能替代它。

packed 输出使用 `outputWord: {offset, width, signed, negate?}`，只允许 bytes32 的有界字段提取。
自定义 error 报价使用 `errorSignature` 和 `completion: "reverted-as-declared"`，且请求须显式允许返回 revert data。
公共层检查 selector、完成类型、规范 ABI 编码、来源、target/caller 和金额关系；其他 revert 不能冒充成功报价。
这些是链外报价证据能力，交易内 runtime quoteOutput 的 revert 捕获仍不在本批。

### 步骤集合、输出效果与窄整数

`execution.version=2` 的 `steps`、`effects` 保持数组。
数组元素可以使用已有 `map`/`concat` 表达式产生列表；公共层展开一次，最终每个列表最多 64 项。
不能把整个 `steps/effects` 顶层换成表达式对象。

```json
{
  "effects": [
    {
      "kind": "debit",
      "token": "$route.tokenIn",
      "account": "$executor",
      "equals": { "runtime": "amountIn" }
    },
    {
      "op": "map",
      "args": ["$descriptor.components", "component", {
        "kind": "credit",
        "token": "$component.token",
        "account": "$component.account",
        "role": "$component.role",
        "minimum": { "op": "uint", "args": ["$component.minimum"] }
      }]
    }
  ]
}
```

多输出必须有且只有一个 `role: "route-output"`，其 token 与路线输出一致；其他为 `side-output`，
每个都必须有自己的明确 `minimum` 或 `equals`。每个资产分别测量新增到账并保护旧库存。
仍只有一个资金输入；side-output 不自动成为下一跳或利润。外部收款路径同时保护另一账户的原库存。
当前支持普通 ERC20 多输出，不支持多输出 native/callback/延迟付款/quoteOutput；不支持的组合明确拒绝。
64 项是声明上限，不是可执行保证，原 VM register/instruction 预算可能更早拒绝。

`uintN/intN` runtime 参数使用同一 ABI 编码器。执行编译器显式启用 checked 模式并在 CALL 前发出范围检查；
有符号值必须完整符号扩展，不能通过截断或掩码变成“合法输入”。其他没有生成检查的 codec 消费者保持原限制。

### 只有 topic 的观察与 mutation-only

没有事件 ABI 时，只能声明 topic 触发，并设置 `receiptMode: "unresolved"`。
它可用于提名/触碰，不能声称已经恢复 swap 金额或 victim 状态影响。
有正常 ABI 的事件可以显式声明 `receiptMode: "mutation-only"` 和非空 `mutationReason`。
两者都不绕过 identity、完整 receipt 或重放准入。

## 4. 迁移窗口现在可以继续什么

下表是公共表达能力的进度，不是协议验收通过表。应以当前 JSON、实际 blockers 和同状态执行重新核对。

| 族 | 本批解除的表达限制 | 仍不能据此宣布完成 |
| --- | --- | --- |
| DODO V2 | 派生调用输入、方向选择整份 quote proof、同 lineage 多 variant | 各 registry 身份关系及双方向实际执行 |
| Algebra Integral | 同 lineage 多模型、CREATE2/ABI 纯运算 | plugin immutable/工厂身份的完整证明及各模型执行 |
| OneSwap | 窄整数 runtime 编码、已有条件路径、mutation-only receipt | 原生币/代币方向完整迁移及双执行 |
| Ekubo | tuple/数组候选、派生 poolId、packed 报价证明 | Core-init reverse binding/日志索引并未实现 |
| Fluid DEX | topic-only、可选资产 metadata、自定义 error 链外报价证明 | runtime revert-quoter、特殊原生币结算的完整覆盖未实现 |
| Set redemption | 有界普通 ERC20 多资产输出和动作集合 | 大篮子嵌套程序、旧 action parity、全部版本/方向并未验收 |
| Uniswap V4 Fee Hook | 同 lineage 的模型选择 | 共享 trial/prefix 资源及各 hook 的完整事实验收未完成 |
| Angstrom | tuple/派生候选表达 | runtime-evidence producer、EIP-712 授权证明、专用 poolId 绑定未实现 |

xWin 的 code-bearing actor 验收环境没有改动。wstETH 的 0/1 容差与边界要求没有放宽。
公共样本库负例测试改为自建 pending fixture，避免要求真实历史库永远保留一条 pending；
这只去掉测试对库存形态的依赖，不替代 zero-tolerance 失败对照，也不改变任何历史 case 状态。
干净基线的 Balancer V1 构造测试还补上了 mock session 已缺失的 `blocksPrefixInversion()` 方法；
保持原有 Exact=0、quoted=0、RPC=0 断言，不修改生产选额逻辑。

若剩余阻塞不能由这些基础能力组合表达，保留具体 file:line 和失败证据。
不要为“迁移计数”添加整个协议专用 callback、身份验证器或报价实现到公共引擎，也不要删除原有支持。

## 5. 验证事实与局限

- 当前实际源码的本地镜像：`test:family-json` 为 **652 项 / 651 pass / 0 fail / 1 既有 skip**。
- `build:live`、`family-capability-manifest:generate`、`family-capability-manifest:check` 通过。
- 新增/修改测试严格 TypeScript 检查通过；执行相关专项 **268/268**，Discovery 专项 **39/39**。
- 报价与生产 Exact 接线独立复核 **25/25**；公共 identity/model 相关独立复核 **40/40**。
- 多输出/窄整数/quoted/runtime/callback 的非作者独立复核 **261/261**，无阻断发现。
- 旧基线运行本批 37 个新能力测试，**2 pass / 35 fail**；候选版本通过。
  这是公共框架离线失败→通过证据，不是 Adapter Replay、历史交易复现或链上 EVM 验收。
- 多输出测试使用生产编译器与独立 VM 测试解释器，覆盖零扣款、欠扣、过扣、输出不足、side-output 不足、
  偷用另一账户库存、错误收款方、native 变化、窄整数越界及非规范符号扩展。
- 本轮没有协议历史双执行、单块自然 Ready、代表性能或 live 成绩，不能用框架绿替代这些结论。

测试记录留在工作日志 `logs/family-common-20261102/`，包括失败尝试；原始日志不提交。
本地镜像为 `logs/swap-json-enabled-20261030/stage/`；提交用干净基线快照核对，避免纳入云端既有 dirty 修改。

## 6. 性能与兼容边界

扩展的报价环境只在 v2 proof 被声明时构造，同一次 Exact 过程复用，不给旧 quote 额外执行一轮 read flow。
身份 metadata 只在定义时读取；事件过滤复用首次 decode。
候选 fan-out 则有真实的 pattern 数量成本：声明 N 就增加 N 个候选匹配位置，不能称为零开销。
列表展开和额外余额断言也有成本，只应由需要的定义使用。
本批没有用缩图、少启用池或放松守恒来制造性能提升，也没有测出性能通过结论。

公共代码变化会改变相关能力指纹。必须由生成器重新计算，不能覆写旧 hash 过门；
已有历史 Ready 依据实际兼容机制重验，不能直接篡改缓存，默认不重扫 14,400 块。

## 7. 继续适配的步骤

1. 迁移窗口合入本交付提交，保留自身 JSON、数学及未提交修改；共享 generated 串行生成。
2. 仅为实际需要的族填写定义，缺项继续显式为空/未支持；复用已有数学及测试体系。
3. 在 `listener/` 执行生成、`build:live`、生成检查、`test:family-json`、`check:protocol-json-samples`。
4. 在统一样本目录补 receipt/header/calldata/trace 推导出的真实输入、方向、来源与块哈希，逐变体跑同状态报价、
   quoted 执行与交易内实收 runtime；保留失败、正确拒绝、缺样本和未验证。
5. 不以临时替换 Solidity 源码匹配旧 artifact 的结果宣称当前提交通过；源码/artifact/执行器版本必须一致。
6. 准确区分“定义可表达”“构建/公共回归通过”“协议局部正确性”“自然集成”“机会复现”“性能通过”。
   本批交付仅推进前两项公共框架能力。

统一测试仍由框架窗口维护；迁移窗口补 JSON/数学和真实样本并运行既有测试，不为每个族复制一套测试引擎。

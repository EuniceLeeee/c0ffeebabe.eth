# tx4cca Adapter Family 验收报告

> 结论：`protocol:eigenpie` 的 identity、edge、quote、plan 与 fork final-sim 已通过；
> source-unseeded scanner 也能自动发现并枚举使用该 family 的同 token 闭环。严格 winner-bound
> canonical route 没有进入 scanner 的最终候选集，且 production EV policy 拒绝 fixed-path replay，
> 因此本次准确状态仍是 **implemented_not_validated**，不是 `fixed` 或 `production_fixed`。

## 1. 代码与输入绑定

- candidate commit：`fc3e8bff2481316a24c5e0457cdae03c64da022d`
- base commit：`origin/main @ b396d6f67a278f6b14bfa80ed201eed915b0f4cb`
- winner：`0x4cca0e665fa0d66181fd5aa89551d4e449c63fb987d87a2c4b7c8e305ae28be4`
- trigger：`0x75639668997ebe48f4d7f605876977c9746f68d8ca4f34224e7383286771228f`
- source window：`[25570935, 25585334]`
- frozen universe：schema 2，11,680/11,680 pools，`maxPools=20000`，SHA-256
  `c894a4b0c79afe2a30cfd69a99e42b910e6375ff29f03063d71a4c6fc27a066e`
- discovery artifact SHA-256：
  `7c07a78fdd995ebe75f49373deef554a830959c7269209e28a25be2380a92b37`
- 链状态来源：节点本机 reth `127.0.0.1:8545`；没有使用远端 archive RPC，没有部署或重启 live searcher。

Production Replay 的状态锚是 sender nonce prefix，不是 canonical full-block prefix：重放 indexes
`67,68`，nonce `76842..76843`，两笔 receipt status、log count 与 log hash 均和 canonical receipt 相同。
因此本报告把它标为 `candidate-authored-diagnostic`、`trustedAcceptance=false`、
`laneCoverage=sender-prefix-post-trigger-blockscan`。

## 2. 六步结果

| 阶段 | 结果 | 证据与边界 |
|---|---|---|
| 1 source / identity | **pass** | 未注入 target、pair、route 或 amount；2,065 candidates，302 admitted instances，286 discovered pools；`sourceComplete=true`、`evaluationComplete=true` |
| 2 graph projection | **pass** | 唯一 Eigenpie subject edge 为 `RED -> mRED`，adapter=`eigenpie-deposit-asset`；完整 graph 可构造唯一 canonical three-leg cycle |
| 3 enumeration / refinement | **partial** | scanner 最终输出 192 条 opportunity；rank 192 自发包含 `UniV4 WETH->RED -> Eigenpie RED->mRED -> PancakeV3 mRED->WETH`。winner 的 canonical PancakeV3 首腿 `0xcaa55d...9415a` 没有出现在任何 opportunity，故 strict winner-bound exact-cycle 判 fail |
| 4 planner / solve | **pass（fixed-path Adapter Replay）** | 最终 SHA 上 planner/solver 自主选 `8064831853923656 wei` WETH；quote search 88 points、62 positive；quote profit `80412404346468 wei` |
| 5 fork final sim | **pass（fixed-path Adapter Replay）** | BotVM final sim success；gross `81227010232884 wei`；gas `599536`；calldata SHA-256 `8f3c00b9e624106d7c6fdbebddebe1657afed9630b6e6d1eb2ba234c2cd52f3a`；flash lender before/after 完全相同 |
| 6 production EV | **reject** | expected profit after haircut `64981608186307 wei`，buffered gas `74066157042752 wei`，bid `32490804093153 wei`，net EV `-41575352949598 wei`；全局 EV policy 正确 fail-closed |

第 4–6 步的 fixed-path fixture 明确注入历史 route，只用于验证 adapter 中层；它不能替代第 3 步的
source-unseeded Production Replay。相反，第 3 步没有注入 route/amount，但其 runner 是本分支新增的诊断工具，
也不能冒充未修改的 trusted gate。

## 3. 结果解释

这轮已经证明的内容：

- shared observed discovery 可以在不知道实例地址的前提下产生 Eigenpie candidate；
- family identity/nonzero probe 能唯一证明 `RED -> mRED` pair 并进图；
- scanner 能使用这条动态 protocol edge 组成闭环，而不依赖 `declaredVenues`；
- `getMLRTAmountToMint` exact quote、approve、`depositAsset` calldata、`minRec`、BotVM 执行和 flash repayment
  在历史 fork 上闭合。

这轮没有证明的内容：

- scanner 能复现 winner 的 exact PancakeV3/Eigenpie/PancakeV3 pool sequence；
- 当前 production EV policy 会允许提交该 route；
- backrun 的 boundary / trigger-only / canonical full-prefix 因果；
- shared discovery/scanner 变更的系统性 cohort 与 same-input Hermes A/B。

因此可以把 **Eigenpie adapter execution semantics** 判为历史 fork 人工验收通过（不是 Rule 12 / trusted
promotion gate），把 **自动发现 wiring** 判为已实现并有真实自发枚举诊断证据；不能把整个 branch、tx4cca
production capture 或 generalized family discovery 宣称为 fixed。
若人工合并本实现，现有 final sim 和 EV 门仍会 fail closed；后续 live gap 观察不能替代上述未完成证据。

## 4. 机器证据

### Production Replay

- 完整运行 SSM command：`8f753d04-0123-4115-9de2-b4da424ad352`
- report：`/tmp/tx4cca-production-replay-fc3e8bf-rerun2.json`
- report SHA-256：`faa6734e3f8667dbd4e70f7bed921962d24f7866bf8bedae4383819ac1bd4b91`
- log SHA-256：`a891aa5ab0224665c1cd716683b0aa2f51af0511755e5f2db7d85c52a62d1af5`
- runner verdict：enumeration fail；solver/final/EV not reached for the strict canonical cycle

该结构化 rerun 的 wrapper filter 误设为 `topK=3`，但 child 的 `maxCandidates=300` 未变，实际只产出 192 条
完整 opportunity；日志逐条核得 canonical 首腿 opportunity count=`0`、Eigenpie opportunity count=`1`。
因此 topK 不是本次 exact-cycle 缺失的原因。此前 `topK=300` 的受干扰运行也已经打印同一 192 条列表，
只是在写结构化 report 前被外部 SIGTERM 中断；它不单独计作通过证据。

第一次 final-SHA 运行 `5be9642b-5cd8-4d16-b946-9ef4e14e8364` 不是代码失败：并发 SSM command
`6ab261d9-2030-443e-bc5f-f206f43771ae` 在 `2026-07-22T10:23:24.520Z` 执行全局
`pkill -f blockscan-hunt`；62ms 后报告记录 `signal=SIGTERM`。它只作为环境事故记录，不进入验收判定。

### Adapter Replay

- SSM command：`89690ed0-c1d5-487b-a6d8-beeffda47e59`
- report：`/tmp/adapter-family-replay-fc3e8bf-final/eigenpie-deposit-tx4cca.adapter-family-replay.json`
- report SHA-256：`76f558b5cd1f98eaef08b840bb016f241c844ec4ec6320860b3991039177b4bf`
- log SHA-256：`78a21e54a36e1d52938697220ccef4a9cb06245dadc6fd02300f2e6ce8298635`
- receipt binding：`baseCommit=b396d6f67a278f6b14bfa80ed201eed915b0f4cb`，
  `adapterCommit=fc3e8bff2481316a24c5e0457cdae03c64da022d`
- verdict：`implemented_not_validated`，唯一失败字段为 `productionEvPositive=false`

## 5. 静态与回归检查

最终 SHA 已通过：TypeScript build；route adapters 14/14；route-family compatibility 5/5；Eigenpie 6/6；
ERC4626、protocol instance、observed protocol、multi-adapter discovery；adapter descriptor/policy；venue identity
10/10；protocol edge/leg；planner 15/15 与 22/22 replay；taxonomy 5/5；blockscan contract 5/5；DODO；RPC
cancellation；production replay artifact contract；adapter fixtures validate-only。

`searcher:lint` 仍命中 main 基线已有的 hot-path 规则；`npm run equivalence` 仍需要外部
`/tmp/ref_clean.txt`。两项都没有被伪报为本分支通过。

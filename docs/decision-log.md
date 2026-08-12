# Decision Log — dated decisions & findings (may go stale)

> The committed sink for the dated conclusions CLAUDE.md used to inline. Scope: authorized defensive
> on-chain arbitrage research (fork/dry-run; broadcast is a human gate).
>
> Rules:
> - Each entry has a date + status: ✅ in effect / ⏳ to-verify / ~~❌ retired~~ (strike, don't delete —
>   prevents circling back to a dead path).
> - Conclusions bind the code/data state when written. Stale → update the status, don't erase.
> - Before re-opening a settled question, scan the ✅ and ❌ entries here first.
> - Cross-session operating facts also live in user memory (`MEMORY.md`); this file is the *committed*
>   copy Codex and fresh sessions can read. Link memory slugs as `[[slug]]`.

---

## Decisions

### D-001 | 2026-07-05 | ✅ | Flip the MEV-Share submit flag (falsification of the flow-admission lever)
- **Decision:** `SEARCHER_SUBMIT_HASHONLY_MEVSHARE=1` on the bounded-live node for a measured window.
- **Why:** the 2026-07-05 dual-blind arch review found 95.3% of 3,889 +EV sims (incl. the biggest
  $50–$210) self-drop at `submit_gate/hash_only_unmatchable` because this one flag is unset — the drain
  (`submitMevShareBundle`) is already built. THE production lever, not an epic. [[project-mevshare-submit-flag-lever]]
- **Envelope intact:** wallet ≤0.2 ETH, `EV_GATE=1`; `mev_sendBundle` is conditioned on the referenced
  hash landing ⇒ no phantom-loss path ([[project-mevshare-flow-discarded]]). Broadcast-behavior change ⇒
  required explicit user authorization (Safety Rule 1) — **granted 2026-07-05**.
- **Measured result (run_id `0bf0319a`, ~20 min, PID 187254) — the falsification came back "WRONG-ish":**
  - ✅ Mechanical: `hash_only_unmatchable` drops 95.3% → 0 (submit-gate wall gone); the `submitMevShareBundle`
    drain is live — `bundle_submitted` 0 → 7, all `mode:mev_sendBundle` → `flashbots-mev-share`.
  - ❌ **Inclusion: ZERO. All 7 rejected by the relay with `{"code":-32000,"message":"backrun not found"}`
    (`accepted:0`; 14 rejections this run).** The flag just RELOCATES the drop — our self-gate
    `hash_only_unmatchable` → the relay's `backrun not found`. No bundle reaches a builder.
  - The 7 sims were small (`simulated_profit_eth` 0.0001–0.0018 ETH, ~$0.4–$6), NOT the arch review's
    $50–$210 — those didn't recur in 20 min (thin window). But they'd hit the SAME rejection anyway.
- **Cause (diagnosed, F-006):** MEV-Share SSE IS connected (banner "MEV-Share SSE connected"; no custom
  `SEARCHER_MEVSHARE_SSE_URL` ⇒ real Flashbots default) and the hints are genuine, so "backrun not found"
  is DOWNSTREAM of a valid feed ⇒ the referenced hint is stale/unmatchable by submit time (timing/one-shot,
  or target-block mismatch). NOT a wrong-source and NOT the submit gate. **The next real lever past the
  gate = mev_sendBundle reference validity (latency / target-block), not economics and not flow-admission.**
- **Disposition:** flag stays ON (harmless — a rejected `mev_sendBundle` never broadcasts, envelope intact,
  no loss; it's the falsification window). It's a diagnostic win, not an inclusion win. Revert path unchanged
  (`rm /opt/MEV/.deploy-live`). Refines the arch review verdict `arch-review-20260705-verdict.md`.

### D-002 | 2026-07-03 | ✅ | Auto-deploy IS in the §6b auto-close chain (do not re-litigate)
- **Decision:** the postmortem → auto-close → deploy chain may auto-deploy via `deploy-node.sh`.
- **Why:** the ~1-min restart gap is acceptable; events JSONL gets a new `run_id` per restart, so analysis
  is naturally segmented (analyze across the boundary). The live/dry guard lives in `deploy-node.sh`, so a
  cron trigger passes the SAME safety envelope as a human one.
- **Requirements (mandatory, not human-gating):** (1) mode-preservation verify after deploy (alert on a
  silent bounded-live→dry-run flip); (2) debounce/batch — the real cost is warm-pool cold-start, deploy at
  most once/window, never once-per-loss. [[feedback-auto-deploy-in-loop-approved]]

### D-003 | 2026-07-03 | ✅ | Bounded-live envelope authorized
- **Decision:** the searcher may broadcast autonomously ONLY inside the script-enforced envelope
  (`.deploy-live` marker + wallet ≤ `MEV_LIVE_MAX_WALLET_ETH` 0.2 ETH + `EV_GATE=1`). See Safety Rule 1.
- **Still hard human gates:** funding above the cap, raising the cap, real-funds key swap, any broadcast
  outside the envelope. [[project-bounded-live-active]] [[project-live-broadcast-authorized]]

### D-004 | 2026-07-04 | ✅ | MEV-Share (hash-only ingest) is always ON at intake
- **Decision:** `SEARCHER_ENABLE_HASH_ONLY=1` unconditionally in `deploy-node.sh` (was marker-gated).
- **Why:** MEV-Share is the primary flow (~72× mempool volume, ~90% of the built pipeline); R13–R21
  "coverage exhausted" was measured on ~1.4% of flow because this was off. Ingest+sim only — submission is
  separately gated (D-001). [[project-mevshare-flow-discarded]]

### D-007 | 2026-07-24 | ✅ | 批量 Multicall 不是 local-reth 的 <10s 杠杆（实测证伪，重定向到去串行化+dedup）
- **Finding:** 在 family 线实现中建了 `batched-multicall-transport.ts`（v2/v3 全池打进一个 aggregate3）。
  节点实测（block 25596722，对 local reth）：正确性 PASS（11 池 mid 逐位一致），但**延迟 0.5x——批量
  反而慢**：1 aggregate3（45 子调用）= 73.7ms vs 45 顺序 eth_call（Promise.all）= 38.6ms。
- **Why:** 批量省的是**网络往返**；local reth 零延迟，往返本来就没有，而 Multicall3 合约执行 + 大 payload
  编解码的固定开销反超并行小调用。批量是**远程 RPC** 优化，不是 local-reth 优化。
- **Decision / 重定向:** block-scan pass 读 local reth，<10s 的杠杆**不是** Multicall 聚合廉价 v2/v3 读
  （那些本就 ~40ms）。原 28.7s 两大头的真实成本与正确杠杆：
  1. **Curve 9.6s** = 两轮**串行** Multicall（pool-state-cache.ts:985 chunk 顺序 await）→ 去串行化（并行
     chunk + 合成一轮）；
  2. **protocol 11.6s** = ~1,879 个**逐边 eth_call quote** @ 并发 24 → **dedup 到唯一实例** + 提高并行 +
     可本地派生的本地派生。
  即 local-reth 的 N→1 收益来自 coordinator 的 (familyId, stateKey) **dedup + 并行 + 去串行化**，不是
  Multicall 聚合。批量 transport 保留为**远程-RPC 场景**工具，不作为 local-reth 主路径。
- **Meta:** 又一次"实测证伪假定的 fix"（HERMES rule 16）：计划里"批量 Multicall transport"被当成 <10s 本体，
  实测显示对 local reth 是负优化。任何人（含 Codex、未来的我）再提"把读打进一个 Multicall 提速"，先看这条 +
  自己在 local reth 上测一遍 batched vs parallel。证据：`test/batched-transport-parity.ts`，分支
  `fable/adapter-family-line`。

### D-008 | 2026-08-12 | ✅ | 活动型 Family 有意保持 append-only，不追求协议解析大全式完整性
- **Decision:** astra-multitoken、eigenpie、erc4626-silo-redeem、ethertoken-native-redeem、
  metronome-hgusdc、curve-underlying、dodo-v2 这 7 个仅以 observed-call/landed-log 为 discovery 证据的
  Family，**不开发 complete-snapshot bootstrap 语义**，按 MEV 范围有意保持 append-only /
  positive-only：第一次观察到 call/log 即准入，之后永不因"不在快照清单"被 tombstone。
- **Why:** 本窗口是 MEV searcher，不是协议解析大全。没被观察到、没交易过的池子不存在套利机会，
  在机会空间里本来就不存在——"没列入"不是 coverage bug，是范围。graph 是对**已成功解析**的活跃池的
  增量缓存；唯一需要 fail-closed 的失败类是协议解析失败（活跃池 decode/解析出错而漏进），该层已由
  fail-closed 解码 + `semantic-mismatch` gate 守护。
- **边界（不推翻宪法）：** complete-snapshot 的删除权（`complete-snapshot-omission`）仍只授予有穷尽
  证据的 13 个 Family（address-surface / factory-log）；活动证据**不得**冒充 complete-snapshot 行使
  删除权，否则会把"暂时安静、之后活跃"的池子误删——那是真实的 MEV 损失。mixed-mode 已实现该边界。
- **Implication:** `s1-remaining-gate-designs.md` 与 canonical 文档中"7 族仍需 bootstrap 语义"的
  blocker 表述撤回，改为既定设计；full-catalog complete-snapshot authority 按设计只覆盖 13 族。
- **Meta:** 用户明确反对把 observed-call/landed-log 族纳入完整性清单（"我是 MEV 又不是协议解析大全"）；
  此决定经对话确认后落库，任何人再提"给这 7 族补 bootstrap"先看本条。
- **Follow-up (2026-08-12):** 按用户提议新增 `observed-complete` publication 模式并合同级关闭：
  7 个活动型族可对"已观察集合"声明完整（publication 可达 shadow-complete），但**无 omission 删除权**；
  删除仍只走显式 terminal evidence，complete-snapshot-omission 只属于 13 个有穷尽证据的族。

### D-009 | 2026-08-12 | ✅ | S1 推进授权：Phase E 之前无需逐项确认
- **Decision:** 用户明确授权本窗口继续推进全部剩余 S1 项（live discovery→checkpoint
  inventory 接线、solver strict consumers 接线、systemic-live paired-live 运行、默认
  authority 切换），**Phase E legacy cleanup 之前不需要再逐项询问**；Phase E 开始前必须
  回来确认删除范围。
- **Scope:** 授权的是"推进路径"，不是解除安全机制：mainnet 广播/签名仍受 live-safety
  envelope（wallet ≤ `MEV_LIVE_MAX_WALLET_ETH`、`SEARCHER_EV_GATE=1`、script-enforced
  dry-run）约束；默认 authority 切换仍需 `evaluateS1CutoverReadiness` 全前置 ready
  （fail-closed 技术门不因授权豁免）；节点操作仍先 preflight（PID/runtime commit/锁/
  未提交改动）。
- **Meta:** 2026-08-12 用户原话："我全部授权 你执行到Phase E之前都不用问我"。此条是
  Rule 1 之外的一次性范围授权；任何超出 envelope 的广播/签名仍须新的明确 OK。

### D-010 | 2026-08-12 | ✅ | 串行 A/B 证据被接受为 adapter 架构不劣于 baseline 的依据
- **Decision:** 用户接受 600s 串行 dry-run A/B 作为证据：challenger
  `552c220e` vs baseline `4265971d` 在 priced 覆盖（87.61% vs 87.59%）、
  graph edges（36922 vs 36918）、head 吞吐（19 vs 15）、p95 timing
  （114.5s vs 134.7s）上均不劣于 baseline，判定"adapter 架构更优/无回退"，
  作为继续推进（solver 真实接线 → 默认 authority 评估 → Phase E）的依据。
- **Scope/边界:** 该接受**不豁免** systemic-live gate 的 fail-closed 语义：
  串行证据在 gate 内仍为 `relative_diagnostic_only`，cutover-readiness 不会
  虚报 ready；任何 production 行为变更（默认 authority、删除 legacy）仍
  先 script-enforced dry-run 验证，Phase E 删除范围仍需逐项确认。
- **Meta:** 用户原话："这个已经能说明我们adapter架构更优了……没有就可以进入到
  Phase E 了"。证据文件：`docs/research/design/evidence/s1-node-serial-dry-run-latest.json`
  与 `s1-node-serial-systemic-live-latest.json`。

### D-011 | 2026-08-12 | ✅ | 跳过默认 authority 切换验证，直接进入 Phase E（可回退）
- **Decision:** 用户决定不再做默认 authority 切换的额外验证，直接在当前 impl 分支
  执行 Phase E legacy cleanup；如后续部署/运行失败，回退到上一验收 commit/旧 runtime。
- **Scope/边界:** 本决定只作用于 impl 分支的源码删除；live 节点 `/opt/MEV` 在显式部署前
  仍运行旧 runtime（`SEARCHER_RUNTIME_COMMIT=269ade3c…`），不受分支删除影响；回退路径 =
  git revert + 重部署旧构建物（AGENTS.md §3 Rule 17：回滚依靠上一已验收构建物）。
  Phase E 每个删除 slice 保持合同测试 + 完整 build + sweep 全过，确保分支自身可用；
  若某 slice 无法保持绿，则该 slice 回退并如实记录。
- **Meta:** 用户原话："我觉得不用 dry run已经能说明问题 直接做 Phase E 不行的话可以回退"。
  此条覆盖 D-009 的"Phase E 前确认删除范围"（范围 = canonical §18.3/§20.2.6 列出的
  legacy 项，逐 slice 提交可见、可 revert）。

### D-012 | 2026-08-12 | ✅ | 剩余 P1 均不影响当前生产 → 先做 md，P1 实现推迟到 cutover 规划
- **Decision:** 按用户规则逐项评估剩余 P1：当前生产 authority 仍是 legacy 路径
  （live strict 只以 observed-complete 旁路运行、无 omission/删除权），因此以下 P1
  均不改变当前生产行为：
  - StateInstance mutation/terminal proof 接线：live 收缩发布目前 fail-closed
    （只增不减），不会悄悄丢实例；strict 尚未成为生产 authority，故无生产影响；
  - factory-log/landed-log/observed-call ingress：7 个活动型族 strict 侧暂无观测，
    legacy 仍完整覆盖，无生产影响；
  - continuous 调度 lane（producer reserve/deadline/去重/backlog）：strict 链在
    后台串行运行、错误隔离，不阻塞 searcher 主循环，无生产影响；
  - revm effect-delta/observe/funded-override/verified-actor：erc4626 等在 strict
    catalogRoot 缺位，legacy 仍负责这些族，无生产影响；
  - legacy fallback 收口：属于 cutover 动作，需默认 authority 切换时另行授权。
  结论：本轮直接做 canonical/plan md 收口（D-012 前已完成 P0-5/P0-6/P1-a/P1-f/P1-d
  合同与机器证据）；上述 P1 实现推迟到 cutover 规划，届时作为 production authority
  前置条件逐项立项。
- **Cutover 前置（P1 实现清单，未来立项时按此核对）：** mutation/terminal proof
  issuer；严格观测 ingress；continuous 调度与崩溃恢复；revm effect-delta 能力；
  真实 sealed-production corpus；legacy 删除逐项确认。
- **Meta:** 用户原话："p1不影响生产就直接做md 如果影响生产不用管顺序做就完了"。

### D-006 | 2026-07-23 | ✅ | Family 解耦不需要跨 family victim 传播（"P0" 撤销，四刀盖棺）
- **Question:** family 架构下（每 family 独立 `deriveMids`），backrun lane 的 victim swap 是否需要向
  依赖同一底层状态的其他 family（如读 Curve 状态的 vault）做"跨 family 二阶传播"，否则粗扫漏枚举？
  （Fable 起初判 P0；用户四轮反驳后撤销。）
- **Decision:** 不需要。不建传播机制；`dependencies()` 维持"失效提示"定位不升格；不阻塞 family 线。
- **Why（四条独立论据，任一即可杀）:**
  1. **闭环经济学**：惰性/独立更新的 vault 汇率不因 victim 当块变化 → 无原子错位可闭环；追它 = 赌未来
     收敛 = 方向性敞口，明确越界（CLAUDE.md §3 位置守恒闭环）。
  2. **每块真值自洽**：所有 family 每块读真实当块状态 → 粗图在 N 天然自洽，standing 价差直接可见；
     victim 制造的机会**锚定在被砸的 swap 池自己那条边上**（victim-patched），读现货的 wrapper 只是同一
     错位的冗余路径，不是独立机会。
  3. **实测空集**：8/8 protocol-conversion 家族的 quote 全读协议内部汇率（convertToAssets/getPooledEth/
     tin-tout/getMLRTAmountToMint…），读 swap 现货（getReserves/slot0/get_dy）命中 0/8（grep 实测）。
  4. **生态自选择 + 已有正确框架**：天真读现货 = 可被闪电贷操纵 = 活不长；幸存协议故意用 TWAP/延迟/
     oracle（防操纵是设计目的），单笔 victim 冲击被衰减到噪音。依赖型汇率真跳变时走的是**自己的链上
     交易**（oracle update/report）= 一等 victim 触发器 —— 即 coffee Chainlink→Metronome 类
     （[[project-coffee-oracle-backrun-victim-gap]]，rate-venue victim 类已建），不是静默图传播。
- **唯一守卫（将来才用）:** 若新增家族声明的 quote 实时读 swap 池现货，conformance 报警并要求显式
  `spotDependent` 声明——"若出现才处理"，不预建。
- **Meta:** 该结论由用户的领域反驳驱动（闭环经济学 > 架构模式直觉）；Fable 初判把"解耦模式的抽象风险"
  当成了实际 gap，未先过经济学与汇率来源实测——先扫 0/8 再下结论才是对的顺序。

### D-005 | 2026-07-17 | ✅ | Declared-venue hardcode posture: pin the root, attest the pair, never derive at admission
- **Decision:** singleton venue addresses stay pinned in `declaredVenues` (identity root, §2
  infrastructure-singleton carve-out); declared token pairs are demoted to **attested expectations** —
  `buildEdges` eth_calls the venue's own interface before any edge exists (wsteth `stETH()`, psm
  `gem()/dai()`, erc4626 standard branch `asset()==fixedTokenIn`, hgusdc `HGUSDC.asset()==tokenOut`);
  goldx/rocksolid expose no token view → liveness attest only (`unit()`/`convertToShares()`), pair stays
  code-owned behind the final sim. Attestation failure = that pool's edge build fails closed with
  per-pool logging (capped 5 + overflow count) on boot (backrun+blockscan) and on refresh; because
  swap-event discovery can never re-surface a protocol singleton, the refresh timer explicitly retries
  registry venues absent from `knownPoolKeys` until they admit — a transient boot RPC error therefore
  costs at most one refresh interval, not the process lifetime (adversarial-review finding, fixed same
  round). Commits `106d1b5`/`0ec553a` + retry fix; conformance `route-adapters` 15/15,
  `runtime-pool-refresh` 6/6.
- **Validation state (honest):** `implemented`, NOT `fixed` (gates.md): no attest selector has executed
  against the real contracts yet (env network policy). Settling evidence before any `fixed` claim:
  `npm run searcher:audit-erc4626` (checks exactly `asset()==fixedTokenIn` per vault) + one fork/node
  boot showing all six declared venues admit. Cast-verified provenance exists in-repo only for
  sUSDS/wstUSR/sfrxETH/scrvUSD/srUSDe; the remaining vault pins rest on the probe's liveness note, and
  LitePSM `gem()`/`dai()` + `HGUSDC.asset()` rest on published-source knowledge only.
- **Why attest, not derive:** attest is fail-closed, derive is open-ended (a venue upgrade returning an
  unexpected address would silently build an edge to a foreign token); pair constants are woven through
  the quote/plan layer (`quotePreparedPSM` scaling, `quoteGoldxMint` guard, `psm.buildPlanFragment`
  direction), so deriving only at build time is a fake removal. The attestation is **boot+retry-scoped
  drift protection, not a standing guarantee**: post-boot drift (e.g. a proxy upgrade behind a pinned
  venue) is caught by neither this check nor a hypothetical tx-time read unless re-attested on a cadence;
  the standing backstop is the final sim, and per-tx reads buy only drift-since-boot at CU cost.
  Trace-extracted in/out is behavior evidence, used for detection/nomination only (observation side,
  Slice E quarantine), never admission — behavior is spoofable (honeypot flows). Admission evidence
  chain stays: pin identity root → interface attest → final sim. Full derivation for singletons =
  Slice C `enumerateRoutes` shape; revisit only after the erc4626 family pipeline is proven. See the
  discovery plan §0 for the three-state hardcode taxonomy. Known standing bypass (pre-existing, unused
  in production): `defaultTokenGraph()` still hardcodes an unattested PSM edge as a planner fallback.

---

## Facts (verified project state)

### F-001 | 2026-07-05 | ✅ | Primary distance-to-production lever = flow-admission at the submit gate
- **Fact:** with MEV-Share intake ON, the dominant self-drop is `submit_gate/hash_only_unmatchable`
  (95.3% of drops, gated by the D-001 flag), not coverage/`no_candidate`. Runner-up = economics
  (`bribeAllAboveGas ⇒ computeBidEth = max(profit−gas,0) ⇒ net≈0`). [[project-mevshare-submit-flag-lever]]
- **Evidence:** arch review `docs/research/reports/arch-review-20260705-verdict.md`; funnel `file:line` in
  `listener/src/searcher/main.ts` (submit gate `:222`/`:1868`; flag `:435`; EV gate `:1963`).

### F-002 | 2026-07-03 | ✅ | Native-ETH v4 pool gap `0xa32b646c` — CLOSED as a pool gap
- **Fact:** bundle `0xa32b646c…8b2f68` (block 25449741) lost `route_gap_decisive`; winner `0x28390df4…`
  backran the same triggering swap via WETH→CFG (v3 `0x08a10a8b…FCBF`) then CFG→WETH on a **native-ETH v4
  pool `0x267d01a3…9348cd9c`** (on-chain `Initialize`: currency0=`0x0`, currency1=CFG, fee=10001,
  tickSpacing=200, hooks=0x0). Our v3-only 3-hop detour saw ~43% of the value; winner's builder payment
  (~97% of its gross) alone exceeded our FULL sim gross ⇒ coverage, not bids.
- **Close:** commits `8acee06`/`b06717c`/`574d5e4` — reusable `v4-backfill-poolid` verb, force-include
  extended to v4 poolIds (was address-only), committed `force-include-poolids.json` survives deploy.
  Rule-12 flip `pool_in_routing_graph false→true, candidate_plans 0→1`. Native-ETH v4 execution is NOT a
  blocker (epic slice-2b-ii, `c817cc2`). [[project-buildernet-auction-loss-anatomy]] [[project-competitor-native-eth-profit]]

### F-003 | 2026-07-04 | ✅ | Atomic backrun = dust market ceiling *on public flow* (posture-qualified)
- **Fact:** coffeebabe (our exact class) captures dust on public flow (~$0.64/tx; the per-tx
  `realized_profit_usd` is a valuation artifact — builder-payment is the robust floor). For OUR posture the
  ~1/5h ceiling is a MARKET limit, not a capability limit. **Qualified:** this was measured on public
  mempool ≈ 1.4% of flow — the real question is MEV-Share (D-001/D-004), not more atomic-backrun coverage.
  [[project-atomic-backrun-market-ceiling]] [[project-coffeebabe-census-notseen-bridge]]

### F-004 | 2026-07-04 | ⏳ | Mempool router-allowlist is a flow-admission blind spot
- **Fact:** the filtered mempool admits `tx.to` in ~10–14 hardcoded routers OR a tracked pool
  (`main.ts:206`) → public swaps via custom routers are invisible pre-funnel (found: coffee's 1 public
  victim we missed, `to` `0x663dc15d`). Fixable searcher-side (admit by pool-touch), distinct from the
  economics gate. [[project-mempool-router-allowlist-blindspot]] [[project-mempool-filter-flow-admission-gap]]

### F-005 | 2026-07-04 | ✅ | topN=0 pool-universe bug + dominant `no_candidate` root cause
- **Fact:** `SEARCHER_POOL_UNIVERSE_TOP_N` default "0" + `?? Infinity` → `slice(0,0)` → the curated
  active-pools universe never loads → runtime graph misses return venues. Verify `universe=N` in the
  startup banner after every deploy. The dominant see→bundle blocker had been `no_candidate_plans` (94% =
  `only_immediate_same_pool_reverse`, a token-graph return-venue coverage gap). [[project-pool-universe-topn-zero-bug]] [[project-nocandidate-return-venue-gap]]

---

### F-006 | 2026-07-05 | ✅ | MEV-Share `mev_sendBundle` 100% relay-rejected "backrun not found" = a POSTURE gate (not timing)
- **Fact:** with D-001's flag ON, 100% of `mev_sendBundle` submissions to `flashbots-mev-share` return
  `http=200 {"code":-32000,"message":"backrun not found"}` → `accepted:false`. The submit path works; the
  relay won't match the referenced hint. Log: `/var/log/mev-live.log` (`[submitter] flashbots-mev-share
  http=200 …backrun not found`).
- **Implication:** the arch review's "flag ON ⇒ inclusion via submitMevShareBundle" was over-optimistic —
  the flag is necessary but NOT sufficient. [[project-mevshare-submit-flag-lever]]
- **CAUSE — corrected 2026-07-05 (dual-blind: fable diagnosis agent + a concurrent orchestrator, converged;
  supersedes my first "timing/target-block" read):** the reject is **STRUCTURAL / POSTURE, not timing and
  not a code bug.** Ruled out mechanically: target-block is NOT drifting (`main.ts:1988` target=latest+1;
  0/12 submit-block > hint-block); the `{hash}` reference is spec-correct (http=200 *semantic* error, not
  parse/400); and **latency is inert — 102ms and 131ms hint→submit BOTH still got "backrun not found"** (a
  race would let a 100ms submit win). Decisive: **19/20 referenced victim txs NEVER land on-chain** (local
  reth NOTFOUND; phantom), 1/20 mined ~10min *before* the hint (the only genuine stale-timing case). ⇒ the
  relay does not hold these as backrun-matchable pending orders at reference time; our plain-searcher posture
  (reconstruct-from-SSE-logs → `mev_sendBundle{hash}`) is **not offered open backrun for this flow.**
  Corroborates [[project-phantom-victim-flow-admission-epic]] (~82% phantom) + [[project-atomic-backrun-market-ceiling]].
- **Fix direction:** NOT latency / targetBlock / maxBlock (all proven inert). Real capture = a posture /
  eligible-orderflow relationship = **STRATEGY / human gate**, not a code edit. Near-term inclusion instead
  via mempool (has landed before) or protocol/credit-leg coverage to raise +EV opportunity density. Options
  on the flag itself (operator's call): revert to 0 (0/20 convert — stop wasting submit+EV-gate cycles), or
  keep (harmless; a rejected `mev_sendBundle` never broadcasts).

### F-007 | 2026-07-06 | ✅ | Two distinct protocol classes: DEX-NAV = dust; CREDIT (Fluid/Morpho) = episodic $100s, credit-live-gated
> **CORRECTED 2026-07-06 (operator caught the overreach with `0xf88b`).** The first draft said "protocol
> block-scan is dust-bounded" — WRONG generalization. It measured only the credit-EXCLUDED DEX-NAV subset in a
> QUIET (peg) window. Two classes must be kept separate:
- **Class 1 — DEX-NAV protocol (what BS-1c scans): smoke-test-dust, but UNMEASURED — NOT "don't build".**
  Shipped **BS-1c** (`0a1984c`, scanner detects+prices non-standing `slotKind:"protocol"` edges) +
  **`searcher:blockscan-hunt`** (`f48c371`). Fork-solved over the LIVE graph at 4 recent blocks AND at the
  `0xf88b` depeg block (24710788, archive fork): **ZERO +EV protocol ring, only sub-dollar pure-DEX dust**
  (best ~$0.50 even AT the depeg block). Of 11 protocol entries only wstETH/sUSDS have a DEX share-venue, both
  NAV-pegged/par.
  > **SAMPLE-SIZE CORRECTION (2026-07-06, operator caught it):** 4 recent + 1 depeg = a **~5-block smoke
  > test** — this proves BS-1c WORKS but does NOT measure the class's EV. Concluding "DEX-NAV = dust, don't
  > build" from 5 blocks is the **starved-sample true-negative trap** (project rule: never conclude a
  > true-negative from a starved sample; size OUTCOME-DRIVEN). Dislocations are EPISODIC. **Verdict downgraded
  > to UNMEASURED/not-yet-decidable.** To decide DEX-NAV: run `blockscan-hunt` over an outcome-driven window
  > (hours, ideally event-targeted across multiple depeg/volatility blocks + more of the 11 entries' share
  > venues), not 5 consecutive quiet blocks. Only the CREDIT class (Class 2) is evidence-backed so far.
- **Class 2 — CREDIT (Fluid/Morpho): episodic $100–500, NOT dust.** `0xf88b498b…` (block 24710788, from =
  coffeebabe) nets **~273 wstUSR + 0.078 WETH (~$100–500)** during a wstUSR **market depeg**, via
  `flash→Fluid borrow→swap→repay` (a BACKRUN). It routes through wstUSR+sUSDS+PSM+Fluid+curve+v4 in ONE atomic
  loop. **This is credit-ESSENTIAL** (the profit rides Fluid leverage + the market dislocation), so the BS-1c
  scanner CANNOT see it (it excludes credit/standing edges by design, `blockscan-scanner.ts:247`) — which is
  why even the depeg-block hunt found only DEX dust. The vault NAV (`previewRedeem`) is stable across the
  depeg; the dislocation is in the leveraged market position, not the DEX pools.
- **Capability EXISTS; the gate is POSTURE.** `test/WstUSRArb.t.sol` (AC-3, landed) reconstructs the ~273
  wstUSR profit on a fork. The Fluid credit edge is grandfathered live in the backrun graph (D4) and the solver
  sizes it (`fluidDebtBps` search, `solver.ts:96-187`). So capturing the `0xf88b` class is largely a
  **`.credit-live` human-gate + depeg-timing** problem, NOT a capability gap. CR-5 (deterministic Fluid quote)
  is an auction-precision upgrade over the grid search, not a blocker.
- **Corrected implication:** the needle-mover is STILL a **posture decision**, but the reward is REAL
  ($100–500/depeg), not dust — which makes the `.credit-live` decision MORE worth taking to the operator, not
  less. Capture-path order: (1) `.credit-live` posture [human] → (2) backrun already routes+sizes the Fluid
  loop, so it captures the proven exemplar first; (3) CR-5 for auction precision; (4) **BS-3 with credit
  UN-EXCLUDED** (relax `blockscan-scanner.ts:247` + wire `fluidDebtBps` sizing into block-scan) to catch the
  standing depeg dislocation proactively every block instead of waiting for a victim swap. BS-3-as-built
  (credit-excluded) only ever sees dust — that was a scanner SCOPE limit, not a market fact.
  tooling_defect (return-path check) stands.
  Full record: `docs/analysis/20260706-protocol-edge-return-venue-gap.md`.
  > **CLASSIFICATION CORRECTION (2026-07-06, operator + event-level verify): `0x9be73297` is PROTOCOL, NOT
  > credit.** Its 4 Morpho Blue events decode to `Supply` + `Withdraw` + 2×`AccrueInterest` (topic0s verified
  > by keccak) — the MetaMorpho VAULT's own internal supply/withdraw when we deposit/redeem steakUSDC/USDT.
  > **ZERO Borrow / Repay / SupplyCollateral** = we took no credit position. So the steakUSDC+steakUSDT
  > ($2.23) and waEthUSDC ($2.44) txs are **ERC4626-vault PROTOCOL arbs, not credit** (the earlier "vault
  > loops close via Morpho CREDIT ~$1" was a mis-read of the vault's internal Supply as our borrow).
  > TWO consequences: (a) these are **>$1 PROTOCOL txs** — direct evidence the DEX-NAV/protocol class is NOT
  > uniformly dust (reinforces the Class-1 sample-size downgrade above); (b) the ONLY remaining credit
  > exemplar is `0xf88b498b…970` (Fluid), and it too must be event-verified for a real `Fluid borrow` before
  > "credit = $100–500" is trusted (Fluid vaults ARE borrow-based + AC-3 reconstructs a leveraged position,
  > so it is likely genuine — but verify, don't inherit the Morpho error).
  [[project-track-a-b-protocol-edges]] [[project-atomic-backrun-market-ceiling]]

### F-008 | 2026-07-06 | ✅ | Our block-scan scanner CANNOT reach coffee's protocol arbs (verified at the exact arb block)
- **Setup:** BS-lane Pass A/B1/B1b landed the live block-scan lane (log-only, isolated stack, full-warm) and
  **B1b** (`1d0c724`) wired live `protocolMids` so the scanner can price protocol edges. To avoid concluding
  from a starved/protocol-blind window, ran the `protocolMids`-enabled `blockscan-hunt` at **block 24568129 —
  the EXACT block of `0x9be73297`** (coffee's steakUSDC/steakUSDT PROTOCOL arb, $2.23, archive fork).
- **Result (decisive):** 24 opportunities, **ZERO protocol rings** (all `protocol=false`, pure-DEX dust, best
  net ~$0.0035). At the exact block where coffee netted $2.23 via a protocol/vault loop, **our scanner surfaces
  no protocol ring at all.**
- **Why (detection-MODEL gap, not a protocolMids gap):** (1) steakUSDC/steakUSDT/waEthUSDC vault shares have
  **no DEX venue** in our universe → no DEX-mid to spread against the vault NAV → our spread-cycle scanner
  cannot form the ring. (2) coffee's mechanism is a **multi-protocol COMPOSITION** (Balancer-flash → Morpho
  Blue supply/withdraw → MetaMorpho vault deposit/redeem → UniV3 swaps → WETH), NOT a DEX-mid-spread cycle —
  a different SHAPE our scanner does not model.
- **Net picture (after 3 corrections — this is the settled one):** protocol is NOT dust (coffee $2.23/$2.44 is
  real), BUT **our block-scan scanner structurally cannot reach coffee's protocol wins.** Its reachable protocol
  set = only vaults whose share has a DEX venue = **wstETH/sUSDS NAV rings**, and only when they dislocate
  (pegged/rare). Capturing coffee's steakUSDC-class protocol arbs needs a **composition-arb** detect+execute
  capability (model flash→Morpho→vault→swap), a much larger build than the spread-cycle scanner.
- **Implication:** a multi-hour live block-scan window will NOT surface coffee's protocol arbs — the lane is
  blind to that shape, not merely waiting for a dislocation. B1b + the live lane are correct + isolated + safe
  (log-only, zero loss); the limit is the detection model. [[project-track-a-b-protocol-edges]]
- **CORRECTED again (2026-07-06, full amount-trace of `0x9be73297`) — it IS a routable closed loop; the
  block is a STUBBED adapter, not a modeling limit.** Executor `0xe08d97` net = **+0.0016 WETH (~$2-3)**. Flow:
  Balancer flash 326,058.65 USDC → **Fluid DEX swap USDC→USDT (326,058.65→326,061.67, +0.9bp — THE profit
  leg)** → USDT →(steakUSDT deposit → Morpho Blue → steakUSDC redeem, ~1:1 par close)→ USDC → repay flash;
  surplus 3.02 USDC → 0.0016 WETH. The profit VENUE `0x52aa89` = **FluidLiquidityProxy (Fluid/Instadapp DEX)**.
  We HAVE a `fluid-dex-swap` adapter but it is a **STUB**: `fluid-dex.ts:52` `encode()` throws
  "not supported in v3.0: dexCallback has no bytes payload" (Fluid's `swapInWithCallback` 0xbe17c79c callback
  can't carry BotVM's inner script). **So `0x9be73297` is routable as legs (vindicates the leg-based D5
  design — the SAME buildTokenPaths routes it); the only block is the un-implemented Fluid DEX swap adapter.**
  FIX (scoped, no executor change): implement `fluidDexSwapAdapter` via the plain non-callback
  `swapIn(bool swap0to1,uint256 amountIn,uint256 amountOutMin,address to)` (approve+call, curve-pattern) +
  a FluidDexResolver quote + register the Fluid Dex USDC/USDT pool; VERIFY vs `0x9be73297`. This is the real,
  bounded "adapt an unknown/stubbed venue" work — a curve-sized adapter, not a new detection model. (F-008's
  earlier "needs a new composition model" was wrong.)
- **DONE + VERIFIED (2026-07-06, commit `1c4b947`):** `fluidDexSwapAdapter` implemented via plain
  `swapIn(bool,uint256,uint256,address)` (selector `0x2668dfaa`, approve+call, no executor change) +
  a FluidDexResolver/revert-estimate quote + plan-builder approve + `poolToken0/poolToken1` threaded
  through the quote plumbing + the Fluid DexT1 **USDC/USDT pool `0x667701e5`** registered as a swap edge.
  Gate `searcher:fluid-dex-verify` **reproduces `0x9be73297`'s swap exactly** (326,058.65 USDC →
  326,061.67 USDT, diff 4288 wei; block 24568129 archive fork-after-prev-tx); planner/replay/taxonomy/
  scanner/coordinator all additive-unchanged. Evaluator fix: Codex first picked the wrong Fluid pool
  (0xea734B6, off ~2bp); the real swapIn target `0x667701e5` was pinned from the callTracer trace.
  **The Fluid DEX leg now routes through the SAME buildTokenPaths as any swap — coffee's Fluid arb class
  is unblocked in the graph.** Not yet deployed to the node (a swap adapter is principal-safe + within the
  bounded-live envelope; the deploy is an operator restart).

### F-009 | 2026-07-06 | ✅ | `0x9be73297`'s vault middle leg = INVENTORY rebalance, NOT a replicable protocol/credit edge
- **Operator ruling (correct — corrects my overclaim):** do NOT read "funds pass through Morpho" as "add a
  Morpho steakUSDT→steakUSDC edge". A cross-vault return path is only a `protocol` leg if it proves 3 things:
  (1) externally callable with NO inventory, (2) a deterministic input→output leg, (3) does NOT depend on
  vault internal state / bot pre-holdings. Classify by trace/replay BEFORE writing any edge.
- **Classification (decided on-chain, block 24568128→24568129):** the "~1:1 USDT→USDC" middle leg is an
  **inventory rebalance through the operator's PRIVATE vault-wrapper contracts**, verdict
  **`inventory_or_internal_only_not_ours`**:
  - Profit-key numbers (operator's Q): bundler `0xb82809` (a private GenericVault w/ Manager+Controller, NOT
    public Morpho infra) minted **+293,404 steakUSDT** (held ~0 before, keeps it after); mediator `0x4825ef`
    **−291,368 steakUSDC** drawn from a **pre-existing 2,751,718 steakUSDC inventory** (~$2.9M), ending at
    2,460,350. NET position change, NOT atomic net-zero.
  - The share-count asymmetry (293,404 vs 291,368) = the two vaults' different NAV/price-per-share; part of
    the profit is embedded in a favorable cross-vault inventory rebalance, ON TOP of the Fluid swap +0.9bp.
  - Fails all 3 criteria: needs ~$2.9M steakUSDC inventory (not inventory-free), depends on vault internal
    state, requires pre-holdings. ⇒ it is an **inventory/posture play (credit-live-adjacent capital
    commitment), not our flash-arb path** — same class as [[project-cex-dex-inventory-competitor-noise]].
- **Consequence:** the Fluid DEX SWAP leg is real + done (F-008); coffee's SPECIFIC steakUSDC arb is NOT
  replicable as a leg. Open (worth checking, cheap): is there a permissionless ≤0.9bp-loss par USDT↔USDC
  return path (curve/PSM) that lets us capture the Fluid dislocation inventory-free? [[project-track-a-b-protocol-edges]]

### F-010 | 2026-07-06 | ✅ | `0x15352456` (coffee, blk 25472647) = private RFQ fill — non-comparable, structurally invisible
- **Operator Q:** did our live see this opportunity / why did we lose? **A: could not see it — both legs private.**
- **Mechanics (local reth + Alchemy secondary):** Balancer flash-loan 0.0526 WETH → fill a SIGNED off-chain
  order (target `0x0b7250…9188`, sel `0x69384be8`, 3 ECDSA sigs, deadline = block_ts+29s ⇒ live ~30s RFQ
  quote) at ~1771.6 USDT/WETH → buy back on in-graph univ3 WETH/USDT 0.01% `0xc7bbec…` at ~1761.3 → net
  **$0.49** (tx-profit: $0.54 realized − $0.05 builder) = coffee dust ceiling.
- **Visibility (events run 5abbb905, live):** 60 events at that target block, none touching the pool/pair;
  the in-block price-mover (idx 79 `0x8aa5812e…`) had prio=0 (builder-integrated private flow), 0 hits in
  our feeds. Pool in-graph (census `distinct_out_of_graph`=0) ⇒ NOT pool/path/latency/admission.
- **Ruling:** `winner_style: rfq_fill` joins `one_leg_inventory` as a **non-comparable winner class** —
  filter it in postmortems; spend zero route/latency budget on it. Only lever = orderflow relationships
  (F-006/D-001, human). Even BS-3 block-scan can't price a private maker quote (not an indexed venue).
  Tooling: `tooldef-20260706-census-single-tx-ingraph-detail` filed (census hides in-graph-only per-tx
  detail; no single-competitor-tx mode). Full trace: `docs/analysis/20260706-coffee-rfq-fill-postmortem.md`.
  [[project-cex-dex-inventory-competitor-noise]]

### F-011 | 2026-07-06 | ✅ | `0xcfacdd69` (coffee, blk 25472884) = Curve FeeCollector keeper claim — NOT an arbitrage
- **Operator Q:** did our live see it / why did we lose? **A: category error — nothing to see; it's keeper work.**
- **Mechanics (local reth + selector DB + Curve docs):** `withdraw_many([3 pools])` + `collect([USDC], coffee)`
  on Curve FeeCollector `0xa2bc…cce00` sweeps $28.95 accrued admin fees → **$28.70 to the CoWSwapBurner**
  (`0xc0fc3ddf…`), **$0.25 caller incentive to coffee** (net $0.22 tx-profit), converted via one Fluid swap.
  USDC conserved exactly; PYUSD/USDe remain in the collector.
- **Bounty market sized (24h of logs):** $18.5k/day swept to the burner; **~$17/day TOTAL caller bounties
  split across ≥5 competing keeper bots** (coffee 8×/$2.02). Not a strategy class for us at any effort.
- **Ruling:** `winner_style: keeper_claim` = third non-comparable class (after `one_leg_inventory`, F-010
  `rfq_fill`). Reflex: check the winner's FLOW SHAPE (value conserved into a fixed sink + small caller cut)
  BEFORE any gap analysis. Census single-tx display gap recurred (already filed
  `tooldef-20260706-census-single-tx-ingraph-detail`). Full trace:
  `docs/analysis/20260706-coffee-keeper-claim-postmortem.md`. [[project-cex-dex-inventory-competitor-noise]]

### F-012 | 2026-07-07 | ✅ | `0xf698e6c2` (coffee, blk 25476156) = STBT RWA atomic loop — venue gap DELIBERATELY not closed
- **What:** standing-dislocation 4-leg loop (no backrun): flash 0.0403 WETH → v3 DAI/WETH (in-graph) → 3pool
  add_liquidity → 3CRV (in-graph) → STBT/3CRV metapool `0x892d701d` (NOT in graph) → STBT→ETH at exotic venue
  `0x7d002303` (NOT in graph) → net **$0.51** (tx-profit). STBT = Matrixdock T-bill RWA, KYC-whitelisted,
  rebasing; **coffee never holds STBT** — the whitelisted router `0x45312ea0` does.
- **Why not close:** class measured at **~2 trades/$1 per DAY** (24h venue logs); replicability hinges on the
  router being permissionless = F-009 3-point leg test UNPROVEN; exit venue needs a new adapter for an
  unidentified ABI. Dust × access-unproven × adapter cost ⇒ log it, don't build. Re-open ONLY if the class
  frequency changes an order of magnitude or the router is proven open.
- **Tooling divergence (rule 16):** census-report said `route_gap_decisive=false` — its out_of_graph counts
  univ2/3/4 ONLY; curve/exotic venue gaps invisible → extended `tooldef-20260706-census-single-tx-ingraph-detail`.
  Full trace: `docs/analysis/20260707-coffee-stbt-rwa-loop-postmortem.md`.

### F-013 | 2026-07-07 | ✅ | `0xf391d0` (coffee, blk 25462190) = clean ATOMIC protocol arb — backrun-closeable behind ONE bounded adapter (srUSDe→sUSDe)
- **What (opposite of F-009):** verified ATOMIC via share net mint/burn — srUSDe net **−934.46 (pure burn)**,
  sUSDe net **0** (flows in and fully out), NO residual inventory in any helper. Reconciled with canonical
  `tx-profit.ts`: net **+$5.69** (WETH only), `unpricedDeltas:[]`. This is the positive case Agent B's
  atomicity classifier separates from `0x9be73297`'s inventory rebalance.
- **Loop:** Balancer flash USDC → UniV4 USDC/srUSDe `0xc069abea` → **srUSDe redeem → sUSDe** → UniV3
  sUSDe/USDT `0x7eb59` → UniV4 USDT/USDC `0x395f91b3` → surplus → UniV3 USDC/WETH → repay. All legs covered
  EXCEPT the srUSDe redeem + the sUSDe node + the `0xc069abea` pool surviving graph build.
- **Blocker 1 — the ONE real gap (bounded, replicable):** srUSDe (`0x3d7d6fdf`) is a **non-standard ERC4626**:
  `asset()`=USDe but redeem **pays sUSDe** via a silo (previewRedeem lies — says 958.15 USDe, actual pay
  773.99 sUSDe). Our generic `erc4626-redeem` models share→USDe with previewRedeem qty ⇒ wrong on BOTH token
  and amount ⇒ deliberately excluded (`token-graph.ts:147` `nonStandardRedeem:true`). Fix = a dedicated
  **srUSDe→sUSDe** redeem edge that quotes in sUSDe + register **sUSDe (`0x9d39a5de`)** as a graph node + let
  `0xc069abea` survive graph construction. srUSDe/sUSDe are permissionless (Ethena/Strata) ⇒ passes F-009's
  3-point replicability test ⇒ **verdict `protocol_cross_vault_replicable`** — this one justifies building the leg.
- **Blocker 2 — scanner still blind (F-008, structural):** even with the edge, this is a multi-hop composition
  (USDC→srUSDe→sUSDe→USDT→USDC), NOT a same-pair two-venue spread — the block-scan spread-cycle scanner cannot
  compose it (hunt @25462190: 16 opps, 0 srUSDe rings, `c069abea_v4pool_loaded:false`). The **backrun planner
  (`buildTokenPaths`) CAN** compose it once the edge exists. So protocol-leg-closes-a-loop-like-backrun is
  TRUE via the planner; the scanner limit is separate and known (F-008).
- **Next (bounded, gated):** build the srUSDe→sUSDe non-standard-redeem adapter + sUSDe node → then a planner
  fork-solve @25462190 must produce the loop (rule-12 replay flip), NOT just build-passing. Operator decision
  before building.
- **Design round 2026-07-07 (8-agent ground → dual-prior proposals → judge → red-team; full doc
  `docs/analysis/20260707-srusde-silo-redeem-edge-design.md`):** byte-exact quote =
  `sUSDe.previewWithdraw(srUSDe.previewRedeem(shares))` — diff **0** vs the receipt at execution state
  (callTracer: the silo itself staticcalls previewWithdraw; the earlier convertToShares hypothesis is the
  floor dual, 1 wei low). Execution = srUSDe's **multi-token exact-in `redeem(address,uint256,address,address)`
  = `0xfea53be1`** (live-verified via eth_call from a real holder; competitor used the exact-out twin
  `0xdfcd412e`; standard `0xba087652` is NOT the silo path). Two F-013 assumptions corrected by ground:
  sUSDe needs NO node registration (graph nodes are implicit from edge endpoints) and c069abea admission =
  a `pinned-warm-pools.json` entry (must include fixedTokenIn/fixedTokenOut or token-graph hard-throws →
  silently skipped). Verdict: **design_holds_with_amendments** — `erc4626-redeem-silo` descriptor
  (~8-line tokenOutArg extension) + registry `redeemTokenOut` field, fail-closed prune retained; 3 red-team
  amendments folded into the gate (evm_setNextBlockTimestamp pin for wei-exact receipt-diff — vaults accrue
  per-second; full pool-pin fields; negative emission asserts: srUSDe exactly ONE edge, flagged-without-payout
  vaults still ZERO).
- **BUILT + GATED 2026-07-07 (commit d2e73ba):** `erc4626-redeem-silo` descriptor (tokenOutArg extension) +
  `quoteSiloRedeem` (two-contract quote) + `redeemTokenOut` registry field + block-scan/hunt mid wiring +
  unit pins (protocol-legs, erc4626-quote two-call). Gate `searcher:blockscan-fork-solve-f391` @25462190
  **PASS 8/8**: real emission (srUSDe → exactly 1 silo edge, no deposit; flagged-without-payout → 0,
  fail-closed) + **silo quote diff=0** on the pre-competitor fork (timestamp-pinned — the sUSDe/srUSDe
  per-second vesting drift the red-team flagged was real: unpinned = +1.9e16) + planner composes the 4-leg
  ring through the silo leg. Silo edge is PROVEN. **Correction to Blocker 2 wording:** the design-round
  claim "c069abea admission = pinned-warm-pools entry" was necessary but NOT sufficient — see F-014.
- **F-013 verdict refined:** "backrun-closeable" is TRUE for the silo LEG (built + proven) but the FULL loop
  is **NOT yet reproducible +EV** — blocked on F-014 (a v4-quoter entry-leg gap), NOT the srUSDe edge.

### F-014 | 2026-07-07 | ⚠️ RE-OPENED (tool-reconciled) | `0xc069abea` leg is USDC→srUSDe, but the srUSDe is MINTED not pool-swapped; tx86 flags `inventory_vault_rebalance`
- **What:** at 0xf391d0's execution state (fork post-txIndex-85, and the clean archive at blk 25462189), our
  V4Quoter (`0x52F0E24D…`) reverts `NotEnoughLiquidity(0xc069abea…)` (`0x6190b2b0`/`7a5ed734`) for
  **USDC→srUSDe at every size incl. 1 USDC**, while the **reverse** srUSDe→USDC quotes fine (1 srUSDe →
  1.0159 USDC) and the competitor's **real** swap filled **949.488853 USDC → 934.46 srUSDe** at that exact
  state. No JIT: the competitor tx has only a Swap on this pool (no ModifyLiquidity), slot0 tick = −276166
  and pool `liquidity` = 1.238e19 unchanged pre/post block. So the quoter's tick-traversal DIVERGES from the
  real core swap for this pool's (one-sided) liquidity — the same class as the known v4-quoting gaps
  ([[project-v4-swaphook-admission-gap]], [[project-univ4-coverage-frontier]]), here on a HOOKLESS pool.
- **Impact:** the srUSDe silo edge (F-013) is correct and composes the ring, but the loop's ENTRY leg can't be
  quoted/sized by our solver ⇒ no +EV solve ⇒ 0xf391d0 not yet capturable end-to-end. The f391 gate documents
  this as a deferred, separate block (still PASSes on the silo-edge flip).
- **RE-CORRECTION (2026-07-07, anchored to the canonical tool — my two prior hand-analysis verdicts BOTH
  flip-flopped; trust `bundle-postmortem`, not the hand decode. `tool-reconciled: bundle-postmortem`):**
  - The intermediate "srUSDe→USDC direction misattribution" claim (commit 5aee875) was WRONG. `bundle-postmortem`
    `decodeV4SwapFills` for c069abea: amount0(srUSDe)=+934460889828731878592, amount1(USDC)=-949488853,
    **zeroForOne=false ⇒ the leg IS USDC→srUSDe** (F-014's original direction was right). My "sqrtP fell ⇒ srUSDe→USDC"
    inference was a hand-decode error.
  - **But the 934e18 srUSDe was MINTED, not pool-swapped:** in the ordered flow, srUSDe transfers `0x0 → EXECUTOR`
    (mint) at logIndex 251, then `EXECUTOR → 0x0` (burn/redeem) at 252 — a vault round-trip, net srUSDe = 0. The
    c069abea POOL's standing liquidity only yields ~0.206e18 srUSDe going up (local v4 math + V4Quoter agree — both
    CORRECT for the pool). So F-014 was never a pool quoter-vs-core gap: the srUSDe came from a **deposit/mint**, not
    the pool.
  - **`winner_style = inventory_vault_rebalance`** was a DETECTOR FALSE POSITIVE — RESOLVED (commit 315b901).
    `shareTokenImbalanceTokens` flagged any GLOBAL net burn as "inventory by construction", but an atomic loop that
    BUYS the vault share in-tx (from a swap venue / 0x0 mint) then REDEEMS it shows a global net burn while the
    EXECUTOR nets 0 — contradicting the tool's own flow-ledger (executor net take = 0 srUSDe, only +WETH). Fixed to
    flag only a NON-VENUE holder residual (either sign). **Agent A was RIGHT (atomic), the detector over-flagged.**
    0xf391d0 AND the fresh coffeebabe 0x2b84e28c now classify `atomic_loop` / non_comparable=None. So these ARE
    genuine atomic protocol arbs — the capture blocker is the entry-leg MECHANISM (srUSDe minted/one-sided c069abea
    pool our pool-quoter can't cleanly price), NOT inventory. The two questions are now cleanly separated.
- **Lesson (the load-bearing one):** on a confusing multi-mechanism v4 tx, do NOT trust a hand trace-decode — the
  sqrtP/transfer-flow/mint signals contradict and I flip-flopped 3×. Run `bundle-postmortem` (authoritative
  `decodeV4SwapFills` + `winner_style`) FIRST and anchor to it (HERMES rule 16).
- **Status:** F-016 slice 1 (local v4 math) is verified-correct as a POOL quoter and still worth finishing for v4
  coverage. But 0xf391d0 is NOT confirmed a capturable arb — it may be an inventory_vault_rebalance. Resolve the
  Agent-A-vs-tool divergence (detector false-positive? file a tooling_defect if so) before more loop work.

### F-015 | 2026-07-07 | ✅ | Protocol atomic closed-loop VERIFIED executing through our pipeline (`searcher:protocol-loop`)
- **What:** a clean, fully-quotable protocol loop runs atomically through the SAME live machinery as a DEX arb:
  `flash USDC → PSM (protocol leg) USDC→DAI → Curve 3pool (DEX leg) DAI→USDC → repay`. Both legs route through
  `buildTokenGraph`/`quote()` like any swap; `buildResolvedPlanFromPath` assembles the flash-wrapped plan; the
  same `BotVMSimulator` the searcher uses executes it. Result on a mainnet fork: **`revert=NONE` (status=1)**,
  the loop closes back to USDC, the **Morpho flash repaid**. Answers the north-star question "do protocol legs
  route through path-assembly + execute atomically like DEX legs" — YES, demonstrated end-to-end.
- **Honest scope:** a MACHINERY gate, not a live +EV finder. With no peg dislocation the round-trip loses the
  Curve fee (~1.1bp), so grossProfit = −$11 at 100k; a small pre-funded USDC buffer covers the fee so the flash
  repays. A REAL +EV run needs a dislocation (or a naturally-mispriced vault share).
- **Real PRODUCTION BUG found + fixed via this repro (commit 6b36e04):** `buildResolvedPlanFromPath` repaid
  EVERY flash via `ensureApprove` — right for Morpho (pull) but a SILENT no-op for Balancer (which verifies its
  restored balance; the repay must TRANSFER back). Any `balancer-flash` plan reverted at `flashLoan`, and
  `flash-liquidity.ts` DEFAULTS the flash-source selector to balancer-flash — so the searcher could emit
  silently-reverting balancer bundles. Fixed: transfer-back for balancer, approve for morpho. The gate now runs
  BOTH adapters (status=1 under each). Setup trap also codified: install the BotVM executor via
  `installForkBotVm` (setCode + impersonate owner) or `state.send` fails "No Signer available".
- **Contrast with F-014/0xf391d0:** that srUSDe loop was NOT a clean vehicle (mint mechanism, one-sided c069abea
  pool, inventory_vault_rebalance flag). PSM+Curve is the clean, deterministic demonstration.

## Dead-ends / retired (high-value — don't circle back)

### ~~X-001 | R13–R21 | ❌ | "coverage exhausted → economics/posture is the only gate"~~
- **Why wrong:** measured on ~1.4% of flow (MEV-Share intake was OFF). The router-allowlist + MEV-Share
  intake gaps never ENTER the funnel, so `pipeline_dropped`/pool-coverage could never see them — a SHARED
  WRONG FRAME that dual-blind convergence masked as confirmation. Fix: the mandatory frame audit (rule 13
  arch-review trigger) + the hermes-gate intake-audit lens. [[project-mevshare-flow-discarded]]

### ~~X-002 | 2026-07-01 | ❌ | "coffeebabe is atomic, MEV-Share can't save us" from a single-pool probe~~
- **Why wrong:** concluded without tracing what the competitor backran. A root-cause is INVALID unless it
  names the specific source swap (or proves none) from a manual trace — now Hermes doctrine (Mechanics
  Step-1). 

### ~~X-003 | 2026-07-03 | ❌ | Interim re-classification of `0xa32b646c` as an execution-adapter epic~~
- **Why wrong:** off a corrupted code read (`rg -r` swallows a replacement arg — never `rg -rn`/`-rln`) +
  a stale memory. Re-verified from clean reads + on-chain data; the original pool-gap classification stood
  (F-002). Verify against CODE, not memory (rule 3). [[project-buildernet-auction-loss-anatomy]]

### ~~X-004 | multiple rounds | ❌ | "polishing the microscope" — analysis commits as progress~~
- **Why wrong:** safe verifiable analysis commits left searcher behavior unchanged (the 2026-07-01
  pattern). Fix: rule 12 `turn_class: observability-only` + rule 13 anti-drift cap (one such turn, then the
  next Brief MUST change behavior or escalate).

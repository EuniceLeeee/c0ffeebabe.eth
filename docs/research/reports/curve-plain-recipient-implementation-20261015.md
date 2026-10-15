# Curve plain recipient implementation — 2026-10-15

**Implementation complete for the scoped recipient wiring; unified historical correctness acceptance is pending.** Source commit `ddc4dafdfd759411abe7c35ca5c9c3eebacc883d`. This is not an `adapter_fixed`, `adapter_merge_ready`, opportunity or performance verdict.

The user changed execution order to finish one Family implementation at a time and concentrate acceptance afterwards. This round closes Curve plain's known recipient wiring and required local regressions; it starts no other Family, historical replay, live or performance experiment.

## Implemented scope

| Path | Behavior |
| --- | --- |
| ERC20 `exchange(int128,int128,uint256,uint256,address)` | Optional per-direction receiver mode after a source-bound external-recipient execution proof. |
| ERC20 `exchange(uint256,uint256,uint256,uint256,bool,address)` | Same, with `use_eth=false` and zero call value. |
| Existing int128/uint256 `exchange_received` | Explicit direct requests now independently guard exact positive debit, recipient receipt, old inventory and native balance. |
| Native input | Optional receiver ABI is behavior-proved using a funded raw-native probe. Runtime uses the common WETH/native input boundary and sends ERC20 output to the selected recipient. |
| Native output | Raw receiver remains the executor. Existing protocol-independent infrastructure measures ETH received, wraps it and delivers precisely that WETH to the original recipient, including caller-only native-output pools. |

Default mode selection, quoted semantics and default native 0/1 rounding are preserved. Explicit direct settlement requires **positive, exact input debit**; a default execution retaining one raw unit is not evidence that direct settlement succeeded. New receipts and old stock remain separate. No protocol branch or production change was added to the central pipeline.

Caller-only ERC20/native-input variants retain their default path; unsupported recipient requests return null. `quote-output` and `deferred-input` remain unsupported in this Family. Curve's input-first callback variants do not establish output-first deferred settlement, and this patch does not complete Yearn callback composition.

## Executed local validation

- Current actual-workspace production build and a build from immutable HEAD plus only the owned source both passed.
- Family: 18 groups plus the existing per-direction execution-proof regression, now included in the formal Family script.
- Native contracts: 15; historical CLI safety: 20; common native boundary: 4; all-Family dual-interface regression: 301; strict runtime: 174 — all passed.
- Actual local BotVM EVM: 7 test functions covering ERC20 and native default/self/external paths, both directions, positive and zero amounts, wrong receipt/debit, old inventory, native balance, approval cleanup and atomic rollback. Pools and tokens in these tests are synthetic.
- The 72 previously generated ERC20 programs remain byte-identical. The current fixture contains 120 programs. These are implementation regressions, not current historical deployed-pool or full sealed-issuer acceptance.
- Non-author pass 2: implementation ready, no open production/tooling blocker; its four findings were resolved. The three-pass cap was preserved.

The first native regression run had 14/15 passing because a new synthetic declared-revert result omitted mandatory effect arrays. That failed artifact remains intact; the fixture was corrected without weakening production validation, and the next run passed 15/15. The historical CLI's native allowance expectation was also corrected to require zero instead of a standing MAX grant, with positive and negative regression coverage.

## Reused historical evidence and remaining acceptance

Before the final native addition, the production single-block Ready copy at **N26152335**, hash `0x62a1a08653dd520793f8526d405430bcaabd5152459fca18e79f843514f3e0b3`, was selectively revalidated from the existing Ready for TX `0x6cc7a620da9e1fc47e894ec69bdbd3b1075c05ebc6c1807a3a6a000035fe136b`. The resulting graph had 22 edges. Both directions of pools `0x390f3595bca2df7d23783dfd126427cceb997bf4` and `0x4149d1038575ce235e03e03b39487a80fd709d31` proved their optional ERC20 recipient modes. The original Ready is unchanged.

That result is bound to the intermediate source and remains useful evidence. It is not a new natural-discovery run, final-native-source validation or historical recipient dual execution. Production price files were preserved; no amount, graph edge or old hash was manually changed. The subsequent unified acceptance must bind the final source, deployed implementation code and same historical state; cover applicable variants/directions and production/manual amount provenance; execute quoted/default/runtime/direct paths through actual issuer handles; and independently check debit, receipt, old inventory, native balance, allowance and rollback. Unrepresented deployed variants remain unverified.

Formal Adapter Replay/conformance/family-local gates, original opportunity replay and both 4A/4B performance remain pending. No performance result can be inferred from these tests. No live, deployment, signing or broadcast was started.

## Evidence and source ownership

[Structured implementation evidence](curve-plain-recipient-implementation-20261015.json) includes exact source/catalog hashes, tool-index selection and execution-manifest hash, prior Ready provenance and retained failures. [Independent review](curve-plain-recipient-review-20261015.json) records findings, their resolutions and acceptance limits.

Cloud evidence: `/opt/mev-cloud/family-runtime-20261007/logs/curve-recipient-20261015.4_896o2d`. Shared catalog generation was serial. Only the canonical artifact generated from HEAD plus owned changes is staged; the actual working catalog and peer UniV1 changes remain intact. All other pre-existing dirty files were hash-checked and preserved. The ignored catalog-input directory is a generator input artifact, not another task branch or working checkout.

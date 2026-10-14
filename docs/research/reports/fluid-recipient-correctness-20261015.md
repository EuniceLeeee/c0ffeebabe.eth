# Fluid recipient correctness — 2026-10-15

Fluid now supports an explicit output receiver for its sampled ERC20 and native ETH directions. The common issuer routes native output through measured ETH/WETH conversion; the Family owns `swapIn`, declared-revert quote decoding and input-first settlement semantics. Source: `f5a4f2011e7b07c1cbbe8e6b2f118962b8914c4f`. This is an authorized framework change, not a `family_local` change.

The existing natural Ready at **N26152607**, hash `0x20557c985376610e7464ea48fed96cbc0fcbfec936ca1519b067f3a855e4b369`, was copied and revalidated by current production code. Its original bytes are unchanged. The three pools provide six raw and six fresh effective directions using default **0.002 WETH / three-hop** valuation. The CLI's `historicalNaturalDiscoveryProven=false` remains recorded; no fresh-from-zero discovery or representative performance claim is made.

| Pool | Receipt TX | Actual coverage |
| --- | --- | --- |
| weETH/native `0x86f874212335af27c41cdb855c2255543d1499ce` | `0x5b6114b5b77e1ae4c1c2d402d82f0bca86db27e2deccb1ef0a978e01e768e663` | 16 positive, 16 declared reverts, 4 unfunded quotes |
| USDC/native `0x836951eb21f3df98273517b7249dceff270d34bf` | `0x03657fd88cd9c7ff4de4b98e0abdfb845908c62a43f4e713125ac9b0aca1f85f` | 16 positive, 16 declared reverts, 4 unfunded quotes |
| USDC/USDT `0x667701e51b4d1ca244f17c78f7ab8744b4c99f9b` | `0x8d869f76d35a3c4fd7543586bbb91e639933dc5cd716171f1959a533cd3a2a10` | 16 positive, 12 declared reverts, 4 unfunded quotes; 4 strict negatives incomplete |

Each direction used its actual production input and 10× that input at the same N-end state. The **48 positives** cover quoted, default runtime, direct self and direct external output equally. Payer/recipient/Liquidity token deltas, actor native balance and Swap event quantities match the quote. Runtime construction has zero external Exact/quoted/RPC calls and no fallback. Extra 10× inputs are explicit amount controls, not new price-table rows.

The **four USDT no-input controls remain incomplete in strict**. Raw EVM evidence confirms `main Revert` with nested `InvalidFEOpcode`; the unchanged production transport deliberately reports `resource-limited`. No declared-revert pass or independent rollback balance claim is inferred. Existing valid cases were reused; the supplemental run selected exactly the 14 previously unrun cases. All first failures remain retained.

Actual cloud build and 301 shared Family tests pass; the owned patch over HEAD builds and passes 298 tests (three additional tests belong to preserved peer changes). Actual EVM regressions pass: runtime VM 53/53 and native boundary 9/9. Fluid contract tests pass 17/17, including a fixture driving the production sim selector; this is not a historical whole-loop sim. New mode2 rejects a successful call with matching bytes, rejects malformed lengths/value/callback configuration, isolates malicious callbacks and restores a previously pending legacy callback. Historical full rollback and external-receiver native balance are not independently measured; separate EVM fixtures cover their stated scope.

Two confirmed tool defects are codified by this source commit: raw Family tests omitted the common native receiver mapping; the historical wrapper originally dropped structured declared-revert provider data. LearningCases preserve the old failures, non-author review and successful regressions. Candidate compile failure, incomplete historical runs, missing generator-input fixture and pre-execution SSH failures are retained in the [validation record](fluid-recipient-validation-20261015.json).

The shared source inventory was updated to actual reviewed hashes. The other 45 Family rows retain their earlier evidence and are not promoted to fresh passes. The actual generated catalog preserves peer UniV1 changes; the committed artifact was generated from HEAD plus only this task's source. Current BotVM mode2 is required and has **not been deployed**; old runtime rejects that mode.

Formal Adapter Replay, framework acceptance, other instances/variants, original opportunity replay and phases 4A/4B remain unfinished. Fluid whole-Family acceptance and the overall Goal remain open. No live, deployment, signing or broadcast was performed.

[Amounts, source and limits](fluid-recipient-correctness-20261015.json) · [receipt review](fluid-recipient-receipts-20261015.json) · [independent review](fluid-settlement-evidence-review-20261015.json)

Tool reconciliation: `listener:searcher:fluid-dex-historical-ready` agrees with copied/revalidated production Ready and six fresh rows; `listener:searcher:fluid-dex-historical-dual` agrees with the mixed pass/incomplete matrix. The current settlement acceptance gate is retained separately with its actual result, never substituted by these prose conclusions.

Current-source Fluid settlement acceptance remains **incomplete** (exit 1): variant coverage and execution evidence are incomplete. All 46 installed Families are inventoried; this invocation selected Fluid only. Source and evidence pins are current; they do not turn scoped successes into a full pass. See the [executed gate receipt](fluid-settlement-gate-20261015.json).

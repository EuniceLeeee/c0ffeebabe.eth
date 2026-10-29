# token-conversion declarative definition

`token-conversion.json` (BTB `btb-bear-v1`) + `xwin-allocations-v1.json` (child) is the
protocol-json-v2 definition. `token-conversion-math.ts` holds the pure BTB quote, xWin local
state assembly and xWin transition models; they are registered statically in
`declarative-math-models.ts`.

Two deviations from the handwritten TS Family are deliberate and user-accepted (2026-10-29):

1. **Code-hash integrity only (BTB asset/target).** The TS opcode-walk dependency-closure and
   audited-template checks are replaced by `get-code` + keccak256 stored on the descriptor and
   re-read/compared at every pricing/exact quote. There is no locality guarantee for the asset
   runtime; all addresses, decimals, supply/backing, amount/effect probes, capacity, approvals
   and execution effects are retained.
2. **OCR2 aggregator runtime is exact code hash only.** The TS `maxAnswer`-normalized OCR2
   template branch (`xwin-dependency-runtime.ts`) is not expressible with the declarative value
   ops (`maskHash` can only zero spans). Deployments whose aggregator differs only in
   `maxAnswer` are therefore rejected at quote time; the accepted deployment set is narrower.
   Exact code-hash integrity still fails closed.

Because the BTB dependency-closure proof is dropped, pricing declares `"refreshPolicy":
"each-block"` in both variants.

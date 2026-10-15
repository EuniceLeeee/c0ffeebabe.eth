# Silo redeem recipient implementation — 2026-10-15

The existing synchronous Silo redeem route now accepts an explicit receiver while retaining the executor as share owner. Programs require positive exact share debit and supply burn, actual receiver receipt equal to the positive return, and preservation of old actor output, receiver shares and actor native currency. Default program bytes stay unchanged; its metadata now advertises the direct capability. quote-output and deferred-input remain unavailable.

Actual and owned-only production builds passed, together with 4 contract-model tests (self/external, multiple amounts and negative matrix), nomination checks and 301 shared Family tests. Independent review caught and resolved the initially missing default capability declaration. The unsupported initial tool capability query is preserved; the corrected indexed tests both ran successfully.

Status: **implemented, necessary local regressions and independent review passed**. Existing identity probes establish self payout only. New external receiver historical execution and implementation/CDO/strategy binding, full issuer integration, EVM rollback, formal Adapter Replay and phase4 performance remain pending. Existing jrUSDe opportunity results are not upgraded by this change. [Source, interfaces, test evidence and limitations](silo-recipient-implementation-20261015.json).

# `custom-swap:oneswap` — parked declarative draft and blockers (2026-10-30) — RESOLVED 2026-11-02

Status: **migrated** on framework `f4a16ced` (branch head `04553544`). This file is retained as the
gap-resolution record for the earlier parked draft; the live migration report is
[`../oneswap-20261102.md`](../oneswap-20261102.md).

Delivered: `venues/swaps/oneswap-family/oneswap.json` + `venues/swaps/oneswap-family/declarative-math.ts`
+ append-only `oneswapMathModels` registration. The handwritten `oneswap.production.ts` remains in the
tree pending central generation; `oneswap.draft.json` is historical and is not imported.

## Gap resolution

### G-OS-1 — `uint112` execution amount — RESOLVED

`declarative-call-codec.ts` now accepts runtime references on any checked `uintN`/`intN` ABI leaf when
`checkedIntegers` is enabled (`:35-40,57-62,87-99`), records the leaf width, and the execution emitter
emits a range check before the CALL (`declarative-execution.ts:680-700`); signed values must be fully
sign-extended (`:687-699`). The v2 step/effect shape supplies the conditional ERC-20 transfer,
`msg.value` and per-side effects (`declarative-execution.ts:501-527,621-631`). The JSON declares exactly
the retained program: `transfer(pool,amountIn)` for ERC-20 input, `addMarketOrder(rawIn,recipient,uint112)`
with `value: {runtime:"amountIn"}` for native input, exact input debit and return-equal credit.

Probe: the migrated JSON builds the runtime program for both directions; the native route contains one
`addMarketOrder` CALL with a value register and no transfer, the ERC-20 route contains transfer + CALL
without value (in-memory opcode walk; see the report).

### G-OS-2 — `"swap"` classification with mutation-only receipt — RESOLVED

`declarative-swap-domain.ts:31-36` accepts `receiptMode:"mutation-only"` with a non-empty
`mutationReason`, and `:216` returns that reason for `"swap"`-classified events instead of requiring a
full `PoolImpact`. The JSON declares the three events as `classification:"swap"` with the retained
reason ("oneswap partial fill events require chain replay; refresh the complete AMM/orderbook state"),
so `landedEvents.classify`/`isSwapLog` telemetry keeps the legacy `swap` classification while the
receipt contribution remains unresolved/mutation-only. The `impact` entry is an unreachable
`$missing.impact` placeholder because the mutation-only branch returns first.

### G-OS-3 — remaining domains authored

The orderbook state/quote was authored as pure math models that delegate to the retained
`state.decodeState` and `math.quoteAmount` implementations (`oneswap:state`, `oneswap:quote`,
`oneswap:pricing`, `oneswap:proxy`). Quote/pricing parity was checked in memory against the handwritten
functions, including the contract vectors, fee rounding, maker-fill, incomplete-prefix rejection and
uint112 bounds.

## Validation

- `compileDeclarativeSwap`/`defineSwapFamily`, in-memory harness, temporary rendered entry + family
  contract test (8/11 with three documented legacy-shape deltas), `tsc`/`build:live` (no oneswap
  errors; tree currently blocked only by the concurrent dodo-v2 math), `test:family-json`
  (652/651/0/1): see [`../oneswap-20261102.md`](../oneswap-20261102.md) for commands and evidence.
- No production generator, RPC/VM, live, signing or broadcast was run.

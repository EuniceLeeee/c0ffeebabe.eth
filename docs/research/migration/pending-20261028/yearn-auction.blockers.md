# protocol:yearn-auction — declarative migration blocked (2026-10-29)

Status: **STOPPED / no draft generated**. Discovery cannot express the
family's registered-auction enumeration in protocol-json-v2, so no
non-narrowing draft can be registered. The rest of the family was not
author-adopted in this window; the primary blocker is recorded below with
source locations so the framework fix can be scoped.

## Source of truth read

`venues/protocols/yearn-auction-family/{action,capture,codec,discovery,exact,execution,identity,instance,manifest,pricing,protocol,routes,runtime-settlement,runtime-shape,state,types}.ts`
and `test/{contract,callback-evidence,callback-historical,callback-ready,historical-dual,runtime-settlement-evm,refresh,fixtures}.ts`.

## Blocker B1 — one nomination cannot fan out to all enabled auctions

- TS nomination reads `getAllEnabledAuctions()` at the source block and emits
  **one address-surface observation per enabled sold token** (or one for the
  nominated `opaque.sold`); see
  `yearn-auction-family/discovery.ts:9-21`, in particular
  `const selected = typeof opaque.sold === "string" ? [address(opaque.sold)] : enabled.map(address)`
  and the `for (const sold of selected)` push.
- protocol-json-v2 has exactly one nomination bridge:
  `discovery.nomination === "address-surface"` +
  `nominationReadFlow` (`venues/declarative-discovery.ts:205-215`). Its
  resolver must return **one plain opaque object or null**:
  `declarative-nomination.ts:62-66`
  (`if (!output || typeof output !== "object" || Array.isArray(output)) throw ...`).
  The surrounding provider then emits one address-surface observation per
  nominated address and passes the opaque through unchanged
  (`address-surface-nomination.ts:44-58`).
- Therefore `getAllEnabledAuctions()` can at best pick one `sold` value. The
  family's contract test requires both enabled auctions to nominate:
  `test/contract.ts:41-43` asserts
  `[f.sold, addr(99)]` from two registry entries. A JSON that only re-reads
  the historical tx (tx-evidence nomination) or only the first enabled
  auction would narrow discovery and is not a valid migration.
- Impact: instances whose auction token has no observed `take` yet cannot be
  nominated from the queue's registry enumeration. This is the family's
  primary discovery source (`sources` includes `address-surface`,
  `evidenceChannel:"nominate"`, `txSeedNominations:true`).
- Needed framework capability (public TS, out of scope here): a nomination
  read flow that returns a **list** of opaque objects (one per enabled sold),
  or a declarative registry-enumeration read that can project one observation
  per returned array element. The existing read-flow language already supports
  arrays; only the single-object return contract blocks it
  (`declarative-nomination.ts:63-66`).

## Remaining migration surface (not authored; no framework verdict claimed)

These sections look expressible in principle and are listed so the next
attempt does not re-derive them; none was validated because the family cannot
reach a faithful registration without B1.

- **Exact/pricing local math**: `state.ts:32-44` inverts the auction floor from
  `rawPrice`/`available`; `pricing.ts:11-19,29-45` derives mids and
  `classifyUnavailable` for zero price/empty capacity. JSON can model this with
  a local-math `quoteFlow`/`pricingFlow` plus a math entry (cf. goldx) and
  `sampleAmount` reading `$steps` (framework-gaps doc §3).
- **Identity multi-round proof**: `identity.ts:68-119` runs surface → token
  dependency → two behavior simulations → executor-program receipt. The
  6876fef0 executor-program simulation (`declarative-simulation.ts`) and
  `simulationActor`/`programReceipt` ops cover the program round; the
  impersonated `take` behavior round maps to a raw `effect-delta-simulation`
  request. The registry/proxy proofs use fixed clone-template hashing
  (`runtime-shape.ts:3-12`), expressible with `maskHash`/`codeHash`/`bytes`.
- **Execution/settlement risk (unproven)**: `runtime-settlement.ts:8-35`
  (`budgetProgram`/`terms`) is call-time math that must become an
  `executionMath` entry; `takeProgram` uses patched fixed-width words and
  balance-delta checks (`execution.ts:11-36`) that the v2 step compiler can
  express. The deferred-input program (`runtime-settlement.ts:36-76`) uses a
  bespoke callback payload/debt continuation; the shared declarative callback
  compiler (`declarative-callback.ts:135-223`) supports output-first ERC20
  callbacks but rejects `settlement.paymentInput` (`:150`) and only binds
  scalar callback arguments (`:105-110`). Whether yearn's callback maps onto
  that contract was **not** proven; do not claim it as migrated or as a gap
  until exercised.
- **Exact method flags**: TS sets `chainAmountQuote:true` for a local
  inversion (`exact.ts:30-31`); a JSON local-math flow cannot claim it, the
  same documented deviation as `pending-20261028/mellow-queue.blockers.md`.

## Re-entry checklist

1. Add list-returning nomination fan-out (or array-element observation
   projection) to the declarative discovery bridge.
2. Re-run `test/contract.ts` nomination assertions (two enabled auctions,
   `opaque.sold` filtering, malformed calldata rejection).
3. Then author identity/pricing/exact/execution, with the deferred callback
   shaped and tested explicitly against `test/callback-*` and
   `runtime-settlement-evm.ts`.

# `fluid-dex` — re-evaluation against framework `f4a16ced` (2026-11-02): still blocked

Status: **blocked / not migrated**. The handwritten `fluid-dex.production.ts` remains the
production entry. No live/VM/RPC, no generator run, no public framework TS/test change, no
generated artifact. The parked draft `fluid-dex.draft.json` is unchanged and still **not
importable**: the sections listed below were already omitted/disabled in it.

This file supersedes the 2026-10-30 parking report. Four of the five previously decisive gaps are
now expressible on this baseline; one capability — the **runtime revert-quoter used by the
`quote-output` settlement preparation** — is still absent, and it is load-bearing for both
advertised settlement paths. Dropping it would narrow a real capability, so the family stays
parked rather than being cut over partially.

## Re-evaluation of the previous gaps

| Previous gap | New baseline evidence | Verdict |
|---|---|---|
| **G-FL-1** topic-only landed event with no public ABI (`swap.ts:21-37`, `codec.ts:16-19`, `discovery.ts:24-33`) | `declarative-event-codec.ts:12-24` accepts a `topic`-only event; `declarative-swap-domain.ts:27-30` requires `receiptMode: "unresolved"`; `declarative-discovery.ts:305-321` accepts a topic-only discovery pattern (`nominationOnly`/trigger identity). | **resolved** — declaration exists (`events[].topic`, `receiptMode: "unresolved"`). |
| **G-FL-2** "resolved with zero impacts" receipt result (`swap.ts:26,34-36`; central wrapper `test/strict-receipt-authority.ts:311-333`) | `declarative-swap-domain.ts:111-119` classifies the opaque trigger but `observation.decode` returns `[]`, and the shared strict wrapper reports the group `unresolved` (`declarative-swap-domain.ts:213-216` skips `receiptMode: "unresolved"`). The legacy observer also reports the group unresolved. | **resolved** — the legacy result is `unresolved`, not a zero-impact `resolved`, so the topic-only declaration is faithful. |
| **G-FL-3** identity `assets`/central metadata hook (`identity.ts:48-52,68-80,186-220,222-229`; probe sizes `:124-139`; asset code `:270`) | `declarative-identity.ts:44-50,115-122` adds the optional `identity.assets` hook and exposes decoded `assets` to stages; `adapter-family-runtime.ts:3703-3710` wires the existing `createIdentityAssetMetadataPlan` authority. | **resolved** — the hook and `assets` decode environment now exist. |
| **G-FL-4** declared-revert custom-error quote (`pricing.ts:96-111`, `exact.ts:38-56`, `codec.ts:119-163`, identity probes `identity.ts:149-164`) | `declarative-quote-proof.ts:14-18,70-75,121-142` supports `errorSignature` + `completion: "reverted-as-declared"` (canonical `decodeErrorResult` selector/payload checks); `declarative-values.ts:193-198` exposes pure `decodeErrorCanonical` for identity/pricing decode. `effects: ["revert-data"]` remains declarable in requirements. | **resolved** — a chain quote proof for the Fluid `FluidDexSwapResult(uint256)` revert is now declarable. |
| **G-FL-5** runtime `quote-output` preparation depends on the same revert decoder (`execution.ts:17-37`, `raw-execution.ts:58-65`) | Declarative `quoteOutput` is a static call/math list: steps must be `static: true` ABI-return-word calls or registered runtime math (`declarative-execution.ts:93-156,190-227`), and the emitter has no `revertBytes` path (`:661-713`). `RuntimeAmountProgram.call({revertBytes})` is not reachable from JSON. | **UNSUPPORTED — decisive gap remains.** |

### The remaining blocking gap (G-FL-5, narrowed to what is actually missing)

`fluidDexRuntimeQuote` (`raw-execution.ts:58-65`) issues `swapIn` with `revertBytes: 36` and
decodes the `FluidDexSwapResult(uint256)` payload in the runtime program. Both settlement paths
depend on it:

- `quote-output`: `execution.ts:22-23` returns `finish(fluidDexRuntimeQuote(pool, swap0To1))`,
  i.e. the settlement *result* is exactly the runtime revert-quote.
- `direct-output`: `raw-execution.ts:29` runs the same `fluidDexRuntimeQuote(...).bytes()` inside
  the direct program to establish the expected output before payment, and `execution.ts:27-29`
  advertises `settlement: { quoteOutput: true, directOutput: true }` for **both** paths.

A declarative execution cannot prepare that quote: the `quoteOutput` module only supports static
calls whose ABI *return* words are saved (`declarative-execution.ts:121,200`), or runtime math
over such captures; there is no `revertBytes`/`return-or-revert-data` runtime call. Declaring no
`quoteOutput` module makes `settlement.quoteOutput` false and makes
`buildDeclarativeRuntimeLeg` reject `{kind:"quote-output"}` (`:904-906`), so the migration would
silently drop an advertised settlement capability and the "actual output equals the declared
revert quote" invariant on the direct path. Additionally, the quote-output path is rejected for
native routes (`:904-906`), and Fluid routes carry native input/output
(`execution.ts:24-26`), so the "special native settlement" coverage called out in the framework
note (`docs/research/design/family-common-capabilities-20261102.md:176`) is also still missing.

To unblock, the shared execution/codec layer needs a bounded, declared runtime **revert-data
quote preparation** (equivalent of `RuntimeAmountProgram.call({revertBytes})` plus canonical
custom-error decode) available to `modules.quoteOutput`, and quote-output settlement support for
the native asset boundary. Until then the handwritten entry stays authoritative.

## What is now confidently expressible (for the eventual migration)

- Manifest/scope/activation, discovery (swapIn call pattern, topic-only landed event, address
  surface), instance/binding projection, routes (`stateKey = route.routeKey`, one directed route
  per pricing group), pricing static/current state reads, pricing projection (`quotedPoolMid`
  shape) and refresh policy, exact chain quote (declared revert, custom error canonical decode),
  identity assets hook and active proofs (declared revert + `decodeErrorCanonical`),
  topic-only receipt observation, and the direct/default execution steps/effects (payable
  `swapIn` with runtime input patch, recipient/minOut arguments, exact-clear approval,
  native/erc20 debit-credit effects).
- The only thing that cannot be declared is the runtime quote preparation above, which is why
  the family is not migrated.

## Files

- `docs/research/migration/pending-20261028/fluid-dex.blockers.md` (this file, updated)
- `docs/research/migration/pending-20261028/fluid-dex.draft.json` (unchanged partial draft; still
  not importable — `identity.definition` / `swap.events` / `modules.*` omissions as recorded in
  the previous revision, plus the now-resolvable sections that would be authored during the real
  migration)

## Validation

No production code, JSON, generated artifact or test was changed in this re-evaluation. The
verdict is based on reading the current shared modules listed above; the framework note itself
lists "runtime revert-quoter" as not implemented for Fluid DEX
(`docs/research/design/family-common-capabilities-20261102.md:176`). Re-run the central
regression `test/strict-receipt-authority.ts:311-333` only after a future fluid migration.

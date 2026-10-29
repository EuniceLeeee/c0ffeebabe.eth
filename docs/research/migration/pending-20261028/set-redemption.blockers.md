# protocol:set-redemption — blocked (engine gaps)

Faithful JSON cannot be authored on framework `6876fef0`. The family stays on its hand-written TS
production entry. A non-deliverable shape draft is parked at `set-redemption.draft.json`; it records
only the parts that are expressible (discovery mapping, instance projection, routes/effects) and the
shape of the blocked parts. It is not a v2 document, must not be copied to
`protocols/set-redemption-family/set-redemption.json`, and must not be used to generate a production
entry.

The family is the only Protocol family in this workspace with an implemented reverse-binding channel,
and it carries two lineages (`set-redemption:basic-issuance-0.7.6`,
`set-redemption:legacy-core-0.5.7`) plus three owned actions (`set-basic-redeem`,
`set-legacy-core-redeem`, `set-legacy-core-issue`). Narrowing any of those is prohibited; the gaps
below are structural, not missing authoring effort.

## Gaps (file:line)

1. **Multi-asset execution fan-out and nested runtime programs are not declarable.** Basic redemption
   burns one Set and credits every basket component. The TS runtime program loops over
   `descriptor.components` in chunks of 8, verifies each receipt, and nests `execSubscript` for larger
   baskets (`set-redemption-family/execution.ts:74-110`); it emits one `assert-balance` node per
   positive output (`execution.ts:134-136`) and six expected effects
   (`execution.ts:138-146`). Legacy redemption does the same in chunks of 7 with
   `redeemAndWithdrawTo` (`execution.ts:16-42`), and legacy issuance builds an exact-out program with
   dynamic quantity/fee/balance checks (`issuance.ts:12-51`); direct settlement adds
   `setDirectProgram`/`setBasketDirectProgram` and side-output preservation
   (`direct.ts:27-64`, `execution.ts:48-66,115-117`).

   Declarative execution requires exactly one debit and one credit bound to the route
   (`venues/declarative-execution.ts:161-168`). Version 2 steps and step effects are static JSON
   arrays (`declarative-execution.ts:26-33,244-298`); there is no expression/program that expands one
   effect or call per `descriptor.components`, and no nested `execSubscript`/runtime-program
   composition. The declarative fragment builder emits exactly one action node
   (`venues/declarative-protocol.ts:650-671`) and cannot add the per-output `assert-balance` nodes.
   The runtime-math catalogue is scalar arithmetic only (`declarative-runtime-math.ts`), so it cannot
   synthesize the loop.

   Probe (run, no repo edit): a declaration with one debit and two credits throws
   `declared conversion must bind full debit or bounded budget and fresh receipt to the route`.

   Consequence: a migrated Basic route would verify only the route component and leave every other
   basket receipt unguarded, or would omit expected outputs. That is a weakened execution check and
   fails the family contract (`test/contract.ts:80-87` asserts five nodes, four `assert-balance`
   entries and six expected effects).

2. **The Basic action adapter cannot encode direct `redeem` calldata.** `set-basic-redeem` is a direct
   encoder: empty `params`, `redeem(set, amount, recipient)` calldata, selector-only trace
   (`set-redemption-family/action.ts:8-17`). The family contract encodes the Basic fragment node and
   compares it to `MODULE.encodeFunctionData("redeem", ...)` (`test/contract.ts:82-84`).

   Declarative action adapters are fixed to runtime-program nodes: `createDeclarativeProgramAction`
   requires exactly one `node.params.runtimeAmountProgram` and returns
   `encodeRuntimeAmountNode(...)` (`venues/declarative-execution.ts:471-492`). There is no JSON action
   declaration for a direct ABI call with a runtime amount patch. Probe: a Basic node with empty
   `params` throws `declared quoted node adapter mismatch`.

   Consequence: even if execution were expressible, the Basic action semantics, `matchTrace` and
   quoted-fragment bytes would differ from the TS contract test.

3. **Dual nomination channels and the implemented reverse binding are not declarable.** The family
   combines address-surface nomination (code-hash + `getModules` binding) with a receipt-log fallback
   for legacy Core candidates in one `nominate` (`discovery.ts:6-11`,
   `set-redemption-family/nomination.ts:22-49`). It also implements the reverse-binding retain channel
   (`discovery.ts:37-41`), the only real implementation among the Protocol families here.

   Declarative mapped discovery accepts exactly one discriminator, `"tx-evidence"` or
   `"address-surface"` (`venues/declarative-discovery.ts:51,266-273`), and choosing either drops the
   other channel. `compileMappedDiscovery` always returns
   `reverseBinding: explicitReverseBindingUnsupported(...)` (`declarative-discovery.ts:273`); the root
   declaration schema has no reverse-binding field (`declarative-protocol.ts:83-99,282`). There is no
   JSON hook to preserve `bindingObservation` as a reverse-binding provider.

   Consequence: cold legacy candidates or cold Basic address-surface candidates lose a nomination
   path, and the implemented reverse binding is replaced by an explicit unsupported declaration. Both
   are capability narrowing, not fail-closed behavior.

4. **Residual: event canonical re-encode comparison is not expressible.** Calls can be checked by
   comparing `encode(abi, name, args)` with the observed calldata (the draft does this), but the
   declarative value language has no `encodeEventLog`. The TS discovery rejects non-canonical event
   encodings by re-encoding the decoded log and comparing data/topics
   (`discovery.ts:20-25`, `legacy.ts:46-50`). Declarative discovery only decodes and applies predicates
   (`declarative-discovery.ts:193,203,242-258`). This is a smaller weakening than gaps 1–3 but should be
   closed before a declaration is accepted if discovery is otherwise unblocked.

5. **Residual parity notes (not blockers by themselves).** The declarative discovery candidate carries
   checksummed addresses from the shared `scalar()` mapper (`declarative-discovery.ts:96-107,238`) while
   the TS candidate stores lowercase addresses (`codec.ts:23,27`); the draft normalizes at
   identity/instance boundaries. For a multi-field key the declarative `candidateKey` is
   `JSON.stringify(parts)` (`declarative-discovery.ts:275-285`) while TS uses `${set}:${module}`
   (`discovery.ts:34`); this is an internal dedupe key, not admission evidence. Both should be aligned
   when discovery is unblocked.

## What the draft does and does not cover

Validated in memory against the TS family (no framework/test edits; temporary probe scripts removed):

- **Discovery mapping**: `compileDeclarativeDiscovery` on the draft definition accepted the same
  canonical Basic call/log, all five legacy call patterns, both legacy log patterns and the
  address-surface observation as the TS plugin after normalizing the framework's checksummed address
  casing. A malformed Basic call with one extra byte was rejected by both. Pattern ids match the TS
  ids (`set-redeem-call`, `legacy-issue`, …, `legacy-SetIssued`, `legacy-SetRedeemed`).
- **Instance/routes**: `compileDeclarativeValues` evaluation of `instance.key`, `instance.draft`,
  `instance.bindingProjection`, `routes.directions`, `routes.key`, `routes.target`, `routes.graphVenue`
  and `routes.effects` equals the TS `plugin.instance.*`/`plugin.routes.*` projections for a
  four-component Basic descriptor (same `instanceKey`, four route keys, token ordering, taxonomy,
  `component` field, graph venue and six expected effects). The route object necessarily also carries
  the declarative `adapterId`/`target` fields; that is the engine's route projection, not a TS parity
  claim.
- **Not covered**: the identity stages, pricing/exact flows and the execution/action bodies are
  intentionally not authored. The draft's `pricing`/`exact`/`execution` blocks are shape notes, not
  validated declarations. `renderDeclarativeProductionEntry`, `createDeclarativeProtocolRuntime` and
  `defineProtocolFamily` were therefore **not** run on the draft: it contains `_` metadata and
  deliberately incomplete sections, and a compiling placeholder would be a non-faithful narrowed
  migration. Gaps 1–3 are the reason a faithful document cannot reach those entry points.

Probes for gaps 1 and 2 were executed with the current framework:

- multi-credit execution → rejected at `declarative-execution.ts:164-168`;
- direct Basic action node → rejected at `declarative-execution.ts:486`.

`listener/node_modules/.bin/tsc -p listener/tsconfig.live.json --noEmit` was run; it fails on the
untracked, concurrently added `listener/src/searcher/venues/badger-sett-withdraw-math.ts` (TS2554 /
runtime-math `op` widening), not on this family or this draft. No framework, test, generated entry or
generator changes were made here.

## Proposed minimal framework hooks (not applied; public TS is out of scope)

- **Execution**: allow a declared basket/effect template that expands over
  `descriptor.components` (multiple credits with per-component minimums), and let the fragment builder
  emit the existing `assert-balance` nodes for every positive output; or allow a declared sequence of
  runtime programs with the existing `execSubscript` composition. The runtime VM already supports the
  TS shape; the JSON compiler is the limitation.
- **Action**: add a direct ABI action declaration (target/function/runtime amount patch) alongside the
  existing runtime-program action, so Basic redemption can preserve its empty-params calldata and
  selector-only trace.
- **Discovery**: allow a list/composition of nomination providers (address-surface + tx/receipt) and a
  declarative reverse-binding provider (e.g. the same read-flow shape as `nominationReadFlow`, returning
  a `verified` observation for the retain channel). Add an `encodeEventLog`/canonical event comparison
  operation for gap 4.
- **Legacy**: the same execution fan-out plus nested-program hook is required for the 7-component
  chunks, `redeemAndWithdrawTo` and the exact-out issuance program; the legacy variant must stay unless
  those are expressible.

## Verdict

Stop per migration policy: do not write the canonical JSON, do not narrow the two nomination channels,
the reverse binding, the Basic direct action, or the multi-asset execution receipts. Revisit after the
execution fan-out/nested-program and direct-action hooks exist; the discovery mapping and dynamic
routes/instance projection in the draft are the ready basis for the remaining work.

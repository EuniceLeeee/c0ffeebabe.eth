# protocol:few-wrapped — blocked (engine gaps)

Faithful JSON cannot be authored with the current public engine. A partial in-memory draft is parked
at `few-wrapped.draft.json` (not a deliverable; discovery mapping and execution shape only). The
family remains on its hand-written TS entry.

## Gaps (file:line)

1. **Discovery keeps two nomination channels.** The family enables transaction seeding *and*
   address-surface nomination (`few-wrapped-family/discovery.ts:7`, `:29`). Declarative discovery has
   one discriminator: `nomination: "tx-evidence" | "address-surface"` (`declarative-discovery.ts:51`)
   and chooses exactly one provider (`:266-273`). Declaring `tx-evidence` drops the opaque
   address/label nomination; declaring `address-surface` drops `txSeedNominations`. No combined form
   exists, and the gate rejects losing either channel.

2. **Identity needs arbitrary effect-simulation setup.** The two behavior probes wrap/unwrap with an
   approve `preCalls` and explicit funding (`few-wrapped-family/identity.ts:29`,
   `few-wrapped-family/simulation.ts:13-19`); the wrap probe needs two approve calls (0 then value)
   before the call, and unwrap must reuse the wrap actor (`identity.ts:40-41`). The declarative
   execution-simulation bridge explicitly forbids VM bytes, substitute callers, arbitrary funding and
   setup pre-calls (`declarative-simulation.ts:46-48`); it funds only the single route input amount
   and emits no pre-calls (`:71-80`). Its receipt decoder also rejects `preCalls` and any funding row
   other than the one input amount (`:122-129`). `simulationActor` (`:97-109`) can recover the actor
   only from a prior executor-program receipt, but the first probe's program context still needs a
   concrete executor (`:60`), which cannot be the symbolic actor the issuer resolves.

3. **Pricing needs two dependent effect simulations at a computed probe amount.** The first round
   reads binding/supply/backing, then builds one simulation per direction at
   `min(oneToken,totalSupply,balanceOf(wrapper))` (`few-wrapped-family/pricing.ts:22-32`). A
   declarative `pricingFlow` cannot give each simulation its direction's `route`: the flow environment
   has no per-route record, and a declared simulation `context` is rejected once a descriptor is
   issued (`declarative-protocol.ts:263-267`). Declaring raw `effect-delta-simulation` requests with
   their own funding/caller would bypass the same simulation boundary as (2).

4. **Receipt evidence is broader than the generic program receipt.** `decodeReceipt`
   (`few-wrapped-family/simulation.ts:34-63`) requires exactly three token deltas, one supply delta,
   one native zero and one Wrap/Unwrap log with exact sender/to/amount. The declarative
   `programReceipt` verifies token scope, native conservation and the debit/receipt pair
   (`declarative-simulation.ts:114-148`) but not supply/event proof; those could be added as ordinary
   JSON checks only after (2) and (3) make the simulations declarable. `zeroEvidence` is not the
   issue here; the simulation itself is.

5. **Exact inherits the same simulation gap.** `few-wrapped-family/exact.ts:14` issues the conversion
   simulation with `preCalls`/funding for the quoted amount. The `effect-simulation` quote proof
   (`declarative-quote-proof.ts`) could represent the chain quote, but the request cannot be built
   under (2).

6. **Discovery calldata/event validation is mostly expressible** (decoded args plus predicates), so
   the blocker is the nomination combination in (1), not the field map. `txSeedNominations` is a
   discovery capability, not optional decoration; dropping it would narrow the original channel.

## Verdict

Stop per migration policy: do not write the canonical JSON, do not narrow the two nomination channels
or the behavior probes, and do not replace protocol receipts with a weaker generic proof. Revisit when
the declarative discovery can declare both nomination providers and the execution-simulation bridge
accepts setup pre-calls/funding plus a caller-derived actor (or an equivalent sanctioned probe shape).

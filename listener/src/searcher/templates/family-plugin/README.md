# Family plugin scaffold

New Families start from this directory. The framework contract is a single
unified `FamilyPlugin<Domain>` discriminated type: every Family picks the
capability slots its domain requires and fills only its own files. The
shared `defineFamily` validates the definition from `manifest.domain`;
`defineSwapFamily` / `defineProtocolFamily` / `defineCreditFamily` /
`defineFundingFamily` remain thin aliases so production entries keep their
shape.

## Directory layout (every Family)

```
venues/<domain>/<family>/
  manifest.ts       // familyId/domain/action/lineage/taxonomy
  discovery.ts      // evidenceChannel: "nominate" + patterns + decodeCandidate
  nomination.ts     // plugin-owned reverse materialization (address/log/tx)
  identity.ts       // identity variants + on-chain proof
  instance.ts       // instance compile/descriptor
  routes.ts         // route projection + graph
  execution.ts      // execution fragment/effects
  action.ts         // FamilyOwnedAction
  capture.ts        // capture.materialize
  types.ts
  <domain>.ts       // swap | protocol | credit | funding semantics
  pricing.ts        // swap/protocol slot
  exact.ts          // swap/protocol slot
  test/…            // plugin-local contract tests
```

## Required by contract (all domains)

- `manifest` (familyId + domain + owned/required action ids + taxonomy)
- `discovery` with `evidenceChannel: "nominate"` and a `nominate` capability
  (or, for funding, no discovery: funding declares repayment target inside
  its funding capability)
- `actionAdapters`

## Domain capability slots

| domain | required | optional | prohibited |
|---|---|---|---|
| swap | pricing, exact | capture, sharedBindings, optional | protocol/funding/credit |
| protocol | pricing, exact | capture, sharedBindings, optional | swap/funding/credit |
| credit | credit | capture | swap/protocol/funding, pricing/exact |
| funding | funding | capture | swap/protocol/credit, discovery/identity/instance/routes |
| (future) lp | lp | - | others |

A new domain only adds a `FamilyDomain` value, a domain validator and its
capability slot; central pipeline, capture, corpus/parity stay untouched.

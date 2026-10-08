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

## Required acceptance for swap/protocol Families

Keep and test both execution capabilities; one does not replace the other:

- `exact` plus the quoted `execution.buildFragment`: given an input amount,
  preserve the production effective/explicit quote and validated execution path.
- `execution.buildRuntimeLeg`: consume the previous leg's actual receipt inside
  the transaction. Construct sim amount trials without off-chain hop quotes.
  ABI, amount arithmetic, native wrapping and callback settlement belong to the
  Family, not central scheduling.

Run `npm run searcher:family-dual-execution` and the Family's quote/execution
contracts. Cover all supported directions/variants and multiple amounts, including
the effective input. Through the production sim amount selector, assert zero
off-chain Exact calls and no quoted fallback for supported runtime legs. Retain
tests for the quoted path. Test current receipt versus old inventory, temporary
approval cleanup where required, native balance deltas, callback debt, amount
bounds and final repayment/conservation. Funding and credit retain their own
domain contracts; they are not ordinary swap legs.

`npm run searcher:family-runtime-audit -- <checkpoint.json>` can read an existing
Ready without modifying it and check all stored descriptors/routes construct.
This is offline construction coverage, not a new admission, a current Ready
fingerprint, an EVM run or a profitable opportunity. Missing historical samples,
unsupported variants, runtime declines and quoted fallback must be reported
separately. Before claiming historical execution parity, use the same state,
source and caller to compare quote output with independently observed receipts;
never manufacture admission/evidence or weaken final simulation/inventory gates.

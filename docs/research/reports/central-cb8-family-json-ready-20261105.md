# Central baseline alignment and selective JSON Ready invalidation

Central baseline: `cb8e4af676146422f5055c8dcbeff9c40410c825`.
Destination: existing `codex/family-runtime-actual-20261007` checkout at
`/opt/mev-cloud/family-runtime-20261007`, originally
`0e74bce3d7dfa60abc511fccda1ba5b13b2628b7`.

## Result and boundaries

Central pipeline, enumeration, Solver, startup, activity transport and diagnostics
follow the requested baseline. Existing Family definitions, adapters and evidence
are retained. The necessary Family interfaces also remain: execution rounding,
positive actual debit, maximum-input policy, native inventory protection,
transaction-origin proof context, executor-program proof and immutable trial data.
The production amount selector retains the baseline's selection/settlement policy
and passes the existing 0/1 rounding policy to runtime encoding.

The existing Rust `serve-ready` command and bounded Ready transport are retained:
the production Ready client invokes that command, while the requested baseline
source only builds `serve` and refers to a separately supplied Ready executable.
Ready uses a binary rebuilt from the retained source, not an unidentified old
executable. This is a Ready compatibility exception, not a new live scheduler.

No live run, signing, deployment or broadcast is part of this change.

## Unique JSON production entry

`build-declarative-production.ts` resolves an existing entry's static Family ID and
domain before writing. A JSON definition replaces the registration glue for that
same Family, including an entry with a different filename. It does not delete the
Family's handwritten implementation. Unresolved identity, conflicting identity or
domain, duplicate registrations and invalid JSON fail closed; no silent TS fallback
or second live registration is introduced.

The AST resolver accepts only the canonical Family constructors and `familyId`
brand, including aliased imports and shorthand manifests. Local impostors and
shadowed `Object.freeze` cannot authorize overwriting an entry. Generated entries
remain subject to the existing catalog duplicate and closure checks.

## Module-aware fingerprints

`venues/declarative-module-dependencies.ts` owns the audited optional boundaries:

| Shared source | JSON module usage |
| --- | --- |
| `declarative-oracle-victim.ts` | `oracleVictim` |
| `declarative-trial-state.ts` | `trialState` |
| `declarative-pricing-projection.ts` | `pricingProjection` |
| `declarative-instance-evidence.ts` | `instanceEvidence` or `executionProjection` |

Root, standard and child declarations are combined conservatively. Nonempty blocks
count even if their dependencies are currently blocked or a child later overrides
them. Empty/absent blocks do not claim support. Malformed declarations reject.

For an unused audited module, function-body changes do not change that Family's
capability fingerprints. Shared imports are still traversed and hashed. New
top-level effects, unsafe initializers or an unrecognized shape restore the full
source hash. The dependency policy implementation itself is also hashed.

This is intentionally not arbitrary function-level impact analysis. Shared core,
safety checks, and unaudited files remain conservative. `declarative-read-flow.ts`
is not excluded because discovery, swap receipts and credit evidence also use it
outside the optional module blocks. Changes within those core files may still
invalidate multiple Families. A TS-to-JSON implementation switch requires fresh
verification; the change does not relabel old Ready hashes.

## Validation and limitations

- Actual checkout: generation, production build and catalog check passed.
- Unified JSON suite: 666 tests, 665 passed, one skipped, zero failed.
- Positive-output/rounding and settlement regressions: 36 passed. The original
  one-unit positive-output test was retained; final simulation still decides
  economic viability, and a zero minimum is not introduced.
- EVM execution and hop diagnostics: 135 passed, zero failed.
- The central regression run initially reported 405 passes and 48 failures.
  Four failures exposed the missing runtime tolerance plumbing and now pass.
  One was an overwritten pre-existing Family rounding test and now passes.
  Startup ownership passed with its documented `--expose-gc` flag and the exact
  pre-change fixture from `cb8e4af6^`.
- The remaining 42 central test failures also reproduce on the unmodified
  `cb8e4af6` source export. They include stale lexical test environments and the
  PSM materialization fixture. They are retained as baseline limitations, not
  declared passing or silently removed.
- A separate export of the exact prospective committed listener source passed
  generation, production build, catalog check and the unified JSON suite. This
  excludes unrelated pre-existing uncommitted Family additions when generating
  the committed catalog. The actual checkout retains those additions and its
  corresponding generated catalog as uncommitted work.

The Ready test will use the existing oct29/app-run2 candidate base, not rediscover
the historical universe. Its immutable input SHA-256 is
`5420bfd134ed24901199da494a7d20e972607d8909951869828a5e408f300374`:
162,174 candidates, 73,169 admitted instances, cutoff 26222895. Original cache and
evidence are preserved; the new run owns a separate output. Build/unit results are
not a claim that this new Ready run, all Family acceptance or live performance has
passed.

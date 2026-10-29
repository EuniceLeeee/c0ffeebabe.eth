# protocol:token-conversion — declarative migration blocked (2026-10-29)

Status: **STOPPED / no draft**. The family has two required variants
(`token-conversion:btb-bear-v1` and `token-conversion:xwin-allocations-v1`).
The BTB variant's asset-dependency proof is an EVM opcode interpreter, which
protocol-json-v2 values cannot express; moving it into a math entry is outside
the sanctioned math surface. A draft covering only xWin (or only the audited
BTB asset template) would narrow the family and was not authored.

## Source of truth read

`venues/protocols/token-conversion-family/*.ts` (identity, exact, pricing,
execution, simulation, discovery, variants, asset-runtime, bear-local,
trial-state, sequential, xwin*/types, manifest) and
`test/{contract,xwin-contract,history-evidence,trial-composition,xwin-*}.ts`.

## Blocker B1 — generic asset dependency closure needs bytecode disassembly

- BTB identity proves the conversion asset's dependency closure with
  `proveLocalAssetRuntime(code)` (`variants.ts:32-49`): it walks every runtime
  byte, decodes `PUSH1..PUSH32` operands (skipping their payload) and rejects
  any opcode outside a local/storage/pure allowlist; only if that walk fails
  does it fall back to the audited exact-template check
  (`asset-runtime.ts:20-24`, template in `asset-runtime.ts:28-47`).
- The JSON value language has no bytecode indexing, loop, or opcode
  classification. Its closed op set is enumerated in
  `venues/declarative-values.ts:22`; the only code-shape helper is fixed-offset
  `maskHash` (`declarative-values.ts:218`), which normalizes known immutable
  words but cannot walk instructions. There is no `bytesAt(code,i)` loop over
  a runtime-sized input (`bytes` slices a fixed offset/length only, same file
  `:217`).
- Consequence: a JSON transcription can keep the audited-template fallback but
  not the generic local-runtime closure. That rejects assets the TS family
  accepts today (any local-only ERC20 runtime that is not the exact archived
  template), i.e. it shrinks the supported instance set. Migration policy
  forbids claiming completion by narrowing coverage, so the family cannot be
  declared migrated.
- Implementing the walk as a declarative `math` model is not a valid escape:
  the module contract says math entries are pure local quote/transition models
  and "普通 ABI、授权、调用顺序、回调和结算不能藏进数学函数"
  (`docs/research/design/protocol-json-module-evolution-20261028.md:39`);
  runtime-identity proof logic in a math model would be protocol semantics
  hidden behind the math slot. A future framework extension would need an
  explicit bytecode/opcode-proof primitive (or a sanctioned identity-model
  slot distinct from `math`), not a Family-defined math entry.
- This is a *Family coverage* blocker, not a claim that all assets are
  unverifiable: the audited BTB asset template check itself is expressible
  (`codeHash`/`maskHash`/`bytes`), and the BTB token template check
  (`variants.ts:59-77`) plus its EIP-712 domain words can be reconstructed
  from constants/word concatenation. The gap is only the generic local-runtime
  branch.

## Remaining migration surface (not authored; no framework verdict claimed)

- **xWin identity** (`xwin-identity.ts:16-71`, `xwin.ts:45-92`): surface code,
  EIP-1967 implementation word, token/swap/oracle/locking getters, target list,
  supply, dependency codes/decimals; then mint+redeem effect simulations.
  `maskHash`/`codeHash`/`get-storage`/raw `effect-delta-simulation` requests
  cover the proof shapes. The Transfer-log count/order/value assertion
  (`xwin.ts:156-166`) needs `effects`+log filtering+`event` ops; it was not
  authored/tested.
- **xWin pricing/exact local state** (`xwin-pricing.ts`, `xwin-local.ts:83-...`,
  `xwin-transition.ts:94-177`): six fixed dependent read rounds with request
  arrays that fan out over tokens/pairs/oracles/feeds, then the full local fund
  transition over `Map`-bearing state (balances, V3 pools, tick bitmap/ticks).
  The 6876fef0 framework explicitly supports Map trial state and dynamic
  request projections (§4/§5 of the gaps doc), so this looks expressible but is
  a large transcription: it needs an `executionMath`/`math` entry for the V3
  transition and a trial-state definition matching
  `local-state-models/resources.ts` / `v3-state.ts` refs. It was not authored.
- **BTB trial state** (`trial-state.ts:30-42`, `bear-local.ts`): two refs from
  `storageState`/`tokenSupplyState`/`tokenBalanceState`, supply/backing
  transition, quantity quote = min(capacity); expressible with a trial-state
  module + math entry, not authored.
- **Discovery** (`discovery.ts:18-47`): two call patterns per variant, calldata
  length checks (74/138 bytes) and canonical re-encode; v2 mapped discovery
  predicates (`length`/`matches`/`encode`/`eq`) can express these, but the
  `variantHint` selection between two child variants still needs testing.

## Re-entry checklist

1. Decide the sanctioned surface for generic runtime dependency proofs
   (framework primitive or explicitly allowed identity model). Without it the
   BTB local-asset branch cannot be migrated faithfully.
2. If a sanctioned model slot is added, re-run `test/contract.ts` and
   `test/xwin-contract.ts` (24k/40k assertions) against the rendered entry.
3. Author the two child variants and the xWin Map trial state; the JSON
   entry must keep both lineages (2 variants) and both directions.

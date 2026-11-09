# Family simulation through node RPC

This is a shared transport change on `codex/family-runtime-actual-20261007`, based on
`f77db38c6033c962d39bc272fa773e2b3ab916c1` plus the existing cloud working tree. It does not
migrate or enable a protocol JSON, publish Ready, deploy an executor, or start live.
Unrelated Family/generated changes in the working tree are not part of this patch.

## State and block environment

| Use | State | EVM block environment | Transport |
| --- | --- | --- | --- |
| Exact implemented by executing a Family program | pinned N | N | `eth_call` with controlled state overrides |
| Same-state quoted/runtime correctness | the same pinned N | N | `debug_traceCall`, original executor |
| Production standalone amount simulation | pinned N | N+1 | existing `eth_simulateV1` simulator |

N is the selected source, not implicitly the reference transaction's block. No N+1
receipt is relabelled as an N quote. A transaction at index 46 also cannot be exactly
replayed merely by selecting its parent block; its relevant intra-block prefix is
a separate replay requirement.

The successful N quote path executes approve/add/remove as one program. The second
operation sees the first operation's state changes. It reads actual balance deltas;
it neither subtracts a safety margin from a two-view quote nor calls Exact to fill
runtime output amounts.

## Shared modules and entry points

Paths below are relative to the repository root.

| File / entry | Responsibility |
| --- | --- |
| `listener/src/searcher/node-strict-source-simulation.ts` / `createNodeStrictSourceSimulation` | Inject the node client into the existing source lease, validation and drain lifecycle. |
| `listener/src/searcher/simulator/node-strict-client.ts` / `NodeStrictClient.strictSimulate` | Pin chain/header/state/code, choose the supported RPC execution shape, dispatch through the shared transport scheduler, and return strict receipts. |
| `listener/src/searcher/simulator/node-input-funding.ts` / `NodeInputFunding.prepare` | Prove direct ERC20 balance slots with node calls; construct isolated input funding without local REVM. |
| `listener/src/searcher/simulator/node-program-quote.ts` / `buildNodeProgramQuote` | Wrap the original deployed BotVM program with independent before/after observations and an authenticated receipt. No protocol ABI or math. |
| `listener/src/searcher/simulator/node-trace-simulation.ts` | Validate traces and logs; carry node-proven post-state between genuine top-level pre-calls. |
| `listener/src/searcher/revm-strict-simulation-transport.ts` | Existing common request/receipt validation, asset boundaries and standalone N+1 entry. Historical `Revm*` names here do not select an engine. |
| `listener/src/searcher/main.ts` / `createLiveSourceSimulationFactory` | Production source factory now injects `NodeStrictClient`; configured local REVM/hybrid live modes reject. |
| `listener/src/searcher/universe-rebuild-production.ts` / `createProbeWiring` | Ready probes use the node source factory and retrieve executor code at the actual cutoff. |
| `listener/src/searcher/test/protocol-json-acceptance-context.ts` | Unified acceptance uses the same node client. Legacy `--revm-bin` is optional and unused. |

JSON retains its existing `declarative-execution-simulation` / effect-delta request
contract. The protocol window supplies its program and consumes observed effects;
it does not supply arbitrary storage/code overrides or its own RPC scheduler. Math,
ABI, approval and callback actions remain Family-owned declarations.

The old source owner and strict transport are deliberately retained. Their source
retirement, validation, cancellation, drain and receipt checks are still needed;
renaming every `Revm*` type would obscure this transport change. Historical tools
outside the switched production/Ready/unified-acceptance entries were not globally
rewritten.

## Caller, code and funding safety

- The original executor performs protocol calls and balance observations. A random,
  previously empty recorder only records values supplied by that executor. It does
  not replace the executor, owner or a protocol's code.
- Canonical Exact uses an authenticated terminal revert receipt. Tag, exact length,
  diagnostic key, target and flow are checked. Quoted/runtime correctness uses a
  returning receipt and matches actual traced calls by caller, target and calldata.
- Startup executor bytecode is a capability checked again at pinned N. It is not
  automatically inserted into historical state. Explicit counterfactual acceptance
  is separate and cannot silently stand in for deployed-code evidence.
- Transaction origins must be empty accounts or exact EIP-7702 delegation
  designators. Arbitrary code-bearing actors are not impersonated by replacing their
  code with an EOA/helper trampoline.
- Input funding adds to existing input inventory. A bounded slot nomination is
  followed by two isolated, distinct sentinel proofs. No holder/pool balance is
  debited, and no allowance or whitelist slot is changed.
- Cross-source caches contain slot hints only. Each new source proves the hint
  again. Completed immutable source facts may be reused; a cancelled first request
  cannot leave a poisoned promise for subsequent requests.
- Nested OOG/invalid execution remains incomplete evidence, not a deterministic
  protocol revert. Failure and rollback checks retain the established strict
  result contract. Final repayment/profit/native/conservation gates are unchanged.

## Supported RPC surface and remaining compatibility limits

The current Alchemy endpoint was actually exercised with pinned `eth_call` plus
state overrides, `debug_traceCall` using `callTracer` and `prestateTracer`, and
`eth_simulateV1`. There is no Alchemy-specific method. A future own node must expose
these methods, historical state and their required override/tracer options; an own
node has not yet been tested. Alchemy rejected `muxTracer`, so the compatibility
path uses the two standard tracers separately.

The default successful canonical Exact path does not trace. Initial funding/source
checks and the temporary recorder's code check are additional RPC work. Claims
such as “one RPC total” or “as cheap as a view” are not justified.

These cases currently fail closed, without local REVM fallback:

- nonlinear/share-based ERC20 balance storage, or direct slots outside the bounded
  search; a read agreeing with one sentinel is insufficient proof;
- arbitrary contract-frame impersonation not expressible through the configured
  executor and original transaction origin;
- raw storage/code observations after an execution prefix;
- node-reported account deletion in the top-level prestate compatibility path;
- native balance observation of another account through the executor wrapper.

Consequently this is not a claim of historical parity for every installed Family
or every former REVM request shape. The existing deployed live process was not
replaced with this candidate.

## Executed Curve component evidence

Reference transaction:
`0x818167c4c61e14c0a9f86512a52ab1fb37b4d026e47216c833a1f251b498a5c2`,
block 26373824, index 46. Pool:
`0x635ef0056a597d13863b73825cca297236578595`.

The source for this component test is **26373823**, hash
`0xeac119cb4a64681b2d79b5028a6f353ae1d7e23b3c8af80d986941e63140b251`.
The sample says parent-block-end explicitly; it is not a full transaction-prefix
replay or a natural Ready/Graph result.

| Measurement | Raw units |
| --- | --- |
| crvUSD requested input and actual debit | `13841602413681833810310` |
| GHO Exact output | `13800279483077820555379` |
| GHO quoted execution actual receipt | `13800279483077820555379` |
| GHO runtime execution actual receipt | `13800279483077820555379` |
| Input/output tolerance used | `0 / 0` |

The runtime leg is constructed before requesting Exact. Both encodings pass the
common execution-fact checker with additional old input/output inventory, zero LP
residue and zero native delta. Both reject missing input and a forced terminal
failure; four negative cases pass the common revert/rollback fact checker.
Standalone simulation separately succeeds with target block **26373824 = N+1**.

The test consumes the other window's frozen, disabled Curve JSON as an explicit
file. Its hash is recorded in the evidence; this patch does not enable it. Use
`listener/src/searcher/test/fixtures/node-rpc/curve-lp-add-remove.json` and the
component runner `searcher:node-rpc-family-case` to repeat. That runner is deliberately
limited to one Swap identity variant and one execution root and rejects other
shapes; it is not a substitute for unified Ready-based Family acceptance.

An additional real-node compatibility probe executed two ERC20 transfers as
top-level pre-call/main call, carried the node's post-state, and measured `-10/+10`
units and two logs. This tests that compatibility path, not a second protocol's
adaptation.

## Validation and handoff status

- Current-source `build:live`: PASS.
- Focused source/transport/node/acceptance-context regressions: 186/186 PASS.
- Relevant production factory/lease/drain regressions: 6/6 PASS.
- Node safety tests: 7/7 PASS, included in the shared JSON suite.
- Full shared JSON suite: **725 tests, 723 pass, 1 fail, 1 skip**. The failure is the
  pre-existing orphan `badger-sett-withdraw.generated.ts`, which prevents the
  installed-definition regression plan from being built. The unrelated file was
  preserved; this is not a full all-Family regression pass.
- A broader runtime-loop harness also has pre-existing missing
  `logBlockScanAmountEvent` VM stubs. Twenty representative failing tests were
  repeated against the exact pre-change `main.ts` and also failed. The specific
  factory/drain tests above passed. These unrelated failures were not erased.

The source snapshot used for local build/tests is copied from the actual cloud
tree, including its existing dirty Family files; changed file hashes are compared
before cloud upload. Cloud node tests and the real component case ran through the
current generated tool inventory. Query: `node,rpc,simulation,component-execution`;
executed IDs: `listener:searcher:node-rpc-simulation` and
`listener:searcher:node-rpc-family-case`. The deliberate public summary in
`../reports/node-rpc-family-simulation-20261109.json` records artifact hashes and
their reconciliation with the manual same-state measurements. Raw artifacts stay
under ignored `logs/node-rpc-family-sim-20261109/` locally and `/tmp/` on the VM.

**Latency remains unverified.** Another window's real live run was active on this
machine during correctness testing. Individual quote/sim wall times are retained
as observations, not accepted performance results. No 3×3 production-stage or
representative-background acceptance was run. Before measuring, require idle
resources, freeze the actual definition/config/Ready/workload and predeclare a
budget from the applicable production stage. Reuse the existing production
`benchmarks/live-stage.ts` path; do not create a separate benchmark scheduler or
call the component runner a representative live test.

For the JSON window: continue using the common declarations and common acceptance
suite. Use deployed executor code at the tested source by default; choose explicit
counterfactual mode only when that is the intended, labelled experiment. Preserve
unsupported cases and the outstanding all-Family/latency limitations. No Ready14
checkpoint, price table, live activation list or running service was changed here.

# Badger Sett liquid-share withdrawal

Default disabled: `SEARCHER_FAMILY_BADGER_SETT_WITHDRAW_ENABLED=1` is an explicit opt-in.
One protocol direction: TheVault 1.5 shares -> AURA through `withdraw(uint256)` (no ABI return).
Not ERC4626, deposit/mint, generic Aura, generic Badger, arbitrary strategies, or locker unlocking.

## Identity and evidence

Source proof: exact runtime hashes in codec.ts, both EIP1967 implementation/admin slots,
vault.strategy(), strategy.vault()/want()/LOCKER(), vault.token(), locker.stakingToken(),
asset/vault decimals. No instance-address allowlist or factory-creation claim.
Unknown code/variant or reciprocal binding is retryable, not a permanent rejection.
Pause/liquidity/fees are current state, not permanent identity.

Saved public source and N-state evidence:
`logs/graviaura-preflight-20261007.KVf2ht`.
Public endpoint: `https://eth.blockscout.com/api/v2/smart-contracts/<address>`.

| Source | Address | Primary source SHA256 |
| --- | --- | --- |
| Transparent proxy | 0xba485b556399123261a5f9c95d413b4f93107407 (also strategy proxy) | 3df03e3cd1f1e97ce0d870facf42606bc0670b83e0f1bbc6ee4f181496bdca36 |
| TheVault | 0x60c796acb2e0949178086294f03a44c450511784 | 73d9fc5f0c1a7c1f23d22f8a6788fdf899606958906047e2da7ba7a06e93ed4e |
| MyStrategy | 0x7c2a951d062cc7b7c6f9c7aa7e80a6f20eaa8cab | 09db2e6af321627f6a1fd596517336d7f1a522bdaf4a8de9fd4a5dbafa8cecc9 |
| AuraToken | 0xc0c293ce456ff0ed870add98a0828dd4d2903dbf | a409d03cdbd50063e5d52dc79ee8040007f1e8faf7956dd2acdada89e5345c47 |
| AuraLocker | 0x3fa73f1e5d8a792c80f426fc8f84fbf7ce9bbcac | 4a9e11d25f8a9297c1764cb0072affebfd34a0e38c9c5137a50e0150bf068d3a |

Preflight design.txt SHA256: 48f898f489d0d76444939e3e2729ef84ae493783742b4b39247be78b5a5a9f18.
provenance.json SHA256: 65e6e4ae8a1542d8a1cf17f823ce8c7579f93a6acb4a2650f2324d0a6a1fe979.
Core Solidity0.6.12 optimizer200 executable bodies independently matched; trailing53-byte CBOR differed.
AURA/locker Solidity0.8.11 optimizer800 metadata-none matched after declared immutable binding.
All deployed runtimes matched the public explorer bytes. This is source/behavior proof, not factory provenance.

## Exact and branch coverage

`B=V+W+L`; `gross=floor(B*q/S)` before share burning. Never multiply the floored PPS.
q>0, q<=S and source SafeMath bounds required. Caller inventory is a route-input precondition:
no fictitious executor share balance is read or installed by Exact.

Supported:
- vault idle covers gross (strategy pause is irrelevant);
- otherwise strategy idle covers the complete deficit and strategy is not paused;
- locked backing may be nonzero if the actual amount needs no unlocking;
- zero fee, fee floor, fee-share floor and last-share fee mint;
- safety check true/false, including its uint256 multiplication;
- locker shutdown/guest list do not block the liquid redemption path.

Explicit decline:
- deficit>strategy idle: processExpiredLocks, expiry/shutdown reward/delegation,
  safety/deviation shortfall outcomes are unimplemented (not a permanent identity denial);
- treasury==executor when fee shares would be minted (net burn would differ);
- zero/over-supply positive quote, paused applicable branch, zero output or overflow.
Native eligibility, recipient transfer, nonReentrant and fee-mint reverts remain final-simulation obligations.
The supported fully liquid branch cannot take deviation/shortfall adjustment, so no haircut is invented.

Read-state local Exact uses existing request/dependent rounds and shared trial state.
No chainAmountQuote/stateOnlyReads/reusePolicy claim. Repeated same-vault trial withdrawals update
supply, both idle balances, and fee shares; dirty shared dependencies refuse baseline reload.
Acquisition/sale touching only executor share/AURA inventory does not invalidate pool accounting.

## Refresh and execution

Each-block effective/Exact refresh re-resolves all source-pinned proxy and dependency bindings,
even on quiet blocks. Production raw mids remain immutable bootstrap sizing references.
Any binding change fails old descriptor; supported replacement recovers through normal identity
recheck/re-admission and a new Ready-root dependency index. No automatic in-place rebind is claimed.

Runtime construction reads no amount, quote, Exact evidence, provider or RPC. It emits native
withdraw with r0 at calldata offset4, no approval or pretransfer. VM instructions check current
getter bindings, liquid capacity, share debit, and AURA delta independent of old inventory.
Source runtime-code/proxy-slot verification remains in the production state/Exact issuer; this
Family adds no central VM opcode. Native protocol guards and final simulation still apply.
The enclosing production runtime-amount-flow measures actual AURA receipt for the next hop.
The quoted buildFragment stays amount/evidence bound and encodes the same guards with fixed q
and an extra min-receipt guard; it does not replace the explicit Exact API.

## Offline checks and remaining acceptance

From listener, after installing the normal dependencies. A clone needs no ignored logs,
RPC configuration or preflight archive for the ordinary offline checks:

```sh
env -u BADGER_SETT_PREFLIGHT node --import tsx --test src/searcher/venues/protocols/badger-sett-withdraw-family/test/{contract,runtime,refresh,selector,provenance}.ts
./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

`test/public-state.json` contains only five public runtimes, seven ABI-encoded results,
the verified ABI function fragments used by these tests, the N block-end anchor and
source/runtime hash commitments. It contains no request envelopes, endpoint URLs or credentials.
`fixture.ts` reads it relative to its own file, not the process working directory.
The always-on provenance test checks these commitments, not the absent original archive.

Full retained-source verification is separate and explicitly selected. With the variable
unset, that one archive-only test is reported **SKIP**, never accepted as historical proof.
An explicitly named missing/corrupt archive fails rather than skipping or falling back:

```sh
BADGER_SETT_PREFLIGHT=/absolute/path/to/retained-preflight node --import tsx --test src/searcher/venues/protocols/badger-sett-withdraw-family/test/{contract,runtime,refresh,selector,provenance}.ts
```

To deliberately regenerate the public JSON from the same retained archive (offline only):

```sh
BADGER_SETT_PREFLIGHT=/absolute/path/to/retained-preflight node --import tsx src/searcher/venues/protocols/badger-sett-withdraw-family/test/export-public-state.ts
```

The exporter verifies the unchanged source hashes, deployed-runtime hashes, matching proxy
runtimes and N anchor, then copies only allowlisted public results and independently verified
ABI fragments. It reports the generated file SHA256; it never fetches missing evidence.
Transport transitions, test catalog labels and VM instruction interpretation are synthetic.
The refresh test uses an explicit synthetic share sizing anchor, not natural production P.
It exercises real lifecycle/Graph/current/Exact/execution issuers without writing a shared catalog.

Not established by these tests: natural single-block discovery/Ready/prices, production P and
canonical TX-amount same-state fork parity, actual BotVM/AURA/next-hop old-inventory isolation,
original call-prestate output equality, fee/lock variants on EVM, six-stage replay or profitability.
N26138511 hash ffdbdda6829f743dc05ad148586e96dc671f31ee30968f07d91963b9de22e771 is BLOCK-END,
not the original TX80334cda... prestate. No RPC/Ready/fork/live/signing is part of this offline phase.

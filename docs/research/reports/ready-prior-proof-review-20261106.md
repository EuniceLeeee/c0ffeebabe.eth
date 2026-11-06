# Ready updates from a previous checkpoint

A production maintenance update uses a scoped supplement when only new Families are enabled. Every other update reviews in-scope previously admitted Family candidates first, using the ordinary candidate, Family capability, authority and proof-source checks. A failed proof check schedules a fresh strict attempt. Prior rejections, retryable records and new nominations receive independent attempts. The final Graph uses only verified outcomes from the selected universe.

The optional `--candidates FILE` on the production Ready maintenance `update` command takes an exact JSON array of durable candidate snapshots. Omitting it uses the enabled previous candidate partitions and current discovery. The checkpoint selects the previous completed generation. A separate destination can inherit a completed checkpoint through the existing store. A review binds its scope and source plan across interruption. The existing legacy run's journal is resumed under its original policy.

## Evidence at block 26222895

The block hash was `0x3963feb050e7486f66e2c09595f12dc42206a78b51b2c287caaa1a3e99ceb59c`.

| Pool | Candidate evidence TX | Production strict and Graph |
|---|---|---|
| `0x177f07c0843776b2a6342ed6c488af64e6f2fd65` | `0x22c3a4252e43ee315fdf5a3de0b73a16796b783923ae63aec9963329a1d3a394` | Uniswap V3 standard terminally rejected on factory reverse binding. Algebra Integral verified and published two opposite token edges. |
| `0xed1050e2fe96f7327dc659613c79e41458e9cf05` | `0x95adf78e53480d380e521b724b130099e7b13d228dd8d8612cfc2770f5474c3f` | Kyber Elastic remained retryable on the fee-units read. Algebra Integral independently rejected the factory reverse binding. A pinned poolByPair call returned the zero address. |

The bounded cached-input production runner published generation 2 with four candidates, one verified, two terminal and one retryable. The production maintenance CLI selected three of those four records in generation 3. It checked and reused one previous proof, processed the remaining two, and published the two Algebra edges. This is scope, proof and Graph evidence at a fixed historical block. It does not measure sustained performance or prove execution or profit.

The runner and maintenance regressions cover removal of a previously admitted candidate, deferred strict after a stale proof, independent Family results and interrupted review recovery. The production build passed. The wider production wiring test still stops at its pre-existing PSM/wstETH fixture assertion, also present in the November 5 central baseline log. The long running Ready was resumed separately at four workers and eight items per batch using its own original checkpoint.

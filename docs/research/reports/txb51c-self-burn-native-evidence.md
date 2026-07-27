# Landed evidence — self-burn-native tx `0xb51c…23a7`

- Transaction:
  `0xb51c9e139384978731d58c526d337bf78ac223647c5c0b570a574855bda723a7`
- Canonical block/index: `25619948 / 63`
- Status: `1`
- Same-actor predecessor used for the exact intra-block state anchor:
  `0x2fbb82b50a966e5080187f0ed7b488200f830f05eba5fe14cf8e17bd8c56bf36`
  at index `62`. This is not classified as an external public-mempool victim.
- Family leg: token `0x292a477e521230fe230c13c93374adde8ddec1c1`
  executes `transfer(token, amount)` and pays native ETH to the caller.
- Input burned in the landed receipt: `12306616935116519` token wei.
- Native payout: `12183550765765354` wei.
- WETH wrapped for the closing leg: `12098506946212668` wei.
- Gross native remainder: `85043819552686` wei.
- Balancer USDT principal: `23416320`; closing USDT output and repayment:
  `23416320` (exact).
- Conservative landed net-profit reference used only as fixture
  classification evidence: `canonicalNetProfitUsd = 0.12`.

This document records the landed transaction. It does not supply a solver
amount, quote, verified route, calldata, discovery admission, or expected
challenger output.

## Adapter-family acceptance

- Frozen production universe: `14,917` pools,
  SHA-256 `4a069469a1f4d14204ce520dd54de3e83ccdee8e58656ac9de7003874d142a60`.
- The production discovery pass evaluated `675` behavior candidates, admitted
  `86` instances across registered protocol families, and published `8` new
  graph pools. The target instance was admitted without a token address,
  protocol name, implementation hash, or route allowlist.
- The current-block graph contained `28,967` edges. All `3/3`
  `protocol:self-burn-native` instances had positive current-block mids.
- Main without the branch rejected this fixture at registry lookup with
  `unsupported execution family protocol:self-burn-native`; the branch accepted
  it and its two-independent-instance conformance test passed.

The exact-state replay applied the canonical predecessor through sender nonce
`194693`; its local receipt matched the canonical `15` logs with SHA-256
`7b2c6b8c34192bab95fab69cf0246d178cf5c8e8f91d0d18725908f93954da44`.
The production solver then chose its own amount; the fixture supplied no amount,
quote, admission result, plan, calldata, or expected output:

- selected flash amount: `23249980` USDT wei;
- quote search: `34/54` positive;
- final-sim gross profit: `159874` USDT wei;
- final-sim gas: `445748`;
- calldata SHA-256:
  `d83e4255dc2b84831026ab8519faa4f8cb72cf13627cabad9c322de83c3d3cf1`;
- lender balance before/after: `119937207414 / 119937207414`;
- ETH/USD: `1934.32`;
- production EV: `23661565275809` wei, positive;
- adapter replay verdict: `adapter_replay_pass`.

The production stage diagnosis is:

1. exact intra-block state reconstruction: pass;
2. generic instance discovery and graph projection: pass;
3. the full scanner retained multiple exact-refine-positive opportunities using
   this self-burn instance; pass for family availability;
4. planner, solver, final sim, repayment/conservation, and EV: pass on the
   trace-derived three-leg route with solver-selected sizing;
5. the historical expected-route gate did not retain the competitor's exact
   V3/V3 venue combination. This is recorded as a separate scanner route
   selection/diagnostic limitation; this evidence does not claim that exact
   competitor route was naturally selected.

The landed analysis was executed through the repository tool runner using node
manifest SHA-256
`26329c161fb75c61f5143c90a3c1f91e88bd7050223a0bb665bbf2ef470d54bc`.
It classified the transaction as an `atomic_loop`, with realized net
approximately `$0.12`.

Current-block family state took roughly `10–16s` in the cold historical
full-graph runs. Per the acceptance scope, latency is recorded but is not a
blocker for this adapter-family branch.

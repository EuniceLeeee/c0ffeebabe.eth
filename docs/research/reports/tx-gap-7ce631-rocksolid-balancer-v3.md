# TX-gap resolution: RockSolid + Balancer V3

## Sample

- Transaction: `0x7ce631b94570e8ebcaea60e93ccfb808327087405e6f0561450d4bb7f69b3c87`
- Execution block: `25535037`
- Scope: atomic DEX + permissionless-protocol closed loop
- Route: UniV3 WETH -> rETH, RockSolid sync deposit, Balancer V3 rETH -> RockSolid rETH, UniV3 rETH -> WETH
- Challenger production commit: `1741772d03c8fd62cab176aa8bcf5b16b3d2b450`
- Promotion base: `72c9e06`

## Six-step acceptance

The integrated production tree was tested with the existing loop fork gate:

```text
cd listener
npm run build
npm run searcher:loop-fork-gate -- \
  --fixture src/searcher/test/fixtures/loops/rocksolid-balancer-v3-7ce631.json \
  --with-solver
```

Result: `blockscan-fork-solve (loop-fork-gate) PASS (10/10)`.

1. Scanner/admission: all four route edges were admitted, including RockSolid and Balancer V3; the production scanner emitted the repeated-token ring.
2. Planner: `candidate_plans > 0`; the ordered route was WETH -> rETH -> RockSolid rETH -> rETH -> WETH.
3. Quote/sizing: solver quote search found positive points and sized the route; the solver output was `netProfit=150217445981980` wei.
4. Fork execution: real adapter calldata executed successfully and closed the flash loop; realized gross profit was `150817806425095` wei.
5. EV: the solver's net output remained positive after the configured safety floor.
6. Baseline flip: the paired planner fixtures recorded the unsupported route as absent and the challenger route as admitted; the same route's stage advanced from no route/zero plans to a composed, simulated route.

## Production change

The change adds Balancer V3 pool identity/admission, quoting, planning, calldata encoding, and RockSolid sync-deposit/redeem integration. It also keeps the existing factory/identity gates and routes Balancer V3 through the common block-scan external-mid path.

No live or latency gate was used for this closure. This is a deterministic historical replay and is being closed under the six-step tx-gap acceptance contract.

## Resolution

This report is the promotion record for the frozen challenger. The integration commit is merged into `main`; the original `ab/rocksolid-balancer-v3-production` branch and worktree may be removed after the merge.

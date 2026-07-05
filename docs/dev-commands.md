# Dev Commands — fork test / trace / discovery

> Reference manual, not constitution. CLAUDE.md points here.

## Fork testing (primary workflow)
```bash
forge test --fork-url $MAINNET_RPC_URL --fork-block-number 24710787 -vvvv           # all fork tests
forge test --match-test testReplayArbitrage --fork-url $MAINNET_RPC_URL --fork-block-number 24710787 -vvvv
```

## Trace / calldata / balances
```bash
cast run <txhash> --rpc-url $MAINNET_RPC_URL                                          # trace a tx
cast 4byte-decode <calldata>                                                          # decode calldata
cast call <token> "balanceOf(address)(uint256)" <addr> --rpc-url $MAINNET_RPC_URL --block 24710787
```

## Address / log discovery
```bash
cast receipt <txhash> --rpc-url $MAINNET_RPC_URL --json | jq '.logs'
```

## Node deploy (the ONE broadcast-safe op — details in `docs/research/HERMES.md`)
```bash
aws ssm send-command --instance-ids i-0ff908dedeec9ebc6 --document-name AWS-RunShellScript \
  --parameters 'commands=["git -C /opt/MEV fetch origin -q && git -C /opt/MEV show origin/main:scripts/deploy-node.sh | sudo bash"]'
```

## Validation gates
Searcher-change gates + harness commands: `docs/research/gates.md`. Trace-diff / reproduction review
methodology: the `mev-review` skill.

#!/usr/bin/env python3
"""Generate a real S1 capture descriptor from node data.

Reads the immutable pool universe snapshot and the live protocol evidence
cache, picks one real instance per family, and writes a descriptor for
`run-architecture-migration-capture-real-cli.ts --onchain`. Only real
addresses found in node data are emitted; families without a real instance
are omitted (never fabricated).
"""
import json
import sys

universe_path = sys.argv[1]
cache_path = sys.argv[2]
out_path = sys.argv[3]
source_block = int(sys.argv[4])
source_block_hash = sys.argv[5]

universe = json.load(open(universe_path))
pools = universe["pools"] if isinstance(universe, dict) and "pools" in universe else universe

dex_families = {
    "univ2": ("univ2", "univ2"),
    "univ3": ("univ3", "univ3"),
    "univ4": ("univ4", "univ4"),
    "curve-underlying": ("curve-underlying", "curve-underlying"),
    "dodo-v2": ("dodo-v2", "dodo-v2"),
    "fluid-dex": ("fluid-dex", "fluid-dex"),
}
cases = []
used_adapters = set()
for pool in pools:
    adapter = pool.get("adapter")
    if adapter in dex_families and adapter not in used_adapters:
        used_adapters.add(adapter)
        family = dex_families[adapter][0]
        case = {"family": family, "pool": pool["address"]}
        if "token0" in pool and "token1" in pool:
            case["tokenA"] = pool["token0"]
            case["tokenB"] = pool["token1"]
        if "fee" in pool:
            case["fee"] = pool["fee"]
        if "tickSpacing" in pool:
            case["tickSpacing"] = pool["tickSpacing"]
        if "factory" in pool:
            case["factory"] = pool["factory"]
        if "tokenIn" in pool:
            case["tokenIn"] = pool["tokenIn"]
        if "tokenOut" in pool:
            case["tokenOut"] = pool["tokenOut"]
        cases.append(case)

cache = json.load(open(cache_path))
verified = cache.get("verified_candidates", {})
if isinstance(verified, dict):
    verified = verified.values()
protocol_field = {
    "erc4626": "vault",
    "erc4626-silo-redeem": "vault",
    "astra-multitoken": "target",
    "eigenpie": "target",
    "ethertoken-native-redeem": "token",
    "self-burn-native": "token",
    "fluid-credit": "vault",
}
protocol_family = {
    "erc4626": "protocol:erc4626",
    "erc4626-silo-redeem": "protocol:erc4626-silo-redeem",
    "astra-multitoken": "protocol:astra-multitoken",
    "eigenpie": "protocol:eigenpie",
    "ethertoken-native-redeem": "protocol:ethertoken-native-redeem",
    "self-burn-native": "protocol:self-burn-native",
    "fluid-credit": "credit:fluid",
}
used_protocol = set()
for entry in verified:
    adapter = entry.get("adapterId")
    if adapter not in protocol_family or adapter in used_protocol:
        continue
    pool = entry.get("candidate", {}).get("pool", {})
    address = pool.get("address")
    if not address:
        continue
    used_protocol.add(adapter)
    cases.append({
        "family": protocol_family[adapter],
        protocol_field[adapter]: address,
    })

manifest = {
    "sourceBlock": source_block,
    "sourceBlockHash": source_block_hash,
    "captureId": f"s1-real-corpus-{source_block}",
    "onchain": True,
    "cases": cases,
}
with open(out_path, "w") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
print(json.dumps({
    "families": [c["family"] for c in cases],
    "caseCount": len(cases),
}, indent=2))

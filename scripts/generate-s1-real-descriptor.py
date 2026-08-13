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

def normalize_generic_case(case):
    """Generic mode only needs {family, address}; drop per-family fields."""
    address = (case.get("pool") or case.get("vault") or case.get("target")
               or case.get("token") or case.get("fundingContract"))
    if not address:
        raise SystemExit(f"case {case.get('family')} has no address")
    return {"family": case["family"], "address": address}

universe = json.load(open(universe_path))
pools = universe["pools"] if isinstance(universe, dict) and "pools" in universe else universe

dex_families = {
    "univ2": ("univ2", "univ2"),
    "univ3": ("univ3", "univ3"),
    "univ4": ("univ4", "univ4"),
    "dodo-v2": ("dodo-v2", "dodo-v2"),
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
        cases.append(normalize_generic_case(case))

cache = json.load(open(cache_path))
verified = cache.get("verified_candidates", {})
if isinstance(verified, dict):
    verified = verified.values()
protocol_field = {
    "protocol:erc4626": "vault",
    "protocol:erc4626-silo-redeem": "vault",
    "protocol:astra-multitoken": "target",
    "protocol:ethertoken-native-redeem": "token",
}
protocol_family = {
    "protocol:erc4626": "protocol:erc4626",
    "protocol:erc4626-silo-redeem": "protocol:erc4626-silo-redeem",
    "protocol:astra-multitoken": "protocol:astra-multitoken",
    "protocol:ethertoken-native-redeem": "protocol:ethertoken-native-redeem",
}
used_protocol = set()
for entry in verified:
    adapter = entry.get("adapterId")
    pool = entry.get("candidate", {}).get("pool", {})
    address = pool.get("address")
    if not address:
        continue
    if adapter == "fluid-dex":
        used_protocol.add(adapter)
        case = {"family": "fluid-dex", "pool": address}
        if pool.get("factory"):
            case["factory"] = pool["factory"]
        if pool.get("token0") and pool.get("token1"):
            case["tokenA"] = pool["token0"]
            case["tokenB"] = pool["token1"]
        cases.append(normalize_generic_case(case))
        continue
    if adapter not in protocol_family or adapter in used_protocol:
        continue
    used_protocol.add(adapter)
    case = {
        "family": protocol_family[adapter],
        protocol_field[adapter]: address,
    }
    if adapter == "protocol:erc4626-silo-redeem" and pool.get("token1"):
        case["target"] = pool["token1"]
    if adapter == "protocol:astra-multitoken" and pool.get("token0") and pool.get("token1"):
        case["tokenIn"] = pool["token0"]
        case["tokenOut"] = pool["token1"]
    cases.append(normalize_generic_case(case))

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

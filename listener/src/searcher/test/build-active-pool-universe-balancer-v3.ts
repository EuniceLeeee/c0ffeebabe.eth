import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  BALANCER_V3_SWAP_TOPIC,
  buildBalancerV3PoolEntries,
  type RawLog,
} from "../build-active-pool-universe.js";

const POOL = "0xbb6f701f42a6104deffc041c5c0057b8a9c46bbc";

function topicAddress(address: string): string {
  return ethers.zeroPadValue(address, 32);
}

function log(block: number): RawLog {
  return {
    address: ADDR.BALANCER_V3_VAULT,
    topics: [
      BALANCER_V3_SWAP_TOPIC,
      topicAddress(POOL),
      topicAddress(ADDR.ROCKSOLID_RETH),
      topicAddress(ADDR.RETH),
    ],
    data: ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "uint256", "uint256"],
      [1n, 2n, 3n, 4n],
    ),
    blockNumber: `0x${block.toString(16)}`,
  };
}

const entries = buildBalancerV3PoolEntries([log(100), log(101)], 2);
if (entries.length !== 1) throw new Error(`FAIL: expected one pool, got ${entries.length}`);
const [entry] = entries;
if (entry.address.toLowerCase() !== POOL.toLowerCase()) throw new Error(`FAIL: indexed pool ${entry.address}`);
if (entry.address.toLowerCase() === ADDR.BALANCER_V3_VAULT.toLowerCase()) throw new Error("FAIL: emitter admitted as pool");
if (entry.adapter !== "balancer-v3" || entry.venueId !== "balancer-v3") throw new Error("FAIL: venue metadata");
if (entry.swapCount30d !== 2 || entry.lastSwapBlock !== 101) throw new Error("FAIL: activity metadata");
if (buildBalancerV3PoolEntries([log(100)], 2).length !== 0) throw new Error("FAIL: minSwaps gate");
console.log("build-active-pool-universe-balancer-v3 PASS (1/1)");

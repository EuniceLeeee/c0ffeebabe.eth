import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  candidatesFromLog,
  strictCatalogLogTopics,
} from "../universe-rebuild-production.js";
import { balancerFlashDiscovery } from
  "../venues/funding/balancer-flash-family/discovery.js";
import { morphoFlashDiscovery } from
  "../venues/funding/morpho-flash-family/discovery.js";

const TOKEN = ethers.getAddress(`0x${"42".repeat(20)}`);
const SOURCE = Object.freeze({
  number: 25_800_000,
  hash: `0x${"51".repeat(32)}`,
  generation: 25_800_000,
});

assertFundingDiscovery(
  morphoFlashDiscovery,
  ADDR.MORPHO,
  "morpho-flash-loan",
  "FlashLoan(address,address,uint256)",
  ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1n]),
  "flash-loan:morpho",
);
assertFundingDiscovery(
  balancerFlashDiscovery,
  ADDR.BALANCER_VAULT,
  "balancer-v2-flash-loan",
  "FlashLoan(address,address,uint256,uint256)",
  ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [1n, 0n]),
  "flash-loan:balancer-v2",
);

const topics = strictCatalogLogTopics();
assert(topics.includes(ethers.id("FlashLoan(address,address,uint256)")));
assert(topics.includes(ethers.id("FlashLoan(address,address,uint256,uint256)")));

console.log("funding token discovery PASS");

function assertFundingDiscovery(
  discovery: typeof morphoFlashDiscovery,
  provider: string,
  patternId: string,
  signature: string,
  data: string,
  expectedFamilyId: string,
): void {
  const topic = ethers.id(signature);
  const tokenWord = ethers.zeroPadValue(TOKEN, 32);
  const observation = Object.freeze({
    kind: "log" as const,
    source: SOURCE,
    address: ethers.getAddress(provider),
    topics: Object.freeze([
      topic,
      ethers.zeroPadValue(ethers.ZeroAddress, 32),
      tokenWord,
    ]),
    data,
    transactionHash: `0x${"61".repeat(32)}`,
  });
  const candidate = discovery.decodeCandidate({
    observation,
    matchedPatternId: patternId,
  });
  assert(candidate !== null);
  assert.equal(candidate.asset, TOKEN);
  assert.match(discovery.candidateKey(candidate), new RegExp(TOKEN.slice(2), "i"));
  assert.equal(discovery.decodeCandidate({
    observation: Object.freeze({
      ...observation,
      address: `0x${"99".repeat(20)}`,
    }),
    matchedPatternId: patternId,
  }), null, "same topic from an unrelated emitter is not authority");

  const decoded = candidatesFromLog(Object.freeze({
    address: observation.address,
    topics: observation.topics,
    data: observation.data,
    transactionHash: observation.transactionHash,
    blockNumber: SOURCE.number,
    blockHash: SOURCE.hash,
    logIndex: 7,
  }));
  assert(decoded.some((item) =>
    item.familyId === expectedFamilyId &&
    String(item.asset).toLowerCase() === TOKEN.toLowerCase()
  ));
}

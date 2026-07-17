import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import {
  scanObservedProtocolTrace,
  shouldTraceForProtocolDiscovery,
} from "../observed-protocol-discovery.js";
import { erc4626Adapter } from "../venues/protocols/erc4626.js";
import type { ProtocolDiscoveryContext, ProtocolDiscoveryReceipt } from "../venues/route-leg-adapter.js";

const VAULT = "0x1111111111111111111111111111111111111111";
const ASSET = "0x2222222222222222222222222222222222222222";
const USER = "0x3333333333333333333333333333333333333333";
const TX_HASH = `0x${"cd".repeat(32)}`;
const ZERO_WORD = `0x${"0".repeat(64)}`;
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function redeem(uint256,address,address)",
]);
const WITHDRAW = ethers.id("Withdraw(address,address,address,uint256,uint256)").toLowerCase();
const TRANSFER = ethers.id("Transfer(address,address,uint256)").toLowerCase();

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const topicAddress = (address: string): string => ethers.zeroPadValue(address, 32).toLowerCase();
const withdrawLog = {
  address: VAULT,
  topics: [WITHDRAW, topicAddress(USER), topicAddress(USER), topicAddress(USER)],
  data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [100n, 90n]),
  transactionHash: TX_HASH,
  blockNumber: 123,
};
const transferLog = {
  address: ASSET,
  topics: [TRANSFER, topicAddress(VAULT), topicAddress(USER)],
  data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [100n]),
  transactionHash: TX_HASH,
  blockNumber: 123,
};
const receipt: ProtocolDiscoveryReceipt = { status: 1, logs: [withdrawLog, transferLog] };
const context: ProtocolDiscoveryContext = {
  blockNumber: 123,
  fromBlock: 123,
  toBlock: 123,
  candidateTokens: [],
  graphTokens: [VAULT, ASSET],
  retainedInstances: [],
  backend: {
    async call(req) {
      if (req.to.toLowerCase() !== VAULT.toLowerCase()) throw new Error("unexpected target");
      return ERC4626.encodeFunctionResult("asset", [ASSET]);
    },
    async getCode() { return "0x6000"; },
    async getStorageAt() { return ZERO_WORD; },
    async getCodeAt() { return "0x6000"; },
    async getStorageAtBlock() { return ZERO_WORD; },
    async getLogs() { return []; },
    async getTransactionReceipt() { return receipt; },
    async traceTransaction() {
      return {
        to: VAULT,
        input: ERC4626.encodeFunctionData("redeem", [90n, USER, USER]),
      };
    },
  },
};

const known = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt,
  trace: {
    to: VAULT,
    input: ERC4626.encodeFunctionData("redeem", [90n, USER, USER]),
  },
});
assert(known.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1, "known address+selector candidate");
assert(known.unknownSelectors.length === 0, "known protocol call must keep unknown diagnostics clean");

const mixed = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt,
  trace: {
    to: VAULT,
    input: ERC4626.encodeFunctionData("redeem", [90n, USER, USER]),
    calls: [{ to: USER, input: "0x12345678" }],
  },
});
assert(mixed.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1, "known route remains admitted");
assert(mixed.unknownSelectors.length === 1, "mixed tx retains separate unknown-selector diagnostic");

const mintLog = {
  address: ASSET,
  topics: [TRANSFER, ZERO_WORD, topicAddress(USER)],
  data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1n]),
};
const burnLog = {
  address: ASSET,
  topics: [TRANSFER, topicAddress(USER), ZERO_WORD],
  data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1n]),
};
const protocolLike: ProtocolDiscoveryReceipt = { status: 1, logs: [mintLog, burnLog] };
const unknown = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt: protocolLike,
  trace: { to: USER, input: "0x12345678" },
});
assert(unknown.candidatesByAdapter.size === 0, "unknown selector must never produce an edge candidate");
assert(unknown.unknownSelectors.length === 1, "unknown selector must produce one diagnostic");
assert(unknown.unknownSelectors[0].recommendation === "inspect_calltrace", "diagnostic recommendation");

const sameSelectorDifferentAddress = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt: protocolLike,
  trace: {
    to: USER,
    input: "0x12345678",
    calls: [{ to: VAULT, input: "0x12345678" }],
  },
});
assert(
  sameSelectorDifferentAddress.unknownSelectors.length === 2,
  "classification/dedupe key must retain address+selector rather than selector alone",
);

const lpMint = {
  address: ASSET,
  topics: [ethers.id("Mint(address,uint256,uint256)").toLowerCase()],
  data: "0x",
};
assert(
  !shouldTraceForProtocolDiscovery([mintLog, burnLog, lpMint]),
  "LP mint/burn flow must remain LP instead of protocol unknown",
);
const lp = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt: { status: 1, logs: [mintLog, burnLog, lpMint] },
  trace: { to: USER, input: "0x12345678" },
});
assert(lp.unknownSelectors.length === 0, "LP flow must not emit protocol unknown diagnostics");

const mixedLp = { ...lpMint, address: USER };
assert(
  shouldTraceForProtocolDiscovery([mintLog, burnLog, mixedLp]),
  "a separate protocol-like burn+mint must survive unrelated LP activity",
);

console.log("observed-protocol-discovery PASS");

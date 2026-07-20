import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import {
  scanObservedProtocolTrace,
  scanProtocolDiscoveryRange,
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
  "function previewRedeem(uint256) view returns (uint256)",
  "function redeem(uint256,address,address)",
]);
const ERC20 = new ethers.Interface(["function transfer(address,uint256)"]);
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
const shareBurnLog = {
  address: VAULT,
  topics: [TRANSFER, topicAddress(USER), ZERO_WORD],
  data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [90n]),
  transactionHash: TX_HASH,
  blockNumber: 123,
};
const receipt: ProtocolDiscoveryReceipt = {
  status: 1,
  logs: [withdrawLog, transferLog, shareBurnLog],
};

function redeemTrace(target = VAULT, includePayout = true): unknown {
  return {
    to: target,
    input: ERC4626.encodeFunctionData("redeem", [90n, USER, USER]),
    calls: includePayout
      ? [{ to: ASSET, input: ERC20.encodeFunctionData("transfer", [USER, 100n]) }]
      : [],
  };
}
const context: ProtocolDiscoveryContext = {
  blockNumber: 123,
  fromBlock: 123,
  toBlock: 123,
  graphTokens: [VAULT, ASSET],
  retainedInstances: [],
  backend: {
    async call(req) {
      if (req.to.toLowerCase() !== VAULT.toLowerCase()) throw new Error("unexpected target");
      if (req.data.slice(0, 10) === ERC4626.getFunction("asset")!.selector) {
        return ERC4626.encodeFunctionResult("asset", [ASSET]);
      }
      if (req.data.slice(0, 10) === ERC4626.getFunction("previewRedeem")!.selector) {
        const shares = BigInt(ERC4626.decodeFunctionData("previewRedeem", req.data)[0]);
        return ERC4626.encodeFunctionResult("previewRedeem", [shares * 10n / 9n]);
      }
      throw new Error("unexpected selector");
    },
    async getCode() { return "0x6000"; },
    async getStorageAt() { return ZERO_WORD; },
    async getLogs() { return []; },
    async getTransactionReceipt() { return receipt; },
    async traceTransaction() {
      return redeemTrace();
    },
  },
};

const known = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt,
  trace: redeemTrace(),
});
assert(known.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1, "known address+selector candidate");
assert(known.unknownSelectors.length === 0, "known protocol call must keep unknown diagnostics clean");

const siblingPayout = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt,
  trace: {
    to: USER,
    input: "0x12345678",
    calls: [
      redeemTrace(VAULT, false),
      {
        to: USER,
        input: "0x87654321",
        calls: [{ to: ASSET, input: ERC20.encodeFunctionData("transfer", [USER, 100n]) }],
      },
    ],
  },
});
assert(
  siblingPayout.candidatesByAdapter.size === 0,
  "receipt payout must be causally nested under the matching redeem/withdraw call",
);

const ambiguous = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter, erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt,
  trace: redeemTrace(),
});
assert(ambiguous.candidatesByAdapter.size === 0, "multiple full adapter matches must be quarantined");
assert(
  ambiguous.unknownSelectors[0]?.reason === "protocol_like_flow_ambiguous_adapter",
  "ambiguous adapter match must be explicit",
);

let logReads = 0;
let receiptReads = 0;
let traceReads = 0;
const rangeContext: ProtocolDiscoveryContext = {
  ...context,
  backend: {
    ...context.backend,
    async getLogs(req) {
      logReads++;
      assert(req.topics[0] === WITHDRAW, "shared scanner must query adapter-declared topic");
      return [withdrawLog, { ...withdrawLog }];
    },
    async getTransactionReceipt() {
      receiptReads++;
      return receipt;
    },
    async traceTransaction() {
      traceReads++;
      return redeemTrace();
    },
  },
};
const range = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: rangeContext,
});
assert(range.sourceComplete, "shared scanner source must complete");
assert(range.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1, "shared scanner dispatches ERC4626");
assert(logReads === 1, "one block window must be scanned once outside the adapter");
assert(receiptReads === 1, "duplicate event logs must share one receipt read per tx");
assert(traceReads === 1, "candidate parsing and evidence must share one trace read per tx");

const splitSourceContext: ProtocolDiscoveryContext = {
  ...rangeContext,
  backend: {
    ...rangeContext.backend,
    async getCode(address) {
      if (address.toLowerCase() === ASSET.toLowerCase()) {
        throw Object.assign(new Error("local reth code read timed out"), { code: "TIMEOUT" });
      }
      return rangeContext.backend.getCode(address);
    },
  },
};
const splitSource = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: splitSourceContext,
  candidateAddresses: [ASSET],
});
assert(!splitSource.sourceComplete, "address-source timeout must keep the combined pass incomplete");
assert(!splitSource.addressSourceComplete, "address-source timeout must remain retryable");
assert(splitSource.eventSourceComplete, "independent event cursor must still be allowed to advance");
assert(
  splitSource.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1,
  "address-source failure must not discard a fully verified observed candidate",
);

const falseWithdrawContext: ProtocolDiscoveryContext = {
  ...context,
  backend: {
    ...context.backend,
    async call(req) {
      if (req.to.toLowerCase() === USER.toLowerCase()) {
        throw Object.assign(new Error("not an ERC4626 vault"), { code: "CALL_EXCEPTION" });
      }
      return context.backend.call(req);
    },
    async getLogs() { return [withdrawLog]; },
    async getTransactionReceipt() { return receipt; },
    async traceTransaction() {
      return redeemTrace(USER);
    },
  },
};
const falseWithdraw = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: falseWithdrawContext,
});
assert(falseWithdraw.sourceComplete, "ordinary address mismatch must not poison the scan cursor");
assert(falseWithdraw.candidatesByAdapter.size === 0, "Withdraw topic plus selector is not a full match");
assert(
  falseWithdraw.unknownSelectors[0]?.reason === "protocol_like_flow_unverified_match",
  "known selector with insufficient address/receipt evidence must not be mislabeled unknown",
);

const prunedHistoryContext: ProtocolDiscoveryContext = {
  ...rangeContext,
  backend: {
    ...rangeContext.backend,
    async traceTransaction() {
      throw Object.assign(new Error("historical state is pruned"), { code: "SERVER_ERROR" });
    },
  },
};
const prunedHistory = await scanProtocolDiscoveryRange({
  adapters: [erc4626Adapter],
  context: prunedHistoryContext,
});
assert(
  prunedHistory.sourceComplete && prunedHistory.eventSourceComplete,
  "local reth pruned-state evidence gap must not pin an otherwise complete event cursor",
);
assert(
  prunedHistory.candidatesByAdapter.size === 0,
  "pruned historical trace evidence must fail closed instead of using an archive fallback",
);

const mixed = await scanObservedProtocolTrace({
  adapters: [erc4626Adapter],
  context,
  txHash: TX_HASH,
  receipt,
  trace: {
    ...(redeemTrace() as Record<string, unknown>),
    calls: [
      { to: ASSET, input: ERC20.encodeFunctionData("transfer", [USER, 100n]) },
      { to: USER, input: "0x12345678" },
    ],
  },
});
assert(mixed.candidatesByAdapter.get(erc4626Adapter.id)?.length === 1, "known route remains admitted");
assert(
  mixed.unknownSelectors.length === 0,
  "unrelated helper calls inside a known protocol tx must not create unknown-selector noise",
);

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
    to: "0x4444444444444444444444444444444444444444",
    input: "0x87654321",
    calls: [
      { to: USER, input: "0x12345678", calls: [{ to: ASSET, input: "0xa9059cbb" }] },
      { to: VAULT, input: "0x12345678", calls: [{ to: ASSET, input: "0xa9059cbb" }] },
    ],
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
  !shouldTraceForProtocolDiscovery([mintLog, burnLog, lpMint], [erc4626Adapter]),
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
  shouldTraceForProtocolDiscovery([mintLog, burnLog, mixedLp], [erc4626Adapter]),
  "a separate protocol-like burn+mint must survive unrelated LP activity",
);

console.log("observed-protocol-discovery PASS");

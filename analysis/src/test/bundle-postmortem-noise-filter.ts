import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { actionsFromLogs } from "../actions/from-logs.js";
import {
  buildVerdict,
  classifyWinnerTxStyle,
  classifyWinnerStyle,
  decodeV4SwapFills,
  detectNonArbSignals,
  detectJitLiquidity,
  extractOtherVenues,
  hasBeneficiaryWethUnwrapExit,
  isNonComparableWinnerStyle,
  loadGraphMembership,
  overlayNonArbStyle,
  positionAccountImbalanceTokens,
  realizedProfitUsdForReport,
  retainedExternalMintRecipients,
  retainedSharePositionTokensForOwners,
  shareTokenImbalanceTokens,
  winnerMovedPriceBeyondPrestate,
  type WinnerStyle,
} from "../cli/bundle-postmortem.js";
import {
  competitorScanAddresses,
  loadLiveCompetitorProfile,
  positionAccountsForActors,
  type LiveCompetitorProfile,
} from "../live-competitors.js";
import { valueDeltas } from "../pnl/arb-profit.js";
import { ADDR, lower, TOPICS } from "../registry/protocols.js";
import type { RpcClient } from "../rpc/client.js";
import type { TokenDelta } from "../types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
interface ActualReceiptFixture {
  transactionHash: string;
  blockNumber: string;
  from: string;
  to: string;
  status: string;
  logs: Array<Record<string, unknown>>;
}

interface DisputedReceiptFixture {
  susdsAtomicLoops: ActualReceiptFixture[];
  externalMintNonComparable: ActualReceiptFixture[];
}

const COFFEE = "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671";
const COFFEE_EXECUTOR = "0xe08d97e151473a848c3d9ca3f323cb720472d015";
const COMPETITOR_ACTORS = new Set([COFFEE, COFFEE_EXECUTOR]);
const liveCompetitorProfile = loadLiveCompetitorProfile();
const coffeePositionAccounts = positionAccountsForActors(liveCompetitorProfile, COMPETITOR_ACTORS);
const coffeePositionAccountSet = new Set(coffeePositionAccounts);
const COMPETITOR_POSITION_OWNERS = new Set([...COMPETITOR_ACTORS, ...coffeePositionAccounts]);
const competitorScanAddressSet = new Set(competitorScanAddresses(liveCompetitorProfile));
// F-009 atomicity detector: a real inventory-rebalance receipt (0x9be73297: steakUSDC/steakUSDT
// rebalance through private vault-wrappers) vs a clean atomic 4-leg AMM loop (0xf2de7499).
const inventoryReceipt = JSON.parse(
  readFileSync(join(FIXTURES, "postmortem-0x9be73297", "receipt.json"), "utf8"),
);
const atomicReceipt = JSON.parse(
  readFileSync(join(FIXTURES, "postmortem-0xf2de7499", "receipt.json"), "utf8"),
);
const liquityMintReceipt = JSON.parse(
  readFileSync(join(FIXTURES, "coffee-20260704", "tx-2.json"), "utf8"),
);
const disputedReceipts = JSON.parse(
  readFileSync(join(FIXTURES, "bundle-postmortem-disputed-receipts.json"), "utf8"),
) as DisputedReceiptFixture;
const EXPECTED_SUSDS_RECEIPT_HASHES = [
  "0x294d326bc58cf7aea2a108a18526cc351881de159da872d464c5735b5cc8cef8",
  "0x868d2dc5d4f60d73ea755015dfe9b668618c72228e442cf7381cdb5e1aa64ea4",
  "0x9d5156cb01a7dfbcaed31ecb028132089d59517472901da130d95e5e4b3020be",
  "0xf2130409bfe9636c5cb6e7b85c523b07a0e20c209508f43a6e375607da3a4527",
  "0x17f767fda9db5e4ad7ddb325c9b125436f2262df8ed09e97cb497fe6f0e2ce7d",
  "0x1c2999d6422e16cea36973416e16dd8e84410f7cf5adf78f5531f4d160d5eaf2",
  "0x69075e9e45ed3840f6bf46c37552b62b66e5537aab1369475a57027750b68c70",
  "0xa82dafbae5f82a016736fc35dea9ed8d9b154b8692b243d074d07c62f0738e85",
  "0x8b56e5d54f3be0a13cfb6f837291c81c416ef79b4269927e4a1c2b1b6e9a8a63",
  "0xba5a95362281d11b1b132c99c6cdc220d076da240e5741bf392a445a134c4a26",
];
const EXPECTED_EXTERNAL_MINT_RECEIPT_HASHES = [
  "0xe45fee762983a4f3eddf3395d32069778e5b7637df985c06a91635fe6f1812f5",
  "0x191b9eb5ea5f8d08e1c38a450950c1eba76ffb943086934f012e712e59661912",
];
const EXPECTED_DISPUTED_LOG_COUNTS = new Map<string, number>([
  ["0x17f767fda9db5e4ad7ddb325c9b125436f2262df8ed09e97cb497fe6f0e2ce7d", 68],
  ["0x191b9eb5ea5f8d08e1c38a450950c1eba76ffb943086934f012e712e59661912", 90],
  ["0x1c2999d6422e16cea36973416e16dd8e84410f7cf5adf78f5531f4d160d5eaf2", 40],
  ["0x294d326bc58cf7aea2a108a18526cc351881de159da872d464c5735b5cc8cef8", 50],
  ["0x69075e9e45ed3840f6bf46c37552b62b66e5537aab1369475a57027750b68c70", 37],
  ["0x868d2dc5d4f60d73ea755015dfe9b668618c72228e442cf7381cdb5e1aa64ea4", 59],
  ["0x8b56e5d54f3be0a13cfb6f837291c81c416ef79b4269927e4a1c2b1b6e9a8a63", 70],
  ["0x9d5156cb01a7dfbcaed31ecb028132089d59517472901da130d95e5e4b3020be", 59],
  ["0xa82dafbae5f82a016736fc35dea9ed8d9b154b8692b243d074d07c62f0738e85", 71],
  ["0xba5a95362281d11b1b132c99c6cdc220d076da240e5741bf392a445a134c4a26", 74],
  ["0xe45fee762983a4f3eddf3395d32069778e5b7637df985c06a91635fe6f1812f5", 23],
  ["0xf2130409bfe9636c5cb6e7b85c523b07a0e20c209508f43a6e375607da3a4527", 30],
]);
const allDisputedReceipts = [
  ...disputedReceipts.susdsAtomicLoops,
  ...disputedReceipts.externalMintNonComparable,
];
const STEAK_USDT = "0xbeef047a543e45807105e51a8bbefcc5950fcfba";
const STEAK_USDC = "0xbeef01735c132ada46aa9aa4c54623caa92a64cb";
const inventoryImbalanceTokens = [...new Set([
  ...shareTokenImbalanceTokens(inventoryReceipt, COMPETITOR_POSITION_OWNERS),
  ...positionAccountImbalanceTokens(inventoryReceipt, coffeePositionAccountSet),
])].sort();
const atomicImbalanceTokens = [...new Set([
  ...shareTokenImbalanceTokens(atomicReceipt, COMPETITOR_POSITION_OWNERS),
  ...positionAccountImbalanceTokens(atomicReceipt, coffeePositionAccountSet),
])].sort();

// FALSE-POSITIVE FIX (coffeebabe srUSDe loops 0xf391d0 / 0x2b84e28c): an atomic loop that BUYS a vault
// share in-tx (from a swap venue) then REDEEMS it (burn to 0x0) shows a GLOBAL net BURN but the executor
// nets ~0. The old unconditional `value<0` flagged it as pre-held inventory. Now it must NOT flag (no
// non-venue holder ends with a residual). A GENUINE pre-held burn (a non-venue helper -> 0x0, no in-tx
// source) still flags. Synthetic receipts, deterministic.
const SHARE_TOK = "0x00000000000000000000000000000000000000a1";
const SWAP_VENUE = "0x00000000000000000000000000000000000000b2";
const EXEC_ACTOR = "0x00000000000000000000000000000000000000c3";
const INV_HELPER = "0x00000000000000000000000000000000000000d4";
const UNKNOWN_TOKEN_CASES = [
  { token: "0x0000000000000000000000000000000000000606", symbol: "UNK6", decimals: 6 },
  { token: "0x0000000000000000000000000000000000000808", symbol: "UNK8", decimals: 8 },
  { token: "0x0000000000000000000000000000000000001818", symbol: "UNK18", decimals: 18 },
] as const;
const EXTERNAL_RECIPIENT = "0x00000000000000000000000000000000000000e5";
const SECOND_POSITION_ACCOUNT = "0x00000000000000000000000000000000000000e6";
const SPLIT_MINT_RECIPIENT = "0x00000000000000000000000000000000000000e7";
const LIQUITY_PROTOCOL_EMITTER = "0xa2895d6a3bf110561dfe4b71ca539d84e1928b22";
const LIQUITY_BOLD = "0x6440f144b7e50d6a8439336510312d2f54beb01d";
const erc20If = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const erc4626If = new ethers.Interface([
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
]);
const v3If = new ethers.Interface(["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"]);
const xfer = (token: string, from: string, to: string, amt: bigint, li: number) => {
  const { data, topics } = erc20If.encodeEventLog("Transfer", [from, to, amt]);
  return { address: token, topics, data, logIndex: "0x" + li.toString(16) };
};
const v3SwapLog = (pool: string, li: number) => {
  const { data, topics } = v3If.encodeEventLog("Swap", [EXEC_ACTOR, EXEC_ACTOR, 1, -1, 0, 0, 0]);
  return { address: pool, topics, data, logIndex: "0x" + li.toString(16) };
};
const vaultWithdrawLog = (vault: string, actor: string, amount: bigint, li: number) => {
  const { data, topics } = erc4626If.encodeEventLog("Withdraw", [actor, actor, actor, amount, amount]);
  return { address: vault, topics, data, logIndex: "0x" + li.toString(16) };
};
const vaultDepositLog = (vault: string, sender: string, owner: string, amount: bigint, li: number) => {
  const { data, topics } = erc4626If.encodeEventLog("Deposit", [sender, owner, amount, amount]);
  return { address: vault, topics, data, logIndex: "0x" + li.toString(16) };
};
const liquityContextLog = (emitter: string, subject: string, li: number) => ({
  address: emitter,
  topics: [TOPICS.liquityBatchUpdated, ethers.zeroPadValue(subject, 32)],
  data: "0x",
  logIndex: "0x" + li.toString(16),
});
const SHARE_AMT = 934n * 10n ** 18n;
// buy the share from a swap venue, redeem it (burn) — executor nets 0 => NOT inventory (the fix).
const atomicBuyRedeem = { logs: [v3SwapLog(SWAP_VENUE, 0), xfer(SHARE_TOK, SWAP_VENUE, EXEC_ACTOR, SHARE_AMT, 1), xfer(SHARE_TOK, EXEC_ACTOR, ethers.ZeroAddress, SHARE_AMT, 2), vaultWithdrawLog(SHARE_TOK, EXEC_ACTOR, SHARE_AMT, 3)] };
// a non-venue helper burns a PRE-HELD share (no in-tx source) => still inventory.
const preHeldBurn = { logs: [xfer(SHARE_TOK, INV_HELPER, ethers.ZeroAddress, SHARE_AMT, 0), vaultWithdrawLog(SHARE_TOK, INV_HELPER, SHARE_AMT, 1)] };
const UNDERLYING_VAULT_SHARE = "0x00000000000000000000000000000000000000a5";
const PUBLIC_WRAPPER = "0x00000000000000000000000000000000000000a6";
// The public wrapper retains receipt-local underlying backing while the actor's own wrapper shares
// mint and burn to zero. Mentioning the actor in wrapper events must not make the wrapper entity-owned.
const nestedPublicWrapper = {
  logs: [
    xfer(UNDERLYING_VAULT_SHARE, ethers.ZeroAddress, PUBLIC_WRAPPER, SHARE_AMT, 0),
    vaultDepositLog(UNDERLYING_VAULT_SHARE, PUBLIC_WRAPPER, PUBLIC_WRAPPER, SHARE_AMT, 1),
    xfer(PUBLIC_WRAPPER, ethers.ZeroAddress, EXEC_ACTOR, SHARE_AMT, 2),
    vaultDepositLog(PUBLIC_WRAPPER, EXEC_ACTOR, EXEC_ACTOR, SHARE_AMT, 3),
    xfer(PUBLIC_WRAPPER, EXEC_ACTOR, ethers.ZeroAddress, SHARE_AMT, 4),
    vaultWithdrawLog(PUBLIC_WRAPPER, EXEC_ACTOR, SHARE_AMT, 5),
  ],
};
const buyRedeemImbalance = shareTokenImbalanceTokens(atomicBuyRedeem, new Set([EXEC_ACTOR]));
const preHeldBurnImbalance = shareTokenImbalanceTokens(preHeldBurn, new Set([INV_HELPER]));
const nestedPublicWrapperImbalance = shareTokenImbalanceTokens(
  nestedPublicWrapper,
  new Set([EXEC_ACTOR]),
);
const transferOnlyPositionDrawdown = {
  logs: [xfer(SHARE_TOK, INV_HELPER, EXTERNAL_RECIPIENT, SHARE_AMT, 0)],
};
const transientPositionFlow = {
  logs: [
    xfer(SHARE_TOK, EXTERNAL_RECIPIENT, INV_HELPER, SHARE_AMT, 0),
    xfer(SHARE_TOK, INV_HELPER, EXTERNAL_RECIPIENT, SHARE_AMT, 1),
  ],
};
const internalPositionTransfer = {
  logs: [xfer(SHARE_TOK, INV_HELPER, SECOND_POSITION_ACCOUNT, SHARE_AMT, 0)],
};
const positivePositionDeposit = {
  logs: [xfer(SHARE_TOK, EXTERNAL_RECIPIENT, INV_HELPER, SHARE_AMT, 0)],
};
const positiveActorShareMint = {
  logs: [
    vaultDepositLog(SHARE_TOK, EXEC_ACTOR, EXEC_ACTOR, SHARE_AMT, 0),
    xfer(SHARE_TOK, ethers.ZeroAddress, EXEC_ACTOR, SHARE_AMT, 1),
  ],
};
const positiveActorPricedShareMint = {
  logs: [
    vaultDepositLog(ADDR.SUSDS, EXEC_ACTOR, EXEC_ACTOR, SHARE_AMT, 0),
    xfer(ADDR.SUSDS, ethers.ZeroAddress, EXEC_ACTOR, SHARE_AMT, 1),
  ],
};
const transferOnlyPositionImbalance = positionAccountImbalanceTokens(
  transferOnlyPositionDrawdown,
  new Set([INV_HELPER]),
);
const transientPositionImbalance = positionAccountImbalanceTokens(
  transientPositionFlow,
  new Set([INV_HELPER]),
);
const internalPositionImbalance = positionAccountImbalanceTokens(
  internalPositionTransfer,
  new Set([INV_HELPER, SECOND_POSITION_ACCOUNT]),
);
const positivePositionImbalance = positionAccountImbalanceTokens(
  positivePositionDeposit,
  new Set([INV_HELPER]),
);
const positiveActorShareImbalance = shareTokenImbalanceTokens(
  positiveActorShareMint,
  new Set([EXEC_ACTOR]),
);
const positiveActorRetainedShares = retainedSharePositionTokensForOwners(
  positiveActorShareMint,
  new Set([EXEC_ACTOR]),
);
const registeredUsdsMintSignals = detectNonArbSignals(
  null,
  { logs: [xfer(ADDR.USDS, ethers.ZeroAddress, EXTERNAL_RECIPIENT, 10n ** 18n, 0)] },
  new Set([EXEC_ACTOR]),
  null,
);
const unrelatedVaultShareMintSignals = detectNonArbSignals(
  null,
  {
    logs: [
      xfer(SHARE_TOK, ethers.ZeroAddress, EXTERNAL_RECIPIENT, SHARE_AMT, 0),
      vaultDepositLog(SHARE_TOK, EXEC_ACTOR, EXTERNAL_RECIPIENT, SHARE_AMT, 1),
    ],
  },
  new Set([EXEC_ACTOR]),
  null,
);
const nestedPublicWrapperSignals = detectNonArbSignals(
  null,
  nestedPublicWrapper,
  new Set([EXEC_ACTOR]),
  null,
);
const unknownExternalMintDustRecipients = retainedExternalMintRecipients(
  { logs: [xfer(UNKNOWN_TOKEN_CASES[0].token, ethers.ZeroAddress, EXTERNAL_RECIPIENT, 1000n, 0)] },
  new Set([EXEC_ACTOR]),
);
const unknownExternalMintMaterialRecipients = UNKNOWN_TOKEN_CASES.map(({ token }) =>
  retainedExternalMintRecipients(
    { logs: [xfer(token, ethers.ZeroAddress, EXTERNAL_RECIPIENT, 1001n, 0)] },
    new Set([EXEC_ACTOR]),
  ));
const unrelatedLiquityCoMintSignals = detectNonArbSignals(
  null,
  {
    logs: [
      xfer(UNKNOWN_TOKEN_CASES[0].token, ethers.ZeroAddress, EXTERNAL_RECIPIENT, 1001n, 0),
      { address: INV_HELPER, topics: [TOPICS.liquityTroveOperation], data: "0x", logIndex: "0x1" },
    ],
  },
  new Set([EXEC_ACTOR]),
  null,
);
const fakeEmitterBoldMintSignals = detectNonArbSignals(
  null,
  {
    logs: [
      xfer(LIQUITY_BOLD, ethers.ZeroAddress, EXTERNAL_RECIPIENT, SHARE_AMT, 0),
      liquityContextLog(INV_HELPER, EXTERNAL_RECIPIENT, 1),
    ],
  },
  new Set([EXEC_ACTOR]),
  null,
);
const unlinkedCanonicalBoldMintSignals = detectNonArbSignals(
  null,
  {
    logs: [
      xfer(LIQUITY_BOLD, ethers.ZeroAddress, EXTERNAL_RECIPIENT, SHARE_AMT, 0),
      liquityContextLog(LIQUITY_PROTOCOL_EMITTER, INV_HELPER, 1),
    ],
  },
  new Set([EXEC_ACTOR]),
  null,
);
const unrelatedCanonicalBoldCoMintSignals = detectNonArbSignals(
  null,
  {
    logs: [
      liquityContextLog(LIQUITY_PROTOCOL_EMITTER, INV_HELPER, 0),
      xfer(LIQUITY_BOLD, ethers.ZeroAddress, INV_HELPER, SHARE_AMT, 1),
      xfer(LIQUITY_BOLD, ethers.ZeroAddress, EXTERNAL_RECIPIENT, SHARE_AMT, 2),
    ],
  },
  new Set([EXEC_ACTOR]),
  null,
);
const unrelatedUsdsBesideSusdsDepositSignals = detectNonArbSignals(
  null,
  {
    logs: [
      vaultDepositLog(ADDR.SUSDS, EXEC_ACTOR, EXEC_ACTOR, SHARE_AMT, 0),
      xfer(ADDR.SUSDS, ethers.ZeroAddress, EXEC_ACTOR, SHARE_AMT, 1),
      xfer(ADDR.USDS, ethers.ZeroAddress, EXTERNAL_RECIPIENT, 10n ** 18n, 2),
    ],
  },
  new Set([EXEC_ACTOR]),
  null,
);
const unrelatedSusdsBesideSusdsDepositSignals = detectNonArbSignals(
  null,
  {
    logs: [
      vaultDepositLog(ADDR.SUSDS, EXEC_ACTOR, EXEC_ACTOR, SHARE_AMT, 0),
      xfer(ADDR.SUSDS, ethers.ZeroAddress, EXEC_ACTOR, SHARE_AMT, 1),
      xfer(ADDR.SUSDS, ethers.ZeroAddress, EXTERNAL_RECIPIENT, 10n ** 18n, 2),
    ],
  },
  new Set([EXEC_ACTOR]),
  null,
);
const unrelatedActorMintWithIndependentSusdsDepositSignals = detectNonArbSignals(
  null,
  {
    logs: [
      xfer(ADDR.USDS, ethers.ZeroAddress, INV_HELPER, SHARE_AMT, 0),
      vaultDepositLog(ADDR.SUSDS, EXEC_ACTOR, EXEC_ACTOR, SHARE_AMT, 1),
      xfer(ADDR.USDS, EXEC_ACTOR, ADDR.SUSDS, SHARE_AMT, 2),
      xfer(ADDR.SUSDS, ethers.ZeroAddress, EXEC_ACTOR, SHARE_AMT, 3),
    ],
  },
  new Set([EXEC_ACTOR, INV_HELPER]),
  null,
);
const mintedFlashRepaymentSignals = detectNonArbSignals(
  null,
  {
    logs: [
      xfer(ADDR.USDS, EXTERNAL_RECIPIENT, EXEC_ACTOR, SHARE_AMT, 0),
      xfer(ADDR.USDS, ethers.ZeroAddress, EXEC_ACTOR, SHARE_AMT, 1),
      xfer(ADDR.USDS, EXEC_ACTOR, EXTERNAL_RECIPIENT, SHARE_AMT, 2),
    ],
  },
  new Set([EXEC_ACTOR]),
  null,
);
const dustPositiveMintedFlashRepaymentSignals = detectNonArbSignals(
  null,
  {
    logs: [
      xfer(UNKNOWN_TOKEN_CASES[0].token, EXTERNAL_RECIPIENT, EXEC_ACTOR, SHARE_AMT - 1n, 0),
      xfer(UNKNOWN_TOKEN_CASES[0].token, ethers.ZeroAddress, EXTERNAL_RECIPIENT, SHARE_AMT, 1),
    ],
  },
  new Set([EXEC_ACTOR]),
  null,
);
const splitExternalMintSignals = detectNonArbSignals(
  null,
  {
    logs: [
      xfer(UNKNOWN_TOKEN_CASES[0].token, ethers.ZeroAddress, EXTERNAL_RECIPIENT, 600n, 0),
      xfer(UNKNOWN_TOKEN_CASES[0].token, ethers.ZeroAddress, SPLIT_MINT_RECIPIENT, 600n, 1),
    ],
  },
  new Set([EXEC_ACTOR]),
  null,
);
const CUSTOM_EOA = "0x00000000000000000000000000000000000000f1";
const CUSTOM_EXECUTOR = "0x00000000000000000000000000000000000000f2";
const CUSTOM_POSITION_ACCOUNT = "0x00000000000000000000000000000000000000f3";
const customProfile = {
  schema_version: 1,
  profile_id: "custom-position-profile",
  entities: [{
    id: "custom",
    eoa: CUSTOM_EOA,
    executors: [CUSTOM_EXECUTOR],
    position_accounts: [CUSTOM_POSITION_ACCOUNT],
    analysis_mode: "full",
  }],
} satisfies LiveCompetitorProfile;
const customProfileFixtureDir = mkdtempSync(join(tmpdir(), "bundle-postmortem-profile-"));
const customProfilePath = join(customProfileFixtureDir, "live-competitors.json");
writeFileSync(customProfilePath, JSON.stringify(customProfile));
const loadedCustomProfile = loadLiveCompetitorProfile(customProfilePath);
const positiveActorProfile: LiveCompetitorProfile = {
  ...loadedCustomProfile,
  profile_id: "positive-actor-profile",
  entities: [{ ...loadedCustomProfile.entities[0], executors: [EXEC_ACTOR] }],
};
const customProfileReceipt = {
  from: CUSTOM_EOA,
  to: CUSTOM_EXECUTOR,
  logs: [xfer(SHARE_TOK, CUSTOM_POSITION_ACCOUNT, EXTERNAL_RECIPIENT, SHARE_AMT, 0)],
};
const classifierRpc = {
  async getLogs() { return []; },
  async getTransaction() { return null; },
  async call() { throw new Error("not needed by fixture"); },
  async traceTransaction() { throw new Error("not needed by fixture"); },
} as unknown as RpcClient;
const customProfileClassification = classifyTransferOnlyPosition(loadedCustomProfile);
const noProfileClassification = classifyTransferOnlyPosition();
const defaultProfileInventoryClassification = classifyDefaultProfileInventory();
const positiveActorShareClassification = classifyPositiveActorShare();
const publicWrapperMintClassification = classifyPublicWrapperMint();
const publicWrapperBurnClassification = classifyPublicWrapperBurn();
const liquityMintImbalance = shareTokenImbalanceTokens(
  { logs: liquityMintReceipt.receiptLogs },
  COMPETITOR_POSITION_OWNERS,
);
const liquityMintAnalysis = analyzeActualReceiptFixture({
  transactionHash: liquityMintReceipt.txHash,
  blockNumber: "0x0",
  from: liquityMintReceipt.tx.from,
  to: liquityMintReceipt.tx.to,
  status: liquityMintReceipt.receiptStatus,
  logs: liquityMintReceipt.receiptLogs,
});
const fluidOtherVenues = extractOtherVenues({
  logs: [{ address: ADDR.FLUID_DEX_USDC_USDT, topics: [TOPICS.fluidDexSwap] }],
}, null);
const susdsLoopAnalyses = disputedReceipts.susdsAtomicLoops.map(analyzeActualReceiptFixture);
const externalMintAnalyses = disputedReceipts.externalMintNonComparable.map(analyzeActualReceiptFixture);
const expectedExternalMintRecipients = new Map([
  [
    "0xe45fee762983a4f3eddf3395d32069778e5b7637df985c06a91635fe6f1812f5",
    ["0x34cf4cdb502b8ff43943149224060c0de2ddff82"],
  ],
  [
    "0x191b9eb5ea5f8d08e1c38a450950c1eba76ffb943086934f012e712e59661912",
    ["0xe1f4b19806573681ee761776a5ff8a6dd04fcec5"],
  ],
]);
const expectedExternalMintTokens = new Map([
  [
    "0xe45fee762983a4f3eddf3395d32069778e5b7637df985c06a91635fe6f1812f5",
    ["0x444444444444c1a66f394025ac839a535246fcc8"],
  ],
  [
    "0x191b9eb5ea5f8d08e1c38a450950c1eba76ffb943086934f012e712e59661912",
    ["0x5d2caad2b7f851dcb001e7d1156fdc3b4936666c"],
  ],
]);

const CFG = "0xcccccccccccccccccccccccccccccccccccccccc";
const reach = {
  status: "sent_directly" as const,
  builder: "test-builder",
  miner: "0x0000000000000000000000000000000000000000",
  builders_sent: ["test-builder"],
  note: "test fixture",
};
const scaleKeeperSignals = detectNonArbSignals(
  "0x8cbf856600000000e4fc6b6d00000000",
  null,
  new Set([EXEC_ACTOR]),
  null,
);

// The inventory receipt's residual vault-share position => inventory_vault_rebalance (non-comparable),
// even though the executor's priced/native net looks like a clean atomic loop (+profit only).
const inventoryVaultStyle = classifyWinnerStyle({
  pricedDeltas: [delta(ADDR.WETH, 399744634603446n, "WETH", 18)], // looks atomic on the executor axis
  unpricedDeltas: [],
  nativeWeiPositive: false,
  unpricedInTokensWithoutCounterTransfer: [],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
  share_imbalance_tokens: inventoryImbalanceTokens,
  inventory_rebalance_selector_hit: true,
});

// The clean atomic loop: no share imbalance; a hardcoded selector hit alone must NOT reclassify a
// comparable atomic loop (a plain ERC4626 arb calls deposit/redeem but nets zero shares).
const atomicWithSelectorHit = classifyWinnerStyle({
  pricedDeltas: [delta(ADDR.WETH, 399744634603446n, "WETH", 18)],
  unpricedDeltas: [],
  nativeWeiPositive: false,
  unpricedInTokensWithoutCounterTransfer: [],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
  share_imbalance_tokens: atomicImbalanceTokens,
  inventory_rebalance_selector_hit: true,
});

const positiveShareWithSelectorStyle = classifyWinnerStyle({
  pricedDeltas: [],
  unpricedDeltas: [delta(SHARE_TOK, SHARE_AMT, "SHARE", 18)],
  nativeWeiPositive: false,
  unpricedInTokensWithoutCounterTransfer: [lower(SHARE_TOK)],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
  share_imbalance_tokens: positiveActorShareImbalance,
  retained_share_position_tokens: positiveActorRetainedShares,
  inventory_rebalance_selector_hit: true,
});

const inventoryVaultVerdict = buildVerdict(
  event("100", "50"),
  [competitor(inventoryVaultStyle, "200")],
  reach,
);

const oneLegStyle = classifyWinnerStyle({
  pricedDeltas: [delta(ADDR.WETH, -305410000000000000n, "WETH", 18)],
  unpricedDeltas: [delta(CFG, 2640100000000000000000n, "CFG", 18)],
  nativeWeiPositive: false,
  unpricedInTokensWithoutCounterTransfer: [lower(CFG)],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
});

// Selling one priced inventory asset into another is still one-leg inventory. The old classifier
// treated any positive priced residual as an atomic loop, even when a different priced token was spent.
const pricedOneLegStyle = classifyWinnerStyle({
  pricedDeltas: [
    delta(ADDR.WETH, -1_000_000_000_000_000_000n, "WETH", 18),
    delta(ADDR.USDC, 3_500_000_000n, "USDC", 6),
  ],
  unpricedDeltas: [],
  nativeWeiPositive: false,
  unpricedInTokensWithoutCounterTransfer: [],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
});

const tickForcedStyle = classifyWinnerStyle({
  pricedDeltas: [],
  unpricedDeltas: [],
  nativeWeiPositive: false,
  unpricedInTokensWithoutCounterTransfer: [],
  winner_moved_price_beyond_prestate: true,
  sandwich_detected: false,
});

// A closed cross-venue backrun can leave one venue beyond block N-1. The closed transaction flow
// is decisive; the tick heuristic must not turn it into inventory.
const tickMovedClosedAtomicStyle = classifyWinnerStyle({
  pricedDeltas: [delta(ADDR.WETH, 210_700_510_961_548n, "WETH", 18)],
  unpricedDeltas: [],
  nativeWeiPositive: false,
  nativeWeiNegative: false,
  unpricedInTokensWithoutCounterTransfer: [],
  winner_moved_price_beyond_prestate: true,
  sandwich_detected: false,
});

const sandwichVerdict = buildVerdict(
  event("100", "50"),
  [competitor("sandwich", "200")],
  reach,
);

const oneLegVerdict = buildVerdict(
  event("100", "50"),
  [competitor(oneLegStyle, "200")],
  reach,
);

const atomicStyle = classifyWinnerStyle({
  pricedDeltas: [delta(ADDR.WETH, 399744634603446n, "WETH", 18)],
  unpricedDeltas: [],
  nativeWeiPositive: false,
  unpricedInTokensWithoutCounterTransfer: [],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
});

const atomicVerdict = buildVerdict(
  event("100", "50"),
  [competitor(atomicStyle, "200")],
  reach,
);
const unknownVerdict = buildVerdict(
  event("100", "50"),
  [competitor("unknown", "200")],
  reach,
);

// Graph-membership v4 fixture: runtime-graph-pools.json stores v4 by PoolManager ADDRESS only
// (no poolId), so in_graph for v4 must come from the sibling active-pools.json poolId set — else
// EVERY v4 pool (incl. ones we index) is a false-negative not-in-graph. This asserts the union.
const V3_ADDR_IN_GRAPH = "0x08a10a8b713c03e2fecaa3e355cea18a459ffcbf";
const V4_POOLID_IN_ACTIVE = "0x267d01a3b23fe2340482242db5396f7544d36f398862efa591e92a079348cd9c";
const V4_POOLID_NOT_INDEXED = "0xaa9a1adf0000000000000000000000000000000000000000000000000000dead";
const graphFixtureDir = mkdtempSync(join(tmpdir(), "bundle-postmortem-graph-"));
writeFileSync(
  join(graphFixtureDir, "runtime-graph-pools.json"),
  JSON.stringify({ pools: [{ address: V3_ADDR_IN_GRAPH, adapter: "univ3" }] }) + "\n",
);
writeFileSync(
  join(graphFixtureDir, "active-pools.json"),
  JSON.stringify({ pools: [{ adapter: "univ4", poolId: V4_POOLID_IN_ACTIVE }] }) + "\n",
);
const graphMembership = loadGraphMembership(join(graphFixtureDir, "runtime-graph-pools.json"));

// v4 real-fill decode + JIT detection (synthetic PoolManager logs, no RPC). Mirrors 0xf391d0's
// c069abea leg: swapper pays 949.488853 USDC (amount1 < 0) and receives 934.46 srUSDe (amount0 > 0).
const V4_PM = lower(ADDR.UNIV4_POOL_MANAGER);
const C069ABEA = "0xc069abea3d235a4f38cb7d0219f66cc7cbbce92f0b4740bac46bef896c2277b8";
const SENDER = "0x00000000000000000000000000000000000000e0";
const v4LogIface = new ethers.Interface([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
]);
function v4SwapLog(poolId: string, amount0: bigint, amount1: bigint, logIndex: number) {
  const { data, topics } = v4LogIface.encodeEventLog("Swap", [poolId, SENDER, amount0, amount1, 0n, 0n, 0, 0]);
  return { address: V4_PM, topics, data, logIndex: "0x" + logIndex.toString(16) };
}
function v4ModifyLog(poolId: string, delta: bigint, logIndex: number) {
  const { data, topics } = v4LogIface.encodeEventLog("ModifyLiquidity", [poolId, SENDER, 0, 0, delta, ethers.ZeroHash]);
  return { address: V4_PM, topics, data, logIndex: "0x" + logIndex.toString(16) };
}
// F-391 shape: a lone Swap, no ModifyLiquidity (no JIT).
const f391Receipt = { logs: [v4SwapLog(C069ABEA, 934460889828731878592n, -949488853n, 2)] };
const f391Jit = detectJitLiquidity(f391Receipt);
const f391Fills = decodeV4SwapFills(f391Receipt, new Set(f391Jit));
// JIT shape: add-liquidity (positive delta) BEFORE the swap on the same pool.
const jitReceipt = { logs: [v4ModifyLog(C069ABEA, 5_000n, 0), v4SwapLog(C069ABEA, 1n, -1n, 1)] };
const jitPools = detectJitLiquidity(jitReceipt);
const jitFills = decodeV4SwapFills(jitReceipt, new Set(jitPools));
// Add-AFTER-swap must NOT count as JIT (ordering matters).
const addAfterJit = detectJitLiquidity({ logs: [v4SwapLog(C069ABEA, 1n, -1n, 0), v4ModifyLog(C069ABEA, 5_000n, 1)] });

const checks: Array<() => void> = [
  () => assert.deepEqual(coffeePositionAccounts, [
    "0xb8280955ae7b5207af4cdbdcd775135bd38157fe",
    "0x4825eff24f9b7b76eeafa2ecc6a1d5dfcb3c1c3f",
  ]),
  () => assert.equal(coffeePositionAccounts.some((address) => competitorScanAddressSet.has(address)), false),
  () => assert.equal(graphMembership.status, "loaded"),
  // the fix: a v4 poolId present in active-pools is now in_graph (was a systematic false-negative)
  () => assert.equal(graphMembership.members.has(lower(V4_POOLID_IN_ACTIVE)), true),
  // a v4 poolId we do NOT index stays out of graph (real coverage gap preserved)
  () => assert.equal(graphMembership.members.has(lower(V4_POOLID_NOT_INDEXED)), false),
  // v2/v3 in_graph stays authoritative against runtime-graph
  () => assert.equal(graphMembership.members.has(lower(V3_ADDR_IN_GRAPH)), true),
  () => assert.equal(oneLegStyle, "one_leg_inventory"),
  () => assert.equal(pricedOneLegStyle, "one_leg_inventory"),
  () => assert.equal(tickForcedStyle, "one_leg_inventory"),
  () => assert.equal(tickMovedClosedAtomicStyle, "atomic_loop"),
  () => assert.equal(oneLegVerdict.winner_style, "one_leg_inventory"),
  () => assert.equal(oneLegVerdict.route_gap_decisive, false),
  () => assert.equal(oneLegVerdict.non_comparable_winner, true),
  () => assert.match(oneLegVerdict.note ?? "", /one_leg_inventory\/CEX-DEX/),
  () => assert.equal(sandwichVerdict.route_gap_decisive, false),
  () => assert.equal(sandwichVerdict.non_comparable_winner, true),
  () => assert.equal(atomicStyle, "atomic_loop"),
  () => assert.equal(atomicVerdict.winner_style, "atomic_loop"),
  () => assert.equal(atomicVerdict.route_gap_decisive, true),
  () => assert.equal(atomicVerdict.non_comparable_winner, undefined),
  () => assert.equal(unknownVerdict.route_gap_decisive, false),
  () => assert.equal(scaleKeeperSignals.claim_selector_hit, true),
  () => assert.equal(overlayNonArbStyle("unknown", scaleKeeperSignals), "keeper_claim"),
  () => assert.equal(isNonComparableWinnerStyle("keeper_claim"), true),
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [],
    unpricedDeltas: [],
    nativeWeiPositive: true,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "atomic_loop"),
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [],
    unpricedDeltas: [],
    nativeWeiPositive: false,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "unknown"),
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [],
    unpricedDeltas: [delta(CFG, -1n, "CFG", 18)],
    nativeWeiPositive: true,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "atomic_loop"),
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [],
    unpricedDeltas: [delta(CFG, 5n, "CFG", 18)],
    nativeWeiPositive: true,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "atomic_loop"),
  // Unknown metadata must retain the original raw-unit boundary without assuming 18 decimals.
  // Rounding dust is ignored at either sign, while the first material unit is not swallowed for
  // hypothetical 6-, 8-, or 18-decimal unregistered tokens.
  ...UNKNOWN_TOKEN_CASES.flatMap(({ token, symbol, decimals }) =>
    ([-1000n, 1000n] as const).map((raw) => () => assert.equal(classifyWinnerStyle({
      pricedDeltas: [],
      unpricedDeltas: [delta(token, raw, symbol, decimals)],
      nativeWeiPositive: true,
      unpricedInTokensWithoutCounterTransfer: [],
      winner_moved_price_beyond_prestate: false,
      sandwich_detected: false,
    }), "atomic_loop", `${symbol} unknown-token dust ${raw}`))),
  ...UNKNOWN_TOKEN_CASES.flatMap(({ token, symbol, decimals }) =>
    ([-1001n, 1001n] as const).map((raw) => () => assert.equal(classifyWinnerStyle({
      pricedDeltas: [],
      unpricedDeltas: [delta(token, raw, symbol, decimals)],
      nativeWeiPositive: true,
      unpricedInTokensWithoutCounterTransfer: [],
      winner_moved_price_beyond_prestate: false,
      sandwich_detected: false,
    }), "unknown", `${symbol} material raw delta ${raw}`))),
  // Dust is sign-symmetric and value-aware: either sign below one cent is ignored, while a
  // material stablecoin drawdown still prevents a closed-loop verdict.
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [delta(ADDR.SUSDS, 1_000_000_000_000n, "sUSDS", 18)],
    unpricedDeltas: [],
    nativeWeiPositive: true,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "atomic_loop"),
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [delta(ADDR.SUSDS, -1_000_000_000_000n, "sUSDS", 18)],
    unpricedDeltas: [],
    nativeWeiPositive: true,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "atomic_loop"),
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [delta(ADDR.SUSDS, -20_000_000_000_000_000n, "sUSDS", 18)],
    unpricedDeltas: [],
    nativeWeiPositive: true,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "unknown"),
  // Deliverable 3: native-ETH-funded one-leg inventory buy (ETH spent invisibly, bought token kept,
  // no counter-transfer) -> one_leg_inventory (was unknown: native-blind AND v4/v2 has no tick check).
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [],
    unpricedDeltas: [],
    nativeWeiPositive: false,
    nativeWeiNegative: true,
    unpricedInTokensWithoutCounterTransfer: [lower(CFG)],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "one_leg_inventory"),
  // guard: native spent but NO leftover bought-token without counter-transfer -> NOT one-leg (an
  // atomic loop returns to a priced token and leaves an empty list) -> falls through to unknown.
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [],
    unpricedDeltas: [],
    nativeWeiPositive: false,
    nativeWeiNegative: true,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "unknown"),
  () => assert.equal(winnerMovedPriceBeyondPrestate(90610, 90601, "down"), true),
  () => assert.equal(winnerMovedPriceBeyondPrestate(90610, 90610, "down"), false),
  () => assert.equal(winnerMovedPriceBeyondPrestate(90610, 90612, "down"), false),
  () => assert.equal(realizedProfitUsdForReport(-528, [delta(CFG, 1n, "CFG", 18)]), `unpriceable(${lower(CFG)})`),

  // False-positive fix: atomic BUY-share-then-REDEEM (executor nets 0, share bought from a swap venue)
  // must NOT be flagged inventory — even though it is a GLOBAL net burn. This is the coffeebabe srUSDe
  // loop shape (0xf391d0 / 0x2b84e28c) the old unconditional `value<0` mis-flagged.
  () => assert.deepEqual(buyRedeemImbalance, []),
  // ...but a genuine pre-held burn (non-venue helper -> 0x0, no in-tx source) still flags.
  () => assert.deepEqual(preHeldBurnImbalance, [lower(SHARE_TOK)]),
  // Explicit entity position accounts are ledger-owned: external changes in either direction are
  // inventory even without an ERC4626 event. Transit and A->B movement inside the entity net to zero.
  () => assert.deepEqual(transferOnlyPositionImbalance, [lower(SHARE_TOK)]),
  () => assert.deepEqual(positivePositionImbalance, [lower(SHARE_TOK)]),
  () => assert.deepEqual(transientPositionImbalance, []),
  () => assert.deepEqual(internalPositionImbalance, []),
  // A beneficiary's positive share mint is not evidence that it spent pre-held inventory.
  () => assert.deepEqual(positiveActorShareImbalance, []),
  () => assert.deepEqual(positiveActorRetainedShares, [lower(SHARE_TOK)]),
  // Nested public-wrapper backing is protocol inventory, not competitor inventory. The actor's
  // own wrapper position closes to zero, and no undeclared wrapper account may be inferred as owned.
  // Its ungrounded retained backing mint is conservatively unknown, never competitor inventory.
  () => assert.deepEqual(nestedPublicWrapperImbalance, []),
  () => assert.equal(overlayNonArbStyle("atomic_loop", nestedPublicWrapperSignals), "unknown"),
  // The same unknown-token fallback feeds external-mint detection: boundary dust is ignored, but
  // a modest retained mint is material for every hypothetical decimal shape above.
  () => assert.deepEqual(unknownExternalMintDustRecipients, []),
  ...unknownExternalMintMaterialRecipients.map((recipients) =>
    () => assert.deepEqual(recipients, [lower(EXTERNAL_RECIPIENT)])),
  // Registered tokens and ERC4626 shares are equally capable of making closure ambiguous.
  () => assert.deepEqual(registeredUsdsMintSignals.external_mint_tokens, [lower(ADDR.USDS)]),
  () => assert.deepEqual(registeredUsdsMintSignals.external_mint_unknown_tokens, []),
  () => assert.equal(registeredUsdsMintSignals.external_mint_protocol_context, null),
  () => assert.equal(overlayNonArbStyle("atomic_loop", registeredUsdsMintSignals), "unknown"),
  () => assert.deepEqual(unrelatedVaultShareMintSignals.external_mint_tokens, [lower(SHARE_TOK)]),
  () => assert.deepEqual(unrelatedVaultShareMintSignals.external_mint_recipients, [lower(EXTERNAL_RECIPIENT)]),
  () => assert.equal(unrelatedVaultShareMintSignals.external_mint_protocol_context, null),
  () => assert.equal(overlayNonArbStyle("atomic_loop", unrelatedVaultShareMintSignals), "unknown"),
  // Protocol context is flow/emitter grounded: neither a coincidental unknown mint, a fake Liquity
  // emitter, nor a canonical event whose indexed subject did not receive BOLD can bless closure.
  () => assert.equal(unrelatedLiquityCoMintSignals.external_mint_protocol_context, null),
  () => assert.equal(overlayNonArbStyle("atomic_loop", unrelatedLiquityCoMintSignals), "unknown"),
  () => assert.equal(fakeEmitterBoldMintSignals.external_mint_protocol_context, null),
  () => assert.equal(overlayNonArbStyle("atomic_loop", fakeEmitterBoldMintSignals), "unknown"),
  () => assert.equal(unlinkedCanonicalBoldMintSignals.external_mint_protocol_context, null),
  () => assert.equal(overlayNonArbStyle("atomic_loop", unlinkedCanonicalBoldMintSignals), "unknown"),
  () => assert.equal(unrelatedCanonicalBoldCoMintSignals.external_mint_protocol_context, null),
  () => assert.equal(
    overlayNonArbStyle("atomic_loop", unrelatedCanonicalBoldCoMintSignals),
    "unknown",
  ),
  // A real canonical sUSDS Deposit cannot bless unrelated retained USDS or an unmatched sUSDS mint.
  () => assert.deepEqual(unrelatedUsdsBesideSusdsDepositSignals.external_mint_tokens, [lower(ADDR.USDS)]),
  () => assert.equal(unrelatedUsdsBesideSusdsDepositSignals.external_mint_protocol_context, null),
  () => assert.equal(
    overlayNonArbStyle("atomic_loop", unrelatedUsdsBesideSusdsDepositSignals),
    "unknown",
  ),
  () => assert.deepEqual(unrelatedSusdsBesideSusdsDepositSignals.external_mint_tokens, [lower(ADDR.SUSDS)]),
  () => assert.equal(unrelatedSusdsBesideSusdsDepositSignals.external_mint_protocol_context, null),
  () => assert.equal(
    overlayNonArbStyle("atomic_loop", unrelatedSusdsBesideSusdsDepositSignals),
    "unknown",
  ),
  // A mint retained by an actor cannot be reassigned to an unrelated external sUSDS deposit that
  // occurred later in the receipt. Ordered provenance removes the false external-mint evidence.
  () => assert.deepEqual(unrelatedActorMintWithIndependentSusdsDepositSignals.external_mint_tokens, []),
  () => assert.equal(
    overlayNonArbStyle("atomic_loop", unrelatedActorMintWithIndependentSusdsDepositSignals),
    "atomic_loop",
  ),
  // A lender repaid with newly minted tokens remains net-zero and has no retained mint position.
  () => assert.deepEqual(mintedFlashRepaymentSignals.external_mint_tokens, []),
  () => assert.deepEqual(mintedFlashRepaymentSignals.external_mint_recipients, []),
  () => assert.deepEqual(dustPositiveMintedFlashRepaymentSignals.external_mint_tokens, []),
  () => assert.deepEqual(dustPositiveMintedFlashRepaymentSignals.external_mint_recipients, []),
  // Materiality is applied after aggregating mint events for a token.
  () => assert.deepEqual(splitExternalMintSignals.external_mint_tokens, [lower(UNKNOWN_TOKEN_CASES[0].token)]),
  () => assert.deepEqual(splitExternalMintSignals.external_mint_recipients, [
    lower(EXTERNAL_RECIPIENT),
    lower(SPLIT_MINT_RECIPIENT),
  ]),
  () => assert.equal(overlayNonArbStyle("atomic_loop", splitExternalMintSignals), "unknown"),
  // Coffee #2 is a Liquity BOLD protocol mint, not an ERC4626 share position. A plain token mint
  // without Deposit/Withdraw evidence must not poison comparable atomic-loop analysis.
  () => assert.deepEqual(liquityMintImbalance, []),
  // Full receipt style path: external BOLD recipients stay diagnostic, while canonical Liquity
  // trove-operation context preserves the known atomic protocol loop.
  () => assert.equal(liquityMintReceipt.receiptStatus, "0x1"),
  () => assert.equal(liquityMintReceipt.receiptLogs.length, 21),
  () => assert.deepEqual(
    [...new Set(liquityMintReceipt.receiptLogs.map((log: Record<string, unknown>) =>
      lower(String(log.transactionHash ?? ""))))],
    [lower(liquityMintReceipt.txHash)],
  ),
  () => assert.deepEqual(
    liquityMintReceipt.receiptLogs.map((log: Record<string, unknown>) => Number(log.logIndex)),
    Array.from({ length: 21 }, (_, index) => 429 + index),
  ),
  () => assert.equal(liquityMintAnalysis.style, "atomic_loop"),
  () => assert.deepEqual(liquityMintAnalysis.signals.external_mint_recipients, [
    "0x807def5e7d057df05c796f4bc75c3fe82bd6eee1",
    "0x9502b7c397e9aa22fe9db7ef7daf21cd2aebe56b",
  ]),
  () => assert.deepEqual(liquityMintAnalysis.signals.external_mint_unknown_tokens, [
    "0x6440f144b7e50d6a8439336510312d2f54beb01d",
  ]),
  () => assert.deepEqual(liquityMintAnalysis.signals.external_mint_tokens, [
    "0x6440f144b7e50d6a8439336510312d2f54beb01d",
  ]),
  () => assert.equal(liquityMintAnalysis.signals.external_mint_protocol_context, "liquity"),
  // Fluid DEX is a swap venue in canonical any-tx postmortems, not an opaque emitter.
  () => assert.deepEqual(fluidOtherVenues, [{
    protocol: "fluidDex",
    id: lower(ADDR.FLUID_DEX_USDC_USDT),
    emitter: lower(ADDR.FLUID_DEX_USDC_USDT),
    in_graph: null,
  }]),

  // The archive fixture is exact: bind both disputed group hash sets and every complete receipt's
  // successful status, full log count, and per-log transaction hash.
  () => assert.deepEqual(
    disputedReceipts.susdsAtomicLoops.map((receipt) => lower(receipt.transactionHash)).sort(),
    EXPECTED_SUSDS_RECEIPT_HASHES.map(lower).sort(),
  ),
  () => assert.deepEqual(
    disputedReceipts.externalMintNonComparable.map((receipt) => lower(receipt.transactionHash)).sort(),
    EXPECTED_EXTERNAL_MINT_RECEIPT_HASHES.map(lower).sort(),
  ),
  ...allDisputedReceipts.flatMap((receipt) => [
    () => assert.equal(receipt.status, "0x1", receipt.transactionHash),
    () => assert.equal(
      receipt.logs.length,
      EXPECTED_DISPUTED_LOG_COUNTS.get(lower(receipt.transactionHash)),
      receipt.transactionHash,
    ),
    () => assert.deepEqual(
      [...new Set(receipt.logs.map((log) => lower(String(log.transactionHash ?? ""))))],
      [lower(receipt.transactionHash)],
      receipt.transactionHash,
    ),
  ]),
  // Actual-receipt regressions: ten position-conserving sUSDS/ERC4626 loops carry only actor dust.
  // Counterparty and settlement-address share nets must not become competitor inventory.
  ...susdsLoopAnalyses.flatMap((analysis) => [
    () => assert.equal(analysis.style, "atomic_loop", analysis.receipt.transactionHash),
    () => assert.deepEqual(analysis.shareImbalanceTokens, [], analysis.receipt.transactionHash),
    () => assert.equal(
      analysis.signals.external_mint_protocol_context,
      analysis.signals.external_mint_tokens.length > 0 ? "susds" : null,
      analysis.receipt.transactionHash,
    ),
    () => assert.ok(
      analysis.signals.external_mint_tokens.every((token) =>
        token === lower(ADDR.USDS) || token === lower(ADDR.SUSDS)),
      analysis.receipt.transactionHash,
    ),
  ]),
  // Two independent token shapes prove the retained external-mint rule is generic: direct
  // zero->recipient (GENI) and mint-to-token-then-settle-to-recipient remain diagnostic, but absent
  // entity ownership they become honest unknown/manual cases rather than invented inventory.
  ...externalMintAnalyses.flatMap((analysis) => [
    () => assert.equal(analysis.style, "unknown", analysis.receipt.transactionHash),
    () => assert.equal(isNonComparableWinnerStyle(analysis.style), false, analysis.receipt.transactionHash),
    () => assert.deepEqual(
      analysis.signals.external_mint_recipients,
      expectedExternalMintRecipients.get(analysis.receipt.transactionHash),
      analysis.receipt.transactionHash,
    ),
    () => assert.deepEqual(
      analysis.signals.external_mint_tokens,
      expectedExternalMintTokens.get(analysis.receipt.transactionHash),
      analysis.receipt.transactionHash,
    ),
    () => assert.deepEqual(
      analysis.signals.external_mint_unknown_tokens,
      expectedExternalMintTokens.get(analysis.receipt.transactionHash),
      analysis.receipt.transactionHash,
    ),
    () => assert.equal(
      analysis.signals.external_mint_protocol_context,
      null,
      analysis.receipt.transactionHash,
    ),
  ]),

  // F-009 atomicity / inventory-rebalance detector ---------------------------------------------
  // Layer 2 (robust receipt signal): 0x9be73297 leaves a residual position in BOTH vault-share
  // tokens (steakUSDT minted, steakUSDC burned) => both flagged. Reconciles the F-009 on-chain trace.
  () => assert.deepEqual(inventoryImbalanceTokens, [lower(STEAK_USDC), lower(STEAK_USDT)].sort()),
  // Negative control: the clean atomic 4-leg AMM loop 0xf2de7499 has NO share mint/burn => empty.
  () => assert.deepEqual(atomicImbalanceTokens, []),
  // 0x9be73297 => inventory_vault_rebalance even though its executor net looks atomic (+WETH only).
  () => assert.equal(inventoryVaultStyle, "inventory_vault_rebalance"),
  () => assert.equal(isNonComparableWinnerStyle("inventory_vault_rebalance"), true),
  () => assert.equal(inventoryVaultVerdict.winner_style, "inventory_vault_rebalance"),
  () => assert.equal(inventoryVaultVerdict.non_comparable_winner, true),
  () => assert.equal(inventoryVaultVerdict.route_gap_decisive, false),
  () => assert.match(inventoryVaultVerdict.note ?? "", /inventory_vault_rebalance/),
  // A generic vault selector cannot establish ownership, on either a closed loop or an unresolved
  // positive actor share mint.
  () => assert.equal(atomicWithSelectorHit, "atomic_loop"),
  () => assert.equal(positiveShareWithSelectorStyle, "unknown"),
  // A receipt-grounded residual share imbalance with no selector still flags.
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [delta(ADDR.WETH, 399744634603446n, "WETH", 18)],
    unpricedDeltas: [],
    nativeWeiPositive: false,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
    share_imbalance_tokens: [lower(STEAK_USDT)],
    inventory_rebalance_selector_hit: false,
  }), "inventory_vault_rebalance"),
  // Regression: the plain atomic-loop fixture (no new signals passed) is unchanged.
  () => assert.equal(atomicStyle, "atomic_loop"),

  // v4 real per-leg fill decode (0xf391d0 c069abea entry leg) -----------------------------------
  () => assert.equal(f391Fills.length, 1),
  () => assert.equal(f391Fills[0].poolId, lower(C069ABEA)),
  // USDC paid in (amount1 < 0), srUSDe received (amount0 > 0) => oneForZero, i.e. NOT zeroForOne.
  () => assert.equal(f391Fills[0].amount1, "-949488853"),
  () => assert.equal(f391Fills[0].amount0, "934460889828731878592"),
  () => assert.equal(f391Fills[0].zeroForOne, false),
  () => assert.equal(f391Fills[0].jit, false),
  () => assert.deepEqual(f391Jit, []),
  // JIT detection: add-before-swap on the same pool flags it; the fill carries jit=true.
  () => assert.deepEqual(jitPools, [lower(C069ABEA)]),
  () => assert.equal(jitFills[0].jit, true),
  // Ordering guard: liquidity added AFTER the swap is not JIT.
  () => assert.deepEqual(addAfterJit, []),
];

async function run(): Promise<void> {
  try {
    const [
      withCustomProfile,
      withoutProfile,
      withDefaultProfile,
      positiveActorShare,
      publicWrapperMint,
      publicWrapperBurn,
    ] = await Promise.all([
      customProfileClassification,
      noProfileClassification,
      defaultProfileInventoryClassification,
      positiveActorShareClassification,
      publicWrapperMintClassification,
      publicWrapperBurnClassification,
    ]);
    const allChecks = [
      ...checks,
      () => assert.equal(withCustomProfile.winner_style, "inventory_vault_rebalance"),
      () => assert.equal(withoutProfile.winner_style, "atomic_loop"),
      () => assert.equal(withDefaultProfile.winner_style, "inventory_vault_rebalance"),
      () => assert.equal(positiveActorShare.winner_style, "unknown"),
      () => assert.deepEqual(positiveActorShare.retained_share_position_tokens, [lower(ADDR.SUSDS)]),
      () => assert.equal(publicWrapperMint.winner_style, "unknown"),
      () => assert.deepEqual(
        publicWrapperMint.non_arb_signals?.external_mint_recipients,
        [lower(PUBLIC_WRAPPER)],
      ),
      () => assert.equal(publicWrapperBurn.winner_style, "atomic_loop"),
      () => assert.deepEqual(competitorScanAddresses(loadedCustomProfile), [CUSTOM_EOA, CUSTOM_EXECUTOR]),
    ];
    for (const check of allChecks) check();
    rmSync(graphFixtureDir, { recursive: true, force: true });
    rmSync(customProfileFixtureDir, { recursive: true, force: true });
    console.log(`bundle-postmortem-noise-filter PASS (${allChecks.length}/${allChecks.length})`);
    console.log("expected_transition: ten complete sUSDS/ERC4626 receipts remain atomic_loop with no inventory signal and only grounded sUSDS mint diagnostics; Liquity 0x803a stays atomic_loop with recognized diagnostic co-mints; ungrounded retained mints become unknown; explicit position-account drawdowns become inventory_vault_rebalance; 0xe45/0x191b remain unknown; 0x9be remains inventory_vault_rebalance. verdict: fixed");
  } catch (err) {
    console.error(`bundle-postmortem-noise-filter FAIL: ${(err as Error).message}`);
    process.exit(1);
  }
}

void run();

function classifyTransferOnlyPosition(profile?: LiveCompetitorProfile) {
  return classifyWinnerTxStyle({
    rpc: classifierRpc,
    txHash: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    tx: { from: CUSTOM_EOA, to: CUSTOM_EXECUTOR, input: "0x" },
    receipt: customProfileReceipt,
    profit: {
      pricedDeltas: [delta(ADDR.WETH, 10n ** 18n, "WETH", 18)],
      unpricedDeltas: [],
      beneficiary: CUSTOM_EXECUTOR,
      ethDeltaEth: 0,
      nativeTraceUsed: false,
    },
    transactionIndex: 0,
    blockNumber: 1,
    prestateBlock: 0,
    ...(profile ? { competitorProfile: profile } : {}),
  });
}

function classifyDefaultProfileInventory() {
  return classifyWinnerTxStyle({
    rpc: classifierRpc,
    txHash: "0x9be73297e0fd8b0ff9760356480b372e3f78b12ce6bc6dc9bb83888d1314b862",
    tx: { from: COFFEE, to: COFFEE_EXECUTOR, input: "0x" },
    receipt: inventoryReceipt,
    profit: {
      pricedDeltas: [delta(ADDR.WETH, 399744634603446n, "WETH", 18)],
      unpricedDeltas: [],
      beneficiary: COFFEE_EXECUTOR,
      ethDeltaEth: 0,
      nativeTraceUsed: false,
    },
    transactionIndex: 0,
    blockNumber: 1,
    prestateBlock: 0,
  });
}

function classifyPositiveActorShare() {
  return classifyWinnerTxStyle({
    rpc: classifierRpc,
    txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tx: { from: CUSTOM_EOA, to: EXEC_ACTOR, input: "0x" },
    receipt: positiveActorPricedShareMint,
    profit: {
      pricedDeltas: [delta(ADDR.SUSDS, SHARE_AMT, "sUSDS", 18)],
      unpricedDeltas: [],
      beneficiary: EXEC_ACTOR,
      ethDeltaEth: 0,
      nativeTraceUsed: false,
    },
    transactionIndex: 0,
    blockNumber: 1,
    prestateBlock: 0,
    competitorProfile: positiveActorProfile,
  });
}

function classifyPublicWrapperMint() {
  return classifyWinnerTxStyle({
    rpc: classifierRpc,
    txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    tx: { from: CUSTOM_EOA, to: PUBLIC_WRAPPER, input: "0x" },
    receipt: {
      from: CUSTOM_EOA,
      to: PUBLIC_WRAPPER,
      logs: [xfer(ADDR.USDS, ethers.ZeroAddress, PUBLIC_WRAPPER, SHARE_AMT, 0)],
    },
    profit: {
      pricedDeltas: [delta(ADDR.WETH, 10n ** 18n, "WETH", 18)],
      unpricedDeltas: [],
      beneficiary: PUBLIC_WRAPPER,
      ethDeltaEth: 0,
      nativeTraceUsed: false,
    },
    transactionIndex: 0,
    blockNumber: 1,
    prestateBlock: 0,
    positionAccounts: [],
  });
}

function classifyPublicWrapperBurn() {
  return classifyWinnerTxStyle({
    rpc: classifierRpc,
    txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    tx: { from: CUSTOM_EOA, to: PUBLIC_WRAPPER, input: "0x" },
    receipt: {
      from: CUSTOM_EOA,
      to: PUBLIC_WRAPPER,
      logs: [
        xfer(SHARE_TOK, PUBLIC_WRAPPER, ethers.ZeroAddress, SHARE_AMT, 0),
        vaultWithdrawLog(SHARE_TOK, PUBLIC_WRAPPER, SHARE_AMT, 1),
      ],
    },
    profit: {
      pricedDeltas: [delta(ADDR.WETH, 10n ** 18n, "WETH", 18)],
      unpricedDeltas: [],
      beneficiary: PUBLIC_WRAPPER,
      ethDeltaEth: 0,
      nativeTraceUsed: false,
    },
    transactionIndex: 0,
    blockNumber: 1,
    prestateBlock: 0,
    positionAccounts: [],
  });
}

function analyzeActualReceiptFixture(receipt: ActualReceiptFixture) {
  const actors = new Set([lower(receipt.from), lower(receipt.to)]);
  const positionAccounts = new Set(positionAccountsForActors(liveCompetitorProfile, actors));
  const positionOwners = new Set([
    ...actors,
    ...positionAccounts,
  ]);
  const rawDeltas = actionsFromLogs(receipt, [...actors]).rawDeltas;
  const valued = valueDeltas(rawDeltas, 3500);
  const shareImbalanceTokens = [...new Set([
    ...shareTokenImbalanceTokens(receipt, positionOwners),
    ...positionAccountImbalanceTokens(receipt, positionAccounts),
  ])].sort();
  const signals = detectNonArbSignals(null, receipt, actors, null);
  const base = classifyWinnerStyle({
    pricedDeltas: valued.priced,
    unpricedDeltas: valued.unpriced,
    nativeWeiPositive: hasBeneficiaryWethUnwrapExit(receipt, actors),
    nativeWeiNegative: false,
    unpricedInTokensWithoutCounterTransfer: valued.unpriced
      .filter((delta) => delta.raw > 0n)
      .map((delta) => delta.token),
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
    share_imbalance_tokens: shareImbalanceTokens,
    retained_share_position_tokens: retainedSharePositionTokensForOwners(receipt, actors),
    inventory_rebalance_selector_hit: false,
  });
  return {
    receipt,
    shareImbalanceTokens,
    signals,
    style: overlayNonArbStyle(base, signals),
  };
}

function event(simulatedProfit: string, bid: string): Record<string, unknown> {
  return {
    simulated_profit: simulatedProfit,
    bid,
    submission_target_block: 25450951,
  };
}

function competitor(winnerStyle: WinnerStyle, builderPaymentWei: string): any {
  return {
    hash: `0x${winnerStyle.padEnd(64, "0").slice(0, 64)}`,
    transactionIndex: 11,
    backrun_positioned: true,
    matched_source_addresses: [],
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    status: "0x1",
    gasUsed: "0",
    effectiveGasPrice: "0",
    priorityTipWei: "0",
    coinbaseTransferWei: "0",
    builderPaymentWei,
    builderPaymentEth: null,
    builderPaymentUsd: null,
    realizedProfitUsd: null,
    profitConfidence: "high",
    nativeTraceUsed: false,
    tracePrestateUsed: false,
    traceError: null,
    v4Swaps: 0,
    v4PoolIds: [],
    touchedVenues: [],
    winner_style: winnerStyle,
    winner_moved_price_beyond_prestate: winnerStyle === "one_leg_inventory",
    unpriced_token_in_flow: winnerStyle === "one_leg_inventory" ? [lower(CFG)] : [],
  };
}

function delta(token: string, raw: bigint, symbol: string, decimals: number): TokenDelta {
  return {
    token: lower(token),
    symbol,
    decimals,
    raw,
  };
}

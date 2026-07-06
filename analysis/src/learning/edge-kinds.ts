import type { EdgeKind, ProtocolAction } from "../../../listener/src/searcher/strategy-taxonomy.js";
import { ADDR, lower, TOPICS } from "../registry/protocols.js";

const SWAP_TOPICS = topicSet([
  TOPICS.univ2Swap,
  TOPICS.univ3Swap,
  TOPICS.univ4Swap,
  TOPICS.curveTokenExchange,
  TOPICS.curveTokenExchangeUnderlying,
  TOPICS.balancerV2Swap,
  TOPICS.pancakeV3Swap,
  TOPICS.dodoSwap,
]);

const FLASH_TOPICS = topicSet([
  TOPICS.balancerV2FlashLoan,
  TOPICS.morphoFlashLoan,
  TOPICS.univ3Flash,
  TOPICS.aaveV3FlashLoan,
]);

const LP_TOPICS = topicSet([
  TOPICS.univ2Mint,
  TOPICS.univ2Burn,
  TOPICS.univ3Mint,
  TOPICS.univ3Burn,
  TOPICS.univ4ModifyLiquidity,
]);

// CREDIT = a leg that opens/closes a DEBT position we hold (borrow/repay + collateral moves).
// Classify by the ACTUAL behavior, NOT by protocol membership: plain Morpho `Supply`/`Withdraw` is a
// LENDING deposit, and — critically — is ALSO what a MetaMorpho VAULT emits internally when we merely
// deposit/redeem its shares (an ERC4626 PROTOCOL leg). Including Supply/Withdraw here mis-tagged
// `0x9be73297` (steakUSDC/USDT vault deposit, ZERO borrow) as credit. Only Borrow/Repay/*Collateral
// represent a credit position we take. (`0x9be73297` classification correction, decision-log F-007.)
const CREDIT_TOPICS = topicSet([
  TOPICS.morphoBorrow,
  TOPICS.morphoRepay,
  TOPICS.morphoSupplyCollateral,
  TOPICS.morphoWithdrawCollateral,
  TOPICS.aaveV3Borrow,
  TOPICS.aaveV3Repay,
  // NOT morphoSupply/morphoWithdraw — plain lending supply/withdraw (incl. a MetaMorpho vault's internal
  // ops) is not a credit LEG; it's protocol/lending. See the block comment above.
  // TODO(credit): Fluid Liquidity LogOperate — pending a verified signature (see registry/protocols.ts).
]);

// Protocol legs: the protocol's OWN asset-conversion rule (Liquity trove ops, ERC4626 vault
// entry/exit). Sky PSM BuyGem/SellGem pending a verified signature (see registry/protocols.ts).
const PROTOCOL_TOPICS = topicSet([
  TOPICS.liquityTroveOperation,
  TOPICS.liquityTroveUpdated,
  TOPICS.liquityBatchUpdated,
  TOPICS.erc4626Deposit,
  TOPICS.erc4626Withdraw,
  TOPICS.psmSellGem,
  TOPICS.psmBuyGem,
]);

const STABLE_ORDER: EdgeKind[] = ["flash", "swap", "credit", "lp", "protocol"];

export function deriveEdgeKindsFromLogs(logs: Array<{ topics?: unknown }> | undefined | null): EdgeKind[] {
  const seen = new Set<EdgeKind>();
  for (const log of logs ?? []) {
    const topic0 = topic0Of(log);
    if (!topic0) continue;
    if (FLASH_TOPICS.has(topic0)) seen.add("flash");
    if (SWAP_TOPICS.has(topic0)) seen.add("swap");
    if (CREDIT_TOPICS.has(topic0)) seen.add("credit");
    if (LP_TOPICS.has(topic0)) seen.add("lp");
    if (PROTOCOL_TOPICS.has(topic0)) seen.add("protocol");
  }
  return STABLE_ORDER.filter((kind) => seen.has(kind));
}

const ACTION_ORDER: ProtocolAction[] = ["mint", "redeem", "wrap", "unwrap", "convert", "stake", "unstake"];
const ZERO_WORD = `0x${"0".repeat(64)}`;
const ERC4626_DEPOSIT = lower(TOPICS.erc4626Deposit);
const ERC4626_WITHDRAW = lower(TOPICS.erc4626Withdraw);
const PSM_SELL_GEM = lower(TOPICS.psmSellGem);
const PSM_BUY_GEM = lower(TOPICS.psmBuyGem);
const WETH_DEPOSIT = lower(TOPICS.wethDeposit);
const WETH_WITHDRAWAL = lower(TOPICS.wethWithdrawal);
const TRANSFER = lower(TOPICS.transfer);
const WETH_ADDR = lower(ADDR.WETH);

/**
 * Topic-level protocol-action observations (evidence-based; no data decoding):
 * - ERC4626 Deposit/Withdraw → "stake"/"unstake" (vault share entry/exit);
 * - WETH Deposit/Withdrawal (WETH emitter only) → "wrap"/"unwrap";
 * - generic mint: an ERC20 Transfer with from == 0x0 on a non-LP emitter → "mint" (an emitter that
 *   also logs an LP topic in the same log set is an AMM pair minting its own LP token, not a
 *   protocol mint). Covers BOLD-style tokens with no named protocol event (coffee tx-2 exemplar).
 * Liquity TroveOperation/TroveUpdated/BatchUpdated topics classify the EDGE as "protocol"
 * (deriveEdgeKindsFromLogs); the action direction (mint vs redeem vs adjust) is not decidable from
 * topic0 alone, so no action is emitted for them directly — the minted token's Transfer-from-0x0
 * carries the mint evidence.
 */
export function deriveProtocolActionsFromLogs(
  logs: Array<{ topics?: unknown; address?: unknown }> | undefined | null,
): ProtocolAction[] {
  const all = [...(logs ?? [])];
  const lpEmitters = new Set<string>();
  for (const log of all) {
    const topic0 = topic0Of(log);
    if (topic0 && LP_TOPICS.has(topic0)) lpEmitters.add(addressOf(log));
  }
  const seen = new Set<ProtocolAction>();
  for (const log of all) {
    const topic0 = topic0Of(log);
    if (!topic0) continue;
    if (topic0 === ERC4626_DEPOSIT) seen.add("stake");
    if (topic0 === ERC4626_WITHDRAW) seen.add("unstake");
    if (topic0 === PSM_SELL_GEM || topic0 === PSM_BUY_GEM) seen.add("convert");
    if (topic0 === WETH_DEPOSIT && addressOf(log) === WETH_ADDR) seen.add("wrap");
    if (topic0 === WETH_WITHDRAWAL && addressOf(log) === WETH_ADDR) seen.add("unwrap");
    if (topic0 === TRANSFER && transferFromZero(log) && !lpEmitters.has(addressOf(log))) seen.add("mint");
  }
  return ACTION_ORDER.filter((action) => seen.has(action));
}

function transferFromZero(log: { topics?: unknown }): boolean {
  if (!Array.isArray(log.topics) || log.topics.length < 3) return false;
  const from = log.topics[1];
  return typeof from === "string" && lower(from) === ZERO_WORD;
}

function addressOf(log: { address?: unknown }): string {
  return typeof log.address === "string" ? lower(log.address) : "";
}

function topic0Of(log: { topics?: unknown }): string | null {
  if (!Array.isArray(log.topics) || typeof log.topics[0] !== "string") return null;
  return lower(log.topics[0]);
}

function topicSet(topics: string[]): Set<string> {
  return new Set(topics.map(lower));
}

import { ethers } from "ethers";

const AUTHORIZED_MAX_WALLET_WEI = ethers.parseEther("0.2");
export const DEFAULT_BRIBE_BPS = 5_000;

export interface LiveEnvelopeInput {
  dryRun: boolean;
  evGate: boolean;
  bribeBps: number;
  bribeAllAboveGas: boolean;
  minNetEth: bigint;
  profitHaircutBps: number;
  walletAddress: string;
  botvmAddress: string;
  configuredBotvmOwner?: string;
  maxWalletEth?: string;
}

export interface LiveEnvelopeProbe {
  walletBalance(address: string): Promise<bigint>;
  botvmOwner(address: string): Promise<string>;
}

/** Fail closed before any live submission component is constructed. */
export async function validateLiveEnvelope(
  input: LiveEnvelopeInput,
  probe: LiveEnvelopeProbe,
): Promise<void> {
  if (input.dryRun) return;
  if (!input.evGate) throw new Error("bounded-live requires SEARCHER_EV_GATE=1");
  if (!Number.isInteger(input.bribeBps) || input.bribeBps < 0 || input.bribeBps > 10_000) {
    throw new Error("bounded-live SEARCHER_BRIBE_BPS must be an integer between 0 and 10000");
  }
  if (input.bribeAllAboveGas) {
    throw new Error(
      "bounded-live SEARCHER_BRIBE_ALL_ABOVE_GAS must be disabled to retain positive EV",
    );
  }
  if (input.bribeBps >= 10_000) {
    throw new Error(
      "bounded-live SEARCHER_BRIBE_BPS must retain positive EV",
    );
  }
  if (input.minNetEth < 0n) {
    throw new Error("bounded-live SEARCHER_MIN_NET_ETH must be non-negative");
  }
  if (
    !Number.isInteger(input.profitHaircutBps) ||
    input.profitHaircutBps < 0 ||
    input.profitHaircutBps > 10_000
  ) {
    throw new Error(
      "bounded-live SEARCHER_PROFIT_HAIRCUT_BPS must be an integer between 0 and 10000",
    );
  }
  if (!input.configuredBotvmOwner) throw new Error("bounded-live requires BOTVM_OWNER");

  const wallet = ethers.getAddress(input.walletAddress);
  const botvm = ethers.getAddress(input.botvmAddress);
  const configuredOwner = ethers.getAddress(input.configuredBotvmOwner);
  if (wallet !== configuredOwner) {
    throw new Error(`bounded-live signer ${wallet} does not match BOTVM_OWNER ${configuredOwner}`);
  }

  let capWei: bigint;
  try {
    capWei = ethers.parseEther(input.maxWalletEth ?? "0.2");
  } catch {
    throw new Error("bounded-live wallet cap is invalid");
  }
  if (capWei <= 0n || capWei > AUTHORIZED_MAX_WALLET_WEI) {
    throw new Error("bounded-live wallet cap must be positive and no greater than 0.2 ETH");
  }

  const onchainOwner = ethers.getAddress(await probe.botvmOwner(botvm));
  if (onchainOwner !== wallet) {
    throw new Error(`bounded-live signer ${wallet} is not BotVM owner ${onchainOwner}`);
  }

  const balance = await probe.walletBalance(wallet);
  if (balance > capWei) {
    throw new Error(`bounded-live wallet balance ${balance} exceeds cap ${capWei}`);
  }
}

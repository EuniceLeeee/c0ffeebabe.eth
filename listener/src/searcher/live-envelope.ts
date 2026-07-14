import { ethers } from "ethers";

const AUTHORIZED_MAX_WALLET_WEI = ethers.parseEther("0.2");

export interface LiveEnvelopeInput {
  dryRun: boolean;
  evGate: boolean;
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

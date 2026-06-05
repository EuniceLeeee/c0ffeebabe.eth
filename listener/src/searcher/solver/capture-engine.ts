import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { ModeBAmounts } from "./quote-engine.js";

interface ProviderBackedState extends StateBackend {
  provider: ethers.JsonRpcProvider;
}

export async function captureDynamicAmounts(
  state: StateBackend,
  seed: ModeBAmounts,
): Promise<ModeBAmounts> {
  const provider = getProvider(state);
  const snap = await state.snapshot();
  try {
    const artifact = loadArtifact();
    const iface = new ethers.Interface(artifact.abi);
    const from = await firstAccount(provider);
    const contract = await deploy(provider, from, artifact.bytecode.object ?? artifact.bytecode);

    const data = iface.encodeFunctionData("capture", [
      seed.flashAmount,
      seed.debtAmount1,
      seed.debtAmount2,
      seed.v4TakeAmount,
      seed.v3ExactOutput,
    ]);
    await sendAndMine(provider, {
      from,
      to: contract,
      data,
      gas: "0x1000000",
    }, "capture");

    const [
      daiAmount,
      usdtReceived,
      wethOwed,
      susdsOut,
      dolaAmount,
    ] = await Promise.all([
      readUint(provider, iface, contract, "daiAmount"),
      readUint(provider, iface, contract, "usdtReceivedPhase2"),
      readUint(provider, iface, contract, "wethOwed"),
      readUint(provider, iface, contract, "susdsOut"),
      readUint(provider, iface, contract, "dolaAmount"),
    ]);

    await state.revert(snap);
    return {
      ...seed,
      daiAmount,
      usdtReceived,
      wethOwed,
      susdsOut,
      dolaAmount,
    };
  } catch (err) {
    await state.revert(snap);
    throw err;
  }
}

function getProvider(state: StateBackend): ethers.JsonRpcProvider {
  const provider = (state as ProviderBackedState).provider;
  if (!provider) throw new Error("capture requires AnvilStateBackend provider");
  return provider;
}

function loadArtifact(): any {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "../../../../out/CaptureArbSim.sol/CaptureArbSim.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

async function firstAccount(provider: ethers.JsonRpcProvider): Promise<string> {
  const accounts: string[] = await provider.send("eth_accounts", []);
  if (accounts.length === 0) throw new Error("anvil has no funded accounts");
  return ethers.getAddress(accounts[0]);
}

async function deploy(provider: ethers.JsonRpcProvider, from: string, bytecode: string): Promise<string> {
  const hash = await provider.send("eth_sendTransaction", [{ from, data: bytecode, gas: "0x800000" }]);
  await provider.send("anvil_mine", ["0x1"]);
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt?.contractAddress || receipt.status !== 1) {
    throw new Error(`capture deploy failed: ${hash}`);
  }
  return receipt.contractAddress;
}

async function sendAndMine(
  provider: ethers.JsonRpcProvider,
  tx: { from: string; to: string; data: string; gas: string },
  label: string,
): Promise<void> {
  const hash = await provider.send("eth_sendTransaction", [tx]);
  await provider.send("anvil_mine", ["0x1"]);
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label} reverted: ${hash}`);
  }
}

async function readUint(
  provider: ethers.JsonRpcProvider,
  iface: ethers.Interface,
  contract: string,
  fn: string,
): Promise<bigint> {
  const result = await provider.call({ to: contract, data: iface.encodeFunctionData(fn) });
  return BigInt(iface.decodeFunctionResult(fn, result)[0]);
}


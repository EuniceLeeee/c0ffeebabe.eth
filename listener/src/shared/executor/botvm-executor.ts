import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const BOTVM_EXECUTE_SELECTOR = "0x09c5eabe";

export const DEFAULT_SEARCHER_OWNER = "0x1000000000000000000000000000000000000001";
export const DEFAULT_SEARCHER_EXECUTOR = "0x00000000000000000000000000000000b07c0de5";

export function buildExecuteCalldata(script: Uint8Array): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(["bytes"], [script]);
  return BOTVM_EXECUTE_SELECTOR + encoded.slice(2);
}

export async function installForkBotVm(
  provider: ethers.JsonRpcProvider,
  owner = DEFAULT_SEARCHER_OWNER,
  executor = DEFAULT_SEARCHER_EXECUTOR,
): Promise<string> {
  const addr = ethers.getAddress(executor);
  const runtime = patchedBotVmRuntime(owner);
  await provider.send("anvil_setCode", [addr, runtime]);
  await provider.send("anvil_setBalance", [
    ethers.getAddress(owner),
    "0x56bc75e2d63100000",
  ]);
  await provider.send("anvil_impersonateAccount", [ethers.getAddress(owner)]);
  const code = await provider.getCode(addr);
  if (code === "0x") throw new Error(`failed to install BotVM at ${addr}`);
  return addr;
}

function patchedBotVmRuntime(owner: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const artifactPath = resolve(here, "../../../../out/BotVM.sol/BotVM.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  let runtime: string | undefined = artifact.deployedBytecode?.object;
  const refs = artifact.deployedBytecode?.immutableReferences ?? {};
  if (!runtime || runtime === "0x") {
    throw new Error("BotVM artifact missing deployed bytecode; run forge build");
  }

  for (const refList of Object.values(refs) as Array<Array<{ start: number; length: number }>>) {
    for (const ref of refList) {
      const encoded = ethers.zeroPadValue(owner, ref.length).slice(2);
      const start = 2 + ref.start * 2;
      const end = start + ref.length * 2;
      runtime = runtime.slice(0, start) + encoded + runtime.slice(end);
    }
  }
  return runtime;
}

export async function readTokenDeltas(params: {
  provider: ethers.JsonRpcProvider;
  account: string;
  tokens: Array<{ symbol: string; address: string }>;
  before: Record<string, bigint>;
}): Promise<Record<string, bigint>> {
  const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
  const deltas: Record<string, bigint> = {};
  for (const token of params.tokens) {
    const result = await params.provider.call({
      to: token.address,
      data: erc20.encodeFunctionData("balanceOf", [params.account]),
    });
    const post = BigInt(result);
    const delta = post - (params.before[token.symbol] ?? 0n);
    if (delta !== 0n) deltas[token.symbol] = delta;
  }
  return deltas;
}


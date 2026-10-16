import { ethers } from "ethers";

/** Explicit unsigned observation mode. It cannot be enabled by an environment file. */
export function keylessDryRunEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.SEARCHER_DRY_RUN_KEYLESS;
  if (flag === undefined || flag === "0") return false;
  if (flag !== "1") throw new Error("SEARCHER_DRY_RUN_KEYLESS must be 0 or 1");
  if (env.SEARCHER_DRY_RUN !== "1" || env.SEARCHER_BLOCKSCAN_SUBMIT !== "0") {
    throw new Error("keyless observation requires SEARCHER_DRY_RUN=1 and SEARCHER_BLOCKSCAN_SUBMIT=0");
  }
  return true;
}

export function loadLiveEnvironment(env: NodeJS.ProcessEnv, readEnvironment: () => string): void {
  // Resolve the explicit process flag before any file or key can be read.
  if (keylessDryRunEnabled(env) || env.SEARCHER_TEST_DISABLE_DOTENV === "1") return;
  let text = "";
  try { text = readEnvironment(); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.replace(/^export\s+/, "");
    if (key === "SEARCHER_DRY_RUN_KEYLESS" && rest.join("=").replace(/^["']|["']$/g, "") === "1") {
      throw new Error("SEARCHER_DRY_RUN_KEYLESS must be supplied by the process environment, not .env");
    }
    if (!env[key]) env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

export function buildLiveExecutionWallet(
  provider: ethers.JsonRpcProvider,
  env: NodeJS.ProcessEnv = process.env,
): ethers.Wallet | ethers.VoidSigner {
  if (keylessDryRunEnabled(env)) {
    if (!env.BOTVM_OWNER) throw new Error("keyless observation requires public BOTVM_OWNER");
    const owner = ethers.getAddress(env.BOTVM_OWNER);
    if (owner === ethers.ZeroAddress) throw new Error("keyless observation requires nonzero BOTVM_OWNER");
    return new ethers.VoidSigner(owner, provider);
  }
  const privateKey = env.PRIVATE_KEY ?? env.OWNER_PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY or OWNER_PRIVATE_KEY required");
  const wallet = new ethers.Wallet(privateKey, provider);
  const botvmOwner = env.BOTVM_OWNER;
  if (botvmOwner && wallet.address.toLowerCase() !== botvmOwner.toLowerCase()) {
    throw new Error(`PRIVATE_KEY wallet ${wallet.address} does not match BOTVM_OWNER ${botvmOwner}`);
  }
  return wallet;
}

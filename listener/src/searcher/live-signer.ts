import { ethers } from "ethers";

export function liveDryRunEnabled(env: NodeJS.ProcessEnv): boolean {
  switch (env.SEARCHER_DRY_RUN) {
    case undefined: case "1": return true;
    case "0": return false;
    default: throw new Error("SEARCHER_DRY_RUN must be 0 or 1");
  }
}

/** Dry-run owns only a public address. Even when an existing environment
 * contains a key, the signer returned to the runtime cannot sign anything. */
export function liveExecutionSigner(env: NodeJS.ProcessEnv, provider: ethers.Provider) {
  const dry = liveDryRunEnabled(env);
  const key = env.PRIVATE_KEY ?? env.OWNER_PRIVATE_KEY;
  const owner = env.BOTVM_OWNER ? ethers.getAddress(env.BOTVM_OWNER) : undefined;
  if (owner === ethers.ZeroAddress) throw new Error("BOTVM_OWNER cannot be the zero address");
  if (!key && !dry) throw new Error("PRIVATE_KEY or OWNER_PRIVATE_KEY required for live");
  if (!key && !owner) throw new Error("keyless dry-run requires BOTVM_OWNER");
  const derived = key ? new ethers.Wallet(key).address : undefined;
  if (owner && derived && owner !== derived) throw new Error("configured signer does not match BOTVM_OWNER");
  return dry ? new ethers.VoidSigner(owner ?? derived!, provider) : new ethers.Wallet(key!, provider);
}

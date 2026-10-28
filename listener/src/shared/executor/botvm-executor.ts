import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const BOTVM_EXECUTE_SELECTOR = "0x09c5eabe";

export const DEFAULT_SEARCHER_OWNER = "0x1000000000000000000000000000000000000001";
export const DEFAULT_SEARCHER_EXECUTOR = "0x00000000000000000000000000000000b07c0de5";

export interface ForkBotVmRuntimeReceipt {
  readonly owner: string;
  readonly executor: string;
  readonly artifactSha256: string;
  readonly runtimeCodeSha256: string;
}

export interface BotVmRuntimeCode {
  readonly code: string;
  readonly keccak256: string;
}

export function dryRunBotVmCodeOverrideEnabled(
  flag: string | undefined,
  dryRun: boolean,
  blockScanSubmit: boolean,
): boolean {
  if (flag !== undefined && flag !== "0" && flag !== "1") {
    throw new Error("SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE must be 0 or 1");
  }
  if (flag !== "1") return false;
  if (!dryRun || blockScanSubmit) {
    throw new Error("SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE requires dry-run with block-scan submission disabled");
  }
  return true;
}

/** Read once at startup; callers retain these exact owner-bound bytes per run. */
export function loadBotVmRuntimeCode(owner: string): BotVmRuntimeCode {
  const code = patchedBotVmRuntime(ethers.getAddress(owner)).toLowerCase();
  return Object.freeze({ code, keccak256: ethers.keccak256(code) });
}

export function forkBotVmInstallationEnabled(
  blindProductionAudit: boolean,
  flag: string | undefined,
): boolean {
  if (flag !== undefined && flag !== "0" && flag !== "1") {
    throw new Error("SEARCHER_BLIND_INSTALL_FORK_BOTVM must be 0 or 1");
  }
  if (!blindProductionAudit && flag === "1") {
    throw new Error("SEARCHER_BLIND_INSTALL_FORK_BOTVM is replay-only");
  }
  return blindProductionAudit && flag === "1";
}

export function buildExecuteCalldata(script: Uint8Array): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(["bytes"], [script]);
  return BOTVM_EXECUTE_SELECTOR + encoded.slice(2);
}

/** Explicit new-executor entry. Existing deployed executors keep the ABI path.
 * Callers must final-sim and submit this exact returned input, never swap it
 * after simulation. The uncompressed script remains the diagnostic witness. */
export function buildRawExecuteCalldata(script: Uint8Array): string {
  // Only raw-entry-independent runtime programs qualify. Reading an outer
  // ABI word would change meaning; callback calldata remains a separate frame.
  if (!canUseRawExecuteCalldata(script)) throw new Error("script requires ABI entry context");
  return ethers.id("executeRaw()").slice(0, 10) + ethers.hexlify(script).slice(2);
}

export function rawExecutionEntryEnabled(flag: string | undefined): boolean {
  if (flag !== undefined && flag !== "0" && flag !== "1") throw new Error("SEARCHER_BOTVM_RAW_ENTRY must be 0 or 1");
  return flag === "1";
}

export function canUseRawExecuteCalldata(script: Uint8Array): boolean {
  const u24 = (p: number) => script[p]! * 65536 + script[p + 1]! * 256 + script[p + 2]!;
  const walk = (start: number, end: number, depth: number): boolean => {
    if (depth > 8 || end - start < 2 || (script[start] !== 1 && script[start] !== 2)) return false;
    const sequence = script[start] === 2;
    let p = start + 1, count = 0;
    while (p < end) {
      if (++count > 128) return false;
      const op = script[p]!;
      if (sequence && op !== 9 && op !== 10 && op !== 11 && op !== 12) return false;
      let size: number | undefined = ({ 0: 34, 2: 5, 3: 3, 4: 74, 5: 2, 6: 5, 9: 34, 11: 37 } as Record<number, number>)[op];
      if (op === 1) {
        if (p + 30 > end) return false;
        const at = p + 30 + script[p + 29]! * 4;
        if (at + 3 > end) return false;
        size = at + 3 + u24(at) - p;
      } else if (op === 12 && sequence) {
        if (p + 30 > end) return false;
        size = 30 + u24(p + 27);
      } else if (op === 10) {
        if (p + 24 > end) return false;
        size = 24 + u24(p + 21);
      } else if (op === 8) {
        if (p + 7 > end) return false;
        size = 7 + u24(p + 4);
        if (p + size > end || !walk(p + 7, p + size, depth + 1)) return false;
      }
      // In particular, opcode 7 reads this call frame's original calldata.
      if (size === undefined || p + size > end) return false;
      p += size;
    }
    return p === end;
  };
  if (script.length >= 3 && script[0] === 15 && script[1] === 2) return walk(1, script.length, 0);
  return script.length >= 38 && script[0] === 14 && u24(33) === script.length - 36
    && walk(36, script.length, 0);
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
  if (code.toLowerCase() !== runtime.toLowerCase()) {
    throw new Error(`failed to install exact BotVM runtime at ${addr}`);
  }
  return addr;
}

/**
 * Content binding for the exact fork-only BotVM bytes installed above.
 * The receipt contains no path and is safe to embed in replay evidence.
 */
export function forkBotVmRuntimeReceipt(
  owner = DEFAULT_SEARCHER_OWNER,
  executor = DEFAULT_SEARCHER_EXECUTOR,
): ForkBotVmRuntimeReceipt {
  const artifact = botVmArtifact();
  const runtime = patchedBotVmRuntime(owner, artifact.parsed);
  return Object.freeze({
    owner: ethers.getAddress(owner).toLowerCase(),
    executor: ethers.getAddress(executor).toLowerCase(),
    artifactSha256: createHash("sha256")
      .update(artifact.raw)
      .digest("hex"),
    runtimeCodeSha256: createHash("sha256")
      .update(Buffer.from(ethers.getBytes(runtime)))
      .digest("hex"),
  });
}

function botVmArtifact(): {
  readonly raw: string;
  readonly parsed: {
    readonly deployedBytecode?: {
      readonly object?: string;
      readonly immutableReferences?: Record<
        string,
        Array<{ start: number; length: number }>
      >;
    };
  };
} {
  const here = dirname(fileURLToPath(import.meta.url));
  const artifactPath = resolve(here, "../../../../out/BotVM.sol/BotVM.json");
  const raw = readFileSync(artifactPath, "utf8");
  return { raw, parsed: JSON.parse(raw) };
}

function patchedBotVmRuntime(
  owner: string,
  artifact = botVmArtifact().parsed,
): string {
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

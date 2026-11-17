import { AbiCoder, getAddress, keccak256, ZeroHash } from "ethers";
import type { DiscoverySemantics, UnifiedObservation } from "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";

const surfaceFingerprint = "univ4-pool-surface-v1";
const abi = AbiCoder.defaultAbiCoder();
type PoolKey = Readonly<{ currency0: string; currency1: string; fee: string; tickSpacing: string; hooks: string }>;
const keyFor = (manager: string, poolId: string) => manager.toLowerCase() + "|" + poolId.toLowerCase();

/** A PoolKey is immutable under its hash. Take only complete candidates whose
 * ABI-encoded key reproduces their poolId, regardless of which Family found it. */
export function indexKnownUniV4PoolKeys(candidates: Iterable<unknown>): ReadonlyMap<string, PoolKey> {
  const keys = new Map<string, PoolKey>();
  for (const value of candidates) {
    if (!value || typeof value !== "object") continue;
    const candidate = value as Readonly<Record<string, unknown>>;
    if (candidate.candidateKind !== "univ4-pool-key" ||
        typeof candidate.manager !== "string" || typeof candidate.poolId !== "string") continue;
    try {
      const manager = getAddress(candidate.manager);
      if (typeof candidate.address === "string" && getAddress(candidate.address) !== manager) continue;
      const currency0 = getAddress(candidate.currency0 as string);
      const currency1 = getAddress(candidate.currency1 as string);
      const fee = BigInt(candidate.fee as string);
      const tickSpacing = BigInt(candidate.tickSpacing as string);
      const hooks = getAddress(candidate.hooks as string);
      const poolId = keccak256(abi.encode(["address", "address", "uint24", "int24", "address"],
        [currency0, currency1, fee, tickSpacing, hooks]));
      if (poolId !== candidate.poolId.toLowerCase()) continue;
      keys.set(keyFor(manager, poolId), Object.freeze({ currency0, currency1, fee: String(fee),
        tickSpacing: String(tickSpacing), hooks }));
    } catch { /* An incomplete or invalid key cannot exclude a nomination. */ }
  }
  return keys;
}

/** undefined = insufficient evidence, null = Family excluded this PoolKey.
 * Successful prechecks still go through the original source-bound nomination.
 * The temporary observation is only for the declared pure surface decoder. */
export function knownUniV4NominationPoolKey(input: {
  keys: ReadonlyMap<string, PoolKey>;
  discovery: Pick<DiscoverySemantics<any>, "addressSurfaces" | "decodeCandidate">;
  manager: string;
  poolId: string;
  source: CanonicalSource;
}): PoolKey | null | undefined {
  const { keys, discovery, manager, poolId, source } = input;
  const poolKey = keys.get(keyFor(manager, poolId));
  const surfaces = discovery.addressSurfaces ?? [];
  if (!poolKey || surfaces.length !== 1) return undefined;
  const surface = surfaces[0]!;
  if (surface.kind !== "interface" || surface.fingerprint !== surfaceFingerprint) return undefined;
  const observation: UnifiedObservation = {
    kind: "address-surface", source, address: manager, codeHash: ZeroHash, implementationWord: ZeroHash,
    interfaceFingerprints: [surfaceFingerprint], opaque: { poolId, poolKey },
  };
  return discovery.decodeCandidate({ observation, matchedPatternId: surface.id }) === null ? null : poolKey;
}

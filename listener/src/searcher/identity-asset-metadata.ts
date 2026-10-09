import { ethers } from "ethers";
import { ADDR } from "../shared/constants/addresses.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource, RequestRequirements } from "./venues/adapter-request-program.js";

/** A Family interprets its protocol's asset identifier. Native declarations
 * contain no guessed sentinel address; central code supplies chain metadata. */
export type IdentityAssetDeclaration =
  | { readonly key: string; readonly kind: "native" }
  | { readonly key: string; readonly kind: "erc20"; readonly address: string };

export type IdentityAssetMetadata =
  | { readonly key: string; readonly kind: "native"; readonly token: string; readonly decimals: 18 }
  | { readonly key: string; readonly kind: "erc20"; readonly token: string; readonly code: string;
      readonly decimals: number | null };

const PREFIX = "central-asset:";
const ERC20 = new ethers.Interface(["function decimals() view returns (uint8)"]);

export function identityAssetRequestId(key: string, field: "code" | "decimals"): string {
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(key)) throw new Error("identity asset key");
  return `${PREFIX}${key}:${field}`;
}

/** Expands declarations in the current identity round, using the existing
 * bounded request scheduler. No extra transport, lifecycle or RPC for ETH. */
export function createIdentityAssetMetadataPlan(
  value: readonly IdentityAssetDeclaration[], source: CanonicalSource,
) {
  if (!Array.isArray(value) || value.length > 64) throw new Error("identity asset declarations");
  const keys = new Set<string>();
  const declarations = Object.freeze(Array.from(value, (item): IdentityAssetDeclaration => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("identity asset declaration");
    if (Object.values(Object.getOwnPropertyDescriptors(item)).some(d => !("value" in d) || !d.enumerable)) {
      throw new Error("identity asset declaration fields");
    }
    const allowed = item.kind === "native" ? ["key", "kind"] : ["address", "key", "kind"];
    if (Reflect.ownKeys(item).sort().join(",") !== allowed.join(",")) {
      throw new Error("identity asset declaration fields");
    }
    if (typeof item.key !== "string") throw new Error("identity asset key");
    identityAssetRequestId(item.key, "code");
    if (keys.has(item.key)) throw new Error("duplicate identity asset key");
    keys.add(item.key);
    if (item.kind === "native") return Object.freeze({ key: item.key, kind: item.kind });
    if (item.kind !== "erc20" || typeof item.address !== "string") throw new Error("identity asset kind");
    const address = ethers.getAddress(item.address);
    if (address === ethers.ZeroAddress) throw new Error("identity erc20 asset address");
    return Object.freeze({ key: item.key, kind: item.kind, address });
  }));
  const requests: readonly AdapterRequest[] = Object.freeze(declarations.flatMap((asset): AdapterRequest[] =>
    asset.kind === "native" ? [] : [
      { id: identityAssetRequestId(asset.key, "code"), kind: "get-code", address: asset.address },
      { id: identityAssetRequestId(asset.key, "decimals"), kind: "eth-call", to: asset.address,
        data: ERC20.encodeFunctionData("decimals"), completion: "return-or-revert-data" },
    ]));
  return Object.freeze({
    isMetadataResult(id: string): boolean { return requests.some(r => r.id === id); },
    requirements(base: RequestRequirements): RequestRequirements {
      if (!requests.length) return base;
      return { ...base, transports: [...new Set([...base.transports, "get-code" as const, "eth-call" as const])],
        ...(base.completions === undefined ? {} : {
          completions: [...new Set([...base.completions, "return-or-revert-data" as const])],
        }) };
    },
    append(original: readonly AdapterRequest[]): readonly AdapterRequest[] {
      if (original.some(r => r.id.startsWith(PREFIX))) throw new Error("reserved identity asset request id");
      return Object.freeze([...original, ...requests]);
    },
    decode(results: readonly AdapterRequestResult[]): readonly IdentityAssetMetadata[] {
      const result = (id: string) => {
        const matches = results.filter(r => r.id === id);
        if (matches.length !== 1 || !matches[0].ok) throw new Error(`identity asset result unavailable: ${id}`);
        const r = matches[0];
        if (r.source.number !== source.number || r.source.generation !== source.generation ||
            r.source.hash.toLowerCase() !== source.hash.toLowerCase()) throw new Error("identity asset source mismatch");
        return r;
      };
      return Object.freeze(declarations.map((asset): IdentityAssetMetadata => {
        if (asset.kind === "native") return Object.freeze({ key: asset.key, kind: asset.kind,
          token: ethers.getAddress(ADDR.WETH), decimals: 18 });
        const code = result(identityAssetRequestId(asset.key, "code"));
        const decimalResult = result(identityAssetRequestId(asset.key, "decimals"));
        if (code.completion !== "returned" || !/^0x(?:[a-fA-F0-9]{2})*$/.test(code.data)) throw new Error("identity asset code result");
        // A missing ERC20 contract remains negative evidence, never native.
        // Keep it distinct from a malformed decimals response on a real token.
        let decimals: number | null = null;
        if (code.data !== "0x") {
          if (decimalResult.completion !== "returned" || !/^0x[0-9a-fA-F]{64}$/.test(decimalResult.data)) {
            throw new Error("identity asset decimals result");
          }
          const n = BigInt(decimalResult.data);
          if (n > 255n) throw new Error("identity asset decimals range");
          decimals = Number(n);
        }
        return Object.freeze({ key: asset.key, kind: asset.kind, token: asset.address, code: code.data, decimals });
      }));
    },
  });
}

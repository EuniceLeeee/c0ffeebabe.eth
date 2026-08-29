import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  deepFreeze,
  hashDomain,
  readOwnEnumerableDataProperty,
  type Hash,
} from "../../canonical-codec/src/index.ts";

export const ASSET_REF_DOMAIN_V1 = "aloha/asset-ref/v1" as const;

export type AssetKindV1 = "erc20" | "native";

export interface AssetIdentityV1 {
  readonly chainId: string;
  readonly kind: AssetKindV1;
  readonly address: string | null;
}

export interface AssetReferenceV1 {
  readonly identity: AssetIdentityV1;
  readonly assetRef: Hash;
}

export interface AssetPortBindingV1 {
  readonly assetIdentity: AssetIdentityV1;
  readonly assetRef: Hash;
}

function canonicalChainId(value: unknown, path: string): string {
  const chainId = assertDecimalString(value, path);
  if (chainId === "0" || BigInt(chainId).toString(10) !== chainId) {
    throw new TypeError(`${path} must be a positive canonical decimal chain id`);
  }
  return chainId;
}

export function canonicalEvmAddress(value: unknown, path = "asset.address"): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new TypeError(`${path} must be a 20-byte EVM address`);
  }
  return `0x${value.slice(2).toLowerCase()}`;
}

export function decodeAssetIdentityV1(value: unknown, path = "asset.identity"): AssetIdentityV1 {
  const object = value as object;
  assertExactKeys(object, ["chainId", "kind", "address"], path);
  const chainId = canonicalChainId(readOwnEnumerableDataProperty(object, "chainId", path), `${path}.chainId`);
  const kind = readOwnEnumerableDataProperty(object, "kind", path);
  const rawAddress = readOwnEnumerableDataProperty(object, "address", path);
  if (kind === "native") {
    if (rawAddress !== null) throw new TypeError(`${path}.address must be null for native assets`);
    return deepFreeze({ chainId, kind, address: null });
  }
  if (kind !== "erc20") throw new TypeError(`${path}.kind is not supported`);
  const address = canonicalEvmAddress(rawAddress, `${path}.address`);
  if (rawAddress !== address) throw new TypeError(`${path}.address must use canonical lowercase encoding`);
  if (address === "0x0000000000000000000000000000000000000000") {
    throw new TypeError(`${path}.address cannot be the zero address for erc20 assets`);
  }
  return deepFreeze({ chainId, kind, address });
}

export function assetRefForIdentityV1(identity: AssetIdentityV1): Hash {
  return hashDomain(ASSET_REF_DOMAIN_V1, decodeAssetIdentityV1(identity));
}

export function decodeAssetReferenceV1(value: unknown, path = "assetReference"): AssetReferenceV1 {
  const object = value as object;
  assertExactKeys(object, ["identity", "assetRef"], path);
  const identity = decodeAssetIdentityV1(
    readOwnEnumerableDataProperty(object, "identity", path),
    `${path}.identity`,
  );
  const assetRef = assertHash(
    readOwnEnumerableDataProperty(object, "assetRef", path),
    `${path}.assetRef`,
  );
  if (assetRef !== assetRefForIdentityV1(identity)) throw new TypeError(`${path}.assetRef does not match identity`);
  return deepFreeze({ identity, assetRef });
}

export function erc20AssetReferenceV1(chainId: string, address: string): AssetReferenceV1 {
  const identity = deepFreeze({
    chainId: canonicalChainId(chainId, "asset.chainId"),
    kind: "erc20" as const,
    address: canonicalEvmAddress(address),
  });
  if (identity.address === "0x0000000000000000000000000000000000000000") {
    throw new TypeError("asset.address cannot be the zero address for erc20 assets");
  }
  return deepFreeze({ identity, assetRef: assetRefForIdentityV1(identity) });
}

export function nativeAssetReferenceV1(chainId: string): AssetReferenceV1 {
  const identity = deepFreeze({
    chainId: canonicalChainId(chainId, "asset.chainId"),
    kind: "native" as const,
    address: null,
  });
  return deepFreeze({ identity, assetRef: assetRefForIdentityV1(identity) });
}

export function erc20AssetRefV1(chainId: string, address: string): Hash {
  return erc20AssetReferenceV1(chainId, address).assetRef;
}

export function nativeAssetRefV1(chainId: string): Hash {
  return nativeAssetReferenceV1(chainId).assetRef;
}

export function assetPortBindingV1(reference: AssetReferenceV1): AssetPortBindingV1 {
  const decoded = decodeAssetReferenceV1(reference);
  return deepFreeze({ assetIdentity: decoded.identity, assetRef: decoded.assetRef });
}

export function erc20AssetPortBindingV1(chainId: string, address: string): AssetPortBindingV1 {
  return assetPortBindingV1(erc20AssetReferenceV1(chainId, address));
}

export function nativeAssetPortBindingV1(chainId: string): AssetPortBindingV1 {
  return assetPortBindingV1(nativeAssetReferenceV1(chainId));
}

export function assertAssetReferenceMatchesV1(
  identity: AssetIdentityV1,
  assetRef: Hash,
  path = "assetReference",
): AssetReferenceV1 {
  return decodeAssetReferenceV1({ identity, assetRef }, path);
}

export * from "./kernel/math.ts";
export { canonicalAddress, decodeAddressWord, decodePositiveInt24Word, decodeUint24Word, lowerAddress, sameAddress } from "./kernel/codec.ts";
export { verifyUniV3Identity } from "./kernel/identity.ts";
export type { UniV3IdentityFactsV1, UniV3IdentityVerdictV1 } from "./kernel/identity.ts";

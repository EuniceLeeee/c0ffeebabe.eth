import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { canonicalAddress, type GoldxActionV1, type GoldxIdentityV1, type GoldxQuoteV1 } from "./types.ts";
export function buildGoldxAction(input: { readonly identity: GoldxIdentityV1; readonly quote: GoldxQuoteV1; readonly calldata: string }): GoldxActionV1 { if (!/^0x[0-9a-fA-F]*$/.test(input.calldata) || input.calldata.length % 2 !== 0) throw new TypeError("goldx calldata is not canonical"); const payload = { cutoff: input.identity.cutoff, target: canonicalAddress(input.identity.instanceKey), calldata: input.calldata, exactQuoteHash: input.quote.quoteHash }; return Object.freeze({ ...payload, actionHash: hashDomain("aloha/goldx/action/v1", payload) }); }
export const GOLDX_SWAP_ACTION_PORT = Object.freeze({ actionOwnerId: "family.goldx.swap-action", build: buildGoldxAction });
export type GoldxActionOwnerRefV1 = Hash;

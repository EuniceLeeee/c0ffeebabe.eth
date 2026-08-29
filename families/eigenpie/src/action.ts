import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { canonicalAddress, type EigenpieActionV1, type EigenpieIdentityV1, type EigenpieQuoteV1 } from "./types.ts";
export function buildEigenpieAction(input: { readonly identity: EigenpieIdentityV1; readonly quote: EigenpieQuoteV1; readonly calldata: string }): EigenpieActionV1 { if (!/^0x[0-9a-fA-F]*$/.test(input.calldata) || input.calldata.length % 2 !== 0) throw new TypeError("eigenpie calldata is not canonical"); const payload = { cutoff: input.identity.cutoff, target: canonicalAddress(input.identity.instanceKey), calldata: input.calldata, exactQuoteHash: input.quote.quoteHash }; return Object.freeze({ ...payload, actionHash: hashDomain("aloha/eigenpie/action/v1", payload) }); }
export const EIGENPIE_PROTOCOL_ACTION_PORT = Object.freeze({ actionOwnerId: "family.eigenpie.protocol-action", build: buildEigenpieAction });
export type EigenpieActionOwnerRefV1 = Hash;

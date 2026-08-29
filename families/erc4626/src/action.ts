import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { canonicalAddress, type Erc4626ActionV1, type Erc4626IdentityV1, type Erc4626QuoteV1 } from "./types.ts";
export function buildErc4626Action(input: { readonly identity: Erc4626IdentityV1; readonly quote: Erc4626QuoteV1; readonly calldata: string }): Erc4626ActionV1 { if (!/^0x[0-9a-fA-F]*$/.test(input.calldata) || input.calldata.length % 2 !== 0) throw new TypeError("erc4626 calldata is not canonical"); const payload = { cutoff: input.identity.cutoff, target: canonicalAddress(input.identity.instanceKey), calldata: input.calldata, exactQuoteHash: input.quote.quoteHash }; return Object.freeze({ ...payload, actionHash: hashDomain("aloha/erc4626/action/v1", payload) }); }
export const ERC4626_VAULT_ACTION_PORT = Object.freeze({ actionOwnerId: "family.erc4626.vault-action", build: buildErc4626Action });
export type Erc4626ActionOwnerRefV1 = Hash;

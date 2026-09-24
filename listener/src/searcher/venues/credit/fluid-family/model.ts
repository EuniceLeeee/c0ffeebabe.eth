import { createHash } from "node:crypto";
import { FLUID_RESOLVER_FACTORY, FLUID_RESOLVER_LIQUIDITY } from "./capacity.js";

export type FluidLocalQuoteModel = "t1-view-v1";

// Compiler-declared immutable references, not arbitrary PUSH32 operands. These
// offsets are identical in all three solc 0.8.21 / paris / 10,000,000-run builds.
const IMMUTABLE_REFERENCES = [
  [1463, 2433, 7650, 7719, 8469, 16490], // SUPPLY_TOKEN
  [1503, 2599, 7962, 8181, 8698, 10774, 16073, 16227], // BORROW_TOKEN
  [1544], // SUPPLY_DECIMALS
  [1584], // BORROW_DECIMALS
  [640, 1384], // ADMIN_IMPLEMENTATION
  [1423, 10544, 11789], // SECONDARY_IMPLEMENTATION
  [1049, 1307, 7249, 7547, 8120, 8407, 8636, 9283, 9482, 16166, 16451, 16976, 17152], // LIQUIDITY
  [258, 444, 888, 1344, 3115, 3355], // VAULT_FACTORY
  [1101, 1623, 3071], // VAULT_ID
  [1662, 9211], // LIQUIDITY_SUPPLY_EXCHANGE_PRICE_SLOT
  [1701, 9437], // LIQUIDITY_BORROW_EXCHANGE_PRICE_SLOT
  [1740, 7211], // LIQUIDITY_USER_SUPPLY_SLOT
  [1779], // LIQUIDITY_USER_BORROW_SLOT
] as const;

// Recompiled from Instadapp/fluid-contracts-public at
// 9496626f71a761fc296dc3b2efbfd54c504e18f0. The 033d / ea3a solc inputs and the
// ea3a input with that commit's safeTransfer.sol (50k native gas) reproduce the
// complete executable bodies in the official deployment artifacts. All three
// coreModule/main.sol sources use getExchangeRateOperate(), never the later
// getExchangeRateOperateWrite() fallback. Provenance is in test/fixtures/local-models.json.
const TEMPLATES = [
  { byteLength: 23706, hash: "ee012e56d6c74050fc9975705f67ddfe1c2da04ae0311ce0c23660bca2245cd8" },
  { byteLength: 23708, hash: "d866d8eb843c83346189967256d0eecbfb13910df6abd37e88eda0a07c7c1b39" },
  { byteLength: 23708, hash: "9b8cd4a78754e76bf42dbc33e7373f31b7de2156edbfa0b9802021bdd28e1ecf" },
] as const;

/** Select pricing semantics, not admission. Existing reverse binding and active
 * behavior checks still admit the instance; an unknown runtime has no local model.
 * Only the compiler's CBOR trailer and declared immutable words are normalized.
 * Repeated immutable copies (including constantsView getters) must agree. */
export function fluidLocalModelForCode(code: string): FluidLocalQuoteModel | null {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) return null;
  const bytes = Buffer.from(code.slice(2), "hex");
  if (bytes.length < 2) return null;
  const metadataLength = bytes.readUInt16BE(bytes.length - 2);
  const bodyLength = bytes.length - metadataLength - 2;
  if (!TEMPLATES.some(template => template.byteLength === bodyLength)) return null;
  const body = bytes.subarray(0, bodyLength);
  // The fixed resolver obtains user limits from its own Liquidity resolver.
  // A matching Vault core with a different LIQUIDITY immutable would mix that
  // infrastructure's limits with another contract's balances. Keep it on the
  // simulation path. The remaining copies are checked below before masking.
  const liquidityWord = BigInt(FLUID_RESOLVER_LIQUIDITY).toString(16).padStart(64, "0");
  if (body.subarray(1049, 1049 + 32).toString("hex") !== liquidityWord) return null;
  const factoryWord = BigInt(FLUID_RESOLVER_FACTORY).toString(16).padStart(64, "0");
  if (body.subarray(258, 258 + 32).toString("hex") !== factoryWord) return null;
  const normalized = Buffer.from(body);
  for (const offsets of IMMUTABLE_REFERENCES) {
    const first = body.subarray(offsets[0], offsets[0] + 32);
    for (const offset of offsets) {
      if (!body.subarray(offset, offset + 32).equals(first)) return null;
      normalized.fill(0, offset, offset + 32);
    }
  }
  const hash = createHash("sha256").update(normalized).digest("hex");
  return TEMPLATES.some(template => template.byteLength === bodyLength && template.hash === hash)
    ? "t1-view-v1" : null;
}

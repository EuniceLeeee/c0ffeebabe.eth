import { Interface, keccak256 } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { assertSource, call, returned, uint } from "./codec.js";
import type { CurvePlainDescriptor } from "./types.js";

interface StorageQuoteModel {
  readonly implementation: string;
  readonly implementationHash: string;
  readonly ramp: "A" | "A-gamma";
}

// Quote-dependency evidence, NOT pool admission. These exact immutable 1167
// runtimes delegate to audited implementations whose get_dy/A/fee/balances
// closure reads only pool storage and internal math (plus the ramp clock).
// Stable get_y/get_D/_xp_mem and crypto newton_D/newton_y/xp/_fee do not read
// token balances, external rates or oracle contracts. The implementation hash
// is checked at the quote source before any result may be published.
// Source: verified Vyper sources/runtime at the implementation addresses;
// cached byte-for-byte source-page/runtime comparison at block 26080328.
// Unknown runtimes, including external-view/NG/rate variants, remain broad.
const MODELS: readonly StorageQuoteModel[] = Object.freeze([
  { implementation: "0xa85461afc2deec01bda23b5cd267d51f765fba10",
    implementationHash: "0xecd09c04d93550c0bf699cff12520ba54d0c6637f951303d1f45c4701a51a4c7", ramp: "A-gamma" },
  { implementation: "0xc629a01ec23ab04e1050500a3717a2a5c0701497",
    implementationHash: "0x992effe83a11d642ce410a6512930f6d6d535c0ad99c3bebd3d9f447aae2ce06", ramp: "A" },
  { implementation: "0x67fe41a94e779ccfa22cff02cc2957dc9c0e4286",
    implementationHash: "0xf8b6ec0714326b3183e32c835b0ae5be7156bb248fface95fb6d83aa6abaa3c8", ramp: "A" },
  { implementation: "0x6523ac15ec152cb70a334230f6c5d62c5bd963f1",
    implementationHash: "0xeeccdab36bda2dc3eb5aa81e800b294816465f29efb22da01e72b4b381faefad", ramp: "A" },
]);
const BY_PROXY_HASH = new Map(MODELS.map(model => [
  keccak256(`0x363d3d373d3d3d363d73${model.implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`),
  Object.freeze(model),
]));
const RAMP = new Interface([
  "function A_precise() view returns (uint256)",
  "function future_A() view returns (uint256)",
  "function A() view returns (uint256)",
  "function gamma() view returns (uint256)",
  "function future_A_gamma() view returns (uint256)",
]);

function modelFor(descriptor: CurvePlainDescriptor): StorageQuoteModel | undefined {
  const model = BY_PROXY_HASH.get(descriptor.binding.codeHash.toLowerCase());
  // Do not apply one implementation's proof to an incompatible route surface.
  return model && descriptor.binding.coins.length === 2 &&
    descriptor.binding.quoteAbi === (model.ramp === "A" ? "int128" : "uint256") ? model : undefined;
}

/** Only this Family interprets the pool's dependency closure. Keep the pool
 * and immutable implementation observed; no token-behavior assumptions. */
export function curveRefreshAddresses(descriptor: CurvePlainDescriptor): readonly string[] {
  const model = modelFor(descriptor);
  return model ? [descriptor.pool, model.implementation] : [descriptor.pool, ...descriptor.binding.coins];
}

export function curveRefreshGuardRequests(descriptor: CurvePlainDescriptor): readonly AdapterRequest[] {
  const model = modelFor(descriptor);
  if (!model) return [];
  return [
    { id: "refresh-implementation", kind: "get-code", address: model.implementation },
    call("refresh-ramp-current-A", descriptor.pool, RAMP.encodeFunctionData(model.ramp === "A" ? "A_precise" : "A")),
    call("refresh-ramp-future", descriptor.pool, RAMP.encodeFunctionData(model.ramp === "A" ? "future_A" : "future_A_gamma")),
    ...(model.ramp === "A-gamma" ? [call("refresh-ramp-current-gamma", descriptor.pool, RAMP.encodeFunctionData("gamma"))] : []),
  ];
}

export function curveRefreshRequirements(descriptor: CurvePlainDescriptor) {
  return { transports: modelFor(descriptor) ? ["eth-call", "get-code"] as const : ["eth-call"] as const };
}

export function validateCurveRefreshScope(descriptor: CurvePlainDescriptor,
  source: CanonicalSource, results: readonly AdapterRequestResult[]): void {
  const model = modelFor(descriptor);
  if (!model) return;
  const read = (id: string) => {
    const value = returned(results, id);
    assertSource(value.source, source);
    return value.data;
  };
  if (keccak256(read("refresh-implementation")) !== model.implementationHash) {
    throw new Error("curve-plain quote dependency implementation changed");
  }
  const currentA = uint(read("refresh-ramp-current-A"));
  const future = uint(read("refresh-ramp-future"));
  const futureA = model.ramp === "A" ? future : future >> 128n;
  const gammaMatches = model.ramp === "A" || uint(read("refresh-ramp-current-gamma")) === (future & ((1n << 128n) - 1n));
  // Audited ramps are monotone to their final integer values. Equality at
  // full precision proves no further clock-only quote change. Never compare
  // rounded A() for stable pools. A new ramp touches the pool and this guard
  // then fails; the shared run-exclusion policy stops further amount quotes.
  // Active ramps are not supported by this on-touch optimization: do not
  // carry a stale quote while pretending the Family has dynamic each-block.
  if (currentA !== futureA || !gammaMatches) {
    throw new Error("curve-plain active parameter ramp requires clock refresh");
  }
}

import { compileAddressMutations } from "../../mutation-index.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import { callRequest, protocolMid, sameAddress, successfulResult, assertSameSource } from "../standard-family/common.js";
import { ONDO_ERC20_INTERFACE, ONDO_FEES_INTERFACE, ONDO_ORACLE_INTERFACE } from "./abi.js";
import { ondoStaticProjection } from "./instance.js";
import { redeemOut } from "./math.js";
import type { OndoDescriptor, OndoPricingDescriptor, OndoPricingDraft, OndoPricingSnapshot, OndoRoute } from "./types.js";

export interface OndoStatic { readonly rwaDecimals: number; readonly receiveDecimals: number }

export const ondoPricing = {
  stateKey: (r: OndoRoute) => r.instanceKey,
  staticBindingProjection: ({ descriptor }) => ondoStaticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({ manager: descriptor.manager, oracle: descriptor.oracle, fees: descriptor.fees, semantics: "ondo-usdy-instant-redeem-v1" }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) throw new Error("ondo pricing requires one bound route");
    return Object.freeze({ instanceKey: descriptor.instanceKey, manager: descriptor.manager, rwa: descriptor.rwa, receive: descriptor.receive,
      oracle: descriptor.oracle, fees: descriptor.fees, normalizer: descriptor.normalizer, rwaDecimals: descriptor.rwaDecimals,
      receiveDecimals: descriptor.receiveDecimals, minimumRwaPrice: descriptor.minimumRwaPrice, feeFlat: descriptor.feeFlat,
      feeBps: descriptor.feeBps, feePrecision: descriptor.feePrecision, route: routes[0] });
  },
  staticEvidence: {
    reusePolicy: { kind: "dependency-proof" as const, dependencyKeys: (d: OndoPricingDraft) => Object.freeze([d.rwa, d.receive]) },
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: (d: OndoPricingDraft) => Object.freeze([
      callRequest("static-rwa-decimals", d.rwa, ONDO_ERC20_INTERFACE.encodeFunctionData("decimals")),
      callRequest("static-receive-decimals", d.receive, ONDO_ERC20_INTERFACE.encodeFunctionData("decimals")),
    ]),
    decode({ results }: { readonly programInput: OndoPricingDraft; readonly results: readonly AdapterRequestResult[] }): OndoStatic {
      assertSameSource([successfulResult(results, "static-rwa-decimals"), successfulResult(results, "static-receive-decimals")]);
      return Object.freeze({ rwaDecimals: Number(BigInt(successfulResult(results, "static-rwa-decimals").data)), receiveDecimals: Number(BigInt(successfulResult(results, "static-receive-decimals").data)) });
    },
  },
  finalizePricingDescriptor({ draft, staticEvidence }) {
    if (staticEvidence === undefined) throw new Error("ondo pricing lacks decimals evidence");
    return Object.freeze({ ...draft, ...staticEvidence });
  },
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }: { readonly descriptor: OndoPricingDescriptor }) => Object.freeze([
      callRequest("ondo-price-rwa", descriptor.oracle, ONDO_ORACLE_INTERFACE.encodeFunctionData("getAssetPrice", [descriptor.rwa])),
      callRequest("ondo-price-receive", descriptor.oracle, ONDO_ORACLE_INTERFACE.encodeFunctionData("getAssetPrice", [descriptor.receive])),
      callRequest("ondo-fee-config", descriptor.fees, ONDO_FEES_INTERFACE.encodeFunctionData("getActiveFeeConfig", [descriptor.rwa, descriptor.receive, "0x" + "0".repeat(64)])),
      callRequest("ondo-fee-precision", descriptor.fees, ONDO_FEES_INTERFACE.encodeFunctionData("FEE_PRECISION")),
    ]),
    decodeSnapshot({ descriptor, initialResults }: { readonly descriptor: OndoPricingDescriptor; readonly initialResults: readonly AdapterRequestResult[] }): OndoPricingSnapshot {
      const priceRwa = BigInt(ONDO_ORACLE_INTERFACE.decodeFunctionResult("getAssetPrice", successfulResult(initialResults, "ondo-price-rwa").data)[0]);
      const priceReceive = BigInt(ONDO_ORACLE_INTERFACE.decodeFunctionResult("getAssetPrice", successfulResult(initialResults, "ondo-price-receive").data)[0]);
      const cfg = ONDO_FEES_INTERFACE.decodeFunctionResult("getActiveFeeConfig", successfulResult(initialResults, "ondo-fee-config").data);
      const active = cfg[0] as unknown as { flatFee: bigint; bpsFee: bigint };
      const feeFlat = BigInt(active.flatFee ?? 0n), feeBps = BigInt(active.bpsFee ?? 0n);
      const feePrecision = BigInt(ONDO_FEES_INTERFACE.decodeFunctionResult("FEE_PRECISION", successfulResult(initialResults, "ondo-fee-precision").data)[0]);
      const amountIn = 10n ** BigInt(descriptor.rwaDecimals);
      const quotes: Record<string, { readonly amountIn: bigint; readonly amountOut: bigint }> = {};
      if (priceRwa >= descriptor.minimumRwaPrice && priceReceive > 0n) {
        const amountOut = redeemOut({ amount: amountIn, priceRwa, priceReceive, normalizer: descriptor.normalizer, receiveDecimals: descriptor.receiveDecimals, feeFlat, feeBps, feePrecision });
        quotes[descriptor.route.routeKey] = Object.freeze({ amountIn, amountOut });
      }
      return Object.freeze({ source: assertSameSource([successfulResult(initialResults, "ondo-price-rwa")]), priceRwa, priceReceive, feeFlat, feeBps, feePrecision, quotes });
    },
    deriveMids({ descriptor, snapshot, routes }) {
      const mids = new Map<OndoRoute["routeKey"], ReturnType<typeof protocolMid>>();
      for (const route of routes) {
        const q = snapshot.quotes[route.routeKey];
        if (q === undefined || q.amountOut <= 0n) continue;
        mids.set(route.routeKey, protocolMid({ route, adapterId: route.adapterId, target: descriptor.manager, quote: q }));
      }
      return mids;
    },
    classifyUnavailable({ snapshot, routes }) {
      const m = new Map<OndoRoute["routeKey"], string>();
      for (const r of routes) if (snapshot.quotes[r.routeKey] === undefined) m.set(r.routeKey, "ondo_price_below_minimum");
      return m;
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([descriptor.manager, descriptor.rwa, descriptor.receive, descriptor.oracle, descriptor.fees]),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor }) => ({ addresses: [descriptor.manager, descriptor.rwa, descriptor.receive], keys: [descriptor.instanceKey] }), { kinds: ["log"] }),
    affectedStateKeys({ descriptor, observation }) {
      return observation.kind === "log" && (sameAddress(observation.address, descriptor.manager) || sameAddress(observation.address, descriptor.oracle)) ? [descriptor.instanceKey] : [];
    },
  },
} satisfies PricingSemantics<OndoDescriptor, OndoRoute, OndoPricingDescriptor, OndoPricingSnapshot, OndoPricingDraft, OndoStatic>;

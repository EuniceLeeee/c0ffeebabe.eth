import { ethers } from "ethers";
import { METRONOME_HGUSDC_PATH } from "../../../../adapters/metronome-hgusdc.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import type {
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcRoute,
} from "./types.js";

export const METRONOME_HGUSDC_ROUTER_INTERFACE = new ethers.Interface([
  "function executePath(bytes path,uint256[] amounts,address receiver)",
]);
export const METRONOME_HGUSDC_CURVE_INTERFACE = new ethers.Interface([
  "function coins(uint256 index) view returns (address)",
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
export const METRONOME_HGUSDC_VAULT_INTERFACE = new ethers.Interface([
  "function asset() view returns (address)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
]);
export const METRONOME_HGUSDC_ERC20_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);
export const METRONOME_HGUSDC_PATH_HASH = ethers.keccak256(
  METRONOME_HGUSDC_PATH,
);

export function metronomeHgUsdcStaticProjection(
  descriptor: MetronomeHgUsdcDescriptor,
) {
  return {
    router: lowerAddress(descriptor.router),
    curve: lowerAddress(descriptor.curve),
    vault: lowerAddress(descriptor.vault),
    tokenIn: lowerAddress(descriptor.tokenIn),
    curveIntermediate: lowerAddress(descriptor.curveIntermediate),
    tokenOut: lowerAddress(descriptor.tokenOut),
    curveDirection: [1, 0],
    pathHash: descriptor.pathHash,
    quoteChain: "curve-get-dy->vault-preview-redeem-v1",
  };
}

export function assertMetronomeHgUsdcInvocation(
  descriptor: MetronomeHgUsdcDescriptor,
  route: MetronomeHgUsdcRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.router,
    route,
    bindingFingerprint: hashCanonical(
      metronomeHgUsdcStaticProjection(descriptor),
    ),
  });
  if (
    route.adapterId !== "metronome-hgusdc-exit" ||
    route.direction !== "msusd-to-usdc" ||
    !sameAddress(route.tokenIn, descriptor.tokenIn) ||
    !sameAddress(route.tokenOut, descriptor.tokenOut)
  ) {
    throw new Error(
      "Metronome hgUSDC route is incompatible with its descriptor",
    );
  }
}

export const METRONOME_HGUSDC_BINDINGS = Object.freeze({
  curve: ADDR.CURVE_MSUSD_FRXUSD,
  vault: ADDR.HGUSDC,
  tokenIn: ADDR.MSUSD,
  curveIntermediate: ADDR.FRXUSD,
  tokenOut: ADDR.USDC,
});

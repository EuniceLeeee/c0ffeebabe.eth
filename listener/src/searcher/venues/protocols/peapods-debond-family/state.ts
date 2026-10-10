import { ethers } from "ethers";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { ABI, address, call, code, decode, rows, uint } from "./codec.js";
import type { Descriptor, State } from "./types.js";
export const requirements = { transports: ["get-code", "eth-call"] as const };
export const stateRequests = (d: Pick<Descriptor, "pod" | "asset">) => [
  code("pod-code", d.pod), code("asset-code", d.asset),
  call("pod-assets", d.pod, ABI.encodeFunctionData("getAllAssets")),
  call("pod-supply", d.pod, ABI.encodeFunctionData("totalSupply")),
  call("asset-backing", d.asset, ABI.encodeFunctionData("balanceOf", [d.pod])),
];
export function decodeState(d: Descriptor, results: readonly AdapterRequestResult[], expected?: CanonicalSource): State {
  const r = rows(results, stateRequests(d), expected);
  if (ethers.keccak256(r.get("pod-code")) !== d.codeHash || ethers.keccak256(r.get("asset-code")) !== d.assetCodeHash)
    throw new Error("peapods source binding changed");
  const assets = decode("getAllAssets", r.get("pod-assets"))[0];
  if (assets.length !== 1 || address(assets[0].token) !== d.asset) throw new Error("peapods asset topology changed");
  return { source: r.source, feeBps: d.feeBps, supply: uint(decode("totalSupply", r.get("pod-supply"))[0]),
    backing: uint(decode("balanceOf", r.get("asset-backing"))[0]) };
}

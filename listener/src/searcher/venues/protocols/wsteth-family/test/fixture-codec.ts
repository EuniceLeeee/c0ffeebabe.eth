import { ethers } from "ethers";

export const WSTETH_INTERFACE = new ethers.Interface([
  "function stETH() view returns (address)",
  "function getWstETHByStETH(uint256 stETHAmount) view returns (uint256)",
  "function getStETHByWstETH(uint256 wstETHAmount) view returns (uint256)",
  "function wrap(uint256 stETHAmount) returns (uint256)",
  "function unwrap(uint256 wstETHAmount) returns (uint256)",
]);

export const WSTETH_SAMPLE = 10n ** 18n;

import { ADDR } from "../../shared/constants/addresses.js";

export interface TokenEdge {
  adapterId: string;
  target: string;
  tokenIn: string;
  tokenOut: string;
  slotKind: "flash" | "lend" | "swap";
}

export interface TokenPath {
  edges: TokenEdge[];
}

export function defaultWstUsrGraph(): TokenEdge[] {
  return [
    {
      adapterId: "fluid-vault",
      target: ADDR.FLUID_VAULT_WSTUSR_USDC,
      tokenIn: ADDR.WSTUSR,
      tokenOut: ADDR.USDC,
      slotKind: "lend",
    },
    {
      adapterId: "psm",
      target: ADDR.SKY_PSM_LITE,
      tokenIn: ADDR.USDC,
      tokenOut: ADDR.DAI,
      slotKind: "swap",
    },
    {
      adapterId: "univ4-unlock",
      target: ADDR.UNISWAP_V4_POOL_MANAGER,
      tokenIn: ADDR.DAI,
      tokenOut: ADDR.USDT,
      slotKind: "swap",
    },
    {
      adapterId: "univ3-swap",
      target: ADDR.UNISWAP_V3_USDT_WETH,
      tokenIn: ADDR.USDT,
      tokenOut: ADDR.WETH,
      slotKind: "swap",
    },
    {
      adapterId: "univ3-swap",
      target: ADDR.UNISWAP_V3_USDT_WETH,
      tokenIn: ADDR.WETH,
      tokenOut: ADDR.USDT,
      slotKind: "swap",
    },
    {
      adapterId: "curve-exchange",
      target: ADDR.CURVE_SUSDS_USDT,
      tokenIn: ADDR.USDT,
      tokenOut: ADDR.SUSDS,
      slotKind: "swap",
    },
    {
      adapterId: "curve-exchange",
      target: ADDR.CURVE_DOLA_SUSDS,
      tokenIn: ADDR.SUSDS,
      tokenOut: ADDR.DOLA,
      slotKind: "swap",
    },
    {
      adapterId: "curve-exchange-nr",
      target: ADDR.CURVE_DOLA_WSTUSR,
      tokenIn: ADDR.DOLA,
      tokenOut: ADDR.WSTUSR,
      slotKind: "swap",
    },
  ];
}

export function buildTokenPaths(
  edges: TokenEdge[],
  startToken: string,
  profitToken: string,
  maxDepth = 8,
): TokenPath[] {
  const paths: TokenPath[] = [];

  function walk(token: string, path: TokenEdge[]): void {
    if (path.length > 0 && token.toLowerCase() === profitToken.toLowerCase()) {
      paths.push({ edges: path });
      return;
    }
    if (path.length >= maxDepth) return;

    for (const edge of edges) {
      if (edge.tokenIn.toLowerCase() !== token.toLowerCase()) continue;
      walk(edge.tokenOut, [...path, edge]);
    }
  }

  walk(startToken, []);
  return paths;
}


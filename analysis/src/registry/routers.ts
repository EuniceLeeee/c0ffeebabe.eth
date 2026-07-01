import { lower } from "./protocols.js";

export const PUBLIC_ROUTERS: Set<string> = new Set([
  lower("0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD"),
  lower("0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af"),
  lower("0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"),
  lower("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"),
  lower("0x1111111254EEB25477B68fb85Ed929f73A960582"),
  lower("0xDef1C0ded9bec7F1a1670819833240f027b25EfF"),
]);

export function isPublicRouter(addr: string | null | undefined): boolean {
  return Boolean(addr && PUBLIC_ROUTERS.has(lower(addr)));
}

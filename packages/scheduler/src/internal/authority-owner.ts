import type { QualifiedExecutorAuthorityIssuer } from "../index.ts";
import { registerQualifiedExecutorAuthorityIssuer } from "./authority-state.ts";
export function issueQualifiedExecutorAuthorityIssuer(value: QualifiedExecutorAuthorityIssuer): QualifiedExecutorAuthorityIssuer {
  if (value === null || typeof value !== "object") throw new TypeError("qualified executor authority issuer invalid");
  return registerQualifiedExecutorAuthorityIssuer(value);
}

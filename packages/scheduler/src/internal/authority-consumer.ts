import type { QualifiedExecutorAuthorityIssuer } from "../index.ts";
import { isQualifiedExecutorAuthorityIssuer } from "./authority-state.ts";
export function assertIssuedQualifiedExecutorAuthorityIssuer(value: unknown): QualifiedExecutorAuthorityIssuer {
  if (!isQualifiedExecutorAuthorityIssuer(value)) throw new TypeError("qualified executor issuer is not release-issued");
  return value;
}

import type { QualifiedExecutorAuthorityIssuer } from "../index.ts";
const issued = new WeakSet<object>();
export function registerQualifiedExecutorAuthorityIssuer(value: QualifiedExecutorAuthorityIssuer): QualifiedExecutorAuthorityIssuer { issued.add(value); return value; }
export function isQualifiedExecutorAuthorityIssuer(value: unknown): value is QualifiedExecutorAuthorityIssuer { return value !== null && typeof value === "object" && issued.has(value); }

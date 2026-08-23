/**
 * The package root intentionally exposes no authoring or authority factory.
 * Build tools and Family packages should import the narrow subpath they own.
 */
export type { GeneratedFamilyEntryV1, StageFamilyRefsV1 } from "../runtime-refs/index.ts";

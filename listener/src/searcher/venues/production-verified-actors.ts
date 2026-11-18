/** Selector-native execution binds calls to the current executor and source.
 * No protocol probe actor is an admission authority. The empty map preserves
 * the central caller-authority interface; an undeclared verified actor still
 * fails closed instead of inheriting an old protocol identity fixture. */
export const PRODUCTION_STRICT_VERIFIED_ACTORS: Readonly<Record<string, string>> = Object.freeze({});

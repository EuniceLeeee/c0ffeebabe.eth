export interface FamilyActivation {
  readonly enabled: boolean;
  readonly defaultEnabled: boolean;
  readonly envKey: string | null;
}

const definitions = new WeakSet<object>();

/** Entry-owned startup policy. This does not modify the Family's capabilities. */
export function defineFamilyActivation(
  input: { readonly enabled: boolean; readonly envKey: string },
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FamilyActivation {
  if (typeof input.enabled !== "boolean" ||
      !/^SEARCHER_FAMILY_[A-Z0-9_]+_ENABLED$/.test(input.envKey)) {
    throw new Error("Family activation requires a boolean default and a SEARCHER_FAMILY_*_ENABLED key");
  }
  const activation = Object.freeze({ enabled: resolveEnabled(input.enabled, input.envKey, environment),
    defaultEnabled: input.enabled, envKey: input.envKey });
  definitions.add(activation);
  return activation;
}

/** Call after a late environment-file load. Never silently mutate an issued catalog. */
export function assertFamilyActivationEnvironment(
  activations: readonly FamilyActivation[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  for (const activation of activations) {
    const expected = activation.envKey === null ? activation.defaultEnabled
      : resolveEnabled(activation.defaultEnabled, activation.envKey, environment);
    if (expected !== activation.enabled) {
      throw new Error(`${activation.envKey ?? "Family default"}: plugin activation fixed at startup; ` +
        "set env before starting or edit plugin default");
    }
  }
}

function resolveEnabled(defaultEnabled: boolean, envKey: string,
  environment: Readonly<Record<string, string | undefined>>): boolean {
  const value = environment[envKey];
  if (value !== undefined && value !== "0" && value !== "1") {
    throw new Error(`${envKey} must be exactly 0 or 1`);
  }
  return value === undefined ? defaultEnabled : value === "1";
}

/** Old synthetic entries without activation keep their original enabled default. */
export const DEFAULT_FAMILY_ACTIVATION: FamilyActivation = Object.freeze({
  enabled: true, defaultEnabled: true, envKey: null,
});

export function assertDefinedFamilyActivation(value: unknown): asserts value is FamilyActivation {
  if (value === null || typeof value !== "object" || !definitions.has(value)) {
    throw new Error("activation must be issued by defineFamilyActivation");
  }
}

export interface StateResourceCarrier {
  readonly stateResourceKey?: string;
  /** When present, the complete set of physical resources used by the route. */
  readonly stateResourceKeys?: readonly string[];
}

export function normalizeStateResourceKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.length || value.length > 256 ||
      Reflect.ownKeys(value).some(key => typeof key !== "string" || key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))
    throw new Error("state resource keys must be a non-empty bounded array");
  const keys: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" ||
        !descriptor.value.trim() || descriptor.value.length > 1024 || /[\u0000-\u001f\u007f]/.test(descriptor.value))
      throw new Error("state resource keys require bounded data strings without control characters");
    keys.push(descriptor.value);
  }
  return Object.freeze([...new Set(keys)].sort());
}

const sealed = new WeakMap<object, readonly string[]>();
/** A plural declaration is complete. Its legacy summary key may identify a
 * router or a composite path and must not manufacture a shared physical pool. */
export function explicitStateResourceKeys(value: StateResourceCarrier): readonly string[] | undefined {
  if (value.stateResourceKeys === undefined)
    return value.stateResourceKey === undefined ? undefined : [value.stateResourceKey];
  const cached = sealed.get(value);
  if (cached) return cached;
  const keys = normalizeStateResourceKeys(value.stateResourceKeys);
  if (Object.isFrozen(value) && Object.isFrozen(value.stateResourceKeys)) sealed.set(value, keys);
  return keys;
}

export function stateResourceSetsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const keys = new Set(a);
  return b.some(key => keys.has(key));
}

export function explicitStateResourceOverlap(a: StateResourceCarrier, b: StateResourceCarrier): boolean | null {
  const left = explicitStateResourceKeys(a), right = explicitStateResourceKeys(b);
  return left === undefined || right === undefined ? null : stateResourceSetsOverlap(left, right);
}

export function explicitStateResourceEquality(a: StateResourceCarrier, b: StateResourceCarrier): boolean | null {
  const left = explicitStateResourceKeys(a), right = explicitStateResourceKeys(b);
  return left === undefined || right === undefined ? null : left.length === right.length && left.every((key, index) => key === right[index]);
}

/** Only an enumeration/grouping summary. Conflict decisions use set overlap. */
export function stateResourceSetIdentity(keys: readonly string[]): string {
  return keys.length === 1 ? keys[0]! : `state-resource-set:${JSON.stringify(keys)}`;
}

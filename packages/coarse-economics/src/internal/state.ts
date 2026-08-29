const projectionServices = new WeakMap<object, (capability: object) => unknown>();
const routeBindings = new WeakMap<object, unknown>();
const enumerationBindings = new WeakMap<object, unknown>();

export function registerCoarseProjectionServiceV1(
  value: object,
  read: (capability: object) => unknown,
): void {
  projectionServices.set(value, read);
}

export function readCoarseProjectionServiceV1(value: object): ((capability: object) => unknown) | undefined {
  return projectionServices.get(value);
}

export function registerCoarseRouteBindingV1(capability: object, binding: unknown): void {
  routeBindings.set(capability, binding);
}

export function readCoarseRouteBindingV1(capability: object): unknown {
  return routeBindings.get(capability);
}

export function registerCoarseEnumerationBindingV1(capability: object, binding: unknown): void {
  enumerationBindings.set(capability, binding);
}

export function readCoarseEnumerationBindingV1(capability: object): unknown {
  return enumerationBindings.get(capability);
}

const services = new WeakSet<object>();

export function registerEconomicSafetyFinalizationServiceV1(value: object): void {
  services.add(value);
}

export function isEconomicSafetyFinalizationServiceV1(value: object): boolean {
  return services.has(value);
}

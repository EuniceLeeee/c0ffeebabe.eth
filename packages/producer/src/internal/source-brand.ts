import type { ProducerIngressSourceV1 } from "../index.ts";

const issued = new WeakSet<object>();

export function brandProducerIngressSource(value: object): ProducerIngressSourceV1 {
  issued.add(value);
  return value as ProducerIngressSourceV1;
}

export function assertIssuedProducerIngressSource(value: unknown): asserts value is ProducerIngressSourceV1 {
  if (value === null || typeof value !== "object" || !issued.has(value)) {
    throw new TypeError("producer ingress source is not candidate-issued");
  }
}

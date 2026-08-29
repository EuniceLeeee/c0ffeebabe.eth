import type { ProductionSixStepTailEmissionPortV1 } from "../index.ts";

const issuedProductionSixStepTailPorts = new WeakSet<object>();

export function issueProductionSixStepTailEmissionPortV1(
  port: ProductionSixStepTailEmissionPortV1,
): ProductionSixStepTailEmissionPortV1 {
  if (port === null || typeof port !== "object"
    || typeof port.emitPlanner !== "function"
    || typeof port.emitExact !== "function"
    || typeof port.emitExecutionProgram !== "function"
    || typeof port.emitFinalSimulation !== "function"
    || typeof port.readStage12Parents !== "function") {
    throw new TypeError("production Six-Step tail port is incomplete");
  }
  issuedProductionSixStepTailPorts.add(port);
  return port;
}

export function assertIssuedProductionSixStepTailEmissionPortV1(
  value: unknown,
): asserts value is ProductionSixStepTailEmissionPortV1 {
  if (value === null || typeof value !== "object" || !issuedProductionSixStepTailPorts.has(value)) {
    throw new TypeError("production Six-Step tail port is not owner-issued");
  }
}
